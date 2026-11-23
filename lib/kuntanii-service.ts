import { sanitizeForLog } from '@/lib/safe-log'
import type { SupplierFailureKind } from '@/lib/supplier-failure'
import { normaliseSupplierStatus } from '@/lib/order-status-display'

// Kuntanii Fulfillment Service — MTN ONLY.
// API docs: https://kuntanii.com (Developer API, /api/integrations/*)
//
// Notes specific to this supplier:
//   • Auth is `Authorization: Bearer kt_live_…`. Orders go to
//     POST /api/integrations/orders with { externalOrderId, deliveryMode?, items:[{phoneNumber, dataGb}] }.
//     WE send the externalOrderId, and it doubles as the idempotency key
//     (X-Kuntanii-Idempotency-Key): a repeat comes back 200 { idempotent: true }.
//   • The externalOrderId we send is stored in orders.kuntanii_reference (and
//     shop_orders.kuntanii_reference). It is the ONLY key their status endpoint
//     (GET /api/integrations/orders/{externalOrderId}) takes and the first thing
//     the webhook carries, so storing it — not their KT-… orderReference — is what
//     lets the webhook and the sync cron find the order. KT-… is logged in apiResponse.
//   • The id we are handed is orders.id on the dispatcher / refulfill / API paths
//     but shop_orders.id on the storefront path. On a re-fulfil the router passes
//     the storefront id back (same as BundlePortal), so the first key is reused.
//   • A cancelled order keeps its externalOrderId forever — resending it would just
//     return the cancelled order. So a retry probes <id>, <id>-r1, <id>-r2 …: a live
//     one is adopted, a cancelled one moves on to the next free suffix.
//   • Kuntanii only delivers to numbers on its approved-beneficiary list. A number
//     it drops (NOT_IN_APPROVED_REGISTRY / BLOCKED_NUMBER) is a definite 'refused',
//     so the router moves the order on to the fallback supplier.
//   • deliveryMode is 'normal' (default) or 'instant', chosen in Admin → Fulfillment
//     (fulfillment_settings.kuntanii_delivery_mode). An instant order Kuntanii won't
//     take is refused, never silently resent as normal — their docs forbid that.
//   • No balance endpoint is documented.

const KUNTANII_API_KEY = process.env.KUNTANII_API_KEY || ''
// Kuntanii scopes an order to the API key that placed it: after a key change, the
// new key gets 404 for every order the old one placed. Older keys listed here
// (comma-separated) are tried for status lookups and not-received reports only,
// never to place orders.
// Keep a key here until its last order has settled, and revoke it at Kuntanii only then.
const KUNTANII_PREVIOUS_API_KEYS = (process.env.KUNTANII_PREVIOUS_API_KEYS || '')
    .split(',').map(k => k.trim()).filter(k => k && k !== KUNTANII_API_KEY)
const KUNTANII_API_URL = (process.env.KUNTANII_API_URL || 'https://kuntanii.com').replace(/\/+$/, '')

const MAX_RETRY_SUFFIX = 5

// ─── Circuit Breaker ───────────────────────────────────────────────────────────
let circuitState: 'closed' | 'open' | 'half-open' = 'closed'
let failureCount = 0
let lastFailureTime: number | null = null
const FAILURE_THRESHOLD = 5
const RECOVERY_TIMEOUT = 60000

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
        console.log('[Kuntanii] Circuit breaker OPENED')
    }
}

// ─── Types ─────────────────────────────────────────────────────────────────────
export type KuntaniiDeliveryMode = 'normal' | 'instant'

export function parseDeliveryMode(value: unknown): KuntaniiDeliveryMode {
    return value === 'instant' ? 'instant' : 'normal'
}

interface FulfillmentResponse {
    success: boolean
    reference?: string
    transactionId?: string
    webhookRef?: string
    error?: string
    apiResponse?: any
    isRateLimited?: boolean
    alreadySubmitted?: boolean
    failureKind?: SupplierFailureKind
}

type MappedStatus = 'pending' | 'processing' | 'completed' | 'failed'

interface StatusResponse {
    success: boolean
    status: MappedStatus
    message?: string
    /** True when Kuntanii answered 404 — no order exists under that externalOrderId. */
    notFound?: boolean
    data?: any
}

