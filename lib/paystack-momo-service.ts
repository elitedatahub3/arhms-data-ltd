/**
 * Paystack Mobile Money — the Charge API client for direct MoMo collection.
 *
 * The `paystack` provider means `transaction/initialize` plus a hosted checkout page
 * the browser is redirected to. `paystack_momo` means this: we debit the handset
 * directly and the customer approves on their phone, with no page to redirect to.
 * That distinction is what lib/payment-provider.ts encodes — see
 * HOSTED_REDIRECT_PROVIDERS, which lists only the former.
 *
 * This module is the thin HTTP layer and nothing else. The orchestration around a
 * charge — prompt limits, audit logging, pending markers, response shaping — lives
 * in lib/paystack-momo-checkout.ts, which is Node-only. Two modules, because of the
 * constraint below.
 *
 * Uses:
 *   PAYSTACK_SECRET_KEY — the same secret key the hosted-checkout flow already uses
 *
 * EDGE-SAFE ON PURPOSE. app/api/hubtel/interact/route.ts runs on the edge runtime,
 * so nothing here may import undici — that means no `getDispatcher()` and no
 * `Agent`, unlike lib/payswitch-payment-service.ts and lib/hubtel-payment-service.ts.
 * It also rules out Redis and the hubtel-* helpers, which is precisely why the
 * orchestration layer is a separate file: pulling any of it in here takes USSD down.
 * Paystack does not whitelist by IP, so the static proxy would buy nothing and would
 * spend metered Fixie quota that Hubtel's collections depend on.
 *
 * Docs: https://paystack.com/docs/api/charge/
 */

/** Charge API base. No trailing slash — every path below starts with one. */
const PAYSTACK_BASE_URL = 'https://api.paystack.co'

/**
 * Default ceiling on a charge or OTP call.
 *
 * The USSD confirm screen has to answer Hubtel inside ~10s or the session is torn
 * down, and the rest of that budget is already spoken for. Six seconds is the most
 * this call can have while leaving room to build a response. USSD callers pass no
 * override and so keep exactly this budget.
 */
const CHARGE_TIMEOUT_MS = 6_000

/**
 * What a browser-facing route should pass as `timeoutMs`.
 *
 * A web checkout has no USSD session to answer, so it would rather wait than
 * resolve as 'pending' something it could have resolved as 'otp' — a premature
 * 'pending' costs the customer a poll cycle and hides the OTP prompt they are
 * waiting for.
 */
export const WEB_CHARGE_TIMEOUT_MS = 20_000

/** The reconciliation cron has no USSD session waiting on it, so it can afford more. */
const VERIFY_TIMEOUT_MS = 15_000

/**
 * Every spelling of a Ghanaian network any ARHMS surface emits -> Paystack's
 * `mobile_money.provider` code. The single source of truth for that mapping.
 *
 * Two vocabularies have to meet here. The checkout forms post 'AT' for AirtelTigo,
 * because their options were written against HUBTEL_CHANNEL_MAP /
 * MOOLRE_PAYMENT_CHANNEL_MAP / PAYSWITCH_CHANNEL_MAP, which all key it that way.
 * detectNetwork() spells the same network 'AirtelTigo'. Before this table the two
 * were reconciled by a copy of the bridge pasted into each caller, and any caller
 * that forgot got `undefined` for AirtelTigo — a network that silently stops
 * working is worse than one that visibly fails, so there is now one table and one
 * resolver.
 *
 * 'vod' is Paystack's code for what Ghana now calls Telecel — they never renamed it.
 */
const NETWORK_ALIASES: Record<string, string> = {
    mtn: 'mtn',
    telecel: 'vod',
    vodafone: 'vod',
    vod: 'vod',
    airteltigo: 'atl',
    'airtel-tigo': 'atl',
    at: 'atl',
    atl: 'atl',
    airtel: 'atl',
    tigo: 'atl',
    'at-ishare': 'atl',
    'at-bigtime': 'atl',
}

/**
 * Resolves any network spelling to a Paystack provider code, or null.
 *
 * Null means "we do not know which wallet to debit" and must surface as a 400.
 * Guessing is not an option: charging the wrong provider fails at best and debits
 * an unexpected wallet at worst.
 */
export function paystackMomoProviderFor(network: string | null | undefined): string | null {
    const key = String(network ?? '').trim().toLowerCase().replace(/\s+/g, '')
    return NETWORK_ALIASES[key] ?? null
}

/**
 * The canonical detectNetwork() spellings, kept as a map for resolvePayerProvider().
 * Derived from NETWORK_ALIASES so the two can never disagree.
 */
export const PAYSTACK_MOMO_PROVIDER_MAP: Record<string, string> = {
    MTN: NETWORK_ALIASES.mtn,
    Telecel: NETWORK_ALIASES.telecel,
    AirtelTigo: NETWORK_ALIASES.airteltigo,
}

