/**
 * Settles a Direct Pay utility bill order once the gateway confirms payment.
 *
 * The order does not exist until this runs — /api/utilities/gateway-init only
 * recorded a pending `wallet_payments` intent carrying the bill details in
 * `metadata`. Here we claim that intent atomically, create the real
 * `utility_orders` row as already paid, and dispatch the payment to Hubtel.
 *
 * Modelled on lib/data-order-payments.ts, including the rule that matters most: the
 * wallet is NOT touched on the happy path, because the money went straight to the
 * gateway. It is only touched when something goes wrong after the customer has
 * already paid, and then only to give the money back.
 *
 * Idempotent — safe to call from a webhook, the verify poller and the
 * reconciliation crons for the same reference.
 */
import { createServerClient } from '@/lib/supabase'
import { triggerUtilityFulfillment, buildUtilityClientReference } from '@/lib/utility-fulfillment-dispatcher'
import { finalizeUtilityOrder } from '@/lib/utility-order-completion'
import {
    UTILITY_SERVICES,
    isUtilityService,
} from '@/lib/hubtel-utility-service'
import { queryUtilityAccount } from '@/lib/utility-provider'
import { sendPushToAdmins } from '@/lib/web-push'

export interface UtilitySettleResult {
    success: boolean
    alreadyProcessed?: boolean
    error?: string
    order?: {
        id: string
        reference_code: string
        service: string
        account_number: string
        account_name: string | null
        bill_amount: number
        total_paid: number
        status: string
    }
}

/** Reads back the order a settled payment produced, for callers that lost the race. */
async function loadSettledOrder(supabase: any, reference: string) {
    const { data } = await supabase
        .from('utility_orders')
        .select('id, reference_code, service, account_number, account_name, bill_amount, total_paid, status')
        .eq('reference_code', reference)
        .maybeSingle()
    return data || undefined
}

