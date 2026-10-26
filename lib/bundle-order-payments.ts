/**
 * Settles a Direct Pay Standard Bundle order once the gateway confirms payment.
 *
 * The order does not exist until this runs — /api/bundles/gateway-init only recorded
 * a pending `wallet_payments` intent (reference `BUNPAY-…`) whose metadata carries the
 * priced bundle_orders columns. Here we claim that intent atomically, create the real
 * `bundle_orders` row as already paid, and hand it to the same dispatcher the wallet
 * path uses.
 *
 * Modelled on lib/airtime-order-payments.ts: the wallet is NOT touched on the happy
 * path, because the money went straight to the gateway. It is only touched when
 * something goes wrong after the customer has already paid, and then only to give the
 * money back.
 *
 * Idempotent — safe to call from a webhook, the verify poller, and the reconciliation
 * crons for the same reference.
 */
import { createServerClient } from '@/lib/supabase'
import { sendPushToUser, sendPushToAdmins } from '@/lib/web-push'
import { isBundleNetwork } from '@/lib/kingflexy-bundles-service'
import { triggerBundleDispatch, BUNDLES_ADMIN_PATH } from '@/lib/bundle-dispatcher'
import { BUNDLES_USER_PATH } from '@/lib/bundle-order-completion'

/** Money coming IN for a bundle. Distinct from BNDL-, the wallet order reference. */
export const BUNDLE_PAYMENT_PREFIX = 'BUNPAY-'

export function isBundlePaymentReference(reference: string | null | undefined): boolean {
    return typeof reference === 'string' && reference.startsWith(BUNDLE_PAYMENT_PREFIX)
}

export interface BundleSettleResult {
    success: boolean
    alreadyProcessed?: boolean
    error?: string
    order?: {
        id: string
        reference_code: string
        network: string
        bundle_label: string
        beneficiary_phone: string
        total_paid: number
        status: string
        created_at: string
    }
}

const ORDER_SELECT = 'id, reference_code, network, bundle_label, beneficiary_phone, total_paid, status, created_at'

/** Reads back the order a settled payment produced, for a caller that lost the claim race. */
async function loadSettledOrder(supabase: any, reference: string) {
    const { data } = await supabase
        .from('bundle_orders')
        .select(ORDER_SELECT)
        .eq('reference_code', reference)
        .maybeSingle()
    return data || undefined
}

export async function processBundleDirectOrder(
    reference: string,
    expectedUserId?: string
): Promise<BundleSettleResult> {
    const supabase = createServerClient() as any

    // 1. Load the payment intent
    const { data: payment, error: paymentError } = await supabase
        .from('wallet_payments')
        .select('*')
        .eq('reference', reference)
        .single()

    if (paymentError || !payment) {
        console.error('[BundleSettle] Payment not found:', reference)
        return { success: false, error: 'Payment not found' }
    }

    if (expectedUserId && payment.user_id !== expectedUserId) {
        console.error('[BundleSettle] Payment ownership mismatch:', reference)
        return { success: false, error: 'Forbidden' }
    }

    const meta = payment.metadata || {}
    const columns = meta.order || {}

    if (
        meta.kind !== 'bundle_order' ||
        !isBundleNetwork(columns.network) ||
        !columns.beneficiary_phone ||
        !columns.bundle_label ||
        !(Number(columns.cost_amount) > 0) ||
        !(Number(columns.total_paid) > 0) ||
        (columns.kf_value == null) === (columns.kf_pack_id == null)
    ) {
        console.error('[BundleSettle] Malformed payment metadata:', reference, meta)
        return { success: false, error: 'Malformed payment metadata' }
    }

    // 2. Atomic claim — only one caller may flip pending → completed. This is what
    //    stops the webhook and the poller both creating the same order.
    const { data: claimed, error: claimError } = await supabase
        .from('wallet_payments')
        .update({ status: 'completed', updated_at: new Date().toISOString() })
        .eq('id', payment.id)
        .eq('status', 'pending')
        .select()
        .maybeSingle()

    if (claimError) {
        console.error('[BundleSettle] Claim error:', claimError)
        return { success: false, error: 'Failed to update payment status' }
    }

    if (!claimed) {
        return { success: true, alreadyProcessed: true, order: await loadSettledOrder(supabase, reference) }
    }

    // 3. Create the order — already paid, awaiting dispatch. The price is the one the
    //    customer was quoted and paid; the gateway fee stays on wallet_payments.
    const { data: order, error: orderError } = await supabase
        .from('bundle_orders')
        .insert({
            user_id: payment.user_id,
            user_role: meta.role || null,
            network: columns.network,
            beneficiary_phone: columns.beneficiary_phone,
            family: columns.family ?? null,
            family_label: columns.family_label ?? null,
            bundle_label: columns.bundle_label,
            validity: columns.validity ?? null,
            kf_value: columns.kf_value ?? null,
            kf_pack_id: columns.kf_pack_id ?? null,
            cost_amount: Number(columns.cost_amount),
            markup_amount: Number(columns.markup_amount ?? 0),
            total_paid: Number(columns.total_paid),
            price_tier: columns.price_tier ?? null,
            reference_code: payment.reference,
            status: 'pending',
            payment_method: 'gateway',
            payment_status: 'paid',
            source: 'dashboard',
        })
        .select()
        .single()

    if (orderError || !order) {
        // Money has already been taken — it must land somewhere. Credit the wallet
        // with everything they paid so the customer is never left short.
        console.error('[BundleSettle] CRITICAL: order insert failed after payment:', reference, orderError)

        const { error: refundError } = await supabase.rpc('credit_wallet_balance', {
            p_user_id: payment.user_id,
            p_amount: Number(payment.total_amount),
        })
        if (refundError) console.error('[BundleSettle] CRITICAL: refund ALSO failed for', reference, refundError)

        await sendPushToAdmins({
            title: '⚠️ Bundle order could not be created',
            body: `${reference}: paid but the order row failed to insert. ${refundError ? 'REFUND ALSO FAILED — fix by hand.' : 'Customer refunded to wallet.'}`,
            url: BUNDLES_ADMIN_PATH,
        }).catch(() => {})

        return { success: false, error: 'Could not create the bundle order' }
    }

    // 4. Tell the buyer and the admins, then dispatch — same as the wallet path.
    const what = `${meta.label || `${order.network} ${order.bundle_label}`}`

    const { error: notifyError } = await supabase.from('notifications').insert({
        user_id: payment.user_id,
        title: 'Bundle Order Placed',
        message: `${what} for ${order.beneficiary_phone} is on its way. Ref: ${order.reference_code}`,
        type: 'order_update',
        action_url: BUNDLES_USER_PATH,
    })
    if (notifyError) console.error('[BundleSettle] Notification error:', notifyError.message)

    await Promise.all([
        sendPushToUser(payment.user_id, {
            title: 'Bundle Order Placed',
            body: `${what} for ${order.beneficiary_phone} is on its way.`,
            url: BUNDLES_USER_PATH,
        }).catch(() => {}),
        sendPushToAdmins({
            title: 'New Standard Bundle order (Direct Pay)',
            body: `${what} → ${order.beneficiary_phone} · GHS ${Number(payment.total_amount).toFixed(2)}`,
            url: BUNDLES_ADMIN_PATH,
        }).catch(() => {}),
    ])

    await triggerBundleDispatch(order.id)

    return { success: true, order: (await loadSettledOrder(supabase, reference)) || order }
}
