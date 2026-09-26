import { sanitizeForLog } from '@/lib/safe-log'
import { normaliseSupplierStatus } from '@/lib/order-status-display'

// HendyLinks Fulfillment Service — mirrors lib/netpulse-service.ts architecture.
// API Docs: https://hendylinks.net/integration (behind a login)
//
// Notes specific to this supplier:
//   • Auth is the `X-API-KEY` header.
//   • POST /api/orders takes { recipient_phone, network, size_gb }. We use the
//     network+size form rather than data_plan_id so there is no catalogue map to
//     keep in sync.
//   • THERE IS NO GUARANTEED IDEMPOTENCY. Unlike every other supplier here, a
//     re-send may create a SECOND order. We do send `external_order_id`, which
//     their /webhook/order-status docs advertise and their /api/orders docs are
//     silent about — best-effort, and reclaimRecentOrder() below is what actually
//     stands in for a real idempotency key. See fulfillOrder.
//   • They document a SECOND order-placing endpoint, POST /webhook/order-status,
//     which takes the api_key in the body and answers { status: "success" }
//     instead of { success: true }. We use /api/orders (header auth) but parse
//     both envelopes, so switching is a one-line change.
//   • Their integer `order_id` is the only correlation key. It is what the
//     completion webhook carries and what the reconciliation cron matches on, so
//     it is stored (as text) in orders.hendylinks_reference.
//   • Completion arrives by signed webhook (app/api/webhooks/hendylinks).
//     app/api/cron/sync-hendylinks-status is the fallback for missed deliveries.
//   • There is NO per-order status endpoint — only GET /api/orders?limit&offset.
//     So reconciliation reads a page of history once and matches locally rather
//     than polling per order.

const HENDYLINKS_API_KEY = process.env.HENDYLINKS_API_KEY || ''
const HENDYLINKS_API_URL = process.env.HENDYLINKS_API_URL || 'https://hendylinks.net'

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
    // True when the order was recovered by reclaimRecentOrder rather than placed
    // by this call — the order already lives at the supplier.
    alreadySubmitted?: boolean
}

interface StatusResponse {
    success: boolean
    status: 'pending' | 'processing' | 'completed' | 'failed'
    message?: string
    data?: any
}

/** One row from GET /api/orders, reduced to what we actually use. */
interface RemoteOrder {
    id: string
    status: string
    recipientPhone: string
    sizeGb: number | null
    createdAt: number | null
    /** Our own order id, when HendyLinks echoes the external_order_id we sent. */
    externalOrderId: string | null
}

// ─── Network Resolver ──────────────────────────────────────────────────────────
/**
 * Map an internal Arhms network name to HendyLinks' `network` value.
 * Internal names: "MTN", "Telecel", "AT-iShare", "AT-BigTime".
 * HendyLinks documents its own set as MTN / TELECEL / AIRTELTIGO, and does not
 * distinguish iShare from BigTime, so both AT variants map onto AIRTELTIGO —
 * the same choice lib/netpulse-service.ts makes.
 *
 * Kept as one table so a correction is a one-line change rather than a hunt.
 */
const NETWORKS: Record<string, string> = {
    MTN: 'MTN',
    Telecel: 'TELECEL',
    'AT-iShare': 'AIRTELTIGO',
    'AT-BigTime': 'AIRTELTIGO',
}

function resolveNetwork(network: string): string | null {
    if (NETWORKS[network]) return NETWORKS[network]
    // Loose fallbacks for slight naming variations.
    const n = (network || '').toUpperCase()
    if (n.startsWith('AT')) return 'AIRTELTIGO'
    if (n === 'TELECEL' || n === 'VODAFONE') return 'TELECEL'
    if (n.startsWith('MTN')) return 'MTN'
    return null
}

// Deliberately NO catalogue pre-validation. NetPulse hardcodes the sizes it
// sells and rejects anything else up front, but we have no visibility of the
// HendyLinks catalogue — a guessed list would reject orders they would happily
// have taken. Let their API answer and surface its message instead, the way
// eazydata and kingflexy already do.

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
        console.log('[HendyLinks] Circuit breaker OPENED')
    }
}