export async function processUtilityDirectOrder(
    reference: string,
    expectedUserId?: string
): Promise<UtilitySettleResult> {
    const supabase = createServerClient() as any

    // 1. Load the payment intent
    const { data: payment, error: paymentError } = await supabase
        .from('wallet_payments')
        .select('*')
        .eq('reference', reference)
        .single()

    if (paymentError || !payment) {
        console.error('[UtilitySettle] Payment not found:', reference)
        return { success: false, error: 'Payment not found' }
    }

    if (expectedUserId && payment.user_id !== expectedUserId) {
        console.error('[UtilitySettle] Payment ownership mismatch:', reference)
        return { success: false, error: 'Forbidden' }
    }

    const meta = payment.metadata || {}
    const service = meta.service

    if (!isUtilityService(service)) {
        console.error('[UtilitySettle] Malformed payment metadata (service):', reference, service)
        return { success: false, error: 'Malformed payment metadata' }
    }

    const def = UTILITY_SERVICES[service]

    // 2. Atomic claim — only one caller may flip pending → completed. This is what
    //    stops the webhook and the poller both paying the bill.
    const { data: claimed, error: claimError } = await supabase
        .from('wallet_payments')
        .update({ status: 'completed', updated_at: new Date().toISOString() })
        .eq('id', payment.id)
        .eq('status', 'pending')
        .select()
        .maybeSingle()

    if (claimError) {
        console.error('[UtilitySettle] Claim error:', claimError)
        return { success: false, error: 'Failed to update payment status' }
    }

    if (!claimed) {
        return { success: true, alreadyProcessed: true, order: await loadSettledOrder(supabase, reference) }
    }

    // 3. Refresh the provider session.
    //
    //    Ghana Water's sessionId is single-use and was issued when the customer hit
    //    "Pay" — which may have been several minutes and one MoMo PIN entry ago. A
    //    stale one fails the payment after the money is already collected, so it is
    //    re-fetched here rather than carried across the gateway round trip.
    let sessionId: string | null = meta.session_id ?? null
    let accountName: string | null = meta.account_name ?? null

    if (def.kind === 'meter-with-session') {
        const refreshed = await queryUtilityAccount({
            service,
            accountNumber: meta.account_number,
            phone: meta.customer_phone,
        })

        if (!refreshed.success || !refreshed.sessionId) {
            // The customer has paid and we cannot deliver. Create the order so the
            // money is traceable, then fail-and-refund through the one code path
            // that knows how to do that.
            const { data: deadOrder } = await supabase
                .from('utility_orders')
                .insert(buildOrderRow(payment, meta, service, accountName, sessionId, 'pending'))
                .select()
                .single()

            if (deadOrder) {
                await finalizeUtilityOrder({
                    orderId: deadOrder.id,
                    status: 'failed',
                    note: `${def.label} would not issue a payment session at settlement: ${refreshed.error || 'unknown error'}.`,
                    refund: true,
                    existingOrder: deadOrder,
                })
            } else {
                // No order row at all — the only remaining record of the money is the
                // payment intent, so make sure a human sees it.
                await supabase.rpc('credit_wallet_balance', {
                    p_user_id: payment.user_id,
                    p_amount: Number(payment.total_amount),
                }).catch((e: any) => console.error('[UtilitySettle] Emergency refund failed:', e))
            }

            await sendPushToAdmins({
                title: '⚠️ Utility payment could not be delivered',
                body: `${reference}: ${def.label} session refresh failed. Customer refunded.`,
                url: '/admin/utilities',
            }).catch(() => {})

            return { success: false, error: refreshed.error || 'Could not start a payment session' }
        }

        sessionId = refreshed.sessionId
        accountName = refreshed.accountName ?? accountName
    }

    // 4. Create the order — already paid, awaiting delivery
    const { data: order, error: orderError } = await supabase
        .from('utility_orders')
        .insert(buildOrderRow(payment, meta, service, accountName, sessionId, 'pending'))
        .select()
        .single()

    if (orderError || !order) {
        // Money has already been taken — it must land somewhere. Fall back to
        // crediting the wallet so the customer is never left short.
        console.error('[UtilitySettle] CRITICAL: order insert failed after payment:', reference, orderError)

        const { error: refundError } = await supabase.rpc('credit_wallet_balance', {
            p_user_id: payment.user_id,
            p_amount: Number(payment.total_amount),
        })

        if (refundError) {
            console.error('[UtilitySettle] CRITICAL: refund ALSO failed for', reference, refundError)
        }

        await sendPushToAdmins({
            title: '⚠️ Utility order could not be created',
            body: `${reference}: paid but the order row failed to insert. ${refundError ? 'REFUND ALSO FAILED — fix by hand.' : 'Customer refunded to wallet.'}`,
            url: '/admin/utilities',
        }).catch(() => {})

        return { success: false, error: 'Could not create the bill payment order' }
    }

    // 5. Notify + dispatch
    supabase.from('notifications').insert({
        user_id: payment.user_id,
        title: `${def.label} Payment Received`,
        message: `GHS ${Number(order.bill_amount).toFixed(2)} for ${def.label} account ${order.account_number} is being processed. Ref: ${order.reference_code}`,
        type: 'order_update',
        action_url: '/dashboard/utilities',
    }).then(() => {}).catch((e: any) => console.error('[UtilitySettle] Notification error:', e))

    await triggerUtilityFulfillment(order.id)

    const { data: fresh } = await supabase
        .from('utility_orders')
        .select('id, reference_code, service, account_number, account_name, bill_amount, total_paid, status')
        .eq('id', order.id)
        .single()

    return { success: true, order: fresh || order }
}

/** The insert payload, shared by the happy path and the session-refresh failure path. */
function buildOrderRow(
    payment: any,
    meta: any,
    service: string,
    accountName: string | null,
    sessionId: string | null,
    status: string
) {
    return {
        user_id: payment.user_id,
        user_role: meta.role || 'customer',
        service,
        account_number: meta.account_number,
        account_name: accountName,
        destination: meta.destination,
        customer_phone: meta.customer_phone ?? null,
        customer_email: meta.customer_email ?? null,
        session_id: sessionId,
        bill_amount: Number(meta.bill_amount),
        fee_rate: Number(meta.fee_rate ?? 0),
        fee_amount: Number(meta.fee_amount ?? 0),
        total_paid: Number(payment.total_amount),
        payment_method: 'gateway',
        payment_status: 'paid',
        status,
        reference_code: payment.reference,
        client_reference: buildUtilityClientReference(payment.reference),
    }
}
