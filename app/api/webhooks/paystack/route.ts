import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { processCompletedWalletPayment } from '@/lib/payments'
import { Redis } from '@upstash/redis'
import { clearPaystackMomoPending } from '@/lib/paystack-momo-checkout'
import { clearPaystackMomoPromptCount } from '@/lib/hubtel-prompt-limit'
import crypto from 'crypto'

const redis = Redis.fromEnv()

export async function POST(request: NextRequest) {
    try {
        const supabase = createServerClient()

        // Read inside the handler rather than asserting at module scope. A missing
        // key used to surface as an opaque crash inside createHmac; this names the
        // variable, which is the difference between a five-minute fix and an hour.
        const secretKey = process.env.PAYSTACK_SECRET_KEY
        if (!secretKey) {
            console.error('[PaystackWebhook] PAYSTACK_SECRET_KEY is not set — cannot verify signatures')
            return NextResponse.json({ error: 'Webhook not configured' }, { status: 503 })
        }

        // Verify webhook signature
        const signature = request.headers.get('x-paystack-signature')
        const body = await request.text()

        const hash = crypto
            .createHmac('sha512', secretKey)
            .update(body)
            .digest('hex')

        // Length-guarded timingSafeEqual rather than !==. The comparison is against
        // an attacker-supplied header, and a variable-time compare leaks how much of
        // a guessed signature was correct.
        const signatureBuffer = Buffer.from(signature ?? '', 'utf8')
        const hashBuffer = Buffer.from(hash, 'utf8')
        const signatureValid =
            signatureBuffer.length === hashBuffer.length
            && crypto.timingSafeEqual(signatureBuffer, hashBuffer)

        if (!signatureValid) {
            console.error('[PaystackWebhook] Invalid webhook signature')
            return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
        }

        const event = JSON.parse(body)

        if (event.event === 'charge.success') {
            const { reference, amount: paidAmountKobo } = event.data
            const metadata = event.data.metadata

            // A number that just approved a prompt has proven it wants them, so its
            // earlier prompts should not be held against it. Done before the routing
            // below because every branch returns from inside itself.
            const approvedMsisdn =
                event.data?.authorization?.mobile_money_number
                || metadata?.payer_msisdn
                || metadata?.payer_phone
            if (approvedMsisdn) {
                await clearPaystackMomoPromptCount(String(approvedMsisdn)).catch(() => {})
            }

            // o. USSD SALES: USSD- references are in-session USSD purchases paid by
            // Paystack Mobile Money. Checked FIRST because, like SHOP-, they have no
            // wallet_payments row to look up — a USSD caller has no account, so there
            // is no user_id or wallet_id for that table's NOT NULL columns.
            //
            // These used to never reach this webhook at all: Hubtel collected them via
            // AddToCart and reported to /api/hubtel/fulfill. That endpoint still works
            // for anything in flight, but this is the live path now.
            if (reference && reference.startsWith('USSD-')) {
                const { ensureUssdSession } = await import('@/lib/ussd-reference')
                const { logCallback } = await import('@/lib/hubtel-payment-log')

                // Paystack echoes back the metadata the charge was created with, so
                // it tells us which session it is settling. No mapping store needed —
                // the reference is only the fallback, for a charge whose metadata did
                // not survive.
                const resolved = await ensureUssdSession(supabase, {
                    sessionId: metadata?.session_id,
                    orderType: metadata?.order_type,
                    reference,
                })
                if (!resolved) {
                    // Money has moved and we cannot tell what it bought. Say so loudly
                    // and leave the row un-settled for a human — acking silently would
                    // bury it.
                    console.error('[PaystackWebhook] USSD order could not be resolved:', reference)
                    await logCallback({
                        clientReference: reference,
                        status: 'failed',
                        amount: paidAmountKobo / 100,
                        message: 'Paid but the USSD session could not be found.',
                        raw: event.data,
                    })
                    return NextResponse.json({ received: true })
                }

                // Paystack reports gross pesewas, which is exactly what both fulfillers
                // want — no gross-vs-net reconstruction like the Hubtel path needed.
                const amountPaid = paidAmountKobo / 100
                const deferredWork: Array<() => Promise<void>> = []

                const result = resolved.orderType === 'data'
                    ? await (await import('@/lib/ussd-data-fulfillment')).fulfillUSSDDataBySession({
                        sessionId: resolved.sessionId,
                        referenceCode: reference,
                        amountPaid,
                        deferredWork,
                    })
                    : await (await import('@/lib/ussd-rc-fulfillment')).fulfillUSSDRCBySession({
                        sessionId: resolved.sessionId,
                        referenceCode: reference,
                        amountPaid,
                        deferredWork,
                    })

                await logCallback({
                    clientReference: reference,
                    status: result.success ? 'success' : 'failed',
                    amount: amountPaid,
                    transactionId: event.data.id ? String(event.data.id) : null,
                    payerMsisdn: metadata?.payer_msisdn ?? null,
                    message: result.success ? null : `Paid but fulfilment failed: ${result.error ?? 'unknown error'}`,
                    raw: event.data,
                })

                if (!result.success) {
                    console.error('[PaystackWebhook] USSD fulfilment failed:', reference, result.error)
                }

                for (const task of deferredWork) {
                    await task().catch(() => {})
                }

                return NextResponse.json({ received: true })
            }

            // o. SHOP ORDERS: References starting with SHOP- are storefront guest orders.
            // They are NOT stored in wallet_payments, so we must handle them separately
            // before the DB lookup to avoid "Payment not found" errors.
            if (reference && reference.startsWith('SHOP-')) {
                // Hosted checkout echoes back the whole metadata object we sent at
                // init. The MoMo rail deliberately sends a compact payload instead —
                // ids and slugs, no display text — so fall back to the copy in Redis,
                // exactly as /api/shop/verify and the PaySwitch sweep already do.
                let shopMetadata = metadata
                if (!shopMetadata?.shop_id) {
                    const raw = await redis.get<any>(`shop:meta:${reference}`)
                    shopMetadata = typeof raw === 'string' ? JSON.parse(raw) : raw
                }

                if (!shopMetadata?.shop_id) {
                    // Say so loudly and leave it for a human rather than acking a paid
                    // order into silence. The money is in and nothing can price it.
                    console.error('[PaystackWebhook] SHOP- paid but metadata is gone:', reference)
                    const { logCallback } = await import('@/lib/hubtel-payment-log')
                    await logCallback({
                        clientReference: reference,
                        status: 'failed',
                        amount: paidAmountKobo / 100,
                        message: 'Paid but the shop order metadata could not be found.',
                        raw: event.data,
                    })
                    return NextResponse.json({ received: true })
                }

                const { processShopOrder } = await import('@/lib/shop-order-processor')
                console.log('[PaystackWebhook] Routing shop order payment')
                await processShopOrder(
                    reference,
                    shopMetadata,
                    paidAmountKobo,
                    shopMetadata.slug ?? shopMetadata.shop_slug
                )
                await clearPaystackMomoPending(reference)
                return NextResponse.json({ received: true })
            }

            // o. RC VOUCHERS: References starting with RC- are voucher purchases
            if (reference && reference.startsWith('RC-')) {
                const { finalizeRCGatewayOrder } = await import('@/lib/vouchers/checkout')
                console.log('[PaystackWebhook] Routing RC Voucher order payment')
                await finalizeRCGatewayOrder({ reference, paidAmountKobo, metadata })
                return NextResponse.json({ received: true })
            }

            // o. AFA REGISTRATION: AFA-SHOP- references are storefront AFA
            // applications. Checked after SHOP-/RC- but the prefixes cannot
            // collide — startsWith is anchored.
            if (reference && reference.startsWith('AFA-SHOP-')) {
                const { finalizeAfaShopOrder } = await import('@/lib/afa/checkout')
                console.log('[PaystackWebhook] Routing AFA registration payment')
                await finalizeAfaShopOrder({ reference, paidAmountKobo })
                return NextResponse.json({ received: true })
            }

            // Get payment record for verification
            const { data: payment } = await supabase
                .from('wallet_payments')
                .select('total_amount, status')
                .eq('reference', reference)
                .single()

            if (!payment) {
                console.error('[PaystackWebhook] Payment not found:', reference)
                return NextResponse.json({ received: true })
            }

            // o. IDEMPOTENCY CHECK: Prevent duplicate webhook processing for ALL payment types
            // This guard covers both wallet top-ups and agent upgrades.
            // Paystack guarantees at-least-once delivery, so this is critical.
            if ((payment as any).status === 'completed') {
                console.log('[PaystackWebhook] Payment already processed, ignoring duplicate webhook')
                return NextResponse.json({ received: true })
            }

            // o. AMOUNT VERIFICATION: Cross-check paid amount against DB-stored expected amount
            const expectedAmountKobo = Math.round((payment as any).total_amount * 100)
            if (paidAmountKobo !== expectedAmountKobo) {
                console.error(`[PaystackWebhook] AMOUNT MISMATCH: Expected ${expectedAmountKobo}, got ${paidAmountKobo}`)
                return NextResponse.json({ received: true })
            }

            // o. DATA BUNDLES: References starting with DATA- are direct-pay data orders
            if (reference && reference.startsWith('DATA-')) {
                const { processDataDirectOrder } = await import('@/lib/data-order-payments')
                console.log('[PaystackWebhook] Routing direct-pay data order:', reference)
                await processDataDirectOrder(reference)
                return NextResponse.json({ received: true })
            }

            // o. UTILITY BILLS: References starting with UTIL- are direct-pay bill payments
            if (reference && reference.startsWith('UTIL-')) {
                const { processUtilityDirectOrder } = await import('@/lib/utility-order-payments')
                console.log('[PaystackWebhook] Routing direct-pay utility bill:', reference)
                await processUtilityDirectOrder(reference)
                return NextResponse.json({ received: true })
            }

            // o. AIRTIME: References starting with AIRPAY- are direct-pay airtime top-ups
            if (reference && reference.startsWith('AIRPAY-')) {
                const { processAirtimeDirectOrder } = await import('@/lib/airtime-order-payments')
                console.log('[PaystackWebhook] Routing direct-pay airtime order:', reference)
                await processAirtimeDirectOrder(reference)
                return NextResponse.json({ received: true })
            }

            // o. BOOST PAYMENTS: References starting with BOOST- are classified listing boosts
            if (reference && reference.startsWith('BOOST-')) {
                const { processBoostPayment } = await import('@/lib/classifieds-payments')
                console.log('[PaystackWebhook] Routing listing boost payment:', reference)
                const boostResult = await processBoostPayment(reference, event.data)

                if (!boostResult.success && !boostResult.alreadyProcessed) {
                    console.error('[PaystackWebhook] Boost processing failed:', boostResult.error)
                    return NextResponse.json({ error: boostResult.error }, { status: 500 })
                }
                return NextResponse.json({ received: true })
            }

            // Route by payment type based on metadata
            if (reference.startsWith('agent_upgrade_') || metadata?.upgrade_type === 'agent') {
                // Agent membership upgrades
                const { processCompletedUpgradePayment } = await import('@/lib/payments')
                await processCompletedUpgradePayment(reference, event.data)
            } else if (reference.startsWith('ussd_activation_') || metadata?.upgrade_type === 'ussd_activation') {
                // USSD short code activation
                const { processCompletedUssdActivation } = await import('@/lib/payments')
                await processCompletedUssdActivation(reference, event.data)
            } else if (reference.startsWith('dealer_sub_') || metadata?.upgrade_type === 'dealer_subscription') {
                // Dealer subscriptions
                const { processCompletedDealerSubscription } = await import('@/lib/payments')
                await processCompletedDealerSubscription(reference, event.data)
            } else {
                // Standard wallet top-up
                await processCompletedWalletPayment(reference, event.data)
            }
        }

        return NextResponse.json({ received: true })
    } catch (error) {
        console.error('[PaystackWebhook] Webhook error:', error)
        return NextResponse.json({ error: 'Webhook processing failed' }, { status: 500 })
    }
}
