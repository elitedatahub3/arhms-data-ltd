/**
 * Settles a Direct Pay airtime order once the gateway confirms payment.
 *
 * The order does not exist until this runs — /api/airtime/gateway-init only
 * recorded a pending `wallet_payments` intent carrying the airtime details in
 * `metadata`. Here we claim that intent atomically, create the real
 * `airtime_orders` row as already paid, and hand it to the same fulfillment
 * dispatcher the wallet path uses.
 *
 * Modelled on lib/utility-order-payments.ts, including the rule that matters
 * most: the wallet is NOT touched on the happy path, because the money went
 * straight to the gateway. It is only touched when something goes wrong after
 * the customer has already paid, and then only to give the money back.
 *
 * Idempotent — safe to call from a webhook, the verify poller, and the
 * reconciliation crons for the same reference.
 */
import { createServerClient } from '@/lib/supabase'
import { triggerAirtimeFulfillment } from '@/lib/airtime-fulfillment-dispatcher'
import { sendAirtimeBeneficiarySMS } from '@/lib/sms-service'
import { sendPushToUser, sendPushToAdmins } from '@/lib/web-push'

export interface AirtimeSettleResult {
    success: boolean
    alreadyProcessed?: boolean
    error?: string
    order?: {
        id: string
        reference_code: string
        network: string
        beneficiary_phone: string
        airtime_amount: number
        fee_amount: number
        total_paid: number
        status: string
        created_at: string
        use_exact_amount: boolean
        type: string
        bundle_preference: string | null
    }
}

// Everything the dashboard's AirtimeOrder interface needs, so the order returned
// through /api/payments/verify renders in the success modal without a second fetch.
const ORDER_SELECT = 'id, reference_code, network, beneficiary_phone, airtime_amount, fee_amount, total_paid, status, created_at, use_exact_amount, type, bundle_preference'

/** Reads back the order a settled payment produced, for a caller that lost the claim race. */
async function loadSettledOrder(supabase: any, reference: string) {
    const { data } = await supabase
        .from('airtime_orders')
        .select(ORDER_SELECT)
        .eq('reference_code', reference)
        .maybeSingle()
    return data || undefined
}

