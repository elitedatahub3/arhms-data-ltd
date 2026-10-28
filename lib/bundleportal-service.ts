import { sanitizeForLog } from '@/lib/safe-log'
import type { SupplierFailureKind } from '@/lib/supplier-failure'
import { normaliseSupplierStatus } from '@/lib/order-status-display'

// BundlePortal Fulfillment Service — mirrors lib/hendylinks-service.ts architecture.
// API Docs: https://api.bundleportal.com (Developer API, v2)
//
// Notes specific to this supplier:
//   • ONE endpoint, POST /v2, for everything. The JSON body's `action` picks the
//     operation (place_order, check_balance, get_transactions, …). Auth is the
//     `x-api-key` header (bp_live_…).
//   • place_order takes { network, recipient, package_size (GB), order_id }.
//     We send OUR id as order_id, and BundlePortal guarantees idempotency on it:
//     a repeat returns the original order with `duplicate: true` and no second
//     charge. That makes a retried POST safe, which is why there is no
//     reclaim-by-history step here the way HendyLinks needs one.
//   • The id we are handed is orders.id on the dispatcher / refulfill / API paths
//     but shop_orders.id on the storefront path (lib/shop-order-processor). Both
//     the webhook and the reconciler therefore match an echoed order_id against
//     orders.id AND orders.shop_order_id.
//   • Their own `reference` (e.g. "KT-88213") is stored in
//     orders.bundleportal_reference and is the webhook's first lookup key.
//   • There is NO status polling on v2 — check_status answers 410. Completion
//     arrives by signed webhook (app/api/webhooks/bundleportal), which is NOT
//     retried by them, so app/api/cron/sync-bundleportal-status pages
//     get_transactions as the safety net for missed deliveries.
//   • Only one order may be in flight per recipient. A second one is refused with
//     409 pending_order — that is a "retry later", not a failure.
//   • MTN has three routes (mtn / mtn_2 / mtn_3) with separate catalogues. The
//     admin picks one in Admin → Fulfillment (fulfillment_settings.bundleportal_mtn_route,
//     default `mtn`); a size the chosen route doesn't sell is retried on plain `mtn`.
//     verify_number always asks plain `mtn`.

const BUNDLEPORTAL_API_KEY = process.env.BUNDLEPORTAL_API_KEY || ''
const BUNDLEPORTAL_API_URL = process.env.BUNDLEPORTAL_API_URL || 'https://api.bundleportal.com/v2'

// ─── Circuit Breaker ───────────────────────────────────────────────────────────
let circuitState: 'closed' | 'open' | 'half-open' = 'closed'
let failureCount = 0
let lastFailureTime: number | null = null
const FAILURE_THRESHOLD = 5
const RECOVERY_TIMEOUT = 60000 // 1 minute

// ─── Interfaces ───────────────────────────────────────────────────────────────
interface FulfillmentResponse {
    success: boolean
    reference?: string
    transactionId?: string
    error?: string
    apiResponse?: any
    isRateLimited?: boolean
    // True when BundlePortal answered `duplicate: true` — the order was already
    // placed by an earlier attempt and this call did not create a new one.
    alreadySubmitted?: boolean
    failureKind?: SupplierFailureKind
}

interface StatusResponse {
    success: boolean
    status: 'pending' | 'processing' | 'completed' | 'failed'
    message?: string
    data?: any
}

type MappedStatus = 'pending' | 'processing' | 'completed' | 'failed'

// ─── Network Resolver ──────────────────────────────────────────────────────────
/**
 * Map an internal Arhms network name to BundlePortal's `network` value.
 * Internal names: "MTN", "Telecel", "AT-iShare", "AT-BigTime".
 * BundlePortal has a single AirtelTigo catalogue (`airteltigo`, alias `ishare`),
 * so both AT variants map onto it — the same choice the other services make.
 */
const NETWORKS: Record<string, string> = {
    MTN: 'mtn',
    Telecel: 'telecel',
    'AT-iShare': 'airteltigo',
    'AT-BigTime': 'airteltigo',
}

