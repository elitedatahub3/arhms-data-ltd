/**
 * Datagod Developer API v2 — utility bills (/v2/utilities/*).
 *
 * The second bill provider beside lib/kingflexy-utility-service.ts.
 * lib/utility-provider.ts picks between them PER BILLER; nothing else should import
 * this file directly.
 *
 * Flow (Datagod docs, "Bill payment flow"):
 *   GET  /utilities/billers            → enabled, min_amount, max_amount per biller
 *   POST /utilities/lookup             → customer name + a SINGLE-USE verify_token
 *   POST /utilities/pay                → { verify_token, amount, reference, expected_pay }
 *   GET  /utilities/orders/{reference} → poll; Datagod sends NO webhooks.
 *
 * The one real difference from KingFlexy: Datagod pays only with a verify_token, and
 * one token pays one reference once. A Direct Pay order can sit minutes waiting for a
 * MoMo PIN, so the token from the checkout lookup is never kept — payUtilityBillViaDatagod
 * runs its own fresh lookup immediately before paying, the same way Standard Bundles
 * fetch a fresh bundle_token at dispatch.
 *
 * Key: the same Commission Services key Standard Bundles use (DATAGOD_COMMISSION_KEY,
 * dg2_live_… / dg2_test_…). It spends our Datagod wallet. The reference we send is our
 * own reference_code, and Datagod echoes it back — so an order can always be asked
 * about by our reference, even if we crashed before hearing the answer.
 */
import { sanitizeForLog } from '@/lib/safe-log'
import type { UtilityQueryResult, UtilityMeter, UtilityDetailRow } from '@/lib/hubtel-utility-service'
import { billerForService } from '@/lib/api-v2-billers'
import type { KfPayResult, KfOrderStatus } from '@/lib/kingflexy-utility-service'

const DG_KEY = process.env.DATAGOD_COMMISSION_KEY || ''
const DG_V2_URL = (process.env.DATAGOD_API_V2_URL || 'https://api.datagod.store/v2').replace(/\/+$/, '')

const UNAVAILABLE = 'Bill payments are temporarily unavailable. Please try again shortly.'

// ─── Circuit Breaker ─────────────────────────────────────────────────────────
// Its own, separate from Standard Bundles: a bills outage at Datagod must not stop
// bundle orders, and vice versa.
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
        console.log('[DatagodUtility] Circuit breaker OPENED')
    }
}

// ─── Shared request helper ───────────────────────────────────────────────────

export interface DgResponse {
    ok: boolean
    status: number
    data: any
    transportError?: string
}

/**
 * Same contract as the bundles client: retries transport failures and 5xx only.
 * Retrying /pay on a 5xx is safe because the reference is unchanged and Datagod
 * replays an existing reference instead of charging again.
 */
async function dgRequest(method: 'GET' | 'POST', path: string, body?: any, budgetMs = 25_000): Promise<DgResponse> {
    const deadline = Date.now() + budgetMs
    const maxAttempts = 3
    let lastError: Error | null = null

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const res = await fetch(`${DG_V2_URL}${path}`, {
                method,
                headers: {
                    Accept: 'application/json',
                    Authorization: DG_KEY,
                    ...(body ? { 'Content-Type': 'application/json' } : {}),
                },
                ...(body ? { body: JSON.stringify(body) } : {}),
                cache: 'no-store',
                signal: AbortSignal.timeout(Math.max(2_000, deadline - Date.now())),
            })

            const raw = await res.text()
            let data: any = null
            try {
                data = raw ? JSON.parse(raw) : null
            } catch {
                console.error(`[DatagodUtility] Non-JSON response (HTTP ${res.status}):`, raw.slice(0, 300))
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
            console.error(`[DatagodUtility] ${method} ${path} attempt ${attempt} failed:`, err?.message)
            if (Date.now() >= deadline) break
            if (attempt < maxAttempts) await new Promise(r => setTimeout(r, 2000 * attempt))
        }
    }

    recordFailure()
    return { ok: false, status: 0, data: null, transportError: lastError?.message || 'Could not reach Datagod' }
}