// ─── Helpers ───────────────────────────────────────────────────────────────────
/** Normalise any Ghanaian number to the local 0XXXXXXXXX form Kuntanii requires. */
export function normalizePhone(phoneNumber: string): string {
    let p = (phoneNumber || '').replace(/\s+/g, '').replace(/-/g, '').replace(/^\+/, '')
    if (p.startsWith('233')) p = '0' + p.slice(3)
    else if (!p.startsWith('0')) p = '0' + p
    return p
}

/** Volume in GB from a size string like "5GB" / "5" / "5.0 GB". */
export function parseGigabytes(dataSize: string): number | null {
    const match = (dataSize || '').match(/[\d.]+/)
    if (!match) return null
    const gb = Number(match[0])
    if (isNaN(gb) || gb <= 0) return null
    return gb
}

function isMtn(network: string): boolean {
    return (network || '').toUpperCase().startsWith('MTN')
}

const UUID_IN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

/** The uuid inside an externalOrderId we sent (`<uuid>` or `<uuid>-r2`). */
export function uuidFromExternalId(externalOrderId: string | null | undefined): string | null {
    const m = String(externalOrderId ?? '').match(UUID_IN)
    return m ? m[0].toLowerCase() : null
}

async function callApi(method: 'GET' | 'POST', path: string, opts: { body?: any; idempotencyKey?: string; timeoutMs: number; apiKey?: string }) {
    const headers: Record<string, string> = {
        Accept: 'application/json',
        Authorization: `Bearer ${opts.apiKey || KUNTANII_API_KEY}`,
    }
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json'
    if (opts.idempotencyKey) headers['X-Kuntanii-Idempotency-Key'] = opts.idempotencyKey

    const response = await fetch(`${KUNTANII_API_URL}${path}`, {
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(opts.timeoutMs),
        cache: 'no-store',
    })
    const rawText = await response.text()
    let data: any = null
    try { data = JSON.parse(rawText) } catch { data = null }
    return { status: response.status, ok: response.ok, data, rawText }
}

// Error codes that mean Kuntanii created nothing and charged nothing. Every one is
// a definite refusal, so the router may hand the order to the fallback supplier.
const REFUSED_CODES = new Set([
    'NO_APPROVED_RECIPIENTS', 'NO_ELIGIBLE_RECIPIENTS', 'VALIDATION_ERROR',
    'INSUFFICIENT_CREDIT', 'GOVERNING_ACCOUNT_CREDIT_HOLD',
    'UNAUTHORIZED', 'FORBIDDEN', 'PAYMENT_VERIFICATION_REQUIRED',
    'PARENT_ORDERS_PAUSED', 'ACCOUNT_ORDERS_PAUSED', 'ORDERS_PAUSED', 'PRICING_PROFILE_REQUIRED',
    // 503s Kuntanii documents as "no order or credit movement was committed".
    'CREDIT_UNAVAILABLE', 'BENEFICIARY_CHECK_UNAVAILABLE', 'CREDIT_RELAY_UNAVAILABLE',
    'RATE_LIMITED',
])

// Account-level problems an admin has to fix at Kuntanii — worth a push.
const ACCOUNT_CODES = new Set([
    'INSUFFICIENT_CREDIT', 'GOVERNING_ACCOUNT_CREDIT_HOLD', 'UNAUTHORIZED', 'FORBIDDEN',
    'PAYMENT_VERIFICATION_REQUIRED', 'PARENT_ORDERS_PAUSED', 'ACCOUNT_ORDERS_PAUSED',
    'PRICING_PROFILE_REQUIRED',
])

async function alertAdmins(body: string) {
    try {
        const { sendPushToAdmins } = await import('@/lib/web-push')
        await sendPushToAdmins({ title: 'Kuntanii needs attention', body, url: '/admin/fulfillment', tag: 'kuntanii-account' })
    } catch { /* never fail an order over an alert */ }
}

/**
 * Turn one POST /orders answer into our result. Pure — exported for tests.
 * `externalOrderId` is what we sent; it becomes the stored reference.
 */
