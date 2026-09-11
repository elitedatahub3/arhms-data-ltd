/**
 * PaySwitch (TheTeller) payment callback.
 *
 * SECURITY MODEL — READ BEFORE EDITING
 * ------------------------------------
 * TheTeller sends NO signature on its callback. There is no equivalent of the
 * HMAC-SHA512 `x-paystack-signature` that app/api/webhooks/paystack/route.ts
 * verifies, so anyone who learns a transaction_id could POST "approved" here and
 * be credited.
 *
 * Therefore the callback body is treated ONLY as a wake-up notification. Nothing
 * in it is trusted: not the status, not the amount. On receipt we resolve the
 * internal reference and then re-query PaySwitch server-to-server, and credit
 * strictly on the answer to THAT call. Never short-circuit this by reading the
 * outcome or the amount off the posted body.
 *
 * Everything after the re-query mirrors app/api/webhooks/moolre/route.ts: the same
 * prefix routing, the same idempotency check, the same pesewa amount verification.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { processCompletedWalletPayment, processCompletedUpgradePayment, processCompletedDealerSubscription } from '@/lib/payments'
import { checkPaymentStatus } from '@/lib/payswitch-payment-service'
import { resolvePayswitchReference } from '@/lib/payswitch-reference'
import { Redis } from '@upstash/redis'

const redis = Redis.fromEnv()

/** Always 200: a non-2xx makes PaySwitch retry, and none of these are retryable. */
function ack() {
    return NextResponse.json({ received: true })
}

