import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { createRouteHandlerClient } from '@/lib/supabase-server'
import { calculatePaystackFee, generateReferenceCode } from '@/lib/utils'
import { initiatePayment as moolreInitiatePayment, MOOLRE_PAYMENT_CHANNEL_MAP } from '@/lib/moolre-payment-service'
import { initiatePayment as hubtelInitiatePayment, HUBTEL_CHANNEL_MAP, calculateHubtelFee, toHubtelMsisdn } from '@/lib/hubtel-payment-service'
import { checkHubtelPromptLimit, recordHubtelPrompt } from '@/lib/hubtel-prompt-limit'
import { initiatePayment as payswitchInitiatePayment, PAYSWITCH_CHANNEL_MAP } from '@/lib/payswitch-payment-service'
import { assignPayswitchTransactionId } from '@/lib/payswitch-reference'
import { resolveProviderForScope, isMomoPromptProvider, type PaymentProvider } from '@/lib/payment-provider'
import { WEB_FEE_SETTING_KEYS, resolveWebFeePercent } from '@/lib/gateway-fees'
import { paystackMomoProviderFor } from '@/lib/paystack-momo-service'
import {
    startPaystackMomoCharge,
    submitPaystackMomoOtp,
    assertOwnPendingPayment,
    type MomoChargeResult,
} from '@/lib/paystack-momo-checkout'
import { resolveBundleTier } from '@/lib/bundle-pricing'
import { buildBundleIntent, bundleOrderColumns, isBundlesDashboardOpen, loadBundleSettings } from '@/lib/bundle-order-intent'
import { BUNDLE_PAYMENT_PREFIX, isBundlePaymentReference } from '@/lib/bundle-order-payments'
import { BUNDLES_USER_PATH } from '@/lib/bundle-order-completion'

/**
 * Direct-pay (MoMo / card) Standard Bundle purchase.
 *
 * Mirrors app/api/airtime/gateway-init/route.ts: no `bundle_orders` row is written
 * here, only a pending `wallet_payments` intent whose metadata carries the priced
 * order columns. processBundleDirectOrder() in lib/bundle-order-payments.ts creates
 * the real order once the gateway confirms payment, and is the only thing that ever
 * dispatches it.
 *
 * The reference is `BUNPAY-` prefixed — that prefix is what routes the callback in
 * every collection webhook and reconciliation poller. Any of them that does not know
 * it credits the payment to the wallet instead of buying the bundle.
 *
 * `quote: true` prices the checkout (gateway + fee) without starting a payment, so
 * the dialog shows the customer the exact figure the handset will ask for.
 */
