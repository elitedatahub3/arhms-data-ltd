/**
 * Hubtel Payment (Collection) Service
 *
 * Handles Direct Mobile Money prompt collections and status checking via the Hubtel API.
 * API Docs: https://developers.hubtel.com/docs/business/api_documentation/payment_apis/direct_receive_money
 *
 * Uses:
 *   HUBTEL_CLIENT_ID          — API ID (username) from Hubtel dashboard
 *   HUBTEL_CLIENT_SECRET      — API Key (password) from Hubtel dashboard
 *   HUBTEL_COLLECTION_ACCOUNT_NUMBER — Your Hubtel merchant collection account number
 *   HUBTEL_FEE_PERCENT        — Transaction fee percentage (default: 1.8)
 *   FIXIE_URL                 — Static proxy URL from usefixie.com (recommended).
 *                               Format: http://user:pass@criterium.usefixie.com:80
 *                               Get your URL + static IP at: https://usefixie.com
 *                               Whitelist the static IP in Hubtel Merchant Portal.
 *
 * Auth: Basic Auth (base64(CLIENT_ID:CLIENT_SECRET))
 */
import { logInitiate } from '@/lib/hubtel-payment-log'
import { getDispatcher } from '@/lib/http-dispatcher'
import { webhookBaseUrl } from './webhook-base-url'

const HUBTEL_RECEIVE_BASE_URL = 'https://rmp.hubtel.com/merchantaccount/merchants'
const HUBTEL_STATUS_BASE_URL = 'https://api-txnstatus.hubtel.com/transactions'

// The dispatcher moved to lib/http-dispatcher.ts so PaySwitch can share the same
// proxy connection pool. Re-exported because lib/hubtel-airtime-service.ts and
// app/api/hubtel/fulfill/route.ts already import it from here.
export { getDispatcher }

/** Maps the internal network label to Hubtel's channel name */
export const HUBTEL_CHANNEL_MAP: Record<string, string> = {
    'MTN': 'mtn-gh',
    'Telecel': 'vodafone-gh',
    'AT': 'tigo-gh',
}

/** Default transaction fee percentage charged to the payer */
export const HUBTEL_FEE_PERCENT = parseFloat(process.env.HUBTEL_FEE_PERCENT || '1.8')

export interface HubtelInitiateParams {
    /** Amount in GHS (e.g. 10.00) */
    amount: number
    /** Phone in international format, e.g. "233249111411" */
    payerPhone: string
    /** Hubtel channel name e.g. "mtn-gh" */
    channel: string
    /** Unique client reference (max 36 chars, alphanumeric preferred) */
    clientReference: string
    /** Optional payer name */
    customerName?: string
    /** Optional payer email */
    customerEmail?: string
    /** Description shown to customer */
    description?: string
    /** Optional owning user — recorded on the payment log so admins can trace the payer */
    userId?: string
}

export interface HubtelInitiateResult {
    success: boolean
    transactionId?: string
    status?: string
    error?: string
}

