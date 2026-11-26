/**
 * Sends a paid Standard Bundle order to KingFlexy.
 *
 * No legs table, unlike airtime: our reference_code is KingFlexy's idempotency key,
 * so re-sending an order (after a crash, a timeout, or a 404 from their status
 * endpoint) returns the original order instead of buying the bundle twice. The only
 * latch needed is the pending → processing claim, which stops two dispatchers racing
 * on the same row.
 *
 * Never throws — it runs inside waitUntil() and from crons.
 */
import { createServerClient } from '@/lib/supabase'
import { sendPushToAdmins } from '@/lib/web-push'
import { isBundleNetwork, mapKfBundleStatus } from '@/lib/kingflexy-bundles-service'
import { purchaseBundleForOrder, orderProvider, BUNDLE_PROVIDER_LABEL } from '@/lib/bundle-provider'
import { finalizeBundleOrder } from '@/lib/bundle-order-completion'
import { BUNDLE_SETTING_KEYS } from '@/lib/bundle-pricing'

export const BUNDLES_ADMIN_PATH = '/admin/standard-bundles'

export interface BundleDispatchResult {
    dispatched: boolean
    reason?: string
}

/**
 * @param force skip the bundles_auto_dispatch switch — for the admin "Send now"
 *              button, which is how orders held by that switch get released.
 */
export async function triggerBundleDispatch(orderId: string, opts: { force?: boolean } = {}): Promise<BundleDispatchResult> {
    try {
        const supabase = createServerClient() as any

        const { data: order } = await supabase.from('bundle_orders').select('*').eq('id', orderId).single()
        if (!order) return { dispatched: false, reason: 'order not found' }
        if (order.status !== 'pending') return { dispatched: false, reason: `status is ${order.status}` }
        if (order.payment_status !== 'paid') return { dispatched: false, reason: `payment is ${order.payment_status}` }

        if (!opts.force) {
            const { data: setting } = await supabase
                .from('admin_settings')
                .select('value')
                .eq('key', BUNDLE_SETTING_KEYS.autoDispatch)
                .maybeSingle()
            if (setting?.value === 'false') return { dispatched: false, reason: 'auto-dispatch is off' }
        }

        // The claim. Zero rows back means another dispatcher already has it.
        const { data: claimed } = await supabase
            .from('bundle_orders')
            .update({ status: 'processing', dispatched_at: new Date().toISOString(), updated_at: new Date().toISOString() })
            .eq('id', orderId)
            .eq('status', 'pending')
            .select('*')
            .maybeSingle()
        if (!claimed) return { dispatched: false, reason: 'already claimed' }

        await sendBundleToProvider(claimed)
        return { dispatched: true }
    } catch (e: any) {
        console.error('[BundleDispatch] Unexpected error for', orderId, e)
        return { dispatched: false, reason: String(e?.message || e) }
    }
}

/**
 * POSTs an already-claimed ('processing') order to the provider stored on it
 * (bundle_orders.provider). Also used by the cron to re-send an order the provider
 * says it never received — same reference, so it is safe.
 */
export async function sendBundleToProvider(order: any): Promise<void> {
    const supabase = createServerClient() as any
    const name = BUNDLE_PROVIDER_LABEL[orderProvider(order)]

    if (!isBundleNetwork(order.network)) {
        await finalizeBundleOrder({ orderId: order.id, status: 'failed', refund: true, note: `Unknown network ${order.network}.`, existingOrder: order })
        return
    }

    const result = await purchaseBundleForOrder(order)

    switch (result.outcome) {
        case 'accepted': {
            const upstream = mapKfBundleStatus(result.status)
            if (upstream === 'completed') {
                await finalizeBundleOrder({
                    orderId: order.id,
                    status: 'completed',
                    providerReference: result.orderReference ?? null,
                    providerResponse: result.raw ?? null,
                    existingOrder: order,
                })
            } else if (upstream === 'refunded' || upstream === 'failed') {
                // A replayed order that had already ended badly upstream.
                await finalizeBundleOrder({
                    orderId: order.id,
                    status: 'failed',
                    refund: true,
                    note: `${name} could not deliver the bundle.`,
                    providerReference: result.orderReference ?? null,
                    providerResponse: result.raw ?? null,
                    existingOrder: order,
                })
            } else {
                await supabase
                    .from('bundle_orders')
                    .update({
                        provider_reference: result.orderReference ?? null,
                        provider_response: result.raw ?? null,
                        fulfillment_note: null,
                        updated_at: new Date().toISOString(),
                    })
                    .eq('id', order.id)
            }
            return
        }

        case 'definite_refusal':
        case 'kf_wallet_empty': {
            await finalizeBundleOrder({
                orderId: order.id,
                status: 'failed',
                refund: true,
                note: `${name} refused the order (HTTP ${result.httpStatus}): ${result.error ?? 'no reason given'}.`,
                providerResponse: result.raw ?? null,
                existingOrder: order,
            })
            if (result.outcome === 'kf_wallet_empty') {
                await sendPushToAdmins({
                    title: `Top up the ${name} wallet`,
                    body: `Standard Bundle ${order.reference_code} was refused for low ${name} balance and refunded. Bundles will keep failing until it is topped up.`,
                    url: BUNDLES_ADMIN_PATH,
                }).catch(() => {})
            } else if (result.keyProblem) {
                await sendPushToAdmins({
                    title: `${name} refused our account`,
                    body: `Standard Bundle ${order.reference_code} was refused and refunded: ${(result.error || `HTTP ${result.httpStatus}`).slice(0, 160)}. Fix it with ${name} or switch the network back.`,
                    url: BUNDLES_ADMIN_PATH,
                }).catch(() => {})
            }
            return
        }

        case 'retry_same_ref':
        case 'unknown':
        default: {
            // May or may not exist upstream. Stay 'processing'; the cron asks the
            // provider and re-sends with the same reference if they never got it.
            await supabase
                .from('bundle_orders')
                .update({
                    fulfillment_note: `Awaiting ${name} (${result.outcome}${result.httpStatus ? `, HTTP ${result.httpStatus}` : ''}): ${result.error ?? ''}`.slice(0, 500),
                    provider_response: result.raw ?? null,
                    updated_at: new Date().toISOString(),
                })
                .eq('id', order.id)
            return
        }
    }
}