function resolveNetwork(network: string): string | null {
    if (NETWORKS[network]) return NETWORKS[network]
    // Loose fallbacks for slight naming variations.
    const n = (network || '').toUpperCase()
    if (n.startsWith('AT')) return 'airteltigo'
    if (n === 'TELECEL' || n === 'VODAFONE') return 'telecel'
    if (n.startsWith('MTN')) return 'mtn'
    return null
}

/** BundlePortal's MTN routes, each with its own catalogue. */
export const MTN_ROUTES = ['mtn', 'mtn_2', 'mtn_3'] as const
export type MtnRoute = typeof MTN_ROUTES[number]

/** The saved route setting, or plain `mtn` when it is missing or unrecognised. */
export function parseMtnRoute(value: unknown): MtnRoute {
    return (MTN_ROUTES as readonly string[]).includes(value as string) ? value as MtnRoute : 'mtn'
}

// ─── Circuit Breaker Helpers ──────────────────────────────────────────────────
function checkCircuit(): boolean {
    if (circuitState === 'closed') return true
    if (circuitState === 'open') {
        const now = Date.now()
        if (lastFailureTime && now - lastFailureTime > RECOVERY_TIMEOUT) {
            circuitState = 'half-open'
            return true
        }
        return false
    }
    return true // half-open allows one attempt
}

function recordSuccess() {
    failureCount = 0
    circuitState = 'closed'
}

function recordFailure() {
    failureCount++
    lastFailureTime = Date.now()
    if (failureCount >= FAILURE_THRESHOLD) {
        circuitState = 'open'
        console.log('[BundlePortal] Circuit breaker OPENED')
    }
}

// ─── Helpers ───────────────────────────────────────────────────────────────────
/** Normalise any Ghanaian number to the 0XXXXXXXXX form BundlePortal requires. */
function normalizePhone(phoneNumber: string): string {
    let p = (phoneNumber || '').replace(/\s+/g, '').replace(/-/g, '').replace(/^\+/, '')
    if (p.startsWith('233')) p = '0' + p.slice(3)
    else if (!p.startsWith('0')) p = '0' + p
    return p
}

/** Volume in GB from a size string like "5GB" / "5" / "5.0 GB". */
function parseGigabytes(dataSize: string): number | null {
    const match = (dataSize || '').match(/[\d.]+/)
    if (!match) return null
    const gb = Number(match[0])
    if (isNaN(gb) || gb <= 0) return null
    return gb
}

/**
 * BundlePortal's order_id rule: letters, digits, `_` and `-`, up to 80 chars.
 * Our uuids already comply; this only guards against a future caller passing
 * something else, which would otherwise be a 400 on every attempt.
 */
function toOrderRef(orderId: string): string | null {
    return /^[A-Za-z0-9_-]{1,80}$/.test(orderId) ? orderId : null
}

/**
 * One POST to the single v2 endpoint. Returns the HTTP status and parsed body;
 * a non-JSON body is reported as `data: null` with the raw text for logging.
 */
async function callApi(action: string, body: Record<string, any>, timeoutMs: number): Promise<{ status: number; ok: boolean; data: any; rawText: string; retryAfter: string | null }> {
    const response = await fetch(BUNDLEPORTAL_API_URL, {
        method: 'POST',
        headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'x-api-key': BUNDLEPORTAL_API_KEY,
        },
        body: JSON.stringify({ action, ...body }),
        signal: AbortSignal.timeout(timeoutMs),
    })
    const rawText = await response.text()
    let data: any = null
    try {
        data = JSON.parse(rawText)
    } catch {
        data = null
    }
    return { status: response.status, ok: response.ok, data, rawText, retryAfter: response.headers.get('retry-after') }
}

// Error codes that mean "not now" rather than "never". The order stays pending
// and auto-refulfill tries again later with the SAME order_id, which their
// idempotency makes safe.
const RETRY_LATER_CODES = new Set(['pending_order', 'network_locked', 'order_capacity_busy', 'read_rate_limited', 'rate_limited'])

