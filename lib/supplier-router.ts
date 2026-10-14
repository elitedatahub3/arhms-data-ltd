/**
 * The one place that decides which data supplier an order goes to, and falls back
 * to a second supplier when the first definitely can't take it.
 *
 * Every data-order path calls this — wallet purchase, direct pay, storefront/USSD,
 * the developer API, bulk purchase, admin re-fulfil and the auto-refulfill cron.
 * Before it existed each of those carried its own copy of an eight-way if/else, and
 * the copies drifted (bulk purchase only ever spoke to Dakazina; the storefront
 * dropped references that arrived as `reference` rather than `transactionId`).
 *
 * Configuration lives in admin_settings.fulfillment_settings:
 *   <flag>[network] === true   → that supplier is the PRIMARY for the network
 *                                (exactly one; two is a conflict and nothing ships)
 *   fallback[network] = id     → the supplier to try when the primary REFUSES
 *
 * Fallback rules — chosen so a fallback can never deliver a bundle twice:
 *   • Only a definite refusal moves on (see lib/supplier-failure.ts). A timeout or a
 *     5xx might have been accepted, so the order stays with that supplier.
 *   • Once any attempt on an order ended 'unknown' at supplier X, every later retry
 *     goes to X alone — X may be delivering it, and only X can say so.
 *   • A retry otherwise starts at the primary again. Refusals are usually temporary
 *     (low balance, open circuit), and a definite refusal created nothing to collide with.
 */
import type { SupplierFailureKind } from '@/lib/supplier-failure'
import { SUPPLIER_FLAGS, SUPPLIER_NAMES, type SupplierId } from '@/lib/supplier-ids'

export type { SupplierId }

export interface SupplierResult {
    success: boolean
    reference?: string
    transactionId?: string
    /** Dakazina only — the identifier their webhook echoes. */
    webhookRef?: string
    error?: string
    apiResponse?: any
    isRateLimited?: boolean
    alreadySubmitted?: boolean
    whitelistPending?: boolean
    failureKind?: SupplierFailureKind
}

type FulfillFn = (
    network: string, phone: string, size: string, orderId: string, opts?: { isRetry?: boolean }
) => Promise<SupplierResult>

export interface SupplierDef {
    id: SupplierId
    /** Key in fulfillment_settings holding this supplier's per-network primary toggle. */
    flag: string
    name: string
    /** Reference column on `orders`. */
    ordersRefColumn: string
    /** Reference column on `shop_orders` (CodeCraft's is named differently). */
    shopRefColumn: string
    /**
     * A thunk with a literal specifier: webpack resolves dynamic imports statically,
     * so `import(someVariable)` would silently fail to bundle. Lazy loading keeps
     * eight supplier SDKs off the cold start of every route that imports this file.
     */
    load: () => Promise<{ fulfillOrder: FulfillFn }>
}

const def = (
    id: SupplierId, ordersRefColumn: string, shopRefColumn: string,
    load: SupplierDef['load']
): SupplierDef => ({ id, flag: SUPPLIER_FLAGS[id], name: SUPPLIER_NAMES[id], ordersRefColumn, shopRefColumn, load })

export const SUPPLIERS: ReadonlyArray<SupplierDef> = [
    def('datakazina',   'dakazina_reference',     'dakazina_reference',     () => import('@/lib/fulfillment-service') as any),
    def('codecraft',    'codecraft_reference',    'codecraft_reference_id', () => import('@/lib/codecraft-service') as any),
    def('kingflexy',    'kingflexy_reference',    'kingflexy_reference',    () => import('@/lib/kingflexy-service') as any),
    def('eazydata',     'eazydata_reference',     'eazydata_reference',     () => import('@/lib/eazydata-service') as any),
    def('agentportal',  'agentportal_reference',  'agentportal_reference',  () => import('@/lib/agentportal-service') as any),
    def('netpulse',     'netpulse_reference',     'netpulse_reference',     () => import('@/lib/netpulse-service') as any),
    def('hendylinks',   'hendylinks_reference',   'hendylinks_reference',   () => import('@/lib/hendylinks-service') as any),
    def('bundleportal', 'bundleportal_reference', 'bundleportal_reference', () => import('@/lib/bundleportal-service') as any),
]

const BY_ID = new Map(SUPPLIERS.map(s => [s.id, s]))

