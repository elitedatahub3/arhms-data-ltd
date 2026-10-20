import { sanitizeForLog } from '@/lib/safe-log'
import type { SupplierFailureKind } from '@/lib/supplier-failure'
import { normaliseSupplierStatus } from '@/lib/order-status-display'

// NetPulse Fulfillment Service — mirrors lib/eazydata-service.ts architecture.
// API Docs: https://netpluse.shop  ("Developer API" reference)
//
// Notes specific to this supplier:
//   • Auth is the `x-api-key` header.
//   • POST /api/v1/purchase takes an EXACT capacity string ("1GB") that must match
//     their catalog — an unlisted size is a hard 400, so we pre-validate below.
//   • `reference` is our own idempotency key; re-sending the same one returns the
//     original order instead of creating a duplicate.
//   • There is NO webhook. Completion is discovered by polling
//     GET /api/v1/order-status/{reference} from app/api/cron/sync-netpulse-status.

const NETPULSE_API_KEY = process.env.NETPULSE_API_KEY || ''
const NETPULSE_API_URL = process.env.NETPULSE_API_URL || 'https://netpluse.shop/api/v1'

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
    // True when NetPulse rejected the request because THIS order was already
    // submitted. Not a fresh failure — the order already lives at the supplier,
    // so callers should stop retrying it as pending.
    alreadySubmitted?: boolean
    failureKind?: SupplierFailureKind
}

interface StatusResponse {
    success: boolean
    status: 'pending' | 'processing' | 'completed' | 'failed'
    message?: string
    data?: any
}

// ─── Catalog ───────────────────────────────────────────────────────────────────
/**
 * Exact whole-GB capacities NetPulse sells per network, transcribed from
 * GET /api/v1/packages. Anything outside these sets is a guaranteed 400
 * ("Unknown package"), so we reject it up front with a readable error rather
 * than letting the order sit pending on a supplier rejection.
 *
 * Coverage gaps worth remembering when toggling networks in the admin panel:
 *   • Telecel starts at 10GB — no 1–8GB, and no 40GB.
 *   • AirtelTigo has a 12GB but no 20GB.
 *   • MTN has no 12GB.
 */
const CATALOG: Record<string, { network: string; sizes: number[] }> = {
    MTN: { network: 'MTN', sizes: [1, 2, 3, 4, 5, 6, 8, 10, 15, 20, 25, 30, 40, 50, 100] },
    Telecel: { network: 'Telecel', sizes: [10, 15, 20, 25, 30, 50] },
    'AT-iShare': { network: 'AirtelTigo', sizes: [1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 25, 30, 40, 50] },
    'AT-BigTime': { network: 'AirtelTigo', sizes: [1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 25, 30, 40, 50] },
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
        console.log('[NetPulse] Circuit breaker OPENED')
    }
}

// ─── Network Resolver ──────────────────────────────────────────────────────────
/**
 * Map an internal Arhms network name to NetPulse's `network` value + size catalog.
 * Internal names: "MTN", "Telecel", "AT-iShare", "AT-BigTime".
 * NetPulse networks: "MTN", "Telecel", "AirtelTigo".
 */
function resolveNetwork(network: string): { network: string; sizes: number[] } | null {
    if (CATALOG[network]) return CATALOG[network]
    // Loose fallbacks for slight naming variations.
    const n = (network || '').toUpperCase()
    if (n.startsWith('AT')) return CATALOG['AT-iShare']
    if (n === 'TELECEL' || n === 'VODAFONE') return CATALOG['Telecel']
    if (n.startsWith('MTN')) return CATALOG['MTN']
    return null
}

// ─── Main Fulfillment Function ─────────────────────────────────────────────────
/**
 * Fulfill a data order via NetPulse.
 * POST /api/v1/purchase with { network, phoneNumber, capacity, reference }.
 * Phone must be 0XXXXXXXXX format; capacity must be an exact catalog string.
 */
