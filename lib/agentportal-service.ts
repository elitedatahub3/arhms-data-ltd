import { sanitizeForLog } from '@/lib/safe-log'
import type { SupplierFailureKind } from '@/lib/supplier-failure'

// Agent Portal GH Fulfillment Service — mirrors lib/eazydata-service.ts architecture.
// API Docs: https://api.agentportalgh.com  (see "Agent API" reference)
//
// IMPORTANT — this supplier is ASYNCHRONOUS / QUEUE-BASED and differs from the others:
//   • POST /api/queue/add returns only { added, charged, balance } — NO transaction id.
//     We correlate results using the `reference` WE supply (the Arhms order id).
//   • Completion is delivered via a signed webhook (order.completed) handled in
//     app/api/webhooks/agentportal/route.ts. checkOrderStatus() here is a best-effort
//     poll used only by the fallback reconciliation cron.

const AGENTPORTAL_API_KEY = process.env.AGENTPORTAL_API_KEY || ''
const AGENTPORTAL_API_URL = process.env.AGENTPORTAL_API_URL || 'https://api.agentportalgh.com'

// How many calendar days back the reconciliation scan reads (today + the previous
// AGENTPORTAL_SCAN_DAYS-1). Exported so the cron can bound its DB query to the same
// window — see fetchRecentItemStatuses for why the two must agree.
export const AGENTPORTAL_SCAN_DAYS = 3
// Safety stop for the paginated order-list walk, so a broken paginator can't spin.
const AGENTPORTAL_MAX_PAGES = 20
// Both list endpoints default to 20 rows a page and honour `page_size` (measured:
// `per_page`/`limit`/`pageSize` are ignored, `page_size` is not). Reading the default
// page is what silently truncated the scan — a 19-order group returned 19 'uploaded'
// rows and only ONE delivery row, so 18 orders looked unresolved.
const AGENTPORTAL_PAGE_SIZE = 100
// The order list is slow (~13s a page regardless of size); the items endpoint is fast
// (~0.8s) and parallelises cleanly, so items are fetched with a worker pool.
const AGENTPORTAL_ITEMS_CONCURRENCY = 12

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
    alreadySubmitted?: boolean
    // True when the order was rejected because the MTN number isn't enabled on the
    // account yet (whitelist gate). Agent Portal auto-submits it to MTN for enabling
    // (up to 2 weeks); the order is kept pending and the auto-refulfill cron retries it later.
    whitelistPending?: boolean
    failureKind?: SupplierFailureKind
}

interface StatusResponse {
    success: boolean
    status: 'pending' | 'processing' | 'completed' | 'failed'
    message?: string
    data?: any
}

// ─── Per-network GB windows (from Agent Portal docs) ────────────────────────────
// service code → { min, max } whole-GB bundle window.
const SERVICE_WINDOWS: Record<string, { service: string; min: number; max: number }> = {
    MTN: { service: 'mtn', min: 1, max: 200 },
    Telecel: { service: 'telecel', min: 10, max: 200 },
    'AT-iShare': { service: 'airteltigo', min: 1, max: 200 },
    'AT-BigTime': { service: 'airteltigo', min: 1, max: 200 },
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
        console.log('[AgentPortal] Circuit breaker OPENED')
    }
}

// ─── Network Resolver ──────────────────────────────────────────────────────────
/**
 * Map an internal Arhms network name to Agent Portal's `service` code + GB window.
 * Internal names: "MTN", "Telecel", "AT-iShare", "AT-BigTime".
 * Agent Portal services: "mtn", "telecel", "airteltigo".
 */
function resolveService(network: string): { service: string; min: number; max: number } | null {
    if (SERVICE_WINDOWS[network]) return SERVICE_WINDOWS[network]
    // Loose fallbacks for slight naming variations.
    const n = (network || '').toUpperCase()
    if (n.startsWith('AT')) return SERVICE_WINDOWS['AT-iShare']
    if (n === 'TELECEL' || n === 'VODAFONE') return SERVICE_WINDOWS['Telecel']
    if (n.startsWith('MTN')) return SERVICE_WINDOWS['MTN']
    return null
}

