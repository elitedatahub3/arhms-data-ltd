/**
 * Paystack Mobile Money reconciliation sweep.
 *
 * This is not merely a lost-webhook net. Paystack emits charge.success and nothing
 * else — there is no charge.failed — so for this rail the sweep is the ONLY thing
 * that ever resolves an unapproved prompt. Without it a customer who ignores the
 * prompt leaves a pending row that stays pending forever, holding whatever it
 * reserved, and a customer whose webhook is lost is never delivered to at all.
 *
 * Three parts, each in its own try block so a failure in one cannot discard the
 * results the others already collected:
 *
 *   A  wallet_payments rows stamped provider='paystack_momo' — every signed-in
 *      checkout (wallet, data, utilities, boosts, upgrades, subscriptions).
 *   B  the four guest storefront flows, which write no wallet_payments row and are
 *      therefore found through a Redis marker instead of a provider column.
 *   C  the USSD sales and short-code activations previously swept by
 *      verify-ussd-payments, absorbed here so there is one sweep calling
 *      verifyTransaction rather than two that can drift apart.
 *
 * Deliberately NO areCronJobsEnabled() guard, matching verify-hubtel-payments,
 * verify-payswitch-payments and verify-ussd-payments: a global cron kill switch
 * must not be able to strand a customer's money.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { Redis } from '@upstash/redis'
import { verifyTransaction } from '@/lib/paystack-momo-service'
import { logStatusCheck } from '@/lib/hubtel-payment-log'
import { clearPaystackMomoPromptCount } from '@/lib/hubtel-prompt-limit'
import {
    claimHubtelStatusCheck,
    PAYSTACK_MOMO_CRON_THROTTLE_KEYS,
} from '@/lib/hubtel-status-throttle'
import { resolveByReference } from '@/lib/ussd-reference'
import {
    processCompletedWalletPayment,
    processCompletedUpgradePayment,
    processCompletedDealerSubscription,
} from '@/lib/payments'

const redis = Redis.fromEnv()

/**
 * This sweep has four parts where the one it replaced had two, and each part can
 * make up to BATCH_LIMIT verify calls of up to 15s each. Normal runs are quick —
 * the throttle skips most rows — but the slowest run is the one after an outage,
 * which is exactly the run that matters. Matches the sync-* routes, which set this
 * for the same reason.
 *
 * A cut-off request loses nothing: every part commits as it goes and every settle
 * path is idempotent, so the next run resumes where this one stopped.
 */
export const maxDuration = 60

/** Let the webhook land before second-guessing it. */
const CALLBACK_GRACE_MINUTES = 5
/** Before this a customer may still walk back to their phone and approve. */
const FAILURE_CUTOFF_MINUTES = 60
/** Upper bound on the query. Without it one stuck row is re-checked forever. */
const ABANDON_AFTER_MINUTES = 24 * 60
const MAX_CRON_CHECKS = 6
const BATCH_LIMIT = 10

/**
 * Both spellings of "not paid for yet".
 *
 * results_checker_orders is written with 'pending_payment' by the gateway routes and
 * 'pending' by lib/vouchers/checkout.ts. Testing against only one of them would read
 * an unpaid order as settled, drop its marker and leave it stranded — which is the
 * exact failure this sweep exists to prevent.
 */
const UNSETTLED_PAYMENT_STATUSES = ['pending_payment', 'pending']

/** 5, 10, 20, 40, 60, 60 minutes. */
function cronBackoffMs(_ageMs: number, checkCount: number): number {
    return Math.min(60, 5 * Math.pow(2, checkCount)) * 60 * 1000
}

function minutesAgo(minutes: number): string {
    return new Date(Date.now() - minutes * 60 * 1000).toISOString()
}