export function getSupplier(id: string): SupplierDef | undefined {
    return BY_ID.get(id as SupplierId)
}

// ─── Settings ──────────────────────────────────────────────────────────────────

export interface FulfillmentConfig {
    globalEnabled: boolean
    /** The parsed fulfillment_settings object ({} when absent or malformed). */
    settings: Record<string, any>
}

/** Parse fulfillment_settings. Malformed JSON yields {} — no supplier, nothing ships. */
export function parseFulfillmentSettings(raw: unknown): Record<string, any> {
    if (!raw) return {}
    if (typeof raw === 'object') return raw as Record<string, any>
    try {
        const parsed = JSON.parse(String(raw))
        return parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
        console.error('[SupplierRouter] fulfillment_settings is not valid JSON — no supplier will be used')
        return {}
    }
}

export async function loadFulfillmentConfig(db: any): Promise<FulfillmentConfig> {
    const { data } = await db
        .from('admin_settings')
        .select('key, value')
        .in('key', ['auto_fulfillment_enabled', 'fulfillment_settings'])

    const map = ((data as any[]) || []).reduce((acc: Record<string, any>, row: any) => {
        acc[row.key] = row.value
        return acc
    }, {})

    return {
        globalEnabled: String(map.auto_fulfillment_enabled) !== 'false',
        settings: parseFulfillmentSettings(map.fulfillment_settings),
    }
}

export type Route =
    | { kind: 'ok'; primary: SupplierDef; fallback: SupplierDef | null }
    | { kind: 'none' }
    | { kind: 'conflict'; ids: SupplierId[] }

/**
 * Primary + fallback for a network. No primary means auto-fulfilment is paused for
 * the network — a fallback on its own is never used, so disconnecting the primary
 * stays the way an admin halts a network.
 */
export function resolveRoute(settings: Record<string, any>, network: string): Route {
    const primaries = SUPPLIERS.filter(s => settings?.[s.flag]?.[network] === true)
    if (primaries.length > 1) return { kind: 'conflict', ids: primaries.map(s => s.id) }
    if (primaries.length === 0) return { kind: 'none' }

    const primary = primaries[0]
    const fallbackId = settings?.fallback?.[network]
    const fallback = fallbackId && fallbackId !== primary.id ? getSupplier(fallbackId) ?? null : null
    return { kind: 'ok', primary, fallback }
}

// ─── Attempts ──────────────────────────────────────────────────────────────────

/** One supplier call, as recorded on orders.supplier_attempts. */
export interface SupplierAttempt {
    supplier: SupplierId
    at: string
    outcome: 'success' | 'already_submitted' | 'refused' | 'unknown'
    error?: string
}

type Match = { column: 'id' | 'shop_order_id'; value: string }

/** Prior attempts for an order. [] when none — or when the column isn't migrated yet. */
export async function readAttempts(db: any, match: Match): Promise<SupplierAttempt[]> {
    const { data, error } = await db.from('orders').select('supplier_attempts').eq(match.column, match.value).maybeSingle()
    if (error || !Array.isArray(data?.supplier_attempts)) return []
    return data.supplier_attempts
}

/**
 * Append to orders.supplier_attempts. Best-effort by design: a missing column
 * (migration not run) costs the attempts history and the sticky-unknown rule
 * across retries, never the order itself.
 */
export async function appendAttempts(db: any, match: Match, prior: SupplierAttempt[], added: SupplierAttempt[]) {
    if (added.length === 0) return
    const { error } = await db.from('orders')
        .update({ supplier_attempts: [...prior, ...added].slice(-20) })
        .eq(match.column, match.value)
    if (error) console.warn(`[SupplierRouter] Could not record supplier_attempts for ${match.value}: ${error.message}`)
}

/** "Dakazina refused (insufficient balance) → BundlePortal ✓" — for alerts and the admin page. */
export function describeAttempts(attempts: SupplierAttempt[]): string {
    return attempts.map(a => {
        const name = getSupplier(a.supplier)?.name || a.supplier
        if (a.outcome === 'success' || a.outcome === 'already_submitted') return `${name} ✓`
        return `${name} ${a.outcome}${a.error ? ` (${a.error})` : ''}`
    }).join(' → ')
}

// ─── Dispatch ──────────────────────────────────────────────────────────────────

