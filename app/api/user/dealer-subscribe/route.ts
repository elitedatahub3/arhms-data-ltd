import { NextRequest, NextResponse } from 'next/server'
import { createRouteHandlerClient } from '@/lib/supabase-server'
import { cookies } from 'next/headers'
import { createClient } from '@supabase/supabase-js'
import { generateReferenceCode } from '@/lib/utils'
import { initiatePayment, checkPaymentStatus, MOOLRE_PAYMENT_CHANNEL_MAP } from '@/lib/moolre-payment-service'
import {
    initiatePayment as hubtelInitiatePayment,
    checkPaymentStatus as hubtelCheckPaymentStatus,
    HUBTEL_CHANNEL_MAP,
} from '@/lib/hubtel-payment-service'
import {
    initiatePayment as payswitchInitiatePayment,
    checkPaymentStatus as payswitchCheckPaymentStatus,
    PAYSWITCH_CHANNEL_MAP,
} from '@/lib/payswitch-payment-service'
import { assignPayswitchTransactionId } from '@/lib/payswitch-reference'
import { resolveProviderForScope, isPaymentProvider, type PaymentProvider } from '@/lib/payment-provider'
import { paystackMomoProviderFor, verifyTransaction } from '@/lib/paystack-momo-service'
import {
    startPaystackMomoCharge,
    submitPaystackMomoOtp,
    assertOwnPendingPayment,
    type MomoChargeResult,
} from '@/lib/paystack-momo-checkout'
import { claimHubtelStatusCheck, PAYSWITCH_CLIENT_THROTTLE_KEYS } from '@/lib/hubtel-status-throttle'
import { processCompletedDealerSubscription } from '@/lib/payments'

