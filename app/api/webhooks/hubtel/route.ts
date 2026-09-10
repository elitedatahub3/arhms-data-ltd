import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { processCompletedWalletPayment, processCompletedUpgradePayment, processCompletedDealerSubscription } from '@/lib/payments'
import { logCallback } from '@/lib/hubtel-payment-log'
import { Redis } from '@upstash/redis'

const redis = Redis.fromEnv()


/**
 * Hubtel Receive Money Callback Handler
 *
 * Hubtel sends a POST to this URL with the final transaction status.
 * ResponseCode '0000' = success, '2001' = failed.
 *
 * For extra security, whitelist Hubtel's callback IP: 18.202.122.131
 */
export async function POST(request: NextRequest) {
    try {
        const supabase = createServerClient()
        const body = await request.text()

        let event: any
        try {
            event = JSON.parse(body)
        } catch (e) {
            console.error('[HubtelWebhook] Failed to parse JSON body:', body)
            return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
        }

        console.log('[HubtelWebhook] Received callback:', JSON.stringify(event))

        // Record EVERY callback before any early return. Non-'0000' codes are dropped a few
        // lines below, and that used to be the end of the story — a cancelled or rejected
        // payment left no trace anywhere for an admin to find.
        await logCallback({
            clientReference: event.Data?.ClientReference,
            responseCode: event.ResponseCode,
            message: event.Message ?? null,
            amount: event.Data?.AmountCharged != null ? parseFloat(String(event.Data.AmountCharged)) : undefined,
            transactionId: event.Data?.TransactionId ?? undefined,
            payerMsisdn: event.Data?.CustomerMobileNumber ?? undefined,
            raw: event,
        })

        // An approved payment clears this number's prompt window: the ceiling is there
        // to stop unsolicited prompts, and a prompt someone entered their PIN for was
        // plainly solicited. Without this, a wallet buying several bundles in an hour
        // locks itself out mid-purchase.
        if (event.ResponseCode === '0000' && event.Data?.CustomerMobileNumber) {
            const { clearHubtelPromptCount } = await import('@/lib/hubtel-prompt-limit')
            await clearHubtelPromptCount(String(event.Data.CustomerMobileNumber))
        }

        // Only process successful payments — ResponseCode '0000'
        if (event.ResponseCode !== '0000') {
            console.log(`[HubtelWebhook] Ignoring non-successful callback. ResponseCode: ${event.ResponseCode}, Message: ${event.Message}`)
            return NextResponse.json({ received: true })
        }

        const { ClientReference, AmountCharged } = event.Data || {}

        if (!ClientReference) {
            console.error('[HubtelWebhook] Missing ClientReference in callback data')
            return NextResponse.json({ error: 'Missing ClientReference' }, { status: 400 })
        }

        // Hubtel sends amounts in GHS — convert to pesewas for our processors
        const paidAmountKobo = Math.round(parseFloat(String(AmountCharged || 0)) * 100)

        // ── SHOP ORDERS ──────────────────────────────────────────────────────────
        if (ClientReference.startsWith('SHOP-')) {
            const metadataStr = await redis.get<string>(`shop:meta:${ClientReference}`)

            if (!metadataStr) {
                console.error(`[HubtelWebhook] Metadata not found in Redis for Shop Order: ${ClientReference}`)
                // Paid, but the cart expired out of Redis — the customer is out of pocket
                // with no order. Flag it rather than letting it pass as a success.
                await logCallback({
                    clientReference: ClientReference,
                    responseCode: event.ResponseCode,
                    status: 'failed',
                    message: 'Paid but shop order metadata had expired from Redis — order not created.',
                })
                return NextResponse.json({ received: true })
            }

            let metadata
            try {
                metadata = typeof metadataStr === 'string' ? JSON.parse(metadataStr) : metadataStr
            } catch (e) {
                metadata = metadataStr
            }

            const { processShopOrder } = await import('@/lib/shop-order-processor')
            console.log('[HubtelWebhook] Routing shop order payment:', ClientReference)
            await processShopOrder(ClientReference, metadata, paidAmountKobo, metadata?.shop_slug)
            return NextResponse.json({ received: true })
        }

        // ── RESULTS CHECKER VOUCHERS ─────────────────────────────────────────────
        if (ClientReference.startsWith('RC-')) {
            const { finalizeRCGatewayOrder } = await import('@/lib/vouchers/checkout')
            console.log('[HubtelWebhook] Routing RC Voucher order payment:', ClientReference)
            await finalizeRCGatewayOrder({ reference: ClientReference, paidAmountKobo })
            return NextResponse.json({ received: true })
        }

        // ── AFA REGISTRATION (storefront) ────────────────────────────────────
        if (ClientReference.startsWith('AFA-SHOP-')) {
            const { finalizeAfaShopOrder } = await import('@/lib/afa/checkout')
            console.log('[HubtelWebhook] Routing AFA registration payment:', ClientReference)
            await finalizeAfaShopOrder({ reference: ClientReference, paidAmountKobo })
            return NextResponse.json({ received: true })
        }

        // NOTE: USSD result-checker payments are NOT handled here. They run on
        // Hubtel's Programmable Services API, which delivers payment via the
        // Service Fulfilment callback at /api/hubtel/fulfill — not this
        // Receive-Money webhook.

        // For Wallet Top-ups, Agent Upgrades, and Classifieds Boosts — look up via wallet_payments
        const { data: payment } = await supabase
            .from('wallet_payments')
            .select('total_amount, status, metadata')
            .eq('reference', ClientReference)
            .single()

        if (!payment) {
            console.error('[HubtelWebhook] Payment not found in database:', ClientReference)
            await logCallback({
                clientReference: ClientReference,
                responseCode: event.ResponseCode,
                status: 'failed',
                message: 'Paid but no matching wallet_payments row for this reference — nothing was credited.',
            })
            return NextResponse.json({ received: true })
        }

        // Idempotency — ignore if already processed
        if ((payment as any).status === 'completed') {
            console.log('[HubtelWebhook] Payment already processed, ignoring duplicate callback')
            return NextResponse.json({ received: true })
        }

        // Amount verification
        const expectedAmountPesewas = Math.round((payment as any).total_amount * 100)
        if (paidAmountKobo !== expectedAmountPesewas) {
            console.error(
                `[HubtelWebhook] AMOUNT MISMATCH for ${ClientReference}: Expected ${expectedAmountPesewas} pesewas, got ${paidAmountKobo} pesewas`
            )
            await logCallback({
                clientReference: ClientReference,
                responseCode: event.ResponseCode,
                status: 'failed',
                message: `Amount mismatch — expected GHS ${(expectedAmountPesewas / 100).toFixed(2)}, Hubtel charged GHS ${(paidAmountKobo / 100).toFixed(2)}. Not credited.`,
            })
            return NextResponse.json({ received: true })
        }

        // ── DATA BUNDLE (Direct Pay) ─────────────────────────────────────────────
        if (ClientReference.startsWith('DATA-')) {
            const { processDataDirectOrder } = await import('@/lib/data-order-payments')
            console.log('[HubtelWebhook] Routing direct-pay data order:', ClientReference)
            await processDataDirectOrder(ClientReference)
            return NextResponse.json({ received: true })
        }

        // ── UTILITY BILL (Direct Pay) ────────────────────────────────────────────
        if (ClientReference.startsWith('UTIL-')) {
            const { processUtilityDirectOrder } = await import('@/lib/utility-order-payments')
            console.log('[HubtelWebhook] Routing direct-pay utility bill:', ClientReference)
            await processUtilityDirectOrder(ClientReference)
            return NextResponse.json({ received: true })
        }

        // ── AIRTIME (Direct Pay) ─────────────────────────────────────────────────
        // AIRPAY-, not AIR- — the latter is a Hubtel airtime fulfillment leg going
        // OUT, which this webhook must not confuse with money coming IN.
        if (ClientReference.startsWith('AIRPAY-')) {
            const { processAirtimeDirectOrder } = await import('@/lib/airtime-order-payments')
            console.log('[HubtelWebhook] Routing direct-pay airtime order:', ClientReference)
            await processAirtimeDirectOrder(ClientReference)
            return NextResponse.json({ received: true })
        }

        // ── CLASSIFIEDS BOOST ─────────────────────────────────────────────────────
        if (ClientReference.startsWith('BOOST-')) {
            const { processBoostPayment } = await import('@/lib/classifieds-payments')
            console.log('[HubtelWebhook] Routing listing boost payment:', ClientReference)
            const boostResult = await processBoostPayment(ClientReference, {
                reference: ClientReference,
                amount: paidAmountKobo,
            })

            if (!boostResult.success && !boostResult.alreadyProcessed) {
                console.error('[HubtelWebhook] Boost processing failed:', boostResult.error)
                return NextResponse.json({ error: boostResult.error }, { status: 500 })
            }
            return NextResponse.json({ received: true })
        }

        // Route by type using reference prefix or metadata
        const metadata = (payment as any).metadata || {}
        const mappedEventData = {
            reference: ClientReference,
            amount: paidAmountKobo,
            metadata,
        }

        if (ClientReference.startsWith('agent_upgrade_') || metadata.upgrade_type === 'agent') {
            // ── AGENT UPGRADE ─────────────────────────────────────────────────────
            console.log('[HubtelWebhook] Routing agent upgrade payment:', ClientReference)
            await processCompletedUpgradePayment(ClientReference, mappedEventData)
        } else if (ClientReference.startsWith('ussd_activation_') || metadata.upgrade_type === 'ussd_activation') {
            // ── USSD SHORT CODE ACTIVATION ────────────────────────────────────────
            console.log('[HubtelWebhook] Routing USSD activation payment:', ClientReference)
            const { processCompletedUssdActivation } = await import('@/lib/payments')
            await processCompletedUssdActivation(ClientReference, mappedEventData)
        } else if (ClientReference.startsWith('dealer_sub_') || metadata.upgrade_type === 'dealer_subscription') {
            // ── DEALER SUBSCRIPTION ───────────────────────────────────────────────
            console.log('[HubtelWebhook] Routing dealer subscription payment:', ClientReference)
            await processCompletedDealerSubscription(ClientReference, mappedEventData)
        } else {
            // ── WALLET TOP-UP ─────────────────────────────────────────────────────
            console.log('[HubtelWebhook] Routing wallet top-up payment:', ClientReference)
            await processCompletedWalletPayment(ClientReference, mappedEventData)
        }

        return NextResponse.json({ received: true })
    } catch (error) {
        console.error('[HubtelWebhook] Webhook processing error:', error)
        return NextResponse.json({ error: 'Webhook processing failed' }, { status: 500 })
    }
}