export interface HubtelStatusResult {
    success: boolean
    /** 'Paid' | 'Unpaid' | 'Refunded' | null */
    status: string | null
    /** Hubtel's own transaction ID */
    transactionId?: string
    /** The telco's reference — the number a customer quotes off their MoMo SMS */
    externalTransactionId?: string
    paymentMethod?: string
    amount?: number
    charges?: number
    amountAfterCharges?: number
    date?: string
    error?: string
    /** Full `data` object as returned, kept for the payment record */
    raw?: unknown
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Builds the Basic auth header from an explicit credential pair.
 *
 * Exported because Commission Services (airtime) may run on its own API key —
 * see lib/hubtel-airtime-service.ts. Both callers share this so the encoding and
 * the "not configured" failure look the same wherever the credentials come from.
 */
export function buildHubtelBasicAuth(
    clientId: string | undefined,
    clientSecret: string | undefined,
    // Named so the thrown error tells an operator exactly which vars to set,
    // rather than "a Hubtel credential" for one of two possible pairs.
    varNames = 'HUBTEL_CLIENT_ID or HUBTEL_CLIENT_SECRET',
    context = 'HubtelPayment'
): string {
    if (!clientId || !clientSecret) {
        throw new Error(`[${context}] ${varNames} is not configured.`)
    }

    const encoded = Buffer.from(`${clientId}:${clientSecret}`).toString('base64')
    return `Basic ${encoded}`
}

/** Basic auth for the collection (Receive Money) API. */
export function getHubtelAuthHeader(): string {
    return buildHubtelBasicAuth(process.env.HUBTEL_CLIENT_ID, process.env.HUBTEL_CLIENT_SECRET)
}

function getCollectionAccount(): string {
    const account = process.env.HUBTEL_COLLECTION_ACCOUNT_NUMBER
    if (!account) {
        throw new Error('[HubtelPayment] HUBTEL_COLLECTION_ACCOUNT_NUMBER is not configured.')
    }
    return account
}

/**
 * The disbursement account Commission Services runs on — a DIFFERENT number from the
 * collection account above.
 *
 * Deliberately duplicated from lib/hubtel-airtime-service.ts and
 * lib/hubtel-utility-service.ts rather than imported: both of those import FROM this
 * module, so reaching back into either would make the cycle real.
 */
function getPrepaidAccount(): string {
    const account = process.env.HUBTEL_PREPAID_ACCOUNT_NUMBER
    if (!account) {
        throw new Error('[HubtelPayment] HUBTEL_PREPAID_ACCOUNT_NUMBER is not configured.')
    }
    return account
}

/**
 * Normalizes a Ghanaian phone number to Hubtel's required international format:
 * a bare "233XXXXXXXXX" (12 digits, NO leading "+"), per the Direct Receive Money spec
 * (e.g. "233249111411"). Accepts local "0XXXXXXXXX" and "+233XXXXXXXXX" inputs.
 */
export function toHubtelMsisdn(phone: string): string {
    let digits = (phone || '').replace(/\D/g, '')
    if (digits.startsWith('0')) {
        digits = '233' + digits.slice(1)
    } else if (digits.startsWith('233')) {
        // already international
    } else if (digits.length === 9) {
        // bare subscriber number without leading 0, e.g. "249111411"
        digits = '233' + digits
    }
    return digits
}

/**
 * Reduces free text to plain ASCII before it goes to Hubtel.
 *
 * Hubtel echoes Description and CustomerName back in its response body. Any
 * multi-byte character in them breaks the framing of that response and undici
 * aborts the read with `TypeError: terminated` — but only AFTER Hubtel has
 * accepted the payment and pushed the prompt to the customer's handset. The
 * caller sees a network error for a payment that is actually live.
 *
 * This is why the storefront failed on every single attempt while the main site
 * never did: the storefront joined the shop name and the item with an em dash,
 * and the main site's descriptions are plain ASCII. Shop names are supplied by
 * customers, so an em dash is only the instance we happened to ship — emoji and
 * accented letters would do the same. Stripping at the boundary is the fix that
 * holds regardless of what a shop calls itself.
 */
export function toHubtelSafeText(value: string, fallback = ''): string {
    const ascii = (value || '')
        // Typographic punctuation first, so it degrades to something readable
        // rather than being dropped outright by the ASCII filter below.
        .replace(/[‐-―−]/g, '-')  // dashes, incl. the em dash
        .replace(/[‘’‛]/g, "'")   // curly single quotes
        .replace(/[“”]/g, '"')         // curly double quotes
        .replace(/…/g, '...')               // ellipsis
        .normalize('NFKD')                       // accented letter -> letter + mark
        .replace(/[^\x20-\x7E]/g, '')            // drop everything still non-ASCII
        .replace(/\s+/g, ' ')
        .trim()
    return ascii || fallback
}

/**
 * Turns a thrown fetch error into something a customer can act on, while logging
 * the real cause for us.
 *
 * undici throws a bare `TypeError: fetch failed` for every connection-level
 * problem — DNS, TLS, an unreachable proxy, a timeout. That string used to be
 * passed straight through to the checkout, where it told the customer nothing and
 * told us nothing either. The underlying reason is on err.cause.
 */
export function describeHubtelNetworkFailure(err: any, context: string, label = 'HubtelPayment'): string {
    const cause = err?.cause
    const code = cause?.code || err?.code
    const usingProxy = !!(process.env.FIXIE_URL || process.env.QUOTAGUARDSTATIC_URL)
    const text = `${err?.message || ''} ${cause?.message || ''}`

    console.error(`[${label}] ${context} failed to reach Hubtel:`, {
        message: err?.message,
        code,
        cause: cause?.message,
        usingProxy,
    })

    // The static proxy rejected us. Undici surfaces this as a cancelled request
    // rather than an HTTP status, so without this branch it looks like a random
    // timeout and sends you hunting in the wrong place. It means the proxy
    // credentials are wrong or the account is expired/out of quota — a config
    // problem no retry will clear.
    if (/407|proxy auth|Proxy response/i.test(text) || (usingProxy && /cancelled/i.test(text))) {
        console.error(
            '[HubtelPayment] ACTION REQUIRED: the static proxy rejected our credentials (HTTP 407). ' +
            'Hubtel only accepts whitelisted IPs, so payments cannot go out until this is fixed. ' +
            'Get a fresh proxy URL from the provider dashboard, update FIXIE_URL, and confirm its ' +
            'static IP is whitelisted in the Hubtel Merchant Portal.'
        )
        return 'Mobile money payments are temporarily unavailable. Please try another payment method or contact support.'
    }

    if (err?.name === 'TimeoutError' || code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'UND_ERR_HEADERS_TIMEOUT') {
        return 'Hubtel did not respond in time. Please try again in a moment.'
    }

    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'ECONNREFUSED' || code === 'ECONNRESET') {
        // Almost always the static proxy: unset, wrong credentials, or unreachable.
        console.error(
            usingProxy
                ? '[HubtelPayment] The static proxy (FIXIE_URL / QUOTAGUARDSTATIC_URL) appears unreachable. Check the URL and that the quota is not exhausted.'
                : '[HubtelPayment] No static proxy is configured. Set FIXIE_URL and whitelist its IP in the Hubtel dashboard.'
        )
        return 'Could not reach the payment provider. Please try again shortly.'
    }

