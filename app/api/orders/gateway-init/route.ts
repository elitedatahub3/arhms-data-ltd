import { NextRequest, NextResponse } from 'next/server'
import { createRouteHandlerClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { calculatePaystackFee, generateReferenceCode } from '@/lib/utils'
import { initiatePayment, MOOLRE_PAYMENT_CHANNEL_MAP } from '@/lib/moolre-payment-service'
import { initiatePayment as hubtelInitiatePayment, HUBTEL_CHANNEL_MAP, calculateHubtelFee, toHubtelMsisdn } from '@/lib/hubtel-payment-service'
import { checkHubtelPromptLimit, recordHubtelPrompt } from '@/lib/hubtel-prompt-limit'
import { resolveDataPrice } from '@/lib/data-order-pricing'
import { initiatePayment as payswitchInitiatePayment, PAYSWITCH_CHANNEL_MAP } from '@/lib/payswitch-payment-service'
import { assignPayswitchTransactionId } from '@/lib/payswitch-reference'
import { resolveProviderForScope, type PaymentProvider } from '@/lib/payment-provider'
import { WEB_FEE_SETTING_KEYS, resolveWebFeePercent } from '@/lib/gateway-fees'
import { paystackMomoProviderFor } from '@/lib/paystack-momo-service'
import {
    startPaystackMomoCharge,
    submitPaystackMomoOtp,
    assertOwnPendingPayment,
    type MomoChargeResult,
} from '@/lib/paystack-momo-checkout'

/**
 * Direct Pay for data bundles.
 *
 * Unlike /api/orders/purchase (which debits the wallet and creates the order
 * immediately), this route takes payment through the active gateway first.
 * No `orders` row is written here — only a pending `wallet_payments` intent
 * carrying the order details in `metadata`. When the gateway confirms payment,
 * processDataDirectOrder() in lib/data-order-payments.ts creates the real
 * order(s) and dispatches fulfillment.
 *
 * Accepts a single item ({ packageId, phoneNumber }) or a basket
 * ({ orders: [{ packageId, phoneNumber }, ...] }) for bulk.
 */

const GHANA_PHONE_REGEX = /^(0\d{9}|233\d{9})$/
const MAX_BULK_ITEMS = 20

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

        if (!authUser) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const userId = authUser.id
        const supabase = createServerClient() as any

        let body: any
        try {
            body = await request.json()
        } catch {
            return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
        }

        const {
            packageId,
            phoneNumber,
            orders: rawOrders,
            momoPhone,
            momoNetwork,
            otpCode,
            reference: existingRef,
        } = body

        // ── Normalize single vs bulk into one list ────────────────────────────
        const requestedItems: { packageId: string; phoneNumber: string }[] = Array.isArray(rawOrders)
            ? rawOrders
            : (packageId && phoneNumber ? [{ packageId, phoneNumber }] : [])

        if (requestedItems.length === 0) {
            return NextResponse.json({ error: 'No packages provided' }, { status: 400 })
        }

        if (requestedItems.length > MAX_BULK_ITEMS) {
            return NextResponse.json({ error: `Maximum ${MAX_BULK_ITEMS} orders per batch` }, { status: 400 })
        }

        const isBulk = requestedItems.length > 1

        // ── Validate + de-duplicate ───────────────────────────────────────────
        const seen = new Set<string>()
        const items: { packageId: string; phoneNumber: string }[] = []
        for (const item of requestedItems) {
            if (!item?.packageId || typeof item.packageId !== 'string') {
                return NextResponse.json({ error: 'Invalid package ID format' }, { status: 400 })
            }
            if (!item?.phoneNumber || typeof item.phoneNumber !== 'string') {
                return NextResponse.json({ error: 'Phone number is required' }, { status: 400 })
            }

            const cleanPhone = item.phoneNumber.replace(/\s+/g, '')
            if (!GHANA_PHONE_REGEX.test(cleanPhone)) {
                return NextResponse.json({
                    error: `Invalid phone number format for ${item.phoneNumber}. Use Ghana format: 0XXXXXXXXX or 233XXXXXXXXX`,
                }, { status: 400 })
            }

            const key = `${cleanPhone}-${item.packageId}`
            if (!seen.has(key)) {
                seen.add(key)
                items.push({ packageId: item.packageId, phoneNumber: cleanPhone })
            }
        }

        // ── Sub-agent gate (matches the wallet paths) ─────────────────────────
        const { data: subAgentData } = await supabase
            .from('sub_agents')
            .select('id')
            .eq('user_id', userId)
            .single()

        if (isBulk && subAgentData) {
            return NextResponse.json(
                { error: 'Bulk purchase is not yet available for sub-agents. Use single purchase instead.' },
                { status: 403 }
            )
        }

        // ── Load profile + settings ───────────────────────────────────────────
        const [{ data: profile }, { data: settingsRows }] = await Promise.all([
            supabase.from('users').select('email, first_name, last_name, phone_number, role').eq('id', userId).single(),
            supabase.from('admin_settings').select('key, value').in('key', [
                ...WEB_FEE_SETTING_KEYS,
                'active_payment_provider_web',
            ]),
        ])

        const settingsMap: Record<string, any> = {}
        for (const row of ((settingsRows as any[]) || [])) settingsMap[row.key] = row.value

        const userRole = (profile as any)?.role
        const isAgentOrAdmin = userRole === 'agent' || userRole === 'admin' || userRole === 'sub-admin'

        if (isBulk && !isAgentOrAdmin) {
            return NextResponse.json({ error: 'Bulk orders are only available to agents and admins' }, { status: 403 })
        }

        const gateway: PaymentProvider = resolveProviderForScope(settingsMap.active_payment_provider_web, 'web')

        // ── Blacklist check ───────────────────────────────────────────────────
        const { data: blacklisted } = await supabase
            .from('phone_blacklist')
            .select('phone_number')
            .in('phone_number', items.map(i => i.phoneNumber))

        if (blacklisted && blacklisted.length > 0) {
            return NextResponse.json({ error: 'One or more phone numbers are not allowed' }, { status: 400 })
        }

        // ── Load packages + resolve authoritative prices ──────────────────────
        const packageIds = [...new Set(items.map(i => i.packageId))]
        const { data: packages } = await supabase
            .from('data_packages')
            .select('*')
            .in('id', packageIds)
            .eq('is_available', true)

        const pkgMap = new Map((packages || []).map((p: any) => [p.id, p]))

        const metadataItems: any[] = []
        for (const item of items) {
            const pkg = pkgMap.get(item.packageId)
            if (!pkg) {
                return NextResponse.json({ error: 'Package not found' }, { status: 404 })
            }

            const priceResult = await resolveDataPrice(supabase, userId, pkg)
            if (!priceResult.ok || !priceResult.data) {
                return NextResponse.json(
                    { error: priceResult.error || 'Failed to resolve price' },
                    { status: priceResult.status || 500 }
                )
            }

            metadataItems.push({
                package_id: (pkg as any).id,
                phone_number: item.phoneNumber,
                price: priceResult.data.price,
                network: (pkg as any).network,
                size: (pkg as any).size,
                cost_price: (pkg as any).cost_price || 0,
                role_at_time: priceResult.data.role,
            })
        }

        // NOTE: the MTN registration gate deliberately does NOT run here — see
        // app/api/orders/purchase/route.ts for the reasoning. Nothing sets
        // item.awaiting_registration any more, so lib/data-order-payments.ts reads it as
        // false for every new payment; it still honours a true value so references
        // initialized before this shipped settle correctly.

        const subtotal = parseFloat(
            metadataItems.reduce((sum, i) => sum + Number(i.price), 0).toFixed(2)
        )

        if (!(subtotal > 0)) {
            return NextResponse.json({ error: 'Invalid order total' }, { status: 400 })
        }

        // ── Gateway fee (server is the source of truth) ───────────────────────
        let fee: number
        let totalAmount: number

        if (gateway === 'hubtel') {
            const hubtelFees = calculateHubtelFee(subtotal)
            fee = hubtelFees.fee
            totalAmount = hubtelFees.total
        } else if (gateway === 'paystack' || gateway === 'paystack_momo' || gateway === 'payswitch') {
            // PaySwitch bills the merchant, not the payer, so it needs the same
            // percentage added on our side that Paystack does — as does the Paystack
            // MoMo rail, which is the same merchant account reached differently.
            // (Moolre, below, charges the payer directly — hence its zero fee.)
            const feePercent = resolveWebFeePercent(settingsMap, { role: userRole, provider: gateway })
            fee = calculatePaystackFee(subtotal, feePercent)
            totalAmount = parseFloat((subtotal + fee).toFixed(2))
        } else {
            // Moolre charges the payer directly — no fee added on our side
            fee = 0
            totalAmount = subtotal
        }

        // ── Get or create wallet (wallet_payments needs a wallet_id) ──────────
        let { data: wallet } = await supabase.from('wallets').select('id').eq('user_id', userId).single()
        if (!wallet) {
            const { data: newWallet, error: walletError } = await supabase
                .from('wallets')
                .insert({ user_id: userId })
                .select()
                .single()
            if (walletError || !newWallet) {
                console.error('[DataGatewayInit] Wallet create failed:', walletError?.message)
                return NextResponse.json({ error: 'Failed to initialize payment. Please try again.' }, { status: 500 })
            }
            wallet = newWallet
        }

        // ── Create (or reuse, on OTP retry) the payment intent ────────────────
        const reference = existingRef || `DATA-${generateReferenceCode()}`
        let paymentId: string | null = null

        if (existingRef) {
            if (!String(existingRef).startsWith('DATA-')) {
                return NextResponse.json({ error: 'Invalid payment reference' }, { status: 400 })
            }
            const { data: existingPayment } = await supabase
                .from('wallet_payments')
                .select('id, user_id, status')
                .eq('reference', existingRef)
                .single()

            if (existingPayment) {
                if ((existingPayment as any).user_id !== userId) {
                    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
                }
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
                    fee,
                    total_amount: totalAmount,
                    reference,
                    provider: gateway,
                    status: 'pending',
                    metadata: {
                        kind: 'data_order',
                        user_id: userId,
                        role: userRole || 'customer',
                        is_bulk: isBulk,
                        items: metadataItems,
                    },
                })
                .select()
                .single()

            if (paymentError || !payment) {
                console.error('[DataGatewayInit] wallet_payments insert error:', paymentError?.message)
                return NextResponse.json({ error: 'Failed to create payment record' }, { status: 500 })
            }
            paymentId = (payment as any).id
        }

        const description = isBulk
            ? `ARHMS Data Bundles x${metadataItems.length}`
            : `ARHMS Data - ${metadataItems[0].network} ${metadataItems[0].size}`

        // ── PAYSTACK ──────────────────────────────────────────────────────────
        if (gateway === 'paystack') {
            if (!process.env.PAYSTACK_SECRET_KEY || !process.env.NEXT_PUBLIC_APP_URL) {
                console.error('[DataGatewayInit] Paystack env vars missing')
                return NextResponse.json({ error: 'Payment gateway is not configured. Please contact support.' }, { status: 503 })
            }

            const userEmail = (profile as any)?.email
            if (!userEmail) {
                return NextResponse.json(
                    { error: 'Account email is required for card payment. Please update your profile.' },
                    { status: 400 }
                )
            }

            // No try/catch here used to mean a slow/unreachable Paystack, a timeout, or
            // a non-JSON response threw straight past this branch into the route's
            // generic catch-all, leaving the wallet_payments row stuck 'pending' and
            // the customer with nothing but "Internal server error". Matches the
            // hardening applied to the shop storefront's equivalent branch.
            let paystackRes: Response
            try {
                paystackRes = await fetch('https://api.paystack.co/transaction/initialize', {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        email: userEmail,
                        amount: Math.round(totalAmount * 100), // pesewas
                        reference,
                        callback_url: `${process.env.NEXT_PUBLIC_APP_URL}/dashboard/data-packages?reference=${reference}`,
                        metadata: { order_type: 'data_order', item_count: metadataItems.length },
                    }),
                    signal: AbortSignal.timeout(15_000),
                })
            } catch (err: any) {
                console.error('[DataGatewayInit] Paystack init request failed:', err?.message || err)
                await supabase.from('wallet_payments').update({ status: 'failed' }).eq('id', paymentId)
                return NextResponse.json({ error: 'Could not reach the payment provider. Please try again shortly.' }, { status: 502 })
            }

            const paystackText = await paystackRes.text()
            let paystackData: any
            try {
                paystackData = JSON.parse(paystackText)
            } catch (parseErr) {
                console.error('[DataGatewayInit] Unparseable Paystack response. Status:', paystackRes.status, 'Body:', paystackText.slice(0, 500))
                await supabase.from('wallet_payments').update({ status: 'failed' }).eq('id', paymentId)
                return NextResponse.json({ error: 'Payment gateway returned an unexpected response. Please try again shortly.' }, { status: 502 })
            }

            if (!paystackData.status) {
                console.error('[DataGatewayInit] Paystack init failed:', paystackData?.message)
                await supabase.from('wallet_payments').update({ status: 'failed' }).eq('id', paymentId)
                return NextResponse.json({ error: paystackData?.message || 'Payment gateway initialization failed' }, { status: 500 })
            }

            return NextResponse.json({
                success: true,
                gateway: 'paystack',
                authorization_url: paystackData.data.authorization_url,
                reference,
                amount: totalAmount,
                fee,
            })
        }

        // ── PAYSTACK MOBILE MONEY ─────────────────────────────────────────────
        // The Charge API rather than transaction/initialize: the prompt goes to the
        // handset and there is no page to redirect to.
        if (gateway === 'paystack_momo') {
            if (!momoPhone || !momoNetwork || !paystackMomoProviderFor(momoNetwork)) {
                return NextResponse.json({ error: 'Valid Mobile Money network is required' }, { status: 400 })
            }

            const finish = async (result: MomoChargeResult) => {
                if (!result.ok) {
                    // Not marked failed on a duplicate reference or a network throw:
                    // both mean a charge may exist, and a failed row can never be
                    // settled afterwards.
                    if (result.safeToMarkFailed && !existingRef) {
                        await supabase.from('wallet_payments')
                            .update({ status: 'failed' })
                            .eq('id', paymentId)
                            .eq('status', 'pending')
                    }
                    return NextResponse.json(result.body, { status: result.httpStatus })
                }
                if (result.outcome === 'paid') {
                    const { processDataDirectOrder } = await import('@/lib/data-order-payments')
                    await processDataDirectOrder(reference)
                }
                return NextResponse.json({ ...result.body, amount: totalAmount, fee })
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
                email: (profile as any)?.email,
                metadata: { user_id: userId, kind: 'data_order', item_count: metadataItems.length },
                userId,
            }))
        }

        // ── HUBTEL ────────────────────────────────────────────────────────────
        if (gateway === 'hubtel') {
            if (!momoNetwork || !HUBTEL_CHANNEL_MAP[momoNetwork]) {
                return NextResponse.json({ error: 'Valid Mobile Money network is required' }, { status: 400 })
            }

            // Use the phone number the user submitted directly.
            const payerPhone = toHubtelMsisdn(momoPhone || '') || momoPhone

            if (!payerPhone) {
                return NextResponse.json(
                    { error: 'Please provide a Mobile Money phone number.' },
                    { status: 400 }
                )
            }

            // Applies to trusted numbers too — see lib/hubtel-prompt-limit.ts.
            const promptLimit = await checkHubtelPromptLimit(payerPhone)
            if (!promptLimit.allowed) {
                await supabase.from('wallet_payments').update({ status: 'failed' }).eq('id', paymentId)
                return NextResponse.json({ error: promptLimit.error }, { status: 429 })
            }

            // Record the payer for webhook usage stats. Read-modify-write: this metadata
            // carries the order items that processDataDirectOrder depends on, so it must
            // be merged, never replaced.
            const { data: currentPayment } = await supabase
                .from('wallet_payments')
                .select('metadata')
                .eq('id', paymentId)
                .single()
            await supabase
                .from('wallet_payments')
                .update({
                    metadata: {
                        ...(((currentPayment as any)?.metadata) || {}),
                        payer_msisdn: toHubtelMsisdn(payerPhone),
                    },
                } as any)
                .eq('id', paymentId)

            const hubtelResponse = await hubtelInitiatePayment({
                amount: totalAmount,
                payerPhone,
                channel: HUBTEL_CHANNEL_MAP[momoNetwork],
                clientReference: reference,
                customerName: `${(profile as any)?.first_name || ''} ${(profile as any)?.last_name || ''}`.trim() || 'Customer',
                customerEmail: (profile as any)?.email || '',
                description,
                userId,
            })

            if (!hubtelResponse.success) {
                console.error('[DataGatewayInit] Hubtel error:', hubtelResponse.error)
                await supabase.from('wallet_payments').update({ status: 'failed' }).eq('id', paymentId)
                return NextResponse.json({ error: hubtelResponse.error || 'Failed to initialize Hubtel payment' }, { status: 500 })
            }

            // Only now has a prompt actually gone to the handset.
            await recordHubtelPrompt(payerPhone)

            return NextResponse.json({
                success: true,
                gateway: 'hubtel',
                otpRequired: false,
                reference,
                amount: totalAmount,
                fee,
                message: 'Payment prompt sent to your phone. Please approve to complete your purchase.',
            })
        }

        // ── PAYSWITCH ─────────────────────────────────────────────────────────
        if (gateway === 'payswitch') {
            if (!momoPhone || !momoNetwork || !PAYSWITCH_CHANNEL_MAP[momoNetwork]) {
                return NextResponse.json({ error: 'Valid Mobile Money phone number and network are required' }, { status: 400 })
            }

            const { transactionId, error: txIdError } = await assignPayswitchTransactionId(supabase, { id: paymentId! })
            if (!transactionId) {
                console.error('[DataGatewayInit] PaySwitch transaction id error:', txIdError)
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
                console.error('[DataGatewayInit] PaySwitch error:', payswitchResponse.error)
                await supabase.from('wallet_payments').update({ status: 'failed' }).eq('id', paymentId)
                return NextResponse.json({ error: payswitchResponse.error || 'Failed to initialize PaySwitch payment' }, { status: 500 })
            }

            return NextResponse.json({
                success: true,
                gateway: 'payswitch',
                otpRequired: false,
                reference,
                amount: totalAmount,
                fee,
                message: 'Payment prompt sent to your phone. Please approve to complete your purchase.',
            })
        }

        // ── MOOLRE ────────────────────────────────────────────────────────────
        if (!momoPhone || !momoNetwork || !MOOLRE_PAYMENT_CHANNEL_MAP[momoNetwork]) {
            return NextResponse.json(
                { error: 'Valid MoMo phone number and network are required for mobile money payments' },
                { status: 400 }
            )
        }

        const channelId = MOOLRE_PAYMENT_CHANNEL_MAP[momoNetwork]

        let moolreResponse = await initiatePayment({
            amount: totalAmount,
            payerPhone: momoPhone,
            channel: channelId,
            externalRef: reference,
            otpCode,
        })

        // OTP just verified — send the actual payment request
        if (moolreResponse.success && String(moolreResponse.status) === '1' && otpCode) {
            moolreResponse = await initiatePayment({
                amount: totalAmount,
                payerPhone: momoPhone,
                channel: channelId,
                externalRef: reference,
            })
        }

        if (!moolreResponse.success) {
            console.error('[DataGatewayInit] Moolre error:', moolreResponse.error)
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
                fee,
                message: 'OTP is required to complete this payment. Please enter the code sent to your phone.',
            })
        }

        return NextResponse.json({
            success: true,
            gateway: 'moolre',
            otpRequired: false,
            reference,
            amount: totalAmount,
            fee,
            message: 'Payment prompt sent to your phone. Please approve to complete your purchase.',
        })
    } catch (error: any) {
        console.error('[DataGatewayInit] Error:', error)
        return NextResponse.json({ error: 'Failed to process checkout' }, { status: 500 })
    }
}