export type PaystackChargeOutcome = 'paid' | 'pending' | 'otp' | 'failed'

export interface PaystackChargeResult {
    outcome: PaystackChargeOutcome
    /** Paystack's own words for the customer — surfaced on the USSD screen when it fits. */
    displayText: string | null
    reference: string
    /** Paystack's raw `data.status`, kept for the log row. */
    rawStatus: string | null
    message: string | null
    raw: unknown
}

/**
 * Fails fast with the exact missing variable names.
 *
 * Same stance as getPayswitchConfigError(): checked BEFORE the fetch, because an
 * unset key otherwise surfaces to the customer as an unexplained network error and
 * to us as a stack trace that names undici rather than the real problem.
 */
export function getPaystackConfigError(): string | null {
    if (!process.env.PAYSTACK_SECRET_KEY) {
        return 'Missing env var(s): PAYSTACK_SECRET_KEY'
    }
    return null
}

function authHeaders(): Record<string, string> {
    return {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
    }
}

/**
 * Strips anything outside printable ASCII.
 *
 * A duplicate of toHubtelSafeText()/toPayswitchSafeText() rather than an import,
 * because both of those live in modules that pull in undici and would break the
 * edge build of the interact route. The lesson behind all three is the same: a
 * multi-byte character in an outbound payment field once made the request throw
 * `TypeError: terminated` AFTER the customer had already been charged.
 */
export function toAsciiSafe(value: string | null | undefined, fallback: string): string {
    const cleaned = String(value ?? '')
        .replace(/[^\x20-\x7E]/g, '')
        .trim()
    return cleaned || fallback
}

/**
 * Folds every string leaf of an outbound payload through toAsciiSafe().
 *
 * Applied inside chargeMobileMoney() rather than left to callers on purpose. The
 * failure it prevents is the worst shape a payment bug takes — a multi-byte
 * character (a storefront shop name joined with an em dash, say) makes the request
 * throw `TypeError: terminated` AFTER the charge has landed, so the money moves and
 * nothing is delivered. Opt-in protection means every one of the callers has to
 * remember; folding here means none of them can forget.
 *
 * Depth-capped because metadata is caller-supplied and a cycle would hang the
 * request. Three levels is past anything the checkout routes send.
 */
function sanitizeMetadata(value: unknown, depth = 0): unknown {
    if (typeof value === 'string') return toAsciiSafe(value, '')
    if (value === null || typeof value === 'number' || typeof value === 'boolean') return value
    if (depth >= 3) return null
    if (Array.isArray(value)) return value.map((item) => sanitizeMetadata(item, depth + 1))
    if (typeof value === 'object') {
        const out: Record<string, unknown> = {}
        for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
            out[toAsciiSafe(key, '_')] = sanitizeMetadata(item, depth + 1)
        }
        return out
    }
    return null
}

/**
 * The synthetic email a USSD charge is booked against.
 *
 * Paystack requires an email on every charge and a USSD caller has no account —
 * they never signed up, they dialled a code. The MSISDN keeps it stable per
 * customer so Paystack's dashboard groups their charges instead of scattering them.
 */
export function ussdCustomerEmail(msisdn: string): string {
    const digits = String(msisdn || '').replace(/\D/g, '') || 'unknown'
    return `${digits}@ussd.arhmsgh.com`
}

/**
 * Resolves the PAYER's network — the person holding the handset, not the recipient.
 *
 * These are genuinely different and confusing them charges the wrong wallet: the
 * USSD `choose_network` step picks the network of the BUNDLE being bought, which is
 * routinely a different network from the one the caller is paying with.
 *
 * Hubtel's `Operator` on the initiation request is the authoritative answer; the
 * MSISDN prefix is the fallback when Hubtel sends nothing useful.
 */
export function resolvePayerProvider(
    hubtelOperator: string | null | undefined,
    payerMsisdn: string | null | undefined,
    detectNetwork: (phone: string) => string | null
): { provider: string | null; network: string | null } {
    const operator = String(hubtelOperator || '').toLowerCase()
    if (operator.includes('mtn')) return { provider: 'mtn', network: 'MTN' }
    // Hubtel still says "vodafone" on a network the country renamed to Telecel.
    if (operator.includes('vodafone') || operator.includes('telecel')) {
        return { provider: 'vod', network: 'Telecel' }
    }
    if (operator.includes('tigo') || operator.includes('airtel')) {
        return { provider: 'atl', network: 'AirtelTigo' }
    }

    const detected = payerMsisdn ? detectNetwork(payerMsisdn) : null
    if (detected && PAYSTACK_MOMO_PROVIDER_MAP[detected]) {
        return { provider: PAYSTACK_MOMO_PROVIDER_MAP[detected], network: detected }
    }

    // Better to ask than to guess: charging the wrong provider fails at best and
    // debits an unexpected wallet at worst.
    return { provider: null, network: null }
}