    return 'Could not reach the payment provider. Please try again shortly.'
}

// ─── Initiate Payment ─────────────────────────────────────────────────────────

/** The who/what/how-much fields shared by every payment-log write in initiatePayment. */
function logIdentity(params: HubtelInitiateParams, payload: { CustomerMsisdn: string }) {
    return {
        clientReference: params.clientReference,
        amount: params.amount,
        channel: params.channel,
        payerMsisdn: payload.CustomerMsisdn,
        customerName: params.customerName ?? null,
        userId: params.userId ?? null,
    }
}

/**
 * Sends a Direct Mobile Money payment prompt to the customer's phone.
 * ResponseCode '0001' = pending (prompt sent successfully).
 */
export async function initiatePayment(params: HubtelInitiateParams): Promise<HubtelInitiateResult> {
    // Kept outside the try so the failure log can show exactly what we sent —
    // the payload is what identified the bad Description in the first place.
    let payloadForLog: Record<string, unknown> | null = null

    try {
        const account = getCollectionAccount()
        const authHeader = getHubtelAuthHeader()
        const callbackUrl = `${webhookBaseUrl()}/api/webhooks/hubtel`

        const payload = {
            // Both of these are echoed back by Hubtel — see toHubtelSafeText.
            CustomerName: toHubtelSafeText(params.customerName || ''),
            CustomerMsisdn: toHubtelMsisdn(params.payerPhone),
            CustomerEmail: params.customerEmail || '',
            Channel: params.channel,
            Amount: parseFloat(params.amount.toFixed(2)),
            PrimaryCallbackUrl: callbackUrl,
            Description: toHubtelSafeText(params.description || '', 'ARHMS Payment'),
            ClientReference: params.clientReference,
        }

        payloadForLog = payload

        console.log('[HubtelPayment] Initiating payment:', {
            account,
            channel: params.channel,
            amount: payload.Amount,
            ref: params.clientReference,
        })

        const response = await fetch(
            `${HUBTEL_RECEIVE_BASE_URL}/${account}/receive/mobilemoney`,
            {
                method: 'POST',
                headers: {
                    Authorization: authHeader,
                    'Content-Type': 'application/json',
                    Accept: 'application/json',
                    'Cache-Control': 'no-cache',
                },
                body: JSON.stringify(payload),
                // Without this a dead proxy hangs the checkout until the platform
                // kills the function, and the customer just watches a spinner.
                signal: AbortSignal.timeout(20_000),
                // @ts-ignore — undici dispatcher for static IP routing
                dispatcher: getDispatcher(),
            }
        )

        const responseText = await response.text()
        let data: any
        try {
            data = JSON.parse(responseText)
        } catch (parseError) {
            console.error('[HubtelPayment] Failed to parse Hubtel response. Status:', response.status)
            console.error('[HubtelPayment] Raw response:', responseText.substring(0, 500))
            await logInitiate({
                ...logIdentity(params, payload),
                status: 'failed',
                message: `Unparseable Hubtel response (HTTP ${response.status})`,
                raw: { request: payload, responseText: responseText.substring(0, 1000) },
            })
            return {
                success: false,
                error: `Hubtel API Error (HTTP ${response.status}). The server returned an invalid response. This often happens if your IP is not whitelisted in the Hubtel dashboard.`,
            }
        }

        console.log('[HubtelPayment] Raw API response:', JSON.stringify(data))

        // 0001 = accepted, callback will confirm final state
        // 0000 = immediately successful (rare for mobile money)
        if (data.ResponseCode === '0001' || data.ResponseCode === '0000') {
            // '0001' only means the prompt is on its way — the callback decides the
            // outcome, so the record stays pending until then.
            await logInitiate({
                ...logIdentity(params, payload),
                status: data.ResponseCode === '0000' ? 'success' : 'pending',
                transactionId: data.Data?.TransactionId ?? null,
                responseCode: data.ResponseCode,
                message: data.Message ?? null,
                raw: { request: payload, response: data },
            })
            return {
                success: true,
                transactionId: data.Data?.TransactionId,
                status: data.ResponseCode,
            }
        }

        // Any other code is a failure
        await logInitiate({
            ...logIdentity(params, payload),
            status: 'failed',
            responseCode: data.ResponseCode ?? null,
            message: data.Message || `Hubtel error (HTTP ${response.status})`,
            raw: { request: payload, response: data },
        })
        return {
            success: false,
            error: data.Message || `Hubtel error (HTTP ${response.status})`,
        }
    } catch (err: any) {
        const error = describeHubtelNetworkFailure(err, 'initiatePayment')
        // Nothing ever reached the customer's handset here, but the attempt still belongs
        // in the record — an admin looking at a customer's complaint needs to see it.
        await logInitiate({
            clientReference: params.clientReference,
            status: 'failed',
            amount: params.amount,
            channel: params.channel,
            payerMsisdn: toHubtelMsisdn(params.payerPhone),
            customerName: params.customerName ?? null,
            userId: params.userId ?? null,
            message: error,
            // err.message alone is useless here — undici reports every transport
            // problem as a bare "fetch failed" or "terminated". The cause is what
            // distinguishes a dead proxy from a broken response body.
            raw: {
                error: String(err?.message || err),
                code: err?.cause?.code ?? err?.code ?? null,
                cause: String(err?.cause?.message ?? err?.cause ?? ''),
                request: payloadForLog,
            },
        })
        return { success: false, error }
    }
}