export async function GET(request: NextRequest) {
    const startTime = Date.now()

    if (request.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const supabase = createServerClient()
    const results = {
        checked: 0,
        credited: 0,
        failed: 0,
        stillPending: 0,
        throttled: 0,
        abandoned: 0,
        guestChecked: 0,
        guestSettled: 0,
        guestReleased: 0,
        ussdChecked: 0,
        ussdFulfilled: 0,
        activationsChecked: 0,
        activationsSettled: 0,
        errors: [] as string[],
        totalTimeMs: 0,
    }

    // ── PART A: wallet_payments ─────────────────────────────────────────────────
    try {
        const { count: abandonedCount } = await (supabase.from('wallet_payments') as any)
            .select('id', { count: 'exact', head: true })
            .eq('status', 'pending')
            .eq('provider', 'paystack_momo')
            .lt('created_at', minutesAgo(ABANDON_AFTER_MINUTES))
        results.abandoned = abandonedCount || 0

        const { data: pending, error: fetchError } = await (supabase.from('wallet_payments') as any)
            .select('id, reference, total_amount, amount, status, metadata, user_id, created_at')
            .eq('status', 'pending')
            .eq('provider', 'paystack_momo')
            .lt('created_at', minutesAgo(CALLBACK_GRACE_MINUTES))
            .gt('created_at', minutesAgo(ABANDON_AFTER_MINUTES))
            .order('created_at', { ascending: true })
            .limit(BATCH_LIMIT)

        if (fetchError) throw new Error(fetchError.message)

        const failureCutoff = new Date(Date.now() - FAILURE_CUTOFF_MINUTES * 60 * 1000)

        for (const payment of (pending || [])) {
            try {
                const decision = await claimHubtelStatusCheck(supabase, payment, {
                    graceMs: 0,
                    interval: cronBackoffMs,
                    maxChecks: MAX_CRON_CHECKS,
                    keys: PAYSTACK_MOMO_CRON_THROTTLE_KEYS,
                })
                if (!decision.allowed) {
                    results.throttled++
                    continue
                }

                results.checked++
                const verified = await verifyTransaction(payment.reference)

                if (verified.outcome === 'paid') {
                    const metadata = payment.metadata || {}
                    const mappedEventData = {
                        reference: payment.reference,
                        // Paystack's figure is authoritative over anything we stored.
                        amount: verified.amountPesewas
                            ?? Math.round(Number(payment.total_amount || payment.amount) * 100),
                        metadata,
                    }

                    // Same routing as the webhook and verify-hubtel-payments. Every
                    // processor is idempotent, so racing a late callback is safe.
                    if (payment.reference.startsWith('DATA-')) {
                        const { processDataDirectOrder } = await import('@/lib/data-order-payments')
                        const r = await processDataDirectOrder(payment.reference)
                        if (!r.success && !r.alreadyProcessed) throw new Error(r.error || 'Data order processing failed')
                    } else if (payment.reference.startsWith('UTIL-')) {
                        const { processUtilityDirectOrder } = await import('@/lib/utility-order-payments')
                        const r = await processUtilityDirectOrder(payment.reference)
                        if (!r.success && !r.alreadyProcessed) throw new Error(r.error || 'Utility bill processing failed')
                    } else if (payment.reference.startsWith('AIRPAY-')) {
                        const { processAirtimeDirectOrder } = await import('@/lib/airtime-order-payments')
                        const r = await processAirtimeDirectOrder(payment.reference)
                        if (!r.success && !r.alreadyProcessed) throw new Error(r.error || 'Airtime order processing failed')
                    } else if (payment.reference.startsWith('BOOST-')) {
                        const { processBoostPayment } = await import('@/lib/classifieds-payments')
                        const r = await processBoostPayment(payment.reference, mappedEventData)
                        if (!r.success && !r.alreadyProcessed) throw new Error(r.error || 'Boost processing failed')
                    } else if (
                        payment.reference.startsWith('agent_upgrade_')
                        || metadata.upgrade_type === 'agent'
                    ) {
                        await processCompletedUpgradePayment(payment.reference, mappedEventData)
                    } else if (
                        payment.reference.startsWith('ussd_activation_')
                        || metadata.upgrade_type === 'ussd_activation'
                    ) {
                        const { processCompletedUssdActivation } = await import('@/lib/payments')
                        await processCompletedUssdActivation(payment.reference, mappedEventData)
                    } else if (
                        payment.reference.startsWith('dealer_sub_')
                        || metadata.upgrade_type === 'dealer_subscription'
                    ) {
                        await processCompletedDealerSubscription(payment.reference, mappedEventData)
                    } else {
                        await processCompletedWalletPayment(payment.reference, mappedEventData, payment.user_id)
                    }

                    await logStatusCheck({
                        clientReference: payment.reference,
                        status: 'success',
                        amount: (verified.amountPesewas ?? 0) / 100,
                        message: 'Settled by reconciliation cron — no callback was received.',
                        raw: verified.raw,
                    })

                    // An approved prompt was by definition solicited.
                    const payerMsisdn = metadata.payer_msisdn || metadata.payer_phone
                    if (payerMsisdn) await clearPaystackMomoPromptCount(String(payerMsisdn))

                    results.credited++
                } else if (verified.outcome === 'failed' && new Date(payment.created_at) < failureCutoff) {
                    // The second .eq is what stops this racing a webhook into
                    // overwriting a row that has already completed.
                    await (supabase.from('wallet_payments') as any)
                        .update({ status: 'failed', updated_at: new Date().toISOString() })
                        .eq('id', payment.id)
                        .eq('status', 'pending')
                    await logStatusCheck({
                        clientReference: payment.reference,
                        status: 'failed',
                        message: `Given up by reconciliation cron after ${FAILURE_CUTOFF_MINUTES} minutes (Paystack status: ${verified.rawStatus ?? 'failed'}).`,
                        raw: verified.raw,
                    })
                    results.failed++
                } else {
                    results.stillPending++
                }
            } catch (err: any) {
                console.error('[CronPaystackMomo] Error on', payment.reference, err?.message)
                results.errors.push(`${payment.reference}: ${err?.message ?? 'unknown'}`)
            }
        }
    } catch (err: any) {
        console.error('[CronPaystackMomo] Part A failed:', err)
        results.errors.push(`walletPayments: ${err?.message ?? 'unknown'}`)
    }

    // ── PART B: guest storefront flows ──────────────────────────────────────────
    // No wallet_payments row and therefore no provider column, so these are found by
    // the marker written at initiate. Only this rail writes it, so the sweep cannot
    // pick up a payment belonging to another gateway.
    try {
        let cursor = 0
        const keys: string[] = []
        do {
            const [next, batch] = await redis.scan(cursor, {
                match: 'paystack_momo:pending:*',
                count: 100,
            })
            cursor = Number(next)
            keys.push(...(batch as string[]))
        } while (cursor !== 0 && keys.length < 200)

        const failureCutoffMs = FAILURE_CUTOFF_MINUTES * 60 * 1000
        const graceMs = CALLBACK_GRACE_MINUTES * 60 * 1000

        for (const key of keys) {
            const reference = key.replace('paystack_momo:pending:', '')
            try {
                const rawInfo = await redis.get<any>(key)
                const info = typeof rawInfo === 'string' ? JSON.parse(rawInfo) : rawInfo
                const ageMs = Date.now() - Number(info?.at ?? 0)
                if (ageMs < graceMs) continue

                results.guestChecked++

                // Cheapest check first, and the common case: the webhook already
                // settled this and only the marker is left behind.
                if (await guestOrderAlreadySettled(supabase, reference, info?.kind)) {
                    await redis.del(key)
                    continue
                }

                const verified = await verifyTransaction(reference)

                if (verified.outcome === 'paid') {
                    const paidAmountKobo = verified.amountPesewas ?? 0
                    await settleGuestOrder(supabase, reference, info?.kind, paidAmountKobo)
                    await logStatusCheck({
                        clientReference: reference,
                        status: 'success',
                        amount: paidAmountKobo / 100,
                        message: 'Settled by reconciliation cron — no callback was received.',
                        raw: verified.raw,
                    })
                    await redis.del(key)
                    results.guestSettled++
                } else if (verified.outcome === 'failed' && ageMs > failureCutoffMs) {
                    await releaseGuestOrder(supabase, reference, info?.kind)
                    await logStatusCheck({
                        clientReference: reference,
                        status: 'failed',
                        message: `Given up by reconciliation cron after ${FAILURE_CUTOFF_MINUTES} minutes (Paystack status: ${verified.rawStatus ?? 'failed'}).`,
                        raw: verified.raw,
                    })
                    await redis.del(key)
                    results.guestReleased++
                }
                // Otherwise leave the marker; the next run asks again.
            } catch (err: any) {
                console.error('[CronPaystackMomo] Guest error on', reference, err?.message)
                results.errors.push(`${reference}: ${err?.message ?? 'unknown'}`)
            }
        }
    } catch (err: any) {
        console.error('[CronPaystackMomo] Part B failed:', err)
        results.errors.push(`guestFlows: ${err?.message ?? 'unknown'}`)
    }

    // ── PART C1: USSD sales ─────────────────────────────────────────────────────
    // A USSD caller has no account and so no wallet_payments row; the pending state
    // lives in hubtel_payment_logs. Absorbed from verify-ussd-payments.
    try {
        const { data: pending } = await (supabase.from('hubtel_payment_logs') as any)
            .select('client_reference, amount, created_at')
            .eq('flow', 'ussd')
            .eq('status', 'pending')
            // The retired Hubtel AddToCart path also wrote flow='ussd' rows, keyed by
            // Hubtel's OrderId. Those are not Paystack references and would 404 forever.
            .like('client_reference', 'USSD-%')
            .lt('created_at', minutesAgo(CALLBACK_GRACE_MINUTES))
            .gt('created_at', minutesAgo(ABANDON_AFTER_MINUTES))
            .order('created_at', { ascending: true })
            .limit(BATCH_LIMIT)

        for (const row of (pending || [])) {
            const reference = String(row.client_reference)
            results.ussdChecked++
            try {
                const verified = await verifyTransaction(reference)
                if (verified.outcome === 'pending') continue

                if (verified.outcome === 'failed') {
                    await logStatusCheck({
                        clientReference: reference,
                        status: 'failed',
                        message: verified.message ?? `Paystack status: ${verified.rawStatus ?? 'failed'}`,
                        raw: verified.raw,
                    })
                    results.failed++
                    continue
                }

                const amountPaid = (verified.amountPesewas ?? 0) / 100
                const resolved = await resolveByReference(supabase, reference)
                if (!resolved) {
                    console.error('[CronPaystackMomo] Paid but unresolvable, needs a human:', reference)
                    await logStatusCheck({
                        clientReference: reference,
                        status: 'failed',
                        amount: amountPaid,
                        message: 'Paid but the USSD session could not be found.',
                        raw: verified.raw,
                    })
                    continue
                }

                const deferredWork: Array<() => Promise<void>> = []
                // Both fulfillers are idempotent on referenceCode, so racing the
                // webhook is safe — whichever arrives second is a no-op.
                const result = resolved.orderType === 'data'
                    ? await (await import('@/lib/ussd-data-fulfillment')).fulfillUSSDDataBySession({
                        sessionId: resolved.sessionId, referenceCode: reference, amountPaid, deferredWork,
                    })
                    : await (await import('@/lib/ussd-rc-fulfillment')).fulfillUSSDRCBySession({
                        sessionId: resolved.sessionId, referenceCode: reference, amountPaid, deferredWork,
                    })

                await logStatusCheck({
                    clientReference: reference,
                    status: result.success ? 'success' : 'failed',
                    amount: amountPaid,
                    message: result.success
                        ? 'Recovered by reconciliation sweep.'
                        : `Paid but fulfilment failed: ${result.error ?? 'unknown error'}`,
                    raw: verified.raw,
                })

                if (result.success) results.ussdFulfilled++
                else results.failed++

                for (const task of deferredWork) await task().catch(() => {})
            } catch (err: any) {
                console.error('[CronPaystackMomo] USSD error on', reference, err?.message)
                results.errors.push(`${reference}: ${err?.message ?? 'unknown'}`)
            }
        }
    } catch (err: any) {
        console.error('[CronPaystackMomo] Part C1 failed:', err)
        results.errors.push(`ussdSales: ${err?.message ?? 'unknown'}`)
    }

    // ── PART C2: short-code activations ─────────────────────────────────────────
    try {
        const { data: pendingActivations } = await (supabase.from('wallet_payments') as any)
            .select('reference, total_amount')
            .eq('status', 'pending')
            // BOTH labels, permanently. Activations written before the USSD scope was
            // unified are stamped 'paystack'; ones written after are 'paystack_momo'.
            // Matching only the new label would strand every row created before the
            // deploy — pending forever, with the shop already debited — and there is
            // no reason to rewrite history to avoid one extra value here.
            .in('provider', ['paystack', 'paystack_momo'])
            .like('reference', 'ussd_activation_%')
            .lt('created_at', minutesAgo(CALLBACK_GRACE_MINUTES))
            .gt('created_at', minutesAgo(ABANDON_AFTER_MINUTES))
            .order('created_at', { ascending: true })
            .limit(BATCH_LIMIT)

        for (const row of (pendingActivations || [])) {
            const reference = String(row.reference)
            results.activationsChecked++
            try {
                const verified = await verifyTransaction(reference)

                // Only 'paid' acts. A failed row is deliberately left pending rather
                // than marked failed: there is nothing reserved to release, and an
                // abandoned prompt approved late should still mint the code it paid for.
                if (verified.outcome !== 'paid') continue

                const { processCompletedUssdActivation } = await import('@/lib/payments')
                const settled = await processCompletedUssdActivation(reference, {
                    reference,
                    amount: verified.amountPesewas ?? Math.round(Number(row.total_amount) * 100),
                    metadata: { recovered_by: 'verify-paystack-momo-payments' },
                })

                if (settled?.success) {
                    results.activationsSettled++
                } else {
                    results.errors.push(`${reference}: ${settled?.error ?? 'activation settle failed'}`)
                    console.error('[CronPaystackMomo] Paid activation would not settle:', reference, settled?.error)
                }
            } catch (err: any) {
                console.error('[CronPaystackMomo] Activation error on', reference, err?.message)
                results.errors.push(`${reference}: ${err?.message ?? 'unknown'}`)
            }
        }
    } catch (err: any) {
        console.error('[CronPaystackMomo] Part C2 failed:', err)
        results.errors.push(`activations: ${err?.message ?? 'unknown'}`)
    }

    results.totalTimeMs = Date.now() - startTime
    console.log('[CronPaystackMomo] Sweep complete:', JSON.stringify(results))
    return NextResponse.json({ success: true, ...results })
}

/**
 * Has the order behind a guest reference already been settled?
 *
 * Checked before asking Paystack because it is a local read and it is what happens
 * on almost every marker the sweep sees — the webhook settled the order and only
 * the marker is left over.
 */
async function guestOrderAlreadySettled(
    supabase: any,
    reference: string,
    kind: string | undefined
): Promise<boolean> {
    if (kind === 'shop') {
        const { data } = await supabase
            .from('shop_orders')
            .select('id')
            .eq('paystack_reference', reference)
            .maybeSingle()
        return !!data
    }
    const table = kind === 'afa' ? 'afa_orders'
        : (kind === 'rc' || kind === 'rc_shop') ? 'results_checker_orders'
            : null
    if (!table) return false

    const { data } = await supabase
        .from(table)
        .select('payment_status')
        .eq('reference_code', reference)
        .maybeSingle()
    return !!data && !UNSETTLED_PAYMENT_STATUSES.includes(String(data.payment_status))
}

/** Settles through the same finalizers the webhook uses, so both stay idempotent together. */
async function settleGuestOrder(
    supabase: any,
    reference: string,
    kind: string | undefined,
    paidAmountKobo: number
): Promise<void> {
    if (kind === 'shop') {
        const raw = await redis.get<any>(`shop:meta:${reference}`)
        const metadata = typeof raw === 'string' ? JSON.parse(raw) : raw
        if (!metadata?.shop_id) {
            console.error('[CronPaystackMomo] SHOP- paid but metadata is gone:', reference)
            return
        }
        const { processShopOrder } = await import('@/lib/shop-order-processor')
        await processShopOrder(reference, metadata, paidAmountKobo, metadata.slug ?? metadata.shop_slug)
        return
    }
    if (kind === 'rc' || kind === 'rc_shop') {
        const { finalizeRCGatewayOrder } = await import('@/lib/vouchers/checkout')
        await finalizeRCGatewayOrder({ reference, paidAmountKobo, metadata: {} })
        return
    }
    if (kind === 'afa') {
        const { finalizeAfaShopOrder } = await import('@/lib/afa/checkout')
        await finalizeAfaShopOrder({ reference, paidAmountKobo })
    }
}

/**
 * Releases what a dead guest order was holding.
 *
 * RC orders reserve vouchers at initiate, so abandoning one without releasing them
 * takes stock off the shelf that nobody paid for.
 */
async function releaseGuestOrder(
    supabase: any,
    reference: string,
    kind: string | undefined
): Promise<void> {
    const table = kind === 'afa' ? 'afa_orders'
        : (kind === 'rc' || kind === 'rc_shop') ? 'results_checker_orders'
            : null
    if (!table) return

    // The .in() guard is the same idea as the conditional update in Part A: only a
    // still-unpaid row may be failed, so this cannot overwrite one a late callback
    // has already completed.
    await supabase
        .from(table)
        .update({ payment_status: 'failed' })
        .eq('reference_code', reference)
        .in('payment_status', UNSETTLED_PAYMENT_STATUSES)
    // 'shop' reserves nothing before payment — no order row exists yet — so there is
    // nothing to release. Dropping the marker is the whole cleanup.
}
