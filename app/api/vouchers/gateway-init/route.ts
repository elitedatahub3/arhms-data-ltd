import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { calculateRCPrice, getRCTypeById } from '@/lib/vouchers/pricing'
import { initiatePayment, MOOLRE_PAYMENT_CHANNEL_MAP } from '@/lib/moolre-payment-service'
import { initiatePayment as hubtelInitiatePayment, HUBTEL_CHANNEL_MAP, toHubtelMsisdn } from '@/lib/hubtel-payment-service'
import { checkHubtelPromptLimit, recordHubtelPrompt } from '@/lib/hubtel-prompt-limit'
import {
    initiatePayment as payswitchInitiatePayment,
    PAYSWITCH_CHANNEL_MAP,
    generatePayswitchTransactionId,
} from '@/lib/payswitch-payment-service'
import { mapPayswitchTransaction } from '@/lib/payswitch-reference'
import { resolveProviderForScope, type PaymentProvider } from '@/lib/payment-provider'
import { paystackMomoProviderFor } from '@/lib/paystack-momo-service'
import {
    startPaystackMomoCharge,
    submitPaystackMomoOtp,
    markPaystackMomoPending,
    clearPaystackMomoPending,
} from '@/lib/paystack-momo-checkout'

export async function POST(request: NextRequest) {
    try {
        const supabase = await createRouteClient()

        // Attempt to get user session (optional for guest checkout)
        const { data: { session } } = await supabase.auth.getSession()
        let userId = null
        let userRole = 'customer'

        if (session) {
            userId = session.user.id
            const { data: userProfile } = await supabase
                .from('users')
                .select('role')
                .eq('id', userId)
                .single()
            if (userProfile) {
                userRole = (userProfile as any).role || 'customer'
            }
        }

        const body = await request.json()
        const {
            typeId,
            quantity,
            customerName,
            customerEmail,
            customerPhone,
            momoPhone,
            momoNetwork,
            otpCode,
            reference: existingRef,
        } = body

        // Resolve gateway from admin setting (runtime toggle, no redeployment needed)
        const { createServerClient: createAdminClient } = await import('@/lib/supabase')
        const dbAdmin = createAdminClient()
        const { data: providerRow } = await (dbAdmin.from('admin_settings') as any)
            .select('value')
            .eq('key', 'active_payment_provider_web')
            .single()
        const gateway: PaymentProvider = resolveProviderForScope(providerRow?.value, 'web')

        if (!typeId || !quantity || quantity <= 0 || !customerEmail) {
            return NextResponse.json({ error: 'Invalid request payload. Email and quantity are required.' }, { status: 400 })
        }

        // Fetch and validate the voucher type
        const type = await getRCTypeById(supabase, typeId)
        if (!type || !type.is_active) {
            return NextResponse.json({ error: 'Product not available' }, { status: 400 })
        }

        // Calculate price — include the gateway fee for the providers that bill us
        // (Paystack, PaySwitch). Moolre and Hubtel charge the payer separately.
        const breakdown = await calculateRCPrice({
            type,
            quantity,
            userRole,
            includePaystackFee: gateway === 'paystack' || gateway === 'paystack_momo' || gateway === 'payswitch',
        })

        // Reuse the order on a retry rather than minting a new one.
        //
        // This route had no reference-reuse path at all: every POST created a fresh
        // order and a fresh reference, so an OTP retry left the first order orphaned
        // at 'pending_payment' forever. Under Moolre that was an untidy row; on the
        // Paystack rail it is fatal, because submit_otp identifies the charge by the
        // ORIGINAL reference and a new one has no charge behind it.
        let referenceCode: string
        let order: any

        if (existingRef) {
            if (!String(existingRef).startsWith('RC-')) {
                return NextResponse.json({ error: 'Invalid payment reference' }, { status: 400 })
            }
            const { data: existingOrder } = await (dbAdmin
                .from('results_checker_orders') as any)
                .select('*')
                .eq('reference_code', existingRef)
                .maybeSingle()

            if (!existingOrder || existingOrder.payment_status !== 'pending_payment') {
                return NextResponse.json(
                    { error: 'That payment is no longer waiting for a code' },
                    { status: 404 }
                )
            }
            // Signed-in buyers own their order; a guest proves it with the phone the
            // charge was raised against, since the reference is guessable.
            const ownsOrder = userId
                ? existingOrder.user_id === userId
                : String(existingOrder.customer_phone || '') === String(customerPhone || '')
            if (!ownsOrder) {
                return NextResponse.json({ error: 'That payment is no longer waiting for a code' }, { status: 404 })
            }

            referenceCode = existingRef
            order = existingOrder
        } else {
            referenceCode = `RC-${Date.now()}`

            // Insert pending order.
            // Must use the service-role client: RLS only allows admins to INSERT into
            // results_checker_orders, so the request-scoped client would be rejected.
            const { data: newOrder, error: orderError } = await (dbAdmin
                .from('results_checker_orders') as any)
                .insert({
                    user_id: userId,
                    user_role: userRole,
                    customer_name: customerName || 'Guest Customer',
                    customer_email: customerEmail,
                    customer_phone: customerPhone,
                    type_id: typeId,
                    type_name: type.name,
                    quantity,
                    unit_price: breakdown.unitPrice,
                    cost_price_at_time: type.cost_price,
                    fee_amount: breakdown.paystackFee,
                    total_paid: breakdown.total,
                    status: 'pending',
                    payment_status: 'pending_payment',
                    reference_code: referenceCode,
                })
                .select()
                .single()

            if (orderError || !newOrder) {
                console.error('[GatewayInit] Order creation failed:', orderError)
                return NextResponse.json({ error: 'Failed to initialize order' }, { status: 500 })
            }
            order = newOrder
        }

        // ── PAYSTACK MOBILE MONEY BRANCH ─────────────────────────────────────────
        if (gateway === 'paystack_momo') {
            if (!momoPhone || !momoNetwork || !paystackMomoProviderFor(momoNetwork)) {
                return NextResponse.json({ error: 'Valid Mobile Money network is required' }, { status: 400 })
            }

            if (otpCode && existingRef) {
                const otpResult = await submitPaystackMomoOtp({ reference: referenceCode, otp: String(otpCode), payerPhone: momoPhone })
                return NextResponse.json(otpResult.body, otpResult.ok ? undefined : { status: otpResult.httpStatus })
            }

            if (!existingRef) {
                // No wallet_payments row on this flow, so the marker is the only
                // handle the reconciliation sweep has on it.
                await markPaystackMomoPending(referenceCode, { kind: 'rc' })
            }

            const charge = await startPaystackMomoCharge({
                reference: referenceCode,
                amountGhs: breakdown.total,
                payerPhone: momoPhone,
                network: momoNetwork,
                email: customerEmail,
                metadata: { kind: 'rc', type_id: typeId, quantity },
                userId,
            })

            if (!charge.ok) {
                if (charge.safeToMarkFailed && !existingRef) {
                    // Releases the vouchers this order reserved.
                    await (dbAdmin.from('results_checker_orders') as any)
                        .update({ payment_status: 'failed' })
                        .eq('reference_code', referenceCode)
                        .eq('payment_status', 'pending_payment')
                    await clearPaystackMomoPending(referenceCode)
                }
                return NextResponse.json(charge.body, { status: charge.httpStatus })
            }

            return NextResponse.json(charge.body)
        }

        // ── PAYSTACK BRANCH ──────────────────────────────────────────────────────
        if (gateway === 'paystack') {
            const paystackPayload = {
                email: customerEmail,
                amount: Math.round(breakdown.total * 100), // Kobo
                reference: referenceCode,
                callback_url: `${process.env.NEXT_PUBLIC_APP_URL || ''}/dashboard/results-checker`,
                metadata: {
                    order_type: 'results_checker',
                    type_id: typeId,
                    quantity,
                },
            }

            const paystackRes = await fetch('https://api.paystack.co/transaction/initialize', {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(paystackPayload),
            })

            const paystackData = await paystackRes.json()

            if (!paystackData.status) {
                console.error('[GatewayInit] Paystack init failed:', paystackData)
                return NextResponse.json({ error: 'Payment gateway initialization failed' }, { status: 500 })
            }

            return NextResponse.json({
                success: true,
                gateway: 'paystack',
                authorization_url: paystackData.data.authorization_url,
                reference: referenceCode,
            })
        }

        // ── MOOLRE BRANCH ────────────────────────────────────────────────────────
        if (gateway === 'moolre') {
            if (!momoPhone || !momoNetwork || !MOOLRE_PAYMENT_CHANNEL_MAP[momoNetwork]) {
                return NextResponse.json({ error: 'Valid MoMo phone and network are required for mobile money payments' }, { status: 400 })
            }

            const channelId = MOOLRE_PAYMENT_CHANNEL_MAP[momoNetwork]

            let moolreResponse = await initiatePayment({
                amount: breakdown.total,
                payerPhone: momoPhone,
                channel: channelId,
                externalRef: referenceCode,
                otpCode,
            })

            // If Moolre returned OTP verification success, send the actual payment request
            if (moolreResponse.success && String(moolreResponse.status) === '1' && otpCode) {
                console.log('[GatewayInit] Moolre OTP verified. Sending follow-up payment request.')
                moolreResponse = await initiatePayment({
                    amount: breakdown.total,
                    payerPhone: momoPhone,
                    channel: channelId,
                    externalRef: referenceCode,
                })
            }

            if (!moolreResponse.success) {
                console.error('[GatewayInit] Moolre error:', moolreResponse.error)
                return NextResponse.json({ error: moolreResponse.error || 'Failed to initialize mobile money payment' }, { status: 500 })
            }

            // OTP required — return so frontend can prompt the user
            if (moolreResponse.status === '200_OTP_REQ') {
                return NextResponse.json({
                    success: true,
                    gateway: 'moolre',
                    otpRequired: true,
                    reference: referenceCode,
                    message: 'OTP is required to complete this payment. Please enter the code sent to your phone.',
                })
            }

            // USSD prompt sent — user must approve on their phone
            return NextResponse.json({
                success: true,
                gateway: 'moolre',
                otpRequired: false,
                reference: referenceCode,
                message: 'Payment prompt sent to your phone. Please approve to complete your purchase.',
            })
        }

        // ── HUBTEL BRANCH ───────────────────────────────────────────────────
        if (gateway === 'hubtel') {
            if (!momoNetwork || !HUBTEL_CHANNEL_MAP[momoNetwork]) {
                return NextResponse.json({ error: 'Valid MoMo network is required for Hubtel payments' }, { status: 400 })
            }

            // Use the phone number the user submitted directly.
            const submittedMsisdn = toHubtelMsisdn(momoPhone || '')
            const payerPhone = submittedMsisdn || momoPhone

            if (!payerPhone) {
                return NextResponse.json(
                    { error: 'Please provide a Mobile Money phone number.' },
                    { status: 400 }
                )
            }

            // Applies to trusted numbers too — see lib/hubtel-prompt-limit.ts.
            const promptLimit = await checkHubtelPromptLimit(payerPhone)
            if (!promptLimit.allowed) {
                return NextResponse.json({ error: promptLimit.error }, { status: 429 })
            }

            const hubtelChannel = HUBTEL_CHANNEL_MAP[momoNetwork]
            const hubtelResponse = await hubtelInitiatePayment({
                amount: breakdown.total,
                payerPhone,   // registered number, or a previously verified one
                channel: hubtelChannel,
                clientReference: referenceCode,
                customerName: customerName || 'Guest Customer',
                customerEmail: customerEmail || '',
                description: `ARHMS Results Checker - ${type.name} x${quantity}`,
            })

            if (!hubtelResponse.success) {
                console.error('[GatewayInit] Hubtel error:', hubtelResponse.error)
                return NextResponse.json({ error: hubtelResponse.error || 'Failed to initialize Hubtel payment' }, { status: 500 })
            }

            // Only now has a prompt actually gone to the handset.
            await recordHubtelPrompt(payerPhone)

            return NextResponse.json({
                success: true,
                gateway: 'hubtel',
                otpRequired: false,
                reference: referenceCode,
                message: 'Payment prompt sent to your phone. Please approve to complete your purchase.',
            })
        }

        // ── PAYSWITCH BRANCH ────────────────────────────────────────────────
        if (gateway === 'payswitch') {
            if (!momoPhone || !momoNetwork || !PAYSWITCH_CHANNEL_MAP[momoNetwork]) {
                return NextResponse.json({ error: 'Valid MoMo phone and network are required for PaySwitch payments' }, { status: 400 })
            }

            // RC orders live in results_checker_orders, not wallet_payments, so the
            // transaction_id -> reference mapping goes to Redis. It must be written
            // BEFORE the prompt: a fast approval can otherwise reach the callback
            // before the mapping exists.
            const transactionId = generatePayswitchTransactionId()
            await mapPayswitchTransaction(transactionId, referenceCode)

            const payswitchResponse = await payswitchInitiatePayment({
                amount: breakdown.total,
                payerPhone: momoPhone,
                network: momoNetwork,
                transactionId,
                description: `ARHMS Results Checker - ${type.name} x${quantity}`,
            })

            if (!payswitchResponse.success) {
                console.error('[GatewayInit] PaySwitch error:', payswitchResponse.error)
                return NextResponse.json({ error: payswitchResponse.error || 'Failed to initialize PaySwitch payment' }, { status: 500 })
            }

            return NextResponse.json({
                success: true,
                gateway: 'payswitch',
                otpRequired: false,
                reference: referenceCode,
                message: 'Payment prompt sent to your phone. Please approve to complete your purchase.',
            })
        }

        return NextResponse.json({ error: 'Unsupported payment gateway' }, { status: 400 })

    } catch (error: any) {
        console.error('[GatewayInit] Error:', error)
        if (error.message === 'PRICING_ERROR_UNIT_BELOW_COST') {
            return NextResponse.json({ error: 'Pricing error. Please contact support.' }, { status: 500 })
        }
        return NextResponse.json({ error: 'Failed to process checkout' }, { status: 500 })
    }
}
