/**
 * Hubtel Commission Services — Airtime Top-Up
 *
 * Delivers airtime value to MTN, Telecel and AT numbers. This is the OUTBOUND
 * counterpart to lib/hubtel-payment-service.ts: that one collects money from a
 * customer, this one spends money out of the prepaid/commission account.
 *
 * API Docs: https://developers.hubtel.com/docs/business/api_documentation/commission_services
 *
 * Uses:
 *   HUBTEL_PREPAID_ACCOUNT_NUMBER — the disbursement account. This is a DIFFERENT
 *                                   number from HUBTEL_COLLECTION_ACCOUNT_NUMBER,
 *                                   and it must be funded or every call fails.
 *   HUBTEL_AIRTIME_CLIENT_ID      — optional; falls back to HUBTEL_CLIENT_ID
 *   HUBTEL_AIRTIME_CLIENT_SECRET  — optional; falls back to HUBTEL_CLIENT_SECRET
 *   FIXIE_URL                     — the same static-IP proxy the collection API needs.
 *                                   Commission Services is IP-whitelisted too, so the
 *                                   Fixie IP must be whitelisted for the PREPAID account
 *                                   as well, not just the collection one.
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

/**
 * Hubtel's hard per-request ceiling. Anything larger is rejected outright, which
 * is why callers must go through splitAirtimeAmount() rather than sending a total.
 */
export const HUBTEL_AIRTIME_MAX_PER_REQUEST = 100

/** Below this Hubtel will not move value, so a split must never produce a smaller leg. */
export const HUBTEL_AIRTIME_MIN_PER_REQUEST = 0.5

/** One service ID per telco — the last path segment of the endpoint. */
export const HUBTEL_AIRTIME_SERVICE_IDS: Record<string, string> = {
    MTN: 'fdd76c884e614b1c8f669a3207b09a98',
    Telecel: 'f4be83ad74c742e185224fdae1304800',
    AT: 'dae2142eb5a14c298eace60240c09e4b',
}

export type AirtimeNetwork = keyof typeof HUBTEL_AIRTIME_SERVICE_IDS

export interface AirtimeTopUpParams {
    network: string
    /** Beneficiary number in any Ghanaian format; normalised to 233XXXXXXXXX here. */
    phone: string
    /** GHS, must already be <= HUBTEL_AIRTIME_MAX_PER_REQUEST. */
    amount: number
    /** Our idempotency key, echoed back on the callback. */
    clientReference: string
}

export interface AirtimeTopUpResult {
    success: boolean
    /** True when Hubtel accepted it but the final state arrives on the callback ('0001'). */
    pending: boolean
    transactionId?: string
    commission?: number
    responseCode?: string
    message?: string
    error?: string
    raw?: unknown
}

// ─── Circuit Breaker ──────────────────────────────────────────────────────────
// Same shape and constants as lib/netpulse-service.ts. It only ever trips on
// transport failures and 5xx — a business rejection (bad number, no funds) is a
// per-order fact and must not stop us trying the next order.
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
        console.log('[HubtelAirtime] Circuit breaker OPENED')
    }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getPrepaidAccount(): string {
    const account = process.env.HUBTEL_PREPAID_ACCOUNT_NUMBER
    if (!account) {
        throw new Error('[HubtelAirtime] HUBTEL_PREPAID_ACCOUNT_NUMBER is not configured.')
    }
    return account
}

function getAirtimeAuthHeader(): string {
    // Separate airtime credentials are optional — most merchants use one API key
    // for both collections and commission services.
    return buildHubtelBasicAuth(
        process.env.HUBTEL_AIRTIME_CLIENT_ID || process.env.HUBTEL_CLIENT_ID,
        process.env.HUBTEL_AIRTIME_CLIENT_SECRET || process.env.HUBTEL_CLIENT_SECRET,
        'HUBTEL_AIRTIME_CLIENT_ID/SECRET (or HUBTEL_CLIENT_ID/SECRET)',
        'HubtelAirtime'
    )
}

/** Rounds to pesewas without the float drift that `toFixed` alone leaves behind. */
function round2(n: number): number {
    return Math.round((n + Number.EPSILON) * 100) / 100
}

/**
 * Breaks a total into legs Hubtel will actually accept.
 *
 * Naively chunking by 100 leaves a remainder that can fall under Hubtel's minimum
 * — GHS 100.30 would become [100, 0.30], and that second leg is rejected, leaving
 * the customer with a partially delivered order for an amount that could have gone
 * out in one clean pair. So when the tail is too small we take from the previous
 * leg to even the last two out: [50.15, 50.15].
 *
 * Totals below the minimum are returned as a single leg and left for the caller to
 * reject — this function does not decide what is sellable, only how to divide it.
 */
