import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { checkPaymentStatus } from '@/lib/hubtel-payment-service'
import { processCompletedWalletPayment, processCompletedUpgradePayment, processCompletedDealerSubscription } from '@/lib/payments'
import { logStatusCheck } from '@/lib/hubtel-payment-log'
import { claimHubtelStatusCheck, CRON_THROTTLE_KEYS } from '@/lib/hubtel-status-throttle'

/**
 * Reconciles Hubtel payments whose callback never arrived.
 *
 * Hubtel confirms mobile money transactions asynchronously via PrimaryCallbackUrl.
 * If that callback is lost (network blip, deploy, wrong NEXT_PUBLIC_APP_URL), the
 * payment sits `pending` forever: the customer is debited but never credited or
 * upgraded. This sweep catches those.
 *
 * Deliberately not gated on CRON_JOBS_ENABLED — this is financial reconciliation,
 * and a missing env var silently disabling it would recreate the gap it closes.
 */

// Hubtel advises against status-checking before the callback window has elapsed.
const CALLBACK_GRACE_MINUTES = 5
// Only give up on a payment well after any prompt could still be approved.
const FAILURE_CUTOFF_MINUTES = 60
// Stop sweeping a payment entirely once it is this old. The query below has to
// have an upper bound: a row Hubtel keeps reporting as Pending (or that we can
// never get a readable answer for) matches the filter forever, and at one run
// every 5 minutes that is 288 metered proxy requests per day, per row, without
// end. That single missing bound is what drains the quota while the site is idle.
//
// Rows past this point keep status='pending' rather than being guessed at — a
// wrong 'failed' would deny a customer who was actually debited — and are counted
// into `abandoned` below so they surface in the run log for manual settlement.
const ABANDON_AFTER_MINUTES = 24 * 60
// Ceiling on proxied status checks per payment, enforced by the throttle. With the
// backoff below this reaches past FAILURE_CUTOFF_MINUTES, so a payment still gets
// a verdict; it just cannot be re-asked indefinitely.
const MAX_CRON_CHECKS = 6

/**
 * Widening gap between checks: 5, 10, 20, 40 minutes, then hourly.
 *
 * A pending payment is most likely to resolve right after it is created, so the
 * early checks are cheap and close together; past that, re-asking often buys
 * nothing but costs quota. Checks land near 5, 15, 35 and 75 minutes of age — the
 * last comfortably past FAILURE_CUTOFF_MINUTES, which is what lets the give-up
 * branch below run at all.
 */
function cronBackoffMs(_ageMs: number, checkCount: number): number {
    return Math.min(60, 5 * Math.pow(2, checkCount)) * 60 * 1000
}