export async function POST(request: NextRequest) {
    try {
        const supabase = createServerClient()
        const body = await request.text()

        let event: any
        try {
            event = JSON.parse(body)
        } catch {
            console.error('[PayswitchWebhook] Failed to parse JSON body:', body.substring(0, 500))
            return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
        }

        console.log('[PayswitchWebhook] Received event:', JSON.stringify(event))

        const transactionId = String(
            event?.transaction_id ?? event?.transactionId ?? event?.data?.transaction_id ?? ''
        ).trim()

        if (!/^\d{12}$/.test(transactionId)) {
            console.error('[PayswitchWebhook] Missing or malformed transaction_id')
            return ack()
        }

        const reference = await resolvePayswitchReference(supabase, transactionId)
        if (!reference) {
            // Not ours, or the mapping expired. Nothing to do — and nothing to retry.
            console.error('[PayswitchWebhook] No reference found for transaction:', transactionId)
            return ack()
        }

        // ── The trust boundary ────────────────────────────────────────────────
        // Everything below acts on `status`, which came from PaySwitch's own API,
        // never from the request body.
        const status = await checkPaymentStatus(transactionId)

        if (!status.success) {
            // We could not confirm. Leave the payment pending: the client poll and
            // /api/cron/verify-payswitch-payments will retry.
            console.error('[PayswitchWebhook] Status re-query failed for', transactionId, ':', status.error)
            return ack()
        }

        if (status.outcome !== 'paid') {
            console.log(`[PayswitchWebhook] Ignoring ${reference} — confirmed outcome is "${status.outcome}"`)
            return ack()
        }

        // PaySwitch reports GHS; every internal processor expects pesewas.
        const paidAmountPesewas =
            status.amount !== undefined ? Math.round(status.amount * 100) : null

        // ── SHOP ORDERS ───────────────────────────────────────────────────────
        // Storefront metadata lives in Redis, not wallet_payments.
        if (reference.startsWith('SHOP-')) {
            const metadataStr = await redis.get<string>(`shop:meta:${reference}`)
            if (!metadataStr) {
                console.error('[PayswitchWebhook] Metadata not found in Redis for shop order:', reference)
                return ack()
            }

            let metadata: any
            try {
                metadata = typeof metadataStr === 'string' ? JSON.parse(metadataStr) : metadataStr
            } catch {
                metadata = metadataStr
            }

            // PaySwitch normally reports the amount; if it does not, reconstruct it
            // from the metadata exactly as /api/cron/verify-moolre-payments does.
            // Falling back to 0 here would hand processShopOrder an underpayment.
            const fallbackPesewas = Math.round(
                (parseFloat(metadata?.selling_price || '0') +
                 parseFloat(metadata?.paystack_fee || '0') +
                 parseFloat(metadata?.fee_amount || '0')) * 100
            )

            const { processShopOrder } = await import('@/lib/shop-order-processor')
            console.log('[PayswitchWebhook] Routing shop order payment:', reference)
            await processShopOrder(reference, metadata, paidAmountPesewas ?? fallbackPesewas, metadata?.shop_slug)
            return ack()
        }

        // ── RC VOUCHERS ───────────────────────────────────────────────────────
        if (reference.startsWith('RC-')) {
            // finalizeRCGatewayOrder THROWS on an amount mismatch, and a throw here
            // becomes a 500 that PaySwitch retries forever. So when PaySwitch does
            // not report an amount, fall back to the order's own total rather than
            // passing 0 — the outcome was already confirmed by the status API.
            let paidKobo = paidAmountPesewas
            if (paidKobo === null) {
                const { data: rcOrder } = await (supabase.from('results_checker_orders') as any)
                    .select('total_paid')
                    .eq('reference_code', reference)
                    .maybeSingle()
                if (!rcOrder) {
                    console.error('[PayswitchWebhook] RC order not found:', reference)
                    return ack()
                }
                paidKobo = Math.round(Number((rcOrder as any).total_paid) * 100)
            }

            const { finalizeRCGatewayOrder } = await import('@/lib/vouchers/checkout')
            console.log('[PayswitchWebhook] Routing RC voucher order payment:', reference)
            await finalizeRCGatewayOrder({ reference, paidAmountKobo: paidKobo })
            return ack()
        }

        // ── AFA REGISTRATION (storefront) ─────────────────────────────────
        if (reference.startsWith('AFA-SHOP-')) {
            // Same reasoning as the RC branch above: finalizeAfaShopOrder throws on
            // an amount mismatch, and a throw becomes a 500 PaySwitch retries
            // forever. When PaySwitch reports no amount, settle against the order's
            // own total rather than passing 0.
            let paidKobo = paidAmountPesewas
            if (paidKobo === null) {
                const { data: afaOrder } = await (supabase.from('afa_orders') as any)
                    .select('payment_amount')
                    .eq('reference_code', reference)
                    .maybeSingle()
                if (!afaOrder) {
                    console.error('[PayswitchWebhook] AFA order not found:', reference)
                    return ack()
                }
                paidKobo = Math.round(Number((afaOrder as any).payment_amount) * 100)
            }

            const { finalizeAfaShopOrder } = await import('@/lib/afa/checkout')
            console.log('[PayswitchWebhook] Routing AFA registration payment:', reference)
            await finalizeAfaShopOrder({ reference, paidAmountKobo: paidKobo })
            return ack()
        }

        // ── wallet_payments-backed flows ──────────────────────────────────────
        const { data: payment } = await supabase
            .from('wallet_payments')
            .select('total_amount, status, metadata')
            .eq('reference', reference)
            .single()

        if (!payment) {
            console.error('[PayswitchWebhook] Payment not found in database:', reference)
            return ack()
        }

        // Idempotency: PaySwitch may retry, and the client poll races us.
        if ((payment as any).status === 'completed') {
            console.log('[PayswitchWebhook] Payment already processed, ignoring duplicate:', reference)
            return ack()
        }

        const expectedAmountPesewas = Math.round((payment as any).total_amount * 100)

        // If PaySwitch did not report an amount we fall back to the expected one —
        // the outcome was already confirmed by the API, so this is not a trust hole.
        // A reported amount that disagrees IS one, and stops here.
        const amountPesewas = paidAmountPesewas ?? expectedAmountPesewas
        if (amountPesewas !== expectedAmountPesewas) {
            console.error(
                `[PayswitchWebhook] AMOUNT MISMATCH for ${reference}: expected ${expectedAmountPesewas}, PaySwitch reported ${amountPesewas}`
            )
            return ack()
        }

        const metadata = (payment as any).metadata || {}
        const eventData = { reference, amount: amountPesewas, metadata }

        if (reference.startsWith('DATA-')) {
            const { processDataDirectOrder } = await import('@/lib/data-order-payments')
            console.log('[PayswitchWebhook] Routing direct-pay data order:', reference)
            await processDataDirectOrder(reference)
            return ack()
        }

        if (reference.startsWith('UTIL-')) {
            const { processUtilityDirectOrder } = await import('@/lib/utility-order-payments')
            console.log('[PayswitchWebhook] Routing direct-pay utility bill:', reference)
            await processUtilityDirectOrder(reference)
            return ack()
        }

        if (reference.startsWith('AIRPAY-')) {
            const { processAirtimeDirectOrder } = await import('@/lib/airtime-order-payments')
            console.log('[PayswitchWebhook] Routing direct-pay airtime order:', reference)
            await processAirtimeDirectOrder(reference)
            return ack()
        }

        if (reference.startsWith('BOOST-')) {
            const { processBoostPayment } = await import('@/lib/classifieds-payments')
            console.log('[PayswitchWebhook] Routing listing boost payment:', reference)
            const boostResult = await processBoostPayment(reference, { reference, amount: amountPesewas })

            if (!boostResult.success && !boostResult.alreadyProcessed) {
                console.error('[PayswitchWebhook] Boost processing failed:', boostResult.error)
                return NextResponse.json({ error: boostResult.error }, { status: 500 })
            }
            return ack()
        }

        if (reference.startsWith('agent_upgrade_') || metadata.upgrade_type === 'agent') {
            await processCompletedUpgradePayment(reference, eventData)
        } else if (reference.startsWith('ussd_activation_') || metadata.upgrade_type === 'ussd_activation') {
            const { processCompletedUssdActivation } = await import('@/lib/payments')
            await processCompletedUssdActivation(reference, eventData)
        } else if (reference.startsWith('dealer_sub_') || metadata.upgrade_type === 'dealer_subscription') {
            await processCompletedDealerSubscription(reference, eventData)
        } else {
            await processCompletedWalletPayment(reference, eventData)
        }

        return ack()
    } catch (error) {
        console.error('[PayswitchWebhook] Webhook error:', error)
        return NextResponse.json({ error: 'Webhook processing failed' }, { status: 500 })
    }
}
