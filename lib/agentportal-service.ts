import { sanitizeForLog } from '@/lib/safe-log'

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
        return { success: false, error: 'Service temporarily unavailable (circuit open)' }
    }

    if (!AGENTPORTAL_API_KEY) {
        return { success: false, error: 'AgentPortal API key not configured' }
    }

    try {
        // ── Resolve network → service + GB window ───────────────────────────
        const svc = resolveService(network)
        if (!svc) {
            return { success: false, error: `Unsupported network: ${network}` }
        }

        // ── Parse whole-GB volume (decimals rejected by the supplier) ───────
        const sizeMatch = dataSize.match(/[\d.]+/)
        if (!sizeMatch) {
            return { success: false, error: `Invalid data size format: ${dataSize}` }
        }
        const gigVolume = Number(sizeMatch[0])
        if (isNaN(gigVolume) || gigVolume <= 0) {
            return { success: false, error: `Invalid GB volume parsed from: ${dataSize}` }
        }
        if (!Number.isInteger(gigVolume)) {
            // Agent Portal only accepts whole-GB bundles.
            return { success: false, error: `AgentPortal accepts whole-GB bundles only (got ${gigVolume}GB for ${network})` }
        }
        if (gigVolume < svc.min || gigVolume > svc.max) {
            return { success: false, error: `${svc.service} accepts ${svc.min}–${svc.max} GB — ${gigVolume}GB is out of range` }
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
                })

                if (response.status === 429) {
                    console.warn(`[AgentPortal] Rate limited (HTTP 429). Order ${orderId} kept pending.`)
                    return { success: false, error: 'Supplier Rate Limited (429)', isRateLimited: true }
                }

                break

            } catch (err: any) {
                lastError = err
                console.error(`[AgentPortal] Fetch error on attempt ${attempt}:`, err.message)
                if (attempt < maxAttempts) {
                    const delay = 2000 * attempt
                    console.log(`[AgentPortal] Retrying in ${delay}ms...`)
                    await new Promise(res => setTimeout(res, delay))
                }
            }
        }

        if (!response) {
            recordFailure()
            return { success: false, error: lastError?.message || 'Persistent network error connecting to AgentPortal' }
        }

        // ── Parse JSON ─────────────────────────────────────────────────────
        const rawText = await response.text()
        let data: any
        try {
            data = JSON.parse(rawText)
        } catch (e) {
            console.error(`[AgentPortal] Non-JSON response (HTTP ${response.status}):`, rawText.slice(0, 300))
            recordFailure()
            return { success: false, error: `Supplier returned unexpected response format (HTTP ${response.status})` }
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
            console.warn(`[AgentPortal] Order ${orderId} not enqueued (added: 0): ${reason}. Kept pending.`)
            return { success: false, error: reason, apiResponse: sanitizeForLog(data) }
        }

        // ── Error responses: { error: "message" } ───────────────────────────
        const errMsg = data?.error || 'Unknown error'

        // 402 insufficient balance — supplier is up, don't trip the breaker.
        if (response.status === 402) {
            console.error(`[AgentPortal] Order ${orderId}: insufficient wallet balance — top up AgentPortal. (${errMsg})`)
            return { success: false, error: errMsg, apiResponse: sanitizeForLog(data) }
        }

        // 401 auth error — misconfigured key, supplier is up.
        if (response.status === 401) {
            console.error(`[AgentPortal] Order ${orderId}: authentication error — check AGENTPORTAL_API_KEY. (${errMsg})`)
            return { success: false, error: errMsg, apiResponse: sanitizeForLog(data) }
        }

        console.warn(`[AgentPortal] Order ${orderId} not fulfilled: ${errMsg} (HTTP ${response.status}). Kept pending.`)
        if (response.status >= 500) {
            recordFailure()
        }
        return {
            success: false,
            error: errMsg,
            apiResponse: sanitizeForLog(data),
        }

    } catch (error: any) {
        recordFailure()
        console.error(`[AgentPortal] Exception during fulfillOrder for ${orderId}:`, error.message)
        return { success: false, error: error.message || 'Unexpected exception' }
    }
}

// ─── Order Status Check (fallback reconciliation only) ──────────────────────────
/**
 * Best-effort status lookup for the fallback cron. Agent Portal has no
 * status-by-reference endpoint, so we scan today's (and yesterday's) orders and
 * match the item whose `reference` equals ours.
 * `reference` is the Arhms orderId we sent at fulfillment time.
 */
export async function checkOrderStatus(reference: string): Promise<StatusResponse> {

    if (!checkCircuit()) return { success: false, status: 'pending', message: 'Service unavailable (circuit open)' }
    if (!AGENTPORTAL_API_KEY) return { success: false, status: 'pending', message: 'API key not configured' }

    try {
        // Look back over the last 2 days of orders to find the group containing our item.
        const dates: string[] = []
        for (let i = 0; i < 2; i++) {
            const d = new Date(Date.now() - i * 86400000)
            dates.push(d.toISOString().slice(0, 10)) // YYYY-MM-DD
        }

        for (const date of dates) {
            const listResp = await fetch(`${AGENTPORTAL_API_URL}/api/beneficiaries/orders?date=${date}`, {
                method: 'GET',
                headers: { 'Accept': 'application/json', 'X-API-Key': AGENTPORTAL_API_KEY },
            })

            const listText = await listResp.text()
            let listData: any
            try {
                listData = JSON.parse(listText)
            } catch {
                continue
            }

            const orders: any[] = Array.isArray(listData) ? listData : (listData?.data || [])
            for (const grp of orders) {
                const orderId = grp?.id || grp?.order_id
                if (!orderId) continue

                const itemsResp = await fetch(
                    `${AGENTPORTAL_API_URL}/api/beneficiaries/orders/${encodeURIComponent(orderId)}/items`,
                    { method: 'GET', headers: { 'Accept': 'application/json', 'X-API-Key': AGENTPORTAL_API_KEY } }
                )
                const itemsText = await itemsResp.text()
                let itemsData: any
                try {
                    itemsData = JSON.parse(itemsText)
                } catch {
                    continue
                }

                const items: any[] = Array.isArray(itemsData) ? itemsData : (itemsData?.data || itemsData?.items || [])
                const match = items.find((it: any) => it?.reference === reference)
                if (match) {
                    recordSuccess()
                    return {
                        success: true,
                        status: mapAgentPortalStatus(match.status),
                        message: match.status,
                        data: match,
                    }
                }
            }
        }

        // Not found yet — still in flight.
        return { success: false, status: 'pending', message: 'Order item not found in recent orders' }

    } catch (error) {
        recordFailure()
        return { success: false, status: 'pending', message: 'Connection error during status check' }
    }
}

// Agent Portal per-item statuses: 'success' | 'failed' (terminal). Anything else → processing.
function mapAgentPortalStatus(status: string): 'pending' | 'processing' | 'completed' | 'failed' {
    const s = (status || '').toLowerCase()
    if (s === 'success' || s === 'done' || s === 'completed' || s === 'delivered') return 'completed'
    if (s === 'failed' || s === 'cancelled' || s === 'reversed') return 'failed'
    return 'processing'
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
    try {
        const response = await fetch(`${AGENTPORTAL_API_URL}/api/wallet`, {
            method: 'GET',
            headers: { 'Accept': 'application/json', 'X-API-Key': AGENTPORTAL_API_KEY },
        })

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

        return { success: false, error: data?.error || 'Failed to fetch balance' }

    } catch (error: any) {
        console.error('[AgentPortal Balance] Error:', error)
        return { success: false, error: error.message }
    }
}