// ─── Main Fulfillment Function ─────────────────────────────────────────────────
/**
 * Fulfill a data order via Agent Portal GH.
 * POST /api/queue/add with { service, items: [{ msisdn, data_gb, reference }] }.
 * The wallet is charged atomically on submit; the item is then batched into an
 * order and delivered asynchronously (completion arrives via webhook).
 * `reference` is set to the Arhms orderId so the webhook can be matched back.
 */
export async function fulfillOrder(
    network: string,
    phoneNumber: string,
    dataSize: string,
    orderId: string
): Promise<FulfillmentResponse> {

    if (!checkCircuit()) {
        console.warn(`[AgentPortal] Circuit breaker is OPEN. Order ${orderId} kept pending.`)
        return { success: false, error: 'Service temporarily unavailable (circuit open)', failureKind: 'refused' }
    }

    if (!AGENTPORTAL_API_KEY) {
        return { success: false, error: 'AgentPortal API key not configured', failureKind: 'refused' }
    }

    try {
        // ── Resolve network → service + GB window ───────────────────────────
        const svc = resolveService(network)
        if (!svc) {
            return { success: false, error: `Unsupported network: ${network}`, failureKind: 'refused' }
        }

        // ── Parse whole-GB volume (decimals rejected by the supplier) ───────
        const sizeMatch = dataSize.match(/[\d.]+/)
        if (!sizeMatch) {
            return { success: false, error: `Invalid data size format: ${dataSize}`, failureKind: 'refused' }
        }
        const gigVolume = Number(sizeMatch[0])
        if (isNaN(gigVolume) || gigVolume <= 0) {
            return { success: false, error: `Invalid GB volume parsed from: ${dataSize}`, failureKind: 'refused' }
        }
        if (!Number.isInteger(gigVolume)) {
            // Agent Portal only accepts whole-GB bundles.
            return { success: false, error: `AgentPortal accepts whole-GB bundles only (got ${gigVolume}GB for ${network})`, failureKind: 'refused' }
        }
        if (gigVolume < svc.min || gigVolume > svc.max) {
            return { success: false, error: `${svc.service} accepts ${svc.min}–${svc.max} GB — ${gigVolume}GB is out of range`, failureKind: 'refused' }
        }

        // ── Phone Normalization → 0XXXXXXXXX (10-digit Ghana) ───────────────
        let normalizedPhone = phoneNumber.replace(/\s+/g, '').replace(/-/g, '')
        if (normalizedPhone.startsWith('233')) normalizedPhone = '0' + normalizedPhone.slice(3)
        else if (!normalizedPhone.startsWith('0')) normalizedPhone = '0' + normalizedPhone

        const requestBody = {
            service: svc.service,
            items: [
                { msisdn: normalizedPhone, data_gb: gigVolume, reference: orderId },
            ],
        }

        console.log(`[AgentPortal] Order ${orderId} | ${svc.service} | ${gigVolume}GB | recipient: ${normalizedPhone}`)
        console.log(`[AgentPortal] Request payload:`, sanitizeForLog(requestBody))

        // ── HTTP Fetch with 3-retry logic (network errors only) ─────────────
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
                response = await fetch(`${AGENTPORTAL_API_URL}/api/queue/add`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Accept': 'application/json',
                        'X-API-Key': AGENTPORTAL_API_KEY,
                    },
                    body: JSON.stringify(requestBody),
                    // Bound the call. Without this a supplier that accepts the TCP
                    // connection and then stalls (never answering, never resetting) leaves
                    // fetch pending forever: the retry loop below never runs and the whole
                    // serverless function is killed mid-order, stranding the row in
                    // 'processing'. A timeout turns that hang into a retriable failure.
                    signal: AbortSignal.timeout(Math.max(2_000, fulfillDeadline - Date.now())),
                })

                if (response.status === 429) {
                    console.warn(`[AgentPortal] Rate limited (HTTP 429). Order ${orderId} kept pending.`)
                    return { success: false, error: 'Supplier Rate Limited (429)', isRateLimited: true, failureKind: lastError ? 'unknown' : 'refused' }
                }

                break

            } catch (err: any) {
                lastError = err
                console.error(`[AgentPortal] Fetch error on attempt ${attempt}:`, err.message)
                if (Date.now() >= fulfillDeadline) {
                    console.warn(`[agentportal] Fulfillment budget exhausted after attempt ${attempt} — giving up so the caller can report a failure.`)
                    break
                }
                if (attempt < maxAttempts) {
                    const delay = 2000 * attempt
                    console.log(`[AgentPortal] Retrying in ${delay}ms...`)
                    await new Promise(res => setTimeout(res, delay))
                }
            }
        }

        if (!response) {
            recordFailure()
            return { success: false, error: lastError?.message || 'Persistent network error connecting to AgentPortal', failureKind: 'unknown' }
        }

        // ── Parse JSON ─────────────────────────────────────────────────────
        const rawText = await response.text()
        let data: any
        try {
            data = JSON.parse(rawText)
        } catch (e) {
            console.error(`[AgentPortal] Non-JSON response (HTTP ${response.status}):`, rawText.slice(0, 300))
            recordFailure()
            return { success: false, error: `Supplier returned unexpected response format (HTTP ${response.status})`, failureKind: 'unknown' }
        }

        console.log(`[AgentPortal] API response:`, { status: response.status, added: data?.added })

        // ── Success: { added: >=1, charged, balance } ───────────────────────
        if (response.ok && typeof data?.added === 'number' && data.added >= 1) {
            recordSuccess()
            return {
                success: true,
                reference: orderId,
                transactionId: orderId, // no supplier id — we correlate by our own reference
                apiResponse: sanitizeForLog(data),
            }
        }

        // ── Whitelist gate: added: 0 with a `rejected` array (no charge) ─────
        // The MTN number isn't enabled yet — keep the order PENDING (not processing).
        if (response.ok && data?.added === 0) {
            const reason = Array.isArray(data?.rejected) && data.rejected[0]?.reason
                ? data.rejected[0].reason
                : 'number not enabled on MTN yet'
            // The whitelist/verification gate is MTN-only — only flag whitelistPending
            // (which triggers the customer verification SMS) for MTN orders.
            const isMtn = svc.service === 'mtn'
            console.warn(`[AgentPortal] Order ${orderId} not enqueued (added: 0): ${reason}.${isMtn ? ' Number auto-submitted to MTN for verification (up to 2 weeks).' : ''} Kept pending.`)
            // added: 0 means nothing was queued and nothing charged — a definite refusal,
            // so a fallback supplier may take the order instead of it waiting on MTN.
            return { success: false, error: reason, whitelistPending: isMtn, apiResponse: sanitizeForLog(data), failureKind: lastError ? 'unknown' : 'refused' }
        }

        // ── Error responses: { error: "message" } ───────────────────────────
        const errMsg = data?.error || 'Unknown error'

        // 402 insufficient balance — supplier is up, don't trip the breaker.
        if (response.status === 402) {
            console.error(`[AgentPortal] Order ${orderId}: insufficient wallet balance — top up AgentPortal. (${errMsg})`)
            return { success: false, error: errMsg, apiResponse: sanitizeForLog(data), failureKind: lastError ? 'unknown' : 'refused' }
        }

        // 401 auth error — misconfigured key, supplier is up.
        if (response.status === 401) {
            console.error(`[AgentPortal] Order ${orderId}: authentication error — check AGENTPORTAL_API_KEY. (${errMsg})`)
            return { success: false, error: errMsg, apiResponse: sanitizeForLog(data), failureKind: lastError ? 'unknown' : 'refused' }
        }

        console.warn(`[AgentPortal] Order ${orderId} not fulfilled: ${errMsg} (HTTP ${response.status}). Kept pending.`)
        if (response.status >= 500) {
            recordFailure()
        }
        return {
            success: false,
            error: errMsg,
            apiResponse: sanitizeForLog(data),
            failureKind: response.status >= 500 || lastError ? 'unknown' : 'refused',
        }

    } catch (error: any) {
        recordFailure()
        console.error(`[AgentPortal] Exception during fulfillOrder for ${orderId}:`, error.message)
        return { success: false, error: error.message || 'Unexpected exception', failureKind: 'unknown' }
    }
}

