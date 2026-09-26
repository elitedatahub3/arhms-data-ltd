/**
 * Per-number cap on Hubtel payment prompts.
 *
 * Trust attaches to the number alone, so once a number is verified ANYONE who types
 * it reaches the Hubtel prompt without a code. This limiter is the only thing left
 * standing between a trusted number and a stream of unsolicited prompts — it must
 * be applied on the trusted path too, not just the first-time one.
 *
 * It counts prompts that were ACTUALLY SENT, not payment attempts. Those are very
 * different things: if Hubtel is unreachable — a dead proxy, an outage — nothing
 * rings the customer's phone, and charging them a token for it would lock them out
 * of a checkout that never worked in the first place. The count is therefore taken
 * in two steps: check the ceiling before calling Hubtel, record only once Hubtel
 * has accepted the request.
 *
 * The two steps can race under concurrency, which at worst allows one extra prompt
 * past the ceiling. That is a far better failure than an hour-long lockout caused by
 * an outage on our side.
 *
 * Note the key prefix is `hubtel:prompt:`. An earlier version used the Upstash
 * Ratelimit prefix `rl:hubtel-prompt`; those old keys are intentionally orphaned, so
 * anyone locked out by the attempt-counting bug is released as soon as this ships.
 */
import { Redis } from '@upstash/redis'
import { toHubtelMsisdn as normalizeMsisdn } from '@/lib/hubtel-payment-service'

const redis = Redis.fromEnv()

// Every prompt counts, approved or not, so a buyer who mistypes a PIN or lets a
// prompt time out burns quota exactly like an abuser does. Five was tight enough
// that ordinary repeat buyers — an agent paying for several customers from one
// wallet — were being turned away. Eight still stops a flood; the real relief is
// clearHubtelPromptCount below.
const MAX_PROMPTS_PER_WINDOW = 8
const WINDOW_SECONDS = 60 * 60

/**
 * The counter is namespaced per gateway.
 *
 * One shared window across gateways would mean a customer who exhausted their
 * prompts on one rail is refused on another for an hour, with nothing in the UI
 * able to explain why — and switching the active gateway would inherit a lockout
 * earned somewhere else. The ceiling is per number per rail.
 */
export type PromptLimitScope = 'hubtel' | 'paystack_momo'

function keyFor(msisdn: string, scope: PromptLimitScope): string {
    return `${scope}:prompt:${msisdn}`
}

export interface PromptLimitResult {
    allowed: boolean
    error?: string
}

/**
 * Call immediately before hubtelInitiatePayment. Read-only — it does not consume
 * anything, so a failed payment costs the customer nothing.
 *
 * Fails OPEN when the counter cannot be read, and says so loudly in the logs.
 *
 * That is a deliberate reversal of this module's original fail-closed stance. The
 * two outcomes are not symmetrical:
 *   - Fail closed on a Redis blip → every mobile money payment across the platform
 *     stops. Direct revenue loss, from an outage that has nothing to do with abuse.
 *   - Fail open on a Redis blip → someone could briefly send extra prompts to a
 *     trusted number. A nuisance: each prompt still needs the handset owner to
 *     approve it, and no money moves without that approval.
 *
 * Redis here is a quota-capped Upstash instance — the payment OTPs were already
 * moved off it for that exact reason — so treating it as a hard dependency of the
 * checkout is not defensible. The OTP gate that protects an UNVERIFIED number is
 * Postgres-backed and still fails closed; that is the control that actually stops
 * a stranger's number being prompted at all.
 */
export async function checkHubtelPromptLimit(
    phone: string,
    scope: PromptLimitScope = 'hubtel'
): Promise<PromptLimitResult> {
    const msisdn = normalizeMsisdn(phone)
    if (!msisdn) return { allowed: false, error: 'Invalid phone number.' }

    try {
        const count = await redis.get<number>(keyFor(msisdn, scope))
        if ((Number(count) || 0) >= MAX_PROMPTS_PER_WINDOW) {
            return {
                allowed: false,
                error: 'Too many payment prompts have been sent to this number recently. Please wait a while and try again.',
            }
        }
        return { allowed: true }
    } catch (e) {
        console.error(
            '[HubtelPromptLimit] counter unreachable — ALLOWING the payment through with no ' +
            'per-number ceiling for this request. If this repeats, check Upstash quota/availability:',
            e
        )
        return { allowed: true }
    }
}

/**
 * Call ONLY after Hubtel has accepted the request and a prompt is genuinely on its
 * way to the handset. Never on a failed or unreachable call.
 *
 * A failure here is logged and swallowed: the payment is already in flight, and
 * refusing to acknowledge it would help nobody.
 */
export async function recordHubtelPrompt(
    phone: string,
    scope: PromptLimitScope = 'hubtel'
): Promise<void> {
    const msisdn = normalizeMsisdn(phone)
    if (!msisdn) return

    try {
        const key = keyFor(msisdn, scope)
        const count = await redis.incr(key)
        // First prompt in this window starts the clock. A fixed window is enough
        // here — this guards against floods, not precise accounting.
        if (count === 1) await redis.expire(key, WINDOW_SECONDS)
    } catch (e) {
        console.error('[HubtelPromptLimit] could not record prompt (non-fatal):', e)
    }
}

/**
 * Call when a payment from this number has actually been APPROVED on the handset.
 *
 * The thing this limiter exists to stop is a stream of prompts nobody asked for —
 * and an unwanted prompt is never approved. A number that just entered its PIN has
 * proven the opposite, so holding its earlier prompts against it only punishes the
 * customers who buy most. Clearing the window here is what keeps a busy wallet from
 * hitting the ceiling in the middle of a normal afternoon's purchases.
 */
export async function clearHubtelPromptCount(
    phone: string,
    scope: PromptLimitScope = 'hubtel'
): Promise<void> {
    const msisdn = normalizeMsisdn(phone)
    if (!msisdn) return

    try {
        await redis.del(keyFor(msisdn, scope))
    } catch (e) {
        console.error('[HubtelPromptLimit] could not clear prompt count (non-fatal):', e)
    }
}

/** The same three, bound to the Paystack MoMo window. */
export const checkPaystackMomoPromptLimit = (phone: string) =>
    checkHubtelPromptLimit(phone, 'paystack_momo')
export const recordPaystackMomoPrompt = (phone: string) =>
    recordHubtelPrompt(phone, 'paystack_momo')
export const clearPaystackMomoPromptCount = (phone: string) =>
    clearHubtelPromptCount(phone, 'paystack_momo')
