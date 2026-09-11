import { NextRequest, NextResponse } from 'next/server'
import { createRouteHandlerClient } from '@/lib/supabase-server'
import { Redis } from '@upstash/redis'
import { initiatePayment, MOOLRE_PAYMENT_CHANNEL_MAP } from '@/lib/moolre-payment-service'
import { initiatePayment as hubtelInitiatePayment, HUBTEL_CHANNEL_MAP, toHubtelMsisdn } from '@/lib/hubtel-payment-service'
import { checkHubtelPromptLimit, recordHubtelPrompt } from '@/lib/hubtel-prompt-limit'
import {
    initiatePayment as payswitchInitiatePayment,
    PAYSWITCH_CHANNEL_MAP,
    generatePayswitchTransactionId,
    toPayswitchMsisdn,
} from '@/lib/payswitch-payment-service'
import { mapPayswitchTransaction } from '@/lib/payswitch-reference'
import { resolveProviderForScope, type PaymentProvider } from '@/lib/payment-provider'
import { shopFeeSettingKeys, resolveShopFeePercent } from '@/lib/gateway-fees'
import { paystackMomoProviderFor } from '@/lib/paystack-momo-service'
import {
    startPaystackMomoCharge,
    submitPaystackMomoOtp,
    markPaystackMomoPending,
    clearPaystackMomoPending,
} from '@/lib/paystack-momo-checkout'
import { checkMtnRegistration, registrationRequiredBody } from '@/lib/mtn-registration-gate'

// Redis client for distributed idempotency across all serverless instances.
// In-memory Maps were removed — they reset on every Vercel cold start.
const redis = Redis.fromEnv()