// ─── Paginated JSON GET ────────────────────────────────────────────────────────
/**
 * GET a JSON endpoint. `reached` reports whether the supplier answered with JSON at
 * all, so callers can tell "supplier unreachable" (bail) from "nothing to report".
 */
async function apiGet(path: string, timeoutMs = 20_000): Promise<{ reached: boolean; json: any }> {
    try {
        const resp = await fetch(`${AGENTPORTAL_API_URL}${path}`, {
            method: 'GET',
            headers: { 'Accept': 'application/json', 'X-API-Key': AGENTPORTAL_API_KEY },
            signal: AbortSignal.timeout(timeoutMs),
        })
        const text = await resp.text()
        try {
            return { reached: true, json: JSON.parse(text) }
        } catch {
            return { reached: false, json: null } // non-JSON (WAF/HTML/gateway error)
        }
    } catch {
        return { reached: false, json: null }
    }
}

// Envelope is { data: [...], total: n } — `total` is the only paging hint the API gives
// (no last_page / next_page_url), so page counts must be derived from it.
function rowsOf(json: any): any[] {
    return Array.isArray(json) ? json : (json?.data || json?.items || [])
}

/**
 * Read EVERY page of a paginated list endpoint. Page 1 is fetched first for its `total`,
 * then the remaining pages are fetched in parallel.
 *
 * `stopOnceOlderThan` (epoch ms) short-circuits the walk for the order list, which is
 * returned strictly newest-first: once a page reaches back past the oldest order we're
 * waiting on, no later page can hold anything we need. That keeps a routine run to a
 * single call on the endpoint that costs ~13s a page.
 */
