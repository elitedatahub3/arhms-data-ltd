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
 *      checkout (wallet, data, utilities, upgrades, subscriptions).
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
import { isRetiredBoostReference, reportRetiredBoostPayment, RETIRED_BOOST_MESSAGE } from '@/lib/retired-boost'
import { createServerClient } from '@/lib/supabase'
import { isCronAuthorized, cronUnauthorizedResponse } from '@/lib/cron-control'
import { Redis } from '@upstash/redis'
import { getShopMeta, listPendingShopPayments, stampShopPaymentCheck } from '@/lib/shop-meta-store'
import { reconcileShopPayment } from '@/lib/shop-payment-reconcile'
import { verifyTransaction } from '@/lib/paystack-momo-service'
import { logStatusCheck } from '@/lib/hubtel-payment-log'
import { clearPaystackMomoPromptCount } from '@/lib/hubtel-prompt-limit'
import {
    claimHubtelStatusCheck,
    PAYSTACK_MOMO_CRON_THROTTLE_KEYS,
} from '@/lib/hubtel-status-throttle'
import { resolveByReference } from '@/lib/ussd-reference'
import { findMemberPayment, settleMemberUssdOrder } from '@/lib/ussd-member-settle'
import { findUssdUtilityPayment, settleUssdUtilityOrder } from '@/lib/ussd-utility-settle'
import { findUssdAirtimePayment, settleUssdAirtimeOrder } from '@/lib/ussd-airtime-settle'
import { USSD_MEMBER_PAYMENT_KIND } from '@/lib/ussd-member'
import {
    processCompletedWalletPayment,
    processCompletedUpgradePayment,
    processCompletedDealerSubscription,
    isSmsPaymentReference,
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
const MAX_CRON_CHECKS = 10
const BATCH_LIMIT = 10
/** Check on every run while a late approval is still likely. */
const EVERY_RUN_MINUTES = 35
/**
 * Part B0 bounds. Gateway calls per run, and the wall-clock point after which the
 * ledger stops starting new checks so Parts B and C still get their turn inside
 * maxDuration. Rows not reached are first in line next run (least recently checked).
 */
const LEDGER_GATEWAY_CALLS = 20
const LEDGER_TIME_BUDGET_MS = 25_000

/**
 * Both spellings of "not paid for yet".
 *
 * results_checker_orders is written with 'pending_payment' by the gateway routes and
 * 'pending' by lib/vouchers/checkout.ts. Testing against only one of them would read
 * an unpaid order as settled, drop its marker and leave it stranded — which is the
 * exact failure this sweep exists to prevent.
 */
const UNSETTLED_PAYMENT_STATUSES = ['pending_payment', 'pending']

/**
 * Every run (5 min) for the first ~30 minutes, then 60 minutes apart.
 *
 * Was 5, 10, 20, 40, 60: a customer who approved just after the first check waited
 * 10+ minutes for the second, which is most of what "my top-up is slow" meant while
 * the webhook was not landing. The hourly tail still reaches FAILURE_CUTOFF_MINUTES
 * within MAX_CRON_CHECKS, so abandoned prompts are still marked failed.
 */
function cronBackoffMs(ageMs: number, _checkCount: number): number {
    // 4, not 5: the cron fires every 5 min, and a run landing a second early
    // would otherwise be throttled and double the wait.
    return (ageMs < EVERY_RUN_MINUTES * 60 * 1000 ? 4 : 60) * 60 * 1000
}

function minutesAgo(minutes: number): string {
    return new Date(Date.now() - minutes * 60 * 1000).toISOString()
}

export async function GET(request: NextRequest) {
    const startTime = Date.now()

    if (!isCronAuthorized(request)) {
        return cronUnauthorizedResponse()
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
        ledgerChecked: 0,
        ledgerSettled: 0,
        ledgerFailed: 0,
        ledgerPaidIssues: 0,
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
            // Newest first: those are the ones a customer may be waiting on. Oldest
            // first let abandoned prompts fill the batch and push a fresh paid top-up
            // to a later run; an old row only loses time before being marked failed.
            .order('created_at', { ascending: false })
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
                    if (payment.reference.startsWith('USSD-') && metadata.kind === 'utility_order' && metadata.channel === 'ussd') {
                        // A bill paid over USSD. Without this it would fall to the wallet
                        // top-up branch below and credit the account of record instead of
                        // paying the bill.
                        const r = await settleUssdUtilityOrder(supabase, {
                            payment,
                            reference: payment.reference,
                            amountPaid: (verified.amountPesewas ?? 0) / 100,
                        })
                        if (!r.success) throw new Error(r.error || 'USSD utility order failed')
                    } else if (payment.reference.startsWith('USSD-AIR-') && metadata.kind === 'airtime_order' && metadata.channel === 'ussd') {
                        // Airtime bought over USSD. Without this it would fall to the wallet
                        // top-up branch below and credit the wallet instead of buying the airtime.
                        const r = await settleUssdAirtimeOrder(supabase, {
                            payment,
                            reference: payment.reference,
                            amountPaid: (verified.amountPesewas ?? 0) / 100,
                        })
                        if (!r.success) throw new Error(r.error || 'USSD airtime order failed')
                    } else if (payment.reference.startsWith('USSD-') && metadata.kind === USSD_MEMBER_PAYMENT_KIND) {
                        // A registered user's USSD order: credit the wallet AND buy
                        // the item, not just the credit a plain top-up gets.
                        const r = await settleMemberUssdOrder(supabase, {
                            payment,
                            reference: payment.reference,
                            amountPaid: (verified.amountPesewas ?? 0) / 100,
                        })
                        if (!r.success) throw new Error(r.error || 'USSD member order failed')
                    } else if (payment.reference.startsWith('DATA-')) {
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
                    } else if (isRetiredBoostReference(payment.reference)) {
                        // Confirmed paid, but the product is gone. Throwing leaves the row pending so it is reported every run until refunded.
                        reportRetiredBoostPayment('CronPaystackMomo', payment.reference)
                        throw new Error(RETIRED_BOOST_MESSAGE)
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
                    } else if (isSmsPaymentReference(payment.reference, metadata)) {
                        const { processCompletedSmsPayment } = await import('@/lib/payments')
                        await processCompletedSmsPayment(payment.reference, mappedEventData, metadata)
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

    // ── PART B0: storefront payment ledger (shop_payment_meta) ─────────────────
    // The durable record of every SHOP- payment, on every rail, written before the
    // prompt goes out. Unlike the Redis marker below it survives a Redis outage, and
    // a paid payment that cannot become an order ends as needs_attention instead of
    // vanishing. Empty until migration 20261013000000 runs, so Part B carries on alone.
    const ledgerHandled = new Set<string>()
    try {
        const rows = await listPendingShopPayments(CALLBACK_GRACE_MINUTES * 60 * 1000, 100)
        let gatewayCalls = 0
        for (const row of rows) {
            if (gatewayCalls >= LEDGER_GATEWAY_CALLS || Date.now() - startTime > LEDGER_TIME_BUDGET_MS) break

            const ageMs = Date.now() - new Date(row.created_at).getTime()
            const lastChecked = row.last_checked_at ? new Date(row.last_checked_at).getTime() : 0
            // Same cadence as Part A: every run for the first half hour, then hourly.
            if (Date.now() - lastChecked < cronBackoffMs(ageMs, 0)) continue

            ledgerHandled.add(row.reference)
            results.ledgerChecked++
            gatewayCalls++
            try {
                await stampShopPaymentCheck(row.reference)
                const r = await reconcileShopPayment(row, {
                    failureCutoffMs: FAILURE_CUTOFF_MINUTES * 60 * 1000,
                    abandonAfterMs: ABANDON_AFTER_MINUTES * 60 * 1000,
                })
                if (r.outcome === 'settled' || r.outcome === 'already_settled') results.ledgerSettled++
                else if (r.outcome === 'failed') results.ledgerFailed++
                else if (r.outcome === 'paid_issue') {
                    results.ledgerPaidIssues++
                    results.errors.push(`${row.reference}: paid, no order (${r.detail ?? 'unknown'})`)
                }

                if (r.outcome === 'settled' || r.outcome === 'paid_issue') {
                    await logStatusCheck({
                        clientReference: row.reference,
                        status: r.outcome === 'settled' ? 'success' : 'failed',
                        message: r.outcome === 'settled'
                            ? 'Settled by reconciliation cron (ledger) - no callback had created the order.'
                            : `Paid but order not created: ${r.detail ?? 'unknown'}. Retrying.`,
                    })
                }
            } catch (err: any) {
                console.error('[CronPaystackMomo] Ledger error on', row.reference, err?.message)
                results.errors.push(`${row.reference}: ${err?.message ?? 'unknown'}`)
            }
        }
    } catch (err: any) {
        console.error('[CronPaystackMomo] Part B0 failed:', err)
        results.errors.push(`shopLedger: ${err?.message ?? 'unknown'}`)
    }

    // ── PART B: guest storefront flows ──────────────────────────────────────────
    // No wallet_payments row and therefore no provider column, so these are found by
    // the marker written at initiate. Only this rail writes it, so the sweep cannot
    // pick up a payment belonging to another gateway. For SHOP- this is now the
    // legacy path (Part B0 covers it durably); it still carries afa / rc / rc_shop.
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
            if (ledgerHandled.has(reference)) continue
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
                    const settled = await settleGuestOrder(supabase, reference, info?.kind, paidAmountKobo)
                    await logStatusCheck({
                        clientReference: reference,
                        status: settled.success ? 'success' : 'failed',
                        amount: paidAmountKobo / 100,
                        message: settled.success
                            ? 'Settled by reconciliation cron — no callback was received.'
                            : `Paid but order not created: ${settled.error ?? 'unknown'}. Will retry.`,
                        raw: verified.raw,
                    })
                    if (settled.success) {
                        await redis.del(key)
                        results.guestSettled++
                    } else {
                        // Keep the marker: it is the only thing that brings this
                        // payment back to the next run.
                        results.errors.push(`${reference}: paid, no order (${settled.error ?? 'unknown'})`)
                    }
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

                // A registered user's order settles into their wallet and is bought
                // from it (lib/ussd-member-settle.ts). Same call the webhook makes;
                // both steps are idempotent, so racing it is safe.
                // A utility bill settles through the website's bill payer (see the webhook).
                const utilityPayment = await findUssdUtilityPayment(supabase, reference)
                if (utilityPayment) {
                    const result = await settleUssdUtilityOrder(supabase, { payment: utilityPayment, reference, amountPaid })
                    await logStatusCheck({
                        clientReference: reference,
                        status: result.success ? 'success' : 'failed',
                        amount: amountPaid,
                        message: result.success
                            ? 'Recovered by reconciliation sweep.'
                            : `Utility settle failed: ${result.error ?? 'unknown error'}`,
                        raw: verified.raw,
                    })
                    if (result.success) {
                        results.ussdFulfilled++
                        await (supabase.from('hubtel_sessions') as any).delete().eq('session_id', utilityPayment.metadata?.session_id ?? '')
                    } else {
                        results.failed++
                    }
                    continue
                }

                // Airtime settles through the website's airtime buyer (see the webhook).
                const airtimePayment = await findUssdAirtimePayment(supabase, reference)
                if (airtimePayment) {
                    const result = await settleUssdAirtimeOrder(supabase, { payment: airtimePayment, reference, amountPaid })
                    await logStatusCheck({
                        clientReference: reference,
                        status: result.success ? 'success' : 'failed',
                        amount: amountPaid,
                        message: result.success
                            ? 'Recovered by reconciliation sweep.'
                            : `Airtime settle failed: ${result.error ?? 'unknown error'}`,
                        raw: verified.raw,
                    })
                    if (result.success) {
                        results.ussdFulfilled++
                        await (supabase.from('hubtel_sessions') as any).delete().eq('session_id', airtimePayment.metadata?.session_id ?? '')
                    } else {
                        results.failed++
                    }
                    continue
                }

                const memberPayment = await findMemberPayment(supabase, reference)
                if (memberPayment) {
                    const result = await settleMemberUssdOrder(supabase, { payment: memberPayment, reference, amountPaid })
                    await logStatusCheck({
                        clientReference: reference,
                        status: result.success ? 'success' : 'failed',
                        amount: amountPaid,
                        message: result.creditedOnly
                            ? `Recovered by reconciliation sweep. Credited to wallet; purchase failed: ${result.error}`
                            : result.success
                                ? 'Recovered by reconciliation sweep.'
                                : `Member settle failed: ${result.error ?? 'unknown error'}`,
                        raw: verified.raw,
                    })
                    if (result.success) {
                        results.ussdFulfilled++
                        await (supabase.from('hubtel_sessions') as any).delete().eq('session_id', memberPayment.metadata?.session_id ?? '')
                    } else {
                        results.failed++
                    }
                    continue
                }

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
                const { fulfillUssdSession } = await import('@/lib/ussd-settle')
                const result = await fulfillUssdSession({
                    orderType: resolved.orderType, sessionId: resolved.sessionId,
                    referenceCode: reference, amountPaid, deferredWork,
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

/**
 * Settles through the same finalizers the webhook uses, so both stay idempotent together.
 *
 * Reports whether an order actually came out of it. It used to return nothing, and
 * the caller logged "success" and dropped the marker even when the processor had
 * refused the order — the one payment the sweep exists for, lost by the sweep.
 */
async function settleGuestOrder(
    supabase: any,
    reference: string,
    kind: string | undefined,
    paidAmountKobo: number
): Promise<{ success: boolean; error?: string }> {
    if (kind === 'shop') {
        const metadata = await getShopMeta<any>(reference)
        if (!metadata?.shop_id) {
            console.error('[CronPaystackMomo] SHOP- paid but metadata is gone:', reference)
            return { success: false, error: 'Paid but the order details are gone' }
        }
        const { processShopOrder } = await import('@/lib/shop-order-processor')
        const result = await processShopOrder(reference, metadata, paidAmountKobo, metadata.slug ?? metadata.shop_slug)
        return { success: result.success, error: result.error }
    }
    if (kind === 'rc' || kind === 'rc_shop') {
        const { finalizeRCGatewayOrder } = await import('@/lib/vouchers/checkout')
        await finalizeRCGatewayOrder({ reference, paidAmountKobo, metadata: {} })
        return { success: true }
    }
    if (kind === 'afa') {
        const { finalizeAfaShopOrder } = await import('@/lib/afa/checkout')
        await finalizeAfaShopOrder({ reference, paidAmountKobo })
        return { success: true }
    }
    return { success: false, error: `Unknown guest kind: ${kind ?? 'none'}` }
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

// Accept any method (cron-job.org's sent method doesn't always match its UI); auth-gated.
export const POST = GET
export const PUT = GET
export const PATCH = GET
export const DELETE = GET

