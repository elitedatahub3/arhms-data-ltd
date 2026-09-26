import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { Redis } from '@upstash/redis'
import { initiatePayment, MOOLRE_PAYMENT_CHANNEL_MAP } from '@/lib/moolre-payment-service'
import {
    initiatePayment as hubtelInitiatePayment,
    HUBTEL_CHANNEL_MAP,
    toHubtelSafeText,
} from '@/lib/hubtel-payment-service'
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
import { validateAfaFormData } from '@/lib/afa-validation'
import { resolveAfaCostPrice } from '@/lib/afa-pricing'

let redis: Redis | null = null
try { redis = Redis.fromEnv() } catch (_) {}

/** Maps a Ghana MoMo prefix to the payment network label the gateways expect. */
function networkForPhone(cleanPhone: string): string {
    const prefix = cleanPhone.substring(0, 3)
    if (['020', '050'].includes(prefix)) return 'Telecel'
    if (['026', '027', '056', '028', '058', '057'].includes(prefix)) return 'AT'
    return 'MTN'
}

/**
 * Guest AFA registration checkout on a shop storefront.
 *
 * Mirrors /api/shop/rc/initialize. Unlike the dashboard path, there is no wallet
 * and no `process_afa_order` RPC: the applicant pays the shop's own price through
 * a gateway, and settlement (marking the order paid + crediting the shop's
 * markup) happens in lib/afa/checkout.ts, driven by whichever of the webhook or
 * the browser poll arrives first.
 */
