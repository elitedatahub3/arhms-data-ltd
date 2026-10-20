/**
 * Storefront checkout metadata, kept in two places.
 *
 * `shop:meta:<ref>` in Redis is the fast path the callbacks have always read. The
 * same payload is also written to `shop_payment_meta` so that a Redis outage or an
 * exhausted quota can neither stop a checkout from starting nor strand a payment
 * that is already in flight without the details needed to price it.
 *
 * Writes go to both. A save only fails when BOTH stores refuse it — charging a
 * customer with the order details stored nowhere would take their money and create
 * no order, so that case must still stop checkout. Reads try Redis and fall back to
 * the table.
 *
 * If the table has not been migrated yet (supabase/migrations/20260920000000_...),
 * the table half of every operation just fails quietly and this behaves exactly
 * like the Redis-only code it replaced.
 *
 * The table row doubles as the payment's LEDGER (migration 20261013000000): it
 * carries status pending -> settled | failed | needs_attention, so the
 * reconciliation cron can find every in-flight payment from the database even
 * when Redis is down, and a paid payment that could not become an order is
 * visible instead of silent. Until that migration runs the ledger columns are
 * shed on write and the ledger helpers are no-ops.
 */

import { Redis } from '@upstash/redis'
import { createServerClient } from '@/lib/supabase'

const redis = Redis.fromEnv()

const TTL_SECONDS = 86400
// The table copy outlives Redis: a buyer who approves late, or a callback that
// never comes, still has to be settled by the cron days later.
const DB_TTL_SECONDS = 7 * 86400
const metaKey = (reference: string) => `shop:meta:${reference}`

/** Settle attempts on a PAID payment before it is handed to a human. */
export const MAX_SETTLE_ATTEMPTS = 5

/**
 * Failures retrying cannot fix: the payment itself is wrong, not the moment.
 * They go straight to needs_attention.
 */
const PERMANENT_ERRORS = new Set([
    'Payment amount mismatch',
    'Order profit would be non-positive; order rejected',
])

export type ShopLedgerInfo = {
    /** Which rail collected it: paystack_momo | hubtel | moolre | payswitch | paystack. */
    provider?: string
    /** shop | afa | rc_shop. Only 'shop' is settled through the ledger today. */
    kind?: string
    slug?: string
}

/** Postgres/PostgREST codes for "that column or table does not exist (yet)". */
function isSchemaMissing(error: any): boolean {
    const code = String(error?.code ?? '')
    return code === '42703' || code === 'PGRST204' || code === '42P01' || code === 'PGRST205'
}

function parse(raw: unknown): any | null {
    if (raw === null || raw === undefined) return null
    if (typeof raw !== 'string') return raw
    try {
        return JSON.parse(raw)
    } catch {
        return raw
    }
}

/**
 * Stores the metadata in Redis and the database, and opens the ledger row.
 *
 * Throws when the database refuses the write, unless the table simply has not been
 * migrated yet. Call this BEFORE the prompt goes out: a charge with no durable
 * record is exactly the payment that can be taken and never turned into an order,
 * and when the database is down nothing could settle it anyway.
 */
export async function saveShopMeta(
    reference: string,
    metadata: unknown,
    ledger: ShopLedgerInfo = {}
): Promise<void> {
    const db: any = createServerClient()
    const expiresAt = new Date(Date.now() + DB_TTL_SECONDS * 1000).toISOString()
    const meta: any = metadata ?? {}

    const baseRow = { reference, metadata, expires_at: expiresAt }
    const ledgerRow = {
        ...baseRow,
        provider: ledger.provider ?? meta.provider ?? null,
        kind: ledger.kind ?? 'shop',
        slug: ledger.slug ?? meta.slug ?? meta.shop_slug ?? null,
        status: 'pending',
        attempts: 0,
        last_error: null,
        settled_at: null,
    }

    const [redisResult, dbResult] = await Promise.allSettled([
        redis.set(metaKey(reference), JSON.stringify(metadata), { ex: TTL_SECONDS }),
        (async () => {
            let { error } = await db
                .from('shop_payment_meta')
                .upsert(ledgerRow, { onConflict: 'reference' })
            if (error && isSchemaMissing(error)) {
                // Ledger columns not migrated yet: keep the metadata copy at least.
                ;({ error } = await db
                    .from('shop_payment_meta')
                    .upsert(baseRow, { onConflict: 'reference' }))
            }
            if (error) throw error
        })(),
    ])

    if (redisResult.status === 'rejected') {
        console.error('[ShopMeta] Redis write failed:', reference, redisResult.reason)
    }
    if (dbResult.status === 'rejected') {
        console.error('[ShopMeta] database write failed:', reference, dbResult.reason)
        // A missing table is the pre-migration world, where Redis alone carried
        // checkout. Anything else means no durable record, so no charge.
        if (redisResult.status === 'rejected' || !isSchemaMissing(dbResult.reason)) {
            // Named so /api/shop/initialize can answer 503 "try again" for it.
            throw new Error(`ShopMeta durable write failed: ${dbResult.reason?.message ?? dbResult.reason}`)
        }
    }

    // Expired rows are ignored on read, so this is housekeeping, not correctness.
    // Only finished rows are swept; a pending or needs_attention row is the record
    // of money that has not become an order yet and must outlive its expiry.
    if (Math.random() < 0.02) {
        try {
            const now = new Date().toISOString()
            const { error } = await db
                .from('shop_payment_meta')
                .delete()
                .lt('expires_at', now)
                .in('status', ['settled', 'failed'])
            if (error && isSchemaMissing(error)) {
                await db.from('shop_payment_meta').delete().lt('expires_at', now)
            }
        } catch {
            /* housekeeping only */
        }
    }
}