export function interpretOrderResponse(
    httpStatus: number, data: any, externalOrderId: string
): FulfillmentResponse & { cancelledDuplicate?: boolean } {
    if (data === null || typeof data !== 'object') {
        return { success: false, error: `Kuntanii returned an unreadable response (HTTP ${httpStatus})`, failureKind: 'unknown' }
    }

    if ((httpStatus === 200 || httpStatus === 201) && data.success === true) {
        const accepted = Number(data.acceptedCount ?? (Array.isArray(data.orders) ? 1 : 0))
        const rejected: any[] = Array.isArray(data.rejectedRecipients) ? data.rejectedRecipients : []
        if (accepted < 1) {
            const reason = rejected[0]?.reason || 'no recipient accepted'
            return { success: false, error: `Kuntanii accepted no recipient (${reason})`, apiResponse: sanitizeForLog(data), failureKind: 'refused' }
        }

        const idempotent = data.idempotent === true
        const statuses: string[] = Array.isArray(data.orders) && data.orders.length > 0
            ? data.orders.map((o: any) => String(o?.status ?? ''))
            : [String(data.status ?? '')]
        // A replayed key whose order was cancelled: nothing is being delivered, and
        // this key can never place a new order. The caller moves to the next suffix.
        if (idempotent && statuses.every(s => mapKuntaniiStatus(s) === 'failed')) {
            return { success: false, cancelledDuplicate: true, error: `Kuntanii order ${externalOrderId} was ${statuses[0] || 'cancelled'}`, apiResponse: sanitizeForLog(data), failureKind: 'refused' }
        }

        return {
            success: true,
            // Both fields carry the same value: the dispatcher reads
            // `transactionId || reference`, shop-order-processor and refulfill read transactionId.
            reference: externalOrderId,
            transactionId: externalOrderId,
            webhookRef: externalOrderId,
            alreadySubmitted: idempotent || undefined,
            apiResponse: sanitizeForLog(data),
        }
    }

    const code: string | undefined = data.code ? String(data.code) : undefined
    const message = data.message || data.error || 'Unknown error'
    const error = `${message} (HTTP ${httpStatus}${code ? ` ${code}` : ''})`

    if (code && REFUSED_CODES.has(code)) {
        return { success: false, error, apiResponse: sanitizeForLog(data), failureKind: 'refused', isRateLimited: code === 'RATE_LIMITED' || undefined }
    }
    // Uncoded rejections below 500 (bar 409) are explicit no's that created nothing.
    if (httpStatus === 409) {
        // The key was reused with different details, or another request with it is
        // mid-flight. Either way an order may exist — stay with Kuntanii.
        return { success: false, error, apiResponse: sanitizeForLog(data), failureKind: 'unknown' }
    }
    if (httpStatus === 429) return { success: false, error, isRateLimited: true, apiResponse: sanitizeForLog(data), failureKind: 'refused' }
    if (httpStatus >= 400 && httpStatus < 500) return { success: false, error, apiResponse: sanitizeForLog(data), failureKind: 'refused' }
    return { success: false, error, apiResponse: sanitizeForLog(data), failureKind: 'unknown' }
}

// ─── Main Fulfillment Function ─────────────────────────────────────────────────
/**
 * Fulfil one MTN data order via Kuntanii.
 *
 * `opts.isRetry` makes it probe earlier keys first (see header). `opts.deliveryMode`
 * is the raw fulfillment_settings.kuntanii_delivery_mode value.
 */