/**
 * Maps Paystack's `data.status` onto the four outcomes the USSD flow can act on.
 *
 * 'pay_offline' is the normal MTN answer — the prompt is on its way and the webhook
 * decides. 'send_otp' means the network wants a one-time code typed back, which is
 * why the state machine has an awaiting_otp step at all.
 */
function mapChargeStatus(status: string | null | undefined): PaystackChargeOutcome {
    switch (String(status || '').toLowerCase()) {
        case 'success':
            return 'paid'
        case 'send_otp':
            return 'otp'
        case 'pay_offline':
        case 'pending':
        case 'ongoing':
        case 'processing':
            return 'pending'
        default:
            return 'failed'
    }
}

/**
 * Turns a thrown fetch into something a human can act on.
 *
 * Modelled on describePayswitchNetworkFailure(): the distinction that matters is
 * between "Paystack refused us" and "we never reached Paystack", because only the
 * second one leaves a charge in an unknown state.
 */
export function describePaystackNetworkFailure(err: any, context: string): string {
    const name = String(err?.name || '')
    const code = String(err?.cause?.code || err?.code || '')
    const message = String(err?.message || '')

    if (name === 'TimeoutError' || name === 'AbortError' || /timeout/i.test(message)) {
        return `${context}: Paystack did not answer within the time limit (${code || name}).`
    }
    if (/fetch failed|terminated|socket|ECONN|ENOTFOUND|EAI_AGAIN/i.test(`${code} ${message}`)) {
        return `${context}: could not reach Paystack (${code || message}).`
    }
    return `${context}: ${message || 'unknown error'}`
}

/**
 * Debits a mobile money wallet.
 *
 * The customer is NOT charged synchronously. Paystack answers 'pay_offline' (or
 * 'send_otp'), pushes the approval to the handset, and the real outcome arrives at
 * the webhook — which is why every caller must treat a 'pending' return as "money
 * may yet move" and never as a failure.
 */
export async function chargeMobileMoney(params: {
    reference: string
    /** Gross GHS the customer sees. Converted to pesewas here — never pass pesewas in. */
    amountGhs: number
    payerMsisdn: string
    /** Paystack provider code: 'mtn' | 'vod' | 'atl'. */
    provider: string
    email?: string
    metadata?: Record<string, unknown>
    /** Defaults to the USSD session budget. Web routes pass WEB_CHARGE_TIMEOUT_MS. */
    timeoutMs?: number
}): Promise<PaystackChargeResult> {
    const configError = getPaystackConfigError()
    if (configError) {
        return failure(params.reference, configError)
    }

    const amountPesewas = Math.round(params.amountGhs * 100)
    if (!Number.isFinite(amountPesewas) || amountPesewas <= 0) {
        return failure(params.reference, `Refusing to charge a non-positive amount: ${params.amountGhs}`)
    }

    const body = {
        email: toAsciiSafe(params.email, '') || ussdCustomerEmail(params.payerMsisdn),
        // Paystack takes the minor unit. GHS 2.00 is 200 — sending 2 would charge
        // two pesewas and still report itself as a successful charge.
        amount: amountPesewas,
        currency: 'GHS',
        reference: params.reference,
        mobile_money: {
            phone: params.payerMsisdn,
            provider: params.provider,
        },
        metadata: sanitizeMetadata(params.metadata ?? {}),
    }

    try {
        const res = await fetch(`${PAYSTACK_BASE_URL}/charge`, {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(params.timeoutMs ?? CHARGE_TIMEOUT_MS),
        })

        const json: any = await res.json().catch(() => null)

        if (!json) {
            return failure(params.reference, `Paystack returned unreadable body (HTTP ${res.status}).`)
        }

        // `status: false` is Paystack refusing the request outright (bad key,
        // unsupported provider, duplicate reference).
        if (json.status === false) {
            const refusal = String(json.message || `Paystack refused the charge (HTTP ${res.status}).`)

            // A duplicate reference is the one refusal that does NOT mean "no
            // charge". It means a charge for this reference already exists — which
            // is exactly what the catch below leaves behind when a first attempt
            // times out and is reported as 'pending'. The customer retries, we send
            // the same reference, Paystack refuses it, and if we called that
            // 'failed' the route would stamp the row failed. The webhook's
            // pending-only guard (lib/payments.ts) can then never settle it, so
            // money that did move is delivered against nothing, and no sweep
            // recovers it. Report it as pending and let verify decide.
            if (/duplicate|already (exists|been)/i.test(refusal)) {
                return {
                    outcome: 'pending',
                    displayText: null,
                    reference: params.reference,
                    rawStatus: 'duplicate',
                    message: refusal,
                    raw: json,
                }
            }

            return {
                outcome: 'failed',
                displayText: null,
                reference: params.reference,
                rawStatus: null,
                message: refusal,
                raw: json,
            }
        }

        const data = json.data || {}
        return {
            outcome: mapChargeStatus(data.status),
            displayText: data.display_text ? String(data.display_text) : null,
            reference: String(data.reference || params.reference),
            rawStatus: data.status ? String(data.status) : null,
            message: data.message ? String(data.message) : null,
            raw: json,
        }
    } catch (err: any) {
        // Deliberately NOT reported as 'failed'. A timeout here means the request
        // may well have landed and the customer may still get a prompt; calling it
        // a failure is how you end up delivering nothing on money you took.
        return {
            outcome: 'pending',
            displayText: null,
            reference: params.reference,
            rawStatus: null,
            message: describePaystackNetworkFailure(err, 'charge'),
            raw: null,
        }
    }
}