/** The precise reason is logged; callers (possibly public) only get UNAVAILABLE. */
function configError(): string | null {
    if (!DG_KEY) {
        console.error('[DatagodUtility] DATAGOD_COMMISSION_KEY is not configured.')
        return UNAVAILABLE
    }
    if (!DG_KEY.startsWith('dg2_')) {
        console.error('[DatagodUtility] DATAGOD_COMMISSION_KEY is not a v2 key (expected the dg2_live_ / dg2_test_ prefix).')
        return UNAVAILABLE
    }
    return null
}

/** Admin-only: the exact config problem, for the Test Datagod button. */
export function datagodUtilityConfigProblem(): string | null {
    if (!DG_KEY) return 'DATAGOD_COMMISSION_KEY is not set.'
    if (!DG_KEY.startsWith('dg2_')) return 'DATAGOD_COMMISSION_KEY is not a v2 Commission Services key (expected dg2_live_…).'
    if (DG_KEY.startsWith('dg2_test_')) return 'DATAGOD_COMMISSION_KEY is a TEST key: payments go to the sandbox and no real bill is paid.'
    return null
}

function errorMessage(res: DgResponse, fallback: string): string {
    return res.transportError || res.data?.error?.message || res.data?.message || fallback
}

/** True when the error body mentions this code word anywhere (Datagod puts it in the message). */
function hasErrorCode(res: DgResponse, code: string): boolean {
    const e = res.data?.error ?? res.data
    if (!e) return false
    try {
        return JSON.stringify(e).toUpperCase().includes(code)
    } catch {
        return false
    }
}

const round2 = (n: number) => Math.round(n * 100) / 100

// ─── Billers ─────────────────────────────────────────────────────────────────

export interface DgBiller {
    key: string
    label: string
    enabled: boolean
    min_amount: number
    max_amount: number
    inputs: { name: string; required: boolean }[]
}

export interface DgBillerCatalog {
    success: boolean
    billers?: DgBiller[]
    error?: string
    status?: number
}

/** Uncached on purpose: used by the admin test and once per dispatch. */
export async function listDgBillers(): Promise<DgBillerCatalog> {
    const cfg = configError()
    if (cfg) return { success: false, error: datagodUtilityConfigProblem() || cfg }
    if (!checkCircuit()) return { success: false, error: 'Datagod bill payments are temporarily unavailable (circuit open).' }

    const res = await dgRequest('GET', '/utilities/billers', undefined, 15_000)
    if (!res.ok || res.data?.success !== true) {
        return { success: false, status: res.status, error: errorMessage(res, `Could not load billers (HTTP ${res.status})`) }
    }

    const billers: DgBiller[] = (res.data.data?.billers ?? []).map((b: any) => ({
        key: String(b?.key ?? ''),
        label: String(b?.label ?? b?.key ?? ''),
        enabled: b?.enabled === true,
        min_amount: Number(b?.min_amount ?? 1),
        max_amount: Number(b?.max_amount ?? 5000),
        inputs: Array.isArray(b?.inputs) ? b.inputs : [],
    }))
    return { success: true, billers }
}

// ─── Lookup ──────────────────────────────────────────────────────────────────

export interface DgLookupParams {
    /** Our internal service id — translated to their biller key here. */
    service: string
    accountNumber?: string
    phone?: string
    email?: string
    /** ECG only: look up the one meter in accountNumber rather than list the phone's meters. */
    addMeter?: boolean
}

/** Lookup body for one biller. Only the fields Datagod documents for it. */
export function buildDgLookupBody(params: DgLookupParams): { body?: Record<string, any>; error?: string } {
    const biller = billerForService(params.service)
    if (!biller) return { error: `Unknown utility service: ${params.service}` }

    const account = (params.accountNumber || '').trim()
    const phone = (params.phone || '').trim()
    const email = (params.email || '').trim()
    const body: Record<string, any> = { biller }

    if (biller === 'ecg') {
        if (!phone) return { error: 'A phone number is required for ECG.' }
        body.phone = phone
        if (params.addMeter) {
            if (!account) return { error: 'A meter number is required.' }
            body.account = account
            body.add_meter = true
        }
        return { body }
    }

    if (!account) return { error: 'An account or meter number is required.' }
    body.account = account
    if (biller === 'ghana_water') {
        if (!phone) return { error: 'A phone number is required for Ghana Water.' }
        body.phone = phone
        // Ghana Water requires an email. The web lookup does not collect one before
        // checkout, so fall back to a no-reply address; the pay-time lookup sends the
        // customer's real email from the order.
        body.email = email || 'billing@arhmsgh.com'
    }
    return { body }
}