export async function fulfillOrder(
    network: string,
    phoneNumber: string,
    dataSize: string,
    orderId: string,
    opts: { isRetry?: boolean; deliveryMode?: string } = {}
): Promise<FulfillmentResponse> {
    if (!isMtn(network)) {
        return { success: false, error: `Kuntanii only sells MTN (got ${network})`, failureKind: 'refused' }
    }
    if (!KUNTANII_API_KEY) {
        return { success: false, error: 'Kuntanii API key not configured', failureKind: 'refused' }
    }
    if (!checkCircuit()) {
        return { success: false, error: 'Kuntanii temporarily unavailable (circuit open)', failureKind: 'refused' }
    }
    const dataGb = parseGigabytes(dataSize)
    if (dataGb === null) {
        return { success: false, error: `Invalid data size format: ${dataSize}`, failureKind: 'refused' }
    }
    if (!/^[A-Za-z0-9_-]{1,70}$/.test(orderId)) {
        return { success: false, error: `Order id not usable as a Kuntanii externalOrderId: ${orderId}`, failureKind: 'refused' }
    }

    const deliveryMode = parseDeliveryMode(opts.deliveryMode)
    const phone = normalizePhone(phoneNumber)

    try {
        // ── Which key to send ─────────────────────────────────────────────
        let suffix = 0
        if (opts.isRetry) {
            const probe = await findReusableKey(orderId)
            if (probe.adopt) {
                console.warn(`[Kuntanii] Order ${orderId}: already live at Kuntanii as ${probe.key} (${probe.raw}) — adopted, not re-placed.`)
                return { success: true, reference: probe.key, transactionId: probe.key, webhookRef: probe.key, alreadySubmitted: true }
            }
            if (probe.unknown) {
                return { success: false, error: `Could not check earlier Kuntanii attempts: ${probe.unknown}`, failureKind: 'unknown' }
            }
            suffix = probe.nextSuffix
        }

        // A cancelled replay moves on to the next suffix (at most once per call).
        for (let hop = 0; hop < 2; hop++) {
            if (suffix > MAX_RETRY_SUFFIX) {
                return { success: false, error: `Kuntanii: ${MAX_RETRY_SUFFIX} earlier attempts were cancelled — not trying again`, failureKind: 'refused' }
            }
            const externalOrderId = suffix === 0 ? orderId : `${orderId}-r${suffix}`
            const body: Record<string, any> = { externalOrderId, items: [{ phoneNumber: phone, dataGb }] }
            if (deliveryMode === 'instant') body.deliveryMode = 'instant'

            console.log(`[Kuntanii] Order ${orderId} | MTN ${dataGb}GB | ${deliveryMode} | key ${externalOrderId}${opts.isRetry ? ' | retry' : ''}`)

            let res: Awaited<ReturnType<typeof callApi>>
            try {
                res = await callApi('POST', '/api/integrations/orders', { body, idempotencyKey: externalOrderId, timeoutMs: 15_000 })
            } catch (err: any) {
                recordFailure()
                console.error(`[Kuntanii] Order ${orderId}: request failed — ${err?.message}`)
                // It may have landed. The order stays with Kuntanii, and the next retry
                // resends the same key, which their idempotency makes safe.
                return { success: false, error: err?.message || 'Network error reaching Kuntanii', failureKind: 'unknown' }
            }

            const result = interpretOrderResponse(res.status, res.data, externalOrderId)
            console.log(`[Kuntanii] Order ${orderId} → HTTP ${res.status} ${res.data?.code || res.data?.outcome || ''} ${res.data?.orderReference || ''}`.trim())

            if (result.cancelledDuplicate) { suffix++; continue }
            delete result.cancelledDuplicate

            if (result.success) recordSuccess()
            else if (res.status >= 500 && result.failureKind === 'unknown') recordFailure()

            const code = res.data?.code ? String(res.data.code) : ''
            if (!result.success && ACCOUNT_CODES.has(code)) {
                await alertAdmins(`${code}: ${res.data?.message || 'order refused'} — MTN orders are going to the fallback supplier.`)
            }
            if (!result.success && code === 'VALIDATION_ERROR' && deliveryMode === 'instant') {
                console.error(`[Kuntanii] Instant Delivery refused (${res.data?.message}). Not resending as normal — switch the delivery mode in Admin → Fulfillment if instant is not enabled.`)
            }
            return result
        }
        return { success: false, error: 'Kuntanii: no usable order key', failureKind: 'refused' }
    } catch (error: any) {
        recordFailure()
        console.error(`[Kuntanii] Exception during fulfillOrder for ${orderId}:`, error?.message)
        return { success: false, error: error?.message || 'Unexpected exception', failureKind: 'unknown' }
    }
}

/**
 * On a retry: walk <id>, <id>-r1 … and decide. A live order (pending / processing /
 * processed) is adopted; a cancelled one means try the next suffix; the first key
 * Kuntanii has never seen (404) is where a new order goes.
 */
async function findReusableKey(orderId: string): Promise<
    { adopt: true; key: string; raw: string; unknown?: undefined; nextSuffix: number }
    | { adopt: false; unknown?: string; nextSuffix: number }
> {
    for (let suffix = 0; suffix <= MAX_RETRY_SUFFIX; suffix++) {
        const key = suffix === 0 ? orderId : `${orderId}-r${suffix}`
        const st = await checkOrderStatus(key)
        if (st.notFound) return { adopt: false, nextSuffix: suffix }
        if (!st.success) return { adopt: false, unknown: st.message || 'status check failed', nextSuffix: suffix }
        if (st.status !== 'failed') return { adopt: true, key, raw: st.message || st.status, nextSuffix: suffix }
        // cancelled → look at the next key
    }
    return { adopt: false, nextSuffix: MAX_RETRY_SUFFIX + 1 }
}