export interface FulfillParams {
    db: any
    network: string
    phone: string
    size: string
    /** The id sent to the supplier as its order/idempotency reference. */
    orderId: string
    /** Which orders row this is, for supplier_attempts. */
    match: Match
    /**
     * 'retry' is the admin re-fulfil button and the auto-refulfill cron: HendyLinks
     * checks its history before re-placing, and BundlePortal reuses the storefront id.
     */
    mode: 'live' | 'retry'
    /** Storefront orders were first placed at BundlePortal under shop_orders.id. */
    shopOrderId?: string | null
    /** Pre-loaded settings, so a batch (cron, bulk) reads admin_settings once. */
    config?: FulfillmentConfig
    /**
     * Runs before each supplier call. Storefront paths stamp shop_orders.fulfilled_by
     * here: the per-supplier sync crons find orders by it, so it must name the
     * supplier being called BEFORE the call, in case the function dies mid-request.
     */
    onBeforeAttempt?: (supplier: SupplierDef) => Promise<void>
    /**
     * Epoch ms after which the fallback is not started. A supplier call can take
     * ~30s, so a route with a hard limit passes its own budget here; the order then
     * stays pending for the next run instead of the function being killed mid-call.
     */
    fallbackDeadline?: number
}

export type FulfillOutcome =
    | { status: 'disabled' }
    | { status: 'no_supplier' }
    | { status: 'conflict'; ids: SupplierId[] }
    /** The order is with `supplier` (fresh success, or adopted as already submitted). */
    | { status: 'placed'; supplier: SupplierDef; result: SupplierResult; reference?: string; attempts: SupplierAttempt[]; fellBack: boolean }
    /** Nothing placed. `last` is the final supplier tried and its result. */
    | { status: 'failed'; supplier: SupplierDef; result: SupplierResult; attempts: SupplierAttempt[] }

/** The reference to stamp: Dakazina's webhook ref first (their events carry nothing else). */
export function supplierReference(supplier: SupplierDef, result: SupplierResult): string | undefined {
    if (supplier.id === 'datakazina') return result.webhookRef || result.transactionId || result.reference
    return result.transactionId || result.reference
}

async function callSupplier(s: SupplierDef, p: FulfillParams): Promise<SupplierResult> {
    try {
        const { fulfillOrder } = await s.load()
        if (s.id === 'hendylinks') {
            // No idempotency key at HendyLinks: on a retry, adopt an order an earlier
            // attempt created instead of placing a second one.
            return await fulfillOrder(p.network, p.phone, p.size, p.orderId, { isRetry: p.mode === 'retry' })
        }
        if (s.id === 'bundleportal') {
            // order_id is BundlePortal's idempotency key; reuse the storefront id the
            // first attempt used so a silent success comes back as a duplicate.
            const key = p.mode === 'retry' ? (p.shopOrderId || p.orderId) : p.orderId
            return await fulfillOrder(p.network, p.phone, p.size, key, { isRetry: p.mode === 'retry' })
        }
        return await fulfillOrder(p.network, p.phone, p.size, p.orderId)
    } catch (err: any) {
        // A throw from inside the service is an unclassified failure — never fall back on it.
        return { success: false, error: err?.message || 'Supplier call threw', failureKind: 'unknown' }
    }
}

function attemptOf(s: SupplierDef, r: SupplierResult): SupplierAttempt {
    const outcome: SupplierAttempt['outcome'] =
        r.success ? (r.alreadySubmitted ? 'already_submitted' : 'success')
            : r.alreadySubmitted ? 'already_submitted'
                : r.failureKind === 'refused' ? 'refused' : 'unknown'
    return { supplier: s.id, at: new Date().toISOString(), outcome, ...(r.error ? { error: String(r.error).slice(0, 200) } : {}) }
}

/**
 * Send one order to its primary supplier, then to the fallback if the primary
 * definitely refused. Writes nothing but supplier_attempts — the caller stamps
 * status, fulfillment_method and the reference (each path has its own tables and
 * side effects), using `supplierReference` and the column names on the supplier.
 *
 * Never throws.
 */