export async function POST(request: NextRequest) {
    try {
        const cookieStore = await cookies()
        const supabase = await createRouteHandlerClient()
        const { data: { user: authUser }, error: authError } = await supabase.auth.getUser()

        if (authError || !authUser) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const { phone, network, otpCode, reference: existingRef, planType: rawPlanType, provider: bodyProvider } = await request.json().catch(() => ({}))

        const planType: 'dealer_3m' | 'dealer_6m' = rawPlanType === 'dealer_3m' ? 'dealer_3m' : 'dealer_6m'
        const planDays = planType === 'dealer_3m' ? 90 : 180
        const planLabel = planType === 'dealer_3m' ? '3 Months Dealer Subscription' : '6 Months Dealer Subscription'

        const { data: dbUser } = await supabase
            .from('users')
            .select('role, dealer_expires_at')
            .eq('id', authUser.id)
            .single()

        if (!dbUser || !['customer', 'dealer', 'agent'].includes((dbUser as any).role)) {
            return NextResponse.json({ error: 'Only customers, agents, and dealers can subscribe to the dealership plan' }, { status: 400 })
        }

        const supabaseAdmin = createClient(
            process.env.NEXT_PUBLIC_SUPABASE_URL!,
            process.env.SUPABASE_SERVICE_ROLE_KEY!,
            { auth: { autoRefreshToken: false, persistSession: false } }
        )

        const { data: settings } = await supabaseAdmin
            .from('admin_settings')
            .select('key, value')
            .in('key', ['dealer_subscription_price_6m', 'dealer_subscription_price_3m', 'active_payment_provider_web'])

        const settingsMap: Record<string, string> = {}
        for (const row of (settings || [])) settingsMap[row.key] = row.value

        // The admin setting is the only source of truth. The body used to win, which
        // let a client pick the gateway that collects its own payment — and once a
        // gateway exists that the UI has not been taught to drive, that is a request
        // shaped for one rail being charged on another. Logged rather than rejected
        // so an older client keeps working instead of failing at checkout.
        if (bodyProvider && isPaymentProvider(bodyProvider)) {
            const resolved = resolveProviderForScope(settingsMap.active_payment_provider_web, 'web')
            if (bodyProvider !== resolved) {
                console.warn(
                    `[DealerSubscribe] Ignoring client-supplied provider '${bodyProvider}'; using '${resolved}' from active_payment_provider_web.`
                )
            }
        }
        const provider: PaymentProvider = resolveProviderForScope(
            settingsMap.active_payment_provider_web,
            'web'
        )

        const priceKey = planType === 'dealer_3m' ? 'dealer_subscription_price_3m' : 'dealer_subscription_price_6m'
        const subscriptionPrice = parseFloat(settingsMap[priceKey] || '0')

        if (!subscriptionPrice || subscriptionPrice <= 0) {
            return NextResponse.json({ error: 'Dealer subscription price not configured' }, { status: 400 })
        }

        if (provider === 'moolre') {
            const channelId = phone && MOOLRE_PAYMENT_CHANNEL_MAP[network]
            if (!phone || !network || !channelId) {
                return NextResponse.json({ error: 'Phone number and network are required' }, { status: 400 })
            }
        }

        if (provider === 'hubtel') {
            if (!phone || !network || !HUBTEL_CHANNEL_MAP[network]) {
                return NextResponse.json({ error: 'Phone number and network are required for Hubtel payment' }, { status: 400 })
            }
        }

        if (provider === 'payswitch') {
            if (!phone || !network || !PAYSWITCH_CHANNEL_MAP[network]) {
                return NextResponse.json({ error: 'Phone number and network are required for PaySwitch payment' }, { status: 400 })
            }
        }

        const reference = existingRef || `dealer_sub_${generateReferenceCode()}`

        const { data: wallet } = await supabaseAdmin
            .from('wallets')
            .select('id')
            .eq('user_id', authUser.id)
            .single()

        if (!wallet) throw new Error('User wallet not found')

        if (!existingRef) {
            const { error: paymentError } = await (supabaseAdmin.from('wallet_payments') as any)
                .insert({
                    user_id: authUser.id,
                    wallet_id: (wallet as any).id,
                    amount: subscriptionPrice,
                    fee: 0,
                    total_amount: subscriptionPrice,
                    reference,
                    provider,
                    status: 'pending',
                    metadata: {
                        user_id: authUser.id,
                        upgrade_type: 'dealer_subscription',
                        plan_type: planType,
                        plan_days: planDays,
                        plan_label: planLabel,
                        base_amount: subscriptionPrice,
                        fee: 0,
                    },
                })

            if (paymentError) {
                console.error('[DealerSubscribe] Insert payment error:', paymentError)
                throw new Error('Failed to record payment attempt')
            }
        }

        if (provider === 'paystack') {
            const { data: userProfile } = await supabaseAdmin
                .from('users')
                .select('email')
                .eq('id', authUser.id)
                .single()

            const paystackRes = await fetch('https://api.paystack.co/transaction/initialize', {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    email: (userProfile as any)?.email,
                    amount: Math.round(subscriptionPrice * 100),
                    reference,
                    callback_url: `${process.env.NEXT_PUBLIC_APP_URL}/dashboard/upgrade?reference=${reference}`,
                    metadata: {
                        upgrade_type: 'dealer_subscription',
                        plan_type: planType,
                        plan_days: planDays,
                        plan_label: planLabel,
                    },
                }),
            })

            const paystackData = await paystackRes.json()

            if (!paystackData.status) {
                console.error('[DealerSubscribe] Paystack init failed:', paystackData)
                await (supabaseAdmin.from('wallet_payments') as any).update({ status: 'failed' }).eq('reference', reference)
                return NextResponse.json({ error: 'Payment gateway error' }, { status: 500 })
            }

            return NextResponse.json({
                success: true,
                gateway: 'paystack',
                authorization_url: paystackData.data.authorization_url,
                reference,
            })
        }

        // ── PAYSTACK MOBILE MONEY BRANCH ────────────────────────────────────────
        if (provider === 'paystack_momo') {
            if (!phone || !network || !paystackMomoProviderFor(network)) {
                return NextResponse.json({ error: 'Valid phone number and network are required' }, { status: 400 })
            }

            const finish = async (result: MomoChargeResult) => {
                if (!result.ok) {
                    if (result.safeToMarkFailed && !existingRef) {
                        await (supabaseAdmin.from('wallet_payments') as any)
                            .update({ status: 'failed' })
                            .eq('reference', reference)
                            .eq('status', 'pending')
                    }
                    return NextResponse.json(result.body, { status: result.httpStatus })
                }
                if (result.outcome === 'paid') {
                    await processCompletedDealerSubscription(reference, {
                        reference,
                        amount: Math.round(subscriptionPrice * 100),
                        metadata: { upgrade_type: 'dealer_subscription' },
                    })
                }
                return NextResponse.json(result.body)
            }

            if (otpCode && existingRef) {
                if (!await assertOwnPendingPayment(supabaseAdmin, existingRef, authUser.id)) {
                    return NextResponse.json({ error: 'That payment is no longer waiting for a code' }, { status: 404 })
                }
                return finish(await submitPaystackMomoOtp({ reference: existingRef, otp: String(otpCode), payerPhone: phone }))
            }

            return finish(await startPaystackMomoCharge({
                reference,
                amountGhs: subscriptionPrice,
                payerPhone: phone,
                network,
                metadata: { user_id: authUser.id, upgrade_type: 'dealer_subscription', kind: 'dealer_subscription' },
                userId: authUser.id,
            }))
        }

        // ── HUBTEL BRANCH ───────────────────────────────────────────────────────
        if (provider === 'hubtel') {
            const hubtelResponse = await hubtelInitiatePayment({
                amount: subscriptionPrice,
                payerPhone: phone,
                channel: HUBTEL_CHANNEL_MAP[network],
                clientReference: reference,
                description: `ARHMS Dealer Subscription - ${planLabel}`,
                userId: authUser.id,
            })

            if (!hubtelResponse.success) {
                await (supabaseAdmin.from('wallet_payments') as any).update({ status: 'failed' }).eq('reference', reference)
                throw new Error(hubtelResponse.error || 'Failed to initialize Hubtel payment')
            }

            return NextResponse.json({
                success: true,
                gateway: 'hubtel',
                reference,
                message: 'Payment prompt sent to your phone. Please approve to continue.',
            })
        }

        // ── PAYSWITCH BRANCH ────────────────────────────────────────────────────
        if (provider === 'payswitch') {
            const { transactionId, error: txIdError } = await assignPayswitchTransactionId(supabaseAdmin, { reference })
            if (!transactionId) {
                console.error('[DealerSubscribe] PaySwitch transaction id error:', txIdError)
                await (supabaseAdmin.from('wallet_payments') as any).update({ status: 'failed' }).eq('reference', reference)
                throw new Error('Could not start the payment. Please try again.')
            }

            const payswitchResponse = await payswitchInitiatePayment({
                amount: subscriptionPrice,
                payerPhone: phone,
                network,
                transactionId,
                description: `ARHMS Dealer Subscription - ${planLabel}`,
            })

            if (!payswitchResponse.success) {
                await (supabaseAdmin.from('wallet_payments') as any).update({ status: 'failed' }).eq('reference', reference)
                throw new Error(payswitchResponse.error || 'Failed to initialize PaySwitch payment')
            }

            return NextResponse.json({
                success: true,
                gateway: 'payswitch',
                reference,
                message: 'Payment prompt sent to your phone. Please approve to continue.',
            })
        }

        // ── MOOLRE BRANCH ───────────────────────────────────────────────────────
        const channelId = MOOLRE_PAYMENT_CHANNEL_MAP[network]

        let moolreResponse = await initiatePayment({
            amount: subscriptionPrice,
            payerPhone: phone,
            channel: channelId,
            externalRef: reference,
            otpCode,
        })

        if (moolreResponse.success && String(moolreResponse.status) === '1' && otpCode) {
            moolreResponse = await initiatePayment({
                amount: subscriptionPrice,
                payerPhone: phone,
                channel: channelId,
                externalRef: reference,
            })
        }

        if (!moolreResponse.success) {
            throw new Error(moolreResponse.error || 'Failed to initialize payment')
        }

        if (moolreResponse.status === '200_OTP_REQ') {
            return NextResponse.json({
                success: true,
                gateway: 'moolre',
                otpRequired: true,
                reference,
                message: 'OTP is required to complete this payment. Please enter the code sent to your phone.',
            })
        }

        return NextResponse.json({
            success: true,
            gateway: 'moolre',
            reference,
            message: 'Payment prompt sent to your phone. Please approve to continue.',
        })
    } catch (error: any) {
        console.error('[DealerSubscribe] Exception:', error)
        return NextResponse.json({ error: error.message || 'Failed to initialize payment' }, { status: 500 })
    }
}

