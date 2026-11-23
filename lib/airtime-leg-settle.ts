/**
 * Applies a supplier's final answer (completed / failed) to one airtime leg and its
 * order. Shared by the airtime sync cron and the BundlePortal webhook so both settle
 * an order the same way.
 *
 *   • completed → leg 'success', order finalized 'completed'.
 *   • failed    → leg 'failed', order back to 'pending' with a note for an admin.
 *     Airtime has no automated refund path (it may still have landed before the
 *     failure was reported), so a human decides — same as before.
 *   • order already resolved elsewhere → only the leg is closed, so it stops
 *     holding a slot in the cron's oldest-first batch.
 */
import { sendPushToAdmins } from '@/lib/web-push'
import { finalizeAirtimeOrder } from '@/lib/airtime-order-completion'

export type AirtimeLegOutcome = 'completed' | 'failed' | 'closed'

export async function settleAirtimeLeg(supabase: any, params: {
    legId: string
    legCreatedAt?: string | null
    order: { id: string; status: string; network?: string; airtime_amount?: any; beneficiary_phone?: string }
    status: 'completed' | 'failed'
    raw?: any
    supplierLabel: string
    /** Push admins about a failure only while the order is fresh — see the cron. */
    alertCutoffMinutes?: number
}): Promise<AirtimeLegOutcome> {
    const now = new Date().toISOString()
    const legStatus = params.status === 'completed' ? 'success' : 'failed'

    await supabase
        .from('airtime_fulfillment_legs')
        .update({ status: legStatus, raw: (params.raw ?? null) as any, updated_at: now })
        .eq('id', params.legId)

    const order = params.order
    if (order.status !== 'processing' && order.status !== 'pending') return 'closed'

    if (params.status === 'completed') {
        await finalizeAirtimeOrder({ orderId: order.id, status: 'completed' })
        return 'completed'
    }

    const note = `${params.supplierLabel} reported this top-up as failed. Confirm on their dashboard before refunding.`
    await supabase
        .from('airtime_orders')
        .update({ status: 'pending', fulfillment_note: note, updated_at: now })
        .eq('id', order.id)

    const ageMin = params.legCreatedAt ? (Date.now() - new Date(params.legCreatedAt).getTime()) / 60000 : 0
    if (ageMin < (params.alertCutoffMinutes ?? 60)) {
        await sendPushToAdmins({
            title: '⚠️ Airtime top-up failed',
            body: `${order.network} GHS ${Number(order.airtime_amount).toFixed(2)} → ${order.beneficiary_phone}. ${note}`,
            url: '/admin/airtime',
        }).catch(() => {})
    }
    return 'failed'
}
