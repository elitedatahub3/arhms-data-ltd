import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { Redis } from '@upstash/redis'
import { initiatePayment, MOOLRE_PAYMENT_CHANNEL_MAP } from '@/lib/moolre-payment-service'
import { initiatePayment as hubtelInitiatePayment, HUBTEL_CHANNEL_MAP } from '@/lib/hubtel-payment-service'
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

let redis: Redis | null = null
try { redis = Redis.fromEnv() } catch (_) {}

export async function POST(request: NextRequest) {
    try {
        const body = await request.json()
        const {
            shopSlug,
            rcTypeId,
            quantity,
            customerName,
            customerPhone,
            customerEmail,
            otpCode,
            reference: existingRef,
        } = body

        // ── Input validation ──────────────────────────────────────────────────────
        if (!shopSlug || !rcTypeId || !quantity || !customerPhone) {
            return NextResponse.json({ error: 'Missing required fields: shopSlug, rcTypeId, quantity, customerPhone' }, { status: 400 })
        }

        const qty = parseInt(quantity)
        if (isNaN(qty) || qty < 1 || qty > 10) {
            return NextResponse.json({ error: 'Quantity must be between 1 and 10' }, { status: 400 })
        }

        const cleanPhone = String(customerPhone).replace(/\s+/g, '')
        if (!/^(0\d{9}|233\d{9})$/.test(cleanPhone)) {
            return NextResponse.json({ error: 'Invalid phone number. Use format: 0XXXXXXXXX' }, { status: 400 })
        }

        let validEmail: string | null = null
        if (customerEmail) {
            const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/
            if (emailRegex.test(String(customerEmail).trim())) {
                validEmail = String(customerEmail).trim().toLowerCase()
            }
        }

        const db = createServerClient() as any

        // ── 1. Check global toggle ────────────────────────────────────────────────
        const { data: settingsRows } = await db
            .from('admin_settings')
            .select('key, value')
            .in('key', ['storefront_rc_enabled', 'active_payment_provider_shop'])

        const adminSettings: Record<string, string> = {}
        for (const row of (settingsRows || [])) adminSettings[row.key] = row.value

        if (adminSettings['storefront_rc_enabled'] !== 'true') {
            return NextResponse.json({ error: 'Results Checker is not available on storefronts' }, { status: 503 })
        }

        // Note: this scope has always defaulted to Paystack when unset, unlike the
        // rest of the app — kept as-is so an unset setting does not change behaviour.
        const provider: PaymentProvider = resolveProviderForScope(
            adminSettings['active_payment_provider_shop'],
            'shop',
            'paystack'
        )

        // No SMS verification on the storefront: guests are prompted straight away.
        // The per-number prompt limit is the only throttle, and it is checked up front —
        // before an order row is written — so a throttled customer leaves no pending order.
        if (provider === 'hubtel' && !existingRef) {
            const promptLimit = await checkHubtelPromptLimit(cleanPhone)
            if (!promptLimit.allowed) {
                return NextResponse.json({ error: promptLimit.error }, { status: 429 })
            }
        }

        // ── 2. Fetch shop ─────────────────────────────────────────────────────────
        const { data: shop } = await db
            .from('shop_profiles')
            .select('id, shop_name, owner_id, approval_status, is_active, owner_phone, whatsapp_number, owner:users!shop_profiles_owner_id_fkey(role)')
            .eq('shop_slug', shopSlug)
            .single()

        if (!shop || shop.approval_status !== 'approved' || !shop.is_active) {
            return NextResponse.json({ error: 'Shop is not currently active' }, { status: 403 })
        }

        // ── 3. Fetch shop RC pricing row ──────────────────────────────────────────
        const { data: shopPricing } = await db
            .from('shop_rc_pricing')
            .select('selling_price')
            .eq('shop_id', shop.id)
            .eq('rc_type_id', rcTypeId)
            .maybeSingle()

        if (!shopPricing) {
            return NextResponse.json({ error: 'This voucher type is not available in this shop' }, { status: 404 })
        }

        // ── 4. Fetch RC type ──────────────────────────────────────────────────────
        const { data: rcType } = await db
            .from('results_checker_types')
            .select('id, name, cost_price, is_active')
            .eq('id', rcTypeId)
            .maybeSingle()

        if (!rcType || !rcType.is_active) {
            return NextResponse.json({ error: 'Voucher type is not available' }, { status: 404 })
        }

        const sellingPrice = parseFloat(shopPricing.selling_price)
        const costPrice = parseFloat(rcType.cost_price)
        const shopMarkup = (sellingPrice - costPrice) * qty
        const totalAmount = sellingPrice * qty

        // ── 5. Reserve vouchers ───────────────────────────────────────────────────
        let tempOrderId = crypto.randomUUID()
        if (existingRef) {
            try {
                const redisOrderId = redis ? await redis.get<string>(`shop:rc:orderid:${existingRef}`) : null
                if (redisOrderId) tempOrderId = redisOrderId
            } catch (_) {}
        }

        if (!existingRef) {
            // Only reserve on the first call (not OTP retry)
            const { data: reserved, error: reserveErr } = await db.rpc('assign_results_checker_vouchers', {
                p_type_id: rcTypeId,
                p_quantity: qty,
                p_order_id: tempOrderId,
            })

            if (reserveErr) {
                if (reserveErr.message?.includes('INSUFFICIENT_INVENTORY')) {
                    return NextResponse.json({ error: 'Not enough vouchers in stock. Please try a smaller quantity.' }, { status: 409 })
                }
                console.error('[shop/rc/initialize] Reserve error:', reserveErr)
                return NextResponse.json({ error: 'Failed to reserve vouchers' }, { status: 500 })
            }

            if (!reserved || reserved.length < qty) {
                return NextResponse.json({ error: 'Not enough vouchers in stock.' }, { status: 409 })
            }

            // ── 6. Create pending order ───────────────────────────────────────────
            const referenceCode = `RC-SHOP-${shop.id.slice(0, 8)}-${Date.now()}`

            const { data: order, error: orderErr } = await db
                .from('results_checker_orders')
                .insert({
                    user_id: null,
                    user_role: 'customer',
                    shop_id: shop.id,
                    shop_name: shop.shop_name,
                    shop_markup: shopMarkup,
                    customer_name: customerName || 'Guest',
                    customer_email: validEmail,
                    customer_phone: cleanPhone,
                    type_id: rcTypeId,
                    type_name: rcType.name,
                    quantity: qty,
                    unit_price: sellingPrice,
                    cost_price_at_time: costPrice,
                    fee_amount: 0,
                    total_paid: totalAmount,
                    merchant_commission: shopMarkup,
                    status: 'pending',
                    payment_status: 'pending_payment',
                    reference_code: referenceCode,
                })
                .select('id')
                .single()

            if (orderErr || !order) {
                console.error('[shop/rc/initialize] Order creation failed:', orderErr)
                return NextResponse.json({ error: 'Failed to initialize order' }, { status: 500 })
            }

            // Cache metadata for verify route
            const meta = {
                shop_id: shop.id,
                shop_name: shop.shop_name,
                rc_type_id: rcTypeId,
                rc_type_name: rcType.name,
                order_id: order.id,
                quantity: qty,
                unit_price: sellingPrice,
                cost_price: costPrice,
                shop_markup: shopMarkup,
                total_paid: totalAmount,
                owner_id: shop.owner_id,
            }

            try {
                if (redis) {
                    await redis.set(`shop:rc:orderid:${referenceCode}`, order.id, { ex: 86400 })
                    await redis.set(`shop:rc:meta:${referenceCode}`, JSON.stringify(meta), { ex: 86400 })
                }
            } catch (redisErr) {
                console.error('[shop/rc/initialize] Redis cache error (non-fatal):', redisErr)
            }

            // ── PAYSTACK MOBILE MONEY BRANCH ──────────────────────────────────────
            if (provider === 'paystack_momo') {
                // Derived here from the payer's prefix, the same way the Hubtel and
                // PaySwitch branches below do it — the shared paymentNetwork further
                // down belongs to the OTP retry tail and is not in scope yet.
                const momoPrefix = cleanPhone.substring(0, 3)
                let momoNetwork = 'MTN'
                if (['020', '050'].includes(momoPrefix)) momoNetwork = 'Telecel'
                else if (['026', '027', '056', '028', '058', '057'].includes(momoPrefix)) momoNetwork = 'AT'

                if (!paystackMomoProviderFor(momoNetwork)) {
                    return NextResponse.json({ error: 'Unsupported payment network' }, { status: 400 })
                }

                // No wallet_payments row here, so the marker is the only handle the
                // reconciliation sweep has on this order.
                await markPaystackMomoPending(referenceCode, { kind: 'rc_shop', slug: shopSlug })

                const charge = await startPaystackMomoCharge({
                    reference: referenceCode,
                    amountGhs: totalAmount,
                    payerPhone: cleanPhone,
                    network: momoNetwork,
                    email: validEmail || undefined,
                    metadata: { kind: 'rc_shop', shop_id: shop.id, order_id: order.id },
                })

                if (!charge.ok) {
                    if (charge.safeToMarkFailed) {
                        // Releases the vouchers this order reserved.
                        await (db.from('results_checker_orders') as any)
                            .update({ payment_status: 'failed' })
                            .eq('reference_code', referenceCode)
                            .eq('payment_status', 'pending_payment')
                        await clearPaystackMomoPending(referenceCode)
                    }
                    return NextResponse.json(charge.body, { status: charge.httpStatus })
                }

                return NextResponse.json(charge.body)
            }

            // ── PAYSTACK BRANCH ───────────────────────────────────────────────────
            if (provider === 'paystack') {
                const guestEmail = validEmail || `guest-${cleanPhone}@checkout.arhmsgh.com`
                const amountInPesewas = Math.round(totalAmount * 100)

                const paystackRes = await fetch('https://api.paystack.co/transaction/initialize', {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        email: guestEmail,
                        amount: amountInPesewas,
                        reference: referenceCode,
                        callback_url: `${process.env.NEXT_PUBLIC_APP_URL}/shop/${shopSlug}/success?reference=${referenceCode}`,
                        metadata: {
                            type: 'rc_voucher',
                            shop_slug: shopSlug,
                            rc_type_name: rcType.name,
                            order_id: order.id,
                            customer_phone: cleanPhone,
                            ...meta,
                        },
                    }),
                })

                const paystackData = await paystackRes.json()

                if (!paystackData.status || !paystackData.data?.authorization_url) {
                    console.error('[shop/rc/initialize] Paystack init failed:', paystackData)
                    return NextResponse.json({ error: 'Payment gateway error. Please try again.' }, { status: 500 })
                }

                return NextResponse.json({
                    success: true,
                    gateway: 'paystack',
                    authorization_url: paystackData.data.authorization_url,
                    reference: referenceCode,
                })
            }

            // ── HUBTEL BRANCH ─────────────────────────────────────────────────────
            // Verification and the prompt limit were already cleared above, before the
            // order row was created.
            if (provider === 'hubtel') {
                const hubtelPrefix = cleanPhone.substring(0, 3)
                let hubtelNetwork = 'MTN'
                if (['020', '050'].includes(hubtelPrefix)) hubtelNetwork = 'Telecel'
                else if (['026', '027', '056', '028', '058', '057'].includes(hubtelPrefix)) hubtelNetwork = 'AT'

                const hubtelChannel = HUBTEL_CHANNEL_MAP[hubtelNetwork]
                if (!hubtelChannel) {
                    return NextResponse.json({ error: 'Unsupported payment network' }, { status: 400 })
                }

                const hubtelResponse = await hubtelInitiatePayment({
                    amount: totalAmount,
                    payerPhone: cleanPhone,
                    channel: hubtelChannel,
                    clientReference: referenceCode,
                    customerName: customerName || 'Guest Customer',
                    customerEmail: validEmail || '',
                    description: `${shop.shop_name} - ${rcType.name} x${qty}`,
                })

                if (!hubtelResponse.success) {
                    console.error('[shop/rc/initialize] Hubtel error:', hubtelResponse.error)
                    return NextResponse.json(
                        { error: hubtelResponse.error || 'Failed to initialize Hubtel payment' },
                        { status: 500 }
                    )
                }

                // Only now has a prompt actually gone to the handset.
                await recordHubtelPrompt(cleanPhone)

                return NextResponse.json({
                    success: true,
                    gateway: 'hubtel',
                    otpRequired: false,
                    reference: referenceCode,
                    message: 'Payment prompt sent to your phone. Please approve to complete your purchase.',
                })
            }

            // ── PAYSWITCH BRANCH ──────────────────────────────────────────────────
            if (provider === 'payswitch') {
                const psPrefix = cleanPhone.substring(0, 3)
                let psNetwork = 'MTN'
                if (['020', '050'].includes(psPrefix)) psNetwork = 'Telecel'
                else if (['026', '027', '056', '028', '058', '057'].includes(psPrefix)) psNetwork = 'AT'

                if (!PAYSWITCH_CHANNEL_MAP[psNetwork]) {
                    return NextResponse.json({ error: 'Unsupported payment network' }, { status: 400 })
                }

                // Written before the prompt — the callback only carries the numeric id.
                const transactionId = generatePayswitchTransactionId()
                await mapPayswitchTransaction(transactionId, referenceCode)

                const payswitchResponse = await payswitchInitiatePayment({
                    amount: totalAmount,
                    payerPhone: cleanPhone,
                    network: psNetwork,
                    transactionId,
                    description: `${shop.shop_name} - ${rcType.name} x${qty}`,
                })

                if (!payswitchResponse.success) {
                    console.error('[shop/rc/initialize] PaySwitch error:', payswitchResponse.error)
                    return NextResponse.json(
                        { error: payswitchResponse.error || 'Failed to initialize PaySwitch payment' },
                        { status: 500 }
                    )
                }

                return NextResponse.json({
                    success: true,
                    gateway: 'payswitch',
                    otpRequired: false,
                    reference: referenceCode,
                    message: 'Payment prompt sent to your phone. Please approve to complete your purchase.',
                })
            }

            // ── MOOLRE BRANCH ─────────────────────────────────────────────────────
            const prefix = cleanPhone.substring(0, 3)
            let paymentNetwork = 'MTN'
            if (['020', '050'].includes(prefix)) paymentNetwork = 'Telecel'
            else if (['026', '027', '056', '028', '058', '057'].includes(prefix)) paymentNetwork = 'AT'

            const channelId = MOOLRE_PAYMENT_CHANNEL_MAP[paymentNetwork]
            if (!channelId) {
                return NextResponse.json({ error: 'Unsupported payment network' }, { status: 400 })
            }

            let moolreResponse = await initiatePayment({
                amount: totalAmount,
                payerPhone: cleanPhone,
                channel: channelId,
                externalRef: referenceCode,
                otpCode: undefined,
            })

            if (!moolreResponse.success) {
                return NextResponse.json({ error: moolreResponse.error || 'Payment initialization failed' }, { status: 500 })
            }

            if (moolreResponse.status === '200_OTP_REQ') {
                return NextResponse.json({
                    success: true,
                    otpRequired: true,
                    reference: referenceCode,
                    message: 'OTP required. Please enter the code sent to your phone.',
                })
            }

            return NextResponse.json({
                success: true,
                reference: referenceCode,
                otpRequired: false,
                message: 'Payment prompt sent to your phone. Please approve to complete your purchase.',
            })
        }

        // ── OTP retry path (Moolre only) ──────────────────────────────────────────
        if (!otpCode) {
            return NextResponse.json({ error: 'OTP code is required to complete payment' }, { status: 400 })
        }

        const prefix = cleanPhone.substring(0, 3)
        let paymentNetwork = 'MTN'
        if (['020', '050'].includes(prefix)) paymentNetwork = 'Telecel'
        else if (['026', '027', '056', '028', '058', '057'].includes(prefix)) paymentNetwork = 'AT'

        // This retry tail was Moolre-only by construction — it sits after the
        // create-order block, so the Paystack rail never reached it and an OTP would
        // have been posted at Moolre against a Paystack reference.
        if (provider === 'paystack_momo') {
            const { data: retryOrder } = await (db.from('results_checker_orders') as any)
                .select('customer_phone, payment_status')
                .eq('reference_code', existingRef)
                .maybeSingle()

            // A guest has no account, and the reference is guessable, so the payer's
            // own number is what proves this charge is theirs to finish.
            if (!retryOrder
                || retryOrder.payment_status !== 'pending_payment'
                || String(retryOrder.customer_phone || '') !== String(cleanPhone)) {
                return NextResponse.json(
                    { error: 'That payment is no longer waiting for a code' },
                    { status: 404 }
                )
            }

            const otpResult = await submitPaystackMomoOtp({ reference: existingRef, otp: String(otpCode), payerPhone: cleanPhone })
            return NextResponse.json(otpResult.body, otpResult.ok ? undefined : { status: otpResult.httpStatus })
        }

        const channelId = MOOLRE_PAYMENT_CHANNEL_MAP[paymentNetwork]

        let moolreResponse = await initiatePayment({
            amount: totalAmount,
            payerPhone: cleanPhone,
            channel: channelId,
            externalRef: existingRef,
            otpCode,
        })

        if (moolreResponse.success && String(moolreResponse.status) === '1' && otpCode) {
            moolreResponse = await initiatePayment({
                amount: totalAmount,
                payerPhone: cleanPhone,
                channel: channelId,
                externalRef: existingRef,
            })
        }

        if (!moolreResponse.success) {
            return NextResponse.json({ error: moolreResponse.error || 'Payment failed' }, { status: 500 })
        }

        if (moolreResponse.status === '200_OTP_REQ') {
            return NextResponse.json({
                success: true,
                otpRequired: true,
                reference: existingRef,
                message: 'Invalid OTP or OTP expired. Please try again.',
            })
        }

        return NextResponse.json({
            success: true,
            reference: existingRef,
            otpRequired: false,
            message: 'Payment prompt sent to your phone. Please approve to complete your purchase.',
        })

    } catch (error: any) {
        console.error('[shop/rc/initialize]', error)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
