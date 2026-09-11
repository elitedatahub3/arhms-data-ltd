import { NextRequest, NextResponse } from 'next/server'
import { processCompletedWalletPayment } from '@/lib/payments'
import { createRouteHandlerClient } from '@/lib/supabase-server'
import { cookies } from 'next/headers'
import { checkPaymentStatus } from '@/lib/moolre-payment-service'
import { checkPaymentStatus as hubtelCheckPaymentStatus } from '@/lib/hubtel-payment-service'
import { checkPaymentStatus as payswitchCheckPaymentStatus } from '@/lib/payswitch-payment-service'
import {
    claimHubtelStatusCheck,
    PAYSWITCH_CLIENT_THROTTLE_KEYS,
    PAYSTACK_MOMO_CLIENT_THROTTLE_KEYS,
} from '@/lib/hubtel-status-throttle'
import { verifyTransaction } from '@/lib/paystack-momo-service'

export async function GET(request: NextRequest) {
    try {
        // Auth check — only the wallet owner (an authenticated user) may trigger verification
        const cookieStore = await cookies()
        const supabase = await createRouteHandlerClient()
        let { data: { user }, error: authError } = await supabase.auth.getUser()

        // Fallback for classifieds that sends token in Authorization header
        if (!user) {
            const authHeader = request.headers.get('authorization')
            if (authHeader && authHeader.startsWith('Bearer ')) {
                const token = authHeader.substring(7)
                const { data: jwtUser } = await supabase.auth.getUser(token)
                if (jwtUser?.user) {
                    user = jwtUser.user
                    authError = null
                }
            }
        }

        if (authError || !user) {
            return NextResponse.json(
                { error: 'Unauthorized' },
                { status: 401 }
            )
        }

        const { searchParams } = new URL(request.url)
        const reference = searchParams.get('reference')
        const isInline = request.headers.get('accept')?.includes('application/json')

        if (!reference) {
            if (isInline) {
                return NextResponse.json({ success: false, error: 'No reference provided' }, { status: 400 })
            }
            return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/dashboard/wallet?error=no_reference`)
        }

        const { data: paymentRecord, error: paymentLookupError } = await (supabase
            .from('wallet_payments') as any)
            .select('id, user_id, amount, total_amount, status, provider, provider_reference, metadata, created_at')
            .eq('reference', reference)
            .single()

        if (paymentLookupError || !paymentRecord) {
            if (isInline) {
                return NextResponse.json({ success: false, error: 'Payment not found' }, { status: 404 })
            }
            return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/dashboard/wallet?error=payment_not_found`)
        }

        if (paymentRecord.user_id !== user.id) {
            if (isInline) {
                return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
            }
            return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/dashboard/wallet?error=forbidden`)
        }

        // Fast-path: Check if webhook already processed it
        if (paymentRecord.status === 'completed') {
            // Direct-pay data orders: return what was actually bought. The webhook
            // usually settles before the first poll, so this is the normal path.
            if (reference.startsWith('DATA-')) {
                const orderRefs: string[] = (paymentRecord as any).metadata?.order_refs || []
                let placedOrders: any[] = []
                if (orderRefs.length > 0) {
                    const { data: orderRows } = await (supabase.from('orders') as any)
                        .select('id, reference_code, network, size, phone_number, price')
                        .in('reference_code', orderRefs)
                    placedOrders = orderRows || []
                }
                if (isInline) return NextResponse.json({ success: true, status: 'completed', message: 'Payment successful', orders: placedOrders })
                return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/dashboard/data-packages?success=true`)
            }
            if (isInline) return NextResponse.json({ success: true, status: 'completed', message: 'Payment successful' })
            return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/dashboard/wallet?success=true`)
        } else if (paymentRecord.status === 'failed') {
            if (isInline) return NextResponse.json({ success: false, status: 'failed', message: 'Payment failed' }, { status: 400 })
            return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/dashboard/wallet?error=payment_failed`)
        }

        // For hosted-checkout Paystack: the webhook handles completion; just return
        // pending so the frontend keeps polling.
        if ((paymentRecord as any).provider === 'paystack') {
            if (isInline) return NextResponse.json({ success: true, status: 'pending', message: 'Waiting for payment confirmation...' })
            return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/dashboard/wallet`)
        }

        // ── Paystack MoMo status check ────────────────────────────────────────
        if ((paymentRecord as any).provider === 'paystack_momo') {
            // Unlike hosted checkout, this rail cannot just wait for the webhook.
            // Paystack emits charge.success and nothing else, so a declined or
            // abandoned prompt produces NO callback at all — without asking the
            // gateway, the tab would poll forever on a payment that is already dead.
            //
            // Bounded the same way as Hubtel and PaySwitch above. Past the cap the
            // reconciliation sweep settles it with no tab open.
            const decision = await claimHubtelStatusCheck(supabase, paymentRecord as any, {
                graceMs: 45_000,
                interval: 20_000,
                maxChecks: 5,
                keys: PAYSTACK_MOMO_CLIENT_THROTTLE_KEYS,
            })

            if (!decision.allowed) {
                if (isInline) return NextResponse.json({ success: true, status: 'pending', message: 'Waiting for payment confirmation...' })
                return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/dashboard/wallet`)
            }

            const verified = await verifyTransaction(reference)

            // 'otp' means the customer still owes us a code, which is a pending state
            // from this endpoint's point of view, not a failure.
            if (verified.outcome === 'pending' || verified.outcome === 'otp') {
                if (isInline) return NextResponse.json({ success: true, status: 'pending', message: 'Waiting for payment confirmation...' })
                return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/dashboard/wallet`)
            }

            if (verified.outcome === 'failed') {
                await (supabase.from('wallet_payments') as any)
                    .update({ status: 'failed' })
                    .eq('id', paymentRecord.id)
                    .eq('status', 'pending')
                if (isInline) return NextResponse.json({ success: false, status: 'failed', message: 'Payment failed' })
                return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/dashboard/wallet?error=payment_failed`)
            }

            // Paid. Same rule as the Hubtel branch: DATA- and UTIL- must be settled
            // here, because the generic tail below queries Moolre, which cannot verify
            // a Paystack reference — falling through would credit the wallet instead
            // of delivering what the customer actually bought.
            if (reference.startsWith('DATA-')) {
                const { processDataDirectOrder } = await import('@/lib/data-order-payments')
                const result = await processDataDirectOrder(reference, user.id)
                if (!result.success) {
                    if (isInline) return NextResponse.json({ success: false, status: 'failed', error: result.error || 'Order processing failed' }, { status: 500 })
                    return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/dashboard/data-packages?error=order_failed`)
                }
                if (isInline) return NextResponse.json({ success: true, status: 'completed', message: 'Payment successful', orders: result.orders || [] })
                return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/dashboard/data-packages?success=true`)
            }

            if (reference.startsWith('UTIL-')) {
                const { processUtilityDirectOrder } = await import('@/lib/utility-order-payments')
                const result = await processUtilityDirectOrder(reference, user.id)
                if (!result.success) {
                    if (isInline) return NextResponse.json({ success: false, status: 'failed', error: result.error || 'Bill payment failed' }, { status: 500 })
                    return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/dashboard/utilities?error=order_failed`)
                }
                if (isInline) return NextResponse.json({ success: true, status: 'completed', message: 'Payment successful', order: result.order })
                return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/dashboard/utilities?success=true`)
            }

            if (reference.startsWith('AIRPAY-')) {
                const { processAirtimeDirectOrder } = await import('@/lib/airtime-order-payments')
                const result = await processAirtimeDirectOrder(reference, user.id)
                if (!result.success) {
                    if (isInline) return NextResponse.json({ success: false, status: 'failed', error: result.error || 'Airtime purchase failed' }, { status: 500 })
                    return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/dashboard/airtime?error=order_failed`)
                }
                if (isInline) return NextResponse.json({ success: true, status: 'completed', message: 'Payment successful', order: result.order })
                return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/dashboard/airtime?success=true`)
            }

            if (reference.startsWith('BOOST-')) {
                const { processBoostPayment } = await import('@/lib/classifieds-payments')
                const boostResult = await processBoostPayment(reference)
                if (!boostResult.success && !boostResult.alreadyProcessed) {
                    if (isInline) return NextResponse.json({ success: false, status: 'failed', error: boostResult.error || 'Boost processing failed' }, { status: 500 })
                    return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/classifieds/seller/dashboard?boost_error=true`)
                }
                if (isInline) return NextResponse.json({ success: true, status: 'completed', message: 'Boost activated!' })
                return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/classifieds/seller/dashboard?boost_success=true`)
            }

            // Everything else settles here and RETURNS. This branch must NOT fall
            // through the way the Hubtel one does: the tail below queries Moolre,
            // which cannot verify a Paystack reference and would leave a charge that
            // has already been paid looking unverifiable forever.
            const expectedAmountPesewas = Math.round(Number(paymentRecord.total_amount || paymentRecord.amount) * 100)
            const settleResult = await processCompletedWalletPayment(
                reference,
                {
                    reference,
                    // Paystack's own figure is authoritative over anything we stored.
                    amount: verified.amountPesewas ?? expectedAmountPesewas,
                    metadata: (paymentRecord as any).metadata || {},
                },
                user.id
            )

            if (!settleResult.success) {
                if (isInline) return NextResponse.json({ success: false, status: 'failed', error: settleResult.error || 'Processing failed' }, { status: 500 })
                return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/dashboard/wallet?error=${settleResult.error || 'processing_failed'}`)
            }

            if (isInline) return NextResponse.json({ success: true, status: 'completed', message: 'Payment successful' })
            return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/dashboard/wallet?success=true`)
        }

        // ── Hubtel status check ───────────────────────────────────────────────
        if ((paymentRecord as any).provider === 'hubtel') {
            // The client polls this endpoint every 3 seconds. Hubtel's status API is
            // reached through a metered static-IP proxy, so calling it on every poll
            // burned roughly 20 proxy requests per payment and exhausted the monthly
            // quota after ~25 top-ups — which then broke payments outright with a 407.
            //
            // Hubtel confirms via webhook, and the DB fast-path above already catches
            // that. So treat the status API as a FALLBACK for when the webhook does not
            // arrive: stay quiet for a grace period, poll at a slow interval, then stop
            // (see lib/hubtel-status-throttle.ts for why the hard cap is the load-bearing
            // part). Past the cap the webhook and the reconciliation sweep
            // (/api/cron/verify-hubtel-payments) are the safety net — neither depends on
            // anyone keeping a browser tab open.
            const decision = await claimHubtelStatusCheck(supabase, paymentRecord as any, {
                graceMs: 45_000,       // give the callback time to land
                interval: 20_000,
                maxChecks: 5,
            })

            if (!decision.allowed) {
                if (isInline) return NextResponse.json({ success: true, status: 'pending', message: 'Waiting for payment confirmation...' })
                return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/dashboard/wallet`)
            }

            const hubtelResponse = await hubtelCheckPaymentStatus(reference)

            if (!hubtelResponse.success || hubtelResponse.status === null) {
                console.error('[PaymentVerify] Hubtel verification failed:', hubtelResponse.error)
                if (isInline) return NextResponse.json({ success: false, status: 'pending', error: 'Payment verification pending' })
                return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/dashboard/wallet`)
            }

            if (hubtelResponse.status === 'Unpaid') {
                if (isInline) return NextResponse.json({ success: true, status: 'pending', message: 'Payment pending' })
                return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/dashboard/wallet`)
            }

            if (hubtelResponse.status === 'Refunded' || (hubtelResponse.status !== 'Paid')) {
                // Any status other than 'Paid' is treated as failed
                await (supabase.from('wallet_payments') as any).update({ status: 'failed' }).eq('id', paymentRecord.id)
                if (isInline) return NextResponse.json({ success: false, status: 'failed', message: 'Payment failed or refunded' })
                return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/dashboard/wallet?error=payment_failed`)
            }

            // hubtelResponse.status === 'Paid' — settle direct-pay data orders here.
            // The generic path below queries Moolre, which cannot verify a Hubtel
            // reference, so a DATA- order must be settled before we reach it.
            if (reference.startsWith('DATA-')) {
                const { processDataDirectOrder } = await import('@/lib/data-order-payments')
                const result = await processDataDirectOrder(reference, user.id)
                if (!result.success) {
                    if (isInline) return NextResponse.json({ success: false, status: 'failed', error: result.error || 'Order processing failed' }, { status: 500 })
                    return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/dashboard/data-packages?error=order_failed`)
                }
                if (isInline) return NextResponse.json({ success: true, status: 'completed', message: 'Payment successful', orders: result.orders || [] })
                return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/dashboard/data-packages?success=true`)
            }

            // UTIL- has the same problem: the Moolre tail below cannot verify a
            // Hubtel reference, and falling through would credit the wallet instead
            // of paying the customer's bill.
            if (reference.startsWith('UTIL-')) {
                const { processUtilityDirectOrder } = await import('@/lib/utility-order-payments')
                const result = await processUtilityDirectOrder(reference, user.id)
                if (!result.success) {
                    if (isInline) return NextResponse.json({ success: false, status: 'failed', error: result.error || 'Bill payment failed' }, { status: 500 })
                    return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/dashboard/utilities?error=order_failed`)
                }
                if (isInline) return NextResponse.json({ success: true, status: 'completed', message: 'Payment successful', order: result.order })
                return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/dashboard/utilities?success=true`)
            }

            if (reference.startsWith('AIRPAY-')) {
                const { processAirtimeDirectOrder } = await import('@/lib/airtime-order-payments')
                const result = await processAirtimeDirectOrder(reference, user.id)
                if (!result.success) {
                    if (isInline) return NextResponse.json({ success: false, status: 'failed', error: result.error || 'Airtime purchase failed' }, { status: 500 })
                    return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/dashboard/airtime?error=order_failed`)
                }
                if (isInline) return NextResponse.json({ success: true, status: 'completed', message: 'Payment successful', order: result.order })
                return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/dashboard/airtime?success=true`)
            }

            // fall through to process payment below
        }

        // ── PaySwitch status check ────────────────────────────────────────────
        if ((paymentRecord as any).provider === 'payswitch') {
            // Same budget reasoning as Hubtel above — the callback settles this in
            // the normal case and the DB fast-path returns as soon as it does, so
            // the status API only needs a small bounded fallback allowance. Past the
            // cap, the callback and /api/cron/verify-payswitch-payments still settle
            // it without anyone keeping a tab open.
            const decision = await claimHubtelStatusCheck(supabase, paymentRecord as any, {
                graceMs: 45_000,
                interval: 20_000,
                maxChecks: 5,
                keys: PAYSWITCH_CLIENT_THROTTLE_KEYS,
            })

            if (!decision.allowed) {
                if (isInline) return NextResponse.json({ success: true, status: 'pending', message: 'Waiting for payment confirmation...' })
                return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/dashboard/wallet`)
            }

            const psResponse = await payswitchCheckPaymentStatus(String((paymentRecord as any).provider_reference || ''))

            if (!psResponse.success || psResponse.outcome === null) {
                console.error('[PaymentVerify] PaySwitch verification failed:', psResponse.error)
                if (isInline) return NextResponse.json({ success: false, status: 'pending', error: 'Payment verification pending' })
                return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/dashboard/wallet`)
            }

            if (psResponse.outcome === 'pending') {
                if (isInline) return NextResponse.json({ success: true, status: 'pending', message: 'Payment pending' })
                return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/dashboard/wallet`)
            }

            if (psResponse.outcome === 'failed') {
                await (supabase.from('wallet_payments') as any).update({ status: 'failed' }).eq('id', paymentRecord.id)
                if (isInline) return NextResponse.json({ success: false, status: 'failed', message: 'Payment failed' })
                return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/dashboard/wallet?error=payment_failed`)
            }

            // Paid — settle direct-pay data orders here. The generic tail below
            // queries MOOLRE, which cannot verify a PaySwitch reference, so a DATA-
            // order must be settled before we reach it.
            if (reference.startsWith('DATA-')) {
                const { processDataDirectOrder } = await import('@/lib/data-order-payments')
                const result = await processDataDirectOrder(reference, user.id)
                if (!result.success) {
                    if (isInline) return NextResponse.json({ success: false, status: 'failed', error: result.error || 'Order processing failed' }, { status: 500 })
                    return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/dashboard/data-packages?error=order_failed`)
                }
                if (isInline) return NextResponse.json({ success: true, status: 'completed', message: 'Payment successful', orders: result.orders || [] })
                return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/dashboard/data-packages?success=true`)
            }

            // UTIL- has the same problem.
            if (reference.startsWith('UTIL-')) {
                const { processUtilityDirectOrder } = await import('@/lib/utility-order-payments')
                const result = await processUtilityDirectOrder(reference, user.id)
                if (!result.success) {
                    if (isInline) return NextResponse.json({ success: false, status: 'failed', error: result.error || 'Bill payment failed' }, { status: 500 })
                    return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/dashboard/utilities?error=order_failed`)
                }
                if (isInline) return NextResponse.json({ success: true, status: 'completed', message: 'Payment successful', order: result.order })
                return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/dashboard/utilities?success=true`)
            }

            if (reference.startsWith('AIRPAY-')) {
                const { processAirtimeDirectOrder } = await import('@/lib/airtime-order-payments')
                const result = await processAirtimeDirectOrder(reference, user.id)
                if (!result.success) {
                    if (isInline) return NextResponse.json({ success: false, status: 'failed', error: result.error || 'Airtime purchase failed' }, { status: 500 })
                    return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/dashboard/airtime?error=order_failed`)
                }
                if (isInline) return NextResponse.json({ success: true, status: 'completed', message: 'Payment successful', order: result.order })
                return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/dashboard/airtime?success=true`)
            }

            // BOOST- has the same problem: the Moolre tail below would reject it.
            if (reference.startsWith('BOOST-')) {
                const { processBoostPayment } = await import('@/lib/classifieds-payments')
                const result = await processBoostPayment(reference)
                if (!result.success && !result.alreadyProcessed) {
                    if (isInline) return NextResponse.json({ success: false, status: 'failed', error: result.error || 'Boost processing failed' }, { status: 500 })
                    return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/classifieds/seller/dashboard?boost_error=true`)
                }
                if (isInline) return NextResponse.json({ success: true, status: 'completed', message: 'Boost activated!' })
                return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/classifieds/seller/dashboard?boost_success=true`)
            }

            // Wallet top-ups and upgrades fall through to the shared settle path,
            // but must skip the Moolre query — hence the early jump below.
            const expectedAmountPesewas = Math.round(Number(paymentRecord.total_amount || paymentRecord.amount) * 100)
            const result = await processCompletedWalletPayment(
                reference,
                { reference, amount: expectedAmountPesewas, metadata: (paymentRecord as any).metadata || {} },
                user.id
            )

            if (!result.success) {
                if (isInline) return NextResponse.json({ success: false, status: 'failed', error: result.error || 'Processing failed' }, { status: 500 })
                return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/dashboard/wallet?error=${result.error || 'processing_failed'}`)
            }

            if (isInline) return NextResponse.json({ success: true, status: 'completed', message: 'Payment successful' })
            return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/dashboard/wallet?success=true`)
        }

        // Verify with Moolre
        const moolreResponse = await checkPaymentStatus(reference)

        if (!moolreResponse.success || moolreResponse.txstatus === null) {
            console.error('[PaymentVerify] Moolre verification failed:', moolreResponse.error)
            // Do not fail the transaction immediately on network error, just return pending so frontend keeps polling
            if (isInline) {
                return NextResponse.json({ success: false, status: 'pending', error: 'Payment verification pending' })
            }
            return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/dashboard/wallet`)
        }

        if (moolreResponse.txstatus === 0 || moolreResponse.txstatus === 3) {
            // Still pending
            if (isInline) return NextResponse.json({ success: true, status: 'pending', message: 'Payment pending' })
            return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/dashboard/wallet`)
        }

        if (moolreResponse.txstatus === 2) {
            // Failed
            await (supabase.from('wallet_payments') as any).update({ status: 'failed' }).eq('id', paymentRecord.id)
            if (isInline) return NextResponse.json({ success: false, status: 'failed', message: 'Payment failed' })
            return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/dashboard/wallet?error=payment_failed`)
        }

        // Processing successful payment (txstatus === 1)
        // For DATA- references, delegate to the data order processor. Without this
        // the payment would fall through below and CREDIT THE WALLET instead of
        // creating and fulfilling the data bundle order.
        if (reference.startsWith('DATA-')) {
            const { processDataDirectOrder } = await import('@/lib/data-order-payments')
            const result = await processDataDirectOrder(reference, user.id)
            if (!result.success) {
                if (isInline) return NextResponse.json({ success: false, status: 'failed', error: result.error || 'Order processing failed' }, { status: 500 })
                return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/dashboard/data-packages?error=order_failed`)
            }
            if (isInline) return NextResponse.json({ success: true, status: 'completed', message: 'Payment successful', orders: (result as any).orders })
            return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/dashboard/data-packages?success=true`)
        }

        // For UTIL- references, delegate to the utility bill processor. Without this
        // the payment would fall through below and CREDIT THE WALLET instead of
        // paying the customer's bill.
        if (reference.startsWith('UTIL-')) {
            const { processUtilityDirectOrder } = await import('@/lib/utility-order-payments')
            const result = await processUtilityDirectOrder(reference, user.id)
            if (!result.success) {
                if (isInline) return NextResponse.json({ success: false, status: 'failed', error: result.error || 'Bill payment failed' }, { status: 500 })
                return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/dashboard/utilities?error=order_failed`)
            }
            if (isInline) return NextResponse.json({ success: true, status: 'completed', message: 'Payment successful', order: result.order })
            return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/dashboard/utilities?success=true`)
        }

        if (reference.startsWith('AIRPAY-')) {
            const { processAirtimeDirectOrder } = await import('@/lib/airtime-order-payments')
            const result = await processAirtimeDirectOrder(reference, user.id)
            if (!result.success) {
                if (isInline) return NextResponse.json({ success: false, status: 'failed', error: result.error || 'Airtime purchase failed' }, { status: 500 })
                return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/dashboard/airtime?error=order_failed`)
            }
            if (isInline) return NextResponse.json({ success: true, status: 'completed', message: 'Payment successful', order: result.order })
            return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/dashboard/airtime?success=true`)
        }

        // For BOOST- references, delegate to the boost processor
        if (reference.startsWith('BOOST-')) {
            const { processBoostPayment } = await import('@/lib/classifieds-payments')
            const result = await processBoostPayment(reference)
            if (!result.success && !result.alreadyProcessed) {
                if (isInline) return NextResponse.json({ success: false, status: 'failed', error: result.error || 'Boost processing failed' }, { status: 500 })
                return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/classifieds/seller/dashboard?boost_error=true`)
            }
            if (isInline) return NextResponse.json({ success: true, status: 'completed', message: 'Boost activated!' })
            return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/classifieds/seller/dashboard?boost_success=true`)
        }

        // For ussd_activation_ references, mint the short code. Without this the
        // payment falls through below and CREDITS THE WALLET instead of activating.
        if (reference.startsWith('ussd_activation_')) {
            const { processCompletedUssdActivation } = await import('@/lib/payments')
            const result = await processCompletedUssdActivation(reference, {
                reference,
                amount: Math.round(Number(paymentRecord.total_amount || paymentRecord.amount) * 100),
                metadata: (paymentRecord as any).metadata || {},
            })
            if (!result.success) {
                if (isInline) return NextResponse.json({ success: false, status: 'failed', error: result.error || 'Activation failed' }, { status: 500 })
                return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/dashboard/shop/ussd?error=activation_failed`)
            }
            if (isInline) return NextResponse.json({ success: true, status: 'completed', message: 'Short code activated!', shortCode: (result as any).shortCode })
            return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/dashboard/shop/ussd?success=true`)
        }

        // Note: processCompletedWalletPayment expects Paystack-like payload format `amount` in kobo/pesewas
        const expectedAmountPesewas = Math.round(Number(paymentRecord.total_amount || paymentRecord.amount) * 100)
        
        const eventData = {
            reference: reference,
            amount: expectedAmountPesewas,
            metadata: (paymentRecord as any).metadata || {}
        }

        const result = await processCompletedWalletPayment(reference, eventData, user.id)

        if (!result.success) {
            if (isInline) {
                return NextResponse.json({ success: false, status: 'failed', error: result.error || 'Processing failed' }, { status: 500 })
            }
            return NextResponse.redirect(
                `${process.env.NEXT_PUBLIC_APP_URL}/dashboard/wallet?error=${result.error || 'processing_failed'}`
            )
        }

        if (isInline) {
            return NextResponse.json({ success: true, status: 'completed', message: 'Payment successful' })
        }
        return NextResponse.redirect(
            `${process.env.NEXT_PUBLIC_APP_URL}/dashboard/wallet?success=true`
        )
    } catch (error) {
        console.error('[PaymentVerify] Verification error:', error)
        const isInline = request.headers.get('accept')?.includes('application/json')
        if (isInline) {
            return NextResponse.json({ success: false, error: 'Verification failed' }, { status: 500 })
        }
        return NextResponse.redirect(
            `${process.env.NEXT_PUBLIC_APP_URL}/dashboard/wallet?error=verification_failed`
        )
    }
}