/**
 * Submits the one-time code for a charge that answered 'send_otp'.
 * Telecel and AirtelTigo take this path more often than MTN.
 */
export async function submitOtp(params: {
    reference: string
    otp: string
    /** Defaults to the USSD session budget. Web routes pass WEB_CHARGE_TIMEOUT_MS. */
    timeoutMs?: number
}): Promise<PaystackChargeResult> {
    const configError = getPaystackConfigError()
    if (configError) {
        return failure(params.reference, configError)
    }

    try {
        const res = await fetch(`${PAYSTACK_BASE_URL}/charge/submit_otp`, {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({ otp: params.otp, reference: params.reference }),
            signal: AbortSignal.timeout(params.timeoutMs ?? CHARGE_TIMEOUT_MS),
        })

        const json: any = await res.json().catch(() => null)
        if (!json) {
            return failure(params.reference, `Paystack returned unreadable body (HTTP ${res.status}).`)
        }

        if (json.status === false) {
            return {
                outcome: 'failed',
                displayText: null,
                reference: params.reference,
                rawStatus: null,
                message: String(json.message || 'OTP rejected.'),
                raw: json,
            }
        }

        const data = json.data || {}
        return {
            outcome: mapChargeStatus(data.status),
            displayText: data.display_text ? String(data.display_text) : null,
            reference: String(data.reference || params.reference),
            rawStatus: data.status ? String(data.status) : null,
            message: data.message ? String(data.message) : null,
            raw: json,
        }
    } catch (err: any) {
        return {
            outcome: 'pending',
            displayText: null,
            reference: params.reference,
            rawStatus: null,
            message: describePaystackNetworkFailure(err, 'submit_otp'),
            raw: null,
        }
    }
}

export interface PaystackVerifyResult {
    outcome: PaystackChargeOutcome
    /** Gross pesewas Paystack actually collected. Authoritative over anything we stored. */
    amountPesewas: number | null
    rawStatus: string | null
    message: string | null
    raw: unknown
}

/**
 * Server-to-server truth for a reference. Used by the reconciliation cron for
 * charges that never produced a webhook, and safe to call repeatedly.
 */
export async function verifyTransaction(reference: string): Promise<PaystackVerifyResult> {
    const configError = getPaystackConfigError()
    if (configError) {
        return { outcome: 'failed', amountPesewas: null, rawStatus: null, message: configError, raw: null }
    }

    try {
        const res = await fetch(
            `${PAYSTACK_BASE_URL}/transaction/verify/${encodeURIComponent(reference)}`,
            {
                method: 'GET',
                headers: authHeaders(),
                signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
            }
        )

        const json: any = await res.json().catch(() => null)
        if (!json || json.status === false) {
            return {
                outcome: 'pending',
                amountPesewas: null,
                rawStatus: null,
                // Unknown, not failed: a 404 here can simply mean the charge has not
                // been booked yet. The cron will ask again.
                message: String(json?.message || `Verify returned HTTP ${res.status}.`),
                raw: json,
            }
        }

        const data = json.data || {}
        const status = String(data.status || '').toLowerCase()
        const outcome: PaystackChargeOutcome =
            status === 'success'
                ? 'paid'
                : status === 'failed' || status === 'abandoned' || status === 'reversed'
                    ? 'failed'
                    : 'pending'

        return {
            outcome,
            amountPesewas: typeof data.amount === 'number' ? data.amount : null,
            rawStatus: data.status ? String(data.status) : null,
            message: data.gateway_response ? String(data.gateway_response) : null,
            raw: json,
        }
    } catch (err: any) {
        return {
            outcome: 'pending',
            amountPesewas: null,
            rawStatus: null,
            message: describePaystackNetworkFailure(err, 'verify'),
            raw: null,
        }
    }
}

function failure(reference: string, message: string): PaystackChargeResult {
    return { outcome: 'failed', displayText: null, reference, rawStatus: null, message, raw: null }
}
