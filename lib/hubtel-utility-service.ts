/**
 * Hubtel Commission Services — Utility Bill Payments
 *
 * DSTV, GOtv, StarTimes, ECG and Ghana Water. Same API surface as airtime
 * (lib/hubtel-airtime-service.ts): same prepaid/commission account, same
 * credentials, same Fixie IP whitelist — one service ID per utility.
 *
 * API Docs: https://developers.hubtel.com/docs/business/api_documentation/commission_services
 *
 * What is different from airtime, and why this file exists at all:
 *
 *   1. Every service has a QUERY endpoint that resolves an account number to a
 *      customer name. Airtime goes to a phone number the buyer already knows; a
 *      DSTV smartcard typo pays a stranger's subscription with no way back, so the
 *      name is shown and confirmed before any money moves.
 *
 *   2. The three services do not agree on what `Destination` means. Pay-TV sends
 *      the smartcard; ECG and Ghana Water send the customer's MSISDN and carry the
 *      meter in `Extradata.bundle`. That rule lives in UTILITY_SERVICES below and
 *      nowhere else.
 *
 *   3. Ghana Water issues a single-use `sessionId` on the query that must be posted
 *      with the payment. It is spent on use, so it has to come from a server-side
 *      query taken moments before the charge — never from whatever the browser had.
 *
 * Uses the same env as airtime:
 *   HUBTEL_PREPAID_ACCOUNT_NUMBER — the disbursement account; must be funded.
 *   HUBTEL_AIRTIME_CLIENT_ID / _SECRET — optional, falls back to HUBTEL_CLIENT_ID/SECRET
 *   FIXIE_URL — static-IP proxy; the same whitelisted IP the airtime path uses.
 */
import {
    getDispatcher,
    buildHubtelBasicAuth,
    toHubtelMsisdn,
    describeHubtelNetworkFailure,
} from '@/lib/hubtel-payment-service'
import { sanitizeForLog } from '@/lib/safe-log'
import { webhookBaseUrl } from './webhook-base-url'

const HUBTEL_CS_BASE_URL = 'https://cs.hubtel.com/commissionservices'

// ─── Service registry ─────────────────────────────────────────────────────────

/**
 * How the account is identified, which decides both the query's shape and what
 * goes in `Destination`.
 *
 *   tv                  — one account number. Query by it, pay to it.
 *   meter-by-phone      — ECG. Query by MSISDN, which returns every meter linked to
 *                         that number; pay to the MSISDN with the chosen meter in
 *                         Extradata.bundle.
 *   meter-with-session  — Ghana Water. Query by meter + MSISDN, which returns a
 *                         single-use sessionId that the payment must carry.
 */
export type UtilityKind = 'tv' | 'meter-by-phone' | 'meter-with-session'

export interface UtilityServiceDef {
    id: string
    label: string
    kind: UtilityKind
    /** Field label shown on the form for the account/meter input. */
    accountLabel: string
    /** What a valid account number looks like. Kept loose — providers change formats. */
    accountPattern: RegExp
    accountHint: string
    /** Ghana Water needs the customer's phone AND meter to query. */
    requiresPhone: boolean
    /** Ghana Water rejects a payment with no email. */
    requiresEmail: boolean
}

export const UTILITY_SERVICES = {
    dstv: {
        id: '297a96656b5846ad8b00d5d41b256ea7',
        label: 'DSTV',
        kind: 'tv',
        accountLabel: 'DSTV Smartcard / IUC Number',
        accountPattern: /^\d{8,15}$/,
        accountHint: 'The 10-digit number on your decoder or your last bill.',
        requiresPhone: false,
        requiresEmail: false,
    },
    gotv: {
        id: 'e6ceac7f3880435cb30b048e9617eb41',
        label: 'GOtv',
        kind: 'tv',
        accountLabel: 'GOtv IUC Number',
        accountPattern: /^\d{8,15}$/,
        accountHint: 'The 10-digit IUC number on your GOtv decoder.',
        requiresPhone: false,
        requiresEmail: false,
    },
    startimes: {
        id: '6598652d34ea4112949c93c079c501ce',
        label: 'StarTimes',
        kind: 'tv',
        accountLabel: 'StarTimes Account Number',
        accountPattern: /^\d{8,15}$/,
        accountHint: 'The account number on your StarTimes decoder.',
        requiresPhone: false,
        requiresEmail: false,
    },
    ecg: {
        id: 'e6d6bac062b5499cb1ece1ac3d742a84',
        label: 'ECG Prepaid',
        kind: 'meter-by-phone',
        accountLabel: 'Meter Number',
        // ECG meters are digits, sometimes with a leading letter (G131099826).
        accountPattern: /^[A-Za-z]?\d{6,15}$/,
        accountHint: 'Type it, or pick one of the meters on your ECG Power App number.',
        requiresPhone: true,
        requiresEmail: false,
    },
    ghanawater: {
        id: '6c1e8a82d2e84feeb8bfd6be2790d71d',
        label: 'Ghana Water',
        kind: 'meter-with-session',
        accountLabel: 'Ghana Water Meter Number',
        accountPattern: /^\d{6,20}$/,
        accountHint: 'The meter/account number on your Ghana Water bill.',
        requiresPhone: true,
        requiresEmail: true,
    },
} as const satisfies Record<string, UtilityServiceDef>