export async function GET(request: NextRequest) {
    try {
        const cookieStore = await cookies()
        const supabase = await createRouteHandlerClient()
        const { data: { user: authUser }, error: authError } = await supabase.auth.getUser()

        if (authError || !authUser) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const { searchParams } = new URL(request.url)
        const reference = searchParams.get('reference') || searchParams.get('trxref')

        if (!reference) {
            return NextResponse.json({ success: false, error: 'No reference provided' }, { status: 400 })
        }

        if (!reference.startsWith('dealer_sub_')) {
            return NextResponse.json({ success: false, error: 'Not a dealer subscription reference' }, { status: 400 })
        }

        const supabaseAdmin = createClient(
            process.env.NEXT_PUBLIC_SUPABASE_URL!,
            process.env.SUPABASE_SERVICE_ROLE_KEY!,
            { auth: { autoRefreshToken: false, persistSession: false } }
        )

        const { data: payment } = await supabaseAdmin
            .from('wallet_payments')
            .select('id, status, user_id, provider, provider_reference, total_amount, metadata, created_at')
            .eq('reference', reference)
            .single()

        if (!payment) {
            return NextResponse.json({ success: false, status: 'failed', error: 'Payment record not found' }, { status: 400 })
        }

        if ((payment as any).user_id !== authUser.id) {
            return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
        }

        if ((payment as any).status === 'completed') {
            return NextResponse.json({ success: true, status: 'completed', alreadyProcessed: true })
        }

        // Confirm with the gateway the payment was actually initiated through
        const paymentProvider = String((payment as any).provider || 'moolre')

        if (paymentProvider === 'hubtel') {
            // /dashboard/upgrade polls this endpoint every 3 seconds while the prompt
            // is on the customer's handset. Hubtel's status API costs a metered proxy
            // request per call, so an unthrottled poll burned ~20 of the 500 monthly
            // requests PER MINUTE — a single abandoned subscription could exhaust the
            // quota on its own, and an exhausted quota 407s every payment in the app.
            //
            // The DB fast-path above already returns the moment the webhook lands, so
            // the status API only needs a small fallback budget. Past it, the webhook
            // and /api/cron/verify-hubtel-payments still settle the payment.
            const decision = await claimHubtelStatusCheck(supabaseAdmin, payment as any, {
                graceMs: 45_000,
                interval: 20_000,
                maxChecks: 5,
            })

            if (!decision.allowed) {
                return NextResponse.json({ success: true, status: 'pending' })
            }

            const hubtelStatus = await hubtelCheckPaymentStatus(reference)

            if (!hubtelStatus.success || hubtelStatus.status === null) {
                return NextResponse.json({ success: true, status: 'pending' })
            }
            if (hubtelStatus.status !== 'Paid') {
                return NextResponse.json({ success: true, status: 'pending' })
            }
        } else if (paymentProvider === 'payswitch') {
            // Same budget reasoning as Hubtel above: the callback settles this in the
            // normal case and the DB fast-path returns the moment it does, so the
            // status API only needs a small bounded fallback allowance.
            const decision = await claimHubtelStatusCheck(supabaseAdmin, payment as any, {
                graceMs: 45_000,
                interval: 20_000,
                maxChecks: 5,
                keys: PAYSWITCH_CLIENT_THROTTLE_KEYS,
            })

            if (!decision.allowed) {
                return NextResponse.json({ success: true, status: 'pending' })
            }

            const txId = String((payment as any).provider_reference || '')
            const payswitchStatus = await payswitchCheckPaymentStatus(txId)

            if (!payswitchStatus.success || payswitchStatus.outcome === null || payswitchStatus.outcome === 'pending') {
                return NextResponse.json({ success: true, status: 'pending' })
            }
            if (payswitchStatus.outcome === 'failed') {
                return NextResponse.json({ success: false, status: 'failed' })
            }
        } else if (paymentProvider === 'paystack' || paymentProvider === 'paystack_momo') {
            // Both Paystack rails verify the same way — one merchant account, one
            // reference namespace. Routed through verifyTransaction() rather than the
            // inline fetch this used to hold, so there is a single place that decides
            // what each Paystack status means. Note it treats an unbooked charge as
            // pending rather than failed, which the raw fetch did not.
            const verified = await verifyTransaction(reference)

            if (verified.outcome === 'failed') {
                return NextResponse.json({ success: false, status: 'failed' })
            }
            if (verified.outcome !== 'paid') {
                return NextResponse.json({ success: true, status: 'pending' })
            }
        } else {
            const moolreResponse = await checkPaymentStatus(reference)

            if (!moolreResponse.success || moolreResponse.txstatus === null) {
                return NextResponse.json({ success: true, status: 'pending' })
            }
            if (moolreResponse.txstatus === 0 || moolreResponse.txstatus === 3) {
                return NextResponse.json({ success: true, status: 'pending' })
            }
            if (moolreResponse.txstatus === 2) {
                return NextResponse.json({ success: false, status: 'failed' })
            }
        }

        const result = await processCompletedDealerSubscription(reference, {
            reference,
            amount: Math.round(Number((payment as any).total_amount) * 100),
            metadata: (payment as any).metadata || {},
        })

        if (!result.success && !result.alreadyProcessed) {
            console.error('[DealerSubscribeVerify] Processing failed:', result.error)
            return NextResponse.json({ success: false, status: 'failed', error: result.error || 'Processing failed' }, { status: 500 })
        }

        return NextResponse.json({ success: true, status: 'completed', alreadyProcessed: !!result.alreadyProcessed })
    } catch (error: any) {
        console.error('[DealerSubscribeVerify] Exception:', error)
        return NextResponse.json({ success: false, error: error.message || 'Verification failed' }, { status: 500 })
    }
}