async function fetchAllPages(
    basePath: string,
    timeoutMs = 20_000,
    stopOnceOlderThan?: number
): Promise<{ reached: boolean; rows: any[] }> {
    const sep = basePath.includes('?') ? '&' : '?'
    const first = await apiGet(`${basePath}${sep}page=1&page_size=${AGENTPORTAL_PAGE_SIZE}`, timeoutMs)
    if (!first.reached) return { reached: false, rows: [] }

    const rows = rowsOf(first.json)
    const total = Number(first.json?.total ?? 0)
    if (rows.length === 0 || total <= rows.length) return { reached: true, rows }

    const oldestOnPage = rows[rows.length - 1]?.created_at
    if (stopOnceOlderThan && oldestOnPage && new Date(oldestOnPage).getTime() < stopOnceOlderThan) {
        return { reached: true, rows }
    }

    const pages = Math.min(Math.ceil(total / AGENTPORTAL_PAGE_SIZE), AGENTPORTAL_MAX_PAGES)
    const rest = await Promise.all(
        Array.from({ length: pages - 1 }, (_, i) =>
            apiGet(`${basePath}${sep}page=${i + 2}&page_size=${AGENTPORTAL_PAGE_SIZE}`, timeoutMs))
    )
    for (const r of rest) rows.push(...rowsOf(r.json))
    return { reached: true, rows }
}

/** Every item row of one Agent Portal order group (all pages). */
export async function fetchOrderItems(groupId: string): Promise<any[]> {
    const { rows } = await fetchAllPages(
        `/api/beneficiaries/orders/${encodeURIComponent(groupId)}/items`, 15_000)
    return rows
}

// ─── Item rows → per-reference outcome ─────────────────────────────────────────
/**
 * Resolve the delivery outcome of EACH of our orders inside one Agent Portal order group.
 *
 * Shape of the items feed (measured):
 *   • A group is a BATCH — it can hold many of our orders (up to ~19 seen in production),
 *     each contributing one 'uploaded' row that carries OUR `reference` plus its own
 *     `batch_id` and `msisdn`.
 *   • When an item is delivered, Agent Portal appends a SEPARATE row with the terminal
 *     status ('success' / 'failed'), `reference: null`, and the SAME `batch_id`.
 *   • Small/instant orders sometimes appear as a single row that is both terminal and
 *     carries the reference.
 *
 * So the outcome of a given order is the terminal row sharing its `batch_id` — NOT
 * "did anything in this group succeed", which would resolve one order per group and
 * strand every other order in the batch.
 */
