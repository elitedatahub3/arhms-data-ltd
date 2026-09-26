/**
 * Rate limits calls to Hubtel's payment status API.
 *
 * Every status check leaves Vercel through the metered static-IP proxy
 * (FIXIE_URL — see lib/hubtel-payment-service.ts), whose free plan allows 500
 * requests per MONTH. Nothing else in the app uses that proxy, so status checks
 * alone decide whether the quota survives the month. When it runs out the proxy
 * answers 407 and payments stop working outright — a metered quota is therefore
 * an availability concern, not just a billing one.
 *
 * The rule this enforces: Hubtel confirms payments by webhook, and every caller
 * checks the DB first. The status API is the FALLBACK for when the webhook never
 * lands. So each payment gets a small, bounded budget of status checks:
 *
 *   1. stay quiet during a grace window, giving the webhook time to arrive
 *   2. then space checks out by at least `interval`
 *   3. then stop entirely at `maxChecks`, however long the caller keeps asking
 *
 * Step 3 is the one that matters most. Throttling alone is unbounded: a customer
 * who never approves the prompt leaves a browser tab polling indefinitely, and
 * "slowly, forever" still drains a monthly quota. Past the cap, the webhook and
 * the reconciliation sweep (/api/cron/verify-hubtel-payments) remain — neither
 * needs anyone's tab to stay open.
 *
 * The counters live in wallet_payments.metadata rather than dedicated columns so
 * this needs no migration, and are namespaced per caller: the browser poll and
 * the cron sweep must not consume each other's budget, or whichever ran first
 * would silently starve the other.
 */

export interface HubtelThrottleKeys {
    /** metadata key holding the ISO timestamp of the last check. */
    lastCheck: string
    /** metadata key holding the number of checks spent so far. */
    count: string
}

/** Keys used by the browser-facing verify routes. */
export const CLIENT_THROTTLE_KEYS: HubtelThrottleKeys = {
    lastCheck: 'last_hubtel_check',
    count: 'hubtel_check_count',
}

/** Keys used by the reconciliation cron, kept separate from the client budget. */
export const CRON_THROTTLE_KEYS: HubtelThrottleKeys = {
    lastCheck: 'last_cron_hubtel_check',
    count: 'cron_hubtel_check_count',
}

/**
 * PaySwitch budgets. The mechanism here is gateway-agnostic (only the name says
 * Hubtel); PaySwitch needs it for the same reason — it is confirmed by callback,
 * its status API may share the same metered static proxy, and a browser tab left
 * open on an unapproved prompt would otherwise poll forever. Separate keys so the
 * two gateways cannot spend each other's budget on a payment that switched
 * providers on a retry.
 */
export const PAYSWITCH_CLIENT_THROTTLE_KEYS: HubtelThrottleKeys = {
    lastCheck: 'last_payswitch_check',
    count: 'payswitch_check_count',
}

export const PAYSWITCH_CRON_THROTTLE_KEYS: HubtelThrottleKeys = {
    lastCheck: 'last_cron_payswitch_check',
    count: 'cron_payswitch_check_count',
}

/**
 * Paystack MoMo budgets. Paystack's verify endpoint is not behind the metered
 * static proxy, so the quota argument above does not apply — but the other reason
 * does: Paystack never webhooks a failure, so an unapproved prompt produces no
 * callback at all and a tab left open on one would poll until it was closed.
 */
export const PAYSTACK_MOMO_CLIENT_THROTTLE_KEYS: HubtelThrottleKeys = {
    lastCheck: 'last_paystack_momo_check',
    count: 'paystack_momo_check_count',
}

export const PAYSTACK_MOMO_CRON_THROTTLE_KEYS: HubtelThrottleKeys = {
    lastCheck: 'last_cron_paystack_momo_check',
    count: 'cron_paystack_momo_check_count',
}

export interface HubtelThrottleOptions {
    /** Silence window after the payment was created, letting the webhook land first. */
    graceMs: number
    /**
     * Minimum gap between checks. A function receives the payment's age and how
     * many checks it has already spent, so callers can back off as a payment ages.
     */
    interval: number | ((ageMs: number, checkCount: number) => number)
    /** Hard ceiling on status checks for this payment, for this caller. */
    maxChecks: number
    /** Overrides the metadata keys. Defaults to the client budget. */
    keys?: HubtelThrottleKeys
}

export type HubtelThrottleDecision =
    | { allowed: true; checkNumber: number }
    | { allowed: false; reason: 'grace' | 'interval' | 'exhausted' }

export interface ThrottledPayment {
    id: string | number
    created_at?: string | null
    metadata?: Record<string, any> | null
}

/**
 * Decides whether this caller may spend a proxied status check on `payment`, and
 * records the spend when it may.
 *
 * The counter is stamped BEFORE the caller makes its request, deliberately: the
 * proxy request is what costs quota, so it has to be accounted for even if the
 * call then fails or the function times out. Concurrent polls that arrive while
 * one is in flight therefore see the new timestamp and back off, instead of all
 * queueing up behind it and firing at once.
 *
 * A stamping failure is NOT treated as a veto — see the catch below.
 */
export async function claimHubtelStatusCheck(
    supabase: any,
    payment: ThrottledPayment,
    options: HubtelThrottleOptions
): Promise<HubtelThrottleDecision> {
    const keys = options.keys ?? CLIENT_THROTTLE_KEYS
    const now = Date.now()
    const meta = (payment.metadata || {}) as Record<string, any>

    const createdAt = payment.created_at ? new Date(payment.created_at).getTime() : NaN
    // An unparseable created_at must not skip the grace window into a free check;
    // treat the payment as brand new so the webhook still gets its head start.
    const ageMs = Number.isFinite(createdAt) ? now - createdAt : 0

    const lastCheck = meta[keys.lastCheck] ? new Date(meta[keys.lastCheck]).getTime() : 0
    const checkCount = Number(meta[keys.count]) || 0

    if (checkCount >= options.maxChecks) return { allowed: false, reason: 'exhausted' }
    if (ageMs < options.graceMs) return { allowed: false, reason: 'grace' }

    const intervalMs =
        typeof options.interval === 'function'
            ? options.interval(ageMs, checkCount)
            : options.interval

    // lastCheck === 0 means never checked, and `now - 0` clears any interval.
    if (now - lastCheck < intervalMs) return { allowed: false, reason: 'interval' }

    try {
        await supabase
            .from('wallet_payments')
            .update({
                metadata: {
                    ...meta,
                    [keys.lastCheck]: new Date(now).toISOString(),
                    [keys.count]: checkCount + 1,
                },
            })
            .eq('id', payment.id)
    } catch (err: any) {
        // Losing the stamp costs quota accuracy; refusing the check costs a customer
        // their money. The interval and the caller's own limits still bound the
        // damage, so proceed — but say so loudly, because a persistent failure here
        // silently restores the unbounded polling this module exists to prevent.
        console.error('[HubtelThrottle] Could not record status check for', payment.id, err?.message)
    }

    return { allowed: true, checkNumber: checkCount + 1 }
}
