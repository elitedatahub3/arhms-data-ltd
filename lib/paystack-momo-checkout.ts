/**
 * Orchestration around a Paystack MoMo charge — the part every checkout route needs
 * and none of them should own a copy of.
 *
 * Ten routes have to do the same six things before and after the charge: map the
 * network, refuse when the gateway is unconfigured, check the per-number prompt
 * ceiling, charge, record the prompt only once Paystack accepted it, and write the
 * audit row. Pasted ten times that is sixty lines of duplication in which a single
 * divergence is a payment nothing recovers, because the sweeps are scoped by what
 * the row says collected it.
 *
 * SEPARATE FROM lib/paystack-momo-service.ts ON PURPOSE. This module imports the
 * prompt limiter and the payment log, which reach Redis and (transitively) undici.
 * app/api/hubtel/interact/route.ts runs on the edge runtime and imports the service
 * directly; pulling any of this into that module would break the edge build and take
 * the USSD channel down. The service is the HTTP client, this is the Node-only layer
 * on top, and the dial-in route uses only the former.
 */

import {
    chargeMobileMoney,
    submitOtp,
    verifyTransaction,
    paystackMomoProviderFor,
    getPaystackConfigError,
    WEB_CHARGE_TIMEOUT_MS,
    type PaystackChargeOutcome,
    type PaystackChargeResult,
} from '@/lib/paystack-momo-service'
import {
    checkPaystackMomoPromptLimit,
    recordPaystackMomoPrompt,
} from '@/lib/hubtel-prompt-limit'
import { logInitiate, logStatusCheck } from '@/lib/hubtel-payment-log'
import { Redis } from '@upstash/redis'

const redis = Redis.fromEnv()

/** Matches the Redis TTL the storefront metadata already uses. */
const PENDING_MARKER_TTL_SECONDS = 86_400

/**
 * How long one payer number is held to a single live charge.
 *
 * Long enough to cover a customer reading an SMS and typing it, short enough that
 * a genuinely dead charge does not lock them out for long. The window is released
 * early whenever a charge is refused, so this only ever delays someone whose
 * previous prompt is still valid.
 */
const INFLIGHT_TTL_SECONDS = 90

function inflightKey(msisdn: string): string {
    return `paystack_momo:inflight:${String(msisdn || '').replace(/\D/g, '')}`
}

export interface MomoChargeInput {
    reference: string
    /**
     * GROSS GHS the customer is charged. Never pesewas.
     *
     * app/api/shop/initialize holds its total in pesewas while every other route
     * holds cedis, so that one caller divides by 100 before calling in. Getting it
     * wrong charges a hundred times the price and reads like a gateway bug.
     */
    amountGhs: number
    payerPhone: string
    /** Any spelling a picker emits: 'MTN' | 'Telecel' | 'AT' | 'AirtelTigo'. */
    network: string
    email?: string | null
    /**
     * Machine-shaped only — ids, slugs, phones. No display text.
     *
     * Everything here is echoed back by the webhook, and the settle paths read their
     * real metadata from the database or Redis, so there is nothing to gain by
     * shipping a shop name through a payment field and something to lose.
     */
    metadata?: Record<string, unknown>
    userId?: string | null
}

export interface MomoChargeResult {
    /** false => surface `body` at `httpStatus` and stop. */
    ok: boolean
    outcome: PaystackChargeOutcome
    /**
     * Whether the caller may mark its pending row failed.
     *
     * False on a duplicate reference and on a network throw, because both mean a
     * charge may already exist. A row stamped 'failed' can never be settled again —
     * the webhook and every processor only act on the pending -> completed
     * transition — so a wrong 'failed' here is money taken for nothing delivered.
     */
    safeToMarkFailed: boolean
    httpStatus: number
    body: Record<string, unknown>
}