export function mapItemsToOutcomes(items: any[]): Map<string, 'completed' | 'failed'> {
    const outcomes = new Map<string, 'completed' | 'failed'>()
    if (!Array.isArray(items) || items.length === 0) return outcomes

    const statusOf = (it: any) => String(it?.status || '').toLowerCase()
    const terminalRows = items.filter(it => statusOf(it) === 'success' || statusOf(it) === 'failed')
    if (terminalRows.length === 0) return outcomes

    for (const row of items) {
        const ref = row?.reference
        if (!ref) continue

        // A retried item is delivered under a replacement batch, so follow that too.
        const batchIds = new Set([row?.batch_id, row?.replaced_by_batch_id].filter(Boolean))
        let mates = terminalRows.filter(t => t?.batch_id && batchIds.has(t.batch_id))

        if (mates.length === 0) {
            // No batch_id to join on — fall back to the recipient + volume, but only when
            // those rows agree. Two orders for the same number and size in one batch would
            // otherwise let a success mask the other one's failure.
            const sameRecipient = terminalRows.filter(t => t?.msisdn === row?.msisdn && t?.data_mb === row?.data_mb)
            const unanimous = sameRecipient.length > 0
                && sameRecipient.every(t => statusOf(t) === statusOf(sameRecipient[0]))
            if (unanimous) mates = sameRecipient
        }

        // Single-row form: the row carrying the reference IS the delivery row.
        if (mates.length === 0 && (statusOf(row) === 'success' || statusOf(row) === 'failed')) {
            mates = [row]
        }

        if (mates.length === 0) continue // still in flight — leave it processing

        // success is always terminal. A failure is only FINAL once auto-refunded
        // (refunded_at); before that Agent Portal may still retry it, so we wait rather
        // than mark the order failed inside the supplier's retry window.
        if (mates.some(m => statusOf(m) === 'success')) {
            outcomes.set(String(ref), 'completed')
        } else if (mates.some(m => statusOf(m) === 'failed' && m?.refunded_at)) {
            outcomes.set(String(ref), 'failed')
        }
    }

    return outcomes
}

// ─── Order Status Check (single reference, admin/debug use) ─────────────────────
/**
 * Best-effort status lookup for one reference. Agent Portal has no status-by-reference
 * endpoint, so this scans the recent order groups for the item we submitted. Prefer
 * fetchRecentItemStatuses() for anything that checks more than one order.
 */
export async function checkOrderStatus(reference: string): Promise<StatusResponse> {
    const { success, statuses, error } = await fetchRecentItemStatuses({
        wantedRefs: new Set([String(reference)]),
    })
    if (!success) return { success: false, status: 'pending', message: error || 'Status check failed' }

    const found = statuses.get(String(reference))
    if (!found) return { success: false, status: 'pending', message: 'Order item not found in recent orders' }
    return { success: true, status: found, message: found }
}

// ─── Batch Status Fetch (for the reconciliation cron) ───────────────────────────
export interface RecentStatusOptions {
    /** Ignore groups created before this instant (a group is never created before the
     *  order that went into it). Bounds a routine run to the orders still outstanding. */
    since?: Date | null
    /** The references we're waiting on. The scan stops as soon as all are resolved. */
    wantedRefs?: Set<string>
    /** Wall-clock budget. On expiry the scan returns what it has (partial: true). */
    budgetMs?: number
}

/**
 * Fetch the delivery outcome of every recent Agent Portal item in ONE pass, returning a
 * Map keyed by the `reference` we submitted (the Arhms order id) → status. The
 * reconciliation cron calls this once per run and then looks up each of its processing
 * orders locally — far cheaper than scanning per order.
 *
 * `success` is false only when we couldn't reach the supplier at all (so the cron can
 * bail without mistakenly treating an empty map as "everything still pending").
 */