// ─── Main Fulfillment Function ─────────────────────────────────────────────────
/**
 * Fulfill a data order via BundlePortal.
 * POST /v2 { action: "place_order", network, recipient, package_size, order_id }.
 *
 * `opts.isRetry` is accepted for signature parity with the other services. It
 * needs no special handling here: a retry sends the same order_id, and
 * BundlePortal returns the original order (duplicate: true) instead of placing
 * a second one.
 *
 * `opts.mtnRoute` is the raw fulfillment_settings.bundleportal_mtn_route value;
 * anything unrecognised means plain `mtn`.
 */
export async function fulfillOrder(
    network: string,
    phoneNumber: string,
    dataSize: string,
    orderId: string,
    opts: { isRetry?: boolean; mtnRoute?: string } = {}
): Promise<FulfillmentResponse> {

    if (!checkCircuit()) {
        console.warn(`[BundlePortal] Circuit breaker is OPEN. Order ${orderId} kept pending.`)
        return { success: false, error: 'Service temporarily unavailable (circuit open)', failureKind: 'refused' }
    }

    if (!BUNDLEPORTAL_API_KEY) {
        return { success: false, error: 'BundlePortal API key not configured', failureKind: 'refused' }
    }

    try {
        const resolvedNetwork = resolveNetwork(network)
        if (!resolvedNetwork) {
            return { success: false, error: `Unsupported network: ${network}`, failureKind: 'refused' }
        }

        const gigVolume = parseGigabytes(dataSize)
        if (gigVolume === null) {
            return { success: false, error: `Invalid data size format: ${dataSize}`, failureKind: 'refused' }
        }

        const orderRef = toOrderRef(orderId)
        if (!orderRef) {
            // Without our own order_id there is no idempotency and no way to match
            // the webhook back to this order. Refuse rather than place blind.
            return { success: false, error: `Order id not usable as a BundlePortal order_id: ${orderId}`, failureKind: 'refused' }
        }

        const recipient = normalizePhone(phoneNumber)
        // MTN goes out on the route chosen in Admin → Fulfillment (mtn / mtn_2 / mtn_3).
        const route = resolvedNetwork === 'mtn' ? parseMtnRoute(opts.mtnRoute) : resolvedNetwork
        const first = await placeOnce({ network: route, recipient, package_size: gigVolume, order_id: orderRef }, orderId, opts)

        // Each MTN route has its own catalogue. A size the chosen route doesn't sell
        // is a plain rejection that created nothing, so the same order_id is placed
        // again on `mtn` straight away. Any other failure (balance, key, 5xx, retry
        // later, number not approved) is returned as it is.
        if (route !== resolvedNetwork && first.notOnRoute) {
            console.warn(`[BundlePortal] Order ${orderId}: ${route} refused (${first.error}) — retrying on ${resolvedNetwork}`)
            const second = await placeOnce({ network: resolvedNetwork, recipient, package_size: gigVolume, order_id: orderRef }, orderId, opts)
            delete second.notOnRoute
            return second
        }
        delete first.notOnRoute
        return first

    } catch (error: any) {
        recordFailure()
        console.error(`[BundlePortal] Exception during fulfillOrder for ${orderId}:`, error.message)
        return { success: false, error: error.message || 'Unexpected exception', failureKind: 'unknown' }
    }
}

/**
 * One place_order call, with the network-error retries, mapped to a FulfillmentResponse.
 * `notOnRoute` marks a plain 400/404/422 rejection — what a route that doesn't sell
 * the size answers — so fulfillOrder can try plain `mtn`.
 */