function shapeSuccess(charge: PaystackChargeResult): MomoChargeResult {
    const otpRequired = charge.outcome === 'otp'
    return {
        ok: true,
        outcome: charge.outcome,
        safeToMarkFailed: false,
        httpStatus: 200,
        body: {
            success: true,
            gateway: 'paystack_momo',
            otpRequired,
            reference: charge.reference,
            message:
                charge.displayText
                ?? (otpRequired
                    ? 'Enter the one-time code sent to your phone.'
                    : 'Payment prompt sent to your phone. Please approve to continue.'),
        },
    }
}

function shapeFailure(
    charge: PaystackChargeResult,
    fallbackMessage: string
): MomoChargeResult {
    return {
        ok: false,
        outcome: 'failed',
        // A refusal Paystack actually articulated (`raw` present) is a real decline.
        // A thrown fetch (`raw === null`) never reached a verdict.
        safeToMarkFailed: charge.raw !== null,
        httpStatus: 502,
        body: { error: charge.message || fallbackMessage },
    }
}

/**
 * Starts a charge and shapes the response every route returns.
 *
 * The body deliberately matches Moolre's contract — `{ success, otpRequired,
 * reference, message }` — so the client surfaces that already branch on
 * `data.otpRequired` need no new code path.
 */
export async function startPaystackMomoCharge(
    input: MomoChargeInput
): Promise<MomoChargeResult> {
    const provider = paystackMomoProviderFor(input.network)
    if (!provider) {
        return {
            ok: false,
            outcome: 'failed',
            safeToMarkFailed: true,
            httpStatus: 400,
            body: { error: 'Unsupported payment network' },
        }
    }

    const configError = getPaystackConfigError()
    if (configError) {
        console.error('[PaystackMomo] refusing to charge:', configError)
        return {
            ok: false,
            outcome: 'failed',
            safeToMarkFailed: true,
            httpStatus: 503,
            body: { error: 'Mobile money payments are temporarily unavailable. Please try again shortly.' },
        }
    }

    const limit = await checkPaystackMomoPromptLimit(input.payerPhone)
    if (!limit.allowed) {
        return {
            ok: false,
            outcome: 'failed',
            safeToMarkFailed: true,
            httpStatus: 429,
            body: { error: limit.error || 'Too many payment prompts have been sent to this number recently.' },
        }
    }

    // One live charge per number at a time.
    //
    // Without this, every press of the pay button mints a new reference and a new
    // charge. Customers press it repeatedly — the logs are full of the same number
    // charged seven or eight times with gaps of seven to thirty seconds — because
    // nothing on screen changes while a prompt is on its way. Each new charge
    // supersedes the OTP the previous one sent, so the code the customer is halfway
    // through typing goes dead, and the symptom reads as "the OTP never came".
    //
    // It also stops the pileup those retries leave behind: a stack of pending rows
    // per customer that the sweep then has to close one by one.
    const key = inflightKey(input.payerPhone)
    let holdsInflight = false
    try {
        const claimed = await redis.set(key, JSON.stringify({ reference: input.reference }), {
            nx: true,
            ex: INFLIGHT_TTL_SECONDS,
        })
        if (!claimed) {
            const raw = await redis.get<any>(key)
            const held = typeof raw === 'string' ? JSON.parse(raw) : raw
            // The two live states need opposite instructions. Telling someone to
            // approve a prompt when what is waiting is a code — or the reverse —
            // sends them looking for something that was never sent.
            const heldNeedsOtp = held?.otpRequired === true
            return {
                ok: false,
                outcome: 'failed',
                // The new row is a duplicate that was never charged, so failing it is
                // correct and leaves the earlier charge untouched.
                safeToMarkFailed: true,
                httpStatus: 409,
                body: {
                    error: heldNeedsOtp
                        ? 'We already sent a one-time code to this number. Enter that code to finish — a new payment would cancel it.'
                        : 'A payment prompt was just sent to this number. Please approve it on your phone, or wait a moment before trying again.',
                    // Handed back so the client can resume the live charge rather than
                    // stranding the customer behind an error they cannot act on.
                    reference: held?.reference ?? null,
                    otpRequired: heldNeedsOtp,
                    resumable: !!held?.reference,
                },
            }
        }
        holdsInflight = true
    } catch (e) {
        // Fails OPEN, same stance as the prompt limiter: a Redis blip must not stop
        // payments. The worst case is the duplicate behaviour we already have today.
        console.error('[PaystackMomo] in-flight guard unavailable, allowing charge:', e)
    }

    const charge = await chargeMobileMoney({
        reference: input.reference,
        amountGhs: input.amountGhs,
        payerMsisdn: input.payerPhone,
        provider,
        email: input.email || undefined,
        metadata: input.metadata,
        timeoutMs: WEB_CHARGE_TIMEOUT_MS,
    })

    // Released as soon as the charge reaches a terminal state. A refusal sent nothing
    // to the handset, and a charge that already succeeded is finished — in neither
    // case is there a live prompt worth protecting, so the customer must be free to
    // start another payment straight away. Only 'otp' and 'pending' keep the hold,
    // which are exactly the states a second charge would sabotage.
    //
    // (The 8-per-hour prompt limiter is a tighter constraint than this window in any
    // case, so an agent buying for several customers is bounded by that, not by this.)
    if (holdsInflight && (charge.outcome === 'failed' || charge.outcome === 'paid')) {
        await redis.del(key).catch(() => {})
    } else if (holdsInflight) {
        // Record which of the two live states this is, so a customer who taps again
        // is told the right thing and can be handed back to the charge they already
        // have rather than being blocked with nothing to act on.
        await redis.set(
            key,
            JSON.stringify({ reference: charge.reference, otpRequired: charge.outcome === 'otp' }),
            { ex: INFLIGHT_TTL_SECONDS }
        ).catch(() => {})
    }

    // Only once Paystack has accepted it. A prompt that never left does not count
    // against a customer who will have to try again.
    if (charge.outcome !== 'failed') {
        await recordPaystackMomoPrompt(input.payerPhone)
    }

    await logInitiate({
        clientReference: input.reference,
        status: charge.outcome === 'failed' ? 'failed' : 'pending',
        amount: input.amountGhs,
        channel: provider,
        payerMsisdn: input.payerPhone,
        // displayText first: it is Paystack's instruction to the customer ("enter the
        // one-time password", "input your PIN on your mobile device") and is the only
        // field that says which authorisation path this charge took. data.message is
        // almost always null on a MoMo charge, so logging it alone left the log row
        // blank and the raw JSON the only place to find out what happened.
        message: charge.displayText ?? charge.message,
        responseCode: charge.rawStatus,
        userId: input.userId ?? null,
        raw: charge.raw,
    })

    if (charge.outcome === 'failed') {
        return shapeFailure(charge, 'The charge was declined. Please try again.')
    }
    return shapeSuccess(charge)
}