// ─── Helpers ───────────────────────────────────────────────────────────────────
/** Normalise any Ghanaian number to the 0XXXXXXXXX form HendyLinks accepts. */
function normalizePhone(phoneNumber: string): string {
    let p = (phoneNumber || '').replace(/\s+/g, '').replace(/-/g, '').replace(/^\+/, '')
    if (p.startsWith('233')) p = '0' + p.slice(3)
    else if (!p.startsWith('0')) p = '0' + p
    return p
}

/** Whole-GB volume from a size string like "5GB" / "5" / "5.0 GB". */
function parseGigabytes(dataSize: string): number | null {
    const match = (dataSize || '').match(/[\d.]+/)
    if (!match) return null
    const gb = Number(match[0])
    if (isNaN(gb) || gb <= 0) return null
    return gb
}

function authHeaders(extra: Record<string, string> = {}) {
    return { Accept: 'application/json', 'X-API-KEY': HENDYLINKS_API_KEY, ...extra }
}

/**
 * Their history rows are documented only through the webhook payload's `order`
 * object, so read every field defensively — a renamed key must degrade to "we
 * can't tell" rather than throw mid-reconciliation.
 */
function toRemoteOrder(raw: any): RemoteOrder | null {
    const id = raw?.id ?? raw?.order_id
    if (id === undefined || id === null) return null
    const sizeMb = Number(raw?.size_mb)
    const createdAt = Date.parse(raw?.created_at ?? '')
    const externalId = raw?.external_order_id ?? raw?.externalOrderId
    return {
        id: String(id),
        status: String(raw?.status ?? ''),
        recipientPhone: normalizePhone(String(raw?.recipient_phone ?? '')),
        sizeGb: isNaN(sizeMb) || sizeMb <= 0 ? parseGigabytes(String(raw?.plan_name ?? '')) : sizeMb / 1024,
        createdAt: isNaN(createdAt) ? null : createdAt,
        externalOrderId: externalId === undefined || externalId === null ? null : String(externalId),
    }
}

/** GET /api/orders — a page of our own order history, newest first. */
async function fetchOrderHistory(limit: number, offset: number, timeoutMs: number): Promise<RemoteOrder[]> {
    const url = `${HENDYLINKS_API_URL}/api/orders?limit=${limit}&offset=${offset}`
    const response = await fetch(url, {
        method: 'GET',
        headers: authHeaders(),
        signal: AbortSignal.timeout(timeoutMs),
    })

    const rawText = await response.text()
    let data: any
    try {
        data = JSON.parse(rawText)
    } catch {
        console.error(`[HendyLinks] Non-JSON history response (HTTP ${response.status}):`, rawText.slice(0, 300))
        return []
    }

    if (!response.ok) {
        console.error(`[HendyLinks] History fetch failed (HTTP ${response.status}):`, data?.message)
        return []
    }

    // Their docs don't pin the envelope down, so accept the three plausible shapes.
    const rows: any[] = Array.isArray(data) ? data
        : Array.isArray(data?.orders) ? data.orders
            : Array.isArray(data?.data) ? data.data
                : []

    return rows.map(toRemoteOrder).filter((o): o is RemoteOrder => o !== null)
}

/**
 * Stand-in for the idempotency guarantee HendyLinks does not give.
 *
 * Looks for an order we may already have placed. Used in two places, both in
 * fulfillOrder:
 *
 *   1. After our own request errored or timed out — the request may well have
 *      landed and created an order before the connection dropped. This is the
 *      realistic double-send: without it the row stays 'pending', auto-refulfill
 *      picks it up and places a SECOND bundle, charging the wallet twice.
 *   2. Before placing at all, when the caller flags a retry.
 *
 * Two ways to match, in order of confidence:
 *
 *   • `external_order_id` — the order id we send with every create. An exact hit
 *     is definitive, so no time window is applied to it. Their docs advertise
 *     this field on /webhook/order-status but say nothing about it on
 *     /api/orders, so it may simply be ignored; hence the fallback.
 *   • recipient + size within `withinMs`. Heuristic, but a false positive is
 *     survivable: any order it adopts delivers exactly the bundle this order
 *     needed, to exactly the right number. The cost of a wrong adoption is
 *     bookkeeping — our row points at a sibling order's id — not a customer left
 *     short. The cost of NOT adopting is a duplicate bundle billed to us. Hence
 *     the deliberate asymmetry: adopt readily, and keep the window tight.
 */