async function placeOnce(
    requestBody: { network: string; recipient: string; package_size: number; order_id: string },
    orderId: string,
    opts: { isRetry?: boolean }
): Promise<FulfillmentResponse & { notOnRoute?: boolean }> {
    const { network: resolvedNetwork, package_size: gigVolume, order_id: orderRef } = requestBody

    console.log(`[BundlePortal] Order ${orderId} | ${resolvedNetwork} | ${gigVolume}GB | recipient: ${requestBody.recipient}${opts.isRetry ? ' | retry' : ''}`)
    console.log(`[BundlePortal] Request payload:`, sanitizeForLog(requestBody))

    // ── HTTP call with 3-retry logic ────────────────────────────────────
    // A retry after a network error is SAFE here, unlike HendyLinks: the same
    // order_id comes back as the original order, never a second charge.
    let result: Awaited<ReturnType<typeof callApi>> | null = null
    let attempt = 0
    const maxAttempts = 3
    let lastError: Error | null = null
    // Whole-call budget across all attempts, so a stalled supplier cannot
    // overrun the caller's function limit.
    const fulfillDeadline = Date.now() + 25_000

    while (attempt < maxAttempts) {
        attempt++
        try {
            result = await callApi('place_order', requestBody, Math.max(2_000, fulfillDeadline - Date.now()))
            break
        } catch (err: any) {
            lastError = err
            console.error(`[BundlePortal] Fetch error on attempt ${attempt}:`, err.message)
            if (Date.now() >= fulfillDeadline) {
                console.warn(`[BundlePortal] Fulfillment budget exhausted after attempt ${attempt} — giving up so the caller can report a failure.`)
                break
            }
            if (attempt < maxAttempts) {
                const delay = 2000 * attempt
                console.log(`[BundlePortal] Retrying in ${delay}ms...`)
                await new Promise(res => setTimeout(res, delay))
            }
        }
    }

    if (!result) {
        recordFailure()
        return { success: false, error: lastError?.message || 'Persistent network error connecting to BundlePortal', failureKind: 'unknown' }
    }

    const { status: httpStatus, ok, data, rawText } = result

    if (data === null) {
        console.error(`[BundlePortal] Non-JSON response (HTTP ${httpStatus}):`, rawText.slice(0, 300))
        recordFailure()
        return { success: false, error: `Supplier returned unexpected response format (HTTP ${httpStatus})`, failureKind: 'unknown' }
    }

    const code: string | undefined = data?.code
    console.log(`[BundlePortal] API response:`, { status: httpStatus, code, reference: data?.data?.reference, orderStatus: data?.data?.status, duplicate: data?.duplicate ?? data?.data?.duplicate })

    // ── Success ─────────────────────────────────────────────────────────
    // `status` may be "processing" (sent to the network) or "cached" (queued
    // for manual delivery at their end). Both are real, paid orders.
    if (ok && data?.success === true) {
        recordSuccess()
        const supplierRef = data?.data?.reference ? String(data.data.reference) : orderRef
        const duplicate = data?.duplicate === true || data?.data?.duplicate === true
        if (duplicate) {
            console.warn(`[BundlePortal] Order ${orderId} already existed at supplier as ${supplierRef} — adopted, not re-placed.`)
        }
        return {
            success: true,
            // Both fields carry the same value on purpose: the dispatcher reads
            // `transactionId || reference`, but shop-order-processor and both
            // refulfill paths read `transactionId` alone.
            reference: supplierRef,
            transactionId: supplierRef,
            alreadySubmitted: duplicate || undefined,
            apiResponse: sanitizeForLog(data),
        }
    }

    // ── Error responses ────────────────────────────────────────────────
    const errMsg = data?.message || data?.error || 'Unknown error'

    if (httpStatus === 429 || httpStatus === 503 || (code && RETRY_LATER_CODES.has(code))) {
        console.warn(`[BundlePortal] Order ${orderId}: retry later (HTTP ${httpStatus}${code ? ` ${code}` : ''}, retry-after ${result.retryAfter ?? data?.retry_after ?? '?'}). Kept pending.`)
        return { success: false, error: `${errMsg} (HTTP ${httpStatus}${code ? ` ${code}` : ''})`, isRateLimited: true, apiResponse: sanitizeForLog(data), failureKind: 'refused' }
    }

    if (httpStatus === 402) {
        console.error(`[BundlePortal] Order ${orderId}: Insufficient balance! Top up the BundlePortal wallet.`)
    } else if (httpStatus === 401) {
        console.error(`[BundlePortal] Order ${orderId}: Invalid API key — check BUNDLEPORTAL_API_KEY.`)
    } else if (code === 'not_allowlisted') {
        console.error(`[BundlePortal] Order ${orderId}: recipient not yet approved for ${resolvedNetwork} — ${errMsg}`)
    } else if (httpStatus === 403) {
        console.error(`[BundlePortal] Order ${orderId}: account/channel blocked (${code || 'forbidden'}) — ${errMsg}`)
    } else if (httpStatus === 400) {
        console.error(`[BundlePortal] Order ${orderId}: Rejected by supplier — ${errMsg}. They may not sell ${resolvedNetwork} ${gigVolume}GB.`)
    }

    console.warn(`[BundlePortal] Order ${orderId} not fulfilled: ${errMsg}. Kept pending.`)
    if (httpStatus >= 500) {
        recordFailure()
    }
    return {
        success: false,
        error: `${errMsg} (HTTP ${httpStatus}${code ? ` ${code}` : ''})`,
        apiResponse: sanitizeForLog(data),
        // order_id is idempotent at BundlePortal (a repeat comes back as
        // duplicate: true, a success), so an explicit rejection below 500 is a
        // definite no even after a mid-flight error. The retry-later 429/503
        // branch above is likewise a refusal to create anything yet.
        failureKind: httpStatus >= 500 ? 'unknown' : 'refused',
        notOnRoute: (httpStatus === 400 || httpStatus === 404 || httpStatus === 422) && code !== 'not_allowlisted' || undefined,
    }
}