// ─── Status ────────────────────────────────────────────────────────────────────
/**
 * Pick one status for our single-recipient order out of the status payload.
 * Webhook `data` and GET /orders/{id} share this shape: { orders: [{ status, … }] }.
 * More than one KT order only happens on a split (>1500 GB), which we never send;
 * if it does, every part must be processed before we call it completed.
 */
export function overallStatus(data: any): { status: MappedStatus; raw: string } | null {
    const orders: any[] = Array.isArray(data?.orders) ? data.orders : []
    const raws = orders.length > 0 ? orders.map(o => String(o?.status ?? '')) : (data?.status ? [String(data.status)] : [])
    if (raws.length === 0) return null
    const mapped = raws.map(mapKuntaniiStatus)
    if (mapped.every(s => s === 'completed')) return { status: 'completed', raw: raws[0] }
    if (mapped.every(s => s === 'failed')) return { status: 'failed', raw: raws[0] }
    const inFlight = raws.find((_, i) => mapped[i] !== 'completed' && mapped[i] !== 'failed') ?? raws[0]
    return { status: mapped.includes('pending') ? 'pending' : 'processing', raw: inFlight }
}

/** GET /api/integrations/orders/{externalOrderId}. */
export async function checkOrderStatus(externalOrderId: string): Promise<StatusResponse> {
    if (!KUNTANII_API_KEY) return { success: false, status: 'pending', message: 'API key not configured' }
    try {
        const path = `/api/integrations/orders/${encodeURIComponent(externalOrderId)}`
        let res = await callApi('GET', path, { timeoutMs: 10_000 })
        // Not under the current key — it may have been placed with a previous one.
        for (const apiKey of KUNTANII_PREVIOUS_API_KEYS) {
            if (res.status !== 404) break
            res = await callApi('GET', path, { timeoutMs: 10_000, apiKey })
        }
        const { status, ok, data, rawText } = res
        if (status === 404) return { success: false, status: 'pending', notFound: true, message: 'Not found' }
        if (!ok || data === null) {
            return { success: false, status: 'pending', message: data?.message || `HTTP ${status}: ${rawText.slice(0, 120)}` }
        }
        const payload = data?.data && typeof data.data === 'object' && !Array.isArray(data.data) ? data.data : data
        const overall = overallStatus(payload)
        if (!overall) return { success: false, status: 'pending', message: 'No status in response', data: sanitizeForLog(data) }
        return { success: true, status: overall.status, message: overall.raw, data: sanitizeForLog(data) }
    } catch (err: any) {
        return { success: false, status: 'pending', message: err?.message || 'Status check failed' }
    }
}

/**
 * Map a Kuntanii order status to ours.
 *
 * Documented: pending → processing → processed, plus cancelled and "not received".
 * "not received" is a dispute raised AFTER delivery and does not mean a refund was
 * approved, so it never fails an order; it falls through to 'pending' (no change).
 */
export function mapKuntaniiStatus(status: string): MappedStatus {
    const s = normaliseSupplierStatus(status)
    const COMPLETED = ['processed', 'completed', 'complete', 'delivered', 'success', 'successful', 'fulfilled']
    const FAILED = ['cancelled', 'canceled', 'failed', 'rejected', 'refunded', 'reversed', 'declined']
    const IN_FLIGHT = ['pending', 'processing', 'queued', 'accepted', 'in progress', 'downloaded']
    if (COMPLETED.includes(s)) return 'completed'
    if (FAILED.includes(s)) return 'failed'
    if (IN_FLIGHT.includes(s)) return 'processing'
    return 'pending'
}

// ─── Pricing / beneficiaries (admin + setup checks; never charge) ──────────────
export async function fetchPricing(deliveryMode: KuntaniiDeliveryMode = 'normal') {
    if (!KUNTANII_API_KEY) return { success: false as const, error: 'API key not configured' }
    try {
        const qs = deliveryMode === 'instant' ? '?deliveryMode=instant' : ''
        const { status, ok, data } = await callApi('GET', `/api/integrations/pricing${qs}`, { timeoutMs: 10_000 })
        if (!ok || data?.success !== true) return { success: false as const, error: data?.message || `HTTP ${status}`, code: data?.code }
        return { success: true as const, data }
    } catch (err: any) {
        return { success: false as const, error: err?.message || 'Pricing fetch failed' }
    }
}

