/**
 * Settles Standard Bundle orders against KingFlexy. Shared by the signed webhook
 * (app/api/webhooks/kingflexy) and the sweep (app/api/cron/sync-kingflexy-bundles)
 * so both reach the same verdict from the same evidence.
 *
 * GET /bundles/orders/{reference} is the source of truth; a webhook body is only a
 * hint, used when the status endpoint cannot be reached. Every path is idempotent:
 * finalizeBundleOrder claims the refund on the row, so a webhook delivered twice, or
 * racing the cron, settles once.
 */
import { createServerClient } from '@/lib/supabase'
import { sendPushToAdmins } from '@/lib/web-push'
import { getKfBundleOrderStatus } from '@/lib/kingflexy-bundles-service'
import { finalizeBundleOrder } from '@/lib/bundle-order-completion'
import { sendBundleToKingFlexy, BUNDLES_ADMIN_PATH } from '@/lib/bundle-dispatcher'

export type BundleSettleOutcome =
    | 'completed' | 'refunded' | 'in_flight' | 'resent' | 'not_found_upstream'
    | 'already_final' | 'unknown_order' | 'status_unavailable' | 'late_delivery_after_refund'

const FINAL = new Set(['completed', 'failed', 'refunded'])

/**
 * @param hint the webhook's claim, used only if KingFlexy's status endpoint is down.
 * @param resendIfMissing re-POST (same reference) when KingFlexy has no such order —
 *        the cron sets this; a webhook never does, since a webhook proves they have it.
 */
export async function reconcileBundleOrder(
    order: any,
    opts: { hint?: 'completed' | 'failed'; hintReason?: string; resendIfMissing?: boolean } = {}
): Promise<BundleSettleOutcome> {
    if (FINAL.has(order.status)) return 'already_final'

    const upstream = await getKfBundleOrderStatus(order.reference_code)

    if (upstream.found) {
        if (upstream.status === 'completed') {
            await finalizeBundleOrder({
                orderId: order.id,
                status: 'completed',
                kfCommission: upstream.commission,
                providerReference: upstream.orderReference ?? null,
                providerResponse: upstream.raw ?? null,
                existingOrder: order,
            })
            return 'completed'
        }
        if (upstream.status === 'failed' || upstream.status === 'refunded') {
            await finalizeBundleOrder({
                orderId: order.id,
                status: 'failed',
                refund: true,
                note: `KingFlexy: ${upstream.reason || `order ${upstream.status}`}.`,
                providerReference: upstream.orderReference ?? null,
                providerResponse: upstream.raw ?? null,
                existingOrder: order,
            })
            return 'refunded'
        }
        if (upstream.orderReference && !order.provider_reference) {
            const supabase = createServerClient() as any
            await supabase.from('bundle_orders').update({ provider_reference: upstream.orderReference }).eq('id', order.id)
        }
        return 'in_flight'
    }

    if (upstream.notFound) {
        if (opts.resendIfMissing && order.status === 'processing') {
            await sendBundleToKingFlexy(order)
            return 'resent'
        }
        return 'not_found_upstream'
    }

    // Status endpoint unavailable. A signed webhook is enough to act on, exactly as
    // the utilities branch does.
    if (opts.hint === 'completed') {
        await finalizeBundleOrder({ orderId: order.id, status: 'completed', existingOrder: order })
        return 'completed'
    }
    if (opts.hint === 'failed') {
        await finalizeBundleOrder({
            orderId: order.id,
            status: 'failed',
            refund: true,
            note: `KingFlexy: ${opts.hintReason || 'order failed'}.`,
            existingOrder: order,
        })
        return 'refunded'
    }
    return 'status_unavailable'
}

/** Handles one verified `product: "bundles"` webhook event. */
export async function settleBundleWebhook(event: any): Promise<BundleSettleOutcome> {
    const supabase = createServerClient() as any
    const reference = String(event?.reference || '')

    let { data: order } = await supabase.from('bundle_orders').select('*').eq('reference_code', reference).maybeSingle()
    if (!order) {
        const byTheirs = await supabase.from('bundle_orders').select('*').eq('provider_reference', reference).maybeSingle()
        order = byTheirs.data
    }
    if (!order) return 'unknown_order'

    const isCompleted = event?.event === 'order.completed'

    // Refunded earlier, delivered anyway. KingFlexy keeps their refund to us and pays
    // no commission, and we keep ours to the customer — the customer got a free
    // bundle. Nothing to undo; an admin should just know.
    if (isCompleted && event?.detail?.previously_refunded === true) {
        if (order.status === 'refunded') {
            await supabase
                .from('bundle_orders')
                .update({ fulfillment_note: `${order.fulfillment_note || ''} Delivered by KingFlexy after the refund.`.trim().slice(0, 1000) })
                .eq('id', order.id)
            await sendPushToAdmins({
                title: 'Bundle delivered after refund',
                body: `${order.reference_code}: ${order.network} ${order.bundle_label} to ${order.beneficiary_phone} was refunded, then delivered anyway. GHS ${Number(order.total_paid).toFixed(2)} lost; no action is automatic.`,
                url: BUNDLES_ADMIN_PATH,
            }).catch(() => {})
            return 'late_delivery_after_refund'
        }
    }

    return reconcileBundleOrder(order, {
        hint: isCompleted ? 'completed' : event?.event === 'order.failed' ? 'failed' : undefined,
        hintReason: typeof event?.detail?.reason === 'string' ? event.detail.reason : undefined,
    })
}