export async function GET(request: NextRequest) {
    const startTime = Date.now()

    const authHeader = request.headers.get('authorization')
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
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
        errors: [] as string[],
        totalTimeMs: 0,
    }

    try {
        const graceCutoff = new Date(Date.now() - CALLBACK_GRACE_MINUTES * 60 * 1000).toISOString()
        const failureCutoff = new Date(Date.now() - FAILURE_CUTOFF_MINUTES * 60 * 1000)
        const abandonCutoff = new Date(Date.now() - ABANDON_AFTER_MINUTES * 60 * 1000).toISOString()

        // Surfaced only so an operator can see rows the sweep has stopped touching.
        // Counting them is free; checking them is not.
        const { count: abandonedCount } = await (supabase
            .from('wallet_payments') as any)
            .select('id', { count: 'exact', head: true })
            .eq('status', 'pending')
            .eq('provider', 'hubtel')
            .lt('created_at', abandonCutoff)
        results.abandoned = abandonedCount || 0

        const { data: pendingPayments, error: fetchError } = await (supabase
            .from('wallet_payments') as any)
            .select('id, reference, total_amount, amount, status, metadata, user_id, created_at')
            .eq('status', 'pending')
            .eq('provider', 'hubtel')
            .lt('created_at', graceCutoff)
            .gt('created_at', abandonCutoff)
            // Oldest first. The 10-row cap is applied by the DB before the throttle
            // runs, so without a deterministic order a batch of freshly-created rows
            // (which the throttle will skip anyway) could crowd out an older payment
            // that is due for the check that decides its verdict.
            .order('created_at', { ascending: true })
            .limit(10)

        if (fetchError) {
            console.error('[CronHubtel] wallet_payments query error:', fetchError)
            results.errors.push(`wallet_payments query: ${fetchError.message}`)
        } else if (pendingPayments && pendingPayments.length > 0) {
            const checkPromises = pendingPayments.map(async (payment: any) => {
                try {
                    // The sweep runs every 5 minutes, so without this every pending row
                    // costs a metered proxy request every 5 minutes for as long as it
                    // stays pending. Back off as the payment ages instead. Grace is 0
                    // here: the query already excludes anything newer than
                    // CALLBACK_GRACE_MINUTES, so the webhook has had its head start.
                    const decision = await claimHubtelStatusCheck(supabase, payment, {
                        graceMs: 0,
                        interval: cronBackoffMs,
                        maxChecks: MAX_CRON_CHECKS,
                        keys: CRON_THROTTLE_KEYS,
                    })

                    if (!decision.allowed) {
                        results.throttled++
                        return
                    }

                    results.checked++
                    const statusResult = await checkPaymentStatus(payment.reference)

                    if (!statusResult.success || statusResult.status === null) {
                        results.stillPending++
                        return // Can't determine status — retry next run
                    }

                    if (statusResult.status === 'Paid') {
                        const paidAmountPesewas = Math.round(
                            Number(payment.total_amount || payment.amount) * 100
                        )
                        const metadata = payment.metadata || {}
                        const mappedEventData = {
                            reference: payment.reference,
                            amount: paidAmountPesewas,
                            metadata,
                        }

                        if (payment.reference.startsWith('DATA-')) {
                            const { processDataDirectOrder } = await import('@/lib/data-order-payments')
                            const dataResult = await processDataDirectOrder(payment.reference)
                            if (!dataResult.success && !dataResult.alreadyProcessed) {
                                throw new Error(dataResult.error || 'Data order processing failed')
                            }
                            console.log(`[CronHubtel] ✅ Data order ${payment.reference} settled`)
                        } else if (payment.reference.startsWith('UTIL-')) {
                            const { processUtilityDirectOrder } = await import('@/lib/utility-order-payments')
                            const utilResult = await processUtilityDirectOrder(payment.reference)
                            if (!utilResult.success && !utilResult.alreadyProcessed) {
                                throw new Error(utilResult.error || 'Utility bill processing failed')
                            }
                            console.log(`[CronHubtel] ✅ Utility bill ${payment.reference} settled`)
                        } else if (payment.reference.startsWith('AIRPAY-')) {
                            const { processAirtimeDirectOrder } = await import('@/lib/airtime-order-payments')
                            const airResult = await processAirtimeDirectOrder(payment.reference)
                            if (!airResult.success && !airResult.alreadyProcessed) {
                                throw new Error(airResult.error || 'Airtime order processing failed')
                            }
                            console.log(`[CronHubtel] ✅ Airtime order ${payment.reference} settled`)
                        } else if (payment.reference.startsWith('BOOST-')) {
                            const { processBoostPayment } = await import('@/lib/classifieds-payments')
                            const boostResult = await processBoostPayment(payment.reference, mappedEventData)
                            if (!boostResult.success && !boostResult.alreadyProcessed) {
                                throw new Error(boostResult.error || 'Boost processing failed')
                            }
                            console.log(`[CronHubtel] ✅ Boost payment ${payment.reference} credited`)
                        } else if (
                            payment.reference.startsWith('agent_upgrade_') ||
                            metadata.upgrade_type === 'agent'
                        ) {
                            await processCompletedUpgradePayment(payment.reference, mappedEventData)
                            console.log(`[CronHubtel] ✅ Agent upgrade ${payment.reference} credited`)
                        } else if (
                            payment.reference.startsWith('ussd_activation_') ||
                            metadata.upgrade_type === 'ussd_activation'
                        ) {
                            const { processCompletedUssdActivation } = await import('@/lib/payments')
                            await processCompletedUssdActivation(payment.reference, mappedEventData)
                            console.log(`[CronHubtel] ✅ USSD activation ${payment.reference} activated`)
                        } else if (
                            payment.reference.startsWith('dealer_sub_') ||
                            metadata.upgrade_type === 'dealer_subscription'
                        ) {
                            await processCompletedDealerSubscription(payment.reference, mappedEventData)
                            console.log(`[CronHubtel] ✅ Dealer subscription ${payment.reference} activated`)
                        } else {
                            await processCompletedWalletPayment(
                                payment.reference,
                                mappedEventData,
                                payment.user_id
                            )
                            console.log(`[CronHubtel] ✅ Wallet payment ${payment.reference} credited`)
                        }

                        // Reconciled out of band — the payment log still shows 'pending'
                        // from initiate because no callback ever arrived.
                        await logStatusCheck({
                            clientReference: payment.reference,
                            status: 'success',
                            transactionId: statusResult.transactionId ?? null,
                            amount: statusResult.amount ?? null,
                            message: statusResult.externalTransactionId
                                ? `Settled by reconciliation cron — no callback was received. Telco ref: ${statusResult.externalTransactionId}`
                                : 'Settled by reconciliation cron — no callback was received.',
                            raw: statusResult.raw,
                        })

                        results.credited++
                    } else if (new Date(payment.created_at) < failureCutoff) {
                        // 'Unpaid' / 'Refunded' well past the approval window — give up.
                        // Before the cutoff the customer may still approve the prompt,
                        // so an Unpaid reading is left alone.
                        await (supabase.from('wallet_payments') as any)
                            .update({ status: 'failed', updated_at: new Date().toISOString() })
                            .eq('id', payment.id)
                            .eq('status', 'pending')
                        await logStatusCheck({
                            clientReference: payment.reference,
                            status: 'failed',
                            transactionId: statusResult.transactionId ?? null,
                            message: `Given up by reconciliation cron after ${FAILURE_CUTOFF_MINUTES} minutes (Hubtel status: ${statusResult.status}).`,
                            raw: statusResult.raw,
                        })

                        results.failed++
                        console.log(`[CronHubtel] ❌ Payment ${payment.reference} marked failed (${statusResult.status})`)
                    } else {
                        results.stillPending++
                    }
                } catch (err: any) {
                    console.error(`[CronHubtel] Error for ${payment.id}:`, err)
                    results.errors.push(`${payment.reference}: ${err.message}`)
                }
            })

            await Promise.all(checkPromises)
        }
    } catch (err: any) {
        console.error('[CronHubtel] Sweep failed:', err)
        results.errors.push(`sweep: ${err.message}`)
    }

    results.totalTimeMs = Date.now() - startTime
    console.log('[CronHubtel] Run complete:', results)
    return NextResponse.json({ success: true, ...results })
}