// ─── Batch Status Read ─────────────────────────────────────────────────────────
// Why a scan stopped. Only 'all_found', 'end_of_history' and 'reached_cutoff'
// mean the history was read far enough back to call a missing order missing;
// every other reason means the scan simply did not get there.
export type ScanStopReason =
    | 'all_found'
    | 'end_of_history'
    | 'reached_cutoff'
    | 'page_limit'
    | 'offset_ignored'
    | 'time_budget'
    | 'fetch_failed'
    | 'circuit_open'
    | 'no_key'

export interface OrderStatusScan {
    statuses: Map<string, { status: MappedStatus; raw: string }>
    stopReason: ScanStopReason
    pagesRead: number
    // created_at of the oldest transaction read, i.e. how far back the scan reached.
    oldestSeenAt: string | null
}

/**
 * Resolve the current status of many orders in one pass, keyed by the order_id
 * WE sent (orders.id or shop_orders.id).
 *
 * v2 has no per-order status call and get_transactions takes no filters, only
 * limit/offset, so this pages it (newest first) and builds an order_id → status
 * map. Pass `scanBackTo` (the oldest backlog order's created_at) and it keeps
 * paging until it reaches transactions older than that, instead of giving up
 * after a fixed few pages — a fixed window let busy-day orders fall out of
 * reach within hours and get reported as "not found" while still undelivered.
 */