/** Finishes a charge that answered `send_otp`. Never mints a new charge. */
export async function submitPaystackMomoOtp(params: {
    reference: string
    otp: string
    /** Releases this number's in-flight hold once the code settles the charge. */
    payerPhone?: string | null
}): Promise<MomoChargeResult> {
    const result = await submitOtp({
        reference: params.reference,
        otp: params.otp,
        timeoutMs: WEB_CHARGE_TIMEOUT_MS,
    })

    // Recorded because otherwise nothing anywhere shows that a code was ever tried.
    // A charge that answered send_otp and then went quiet is indistinguishable, in
    // the logs, from one where the customer never received the SMS at all — and
    // those two need completely different responses from us.
    await logStatusCheck({
        clientReference: params.reference,
        status: result.outcome === 'paid' ? 'success' : result.outcome === 'failed' ? 'failed' : 'pending',
        message: result.displayText ?? result.message ?? `OTP submitted, Paystack said ${result.rawStatus ?? 'nothing'}`,
        raw: result.raw,
    })

    // The code carried the charge to a finish, so this number is free again. A wrong
    // code deliberately keeps the hold: the same charge is still live and the
    // customer is about to retype against it.
    if (params.payerPhone && result.outcome === 'paid') {
        await redis.del(inflightKey(params.payerPhone)).catch(() => {})
    }

    if (result.outcome === 'failed') {
        // An OTP rejection is not a dead payment — the customer can retype the code
        // against the same charge, so the row must stay pending.
        return {
            ...shapeFailure(result, 'That code was not accepted. Please check it and try again.'),
            safeToMarkFailed: false,
            httpStatus: 400,
        }
    }
    return shapeSuccess(result)
}

