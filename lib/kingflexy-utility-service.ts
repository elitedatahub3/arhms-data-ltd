/**
 * KingFlexy Commission Services — utility bill payments.
 *
 * Bills used to go straight to Hubtel. That never worked: Hubtel answers every
 * request with "Could not find Prepaid account", and utilities share the airtime
 * account, so both products failed the same way. KingFlexy resells the same Hubtel
 * Commission Services and owns the prepaid account itself, which takes that whole
 * class of failure off our books.
 *
 * Separate from lib/kingflexy-service.ts (data) because the two use DIFFERENT
 * CREDENTIALS: data authenticates with a standard kf_live_ key, and every commission
 * endpoint rejects that key with 403. They also get their own circuit breaker — a
 * bill-payment outage should not stop data orders flowing, and vice versa.
 *
 * The retry/deadline/breaker shape is deliberately copied from the data client
 * rather than reinvented: it already solved the stalled-supplier problem, where a
 * connection that opens and then never answers leaves fetch pending until the whole
 * serverless function is killed mid-order.
 */
import { sanitizeForLog } from '@/lib/safe-log'
import type { UtilityQueryResult, UtilityMeter, UtilityDetailRow } from '@/lib/hubtel-utility-service'
import { billerForService, type BillerKey } from '@/lib/api-v2-billers'

const KF_COMMISSION_KEY = process.env.KINGFLEXY_COMMISSION_KEY || ''
const KF_V2_URL = process.env.KINGFLEXY_API_V2_URL || 'https://api.kingflexygh.com/api/v2'