export async function fetchRecentOrderStatuses(opts: {
    wantedOrderIds: string[]
    budgetMs?: number
    maxPages?: number
    pageSize?: number
    scanBackTo?: string
}): Promise<OrderStatusScan> {
    const statuses = new Map<string, { status: MappedStatus; raw: string }>()
    const result = (stopReason: ScanStopReason, pagesRead = 0, oldestSeenAt: string | null = null): OrderStatusScan =>
        ({ statuses, stopReason, pagesRead, oldestSeenAt })

    if (!BUNDLEPORTAL_API_KEY) return result('no_key')
    if (opts.wantedOrderIds.length === 0) return result('all_found')
    if (!checkCircuit()) {
        console.warn('[BundlePortal] Circuit breaker is OPEN — skipping status scan.')
        return result('circuit_open')
    }

    const wanted = new Set(opts.wantedOrderIds)
    const budgetMs = opts.budgetMs ?? 30_000
    const maxPages = opts.maxPages ?? (opts.scanBackTo ? 30 : 10)
    const pageSize = opts.pageSize ?? 100
    const cutoffMs = opts.scanBackTo ? Date.parse(opts.scanBackTo) : NaN
    const deadline = Date.now() + budgetMs

    let stopReason: ScanStopReason = 'page_limit'
    let pagesRead = 0
    let oldestSeenMs = Infinity
    let offset = 0
    let prevFirstKey: string | null = null

    try {
        for (let page = 0; page < maxPages; page++) {
            if (statuses.size === wanted.size) { stopReason = 'all_found'; break }
            if (Date.now() >= deadline) { stopReason = 'time_budget'; break }

            const { status, ok, data, rawText } = await callApi(
                'get_transactions',
                { limit: pageSize, offset },
                Math.max(2_000, deadline - Date.now())
            )
            if (!ok || data?.success !== true) {
                console.error(`[BundlePortal] get_transactions failed (HTTP ${status}) at offset ${offset}:`, data?.message || rawText.slice(0, 300))
                stopReason = 'fetch_failed'
                break
            }
            pagesRead++

            const rows: any[] = Array.isArray(data?.data?.transactions) ? data.data.transactions : []
            if (page === 0) {
                console.log(`[BundlePortal] get_transactions page shape: rows=${rows.length} count=${data?.data?.count} limit=${data?.data?.limit} (asked ${pageSize})`)
            }
            if (rows.length === 0) { stopReason = 'end_of_history'; break }

            // If the server ignores offset, every page is the same page — stop
            // rather than burn the budget re-reading it.
            const firstKey = `${rows[0]?.order_id}|${rows[0]?.created_at}`
            if (firstKey === prevFirstKey) { stopReason = 'offset_ignored'; break }
            prevFirstKey = firstKey

            for (const row of rows) {
                const createdMs = Date.parse(String(row?.created_at ?? ''))
                if (Number.isFinite(createdMs) && createdMs < oldestSeenMs) oldestSeenMs = createdMs

                const id = row?.order_id === undefined || row?.order_id === null ? null : String(row.order_id)
                if (!id || !wanted.has(id) || statuses.has(id)) continue
                const raw = String(row?.status ?? '')
                statuses.set(id, { status: mapBundlePortalStatus(raw), raw })
            }

            if (statuses.size === wanted.size) { stopReason = 'all_found'; break }
            if (Number.isFinite(cutoffMs) && oldestSeenMs < cutoffMs) { stopReason = 'reached_cutoff'; break }

            // Advance by what actually came back, NOT by the limit we asked for: the
            // server caps page size below 100, so a short page is NOT the end of the
            // history. Treating it as the end meant only ever reading page one.
            offset += rows.length
            // `count` only settles it when it is plainly a grand total; if it merely
            // equals this page's length, keep going — an empty page ends the scan.
            const total = Number(data?.data?.count)
            if (Number.isFinite(total) && total > rows.length && offset >= total) { stopReason = 'end_of_history'; break }
        }
        recordSuccess()
    } catch (err: any) {
        recordFailure()
        stopReason = 'fetch_failed'
        console.error('[BundlePortal] Status scan failed:', err?.message)
    }

    const oldestSeenAt = Number.isFinite(oldestSeenMs) ? new Date(oldestSeenMs).toISOString() : null
    console.log(`[BundlePortal] Status scan: ${statuses.size}/${wanted.size} found, ${pagesRead} page(s), stop=${stopReason}, reached back to ${oldestSeenAt ?? 'n/a'}`)
    return result(stopReason, pagesRead, oldestSeenAt)
}

/**
 * Single-order status, for the admin manual-sync route. Built on the batch
 * reader because v2 exposes no per-order endpoint.
 */
export async function checkOrderStatus(orderId: string): Promise<StatusResponse> {
    if (!checkCircuit()) return { success: false, status: 'pending', message: 'Service unavailable (circuit open)' }
    if (!BUNDLEPORTAL_API_KEY) return { success: false, status: 'pending', message: 'API key not configured' }

    const { statuses } = await fetchRecentOrderStatuses({ wantedOrderIds: [orderId], budgetMs: 10_000 })
    const hit = statuses.get(orderId)
    if (!hit) return { success: false, status: 'pending', message: 'Order not found in recent history' }

    return { success: true, status: hit.status, message: hit.raw }
}

/**
 * Map a BundlePortal order status to ours.
 *
 * They document processing / cached / completed / failed, plus the webhook
 * events order.cancelled and order.refunded. The synonym sets are kept wide on
 * purpose: an unrecognised label falls through to 'pending', the reconciler
 * ignores 'pending', and the order sits in 'processing' forever.
 */