async function reclaimRecentOrder(
    orderId: string,
    recipientPhone: string,
    gigVolume: number,
    withinMs: number,
    timeoutMs: number
): Promise<RemoteOrder | null> {
    try {
        const cutoff = Date.now() - withinMs
        const rows = await fetchOrderHistory(50, 0, timeoutMs)

        const byExternalId = rows.find(o => o.externalOrderId !== null && o.externalOrderId === orderId)
        if (byExternalId) return byExternalId

        return rows.find(o =>
            o.recipientPhone === recipientPhone
            && o.sizeGb !== null
            && Math.abs(o.sizeGb - gigVolume) < 0.01
            // A row with no parseable timestamp is not assumed recent.
            && o.createdAt !== null
            && o.createdAt >= cutoff
        ) || null
    } catch (err: any) {
        console.error('[HendyLinks] Reclaim scan failed:', err?.message)
        return null
    }
}

// ─── Main Fulfillment Function ─────────────────────────────────────────────────
/**
 * Fulfill a data order via HendyLinks.
 * POST /api/orders with { recipient_phone, network, size_gb }.
 *
 * `opts.isRetry` should be set by the refulfill paths (the auto-refulfill cron and
 * the admin re-fulfil button). It makes this check the supplier's history BEFORE
 * placing, so an order that was already created by an attempt whose response we
 * never saw is adopted instead of duplicated.
 */