export async function fulfillOrder(
    network: string,
    phoneNumber: string,
    dataSize: string,
    orderId: string
): Promise<FulfillmentResponse> {

    if (!checkCircuit()) {
        console.warn(`[NetPulse] Circuit breaker is OPEN. Order ${orderId} kept pending.`)
        return { success: false, error: 'Service temporarily unavailable (circuit open)', failureKind: 'refused' }
    }

    if (!NETPULSE_API_KEY) {
        return { success: false, error: 'NetPulse API key not configured', failureKind: 'refused' }
    }

    try {
        // ── Resolve network → NetPulse network + catalog ────────────────────
        const resolved = resolveNetwork(network)
        if (!resolved) {
            return { success: false, error: `Unsupported network: ${network}`, failureKind: 'refused' }
        }

        // ── Parse whole-GB volume ───────────────────────────────────────────
        const sizeMatch = dataSize.match(/[\d.]+/)
        if (!sizeMatch) {
            return { success: false, error: `Invalid data size format: ${dataSize}`, failureKind: 'refused' }
        }
        const gigVolume = Number(sizeMatch[0])
        if (isNaN(gigVolume) || gigVolume <= 0) {
            return { success: false, error: `Invalid GB volume parsed from: ${dataSize}`, failureKind: 'refused' }
        }

        // ── Catalog guard ───────────────────────────────────────────────────
        // NetPulse only accepts capacities it actually lists. Failing here gives
        // the admin alert a useful reason instead of an opaque supplier 400.
        if (!resolved.sizes.includes(gigVolume)) {
            return {
                success: false,
                error: `NetPulse does not sell ${gigVolume}GB on ${resolved.network} (available: ${resolved.sizes.join(', ')}GB)`,
                failureKind: 'refused',
            }
        }

        // ── Phone Normalization → 0XXXXXXXXX ───────────────────────────────
        let normalizedPhone = phoneNumber.replace(/\s+/g, '').replace(/-/g, '')
        if (normalizedPhone.startsWith('233')) normalizedPhone = '0' + normalizedPhone.slice(3)
        else if (!normalizedPhone.startsWith('0')) normalizedPhone = '0' + normalizedPhone

        // Per-attempt idempotency key. Constant across THIS call's internal network
        // retries (so a dropped connection can't double-place the order) but fresh
        // on every separate (re)fulfill invocation — reusing the bare orderId would
        // make NetPulse return the ORIGINAL failed order forever, so a refulfill
        // could never place a real, deliverable one.
        const idempotencyReference = `${orderId}-${Date.now()}`

        const requestBody = {
            network: resolved.network,
            phoneNumber: normalizedPhone,
            capacity: `${gigVolume}GB`,
            reference: idempotencyReference,
        }

        console.log(`[NetPulse] Order ${orderId} | ${resolved.network} | ${gigVolume}GB | recipient: ${normalizedPhone}`)
        console.log(`[NetPulse] Request payload:`, sanitizeForLog(requestBody))

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
                response = await fetch(`${NETPULSE_API_URL}/purchase`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Accept': 'application/json',
                        'x-api-key': NETPULSE_API_KEY,
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
                    console.warn(`[NetPulse] Rate limited (HTTP 429). Order ${orderId} kept pending.`)
                    return { success: false, error: 'Supplier Rate Limited (429)', isRateLimited: true, failureKind: lastError ? 'unknown' : 'refused' }
                }

                break

            } catch (err: any) {
                lastError = err
                console.error(`[NetPulse] Fetch error on attempt ${attempt}:`, err.message)
                if (Date.now() >= fulfillDeadline) {
                    console.warn(`[netpulse] Fulfillment budget exhausted after attempt ${attempt} — giving up so the caller can report a failure.`)
                    break
                }
                if (attempt < maxAttempts) {
                    const delay = 2000 * attempt
                    console.log(`[NetPulse] Retrying in ${delay}ms...`)
                    await new Promise(res => setTimeout(res, delay))
                }
            }
        }

        if (!response) {
            recordFailure()
            return { success: false, error: lastError?.message || 'Persistent network error connecting to NetPulse', failureKind: 'unknown' }
        }

        // ── Parse JSON ─────────────────────────────────────────────────────
        const rawText = await response.text()
        let data: any
        try {
            data = JSON.parse(rawText)
        } catch (e) {
            console.error(`[NetPulse] Non-JSON response (HTTP ${response.status}):`, rawText.slice(0, 300))
            recordFailure()
            return { success: false, error: `Supplier returned unexpected response format (HTTP ${response.status})`, failureKind: 'unknown' }
        }

        console.log(`[NetPulse] API response:`, { status: response.status, reference: data?.reference })

        // ── Success: { reference, status, price, balance } ──────────────────
        if (response.ok && data?.reference) {
            recordSuccess()
            if (typeof data.balance === 'number' && data.balance < 20) {
                console.warn(`[NetPulse] Wallet balance low after order ${orderId}: GHS ${data.balance}`)
            }
            return {
                success: true,
                reference: data.reference,
                transactionId: data.reference,
                apiResponse: sanitizeForLog(data),
            }
        }

        // ── Error responses ────────────────────────────────────────────────
        const errMsg = data?.error || 'Unknown error'

        // 409 — NetPulse's short-window duplicate guard ("please wait 1 minute").
        // This is a throttle, not a permanent collision: the order was NOT placed,
        // so keep it pending and let the refulfill cron retry after the window.
        if (response.status === 409) {
            console.warn(`[NetPulse] Order ${orderId} hit the duplicate-order window — kept pending for retry.`)
            return {
                success: false,
                isRateLimited: true,
                error: `Duplicate-order window (409): ${errMsg}`,
                apiResponse: sanitizeForLog(data),
                // The window is keyed on the number, so the order it collided with may be
                // our own earlier attempt that DID go through. Not safe to fall back.
                failureKind: 'unknown',
            }
        }

        if (response.status === 402) {
            console.error(`[NetPulse] Order ${orderId}: Insufficient balance (GHS ${data?.balance ?? '?'})! Top up the NetPulse wallet.`)
        } else if (response.status === 401) {
            console.error(`[NetPulse] Order ${orderId}: Invalid or inactive API key — check NETPULSE_API_KEY.`)
        } else if (response.status === 400) {
            console.error(`[NetPulse] Order ${orderId}: Rejected by supplier — ${errMsg}`)
        }

        console.warn(`[NetPulse] Order ${orderId} not fulfilled: ${errMsg}. Kept pending.`)
        if (response.status >= 500) {
            recordFailure()
        }
        return {
            success: false,
            error: `${errMsg} (HTTP ${response.status})`,
            apiResponse: sanitizeForLog(data),
            // No idempotency key: after a mid-flight error, a rejection can't vouch for
            // the earlier attempt.
            failureKind: response.status >= 500 || lastError ? 'unknown' : 'refused',
        }

    } catch (error: any) {
        recordFailure()
        console.error(`[NetPulse] Exception during fulfillOrder for ${orderId}:`, error.message)
        return { success: false, error: error.message || 'Unexpected exception', failureKind: 'unknown' }
    }
}

