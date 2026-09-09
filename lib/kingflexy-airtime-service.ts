/**
 * KingFlexy Airtime v2 — direct airtime top-ups for MTN, Telecel and AT.
 *
 * Replaces lib/hubtel-airtime-service.ts as the auto-fulfillment provider. Hubtel's
 * prepaid account has never reliably worked — the same account utility bills used to
 * hit before that product moved to lib/kingflexy-utility-service.ts. This is the
 * airtime equivalent of that swap.
 *
 * Authenticates with the Commission Services key (KINGFLEXY_COMMISSION_KEY,
 * kf_cs_live_) — same one lib/kingflexy-utility-service.ts uses for bill payments.
 * KingFlexy's Airtime v2 docs are explicit that this endpoint "only accepts a
 * Commission Services key... a standard key is rejected with 403," so this is
 * deliberately NOT KINGFLEXY_API_KEY (kf_live_), which is for the v1 data endpoints
 * and would be rejected here.
 *
 * The retry/deadline/breaker shape is copied from lib/kingflexy-utility-service.ts,
 * which already solved the stalled-supplier problem for this same host.
 */
import { sanitizeForLog } from '@/lib/safe-log'

const KF_COMMISSION_KEY = process.env.KINGFLEXY_COMMISSION_KEY || ''
const KF_V2_URL = process.env.KINGFLEXY_API_V2_URL || 'https://api.kingflexygh.com/api/v2'

// ─── Circuit Breaker ─────────────────────────────────────────────────────────
// Separate from kingflexy-service.ts's and kingflexy-utility-service.ts's breakers —
// each endpoint family fails independently and must not trip the others.
let circuitState: 'closed' | 'open' | 'half-open' = 'closed'
let failureCount = 0
let lastFailureTime: number | null = null
const FAILURE_THRESHOLD = 5
const RECOVERY_TIMEOUT = 60_000

function checkCircuit(): boolean {
    if (circuitState === 'closed') return true
    if (circuitState === 'open') {
        if (lastFailureTime && Date.now() - lastFailureTime > RECOVERY_TIMEOUT) {
            circuitState = 'half-open'
            return true
        }
        return false
    }
    return true
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
        console.log('[KingFlexyAirtime] Circuit breaker OPENED')
    }
}

// ─── Shared request helper ───────────────────────────────────────────────────

interface KfResponse {
    ok: boolean
    status: number
    data: any
    /** Set when we never got a parseable answer at all — distinct from a rejection. */
    transportError?: string
}

/**
 * One HTTP call with a whole-call budget across retries.
 *
 * Retries are for TRANSPORT failures only. A business rejection — 400, 403, 404,
 * 409 — is an answer, and repeating it just burns the per-key rate limit (10/min on
 * purchase, 30/min on status). 5xx is retried because it is the provider being unwell
 * rather than us being wrong.
 */
async function kfRequest(
    method: 'GET' | 'POST',
    path: string,
    body?: any,
    budgetMs = 25_000
): Promise<KfResponse> {
    const deadline = Date.now() + budgetMs
    const maxAttempts = 3
    let lastError: Error | null = null

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const res = await fetch(`${KF_V2_URL}${path}`, {
                method,
                headers: {
                    Accept: 'application/json',
                    // No "Bearer" prefix — their API takes the raw key.
                    Authorization: KF_COMMISSION_KEY,
                    ...(body ? { 'Content-Type': 'application/json' } : {}),
                },
                ...(body ? { body: JSON.stringify(body) } : {}),
                // Without this, a supplier that accepts the connection and then stalls
                // leaves fetch pending forever and the retry loop below never runs.
                signal: AbortSignal.timeout(Math.max(2_000, deadline - Date.now())),
            })

            const raw = await res.text()
            let data: any = null
            try {
                data = raw ? JSON.parse(raw) : null
            } catch {
                console.error(`[KingFlexyAirtime] Non-JSON response (HTTP ${res.status}):`, raw.slice(0, 300))
                if (res.status >= 500) recordFailure()
                return { ok: false, status: res.status, data: null, transportError: `Unexpected response format (HTTP ${res.status})` }
            }

            if (res.status >= 500) {
                recordFailure()
                if (attempt < maxAttempts && Date.now() < deadline) {
                    await new Promise(r => setTimeout(r, 2000 * attempt))
                    continue
                }
            } else {
                recordSuccess()
            }

            return { ok: res.ok, status: res.status, data }
        } catch (err: any) {
            lastError = err
            console.error(`[KingFlexyAirtime] ${method} ${path} attempt ${attempt} failed:`, err?.message)
            if (Date.now() >= deadline) break
            if (attempt < maxAttempts) await new Promise(r => setTimeout(r, 2000 * attempt))
        }
    }

    recordFailure()
    return {
        ok: false,
        status: 0,
        data: null,
        transportError: lastError?.message || 'Could not reach KingFlexy',
    }
}

/**
 * Guards against the two configuration mistakes that look like provider outages.
 *
 * The precise reason is LOGGED, never returned — callers surface this straight to an
 * admin note or push, and "KINGFLEXY_COMMISSION_KEY is not configured" has no
 * business appearing there.
 */