/**
 * Decides what to do with a reference that already exists.
 *
 * Paystack refuses a second charge on the same reference, so a retry can never just
 * re-send. Ask the gateway what happened to the first attempt instead: 'paid' means
 * settle, 'pending' means keep waiting, and only an outright failure justifies
 * minting a new reference.
 */
export async function resolveExistingCharge(reference: string): Promise<MomoChargeResult> {
    const verified = await verifyTransaction(reference)

    if (verified.outcome === 'failed') {
        return {
            ok: false,
            outcome: 'failed',
            safeToMarkFailed: true,
            httpStatus: 502,
            body: { error: verified.message || 'That payment did not go through. Please start a new one.' },
        }
    }

    return {
        ok: true,
        outcome: verified.outcome === 'paid' ? 'paid' : 'pending',
        safeToMarkFailed: false,
        httpStatus: 200,
        body: {
            success: true,
            gateway: 'paystack_momo',
            otpRequired: false,
            reference,
            message:
                verified.outcome === 'paid'
                    ? 'Payment received.'
                    : 'Still waiting for you to approve the prompt on your phone.',
        },
    }
}

/**
 * Confirms a reference belongs to this user and is still awaiting payment.
 *
 * Without it the OTP endpoints would submit codes against a stranger's charge — the
 * references are guessable, and burning someone else's attempts is enough to break
 * their checkout.
 */
export async function assertOwnPendingPayment(
    db: any,
    reference: string,
    userId: string
): Promise<boolean> {
    if (!reference || !userId) return false
    const { data } = await db
        .from('wallet_payments')
        .select('id')
        .eq('reference', reference)
        .eq('user_id', userId)
        .eq('status', 'pending')
        .maybeSingle()
    return !!data
}

/**
 * Marks a guest reference as an outstanding Paystack MoMo charge.
 *
 * The four storefront flows write no wallet_payments row, so there is no provider
 * column for the reconciliation sweep to filter on. This marker is that filter: it
 * is written before the charge, deleted by whichever of the webhook, the browser
 * poll or the sweep settles it, and — because only this rail writes it — it cannot
 * pick up a payment that belongs to another gateway even if an admin switches the
 * setting mid-flight.
 */
export async function markPaystackMomoPending(
    reference: string,
    info: { kind: 'shop' | 'rc' | 'rc_shop' | 'afa'; slug?: string }
): Promise<void> {
    try {
        await redis.set(
            `paystack_momo:pending:${reference}`,
            JSON.stringify({ ...info, at: Date.now() }),
            { ex: PENDING_MARKER_TTL_SECONDS }
        )
    } catch (e) {
        // Non-fatal: the charge still happens and the webhook still settles it. What
        // is lost is the safety net, so it is worth a loud log rather than silence.
        console.error('[PaystackMomo] could not write pending marker:', reference, e)
    }
}

/**
 * Whether this reference is an outstanding Paystack MoMo charge.
 *
 * The guest verify routes use it to decide which gateway to ask. Fails CLOSED — a
 * Redis blip answers "not ours", which sends the caller down its original Moolre
 * path rather than asking Paystack about a Moolre reference. The wrong answer that
 * way costs a poll cycle; the wrong answer the other way would report a live charge
 * as unverifiable.
 */
export async function isPaystackMomoPending(reference: string): Promise<boolean> {
    try {
        return (await redis.get(`paystack_momo:pending:${reference}`)) !== null
    } catch (e) {
        console.error('[PaystackMomo] could not read pending marker:', reference, e)
        return false
    }
}

export async function clearPaystackMomoPending(reference: string): Promise<void> {
    try {
        await redis.del(`paystack_momo:pending:${reference}`)
    } catch (e) {
        console.error('[PaystackMomo] could not clear pending marker:', reference, e)
    }
}
