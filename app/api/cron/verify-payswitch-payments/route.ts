/**
 * PaySwitch reconciliation sweep.
 *
 * The safety net for a callback that never arrived. Unlike the client poll in
 * /api/payments/verify, this needs nobody to keep a browser tab open — which is
 * exactly the case where a customer approves the prompt, closes the page, and
 * would otherwise never be credited.
 *
 * Mirrors /api/cron/verify-moolre-payments. Two differences worth knowing:
 *   • PaySwitch is queried by its 12-digit transaction_id, so rows without a
 *     provider_reference are unreachable and skipped.
 *   • Status checks are throttled on the CRON budget (separate metadata keys from
 *     the browser poll), so the two cannot starve each other — see
 *     lib/hubtel-status-throttle.ts.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { checkPaymentStatus } from '@/lib/payswitch-payment-service'
import { claimHubtelStatusCheck, PAYSWITCH_CRON_THROTTLE_KEYS } from '@/lib/hubtel-status-throttle'
import { processCompletedWalletPayment, processCompletedUpgradePayment, processCompletedDealerSubscription } from '@/lib/payments'
import { Redis } from '@upstash/redis'

const redis = Redis.fromEnv()

export async function GET(request: NextRequest) {
    const startTime = Date.now()

    const authHeader = request.headers.get('authorization')
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const supabase = createServerClient()
    const results = {
        walletChecked: 0,
        walletCredited: 0,
        walletFailed: 0,
        walletSkipped: 0,
        shopChecked: 0,
        shopProcessed: 0,
        shopFailed: 0,
        errors: [] as string[],
        totalTimeMs: 0,
    }

    // ── Part A: pending wallet_payments-backed flows ──────────────────────────
    try {
        const threeMinutesAgo = new Date(Date.now() - 3 * 60 * 1000).toISOString()

        const { data: pendingPayments, error: fetchError } = await (supabase
            .from('wallet_payments') as any)
            .select('id, reference, provider_reference, total_amount, amount, status, metadata, user_id, created_at')
            .eq('status', 'pending')
            .eq('provider', 'payswitch')
            .lt('created_at', threeMinutesAgo)
            .limit(10)

        if (fetchError) {
            console.error('[CronPayswitch] wallet_payments query error:', fetchError)
            results.errors.push(`wallet_payments query: ${fetchError.message}`)
        } else if (pendingPayments && pendingPayments.length > 0) {
            const checkPromises = pendingPayments.map(async (payment: any) => {
                try {
                    if (!payment.provider_reference) {
                        // Initiation died before an id was claimed — nothing to query.
                        results.walletSkipped++
                        return
                    }

                    const decision = await claimHubtelStatusCheck(supabase, payment, {
                        graceMs: 0,          // the 3-minute age filter above is the grace window
                        interval: 5 * 60_000,
                        maxChecks: 6,
                        keys: PAYSWITCH_CRON_THROTTLE_KEYS,
                    })

                    if (!decision.allowed) {
                        results.walletSkipped++
                        return
                    }

                    results.walletChecked++
                    const statusResult = await checkPaymentStatus(String(payment.provider_reference))

                    if (!statusResult.success || statusResult.outcome === null || statusResult.outcome === 'pending') {
                        return
                    }

                    if (statusResult.outcome === 'failed') {
                        await (supabase.from('wallet_payments') as any)
                            .update({ status: 'failed', updated_at: new Date().toISOString() })
                            .eq('id', payment.id)
                        results.walletFailed++
                        console.log(`[CronPayswitch] Payment ${payment.reference} failed`)
                        return
                    }

                    // outcome === 'paid'
                    const paidAmountPesewas = Math.round(Number(payment.total_amount || payment.amount) * 100)
                    const metadata = payment.metadata || {}
                    const eventData = { reference: payment.reference, amount: paidAmountPesewas, metadata }

                    if (payment.reference.startsWith('DATA-')) {
                        const { processDataDirectOrder } = await import('@/lib/data-order-payments')
                        const dataResult = await processDataDirectOrder(payment.reference)
                        if (dataResult.success || dataResult.alreadyProcessed) {
                            results.walletCredited++
                            console.log(`[CronPayswitch] Data order ${payment.reference} settled`)
                        } else {
                            console.error(`[CronPayswitch] Data order ${payment.reference} failed:`, dataResult.error)
                        }
                    } else if (payment.reference.startsWith('UTIL-')) {
                        const { processUtilityDirectOrder } = await import('@/lib/utility-order-payments')
                        const utilResult = await processUtilityDirectOrder(payment.reference)
                        if (utilResult.success || utilResult.alreadyProcessed) {
                            results.walletCredited++
                            console.log(`[CronPayswitch] Utility bill ${payment.reference} settled`)
                        } else {
                            console.error(`[CronPayswitch] Utility bill ${payment.reference} failed:`, utilResult.error)
                        }
                    } else if (payment.reference.startsWith('AIRPAY-')) {
                        const { processAirtimeDirectOrder } = await import('@/lib/airtime-order-payments')
                        const airResult = await processAirtimeDirectOrder(payment.reference)
                        if (airResult.success || airResult.alreadyProcessed) {
                            results.walletCredited++
                            console.log(`[CronPayswitch] Airtime order ${payment.reference} settled`)
                        } else {
                            console.error(`[CronPayswitch] Airtime order ${payment.reference} failed:`, airResult.error)
                        }
                    } else if (payment.reference.startsWith('BOOST-')) {
                        const { processBoostPayment } = await import('@/lib/classifieds-payments')
                        const boostResult = await processBoostPayment(payment.reference)
                        if (boostResult.success || boostResult.alreadyProcessed) {
                            results.walletCredited++
                            console.log(`[CronPayswitch] Boost payment ${payment.reference} credited`)
                        } else {
                            console.error(`[CronPayswitch] Boost payment ${payment.reference} failed:`, boostResult.error)
                        }
                    } else if (payment.reference.startsWith('agent_upgrade_') || metadata.upgrade_type === 'agent') {
                        await processCompletedUpgradePayment(payment.reference, eventData)
                        results.walletCredited++
                        console.log(`[CronPayswitch] Agent upgrade ${payment.reference} credited`)
                    } else if (payment.reference.startsWith('ussd_activation_') || metadata.upgrade_type === 'ussd_activation') {
                        const { processCompletedUssdActivation } = await import('@/lib/payments')
                        await processCompletedUssdActivation(payment.reference, eventData)
                        results.walletCredited++
                        console.log(`[CronPayswitch] USSD activation ${payment.reference} activated`)
                    } else if (payment.reference.startsWith('dealer_sub_') || metadata.upgrade_type === 'dealer_subscription') {
                        await processCompletedDealerSubscription(payment.reference, eventData)
                        results.walletCredited++
                        console.log(`[CronPayswitch] Dealer subscription ${payment.reference} activated`)
                    } else {
                        await processCompletedWalletPayment(payment.reference, eventData, payment.user_id)
                        results.walletCredited++
                        console.log(`[CronPayswitch] Wallet payment ${payment.reference} credited`)
                    }
                } catch (err: any) {
                    console.error(`[CronPayswitch] Wallet error for ${payment.id}:`, err)
                    results.errors.push(`wallet ${payment.id}: ${err.message}`)
                }
            })

            await Promise.all(checkPromises)
        }
    } catch (partAErr: any) {
        console.error('[CronPayswitch] Part A (wallet) failed:', partAErr)
        results.errors.push(`Part A: ${partAErr.message}`)
    }

    // ── Part B: storefront orders stuck in Redis ──────────────────────────────
    // The shop flow writes no wallet_payments row, so Part A cannot see it. Scan
    // the id->reference map instead: it is written for exactly the flows that have
    // no DB row, and its value is the reference we need.
    try {
        let cursor = 0
        const refKeys: string[] = []

        do {
            const [nextCursor, keys] = await redis.scan(cursor, { match: 'payswitch:ref:*', count: 10 })
            cursor = typeof nextCursor === 'string' ? parseInt(nextCursor) : nextCursor
            refKeys.push(...keys)
            if (refKeys.length >= 10) break
        } while (cursor !== 0)

        if (refKeys.length > 0) {
            const shopPromises = refKeys.map(async (key) => {
                try {
                    const transactionId = key.replace('payswitch:ref:', '')
                    const reference = await redis.get<string>(key)
                    if (!reference) return

                    // RC- orders are settled by finalizeRCGatewayOrder off the callback
                    // and by /api/shop/rc/verify; only storefront orders are swept here,
                    // matching what the Moolre cron covers.
                    if (!String(reference).startsWith('SHOP-')) return

                    results.shopChecked++

                    const { data: existingOrder } = await (supabase.from('shop_orders') as any)
                        .select('id')
                        .eq('reference', reference)
                        .maybeSingle()

                    if (existingOrder) {
                        await redis.del(key)
                        return
                    }

                    const statusResult = await checkPaymentStatus(transactionId)
                    if (!statusResult.success || statusResult.outcome === null || statusResult.outcome === 'pending') {
                        return
                    }

                    if (statusResult.outcome === 'failed') {
                        await redis.del(key)
                        results.shopFailed++
                        return
                    }

                    const metadataStr = await redis.get<string>(`shop:meta:${reference}`)
                    if (!metadataStr) return

                    let metadata: any
                    try {
                        metadata = typeof metadataStr === 'string' ? JSON.parse(metadataStr) : metadataStr
                    } catch {
                        metadata = metadataStr
                    }

                    const sellingPrice = parseFloat(metadata.selling_price || '0')
                    const paystackFee = parseFloat(metadata.paystack_fee || '0')
                    const feeAmount = parseFloat(metadata.fee_amount || '0')
                    const fallbackPesewas = Math.round((sellingPrice + paystackFee + feeAmount) * 100)
                    const paidAmountPesewas =
                        statusResult.amount !== undefined ? Math.round(statusResult.amount * 100) : fallbackPesewas

                    const { processShopOrder } = await import('@/lib/shop-order-processor')
                    console.log(`[CronPayswitch] Processing missed shop order: ${reference}`)
                    await processShopOrder(reference, metadata, paidAmountPesewas, metadata?.shop_slug)

                    results.shopProcessed++
                } catch (err: any) {
                    console.error(`[CronPayswitch] Shop error for key ${key}:`, err)
                    results.errors.push(`shop ${key}: ${err.message}`)
                }
            })

            await Promise.all(shopPromises)
        }
    } catch (partBErr: any) {
        console.error('[CronPayswitch] Part B (shop) failed:', partBErr)
        results.errors.push(`Part B: ${partBErr.message}`)
    }

    results.totalTimeMs = Date.now() - startTime
    console.log('[CronPayswitch] Run complete:', results)
    return NextResponse.json({ success: true, ...results })
}