// ─── Order Status Check ────────────────────────────────────────────────────────
/**
 * Check the status of an existing NetPulse order.
 * GET /api/v1/order-status/{reference}
 * Response: { reference, network, capacity, status, createdAt }
 */
export async function checkOrderStatus(reference: string): Promise<StatusResponse> {

    if (!checkCircuit()) return { success: false, status: 'pending', message: 'Service unavailable (circuit open)' }
    if (!NETPULSE_API_KEY) return { success: false, status: 'pending', message: 'API key not configured' }

    try {
        const url = `${NETPULSE_API_URL}/order-status/${encodeURIComponent(reference)}`
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'x-api-key': NETPULSE_API_KEY,
            },
            // The reconciliation cron calls this once per order, serially. One hung
            // request would otherwise eat the whole run and starve every order behind it.
            signal: AbortSignal.timeout(10_000),
        })

        const rawText = await response.text()
        let data: any
        try {
            data = JSON.parse(rawText)
        } catch (e) {
            recordFailure()
            return { success: false, status: 'pending', message: `Unexpected response format (HTTP ${response.status})` }
        }

        if (response.ok && data?.status) {
            recordSuccess()
            return { success: true, status: mapNetPulseStatus(data.status), message: data.status, data }
        }

        if (response.status >= 500) {
            recordFailure()
        }
        return { success: false, status: 'pending', message: data?.error || 'Failed to check status' }

    } catch (error) {
        recordFailure()
        return { success: false, status: 'pending', message: 'Connection error during status check' }
    }
}

/**
 * Map a NetPulse order status to ours.
 *
 * The dashboard at netpluse.shop labels the terminal success state "Delivered",
 * not "completed", and parks orders under manual review as "On Hold — Verifying"
 * / "Awaiting verification". Matching only "completed" left every delivered order
 * falling through to 'pending', so the sync cron never closed it out.
 *
 * Verifying is NOT a failure — the order is placed and under review at the
 * supplier, so it stays in-flight (processing) and gets polled again next run.
 */
function mapNetPulseStatus(status: string): 'pending' | 'processing' | 'completed' | 'failed' {
    // Separators are normalised because NetPulse is not consistent about them:
    // the API returns "on_hold" while their dashboard renders "On Hold". Matching
    // the literal strings meant the underscore form fell through to 'pending' and
    // 12 live orders sat unrecognised. Compare on words, not punctuation.
    const s = normaliseSupplierStatus(status)
    const COMPLETED = ['completed', 'complete', 'delivered', 'success', 'successful', 'credited']
    const FAILED = ['failed', 'cancelled', 'canceled', 'refunded', 'rejected', 'reversed']
    const IN_FLIGHT = ['processing', 'verifying', 'on hold', 'onhold', 'awaiting verification', 'queued', 'pending verification', 'under review']
    if (COMPLETED.includes(s)) return 'completed'
    if (FAILED.includes(s)) return 'failed'
    if (IN_FLIGHT.includes(s)) return 'processing'
    return 'pending'
}

// ─── Balance Fetch ─────────────────────────────────────────────────────────────
/**
 * Fetch live NetPulse wallet balance.
 * GET /api/v1/balance
 * Response: { balance: 12.50, currency: "GHS" }
 */
export async function fetchSupplierBalance(): Promise<{
    success: boolean
    balance?: number
    currency?: string
    error?: string
}> {
    try {
        const response = await fetch(`${NETPULSE_API_URL}/balance`, {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'x-api-key': NETPULSE_API_KEY,
            },
        })

        const rawText = await response.text()
        let data: any
        try {
            data = JSON.parse(rawText)
        } catch (e) {
            console.error('[NetPulse Balance] Non-JSON response (HTTP', response.status, '):', rawText.slice(0, 300))
            return { success: false, error: `Unexpected response format (HTTP ${response.status})` }
        }

        console.log('[NetPulse Balance] API response received', { status: response.status, ok: response.ok })

        if (response.ok && data?.balance !== undefined) {
            const balance = parseFloat(data.balance ?? 0) || 0
            return { success: true, balance, currency: data.currency || 'GHS' }
        }

        return { success: false, error: data?.error || 'Failed to fetch balance' }

    } catch (error: any) {
        console.error('[NetPulse Balance] Error:', error)
        return { success: false, error: error.message }
    }
}