// ─── Circuit Breaker ─────────────────────────────────────────────────────────
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
        console.log('[KingFlexyUtility] Circuit breaker OPENED')
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
 * 409 — is an answer, and repeating it just burns the per-key rate limit. 5xx is
 * retried because it is the provider being unwell rather than us being wrong.
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
                    // No "Bearer" prefix — their API takes the raw key, same as the
                    // data endpoints in lib/kingflexy-service.ts.
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
                console.error(`[KingFlexyUtility] Non-JSON response (HTTP ${res.status}):`, raw.slice(0, 300))
                if (res.status >= 500) recordFailure()
                return { ok: false, status: res.status, data: null, transportError: `Unexpected response format (HTTP ${res.status})` }
            }

            if (res.status >= 500) {
                recordFailure()
                // Worth another attempt — the provider is unwell, not our request.
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
            console.error(`[KingFlexyUtility] ${method} ${path} attempt ${attempt} failed:`, err?.message)
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
 * The precise reason is LOGGED, never returned. buildUtilityIntent passes a lookup
 * failure straight through to whoever asked — a storefront customer or an API
 * partner — so returning "KINGFLEXY_COMMISSION_KEY is not configured" would print an
 * internal variable name on a public error page. They get the same message they get
 * for any provider problem; we get the detail in the logs.
 */
function configError(): string | null {
    if (!KF_COMMISSION_KEY) {
        console.error('[KingFlexyUtility] KINGFLEXY_COMMISSION_KEY is not configured.')
        return 'Bill payments are temporarily unavailable. Please try again shortly.'
    }
    if (!KF_COMMISSION_KEY.startsWith('kf_cs_live_')) {
        // A standard kf_live_ key is rejected with 403 on every commission endpoint,
        // and that 403 reads identically to "key not approved yet" — so catch it here
        // rather than spending a request and misdiagnosing the answer.
        console.error('[KingFlexyUtility] KINGFLEXY_COMMISSION_KEY is not a Commission Services key (expected the kf_cs_live_ prefix).')
        return 'Bill payments are temporarily unavailable. Please try again shortly.'
    }
    return null
}

// ─── Billers ─────────────────────────────────────────────────────────────────

export interface KfBiller {
    key: BillerKey
    label: string
    enabled: boolean
    account_label: string
    requires_phone: boolean
    lookup_by: 'phone' | 'account'
    links_phone_to_account: boolean
    has_amount_due: boolean
}

export interface KfBillerCatalog {
    success: boolean
    billers?: KfBiller[]
    minAmount?: number
    maxAmount?: number
    error?: string
}

/**
 * Their live catalogue, including billers they have switched off.
 *
 * Read this rather than hardcoding limits: min_amount/max_amount are theirs to move,
 * and our own utility_api_min/max_amount must sit inside them or we accept a payment
 * they will reject.
 */
export async function listBillers(): Promise<KfBillerCatalog> {
    const cfg = configError()
    if (cfg) return { success: false, error: cfg }
    if (!checkCircuit()) return { success: false, error: 'Bill payment provider temporarily unavailable.' }

    const res = await kfRequest('GET', '/utilities/billers', undefined, 15_000)
    if (!res.ok || res.data?.success !== true) {
        return { success: false, error: res.transportError || res.data?.error?.message || `Could not load billers (HTTP ${res.status})` }
    }

    return {
        success: true,
        billers: res.data.data?.billers ?? [],
        minAmount: Number(res.data.data?.min_amount ?? 1),
        maxAmount: Number(res.data.data?.max_amount ?? 1000),
    }
}

// ─── Lookup ──────────────────────────────────────────────────────────────────

export interface KfLookupParams {
    /** Our internal service id — translated to their biller key here. */
    service: string
    accountNumber?: string
    phone?: string
}

/**
 * Resolves an account to a customer name, adapted into the shape the rest of the app
 * already speaks.
 *
 * Returning UtilityQueryResult rather than KingFlexy's own shape is what keeps this
 * swap to one file: buildUtilityIntent, the web query route, the v2 lookup route and
 * utility-order-payments all consume that interface and none of them change.
 *
 * Their ECG response is the shape that differs — account_name/amount_due are null and
 * the answer is a `meters` array keyed on the phone number. That maps onto
 * UtilityMeter, so the "is the requested meter actually on this phone" check in
 * buildUtilityIntent keeps working untouched.
 */
export async function lookupUtilityAccount(params: KfLookupParams): Promise<UtilityQueryResult> {
    const cfg = configError()
    if (cfg) return { success: false, error: cfg }
    if (!checkCircuit()) {
        return { success: false, error: 'Bill payment provider temporarily unavailable. Please try again shortly.' }
    }

    const biller = billerForService(params.service)
    if (!biller) return { success: false, error: `Unknown utility service: ${params.service}` }

    const query = new URLSearchParams({ biller })
    // `account` is required for every biller including ECG; for ECG their query
    // actually runs on the phone, so the number goes in both fields.
    const account = (params.accountNumber || params.phone || '').trim()
    if (!account) return { success: false, error: 'An account or meter number is required.' }
    query.set('account', account)
    if (params.phone) query.set('phone', params.phone.trim())

    const res = await kfRequest('GET', `/utilities/lookup?${query.toString()}`, undefined, 20_000)

    if (!res.ok || res.data?.success !== true) {
        const message = res.transportError || res.data?.error?.message || 'That account could not be verified.'
        // Their 502 means the billing provider is unreachable — a retry-later, not a
        // wrong number. Carrying a responseCode through lets lookupFailureStatus()
        // in api-v2-billers tell a 404 from a 502 downstream.
        return {
            success: false,
            error: message,
            responseCode: res.status === 502 ? undefined : String(res.status || ''),
        }
    }

    const d = res.data.data || {}

    const meters: UtilityMeter[] = Array.isArray(d.meters)
        ? d.meters.map((m: any) => ({
            // Their `name` is the bare customer name; ours is a display label that
            // buildUtilityIntent parses "NAME (METER)" out of. Rebuild that form so
            // the existing parser finds what it expects.
            label: m?.name ? `${m.name} (${m.meterNumber})` : String(m?.meterNumber ?? ''),
            meterNumber: String(m?.meterNumber ?? ''),
            balance: Number(m?.outstanding ?? 0) || 0,
        }))
        : []

    // Kept for the receipt and the admin view, mirroring what the Hubtel normalizer
    // used to put here.
    const details: UtilityDetailRow[] = []
    if (d.account_name) details.push({ display: 'name', value: String(d.account_name), amount: 0 })
    if (d.bouquet) details.push({ display: 'bouquet', value: String(d.bouquet), amount: 0 })
    if (d.amount_due != null) details.push({ display: 'amountDue', value: String(d.amount_due), amount: Number(d.amount_due) || 0 })

    return {
        success: true,
        accountName: d.account_name ?? (meters[0]?.label ? /^(.*?)\s*\(/.exec(meters[0].label)?.[1]?.trim() : undefined),
        amountDue: d.amount_due != null ? Number(d.amount_due) : undefined,
        meters: meters.length ? meters : undefined,
        details,
        // Ghana Water's single-use sessionId was a Hubtel concept. KingFlexy manages
        // it internally and returns none, so orders placed from here simply have no
        // session_id — nothing downstream requires one once the Hubtel normalizer is
        // out of the path.
        sessionId: undefined,
        responseCode: '0000',
    }
}

// ─── Payment ─────────────────────────────────────────────────────────────────

export interface KfPayParams {
    service: string
    accountNumber: string
    amount: number
    phone?: string | null
    /** Our reference_code. Their idempotency key — a retry returns the original. */
    reference: string
}

export interface KfPayResult {
    success: boolean
    /** THEIR generated reference (UTIL-<BILLER>-<hex>) — what the status endpoint takes. */
    supplierReference?: string
    orderId?: string
    status?: string
    commissionSharePercent?: number
    /** True when the reference was already used — the original order stands. */
    alreadyProcessed?: boolean
    error?: string
    /**
     * True when the provider definitively refused and no money moved, so the
     * customer can be refunded. False for a timeout, where the payment may have
     * landed and a refund would give the money away twice.
     */
    knownUnpaid?: boolean
    raw?: any
}

export async function payUtilityBillViaKingFlexy(params: KfPayParams): Promise<KfPayResult> {
    const cfg = configError()
    if (cfg) return { success: false, error: cfg, knownUnpaid: true }
    if (!checkCircuit()) {
        return { success: false, error: 'Bill payment provider temporarily unavailable.', knownUnpaid: true }
    }

    const biller = billerForService(params.service)
    if (!biller) return { success: false, error: `Unknown utility service: ${params.service}`, knownUnpaid: true }

    const body: Record<string, any> = {
        biller,
        account: params.accountNumber,
        amount: params.amount,
        reference: params.reference,
    }
    // Required for ecg and ghana_water, rejected as noise for the TV billers.
    if (params.phone) body.phone = params.phone

    console.log(`[KingFlexyUtility] Paying ${biller} GHS ${params.amount} -> ${params.accountNumber} (ref ${params.reference})`)

    // No retries on the payment itself beyond the transport layer's own: this is the
    // one call that moves money, and kfRequest only repeats on 5xx and connection
    // failures, never on an answer.
    const res = await kfRequest('POST', '/utilities/pay', body, 25_000)

    if (res.transportError) {
        // We never heard back. The payment may or may not have been taken, so this
        // must NOT be treated as refundable.
        return { success: false, error: res.transportError, knownUnpaid: false }
    }

    if (res.ok && res.data?.success === true) {
        const d = res.data.data || {}
        return {
            success: true,
            supplierReference: d.reference,
            orderId: d.order_id,
            status: d.status || 'pending',
            commissionSharePercent: d.commission_share_percent != null ? Number(d.commission_share_percent) : undefined,
            alreadyProcessed: d.already_processed === true,
            raw: sanitizeForLog(res.data),
        }
    }

    const message = res.data?.error?.message || res.data?.message || `Payment refused (HTTP ${res.status})`

    // They answered. A 4xx is a definite refusal with nothing charged; a 5xx after
    // retries is ambiguous and stays unrefundable for a human to confirm.
    return {
        success: false,
        error: message,
        knownUnpaid: res.status >= 400 && res.status < 500,
        raw: sanitizeForLog(res.data),
    }
}

// ─── Status ──────────────────────────────────────────────────────────────────

export interface KfOrderStatus {
    success: boolean
    status?: 'pending' | 'processing' | 'completed' | 'failed' | 'refunded'
    paymentStatus?: string
    accountName?: string | null
    amount?: number
    /** Their realised commission on this order — becomes utility_orders.commission. */
    commissionEarned?: number | null
    error?: string
    raw?: any
}

/**
 * @param supplierReference THEIR reference from the /pay response, not ours.
 */
export async function getUtilityOrderStatus(supplierReference: string): Promise<KfOrderStatus> {
    const cfg = configError()
    if (cfg) return { success: false, error: cfg }
    if (!checkCircuit()) return { success: false, error: 'Provider temporarily unavailable.' }

    const res = await kfRequest('GET', `/utilities/orders/${encodeURIComponent(supplierReference)}`, undefined, 15_000)

    if (!res.ok || res.data?.success !== true) {
        return { success: false, error: res.transportError || res.data?.error?.message || `Status unavailable (HTTP ${res.status})` }
    }

    const d = res.data.data || {}
    return {
        success: true,
        status: d.status,
        paymentStatus: d.payment_status,
        accountName: d.account_name ?? null,
        amount: d.amount != null ? Number(d.amount) : undefined,
        commissionEarned: d.commission_earned != null ? Number(d.commission_earned) : null,
        raw: sanitizeForLog(res.data),
    }
}