function configError(): string | null {
    if (!KF_COMMISSION_KEY) {
        console.error('[KingFlexyAirtime] KINGFLEXY_COMMISSION_KEY is not configured.')
        return 'Airtime provider is temporarily unavailable.'
    }
    if (!KF_COMMISSION_KEY.startsWith('kf_cs_live_')) {
        console.error('[KingFlexyAirtime] KINGFLEXY_COMMISSION_KEY does not look like a Commission Services key (expected the kf_cs_live_ prefix).')
        return 'Airtime provider is temporarily unavailable.'
    }
    return null
}

// ─── Purchase ────────────────────────────────────────────────────────────────

export interface KfAirtimePurchaseParams {
    network: string
    /** Beneficiary number, 0XXXXXXXXX — same format KingFlexy expects, no conversion needed. */
    phone: string
    /** GHS value the beneficiary should receive. Never paired with use_exact_amount — see file header. */
    amount: number
    /** Our reference_code. Their idempotency key — a repeat with the same body returns the existing order. */
    reference: string
}

export interface KfAirtimePurchaseResult {
    success: boolean
    /** THEIR order id, for logs/support — the status endpoint takes OUR reference, not this. */
    supplierOrderId?: string
    status?: string
    feeAmount?: number
    totalPaid?: number
    newBalance?: number
    error?: string
    /**
     * True when the provider definitively refused and nothing left our KingFlexy
     * balance — false for a timeout, where the top-up may have gone out anyway.
     * Informational only: airtime has no automated refund path today (see the
     * dispatcher), so this just tells an admin whether a manual credit is safe.
     */
    knownUnpaid?: boolean
    raw?: any
}

export async function purchaseAirtimeViaKingFlexy(params: KfAirtimePurchaseParams): Promise<KfAirtimePurchaseResult> {
    const cfg = configError()
    if (cfg) return { success: false, error: cfg, knownUnpaid: false }
    if (!checkCircuit()) {
        return { success: false, error: 'Airtime provider temporarily unavailable.', knownUnpaid: false }
    }

    const body = {
        network: params.network,
        beneficiary_phone: params.phone,
        amount: params.amount,
        reference: params.reference,
    }

    console.log(`[KingFlexyAirtime] Purchasing ${params.network} GHS ${params.amount} -> ${params.phone} (ref ${params.reference})`)

    const res = await kfRequest('POST', '/airtime/purchase', body, 25_000)

    if (res.transportError) {
        // We never heard back. The top-up may or may not have gone out, so this must
        // NOT be treated as refundable.
        return { success: false, error: res.transportError, knownUnpaid: false }
    }

    // A reused reference against a DIFFERENT body comes back 409 and is not charged —
    // a genuine rejection, not a duplicate-success case like the v1 data client's 409.
    if (res.ok && res.data?.success === true) {
        const d = res.data.data || {}
        return {
            success: true,
            supplierOrderId: d.order_id,
            status: d.status || 'pending',
            feeAmount: d.fee_amount != null ? Number(d.fee_amount) : undefined,
            totalPaid: d.total_paid != null ? Number(d.total_paid) : undefined,
            newBalance: d.new_balance != null ? Number(d.new_balance) : undefined,
            raw: sanitizeForLog(res.data),
        }
    }

    const message = res.data?.error?.message || res.data?.message || `Purchase refused (HTTP ${res.status})`

    // They answered. A 4xx is a definite refusal with nothing charged to our KingFlexy
    // balance; a 5xx after retries is ambiguous and stays unrefundable for a human.
    return {
        success: false,
        error: message,
        knownUnpaid: res.status >= 400 && res.status < 500,
        raw: sanitizeForLog(res.data),
    }
}

// ─── Status ──────────────────────────────────────────────────────────────────

export interface KfAirtimeStatusResult {
    success: boolean
    status?: 'pending' | 'processing' | 'completed' | 'failed'
    error?: string
    raw?: any
}

/** KingFlexy statuses — refund/reversed/cancelled fold into 'failed' for our purposes. */
function mapKfAirtimeStatus(status: string): 'pending' | 'processing' | 'completed' | 'failed' {
    const s = (status || '').toLowerCase()
    if (s === 'completed') return 'completed'
    if (s === 'failed' || s === 'refund' || s === 'refunded' || s === 'reversed' || s === 'cancelled') return 'failed'
    if (s === 'processing') return 'processing'
    return 'pending'
}

/**
 * @param reference OUR reference_code — the docs show the status endpoint keyed on
 * the same reference we submitted, unlike the utility flow which needs KingFlexy's
 * own generated reference.
 */
export async function getKfAirtimeOrderStatus(reference: string): Promise<KfAirtimeStatusResult> {
    const cfg = configError()
    if (cfg) return { success: false, error: cfg }
    if (!checkCircuit()) return { success: false, error: 'Provider temporarily unavailable.' }

    const res = await kfRequest('GET', `/airtime/orders/${encodeURIComponent(reference)}`, undefined, 15_000)

    if (!res.ok || res.data?.success !== true) {
        return { success: false, error: res.transportError || res.data?.error?.message || `Status unavailable (HTTP ${res.status})` }
    }

    const d = res.data.data || {}
    return {
        success: true,
        status: mapKfAirtimeStatus(d.status),
        raw: sanitizeForLog(res.data),
    }
}