// ─── Status Check ─────────────────────────────────────────────────────────────

/**
 * One status lookup, against ONE Hubtel account.
 *
 * The account is a parameter because the same endpoint is the only lead we have on
 * Commission Services transactions, which live on the prepaid account rather than
 * the collection one. See checkCommissionStatus below.
 */
async function statusForAccount(
    account: string,
    authHeader: string,
    clientReference: string,
    label: string
): Promise<HubtelStatusResult> {
    try {
        const url = `${HUBTEL_STATUS_BASE_URL}/${account}/status?clientReference=${encodeURIComponent(clientReference)}`

        console.log(`[HubtelPayment] Checking ${label} status for ref:`, clientReference)

        const response = await fetch(url, {
            method: 'GET',
            headers: {
                Authorization: authHeader,
                Accept: 'application/json',
            },
            signal: AbortSignal.timeout(20_000),
            // @ts-ignore — undici dispatcher for static IP routing
            dispatcher: getDispatcher(),
        })

        const responseText = await response.text()
        let data: any
        try {
            data = JSON.parse(responseText)
        } catch (parseError) {
            console.error('[HubtelPayment] checkPaymentStatus failed to parse Hubtel response. Status:', response.status)
            console.error('[HubtelPayment] Raw response:', responseText.substring(0, 500))
            return {
                success: false,
                status: null,
                error: `Hubtel API Error (HTTP ${response.status}). The server returned an invalid response.`,
            }
        }

        console.log('[HubtelPayment] Status check response:', JSON.stringify(data))

        if (!response.ok || data.responseCode !== '0000') {
            return {
                success: false,
                status: null,
                error: data.message || `Hubtel status check error (HTTP ${response.status})`,
            }
        }

        return {
            success: true,
            status: data.data?.status ?? null,     // 'Paid' | 'Unpaid' | 'Refunded'
            transactionId: data.data?.transactionId ?? undefined,
            externalTransactionId: data.data?.externalTransactionId ?? undefined,
            paymentMethod: data.data?.paymentMethod ?? undefined,
            amount: data.data?.amount ?? undefined,
            charges: data.data?.charges ?? undefined,
            amountAfterCharges: data.data?.amountAfterCharges ?? undefined,
            date: data.data?.date ?? undefined,
            raw: data.data ?? null,
        }
    } catch (err: any) {
        return { success: false, status: null, error: describeHubtelNetworkFailure(err, 'checkPaymentStatus') }
    }
}