export async function processAirtimeDirectOrder(
    reference: string,
    expectedUserId?: string
): Promise<AirtimeSettleResult> {
    const supabase = createServerClient() as any

    // 1. Load the payment intent
    const { data: payment, error: paymentError } = await supabase
        .from('wallet_payments')
        .select('*')
        .eq('reference', reference)
        .single()

    if (paymentError || !payment) {
        console.error('[AirtimeSettle] Payment not found:', reference)
        return { success: false, error: 'Payment not found' }
    }

    if (expectedUserId && payment.user_id !== expectedUserId) {
        console.error('[AirtimeSettle] Payment ownership mismatch:', reference)
        return { success: false, error: 'Forbidden' }
    }

    const meta = payment.metadata || {}
    const network = meta.network

    if (!meta.beneficiary_phone || !['MTN', 'Telecel', 'AT'].includes(network) || !(Number(meta.airtime_amount) > 0)) {
        console.error('[AirtimeSettle] Malformed payment metadata:', reference, meta)
        return { success: false, error: 'Malformed payment metadata' }
    }

    // 2. Atomic claim — only one caller may flip pending → completed. This is what
    //    stops the webhook and the poller both dispatching the same top-up.
    const { data: claimed, error: claimError } = await supabase
        .from('wallet_payments')
        .update({ status: 'completed', updated_at: new Date().toISOString() })
        .eq('id', payment.id)
        .eq('status', 'pending')
        .select()
        .maybeSingle()

    if (claimError) {
        console.error('[AirtimeSettle] Claim error:', claimError)
        return { success: false, error: 'Failed to update payment status' }
    }

    if (!claimed) {
        return { success: true, alreadyProcessed: true, order: await loadSettledOrder(supabase, reference) }
    }

    // 3. Create the order — already paid, awaiting fulfillment
    const resolvedType: 'airtime' | 'mashup' = meta.type === 'mashup' ? 'mashup' : 'airtime'

    const { data: order, error: orderError } = await supabase
        .from('airtime_orders')
        .insert({
            user_id: payment.user_id,
            user_role: meta.role || 'customer',
            beneficiary_phone: meta.beneficiary_phone,
            network,
            airtime_amount: Number(meta.airtime_amount),
            fee_rate: Number(meta.fee_rate ?? 0),
            fee_amount: Number(meta.fee_amount ?? 0),
            total_paid: Number(payment.total_amount),
            use_exact_amount: meta.use_exact_amount === true,
            status: 'pending',
            reference_code: payment.reference,
            type: resolvedType,
            bundle_preference: resolvedType === 'mashup' ? (meta.bundle_preference || 'balanced') : null,
            payment_method: 'gateway',
            payment_status: 'paid',
        })
        .select()
        .single()

    if (orderError || !order) {
        // Money has already been taken — it must land somewhere. Fall back to
        // crediting the wallet so the customer is never left short.
        console.error('[AirtimeSettle] CRITICAL: order insert failed after payment:', reference, orderError)

        const { error: refundError } = await supabase.rpc('credit_wallet_balance', {
            p_user_id: payment.user_id,
            p_amount: Number(payment.total_amount),
        })

        if (refundError) {
            console.error('[AirtimeSettle] CRITICAL: refund ALSO failed for', reference, refundError)
        }

        await sendPushToAdmins({
            title: '⚠️ Airtime order could not be created',
            body: `${reference}: paid but the order row failed to insert. ${refundError ? 'REFUND ALSO FAILED — fix by hand.' : 'Customer refunded to wallet.'}`,
            url: '/admin/airtime',
        }).catch(() => {})

        return { success: false, error: 'Could not create the airtime order' }
    }

    // 4. Notify the buyer, alert the beneficiary, then dispatch fulfillment —
    //    same order the wallet path (app/api/airtime/create) uses.
    supabase.from('notifications').insert({
        user_id: payment.user_id,
        title: resolvedType === 'mashup' ? 'Mashup Order Placed 🎯' : 'Airtime Order Placed',
        message: resolvedType === 'mashup'
            ? `${network} Mashup request of GHS ${Number(order.airtime_amount).toFixed(2)} for ${order.beneficiary_phone} is pending. Ref: ${order.reference_code}`
            : `GHS ${Number(order.airtime_amount).toFixed(2)} airtime for ${order.beneficiary_phone} (${network}) is pending. Ref: ${order.reference_code}`,
        type: 'order_update',
        action_url: '/dashboard/airtime',
    }).then(() => {}).catch((e: any) => console.error('[AirtimeSettle] Notification error:', e))

    await sendPushToUser(payment.user_id, {
        title: resolvedType === 'mashup' ? 'Mashup Order Placed' : 'Airtime Order Placed',
        body: resolvedType === 'mashup'
            ? `${network} Mashup of GHS ${Number(order.airtime_amount).toFixed(2)} for ${order.beneficiary_phone} is pending.`
            : `GHS ${Number(order.airtime_amount).toFixed(2)} airtime for ${order.beneficiary_phone} (${network}) is pending.`,
        url: '/dashboard/airtime',
    }).catch(() => {})

    if (resolvedType !== 'mashup') {
        await sendAirtimeBeneficiarySMS(order.beneficiary_phone, Number(order.airtime_amount))
            .catch((err: any) => console.error('[AirtimeSettle] Beneficiary SMS failed:', err))
    }

    await triggerAirtimeFulfillment(order.id)

    const { data: fresh } = await supabase
        .from('airtime_orders')
        .select(ORDER_SELECT)
        .eq('id', order.id)
        .single()

    return { success: true, order: fresh || order }
}