/** The payment became an order. Best effort: a missing ledger never blocks settlement. */
export async function markShopPaymentSettled(reference: string): Promise<void> {
    try {
        const db: any = createServerClient()
        const { error } = await db
            .from('shop_payment_meta')
            .update({ status: 'settled', settled_at: new Date().toISOString(), last_error: null })
            .eq('reference', reference)
        if (error && !isSchemaMissing(error)) {
            console.error('[ShopMeta] ledger settle failed:', reference, error.message)
        }
    } catch (e) {
        console.error('[ShopMeta] ledger settle threw:', reference, e)
    }
}

/**
 * A PAID payment could not become an order. Counts the attempt and keeps it
 * pending so the cron retries; after MAX_SETTLE_ATTEMPTS, or at once for an error
 * retrying cannot fix, it becomes needs_attention for a human.
 */
export async function markShopPaymentIssue(reference: string, error: string): Promise<void> {
    try {
        const db: any = createServerClient()
        const { data, error: readError } = await db
            .from('shop_payment_meta')
            .select('attempts, status')
            .eq('reference', reference)
            .maybeSingle()
        if (readError) {
            if (!isSchemaMissing(readError)) console.error('[ShopMeta] ledger read failed:', reference, readError.message)
            return
        }
        if (!data || data.status === 'settled') return

        const attempts = Number(data.attempts ?? 0) + 1
        const giveUp = attempts >= MAX_SETTLE_ATTEMPTS || PERMANENT_ERRORS.has(error)
        await db
            .from('shop_payment_meta')
            .update({
                attempts,
                last_error: error.slice(0, 500),
                status: giveUp ? 'needs_attention' : 'pending',
            })
            .eq('reference', reference)
        if (giveUp) {
            console.error(`[ShopMeta] PAID, NO ORDER - needs a human: ${reference} (${error})`)
        }
    } catch (e) {
        console.error('[ShopMeta] ledger issue write threw:', reference, e)
    }
}

/** The payment never happened (declined, abandoned). Nothing is owed. */
export async function markShopPaymentFailed(reference: string, reason: string): Promise<void> {
    try {
        const db: any = createServerClient()
        await db
            .from('shop_payment_meta')
            .update({ status: 'failed', last_error: reason.slice(0, 500) })
            .eq('reference', reference)
            .eq('status', 'pending')
    } catch {
        /* best effort */
    }
}

export type ShopLedgerRow = {
    reference: string
    provider: string | null
    kind: string | null
    slug: string | null
    status: string
    attempts: number
    last_error: string | null
    created_at: string
    last_checked_at: string | null
    metadata: any
}

/**
 * Pending ledger rows older than `minAgeMs`, least recently checked first. Empty
 * (not an error) before the ledger migration runs, so callers keep their legacy path.
 */
export async function listPendingShopPayments(minAgeMs: number, limit = 100): Promise<ShopLedgerRow[]> {
    const db: any = createServerClient()
    const { data, error } = await db
        .from('shop_payment_meta')
        .select('reference, provider, kind, slug, status, attempts, last_error, created_at, last_checked_at, metadata')
        .eq('status', 'pending')
        .lt('created_at', new Date(Date.now() - minAgeMs).toISOString())
        .order('last_checked_at', { ascending: true, nullsFirst: true })
        .order('created_at', { ascending: true })
        .limit(limit)
    if (error) {
        if (!isSchemaMissing(error)) console.error('[ShopMeta] ledger list failed:', error.message)
        return []
    }
    return data ?? []
}

/** Stamped BEFORE the gateway call, so a timed-out run still rotates the backlog. */
export async function stampShopPaymentCheck(reference: string): Promise<void> {
    try {
        const db: any = createServerClient()
        await db
            .from('shop_payment_meta')
            .update({ last_checked_at: new Date().toISOString() })
            .eq('reference', reference)
    } catch {
        /* best effort */
    }
}

/**
 * What the buyer was asked to pay, in pesewas, rebuilt from the stored order.
 * For gateways that report status but no amount (Moolre), exactly as
 * /api/shop/verify has always done; processShopOrder re-checks it against prices.
 */
export function expectedShopPaidPesewas(metadata: any): number {
    return Math.round(Number(metadata?.selling_price || metadata?.airtime_amount || 0) * 100) +
        Math.round(Number(metadata?.fee_amount || metadata?.paystack_fee || 0) * 100)
}

/** Redis first, then the database. Null only when neither has it. */
export async function getShopMeta<T = any>(reference: string): Promise<T | null> {
    try {
        const fromRedis = parse(await redis.get<any>(metaKey(reference)))
        if (fromRedis) return fromRedis as T
    } catch (e) {
        console.error('[ShopMeta] Redis read failed, trying database:', reference, e)
    }

    try {
        const db: any = createServerClient()
        const { data } = await db
            .from('shop_payment_meta')
            .select('metadata')
            .eq('reference', reference)
            .gt('expires_at', new Date().toISOString())
            .maybeSingle()
        return (data?.metadata as T) ?? null
    } catch (e) {
        console.error('[ShopMeta] database read failed:', reference, e)
        return null
    }
}

/** Removes both copies. Best effort — both expire on their own. */
export async function deleteShopMeta(reference: string): Promise<void> {
    await Promise.allSettled([
        redis.del(metaKey(reference)),
        (async () => {
            const db: any = createServerClient()
            await db.from('shop_payment_meta').delete().eq('reference', reference)
        })(),
    ])
}