export async function fetchRecentItemStatuses(options: RecentStatusOptions = {}): Promise<{
    success: boolean
    statuses: Map<string, 'pending' | 'processing' | 'completed' | 'failed'>
    error?: string
    scannedGroups?: number
    partial?: boolean
}> {
    const statuses = new Map<string, 'pending' | 'processing' | 'completed' | 'failed'>()

    if (!checkCircuit()) return { success: false, statuses, error: 'Service unavailable (circuit open)' }
    if (!AGENTPORTAL_API_KEY) return { success: false, statuses, error: 'API key not configured' }

    const deadline = Date.now() + (options.budgetMs ?? 45_000)
    const remaining = options.wantedRefs ? new Set(options.wantedRefs) : null

    // Scan window. Anything older than this can never be resolved here, which is why the
    // caller must bound its DB query to the SAME window (AGENTPORTAL_SCAN_DAYS) —
    // otherwise unresolvable old orders sit at the head of an oldest-first query forever
    // and starve the orders that this scan could actually have resolved.
    const oldestWanted = options.since ? options.since.getTime() : 0
    const dates: string[] = []
    for (let i = 0; i < AGENTPORTAL_SCAN_DAYS; i++) {
        const day = new Date(Date.now() - i * 86400000)
        dates.push(day.toISOString().slice(0, 10))
        // No outstanding order older than this day — no reason to read further back.
        if (oldestWanted && day.setUTCHours(0, 0, 0, 0) <= oldestWanted) break
    }

    let partial = false

    try {
        // ── 1. Order groups for each scanned date (dates and pages in parallel) ──
        const lists = await Promise.all(dates.map(d =>
            fetchAllPages(`/api/beneficiaries/orders?date=${d}`, 20_000, oldestWanted || undefined)))

        if (!lists.some(l => l.reached)) {
            recordFailure()
            return { success: false, statuses, error: 'Could not reach Agent Portal' }
        }

        const groups = lists.flatMap(l => l.rows).filter(grp => {
            if (!(grp?.id || grp?.order_id)) return false
            // A group created before the oldest order we're waiting on cannot contain it.
            if (oldestWanted && grp?.created_at && new Date(grp.created_at).getTime() < oldestWanted) return false
            // Skip groups that haven't done anything terminal yet (still uploading) —
            // saves an items call and they have nothing to report.
            const ps = String(grp?.processing_status || '').toUpperCase()
            return ps === 'DONE' || (Number(grp?.success_count) || 0) > 0 || (Number(grp?.failure_count) || 0) > 0
        })

        // ── 2. Items for each group, in parallel, newest first ───────────────────
        let next = 0
        let scanned = 0
        const worker = async () => {
            while (next < groups.length) {
                if (Date.now() >= deadline) { partial = true; return }
                if (remaining && remaining.size === 0) return // everything we wanted is resolved
                const grp = groups[next++]
                const items = await fetchOrderItems(grp.id || grp.order_id)
                scanned++
                for (const [ref, outcome] of mapItemsToOutcomes(items)) {
                    statuses.set(ref, outcome)
                    remaining?.delete(ref)
                }
            }
        }
        await Promise.all(Array.from(
            { length: Math.min(AGENTPORTAL_ITEMS_CONCURRENCY, Math.max(groups.length, 1)) }, worker))

        recordSuccess()
        return { success: true, statuses, scannedGroups: scanned, partial }
    } catch (error: any) {
        recordFailure()
        return { success: false, statuses, error: error?.message || 'Connection error during batch status fetch' }
    }
}

// ─── Balance Fetch ─────────────────────────────────────────────────────────────
/**
 * Fetch live Agent Portal wallet balance.
 * GET /api/wallet → { balance, transactions_total, recent_transactions }.
 */