export async function verifyBeneficiaries(phoneNumbers: string[]) {
    if (!KUNTANII_API_KEY) return { success: false as const, error: 'API key not configured' }
    try {
        const { status, ok, data } = await callApi('POST', '/api/integrations/beneficiaries/verify', {
            body: { phoneNumbers: phoneNumbers.map(normalizePhone) }, timeoutMs: 10_000,
        })
        if (!ok || data?.success !== true) return { success: false as const, error: data?.message || `HTTP ${status}`, code: data?.code }
        return { success: true as const, data }
    } catch (err: any) {
        return { success: false as const, error: err?.message || 'Verify failed' }
    }
}

/**
 * "Server 3" number check: which numbers Kuntanii will deliver to. Check only —
 * nothing is submitted to MTN. Reply: { results: [{ phoneNumber, normalizedPhone,
 * eligible, reason, message }] }. Chunked; numbers in a chunk that errors land in
 * `failed`.
 */
export async function verifyKuntaniiNumbers(phoneNumbers: string[]): Promise<{
    success: boolean; allowed: Set<string>; failed: Set<string>; reasons: Map<string, string>; error?: string
}> {
    const allowed = new Set<string>(), failed = new Set<string>(), reasons = new Map<string, string>()
    const CHUNK = 100
    let anyOk = false, lastError: string | undefined
    for (let i = 0; i < phoneNumbers.length; i += CHUNK) {
        const chunk = phoneNumbers.slice(i, i + CHUNK)
        const res = await verifyBeneficiaries(chunk)
        if (!res.success) {
            lastError = res.error
            chunk.forEach(n => failed.add(n))
            continue
        }
        anyOk = true
        const byLocal = new Map<string, any>()
        for (const r of res.data?.results || []) {
            byLocal.set(normalizePhone(String(r?.normalizedPhone || r?.phoneNumber || '')), r)
        }
        for (const n of chunk) {
            const r = byLocal.get(normalizePhone(n))
            if (!r) { failed.add(n); continue }
            if (r.eligible === true) allowed.add(n)
            else if (r.message || r.reason) reasons.set(n, String(r.message || r.reason))
        }
    }
    return { success: anyOk, allowed, failed, reasons, error: anyOk ? undefined : lastError }
}

/** Kuntanii documents no balance endpoint. */
export async function fetchSupplierBalance(): Promise<{ success: boolean; balance?: number; currency?: string; error?: string; unsupported?: boolean }> {
    return { success: false, unsupported: true, error: 'Kuntanii has no balance endpoint' }
}

// ─── Not-received reports (disputes) ───────────────────────────────────────────
//   POST /api/integrations/orders/{externalOrderId}/not-received { phoneNumber, dataGb?, reasonCode?, description? }
//     → 201 { reportReference, orderReference, disputeStatus, orderStatus, … }
//   GET  /api/integrations/orders/{externalOrderId}/not-received?page=N
//     → every report on that order (incl. ones Kuntanii staff opened), 25 per page.
// Only allowed on a processed order. Reports are scoped to the API key that placed
// the order, so 404s fall back to KUNTANII_PREVIOUS_API_KEYS like checkOrderStatus.
// A Kuntanii refund is a billing credit to US — it never refunds our customer.

export interface NotReceivedReport {
    reportReference: string | null
    phoneNumber: string | null
    dataGb: number | null
    /** open | escalated | resolved | rejected */
    status: string | null
    /** pending | escalated | confirmed_sent | refunded | retry_approved | rejected | resolved */
    outcome: string | null
    resolution: string | null
    createdAt: string | null
    resolvedAt: string | null
    refundGhs: number | null
}

function pickReport(r: any): NotReceivedReport {
    const refunds: any[] = Array.isArray(r?.refunds) ? r.refunds : []
    return {
        reportReference: r?.reportReference ?? null,
        phoneNumber: r?.phoneNumber ?? null,
        dataGb: r?.dataGb ?? null,
        status: r?.disputeStatus ?? r?.status ?? null,
        outcome: r?.outcome ?? null,
        resolution: r?.resolution ?? null,
        createdAt: r?.createdAt ?? r?.reportedAt ?? null,
        resolvedAt: r?.resolvedAt ?? null,
        refundGhs: refunds.length > 0 ? refunds.reduce((sum, x) => sum + (Number(x?.amountGhs) || 0), 0) : null,
    }
}