export type UtilityService = keyof typeof UTILITY_SERVICES

export const UTILITY_SERVICE_KEYS = Object.keys(UTILITY_SERVICES) as UtilityService[]

export function isUtilityService(value: unknown): value is UtilityService {
    return typeof value === 'string' && value in UTILITY_SERVICES
}

/**
 * Resolves what goes in Hubtel's `Destination` for this service.
 *
 * Pay-TV pays the account itself. ECG and Ghana Water pay the customer's MSISDN and
 * name the meter in Extradata — the sample requests in the integration guide send a
 * phone number there even though Ghana Water's parameter table calls it the meter
 * number, and the sample is what the live API accepts.
 */
export function resolveDestination(
    service: UtilityService,
    accountNumber: string,
    phone?: string | null
): string {
    if (UTILITY_SERVICES[service].kind === 'tv') return accountNumber.trim()
    if (!phone) {
        throw new Error(`[HubtelUtility] ${UTILITY_SERVICES[service].label} requires a customer phone number.`)
    }
    return toHubtelMsisdn(phone)
}

// ─── Circuit Breaker ──────────────────────────────────────────────────────────
// Same shape and constants as the airtime client. Trips only on transport failures
// and 5xx — a business rejection (unknown meter, no funds) is a per-order fact and
// must not stop the next customer being served.
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
        console.log('[HubtelUtility] Circuit breaker OPENED')
    }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getPrepaidAccount(): string {
    const account = process.env.HUBTEL_PREPAID_ACCOUNT_NUMBER
    if (!account) {
        throw new Error('[HubtelUtility] HUBTEL_PREPAID_ACCOUNT_NUMBER is not configured.')
    }
    return account
}

function getUtilityAuthHeader(): string {
    // Commission Services is one product; utilities share the airtime key.
    return buildHubtelBasicAuth(
        process.env.HUBTEL_AIRTIME_CLIENT_ID || process.env.HUBTEL_CLIENT_ID,
        process.env.HUBTEL_AIRTIME_CLIENT_SECRET || process.env.HUBTEL_CLIENT_SECRET,
        'HUBTEL_AIRTIME_CLIENT_ID/SECRET (or HUBTEL_CLIENT_ID/SECRET)',
        'HubtelUtility'
    )
}

/** Rounds to pesewas without the float drift `toFixed` alone leaves behind. */
function round2(n: number): number {
    return Math.round((n + Number.EPSILON) * 100) / 100
}

/**
 * Strips everything outside printable ASCII.
 *
 * A non-ASCII character anywhere in a Hubtel request body makes undici throw
 * `terminated` — AFTER the transaction has gone live at Hubtel. It reads like a
 * proxy fault and is not one. Customer names and emails are the fields that carry
 * accents here, so every string we forward goes through this.
 */
function asciiOnly(value: string | null | undefined, max = 120): string {
    return String(value ?? '')
        .replace(/[^\x20-\x7E]/g, '')
        .trim()
        .slice(0, max)
}

/** Case- and space-insensitive match on the Display key Hubtel returns. */
function findDisplay(rows: UtilityDetailRow[], ...keys: string[]): UtilityDetailRow | undefined {
    const wanted = keys.map(k => k.toLowerCase().replace(/\s+/g, ''))
    return rows.find(r => wanted.includes(String(r.display).toLowerCase().replace(/\s+/g, '')))
}

// ─── Account Query ────────────────────────────────────────────────────────────

export interface UtilityDetailRow {
    display: string
    value: string
    amount: number
}

export interface UtilityMeter {
    /** What the provider calls it, e.g. "THOMAS ANANE (G131099826)". */
    label: string
    meterNumber: string
    /** Outstanding balance where the provider reports one. Negative = in credit. */
    balance: number
}