export async function fulfillOrder(
    network: string,
    phoneNumber: string,
    dataSize: string,
    orderId: string,
    opts: { isRetry?: boolean } = {}
): Promise<FulfillmentResponse> {

    if (!checkCircuit()) {
        console.warn(`[HendyLinks] Circuit breaker is OPEN. Order ${orderId} kept pending.`)
        return { success: false, error: 'Service temporarily unavailable (circuit open)' }
    }

    if (!HENDYLINKS_API_KEY) {
        return { success: false, error: 'HendyLinks API key not configured' }
    }

    try {
        const resolvedNetwork = resolveNetwork(network)
        if (!resolvedNetwork) {
            return { success: false, error: `Unsupported network: ${network}` }
        }

        const gigVolume = parseGigabytes(dataSize)
        if (gigVolume === null) {
            return { success: false, error: `Invalid data size format: ${dataSize}` }
        }

        const normalizedPhone = normalizePhone(phoneNumber)

        // ── Pre-flight reclaim (retries only) ───────────────────────────────
        // Deliberately not run on first attempts: a customer legitimately buying
        // the same bundle for the same number twice in a row would otherwise have
        // the second purchase silently collapsed into the first.
        if (opts.isRetry) {
            const existing = await reclaimRecentOrder(orderId, normalizedPhone, gigVolume, 30 * 60_000, 10_000)
            if (existing) {
                console.warn(`[HendyLinks] Order ${orderId} already exists at supplier as #${existing.id} (status "${existing.status}") — adopting instead of re-placing.`)
                return {
                    success: true,
                    reference: existing.id,
                    transactionId: existing.id,
                    alreadySubmitted: true,
                    apiResponse: sanitizeForLog(existing),
                }
            }
        }

        const requestBody = {
            recipient_phone: normalizedPhone,
            network: resolvedNetwork,
            size_gb: gigVolume,
            // Their docs advertise external_order_id on /webhook/order-status and are
            // silent about it here, so treat it as best-effort: if /api/orders honours
            // it, reclaimRecentOrder gets an exact match instead of a phone+size guess.
            // If it ignores it, nothing is lost. Watch for a 400 naming this field on
            // the first live order — that would mean they validate strictly and it has
            // to come out again.
            external_order_id: orderId,
        }

        console.log(`[HendyLinks] Order ${orderId} | ${resolvedNetwork} | ${gigVolume}GB | recipient: ${normalizedPhone}`)
        console.log(`[HendyLinks] Request payload:`, sanitizeForLog(requestBody))

        // ── HTTP Fetch with 3-retry logic ───────────────────────────────────
        let response: Response | null = null
        let attempt = 0
        const maxAttempts = 3
        let lastError: Error | null = null
        // Whole-call budget across all attempts. A stalled supplier would otherwise
        // burn maxAttempts x the per-attempt timeout plus backoff, overrunning the
        // caller's function limit and getting killed before it can report failure.
        const fulfillDeadline = Date.now() + 25_000

        while (attempt < maxAttempts) {
            attempt++
            try {
                response = await fetch(`${HENDYLINKS_API_URL}/api/orders`, {
                    method: 'POST',
                    headers: authHeaders({ 'Content-Type': 'application/json' }),
                    body: JSON.stringify(requestBody),
                    // Bound the call. Without this a supplier that accepts the TCP
                    // connection and then stalls leaves fetch pending forever, and the
                    // whole serverless function is killed mid-order.
                    signal: AbortSignal.timeout(Math.max(2_000, fulfillDeadline - Date.now())),
                })

                if (response.status === 429) {
                    console.warn(`[HendyLinks] Rate limited (HTTP 429). Order ${orderId} kept pending.`)
                    return { success: false, error: 'Supplier Rate Limited (429)', isRateLimited: true }
                }

                break

            } catch (err: any) {
                lastError = err
                console.error(`[HendyLinks] Fetch error on attempt ${attempt}:`, err.message)
                // Do NOT retry the POST blindly. With no idempotency key, a request
                // that timed out may already have created an order — a straight retry
                // would place a second one. Ask the supplier what it actually has.
                const placed = await reclaimRecentOrder(orderId, normalizedPhone, gigVolume, 3 * 60_000, 8_000)
                if (placed) {
                    console.warn(`[HendyLinks] Attempt ${attempt} errored but order ${orderId} DID land as #${placed.id} — adopting.`)
                    recordSuccess()
                    return {
                        success: true,
                        reference: placed.id,
                        transactionId: placed.id,
                        alreadySubmitted: true,
                        apiResponse: sanitizeForLog(placed),
                    }
                }
                if (Date.now() >= fulfillDeadline) {
                    console.warn(`[HendyLinks] Fulfillment budget exhausted after attempt ${attempt} — giving up so the caller can report a failure.`)
                    break
                }
                if (attempt < maxAttempts) {
                    const delay = 2000 * attempt
                    console.log(`[HendyLinks] Retrying in ${delay}ms...`)
                    await new Promise(res => setTimeout(res, delay))
                }
            }
        }

        if (!response) {
            recordFailure()
            return { success: false, error: lastError?.message || 'Persistent network error connecting to HendyLinks' }
        }

        // ── Parse JSON ─────────────────────────────────────────────────────
        const rawText = await response.text()
        let data: any
        try {
            data = JSON.parse(rawText)
        } catch {
            console.error(`[HendyLinks] Non-JSON response (HTTP ${response.status}):`, rawText.slice(0, 300))
            recordFailure()
            return { success: false, error: `Supplier returned unexpected response format (HTTP ${response.status})` }
        }

        console.log(`[HendyLinks] API response:`, { status: response.status, order_id: data?.order_id })

        // ── Success ─────────────────────────────────────────────────────────
        // Two envelopes are documented: /api/orders answers { success: true, order_id },
        // /webhook/order-status answers { status: "success", order_id }. Accept either,
        // so this keeps working if the endpoints ever converge or we switch.
        const claimsSuccess = data?.success === true || String(data?.status).toLowerCase() === 'success'
        if (response.ok && claimsSuccess && data?.order_id !== undefined && data?.order_id !== null) {
            recordSuccess()
            const supplierOrderId = String(data.order_id)
            return {
                success: true,
                // Both fields carry the same value on purpose: the dispatcher reads
                // `transactionId || reference`, but shop-order-processor and both
                // refulfill paths read `transactionId` alone. Setting only one leaves
                // the reference column unstamped on those paths, and reconciliation
                // then never sees the order.
                reference: supplierOrderId,
                transactionId: supplierOrderId,
                apiResponse: sanitizeForLog(data),
            }
        }

        // ── Error responses ────────────────────────────────────────────────
        const errMsg = data?.message || data?.error || 'Unknown error'

        if (response.status === 402) {
            console.error(`[HendyLinks] Order ${orderId}: Insufficient balance! Top up the HendyLinks wallet.`)
        } else if (response.status === 401) {
            console.error(`[HendyLinks] Order ${orderId}: Invalid API key — check HENDYLINKS_API_KEY.`)
        } else if (response.status === 404) {
            console.error(`[HendyLinks] Order ${orderId}: Plan not found for ${resolvedNetwork} ${gigVolume}GB — they may not sell this size.`)
        } else if (response.status === 400) {
            console.error(`[HendyLinks] Order ${orderId}: Rejected by supplier — ${errMsg}`)
        }

        console.warn(`[HendyLinks] Order ${orderId} not fulfilled: ${errMsg}. Kept pending.`)
        if (response.status >= 500) {
            recordFailure()
        }
        return {
            success: false,
            error: `${errMsg} (HTTP ${response.status})`,
            apiResponse: sanitizeForLog(data),
        }

    } catch (error: any) {
        recordFailure()
        console.error(`[HendyLinks] Exception during fulfillOrder for ${orderId}:`, error.message)
        return { success: false, error: error.message || 'Unexpected exception' }
    }
}