export function mapBundlePortalStatus(status: string): MappedStatus {
    const s = normaliseSupplierStatus(status)
    const COMPLETED = ['completed', 'complete', 'delivered', 'success', 'successful', 'credited', 'fulfilled']
    const FAILED = ['failed', 'failure', 'cancelled', 'canceled', 'refunded', 'rejected', 'reversed', 'declined']
    const IN_FLIGHT = ['processing', 'cached', 'pending', 'queued', 'in progress', 'verifying', 'on hold', 'onhold']
    if (COMPLETED.includes(s)) return 'completed'
    if (FAILED.includes(s)) return 'failed'
    if (IN_FLIGHT.includes(s)) return 'processing'
    return 'pending'
}

// ─── MTN Number Verification ───────────────────────────────────────────────────
/**
 * Check which MTN numbers BundlePortal will deliver to.
 * POST /v2 { action: "verify_number", network: "mtn", recipient } — free, one
 * number per call, and unlike Agent Portal it does NOT submit an unapproved
 * number for registration. Calls run with bounded concurrency, as their docs ask.
 *
 * `allowed` holds approved numbers; `inFlight` those approved but blocked by an
 * unfinished order (can_order false). A number whose lookup failed is in
 * neither set and is reported in `failed`.
 *
 * Also consulted by the MTN registration gate (lib/mtn-registration-gate.ts): a
 * number accepted here is let through even if Agent Portal has not enabled it. The
 * gate passes its own per-call `timeoutMs`, tighter than the checker page's default.
 */
export async function verifyMtnNumbers(msisdns: string[], concurrency = 5, options?: { timeoutMs?: number }): Promise<{
    success: boolean
    allowed: Set<string>
    inFlight: Set<string>
    failed: Set<string>
    error?: string
}> {
    const allowed = new Set<string>()
    const inFlight = new Set<string>()
    const failed = new Set<string>()
    if (!BUNDLEPORTAL_API_KEY) return { success: false, allowed, inFlight, failed, error: 'API key not configured' }

    let lastError: string | undefined
    let next = 0
    const worker = async () => {
        while (next < msisdns.length) {
            const number = msisdns[next++]
            try {
                const { ok, data, status } = await callApi('verify_number', { network: 'mtn', recipient: normalizePhone(number) }, options?.timeoutMs ?? 10_000)
                if (ok && data?.success === true && data?.data) {
                    if (data.data.allowed === true) {
                        allowed.add(number)
                        if (data.data.can_order === false) inFlight.add(number)
                    }
                } else {
                    failed.add(number)
                    lastError = data?.message || data?.error || `HTTP ${status}`
                }
            } catch (error: any) {
                failed.add(number)
                lastError = error?.message || 'Connection error'
            }
        }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, msisdns.length) }, worker))

    if (failed.size === msisdns.length && msisdns.length > 0) {
        console.error('[BundlePortal Verify] Every lookup failed:', lastError)
        return { success: false, allowed, inFlight, failed, error: lastError }
    }
    return { success: true, allowed, inFlight, failed }
}

// ─── Balance Fetch ─────────────────────────────────────────────────────────────
/**
 * Fetch live BundlePortal wallet balance.
 * POST /v2 { action: "check_balance" }
 */
export async function fetchSupplierBalance(): Promise<{
    success: boolean
    balance?: number
    currency?: string
    error?: string
}> {
    if (!BUNDLEPORTAL_API_KEY) return { success: false, error: 'BundlePortal API key not configured' }

    try {
        // The admin balance route fans out to every supplier and awaits them all.
        // One untimed call would hang the whole panel.
        const { status, ok, data, rawText } = await callApi('check_balance', {}, 10_000)

        if (data === null) {
            console.error('[BundlePortal Balance] Non-JSON response (HTTP', status, '):', rawText.slice(0, 300))
            return { success: false, error: `Unexpected response format (HTTP ${status})` }
        }

        const rawBalance = data?.data?.wallet_balance
        if (ok && data?.success === true && rawBalance !== undefined && rawBalance !== null) {
            const balance = parseFloat(rawBalance) || 0
            return { success: true, balance, currency: data?.data?.currency || 'GHS' }
        }

        return { success: false, error: data?.message || data?.error || 'Failed to fetch balance' }

    } catch (error: any) {
        console.error('[BundlePortal Balance] Error:', error)
        return { success: false, error: error.message }
    }
}