interface DgLookupRaw {
    result: UtilityQueryResult
    /** Top-level token (non-ECG, or ECG with add_meter). */
    token?: string
    /** ECG meter list tokens, keyed by normalised meter number. */
    meterTokens: Record<string, string>
}

const normMeter = (s: string) => String(s || '').replace(/\s+/g, '').toLowerCase()

/** Pure: turns one Datagod lookup answer into our UtilityQueryResult plus its tokens. */
export function normaliseDgLookup(res: DgResponse): DgLookupRaw {
    if (!res.ok || res.data?.success !== true) {
        const message = errorMessage(res, 'That account could not be verified.')
        // Datagod being unwell (5xx, 403 NOT_AVAILABLE, transport) reads as
        // "temporarily unavailable" with no responseCode, so lookupFailureStatus()
        // answers 502; a wrong number (400, 502 LOOKUP_FAILED) keeps a code → 404.
        const unwell = res.status === 0 || res.status >= 503 || res.status === 500
            || (res.status === 403 && hasErrorCode(res, 'NOT_AVAILABLE'))
            || res.status === 429
        if (unwell) console.error(`[DatagodUtility] Lookup unavailable (HTTP ${res.status}): ${message}`)
        return {
            result: unwell
                ? { success: false, error: UNAVAILABLE }
                : { success: false, error: hasErrorCode(res, 'LOOKUP_FAILED') ? 'That account could not be verified. Check the details and try again.' : message, responseCode: String(res.status || '') },
            meterTokens: {},
        }
    }

    const d = res.data.data || {}
    const meterTokens: Record<string, string> = {}
    const meters: UtilityMeter[] = Array.isArray(d.meters)
        ? d.meters.map((m: any) => {
            const meterNumber = String(m?.meter ?? m?.meterNumber ?? m?.meter_number ?? '')
            if (m?.verify_token) meterTokens[normMeter(meterNumber)] = String(m.verify_token)
            return {
                // buildUtilityIntent parses "NAME (METER)" out of the label.
                label: m?.name ? `${m.name} (${meterNumber})` : meterNumber,
                meterNumber,
                balance: Number(m?.outstanding ?? 0) || 0,
            }
        })
        : []

    const details: UtilityDetailRow[] = []
    if (d.customer_name) details.push({ display: 'name', value: String(d.customer_name), amount: 0 })
    if (d.bouquet) details.push({ display: 'bouquet', value: String(d.bouquet), amount: 0 })
    if (d.amount_due != null) details.push({ display: 'amountDue', value: String(d.amount_due), amount: Number(d.amount_due) || 0 })

    const firstMeterName = meters[0]?.label ? /^(.*?)\s*\(/.exec(meters[0].label)?.[1]?.trim() : undefined

    return {
        result: {
            success: true,
            accountName: d.customer_name ?? firstMeterName ?? undefined,
            amountDue: d.amount_due != null ? Number(d.amount_due) : undefined,
            meters: meters.length ? meters : undefined,
            details,
            sessionId: undefined,
            responseCode: '0000',
        },
        token: d.verify_token ? String(d.verify_token) : undefined,
        meterTokens,
    }
}

async function dgLookupRaw(params: DgLookupParams): Promise<DgLookupRaw> {
    const cfg = configError()
    if (cfg) return { result: { success: false, error: cfg }, meterTokens: {} }
    if (!checkCircuit()) return { result: { success: false, error: UNAVAILABLE }, meterTokens: {} }

    const built = buildDgLookupBody(params)
    if (!built.body) return { result: { success: false, error: built.error, responseCode: '400' }, meterTokens: {} }

    const res = await dgRequest('POST', '/utilities/lookup', built.body, 20_000)
    return normaliseDgLookup(res)
}

/**
 * Account lookup for checkout and the API. Moves no money. The verify_token is
 * dropped here on purpose: it is single-use and would be stale by the time a
 * Direct Pay order is paid.
 */
export async function lookupUtilityAccountViaDatagod(params: DgLookupParams): Promise<UtilityQueryResult> {
    return (await dgLookupRaw(params)).result
}

/**
 * A fresh verify_token for exactly this account. ECG lists the phone's meters
 * first and takes the matching meter's token; a meter not yet on that phone is
 * looked up directly with add_meter.
 */
async function freshVerifyToken(params: DgLookupParams): Promise<{ token?: string; error?: string; unavailable?: boolean }> {
    const biller = billerForService(params.service)
    if (biller === 'ecg') {
        const listed = await dgLookupRaw({ ...params, addMeter: false })
        const hit = listed.meterTokens[normMeter(params.accountNumber || '')]
        if (hit) return { token: hit }
        const direct = await dgLookupRaw({ ...params, addMeter: true })
        if (direct.token) return { token: direct.token }
        return {
            error: direct.result.error || listed.result.error || `Meter ${params.accountNumber} could not be verified with ECG.`,
            unavailable: !direct.result.responseCode,
        }
    }

    const r = await dgLookupRaw(params)
    if (r.token) return { token: r.token }
    return { error: r.result.error || 'That account could not be verified.', unavailable: !r.result.responseCode }
}

// ─── Payment ─────────────────────────────────────────────────────────────────

export interface DgPayParams {
    service: string
    accountNumber: string
    amount: number
    phone?: string | null
    email?: string | null
    /** Our reference_code — Datagod's idempotency key and the status handle. */
    reference: string
    /**
     * The most we may be charged (what the customer paid us). A PRICE_CHANGED retry
     * above this is refused rather than paid at a loss.
     */
    maxCost?: number
}

export interface DgPayResult extends KfPayResult {
    /** What Datagod charged our wallet. */
    paidAmount?: number
    /** Cashback Datagod credited for this payment — our commission. */
    cashback?: number
    /** True when Datagod's wallet is short (402). */
    insufficientBalance?: boolean
}

/**
 * The money-safety core. Decides from one /pay answer whether we KNOW nothing was
 * charged (so the customer can be refunded) or the payment may have landed.
 *
 * Ambiguous, never refund:
 *   - no answer at all (transport error)
 *   - 409 REQUEST_IN_PROGRESS / OUTCOME_UNKNOWN, 500 OUTCOME_UNKNOWN
 *   - 409 REFERENCE_REUSED — a payment under OUR reference may already exist
 *   - any other 5xx that does not say "nothing was charged"
 * Definite refusal, safe to refund: every other 4xx, and 5xx saying "nothing was charged".
 */
export function classifyDgPayFailure(res: DgResponse): { knownUnpaid: boolean } {
    if (res.transportError || res.status === 0) return { knownUnpaid: false }
    if (hasErrorCode(res, 'OUTCOME_UNKNOWN') || hasErrorCode(res, 'REQUEST_IN_PROGRESS')) return { knownUnpaid: false }
    if (hasErrorCode(res, 'REFERENCE_REUSED')) return { knownUnpaid: false }
    const msg = JSON.stringify(res.data ?? '').toLowerCase()
    if (res.status >= 500) return { knownUnpaid: msg.includes('nothing was charged') }
    if (res.status >= 400) return { knownUnpaid: true }
    return { knownUnpaid: false }
}

/** "PRICE_CHANGED: expected 120.00, current 120.50 (...)" → 120.5 */
export function parsePriceChangedCurrent(res: DgResponse): number | null {
    const msg = String(res.data?.error?.message ?? res.data?.message ?? '')
    const m = /current\s+([\d.]+)/i.exec(msg)
    const n = m ? Number(m[1]) : NaN
    return Number.isFinite(n) && n > 0 ? n : null
}

function successFromPay(res: DgResponse): DgPayResult {
    const o = res.data?.data?.order || {}
    return {
        success: true,
        supplierReference: o.reference ? String(o.reference) : undefined,
        status: o.status || 'pending',
        alreadyProcessed: res.data?.data?.replayed === true || res.data?.replayed === true || res.status === 200,
        paidAmount: o.paid_amount != null ? Number(o.paid_amount) : undefined,
        cashback: o.cashback != null ? Number(o.cashback) : undefined,
        raw: sanitizeForLog(res.data),
    }
}

export async function payUtilityBillViaDatagod(params: DgPayParams): Promise<DgPayResult> {
    const cfg = configError()
    if (cfg) return { success: false, error: cfg, knownUnpaid: true }
    if (!checkCircuit()) return { success: false, error: 'Datagod bill payments are temporarily unavailable.', knownUnpaid: true }

    const biller = billerForService(params.service)
    if (!biller) return { success: false, error: `Unknown utility service: ${params.service}`, knownUnpaid: true }

    const amount = round2(Number(params.amount))
    const lookupParams: DgLookupParams = {
        service: params.service,
        accountNumber: params.accountNumber,
        phone: params.phone || undefined,
        email: params.email || undefined,
    }

    let expectedPay = amount
    for (let attempt = 1; attempt <= 2; attempt++) {
        // Nothing has been sent to /pay yet, so a failed lookup is a definite
        // "not paid" — the customer can be refunded.
        const tok = await freshVerifyToken(lookupParams)
        if (!tok.token) {
            return { success: false, error: `Could not verify the account with Datagod before paying: ${tok.error}`, knownUnpaid: true }
        }

        console.log(`[DatagodUtility] Paying ${biller} GHS ${amount} -> ${params.accountNumber} (ref ${params.reference}, expected_pay ${expectedPay})`)
        const res = await dgRequest('POST', '/utilities/pay', {
            verify_token: tok.token,
            amount,
            reference: params.reference,
            expected_pay: round2(expectedPay),
        }, 25_000)

        if (res.ok && res.data?.success === true) return successFromPay(res)

        // The price moved between lookup and pay. Nothing was charged. Accept the new
        // price once, but only if it is still within what the customer paid us.
        if (attempt === 1 && res.status === 409 && hasErrorCode(res, 'PRICE_CHANGED')) {
            const current = parsePriceChangedCurrent(res)
            const ceiling = params.maxCost != null ? Number(params.maxCost) : amount
            if (current != null && current <= ceiling) {
                console.warn(`[DatagodUtility] ${params.reference}: price changed ${expectedPay} -> ${current}; retrying once.`)
                expectedPay = current
                continue
            }
            return {
                success: false,
                error: `Datagod's price changed to GHS ${current ?? '?'}, above the GHS ${ceiling.toFixed(2)} the customer paid. Nothing was charged.`,
                knownUnpaid: true,
                raw: sanitizeForLog(res.data),
            }
        }

        const { knownUnpaid } = classifyDgPayFailure(res)
        return {
            success: false,
            error: errorMessage(res, `Payment refused (HTTP ${res.status})`),
            knownUnpaid,
            insufficientBalance: res.status === 402,
            raw: sanitizeForLog(res.data),
        }
    }

    // Unreachable: the loop always returns.
    return { success: false, error: 'Payment was not attempted.', knownUnpaid: true }
}

// ─── Status ──────────────────────────────────────────────────────────────────

export interface DgOrderStatus extends KfOrderStatus {
    /** True on a 404: Datagod does not know this reference (never proof it was unpaid). */
    notFound?: boolean
}

/** Pure: maps one GET /utilities/orders/{reference} answer. */
export function normaliseDgOrderStatus(res: DgResponse): DgOrderStatus {
    if (!res.ok || res.data?.success !== true) {
        return {
            success: false,
            notFound: res.status === 404,
            error: errorMessage(res, `Status unavailable (HTTP ${res.status})`),
        }
    }

    const d = res.data.data || {}
    const o = d.order
    if (!o) {
        // Our request with this reference is still unconfirmed at Datagod
        // (claim.state in_progress / outcome_unknown). Keep waiting.
        return { success: true, status: 'pending', raw: sanitizeForLog(res.data) }
    }

    const s = String(o.status || '').toLowerCase()
    const status = (['pending', 'processing', 'completed', 'failed', 'refunded'] as const).find(x => x === s) ?? 'processing'
    return {
        success: true,
        status,
        accountName: o.customer_name ?? null,
        amount: o.face_amount != null ? Number(o.face_amount) : undefined,
        commissionEarned: o.cashback != null ? Number(o.cashback) : null,
        raw: sanitizeForLog(res.data),
    }
}

/** @param reference OUR reference_code — Datagod echoes it. */
export async function getDgUtilityOrderStatus(reference: string): Promise<DgOrderStatus> {
    const cfg = configError()
    if (cfg) return { success: false, error: cfg }
    if (!checkCircuit()) return { success: false, error: 'Provider temporarily unavailable.' }

    const res = await dgRequest('GET', `/utilities/orders/${encodeURIComponent(reference)}`, undefined, 15_000)
    return normaliseDgOrderStatus(res)
}