type OrderCall = { key: string; status: number; ok: boolean; data: any; rawText: string }

/** Try each candidate externalOrderId under each API key until one isn't a 404. */
async function callForOrder(keys: string[], method: 'GET' | 'POST', suffix: string, body?: any): Promise<OrderCall | null> {
    let last: OrderCall | null = null
    for (const key of [...new Set(keys.filter(Boolean))]) {
        const path = `/api/integrations/orders/${encodeURIComponent(key)}/not-received${suffix}`
        for (const apiKey of [KUNTANII_API_KEY, ...KUNTANII_PREVIOUS_API_KEYS]) {
            const res = await callApi(method, path, { body, timeoutMs: 15_000, apiKey })
            last = { key, ...res }
            if (res.status !== 404) return last
        }
    }
    return last
}

function apiError(res: OrderCall): string {
    const d = res.data
    const msg = d?.error?.message || d?.message || (typeof d?.error === 'string' ? d.error : null)
    const code = d?.error?.code || d?.code
    return [code, msg].filter(Boolean).join(': ') || `HTTP ${res.status}: ${res.rawText.slice(0, 160)}`
}

function unwrap(data: any): any {
    return data?.data && typeof data.data === 'object' && !Array.isArray(data.data) ? data.data : data
}

/** Raise a not-received dispute for one recipient on a processed Kuntanii order. */
export async function reportNotReceived(
    keys: string[],
    input: { phoneNumber: string; dataGb?: number | null; description?: string; reasonCode?: string },
): Promise<{
    success: boolean
    externalOrderId?: string
    report?: NotReceivedReport & { orderReference: string | null; orderStatus: string | null }
    error?: string
}> {
    if (!KUNTANII_API_KEY) return { success: false, error: 'KUNTANII_API_KEY not configured' }
    try {
        const body: Record<string, unknown> = { phoneNumber: normalizePhone(input.phoneNumber) }
        if (input.dataGb) body.dataGb = input.dataGb
        if (input.reasonCode) body.reasonCode = input.reasonCode
        if (input.description) body.description = input.description.slice(0, 500)
        const res = await callForOrder(keys, 'POST', '', body)
        if (!res) return { success: false, error: 'No Kuntanii reference for this order' }
        if (!res.ok || res.data?.success === false) return { success: false, externalOrderId: res.key, error: apiError(res) }
        const payload = unwrap(res.data)
        return {
            success: true,
            externalOrderId: res.key,
            report: { ...pickReport(payload), orderReference: payload?.orderReference ?? null, orderStatus: payload?.orderStatus ?? null },
        }
    } catch (err: any) {
        return { success: false, error: err?.message || 'Report failed' }
    }
}

/** Every not-received report Kuntanii holds for an order. */
export async function listNotReceivedReports(
    keys: string[],
): Promise<{ success: boolean; externalOrderId?: string; reports: NotReceivedReport[]; notFound?: boolean; error?: string }> {
    if (!KUNTANII_API_KEY) return { success: false, reports: [], error: 'KUNTANII_API_KEY not configured' }
    const reports: NotReceivedReport[] = []
    try {
        let candidates = keys
        let externalOrderId: string | undefined
        for (let page = 1; page <= 4; page++) {
            const res = await callForOrder(candidates, 'GET', `?page=${page}`)
            if (!res) return { success: false, reports, error: 'No Kuntanii reference for this order' }
            if (res.status === 404) return { success: true, externalOrderId: res.key, reports, notFound: page === 1 }
            if (!res.ok) return { success: false, externalOrderId: res.key, reports, error: apiError(res) }
            externalOrderId = res.key
            candidates = [res.key]
            const payload = unwrap(res.data)
            const list: any[] = Array.isArray(payload?.reports) ? payload.reports
                : Array.isArray(res.data?.data) ? res.data.data
                : Array.isArray(payload?.items) ? payload.items : []
            reports.push(...list.map(pickReport))
            if (!(payload?.pagination?.hasNext ?? res.data?.pagination?.hasNext)) break
        }
        return { success: true, externalOrderId, reports }
    } catch (err: any) {
        return { success: false, reports, error: err?.message || 'Lookup failed' }
    }
}
