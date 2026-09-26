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
 */

import { Redis } from '@upstash/redis'
import { createServerClient } from '@/lib/supabase'

const redis = Redis.fromEnv()

const TTL_SECONDS = 86400
const metaKey = (reference: string) => `shop:meta:${reference}`

function parse(raw: unknown): any | null {
    if (raw === null || raw === undefined) return null
    if (typeof raw !== 'string') return raw
    try {
        return JSON.parse(raw)
    } catch {
        return raw
    }
}

/** Stores the metadata in Redis and the database. Throws only if both fail. */
export async function saveShopMeta(reference: string, metadata: unknown): Promise<void> {
    const db: any = createServerClient()
    const expiresAt = new Date(Date.now() + TTL_SECONDS * 1000).toISOString()

    const [redisResult, dbResult] = await Promise.allSettled([
        redis.set(metaKey(reference), JSON.stringify(metadata), { ex: TTL_SECONDS }),
        (async () => {
            const { error } = await db
                .from('shop_payment_meta')
                .upsert({ reference, metadata, expires_at: expiresAt }, { onConflict: 'reference' })
            if (error) throw error
        })(),
    ])

    if (redisResult.status === 'rejected') {
        console.error('[ShopMeta] Redis write failed:', reference, redisResult.reason)
    }
    if (dbResult.status === 'rejected') {
        console.error('[ShopMeta] database write failed:', reference, dbResult.reason)
    }

    if (redisResult.status === 'rejected' && dbResult.status === 'rejected') {
        throw redisResult.reason
    }

    // Expired rows are ignored on read, so this is housekeeping, not correctness.
    if (Math.random() < 0.02) {
        try {
            await db.from('shop_payment_meta').delete().lt('expires_at', new Date().toISOString())
        } catch {
            /* housekeeping only */
        }
    }
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