// ─── Batch Status Read ─────────────────────────────────────────────────────────
/**
 * Resolve the current status of many orders in one pass.
 *
 * HendyLinks has no per-order status endpoint, so this pages GET /api/orders and
 * builds an id → status map, the way lib/agentportal-service.ts does. Reading a
 * page at a time rather than one call per order keeps a run's supplier traffic
 * bounded no matter how deep the backlog gets, and makes a quiet run free.
 *
 * Stops as soon as every wanted reference is accounted for, the page budget is
 * spent, or the caller's time budget runs out.
 */
export async function fetchRecentOrderStatuses(opts: {
    wantedRefs: string[]
    budgetMs?: number
    maxPages?: number
    pageSize?: number
}): Promise<Map<string, { status: 'pending' | 'processing' | 'completed' | 'failed'; raw: string }>> {
    const resolved = new Map<string, { status: 'pending' | 'processing' | 'completed' | 'failed'; raw: string }>()

    if (!HENDYLINKS_API_KEY || opts.wantedRefs.length === 0) return resolved
    if (!checkCircuit()) {
        console.warn('[HendyLinks] Circuit breaker is OPEN — skipping status scan.')
        return resolved
    }

    const wanted = new Set(opts.wantedRefs)
    const budgetMs = opts.budgetMs ?? 30_000
    const maxPages = opts.maxPages ?? 10
    const pageSize = opts.pageSize ?? 50
    const deadline = Date.now() + budgetMs

    try {
        for (let page = 0; page < maxPages; page++) {
            if (Date.now() >= deadline || wanted.size === resolved.size) break

            const rows = await fetchOrderHistory(pageSize, page * pageSize, Math.max(2_000, deadline - Date.now()))
            if (rows.length === 0) break

            for (const row of rows) {
                if (!wanted.has(row.id) || resolved.has(row.id)) continue
                resolved.set(row.id, { status: mapHendyLinksStatus(row.status), raw: row.status })
            }

            // A short page means we reached the end of the history.
            if (rows.length < pageSize) break
        }
        recordSuccess()
    } catch (err: any) {
        recordFailure()
        console.error('[HendyLinks] Status scan failed:', err?.message)
    }

    return resolved
}