export async function POST(request: NextRequest) {
    if (process.env.NEXT_PUBLIC_PAYMENT_MAINTENANCE_MODE === 'true') {
        return NextResponse.json(
            { error: 'Payment system is currently under maintenance. Please try again later.' },
            { status: 503 }
        )
    }

    try {
        const supabaseUserClient = await createRouteHandlerClient()
        const { data: { user: authUser } } = await supabaseUserClient.auth.getUser()
        if (!authUser) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

        const userId = authUser.id
        const supabase = createServerClient() as any

        let body: any
        try {
            body = await request.json()
        } catch {
            return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
        }

        const { network, bundleKey, phone, momoPhone, momoNetwork, otpCode, reference: existingRef, quote } = body || {}

        const [settings, { data: profile }, { data: payRows }] = await Promise.all([
            loadBundleSettings(supabase),
            supabase.from('users').select('*').eq('id', userId).single(),
            supabase.from('admin_settings').select('key, value').in('key', [...WEB_FEE_SETTING_KEYS, 'active_payment_provider_web']),
        ])
        if (!profile) return NextResponse.json({ error: 'User not found' }, { status: 404 })

        if (!isBundlesDashboardOpen(settings)) {
            return NextResponse.json({ error: 'Standard Bundles are not available right now.' }, { status: 403 })
        }

        const built = await buildBundleIntent({ network, bundleKey, phone }, settings, resolveBundleTier(profile))
        if (!built.ok) return NextResponse.json({ error: built.error }, { status: built.status })
        const intent = built.intent

        const payMap: Record<string, any> = {}
        for (const row of ((payRows as any[]) || [])) payMap[row.key] = row.value

        const gateway: PaymentProvider = resolveProviderForScope(payMap.active_payment_provider_web, 'web')
        const feeRole = (profile as any).role === 'agent' ? 'agent' : 'customer'

        // Gateway fee on top of the bundle price. Same rule as the airtime/data
        // checkouts: Paystack, PaySwitch and Hubtel charge us, Moolre charges the payer.
        const subtotal = intent.totalPaid
        let gatewayFee = 0
        let totalAmount = subtotal
        if (gateway === 'paystack' || gateway === 'paystack_momo' || gateway === 'payswitch') {
            gatewayFee = calculatePaystackFee(subtotal, resolveWebFeePercent(payMap, { role: feeRole, provider: gateway }))
            totalAmount = parseFloat((subtotal + gatewayFee).toFixed(2))
        } else if (gateway === 'hubtel') {
            const hubtelFees = calculateHubtelFee(subtotal)
            gatewayFee = hubtelFees.fee
            totalAmount = hubtelFees.total
        }

        if (quote === true) {
            return NextResponse.json({
                success: true,
                gateway,
                needsMomoDetails: isMomoPromptProvider(gateway),
                price: subtotal,
                fee: gatewayFee,
                total: totalAmount,
            })
        }

        // Get or create wallet (wallet_payments needs a wallet_id)
        let { data: wallet } = await supabase.from('wallets').select('id').eq('user_id', userId).single()
        if (!wallet) {
            const { data: newWallet, error: walletError } = await supabase
                .from('wallets')
                .insert({ user_id: userId })
                .select()
                .single()
            if (walletError || !newWallet) {
                console.error('[BundleGatewayInit] Wallet create failed:', walletError?.message)
                return NextResponse.json({ error: 'Failed to initialize payment. Please try again.' }, { status: 500 })
            }
            wallet = newWallet
        }

        // Create (or reuse, on OTP retry) the payment intent
        const reference = existingRef || `${BUNDLE_PAYMENT_PREFIX}${generateReferenceCode()}`
        let paymentId: string | null = null

        if (existingRef) {
            if (!isBundlePaymentReference(String(existingRef))) {
                return NextResponse.json({ error: 'Invalid payment reference' }, { status: 400 })
            }
            const { data: existingPayment } = await supabase
                .from('wallet_payments')
                .select('id, user_id, status')
                .eq('reference', existingRef)
                .single()

            if (existingPayment) {
                if ((existingPayment as any).user_id !== userId) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
                if ((existingPayment as any).status !== 'pending') {
                    return NextResponse.json({ error: 'This payment has already been processed' }, { status: 400 })
                }
                paymentId = (existingPayment as any).id
            }
        }

        if (!paymentId) {
            const { data: payment, error: paymentError } = await supabase
                .from('wallet_payments')
                .insert({
                    user_id: userId,
                    wallet_id: (wallet as any).id,
                    amount: subtotal,
                    fee: gatewayFee,
                    total_amount: totalAmount,
                    reference,
                    provider: gateway,
                    status: 'pending',
                    metadata: {
                        kind: 'bundle_order',
                        user_id: userId,
                        role: (profile as any).role || null,
                        label: intent.label,
                        // Priced at checkout and settled verbatim: the customer gets
                        // exactly the bundle and price they agreed to.
                        order: bundleOrderColumns(intent),
                    },
                })
                .select()
                .single()

            if (paymentError || !payment) {
                console.error('[BundleGatewayInit] wallet_payments insert error:', paymentError?.message)
                return NextResponse.json({ error: 'Failed to create payment record' }, { status: 500 })
            }
            paymentId = (payment as any).id
        }

        // ASCII only: Hubtel's client dies with `terminated` on anything else.
        const description = `ARHMS Bundle - ${intent.label}`.replace(/[^\x20-\x7E]/g, '')

        // PAYSTACK (hosted page)
        if (gateway === 'paystack') {
            if (!process.env.PAYSTACK_SECRET_KEY || !process.env.NEXT_PUBLIC_APP_URL) {
                console.error('[BundleGatewayInit] Paystack env vars missing')
                return NextResponse.json({ error: 'Payment gateway is not configured. Please contact support.' }, { status: 503 })
            }
            const userEmail = (profile as any).email
            if (!userEmail) {
                return NextResponse.json({ error: 'Account email is required for card payment. Please update your profile.' }, { status: 400 })
            }

            const paystackRes = await fetch('https://api.paystack.co/transaction/initialize', {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    email: userEmail,
                    amount: Math.round(totalAmount * 100), // pesewas
                    reference,
                    callback_url: `${process.env.NEXT_PUBLIC_APP_URL}${BUNDLES_USER_PATH}?reference=${reference}`,
                    metadata: { order_type: 'bundle_order', network: intent.network },
                }),
            })
            const paystackData = await paystackRes.json()

            if (!paystackData.status) {
                console.error('[BundleGatewayInit] Paystack init failed:', paystackData?.message)
                await supabase.from('wallet_payments').update({ status: 'failed' }).eq('id', paymentId)
                return NextResponse.json({ error: 'Payment gateway initialization failed' }, { status: 500 })
            }

            return NextResponse.json({
                success: true,
                gateway: 'paystack',
                authorization_url: paystackData.data.authorization_url,
                reference,
                amount: totalAmount,
                fee: gatewayFee,
            })
        }

        // PAYSTACK MOBILE MONEY
        if (gateway === 'paystack_momo') {
            if (!momoPhone || !momoNetwork || !paystackMomoProviderFor(momoNetwork)) {
                return NextResponse.json({ error: 'Valid Mobile Money network is required' }, { status: 400 })
            }

            const finish = async (result: MomoChargeResult) => {
                if (!result.ok) {
                    if (result.safeToMarkFailed && !existingRef) {
                        await supabase.from('wallet_payments')
                            .update({ status: 'failed' })
                            .eq('id', paymentId)
                            .eq('status', 'pending')
                    }
                    return NextResponse.json(result.body, { status: result.httpStatus })
                }
                if (result.outcome === 'paid') {
                    const { processBundleDirectOrder } = await import('@/lib/bundle-order-payments')
                    await processBundleDirectOrder(reference)
                }
                return NextResponse.json({ ...result.body, amount: totalAmount, fee: gatewayFee })
            }

            if (otpCode && existingRef) {
                if (!await assertOwnPendingPayment(supabase, existingRef, userId)) {
                    return NextResponse.json({ error: 'That payment is no longer waiting for a code' }, { status: 404 })
                }
                return finish(await submitPaystackMomoOtp({ reference: existingRef, otp: String(otpCode), payerPhone: momoPhone }))
            }

            return finish(await startPaystackMomoCharge({
                reference,
                amountGhs: totalAmount,
                payerPhone: momoPhone,
                network: momoNetwork,
                email: (profile as any).email,
                metadata: { user_id: userId, kind: 'bundle_order', network: intent.network },
                userId,
            }))
        }

        // HUBTEL
        if (gateway === 'hubtel') {
            if (!momoNetwork || !HUBTEL_CHANNEL_MAP[momoNetwork]) {
                return NextResponse.json({ error: 'Valid Mobile Money network is required' }, { status: 400 })
            }
            const payerPhone = toHubtelMsisdn(momoPhone || '') || momoPhone
            if (!payerPhone) return NextResponse.json({ error: 'Please provide a Mobile Money phone number.' }, { status: 400 })

            const promptLimit = await checkHubtelPromptLimit(payerPhone)
            if (!promptLimit.allowed) {
                await supabase.from('wallet_payments').update({ status: 'failed' }).eq('id', paymentId)
                return NextResponse.json({ error: promptLimit.error }, { status: 429 })
            }

            // Read-modify-write: this metadata carries the order the settle path
            // depends on, so it must be merged, never replaced.
            const { data: currentPayment } = await supabase.from('wallet_payments').select('metadata').eq('id', paymentId).single()
            await supabase
                .from('wallet_payments')
                .update({ metadata: { ...((currentPayment as any)?.metadata || {}), payer_msisdn: toHubtelMsisdn(payerPhone) } })
                .eq('id', paymentId)

            const hubtelResponse = await hubtelInitiatePayment({
                amount: totalAmount,
                payerPhone,
                channel: HUBTEL_CHANNEL_MAP[momoNetwork],
                clientReference: reference,
                customerName: `${(profile as any).first_name || ''} ${(profile as any).last_name || ''}`.replace(/[^\x20-\x7E]/g, '').trim() || 'Customer',
                customerEmail: (profile as any).email || '',
                description,
                userId,
            })

            if (!hubtelResponse.success) {
                console.error('[BundleGatewayInit] Hubtel error:', hubtelResponse.error)
                await supabase.from('wallet_payments').update({ status: 'failed' }).eq('id', paymentId)
                return NextResponse.json({ error: hubtelResponse.error || 'Failed to initialize Hubtel payment' }, { status: 500 })
            }

            await recordHubtelPrompt(payerPhone)

            return NextResponse.json({
                success: true,
                gateway: 'hubtel',
                otpRequired: false,
                reference,
                amount: totalAmount,
                fee: gatewayFee,
                message: 'Payment prompt sent to your phone. Please approve to complete your purchase.',
            })
        }

        // PAYSWITCH
        if (gateway === 'payswitch') {
            if (!momoPhone || !momoNetwork || !PAYSWITCH_CHANNEL_MAP[momoNetwork]) {
                return NextResponse.json({ error: 'Valid Mobile Money phone number and network are required' }, { status: 400 })
            }

            const { transactionId, error: txIdError } = await assignPayswitchTransactionId(supabase, { id: paymentId! })
            if (!transactionId) {
                console.error('[BundleGatewayInit] PaySwitch transaction id error:', txIdError)
                await supabase.from('wallet_payments').update({ status: 'failed' }).eq('id', paymentId)
                return NextResponse.json({ error: 'Could not start the payment. Please try again.' }, { status: 500 })
            }

            const payswitchResponse = await payswitchInitiatePayment({
                amount: totalAmount,
                payerPhone: momoPhone,
                network: momoNetwork,
                transactionId,
                description,
            })

            if (!payswitchResponse.success) {
                console.error('[BundleGatewayInit] PaySwitch error:', payswitchResponse.error)
                await supabase.from('wallet_payments').update({ status: 'failed' }).eq('id', paymentId)
                return NextResponse.json({ error: payswitchResponse.error || 'Failed to initialize PaySwitch payment' }, { status: 500 })
            }

            return NextResponse.json({
                success: true,
                gateway: 'payswitch',
                otpRequired: false,
                reference,
                amount: totalAmount,
                fee: gatewayFee,
                message: 'Payment prompt sent to your phone. Please approve to complete your purchase.',
            })
        }

        // MOOLRE
        if (!momoPhone || !momoNetwork || !MOOLRE_PAYMENT_CHANNEL_MAP[momoNetwork]) {
            return NextResponse.json({ error: 'Valid MoMo phone number and network are required for mobile money payments' }, { status: 400 })
        }

        const channelId = MOOLRE_PAYMENT_CHANNEL_MAP[momoNetwork]
        let moolreResponse = await moolreInitiatePayment({
            amount: totalAmount,
            payerPhone: momoPhone,
            channel: channelId,
            externalRef: reference,
            otpCode,
        })

        // OTP just verified -- send the actual payment request
        if (moolreResponse.success && String(moolreResponse.status) === '1' && otpCode) {
            moolreResponse = await moolreInitiatePayment({
                amount: totalAmount,
                payerPhone: momoPhone,
                channel: channelId,
                externalRef: reference,
            })
        }

        if (!moolreResponse.success) {
            console.error('[BundleGatewayInit] Moolre error:', moolreResponse.error)
            await supabase.from('wallet_payments').update({ status: 'failed' }).eq('id', paymentId)
            return NextResponse.json({ error: moolreResponse.error || 'Failed to initialize mobile money payment' }, { status: 500 })
        }

        if (moolreResponse.status === '200_OTP_REQ') {
            return NextResponse.json({
                success: true,
                gateway: 'moolre',
                otpRequired: true,
                reference,
                amount: totalAmount,
                fee: gatewayFee,
                message: 'OTP is required to complete this payment. Please enter the code sent to your phone.',
            })
        }

        return NextResponse.json({
            success: true,
            gateway: 'moolre',
            otpRequired: false,
            reference,
            amount: totalAmount,
            fee: gatewayFee,
            message: 'Payment prompt sent to your phone. Please approve to complete your purchase.',
        })
    } catch (error: any) {
        console.error('[BundleGatewayInit] Error:', error)
        return NextResponse.json({ error: 'Failed to process checkout' }, { status: 500 })
    }
}