export async function POST(request: NextRequest) {
    try {
        const body = await request.json()
        const { shopSlug, packageId, guestPhone, guestEmail, payerPhone, payerNetwork, orderType, network, amount, useExactAmount, isMashup, bundlePreference, otpCode, reference: existingRef } = body

        if (!shopSlug || !guestPhone) {
            return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
        }
        // Note: rate limiting for this route is enforced by the Upstash middleware limiter (shopInitialize: 10/min by IP).

        if (orderType === 'airtime' && (!network || !amount)) {
            return NextResponse.json({ error: 'Missing airtime fields' }, { status: 400 })
        } else if (orderType !== 'airtime' && !packageId) {
            return NextResponse.json({ error: 'Missing package identifier' }, { status: 400 })
        }

        let validatedGuestEmail: string | null = null
        if (guestEmail && typeof guestEmail === 'string' && guestEmail.trim()) {
            const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/
            if (emailRegex.test(guestEmail.trim()) && guestEmail.trim().length <= 254) {
                validatedGuestEmail = guestEmail.trim().toLowerCase()
            }
        }

        if (typeof shopSlug !== 'string' || !/^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$/.test(shopSlug)) {
            return NextResponse.json({ error: 'Invalid shop identifier' }, { status: 400 })
        }

        if (orderType !== 'airtime' && (typeof packageId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(packageId))) {
            return NextResponse.json({ error: 'Invalid package identifier' }, { status: 400 })
        }

        if (typeof guestPhone !== 'string') {
            return NextResponse.json({ error: 'Invalid phone number' }, { status: 400 })
        }
        const cleanPhone = guestPhone.replace(/\s+/g, '')
        if (!/^(0\d{9}|233\d{9})$/.test(cleanPhone)) {
            return NextResponse.json({ error: 'Invalid phone number. Use format: 0XXXXXXXXX or 233XXXXXXXXX' }, { status: 400 })
        }

        // The bundle goes to guestPhone; the MoMo prompt may go to a different wallet.
        // Older clients send neither field — then the beneficiary pays, as before.
        let payerClean = cleanPhone
        if (payerPhone !== undefined && payerPhone !== null && String(payerPhone).trim() !== '') {
            if (typeof payerPhone !== 'string') {
                return NextResponse.json({ error: 'Invalid Mobile Money number' }, { status: 400 })
            }
            payerClean = payerPhone.replace(/\s+/g, '')
            if (!/^(0\d{9}|233\d{9})$/.test(payerClean)) {
                return NextResponse.json({ error: 'Invalid Mobile Money number. Use format: 0XXXXXXXXX or 233XXXXXXXXX' }, { status: 400 })
            }
        }
        const payerIsSeparate = payerClean !== cleanPhone

        const { createServerClient } = await import('@/lib/supabase')
        const db = createServerClient() as any

        const { data: shop, error: shopError } = await db
            .from('shop_profiles')
            .select(`
                id, shop_name, shop_slug, owner_id, approval_status, is_active, 
                fulfillment_mode, paystack_fee_percent, owner_phone, whatsapp_number,
                airtime_fee_mtn, airtime_fee_telecel, airtime_fee_at,
                owner:users!shop_profiles_owner_id_fkey(role, email)
            `)
            .eq('shop_slug', shopSlug)
            .single()

        if (shopError || !shop) return NextResponse.json({ error: 'Shop not found' }, { status: 404 })

        const ownerRole = shop.owner?.role || 'customer'
        if (shop.approval_status !== 'approved' || !shop.is_active || !['customer', 'agent', 'dealer', 'admin', 'sub-admin'].includes(shop.owner?.role)) {
            return NextResponse.json({
                error: 'This shop is not currently active',
                contact: { phone: shop.owner_phone, whatsapp: shop.whatsapp_number, email: shop.owner?.email }
            }, { status: 403 })
        }

        const { data: settingsRows } = await db
            .from('admin_settings')
            .select('key, value')
            .in('key', [
                'shop_feature_enabled', 'storefront_airtime_enabled', 'storefront_mashup_enabled',
                'airtime_enabled_mtn', 'airtime_enabled_telecel', 'airtime_enabled_at',
                'airtime_min_amount', 'airtime_max_amount',
                'airtime_fee_mtn_customer', 'airtime_fee_mtn_agent',
                'airtime_fee_telecel_customer', 'airtime_fee_telecel_agent',
                'airtime_fee_at_customer', 'airtime_fee_at_agent',
                'active_payment_provider_shop',
            ])

        const settings: Record<string, string> = {}
        for (const row of (settingsRows || [])) settings[row.key] = row.value

        // Resolved here rather than just before the gateway branches, because the fee
        // keys depend on which rail collects — and the price has to be settled before
        // the order is priced, not after.
        const shopProvider: PaymentProvider = resolveProviderForScope(settings.active_payment_provider_shop, 'shop')

        // Fetch role-specific Paystack fee from the correct table (shop_global_settings)
        const { data: paystackFeeRows } = await db
            .from('shop_global_settings')
            .select('key, value')
            .in('key', shopFeeSettingKeys(ownerRole, shopProvider))
        const paystackFeeMap: Record<string, string> = {}
        for (const row of (paystackFeeRows || [])) paystackFeeMap[row.key] = row.value

        if (settings.shop_feature_enabled === 'false') {
            return NextResponse.json({ error: 'Shop feature is currently disabled' }, { status: 503 })
        }

        let totalAmount = 0
        let sellingPrice = 0
        let costPrice = 0
        let profit = 0
        let metadataPayload: any = {}
        let pkgNetwork = ''
        let pkgSize = ''

        if (orderType === 'airtime') {
            if (settings.storefront_airtime_enabled === 'false') {
                return NextResponse.json({ error: 'Airtime purchase is disabled' }, { status: 503 })
            }
            if (isMashup && settings.storefront_mashup_enabled !== 'true') {
                return NextResponse.json({ error: 'Mashup bundles are not currently available' }, { status: 503 })
            }
            if (settings[`airtime_enabled_${network.toLowerCase()}`] === 'false') {
                return NextResponse.json({ error: `${network} airtime is disabled` }, { status: 503 })
            }

            const numAmount = parseFloat(amount)
            const minAmount = parseFloat(settings.airtime_min_amount || '1')
            const maxAmount = parseFloat(settings.airtime_max_amount || '500')
            
            if (isNaN(numAmount) || numAmount < minAmount || numAmount > maxAmount) {
                return NextResponse.json({ error: 'Invalid airtime amount' }, { status: 400 })
            }

            const shopFeeKey = `airtime_fee_${network.toLowerCase()}`
            const shopFee = parseFloat(shop[shopFeeKey] || 0)
            const adminFee = parseFloat(settings[`airtime_fee_${network.toLowerCase()}_${ownerRole}`] || '0')
            
            if (shopFee + adminFee > 10) {
                return NextResponse.json({ error: 'Airtime is temporarily unavailable (Fee cap exceeded). Please contact the shop owner.' }, { status: 503 })
            }
            
            const totalFeeMultiplier = (shopFee + adminFee) / 100
            const feeAmount = numAmount * totalFeeMultiplier
            
            let actualAirtimeAmount = numAmount
            let actualFeeAmount = feeAmount
            
            if (useExactAmount) {
                totalAmount = Math.round((numAmount + feeAmount) * 100) // pay amount + fee
            } else {
                totalAmount = Math.round(numAmount * 100) // pay exactly amount
                actualAirtimeAmount = Math.max(0, numAmount - feeAmount)
            }
            
            if (actualAirtimeAmount < minAmount) {
                return NextResponse.json({ error: `The combined fees are too high for this amount. The minimum airtime deliverable is GHS ${minAmount}.` }, { status: 400 })
            }
            
            profit = actualAirtimeAmount > 0 ? actualAirtimeAmount * (shopFee / 100) : 0
            sellingPrice = actualAirtimeAmount
            costPrice = actualAirtimeAmount
            pkgNetwork = network
            pkgSize = `GHS ${actualAirtimeAmount.toFixed(2)} Airtime`

            metadataPayload = {
                order_type: 'airtime',
                type: isMashup ? 'mashup' : 'airtime',
                bundle_preference: isMashup ? (bundlePreference || 'balanced') : undefined,
                network,
                package_size: pkgSize,
                airtime_amount: actualAirtimeAmount,
                selling_price: actualAirtimeAmount,
                cost_price: actualAirtimeAmount,
                profit: profit,
                fee_amount: feeAmount,
                use_exact_amount: !!useExactAmount,
                original_amount: numAmount
            }
        } else {
            const { data: pkg } = await db.from('data_packages').select('*').eq('id', packageId).eq('is_available', true).single()
            if (!pkg) return NextResponse.json({ error: 'Package not found or unavailable' }, { status: 404 })

            const { data: shopPrice } = await db.from('shop_pricing').select('selling_price').eq('shop_id', shop.id).eq('package_id', packageId).single()
            if (!shopPrice) return NextResponse.json({ error: 'Package not available in this shop' }, { status: 404 })

            sellingPrice = parseFloat(shopPrice.selling_price)
            const ownerRole = shop.owner?.role || 'customer'
            const ownerIsAgentTier = ['agent', 'dealer'].includes(ownerRole)

            // Use the correct cost price based on the owner's role tier
            let tierPrice = 0
            if (ownerRole === 'dealer' && parseFloat(pkg.dealer_price) > 0) {
                tierPrice = parseFloat(pkg.dealer_price)
            } else if (ownerRole === 'agent' && parseFloat(pkg.agent_price) > 0) {
                tierPrice = parseFloat(pkg.agent_price)
            }
            const hasTierPrice = ownerIsAgentTier && tierPrice > 0
            costPrice = hasTierPrice ? tierPrice : (parseFloat(pkg.price) || 0)
            profit = hasTierPrice ? sellingPrice - costPrice : sellingPrice

            if (sellingPrice <= 0) {
                return NextResponse.json({ error: 'Invalid pricing configuration' }, { status: 400 })
            }
            // Only enforce profit margin when a known cost price exists
            if (!ownerIsAgentTier && profit <= 0) {
                return NextResponse.json({ error: 'Invalid pricing configuration' }, { status: 400 })
            }
            if (hasTierPrice && profit < 0) {
                return NextResponse.json({ error: 'Invalid pricing configuration' }, { status: 400 })
            }

            // --- Role-Aware Paystack Fee Resolution ---
            // Shared with lib/shop-order-processor.ts, which re-derives this figure at
            // settlement and rejects the order if it differs by more than five pesewas.
            const paystackFeePercent = resolveShopFeePercent(paystackFeeMap, {
                shopOverride: shop.paystack_fee_percent,
                ownerRole,
                provider: shopProvider,
            })
            const paystackFee = Math.round(sellingPrice * (paystackFeePercent / 100) * 100) / 100
            totalAmount = Math.round((sellingPrice + paystackFee) * 100)
            pkgNetwork = pkg.network
            pkgSize = pkg.size

            metadataPayload = {
                order_type: 'data',
                package_id: packageId,
                network: pkg.network,
                package_size: pkg.size,
                selling_price: sellingPrice,
                cost_price: costPrice,
                profit: profit,
                paystack_fee: paystackFee // Keeping this key name for backward compatibility with downstream processing
            }
        }

        // Payment network: the customer's explicit pick wins, then the order's own
        // network (airtime, where payer and recipient are the same), then the prefix
        // of the wallet we are about to charge.
        let paymentNetwork = ['MTN', 'Telecel', 'AT'].includes(payerNetwork) ? payerNetwork : ''
        if (!paymentNetwork && !payerIsSeparate) paymentNetwork = network
        if (!paymentNetwork || !['MTN', 'Telecel', 'AT'].includes(paymentNetwork)) {
            const prefix = payerClean.substring(0, 3)
            if (['024', '054', '055', '059', '025', '053', '098'].includes(prefix)) paymentNetwork = 'MTN'
            else if (['020', '050'].includes(prefix)) paymentNetwork = 'Telecel'
            else if (['026', '027', '056', '028', '058', '057'].includes(prefix)) paymentNetwork = 'AT'
            else paymentNetwork = 'MTN' // Fallback
        }

        // ── MTN REGISTRATION GATE ────────────────────────────────────────────────
        // Guests pay before fulfillment here, so this must run before the prompt is
        // sent — otherwise we take money for data that cannot be delivered yet.
        // Airtime is exempt: it has no whitelist.
        //
        // This 409 is FINAL. There is no acknowledgeRegistration escape on the
        // storefront, unlike the dashboard and the public API: a guest has no account,
        // so a held order is one they can neither track nor chase. Refusing the sale is
        // kinder than banking it against a two-week wait they cannot follow up on.
        if (orderType !== 'airtime') {
            const gate = await checkMtnRegistration(db, cleanPhone, pkgNetwork)
            if (gate.gated) {
                return NextResponse.json(registrationRequiredBody([gate.normalizedNumber]), { status: 409 })
            }
        }

        const shopRef = existingRef || `SHOP-${shop.id.slice(0, 8)}-${Date.now()}`

        // Full metadata used by both webhook paths
        const fullMetadata = {
            shop_id: shop.id,
            shop_name: shop.shop_name,
            shop_slug: shopSlug,
            slug: shopSlug, // legacy alias consumed by processShopOrder
            guest_phone: cleanPhone,
            payer_phone: payerClean,
            guest_email: validatedGuestEmail,
            // Which rail priced this order. processShopOrder re-derives the fee at
            // settlement and rejects a mismatch, so it has to resolve the same keys —
            // and the admin setting may have been switched in between.
            provider: shopProvider,
            fulfillment_mode: shop.fulfillment_mode,
            // Always false now — the gate above refuses instead of holding. Kept in the
            // metadata because processShopOrder still honours it for references that
            // were initialized before the hard block shipped and settle after it.
            awaiting_registration: false,
            ...metadataPayload,
        }

        // ── PAYSTACK BRANCH ──────────────────────────────────────────────────────
        if (shopProvider === 'paystack') {
            const paystackRes = await fetch('https://api.paystack.co/transaction/initialize', {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    email: validatedGuestEmail || `guest-${cleanPhone}@checkout.arhmsgh.com`,
                    amount: totalAmount, // already in pesewas
                    reference: shopRef,
                    callback_url: `${process.env.NEXT_PUBLIC_APP_URL}/shop/${shopSlug}/success?reference=${shopRef}`,
                    metadata: fullMetadata,
                }),
            })

            const paystackData = await paystackRes.json()

            if (!paystackData.status) {
                console.error('[ShopInit] Paystack init failed:', paystackData)
                return NextResponse.json({ error: 'Payment gateway error' }, { status: 500 })
            }

            return NextResponse.json({
                success: true,
                gateway: 'paystack',
                authorization_url: paystackData.data.authorization_url,
                reference: shopRef,
            })
        }

        // ── HUBTEL BRANCH ────────────────────────────────────────────────────────
        if (shopProvider === 'hubtel') {
            const hubtelChannel = HUBTEL_CHANNEL_MAP[paymentNetwork]
            if (!hubtelChannel) {
                return NextResponse.json({ error: 'Unsupported payment network' }, { status: 400 })
            }

            // No SMS verification on the storefront: guests are prompted straight away.
            // The per-number prompt limit below is the only throttle on Hubtel prompts.
            const promptLimit = await checkHubtelPromptLimit(payerClean)
            if (!promptLimit.allowed) {
                return NextResponse.json({ error: promptLimit.error }, { status: 429 })
            }

            // Metadata must land in Redis BEFORE the prompt — the callback reads it
            // and a fast approval can otherwise beat the write.
            if (!existingRef) {
                await redis.set(
                    `shop:meta:${shopRef}`,
                    JSON.stringify({ ...fullMetadata, payer_msisdn: toHubtelMsisdn(payerClean) }),
                    { ex: 86400 }
                )
            }

            const hubtelResponse = await hubtelInitiatePayment({
                amount: totalAmount / 100,   // stored in pesewas, Hubtel expects GHS
                payerPhone: payerClean,
                channel: hubtelChannel,
                clientReference: shopRef,
                customerName: 'Guest Customer',
                customerEmail: validatedGuestEmail || '',
                description: `${shop.shop_name} - ${orderType === 'airtime' ? 'Airtime' : 'Data Bundle'}`,
            })

            if (!hubtelResponse.success) {
                console.error('[ShopInit] Hubtel error:', hubtelResponse.error)
                return NextResponse.json(
                    { error: hubtelResponse.error || 'Failed to initialize Hubtel payment' },
                    { status: 500 }
                )
            }

            // Only now has a prompt actually gone to the handset.
            await recordHubtelPrompt(payerClean)

            return NextResponse.json({
                success: true,
                gateway: 'hubtel',
                reference: shopRef,
                message: 'Payment prompt sent to your phone. Please approve to complete your purchase.',
            })
        }

        // ── PAYSTACK MOBILE MONEY BRANCH ─────────────────────────────────────────
        if (shopProvider === 'paystack_momo') {
            if (!paystackMomoProviderFor(paymentNetwork)) {
                return NextResponse.json({ error: 'Unsupported payment network' }, { status: 400 })
            }

            // An OTP finishes the charge that already exists. No new order, no second
            // Redis write, and above all no second charge.
            if (otpCode && existingRef) {
                const rawMeta = await redis.get<any>(`shop:meta:${existingRef}`)
                const meta = typeof rawMeta === 'string' ? JSON.parse(rawMeta) : rawMeta
                // A guest has no account to bind this to and the references are
                // guessable, so ownership is proved by the payer's own number. Without
                // it anyone who guesses a reference can burn a stranger's OTP attempts.
                if (!meta || String(meta.payer_phone || '') !== String(payerClean)) {
                    return NextResponse.json(
                        { error: 'That payment is no longer waiting for a code' },
                        { status: 404 }
                    )
                }
                const otpResult = await submitPaystackMomoOtp({ reference: existingRef, otp: String(otpCode), payerPhone: payerClean })
                return NextResponse.json(otpResult.body, otpResult.ok ? undefined : { status: otpResult.httpStatus })
            }

            // Metadata must land in Redis BEFORE the prompt — the callback reads it
            // and a fast approval can otherwise beat the write.
            if (!existingRef) {
                await redis.set(
                    `shop:meta:${shopRef}`,
                    JSON.stringify({ ...fullMetadata, payer_msisdn: payerClean }),
                    { ex: 86400 }
                )
                // There is no wallet_payments row for a guest order, so this marker is
                // the only thing the reconciliation sweep can find it by.
                await markPaystackMomoPending(shopRef, { kind: 'shop', slug: shopSlug })
            }

            const charge = await startPaystackMomoCharge({
                reference: shopRef,
                // totalAmount is in PESEWAS in this route and only this route —
                // every other checkout holds cedis, and chargeMobileMoney multiplies
                // by 100 internally. A missed division charges the guest 100x.
                amountGhs: totalAmount / 100,
                payerPhone: payerClean,
                network: paymentNetwork,
                email: validatedGuestEmail || undefined,
                // Machine-shaped only. The settle path reads the real metadata back
                // from Redis, so the shop name never has to survive a payment field.
                metadata: { kind: 'shop', shop_id: shop.id, shop_slug: shopSlug, ref: shopRef },
            })

            if (!charge.ok) {
                if (charge.safeToMarkFailed && !existingRef) {
                    await redis.del(`shop:meta:${shopRef}`)
                    await clearPaystackMomoPending(shopRef)
                }
                return NextResponse.json(charge.body, { status: charge.httpStatus })
            }

            return NextResponse.json(charge.body)
        }

        // ── PAYSWITCH BRANCH ─────────────────────────────────────────────────────
        if (shopProvider === 'payswitch') {
            if (!PAYSWITCH_CHANNEL_MAP[paymentNetwork]) {
                return NextResponse.json({ error: 'Unsupported payment network' }, { status: 400 })
            }

            const transactionId = generatePayswitchTransactionId()

            // Both writes must land BEFORE the prompt — the callback reads the
            // metadata and resolves the reference from the id, and a fast approval
            // can otherwise beat either write.
            if (!existingRef) {
                await redis.set(
                    `shop:meta:${shopRef}`,
                    JSON.stringify({ ...fullMetadata, payer_msisdn: toPayswitchMsisdn(payerClean) }),
                    { ex: 86400 }
                )
            }
            await mapPayswitchTransaction(transactionId, shopRef)

            const payswitchResponse = await payswitchInitiatePayment({
                amount: totalAmount / 100,   // stored in pesewas, the service takes GHS
                payerPhone: payerClean,
                network: paymentNetwork,
                transactionId,
                description: `${shop.shop_name} - ${orderType === 'airtime' ? 'Airtime' : 'Data Bundle'}`,
            })

            if (!payswitchResponse.success) {
                console.error('[ShopInit] PaySwitch error:', payswitchResponse.error)
                return NextResponse.json(
                    { error: payswitchResponse.error || 'Failed to initialize PaySwitch payment' },
                    { status: 500 }
                )
            }

            return NextResponse.json({
                success: true,
                gateway: 'payswitch',
                reference: shopRef,
                message: 'Payment prompt sent to your phone. Please approve to complete your purchase.',
            })
        }

        // ── MOOLRE BRANCH ────────────────────────────────────────────────────────
        const channelId = MOOLRE_PAYMENT_CHANNEL_MAP[paymentNetwork]
        if (!channelId) {
            return NextResponse.json({ error: 'Unsupported payment network' }, { status: 400 })
        }

        const idemKey = `shop:idem:${shop.id}-${cleanPhone}-${payerClean}-${totalAmount}`
        if (!otpCode) {
            const cachedIdem = await redis.get<{ ref: string }>(idemKey)
            if (cachedIdem) {
                return NextResponse.json({ success: true, gateway: 'moolre', reference: cachedIdem.ref, message: 'Payment prompt sent to your phone.' })
            }
        }

        let moolreResponse = await initiatePayment({
            amount: totalAmount / 100,
            payerPhone: payerClean,
            channel: channelId,
            externalRef: shopRef,
            otpCode,
        })

        if (moolreResponse.success && String(moolreResponse.status) === '1' && otpCode) {
            console.log('[ShopInit] OTP verified successfully. Sending follow-up payment request.')
            moolreResponse = await initiatePayment({
                amount: totalAmount / 100,
                payerPhone: payerClean,
                channel: channelId,
                externalRef: shopRef,
            })
        }

        if (!moolreResponse.success) {
            return NextResponse.json({ error: moolreResponse.error || 'Payment initialization failed' }, { status: 500 })
        }

        if (moolreResponse.status === '200_OTP_REQ') {
            if (!existingRef) {
                await redis.set(`shop:meta:${shopRef}`, JSON.stringify(fullMetadata), { ex: 86400 })
            }
            return NextResponse.json({
                success: true,
                gateway: 'moolre',
                otpRequired: true,
                reference: shopRef,
                message: 'OTP is required to complete this payment. Please enter the code sent to your phone.',
            })
        }

        if (!existingRef) {
            await redis.set(`shop:meta:${shopRef}`, JSON.stringify(fullMetadata), { ex: 86400 })
        }

        await redis.set(idemKey, { ref: shopRef }, { ex: 60 })

        return NextResponse.json({ success: true, gateway: 'moolre', reference: shopRef, message: 'Payment prompt sent to your phone. Please approve to complete your order.' })
    } catch (error) {
        console.error('[Shop Initialize] Error:', error)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