export async function fetchSupplierBalance(): Promise<{
    success: boolean
    balance?: number
    currency?: string
    error?: string
}> {
    if (!AGENTPORTAL_API_KEY) {
        return { success: false, error: 'AGENTPORTAL_API_KEY not configured' }
    }

    try {
        // This host intermittently accepts the TCP connection and then never completes the
        // TLS handshake — measured directly: a normal call is ~0.8s, but a run of requests
        // will stall at tls=0.000 and hang. undici surfaces that as a bare "fetch failed",
        // which is why fulfillOrder already retries network errors 3x. A single attempt
        // here meant one blip blanked the admin card.
        //
        // Both endpoints below return `balance` (see the Agent Portal API reference:
        // GET /api/wallet and GET /api/wallet/summary). The last attempt uses the summary
        // route so a fault specific to one endpoint still yields a balance.
        const endpoints = ['/api/wallet', '/api/wallet', '/api/wallet/summary']
        let response: Response | null = null
        let lastError: any = null

        for (let attempt = 0; attempt < endpoints.length; attempt++) {
            try {
                response = await fetch(`${AGENTPORTAL_API_URL}${endpoints[attempt]}`, {
                    method: 'GET',
                    headers: { 'Accept': 'application/json', 'X-API-Key': AGENTPORTAL_API_KEY },
                    // Bounded per attempt: a stalled handshake must fail fast enough to
                    // leave room for the remaining attempts inside the route's budget.
                    signal: AbortSignal.timeout(8_000),
                })
                break
            } catch (err: any) {
                lastError = err
                console.warn(`[AgentPortal Balance] Attempt ${attempt + 1} (${endpoints[attempt]}) failed: ${err?.message} (${err?.cause?.code || err?.name || 'no cause'})`)
                if (attempt < endpoints.length - 1) await new Promise(res => setTimeout(res, 500 * (attempt + 1)))
            }
        }

        if (!response) {
            const code = lastError?.cause?.code || lastError?.name
            return {
                success: false,
                error: `Could not reach Agent Portal${code ? ` (${code})` : ''}`,
            }
        }

        const rawText = await response.text()
        let data: any
        try {
            data = JSON.parse(rawText)
        } catch (e) {
            console.error('[AgentPortal Balance] Non-JSON response (HTTP', response.status, '):', rawText.slice(0, 300))
            return { success: false, error: `Unexpected response format (HTTP ${response.status})` }
        }

        console.log('[AgentPortal Balance] API response received', { status: response.status, ok: response.ok })

        if (response.ok && data?.balance !== undefined) {
            const balance = parseFloat(data.balance ?? 0) || 0
            return { success: true, balance, currency: 'GHS' }
        }

        if (response.status === 401) {
            return { success: false, error: 'Authentication failed — check AGENTPORTAL_API_KEY' }
        }

        return { success: false, error: `${data?.error || 'Failed to fetch balance'} (HTTP ${response.status})` }

    } catch (error: any) {
        console.error('[AgentPortal Balance] Error:', error)
        return { success: false, error: error.message }
    }
}

// ─── MTN Whitelist Verify / Submit ──────────────────────────────────────────────
/**
 * Check which MTN numbers are enabled ("whitelisted") on the account, and — as a side
 * effect of the same endpoint — auto-submit any that aren't yet for enabling (up to 2 weeks).
 * POST /api/mtn-whitelist/verify { msisdns: [...] } → { results: [{ input, normalized, allowed }] }.
 * Returns the set of ENABLED numbers (both input and normalized forms) so callers can
 * match regardless of phone format. Up to 1000 numbers per call.
 */
export async function verifyMtnWhitelist(msisdns: string[], options?: { timeoutMs?: number }): Promise<{
    success: boolean
    allowed: Set<string>
    error?: string
}> {
    const allowed = new Set<string>()
    if (!AGENTPORTAL_API_KEY) return { success: false, allowed, error: 'API key not configured' }
    if (!msisdns || msisdns.length === 0) return { success: true, allowed }

    try {
        const response = await fetch(`${AGENTPORTAL_API_URL}/api/mtn-whitelist/verify`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'X-API-Key': AGENTPORTAL_API_KEY,
            },
            body: JSON.stringify({ msisdns: msisdns.slice(0, 1000) }),
            // Callers on the purchase path bound this — a slow supplier must not
            // sit between the buyer tapping Pay and the payment prompt. Omitted
            // by the bulk checker page and the cron, which can afford to wait.
            ...(options?.timeoutMs ? { signal: AbortSignal.timeout(options.timeoutMs) } : {}),
        })

        const rawText = await response.text()
        let data: any
        try {
            data = JSON.parse(rawText)
        } catch {
            return { success: false, allowed, error: `Unexpected response (HTTP ${response.status})` }
        }

        if (response.ok && Array.isArray(data?.results)) {
            for (const r of data.results) {
                if (r?.allowed === true) {
                    if (r.normalized) allowed.add(String(r.normalized))
                    if (r.input) allowed.add(String(r.input))
                }
            }
            return { success: true, allowed }
        }

        return { success: false, allowed, error: data?.error || `Failed to verify (HTTP ${response.status})` }
    } catch (error: any) {
        console.error('[AgentPortal Whitelist] Error:', error)
        return { success: false, allowed, error: error?.message || 'Connection error' }
    }
}