export async function POST(request: NextRequest) {
    try {
        const body = await request.json()
        const {
            shopSlug,
            formData,
            customerEmail,
            otpCode,
            reference: existingRef,
        } = body

        // ── Input validation ──────────────────────────────────────────────────
        if (!shopSlug) {
            return NextResponse.json({ error: 'Missing required field: shopSlug' }, { status: 400 })
        }
        if (!formData || typeof formData !== 'object') {
            return NextResponse.json({ error: 'Missing applicant details' }, { status: 400 })
        }

        // Same allowlists, ID formats and 18+ rule the dashboard enforces.
        const validationError = validateAfaFormData(formData)
        if (validationError) {
            return NextResponse.json({ error: validationError.error }, { status: validationError.status })
        }

        const cleanPhone = String(formData.phone).replace(/\s+/g, '')
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

        // ── 1. Global toggle + payment provider ───────────────────────────────
        const { data: settingsRows } = await db
            .from('admin_settings')
            .select('key, value')
            .in('key', ['storefront_afa_enabled', 'active_payment_provider_shop'])

        const adminSettings: Record<string, string> = {}
        for (const row of (settingsRows || [])) adminSettings[row.key] = row.value

        if (adminSettings['storefront_afa_enabled'] !== 'true') {
            return NextResponse.json({ error: 'AFA registration is not available on storefronts' }, { status: 503 })
        }

        // Matches the RC scope, which has always defaulted to Paystack when unset.
        const provider: PaymentProvider = resolveProviderForScope(
            adminSettings['active_payment_provider_shop'],
            'shop',
            'paystack'
        )

        // Checked before any row is written, so a throttled applicant leaves no
        // abandoned pending order behind.
        if (provider === 'hubtel' && !existingRef) {
            const promptLimit = await checkHubtelPromptLimit(cleanPhone)
            if (!promptLimit.allowed) {
                return NextResponse.json({ error: promptLimit.error }, { status: 429 })
            }
        }

        // ── 2. Fetch shop + owner role ────────────────────────────────────────
        const { data: shop } = await db
            .from('shop_profiles')
            .select('id, shop_name, owner_id, approval_status, is_active')
            .eq('shop_slug', shopSlug)
            .single()

        if (!shop || shop.approval_status !== 'approved' || !shop.is_active) {
            return NextResponse.json({ error: 'Shop is not currently active' }, { status: 403 })
        }

        // Queried separately rather than as a PostgREST embed: a to-one embed can
        // come back as an object or a single-element array depending on the
        // version, and silently reading the wrong shape would fall through to the
        // 'customer' price — charging the platform's cut against the wrong tier and
        // paying the shop the wrong markup. This is money, so it is read plainly.
        const { data: ownerRow } = await db
            .from('users')
            .select('role')
            .eq('id', shop.owner_id)
            .maybeSingle()

        const ownerRole = ownerRow?.role || 'customer'

        // ── 3. Resolve pricing ────────────────────────────────────────────────
        const { data: shopPricing } = await db
            .from('shop_afa_pricing')
            .select('selling_price')
            .eq('shop_id', shop.id)
            .maybeSingle()

        if (!shopPricing) {
            return NextResponse.json({ error: 'AFA registration is not available in this shop' }, { status: 404 })
        }

        // Cost is recomputed here rather than trusted from the pricing row, so an
        // admin changing the role price takes effect on the next order.
        const costResult = await resolveAfaCostPrice(db, ownerRole)
        if (!costResult.ok) {
            return NextResponse.json({ error: costResult.error }, { status: 500 })
        }

        const sellingPrice = parseFloat(shopPricing.selling_price)
        const costPrice = costResult.price
        const shopMarkup = Math.max(0, sellingPrice - costPrice)
        const totalAmount = sellingPrice

        const applicantName = String(formData.full_name).trim()
        // Hubtel rejects non-ASCII in Description/CustomerName by throwing after
        // the prompt is already live, so both are folded to ASCII up front.
        const safeShopName = toHubtelSafeText(shop.shop_name, 'Shop')
        const safeApplicantName = toHubtelSafeText(applicantName, 'Applicant')
        const paymentDescription = `${safeShopName} - AFA Registration`

        // ── 4. First call: create the pending order ───────────────────────────
        if (!existingRef) {
            const referenceCode = `AFA-SHOP-${shop.id.slice(0, 8)}-${Date.now()}`

            const { data: order, error: orderErr } = await db
                .from('afa_orders')
                .insert({
                    user_id: null,
                    shop_id: shop.id,
                    shop_name: shop.shop_name,
                    shop_markup: shopMarkup,
                    cost_price: costPrice,
                    payment_amount: sellingPrice,
                    customer_email: validEmail,
                    full_name: applicantName,
                    phone: cleanPhone,
                    id_type: formData.id_type,
                    id_number: String(formData.id_number).trim(),
                    // Kept in sync with id_number for backward compatibility — the
                    // dashboard RPC populates it the same way.
                    ghana_card: String(formData.id_number).trim(),
                    date_of_birth: formData.date_of_birth,
                    location: formData.location,
                    region: formData.region,
                    occupation: 'Farmer',
                    notes: formData.notes || null,
                    status: 'pending',
                    payment_status: 'pending_payment',
                    source: 'storefront',
                    reference_code: referenceCode,
                })
                .select('id')
                .single()

            if (orderErr || !order) {
                console.error('[shop/afa/initialize] Order creation failed:', orderErr)
                return NextResponse.json({ error: 'Failed to initialize registration' }, { status: 500 })
            }

            const meta = {
                shop_id: shop.id,
                shop_name: shop.shop_name,
                order_id: order.id,
                applicant_name: applicantName,
                selling_price: sellingPrice,
                cost_price: costPrice,
                shop_markup: shopMarkup,
                owner_id: shop.owner_id,
            }

            try {
                if (redis) {
                    await redis.set(`shop:afa:orderid:${referenceCode}`, order.id, { ex: 86400 })
                    await redis.set(`shop:afa:meta:${referenceCode}`, JSON.stringify(meta), { ex: 86400 })
                }
            } catch (redisErr) {
                console.error('[shop/afa/initialize] Redis cache error (non-fatal):', redisErr)
            }

            // ── PAYSTACK MOBILE MONEY BRANCH ──────────────────────────────────
            if (provider === 'paystack_momo') {
                const payerNetwork = networkForPhone(cleanPhone)
                if (!paystackMomoProviderFor(payerNetwork)) {
                    return NextResponse.json({ error: 'Unsupported payment network' }, { status: 400 })
                }

                // No wallet_payments row here, so the marker is the only handle the
                // reconciliation sweep has on this registration.
                await markPaystackMomoPending(referenceCode, { kind: 'afa', slug: shopSlug })

                const charge = await startPaystackMomoCharge({
                    reference: referenceCode,
                    amountGhs: totalAmount,
                    payerPhone: cleanPhone,
                    network: payerNetwork,
                    email: validEmail || undefined,
                    // The applicant's name never has to reach a payment field — the
                    // settle path reads it back from the order row.
                    metadata: { kind: 'afa', shop_id: shop.id, order_id: order.id },
                })

                if (!charge.ok) {
                    if (charge.safeToMarkFailed) {
                        await (db.from('afa_orders') as any)
                            .update({ payment_status: 'failed' })
                            .eq('reference_code', referenceCode)
                            .eq('payment_status', 'pending_payment')
                        await clearPaystackMomoPending(referenceCode)
                    }
                    return NextResponse.json(charge.body, { status: charge.httpStatus })
                }

                return NextResponse.json(charge.body)
            }

            // ── PAYSTACK BRANCH ───────────────────────────────────────────────
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
                            type: 'afa_registration',
                            shop_slug: shopSlug,
                            order_id: order.id,
                            customer_phone: cleanPhone,
                            ...meta,
                        },
                    }),
                })

                const paystackData = await paystackRes.json()

                if (!paystackData.status || !paystackData.data?.authorization_url) {
                    console.error('[shop/afa/initialize] Paystack init failed:', paystackData)
                    return NextResponse.json({ error: 'Payment gateway error. Please try again.' }, { status: 500 })
                }

                return NextResponse.json({
                    success: true,
                    gateway: 'paystack',
                    authorization_url: paystackData.data.authorization_url,
                    reference: referenceCode,
                })
            }

            // ── HUBTEL BRANCH ─────────────────────────────────────────────────
            if (provider === 'hubtel') {
                const hubtelChannel = HUBTEL_CHANNEL_MAP[networkForPhone(cleanPhone)]
                if (!hubtelChannel) {
                    return NextResponse.json({ error: 'Unsupported payment network' }, { status: 400 })
                }

                const hubtelResponse = await hubtelInitiatePayment({
                    amount: totalAmount,
                    payerPhone: cleanPhone,
                    channel: hubtelChannel,
                    clientReference: referenceCode,
                    customerName: safeApplicantName,
                    customerEmail: validEmail || '',
                    description: paymentDescription,
                })

                if (!hubtelResponse.success) {
                    console.error('[shop/afa/initialize] Hubtel error:', hubtelResponse.error)
                    return NextResponse.json(
                        { error: hubtelResponse.error || 'Failed to initialize Hubtel payment' },
                        { status: 500 }
                    )
                }

                // Only now has a prompt actually reached the handset.
                await recordHubtelPrompt(cleanPhone)

                return NextResponse.json({
                    success: true,
                    gateway: 'hubtel',
                    otpRequired: false,
                    reference: referenceCode,
                    message: 'Payment prompt sent to your phone. Please approve to complete your registration.',
                })
            }

            // ── PAYSWITCH BRANCH ──────────────────────────────────────────────
            if (provider === 'payswitch') {
                const psNetwork = networkForPhone(cleanPhone)
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
                    description: paymentDescription,
                })

                if (!payswitchResponse.success) {
                    console.error('[shop/afa/initialize] PaySwitch error:', payswitchResponse.error)
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
                    message: 'Payment prompt sent to your phone. Please approve to complete your registration.',
                })
            }

            // ── MOOLRE BRANCH ─────────────────────────────────────────────────
            const channelId = MOOLRE_PAYMENT_CHANNEL_MAP[networkForPhone(cleanPhone)]
            if (!channelId) {
                return NextResponse.json({ error: 'Unsupported payment network' }, { status: 400 })
            }

            const moolreResponse = await initiatePayment({
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
                message: 'Payment prompt sent to your phone. Please approve to complete your registration.',
            })
        }

        // ── OTP retry path (Moolre only) ──────────────────────────────────────
        if (!otpCode) {
            return NextResponse.json({ error: 'OTP code is required to complete payment' }, { status: 400 })
        }

        // Moolre-only by construction until now: this tail sits after the create-order
        // block, so a Paystack OTP would have been posted at Moolre against a
        // reference it never issued.
        if (provider === 'paystack_momo') {
            const { data: retryOrder } = await (db.from('afa_orders') as any)
                .select('phone, payment_status')
                .eq('reference_code', existingRef)
                .maybeSingle()

            // A guest has no account and the reference is guessable, so the payer's
            // own number is what proves this charge is theirs to finish.
            if (!retryOrder
                || retryOrder.payment_status !== 'pending_payment'
                || String(retryOrder.phone || '') !== String(cleanPhone)) {
                return NextResponse.json(
                    { error: 'That payment is no longer waiting for a code' },
                    { status: 404 }
                )
            }

            const otpResult = await submitPaystackMomoOtp({ reference: existingRef, otp: String(otpCode), payerPhone: cleanPhone })
            return NextResponse.json(otpResult.body, otpResult.ok ? undefined : { status: otpResult.httpStatus })
        }

        const channelId = MOOLRE_PAYMENT_CHANNEL_MAP[networkForPhone(cleanPhone)]

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
            message: 'Payment prompt sent to your phone. Please approve to complete your registration.',
        })

    } catch (error: any) {
        console.error('[shop/afa/initialize]', error)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