/**
 * Checks the final status of a Hubtel COLLECTION transaction — money coming in.
 * Should only be called if a callback was not received within 5 minutes.
 * Returns status: 'Paid' | 'Unpaid' | 'Refunded' | null
 */
export async function checkPaymentStatus(clientReference: string): Promise<HubtelStatusResult> {
    try {
        return await statusForAccount(
            getCollectionAccount(),
            getHubtelAuthHeader(),
            clientReference,
            'collection'
        )
    } catch (err: any) {
        // getCollectionAccount / getHubtelAuthHeader throw when unconfigured.
        return { success: false, status: null, error: describeHubtelNetworkFailure(err, 'checkPaymentStatus') }
    }
}

export type HubtelStatusAccount = 'prepaid' | 'collection'

export interface HubtelCommissionStatusResult extends HubtelStatusResult {
    /** Which account actually answered, or null when neither did. */
    accountUsed: HubtelStatusAccount | null
    /** Every attempt, so an admin can see exactly what Hubtel said and to whom. */
    attempts: Array<{ account: HubtelStatusAccount; success: boolean; status: string | null; error?: string }>
}

/**
 * Asks Hubtel what became of a transaction, trying the prepaid account first.
 *
 * Commission Services — airtime top-ups (AIR-) and utility bill payments (UTLB-) —
 * publish no status endpoint of their own, so when a callback never arrives the
 * order strands and an admin has to resolve it from the Hubtel portal by hand. The
 * transaction-status API is the only lead available, and this repo has always
 * pointed it at the COLLECTION account, which is why the sweeps in
 * /api/cron/sync-hubtel-{airtime,utility} say no status check exists and settle for
 * flagging a human.
 *
 * Whether that endpoint answers for the PREPAID account has never actually been
 * tried. So try it, then fall back to collection, and report which one replied —
 * the caller must be able to tell "Hubtel says it failed" from "Hubtel would not
 * say", because on an irreversible bill payment those are not the same answer and
 * guessing between them either refunds a paid bill or closes an unpaid one.
 */
export async function checkCommissionStatus(clientReference: string): Promise<HubtelCommissionStatusResult> {
    const attempts: HubtelCommissionStatusResult['attempts'] = []

    const targets: Array<{ account: HubtelStatusAccount; resolve: () => { account: string; auth: string } }> = [
        {
            account: 'prepaid',
            resolve: () => ({
                account: getPrepaidAccount(),
                // Commission Services is one product; utilities and airtime share the
                // airtime key, falling back to the main one. Same resolution as
                // getUtilityAuthHeader() in lib/hubtel-utility-service.ts.
                auth: buildHubtelBasicAuth(
                    process.env.HUBTEL_AIRTIME_CLIENT_ID || process.env.HUBTEL_CLIENT_ID,
                    process.env.HUBTEL_AIRTIME_CLIENT_SECRET || process.env.HUBTEL_CLIENT_SECRET,
                    'HUBTEL_AIRTIME_CLIENT_ID/SECRET (or HUBTEL_CLIENT_ID/SECRET)',
                    'HubtelPayment'
                ),
            }),
        },
        {
            account: 'collection',
            resolve: () => ({ account: getCollectionAccount(), auth: getHubtelAuthHeader() }),
        },
    ]

    for (const target of targets) {
        let resolved: { account: string; auth: string }
        try {
            resolved = target.resolve()
        } catch (err: any) {
            // Unconfigured env var — record it and try the other account rather than
            // failing the whole lookup.
            attempts.push({ account: target.account, success: false, status: null, error: String(err?.message || err) })
            continue
        }

        const result = await statusForAccount(resolved.account, resolved.auth, clientReference, target.account)
        attempts.push({
            account: target.account,
            success: result.success,
            status: result.status,
            error: result.error,
        })

        if (result.success) {
            return { ...result, accountUsed: target.account, attempts }
        }
    }

    return {
        success: false,
        status: null,
        error: attempts.map(a => `${a.account}: ${a.error || 'no answer'}`).join(' · ') || 'No account could be queried',
        accountUsed: null,
        attempts,
    }
}

/**
 * Calculates the Hubtel fee and total amount for a given base amount.
 */
export function calculateHubtelFee(baseAmount: number, feePercent: number = HUBTEL_FEE_PERCENT): { fee: number; total: number } {
    const fee = parseFloat((baseAmount * (feePercent / 100)).toFixed(2))
    const total = parseFloat((baseAmount + fee).toFixed(2))
    return { fee, total }
}