export async function fulfillWithFallback(p: FulfillParams): Promise<FulfillOutcome> {
    const config = p.config ?? await loadFulfillmentConfig(p.db)
    if (!config.globalEnabled) return { status: 'disabled' }

    const route = resolveRoute(config.settings, p.network)
    if (route.kind === 'none') return { status: 'no_supplier' }
    if (route.kind === 'conflict') return { status: 'conflict', ids: route.ids }

    const prior = await readAttempts(p.db, p.match)

    // Sticky unknown: the most recent supplier that may have accepted this order is
    // the only one allowed to touch it again.
    const lastUnknown = [...prior].reverse().find(a => a.outcome === 'unknown')
    const stuckTo = lastUnknown ? getSupplier(lastUnknown.supplier) : undefined

    let chain: SupplierDef[]
    if (stuckTo && (stuckTo.id === route.primary.id || stuckTo.id === route.fallback?.id)) {
        chain = [stuckTo]
    } else {
        // The admin moved this network off that supplier entirely. Same as switching
        // suppliers always did: the order follows the new configuration.
        chain = route.fallback ? [route.primary, route.fallback] : [route.primary]
    }

    const added: SupplierAttempt[] = []
    let last: { supplier: SupplierDef; result: SupplierResult } | null = null

    for (const supplier of chain) {
        if (p.onBeforeAttempt) {
            await p.onBeforeAttempt(supplier).catch(err =>
                console.error(`[SupplierRouter] onBeforeAttempt failed for ${p.orderId}:`, err?.message))
        }
        const result = await callSupplier(supplier, p)
        const attempt = attemptOf(supplier, result)
        added.push(attempt)
        last = { supplier, result }

        if (result.success || result.alreadySubmitted) {
            await appendAttempts(p.db, p.match, prior, added)
            const fellBack = supplier.id !== chain[0].id
            if (fellBack) {
                console.warn(`[SupplierRouter] ${p.network} order ${p.orderId}: ${describeAttempts(added)}`)
                await notifyFallback(p, added)
            }
            return { status: 'placed', supplier, result, reference: supplierReference(supplier, result), attempts: added, fellBack }
        }

        if (attempt.outcome !== 'refused') break // unknown — stay with this supplier
        if (supplier !== chain[chain.length - 1]) {
            if (p.fallbackDeadline && Date.now() > p.fallbackDeadline) {
                console.warn(`[SupplierRouter] ${supplier.name} refused ${p.network} order ${p.orderId}; out of time for the fallback — left for the next run`)
                break
            }
            console.warn(`[SupplierRouter] ${supplier.name} refused ${p.network} order ${p.orderId} (${result.error}) — trying fallback`)
        }
    }

    await appendAttempts(p.db, p.match, prior, added)
    return { status: 'failed', supplier: last!.supplier, result: last!.result, attempts: added }
}

async function notifyFallback(p: FulfillParams, attempts: SupplierAttempt[]) {
    try {
        const { sendPushToAdmins } = await import('@/lib/web-push')
        await sendPushToAdmins({
            title: 'Order sent to fallback supplier',
            body: `${p.network} ${p.size}: ${describeAttempts(attempts)}`,
            url: '/admin/fulfillment',
        })
    } catch { /* an alert must never fail an order that was placed */ }
}

// ─── Stamping helpers ──────────────────────────────────────────────────────────

/** orders columns for a placed order: fulfillment_method plus the reference column. */
export function ordersStamp(supplier: SupplierDef, reference?: string): Record<string, string> {
    return { fulfillment_method: supplier.id, ...(reference ? { [supplier.ordersRefColumn]: reference } : {}) }
}

/** shop_orders columns for a placed order. */
export function shopOrdersStamp(supplier: SupplierDef, reference?: string): Record<string, string> {
    return reference ? { [supplier.shopRefColumn]: reference } : {}
}

/** Keys from a stamp that may be shed by updateOrderWithColumnFallback, most suspect first. */
export function optionalStampKeys(stamp: Record<string, any>): string[] {
    return [...Object.keys(stamp).filter(k => k.endsWith('_reference') || k.endsWith('_reference_id')), ...('fulfillment_method' in stamp ? ['fulfillment_method'] : [])]
}

/** A one-line reason for an admin alert when nothing could be placed. */
export function failureReason(outcome: Extract<FulfillOutcome, { status: 'failed' }>): string {
    if (outcome.attempts.length > 1) return `All suppliers refused: ${describeAttempts(outcome.attempts)}`
    const kind = outcome.result.failureKind === 'refused' ? 'refused' : 'failed (outcome unknown)'
    return `${outcome.supplier.name} ${kind}: ${outcome.result.error || 'Unknown error'}`
}