export function splitAirtimeAmount(total: number): number[] {
    const amount = round2(total)
    if (!(amount > 0)) return []
    if (amount <= HUBTEL_AIRTIME_MAX_PER_REQUEST) return [amount]

    const legs: number[] = []
    let remaining = amount
    while (remaining > HUBTEL_AIRTIME_MAX_PER_REQUEST) {
        legs.push(HUBTEL_AIRTIME_MAX_PER_REQUEST)
        remaining = round2(remaining - HUBTEL_AIRTIME_MAX_PER_REQUEST)
    }
    if (remaining > 0) legs.push(remaining)

    // Rebalance an undersized tail against the leg before it.
    const last = legs.length - 1
    if (legs.length > 1 && legs[last] < HUBTEL_AIRTIME_MIN_PER_REQUEST) {
        const pooled = round2(legs[last - 1] + legs[last])
        const half = round2(pooled / 2)
        legs[last - 1] = half
        legs[last] = round2(pooled - half)
    }

    return legs
}

// ─── Top-Up ───────────────────────────────────────────────────────────────────

/**
 * Sends ONE airtime top-up leg.
 *
 * Deliberately has no retry loop, unlike the data suppliers. A top-up that timed
 * out may still have landed on the handset; retrying it would send the value twice
 * with no way to claw it back. One attempt per leg row, and the reconciliation cron
 * surfaces anything left in limbo.
 */
export async function topUpAirtime(params: AirtimeTopUpParams): Promise<AirtimeTopUpResult> {
    const { network, phone, amount, clientReference } = params

    if (!checkCircuit()) {
        console.warn(`[HubtelAirtime] Circuit breaker OPEN — ${clientReference} not sent.`)
        return { success: false, pending: false, error: 'Airtime provider temporarily unavailable (circuit open)' }
    }

    const serviceId = HUBTEL_AIRTIME_SERVICE_IDS[network]
    if (!serviceId) {
        return { success: false, pending: false, error: `Unsupported airtime network: ${network}` }
    }

    if (!(amount > 0) || amount > HUBTEL_AIRTIME_MAX_PER_REQUEST) {
        return {
            success: false,
            pending: false,
            error: `Airtime leg must be between 0 and GHS ${HUBTEL_AIRTIME_MAX_PER_REQUEST} (got ${amount})`,
        }
    }

    let payloadForLog: Record<string, unknown> | null = null

    try {
        const account = getPrepaidAccount()
        const authHeader = getAirtimeAuthHeader()

        const payload = {
            Destination: toHubtelMsisdn(phone),
            Amount: round2(amount),
            CallbackUrl: `${webhookBaseUrl()}/api/webhooks/hubtel-airtime`,
            ClientReference: clientReference,
        }
        payloadForLog = payload

        console.log('[HubtelAirtime] Sending top-up:', {
            network,
            amount: payload.Amount,
            destination: payload.Destination,
            ref: clientReference,
        })

        const response = await fetch(`${HUBTEL_CS_BASE_URL}/${account}/${serviceId}`, {
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
            // Hubtel serves an HTML error page when the caller's IP is not
            // whitelisted, so an unparseable body is a config signal, not a blip.
            console.error('[HubtelAirtime] Unparseable response. Status:', response.status)
            console.error('[HubtelAirtime] Raw response:', responseText.substring(0, 500))
            if (response.status >= 500) recordFailure()
            return {
                success: false,
                pending: false,
                error: `Hubtel returned an invalid response (HTTP ${response.status}). This usually means the static proxy IP is not whitelisted for the prepaid account.`,
                raw: { request: payload, responseText: responseText.substring(0, 1000) },
            }
        }

        console.log('[HubtelAirtime] API response:', JSON.stringify(sanitizeForLog(data)))

        const responseCode = String(data?.ResponseCode ?? '')

        // Codes that mean "Hubtel has taken this on", not "delivered".
        //
        // 0000 — delivered synchronously, no callback follows.
        // 0001 — accepted, callback follows.
        // 4075 — accepted, callback follows. Undocumented in the integration guide
        //        but what the live API actually returns ("Transaction pending.
        //        Expect callback request for final state."). Treating it as a
        //        rejection told an admin to re-send airtime Hubtel was already
        //        delivering, which is a double credit that cannot be recalled.
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
            error: data?.Message || `Hubtel rejected the top-up (HTTP ${response.status}, code ${responseCode || 'none'})`,
            raw: { request: payload, response: data },
        }
    } catch (err: any) {
        recordFailure()
        const error = describeHubtelNetworkFailure(err, 'topUpAirtime', 'HubtelAirtime')
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