export interface UtilityQueryResult {
    success: boolean
    /** The customer name the provider has on file. Absent means "do not charge". */
    accountName?: string
    /** Outstanding balance where the provider reports one. */
    amountDue?: number
    /** Ghana Water only. Single-use — spend it on the payment that follows. */
    sessionId?: string
    /** ECG only: every meter linked to the queried MSISDN. */
    meters?: UtilityMeter[]
    /** Everything the provider returned, for display and for the order record. */
    details?: UtilityDetailRow[]
    responseCode?: string
    error?: string
}

export interface UtilityQueryParams {
    service: UtilityService
    /** Account / smartcard / meter. Not used by ECG, which queries by phone. */
    accountNumber?: string
    /** Required for ECG and Ghana Water. */
    phone?: string
}

/**
 * Turns one query response into the shape the rest of the app uses.
 *
 * Pure and exported so the three different response shapes can be checked against
 * the samples in Hubtel's integration guide without touching the network —
 * scripts/check-utility-normalizer.ts does exactly that. Getting ECG's
 * `Display: " THOMAS ANANE (G131099826)"` or Ghana Water's sessionId wrong is a
 * failure that only shows up mid-payment otherwise.
 */
export function normalizeUtilityQueryResponse(service: UtilityService, data: any): UtilityQueryResult {
    const def = UTILITY_SERVICES[service]
    const responseCode = String(data?.ResponseCode ?? '')

    if (responseCode !== '0000') {
        return {
            success: false,
            responseCode: responseCode || undefined,
            error: data?.Message || `That ${def.accountLabel} could not be found.`,
        }
    }

    const rows: UtilityDetailRow[] = Array.isArray(data?.Data)
        ? data.Data.map((row: any) => ({
            display: String(row?.Display ?? '').trim(),
            value: String(row?.Value ?? '').trim(),
            amount: Number(row?.Amount ?? 0) || 0,
        }))
        : []

    // ── ECG: the Data array IS the meter list ────────────────────────────────
    // Each row is one meter: Display " THOMAS ANANE (G131099826)", Value the bare
    // meter number, Amount the balance (negative when in credit).
    if (def.kind === 'meter-by-phone') {
        const meters: UtilityMeter[] = rows
            .filter(r => r.value)
            .map(r => ({ label: r.display || r.value, meterNumber: r.value, balance: r.amount }))

        if (meters.length === 0) {
            return { success: false, error: 'No ECG meters are linked to that phone number.' }
        }

        // The name is inside the display label — "NAME (METER)". Only used for the
        // receipt; the meter number is what actually identifies the account.
        const nameMatch = /^(.*?)\s*\(/.exec(meters[0].label)

        return {
            success: true,
            accountName: (nameMatch?.[1] || meters[0].label).trim() || undefined,
            meters,
            details: rows,
            responseCode,
        }
    }

    // ── Pay-TV and Ghana Water: keyed rows ───────────────────────────────────
    const name = findDisplay(rows, 'name')?.value
    const dueRow = findDisplay(rows, 'amountDue', 'amount due')
    const sessionId = findDisplay(rows, 'sessionId', 'session id')?.value

    if (!name) {
        return { success: false, error: `That ${def.accountLabel} could not be verified.`, details: rows, responseCode }
    }

    if (def.kind === 'meter-with-session' && !sessionId) {
        // Without it the payment is guaranteed to fail, and failing here costs
        // nothing while failing there costs a support ticket.
        return { success: false, error: 'Ghana Water did not return a session for that meter. Please try again.', details: rows, responseCode }
    }

    const amountDue = dueRow
        ? (dueRow.amount || Number(String(dueRow.value).replace(/[^\d.-]/g, '')) || 0)
        : undefined

    return {
        success: true,
        accountName: name,
        amountDue,
        sessionId: sessionId || undefined,
        details: rows,
        responseCode,
    }
}

/**
 * Resolves an account number to the customer's details.
 *
 * Read-only and free — no value moves — so unlike the payment call this one is safe
 * to make more than once. Callers MUST run it server-side immediately before
 * charging rather than trusting what the browser looked up earlier: it is the only
 * thing standing between a mistyped digit and a stranger's bill, and for Ghana Water
 * it is where the single-use sessionId comes from.
 */
export async function queryUtilityAccount(params: UtilityQueryParams): Promise<UtilityQueryResult> {
    const { service, accountNumber, phone } = params
    const def = UTILITY_SERVICES[service]

    if (!def) return { success: false, error: `Unknown utility service: ${service}` }

    if (!checkCircuit()) {
        console.warn(`[HubtelUtility] Circuit breaker OPEN — ${service} query not sent.`)
        return { success: false, error: 'Bill payment provider temporarily unavailable. Please try again shortly.' }
    }

    try {
        const account = getPrepaidAccount()
        const authHeader = getUtilityAuthHeader()

        // Each kind asks a different question, so each builds its own query string.
        const query = new URLSearchParams()
        if (def.kind === 'meter-by-phone') {
            if (!phone) return { success: false, error: 'A phone number is required to look up ECG meters.' }
            query.set('destination', toHubtelMsisdn(phone))
        } else if (def.kind === 'meter-with-session') {
            if (!accountNumber) return { success: false, error: `A ${def.accountLabel} is required.` }
            if (!phone) return { success: false, error: 'A phone number is required for Ghana Water.' }
            query.set('destination', accountNumber.trim())
            query.set('mobile', toHubtelMsisdn(phone))
        } else {
            if (!accountNumber) return { success: false, error: `A ${def.accountLabel} is required.` }
            query.set('destination', accountNumber.trim())
        }

        const url = `${HUBTEL_CS_BASE_URL}/${account}/${def.id}?${query.toString()}`

        const response = await fetch(url, {
            method: 'GET',
            headers: {
                Authorization: authHeader,
                Accept: 'application/json',
                'Content-Type': 'application/json',
                'Cache-Control': 'no-cache',
            },
            signal: AbortSignal.timeout(20_000),
            // @ts-ignore — undici dispatcher for static IP routing
            dispatcher: getDispatcher(),
        })

        const responseText = await response.text()
        let data: any
        try {
            data = JSON.parse(responseText)
        } catch {
            // Hubtel serves an HTML error page when the caller's IP is not whitelisted,
            // so an unparseable body is a config signal, not a blip.
            console.error('[HubtelUtility] Unparseable query response. Status:', response.status)
            console.error('[HubtelUtility] Raw response:', responseText.substring(0, 500))
            if (response.status >= 500) recordFailure()
            return {
                success: false,
                error: `Hubtel returned an invalid response (HTTP ${response.status}). This usually means the static proxy IP is not whitelisted for the prepaid account.`,
            }
        }

        // A 5xx is the provider being unwell; a business rejection ("no such meter")
        // is not, and must not push the breaker towards opening for everyone else.
        if (response.status >= 500) recordFailure()
        else recordSuccess()

        return normalizeUtilityQueryResponse(service, data)
    } catch (err: any) {
        recordFailure()
        return { success: false, error: describeHubtelNetworkFailure(err, 'queryUtilityAccount', 'HubtelUtility') }
    }
}

// ─── Bill Payment ─────────────────────────────────────────────────────────────

export interface UtilityPaymentParams {
    service: UtilityService
    /** Already resolved via resolveDestination(). */
    destination: string
    /** GHS. */
    amount: number
    /** Our idempotency key, echoed back on the callback. */
    clientReference: string
    /** Meter number for ECG and Ghana Water. */
    meterNumber?: string | null
    /** Ghana Water only, mandatory there. */
    email?: string | null
    /** Ghana Water only. Must be the sessionId from a fresh server-side query. */
    sessionId?: string | null
}

export interface UtilityPaymentResult {
    success: boolean
    /** True when Hubtel accepted it but the final state arrives on the callback. */
    pending: boolean
    transactionId?: string
    commission?: number
    responseCode?: string
    message?: string
    error?: string
    raw?: unknown
}

/**
 * Pays ONE utility bill.
 *
 * No retry loop, for the same reason the airtime client has none: a payment that
 * timed out may already have settled at the provider, and sending it again pays the
 * bill twice with no way to claw it back. One attempt per order; the reconciliation
 * cron surfaces anything left in limbo.
 */
export async function payUtilityBill(params: UtilityPaymentParams): Promise<UtilityPaymentResult> {
    const { service, destination, amount, clientReference, meterNumber, email, sessionId } = params
    const def = UTILITY_SERVICES[service]

    if (!def) return { success: false, pending: false, error: `Unknown utility service: ${service}` }

    if (!checkCircuit()) {
        console.warn(`[HubtelUtility] Circuit breaker OPEN — ${clientReference} not sent.`)
        return { success: false, pending: false, error: 'Bill payment provider temporarily unavailable (circuit open)' }
    }

    if (!(amount > 0)) {
        return { success: false, pending: false, error: `Invalid bill amount (${amount})` }
    }

    // Fail before the call rather than letting the provider reject it — a rejection
    // is indistinguishable at a glance from "the account does not exist".
    if (def.kind !== 'tv' && !meterNumber) {
        return { success: false, pending: false, error: `${def.label} requires a meter number.` }
    }
    if (def.requiresEmail && !email) {
        return { success: false, pending: false, error: `${def.label} requires the customer's email address.` }
    }
    if (def.kind === 'meter-with-session' && !sessionId) {
        return { success: false, pending: false, error: `${def.label} requires a session ID from a fresh account query.` }
    }

    let payloadForLog: Record<string, unknown> | null = null

    try {
        const account = getPrepaidAccount()
        const authHeader = getUtilityAuthHeader()

        const payload: Record<string, unknown> = {
            Destination: destination,
            Amount: round2(amount),
            CallbackUrl: `${webhookBaseUrl()}/api/webhooks/hubtel-utility`,
            ClientReference: clientReference,
        }

        // Hubtel spells this key "Extradata" (lowercase d) in every sample request.
        if (def.kind === 'meter-by-phone') {
            payload.Extradata = { bundle: asciiOnly(meterNumber, 40) }
        } else if (def.kind === 'meter-with-session') {
            payload.Extradata = {
                bundle: asciiOnly(meterNumber, 40),
                Email: asciiOnly(email, 80),
                SessionId: asciiOnly(sessionId, 120),
            }
        }

        payloadForLog = payload

        console.log('[HubtelUtility] Sending bill payment:', {
            service,
            amount: payload.Amount,
            destination,
            meter: meterNumber ?? null,
            ref: clientReference,
        })

        const response = await fetch(`${HUBTEL_CS_BASE_URL}/${account}/${def.id}`, {
            method: 'POST',
            headers: {
                Authorization: authHeader,
                'Content-Type': 'application/json',
                Accept: 'application/json',
                'Cache-Control': 'no-cache',
            },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(20_000),
            // @ts-ignore — undici dispatcher for static IP routing
            dispatcher: getDispatcher(),
        })

        const responseText = await response.text()
        let data: any
        try {
            data = JSON.parse(responseText)
        } catch {
            console.error('[HubtelUtility] Unparseable response. Status:', response.status)
            console.error('[HubtelUtility] Raw response:', responseText.substring(0, 500))
            if (response.status >= 500) recordFailure()
            return {
                success: false,
                pending: false,
                error: `Hubtel returned an invalid response (HTTP ${response.status}). This usually means the static proxy IP is not whitelisted for the prepaid account.`,
                raw: { request: payload, responseText: responseText.substring(0, 1000) },
            }
        }

        console.log('[HubtelUtility] API response:', JSON.stringify(sanitizeForLog(data)))

        const responseCode = String(data?.ResponseCode ?? '')

        // Codes that mean "Hubtel has taken this on", not "settled".
        //
        // 0000 — settled synchronously, no callback follows.
        // 0001 — accepted, callback follows.
        // 4075 — accepted, callback follows. Undocumented, but what the live API
        //        actually returns. Treating it as a rejection on the airtime path
        //        told an admin to re-send value Hubtel was already delivering.
        //
        // Anything unrecognised stays a rejection: for irreversible value, guessing
        // that an unknown code means success is the one mistake with no way back.
        const ACCEPTED_PENDING = new Set(['0001', '4075'])

        if (responseCode === '0000' || ACCEPTED_PENDING.has(responseCode)) {
            recordSuccess()
            const commissionRaw = data?.Data?.Meta?.Commission
            const commission = commissionRaw != null ? Number(commissionRaw) : undefined
            return {
                success: true,
                pending: ACCEPTED_PENDING.has(responseCode),
                transactionId: data?.Data?.TransactionId,
                commission: Number.isFinite(commission) ? commission : undefined,
                responseCode,
                message: data?.Message ?? undefined,
                raw: { request: payload, response: data },
            }
        }

        if (response.status >= 500) recordFailure()

        return {
            success: false,
            pending: false,
            responseCode: responseCode || undefined,
            message: data?.Message ?? undefined,
            error: data?.Message || `Hubtel rejected the bill payment (HTTP ${response.status}, code ${responseCode || 'none'})`,
            raw: { request: payload, response: data },
        }
    } catch (err: any) {
        recordFailure()
        const error = describeHubtelNetworkFailure(err, 'payUtilityBill', 'HubtelUtility')
        return {
            success: false,
            pending: false,
            error,
            raw: {
                error: String(err?.message || err),
                code: err?.cause?.code ?? err?.code ?? null,
                cause: String(err?.cause?.message ?? err?.cause ?? ''),
                request: payloadForLog,
            },
        }
    }
}