// ─── Order Status Check ────────────────────────────────────────────────────────
/**
 * Single-order status, for the admin manual-sync route.
 *
 * Implemented on top of the batch reader because HendyLinks exposes no
 * per-order endpoint. Prefer fetchRecentOrderStatuses when checking more than
 * one order — this pages the same history for each call.
 */
export async function checkOrderStatus(reference: string): Promise<StatusResponse> {
    if (!checkCircuit()) return { success: false, status: 'pending', message: 'Service unavailable (circuit open)' }
    if (!HENDYLINKS_API_KEY) return { success: false, status: 'pending', message: 'API key not configured' }

    const resolved = await fetchRecentOrderStatuses({ wantedRefs: [reference], budgetMs: 10_000 })
    const hit = resolved.get(reference)
    if (!hit) return { success: false, status: 'pending', message: 'Order not found in recent history' }

    return { success: true, status: hit.status, message: hit.raw }
}

/**
 * Map a HendyLinks order status to ours.
 *
 * Their docs only ever name "completed" and "failed", so the synonym sets are
 * deliberately wide. Matching a single literal is what stranded 12 NetPulse
 * orders on "on_hold" and every EazyData order on "SUCCESS": an unrecognised
 * label falls through to 'pending', the sync cron ignores 'pending', and the
 * order sits in 'processing' forever. The cron's supplierLabels tally exists to
 * make any label missing from these lists visible.
 */
export function mapHendyLinksStatus(status: string): 'pending' | 'processing' | 'completed' | 'failed' {
    const s = normaliseSupplierStatus(status)
    const COMPLETED = ['completed', 'complete', 'delivered', 'success', 'successful', 'credited', 'fulfilled']
    const FAILED = ['failed', 'failure', 'cancelled', 'canceled', 'refunded', 'rejected', 'reversed', 'declined']
    const IN_FLIGHT = ['processing', 'pending', 'queued', 'in progress', 'verifying', 'on hold', 'onhold', 'awaiting verification', 'pending verification', 'under review']
    if (COMPLETED.includes(s)) return 'completed'
    if (FAILED.includes(s)) return 'failed'
    if (IN_FLIGHT.includes(s)) return 'processing'
    return 'pending'
}

// ─── Balance Fetch ─────────────────────────────────────────────────────────────
/**
 * Fetch live HendyLinks wallet balance.
 * GET /api/balance
 */
export async function fetchSupplierBalance(): Promise<{
    success: boolean
    balance?: number
    currency?: string
    error?: string
}> {
    if (!HENDYLINKS_API_KEY) return { success: false, error: 'HendyLinks API key not configured' }

    try {
        const response = await fetch(`${HENDYLINKS_API_URL}/api/balance`, {
            method: 'GET',
            headers: authHeaders(),
            // The admin balance route fans out to every supplier and awaits them all.
            // One untimed call would hang the whole panel.
            signal: AbortSignal.timeout(10_000),
        })

        const rawText = await response.text()
        let data: any
        try {
            data = JSON.parse(rawText)
        } catch {
            console.error('[HendyLinks Balance] Non-JSON response (HTTP', response.status, '):', rawText.slice(0, 300))
            return { success: false, error: `Unexpected response format (HTTP ${response.status})` }
        }

        console.log('[HendyLinks Balance] API response received', { status: response.status, ok: response.ok })

        const rawBalance = data?.balance ?? data?.data?.balance
        if (response.ok && rawBalance !== undefined && rawBalance !== null) {
            const balance = parseFloat(rawBalance) || 0
            return { success: true, balance, currency: data?.currency || data?.data?.currency || 'GHS' }
        }

        return { success: false, error: data?.message || data?.error || 'Failed to fetch balance' }

    } catch (error: any) {
        console.error('[HendyLinks Balance] Error:', error)
        return { success: false, error: error.message }
    }
}
