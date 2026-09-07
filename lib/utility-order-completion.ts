/**
 * The single place a utility bill order changes state.
 *
 * Three callers move an order out of 'pending': the dispatcher (when Hubtel settles
 * synchronously or rejects outright), the Commission Services callback, and an admin
 * pressing a button in /admin/utilities. They must all do the same things — update
 * the row, refund when the bill was never paid, and tell the customer — so there is
 * one implementation, exactly as lib/airtime-order-completion.ts does for airtime.
 *
 * The refund is the part airtime does not have. Airtime that fails mid-flight may
 * still have landed on the handset, so it halts for a human. A utility payment
 * Hubtel refuses is unambiguous: no value left the prepaid account, the customer's
 * money is sitting with us, and it goes straight back. Anything genuinely uncertain
 * is left 'failed' WITHOUT a refund for an admin to settle by hand — see refund
 * below.
 */
import { createServerClient } from '@/lib/supabase'
import { sendPushToUser } from '@/lib/web-push'
import { UTILITY_SERVICES, isUtilityService } from '@/lib/hubtel-utility-service'
import { creditCommissionForOrder } from '@/lib/commission-earning'
import { creditResellersForOrder } from '@/lib/utility-shop-earning'
import { queueApiWebhook } from '@/lib/api-webhook'

export type UtilityFinalStatus = 'processing' | 'completed' | 'failed' | 'refunded'

export interface FinalizeUtilityOrderParams {
    orderId: string
    status: UtilityFinalStatus
    /** Reason / provider detail. Required by callers when the status is not 'completed'. */
    note?: string | null
    /** The admin who acted, when a human did. Absent for provider-driven completions. */
    actorId?: string | null
    /**
     * Put the money back. Only true when we KNOW the bill was not paid — a
     * synchronous rejection or a '2001'-style failure callback. A timeout or an
     * unknown state must leave this false: refunding a bill that actually settled
     * gives the money away twice.
     */
    refund?: boolean
    /** Pass the already-loaded row to save a round trip. */
    existingOrder?: any
}

export interface FinalizeUtilityOrderResult {
    success: boolean
    error?: string
    order?: any
}

function serviceLabel(service: string): string {
    return isUtilityService(service) ? UTILITY_SERVICES[service].label : service
}

export async function finalizeUtilityOrder(
    params: FinalizeUtilityOrderParams
): Promise<FinalizeUtilityOrderResult> {
    const { orderId, status, note, actorId, refund } = params
    const supabase = createServerClient() as any

    let existing = params.existingOrder
    if (!existing) {
        const { data, error } = await supabase
            .from('utility_orders')
            .select('*')
            .eq('id', orderId)
            .single()
        if (error || !data) return { success: false, error: 'Order not found' }
        existing = data
    }

    // ── Refund ───────────────────────────────────────────────────────────────
    // The ROW is the mutex, not a check on the copy we hold.
    //
    // `existing` can be a caller-supplied snapshot taken before this ran, so reading
    // payment_status off it and then crediting would let two concurrent failure
    // callbacks — or a callback racing the cron — both see 'paid' and both pay the
    // customer back. Flipping the column with a conditional UPDATE first means
    // exactly one caller gets a row, and only that caller credits the wallet.
    //
    // Claiming before crediting does mean a failed credit leaves the row marked
    // refunded when no money moved, so that case is unwound below.
    let refunded = false
    const refundAmount = Number(existing.total_paid ?? 0)

    if (refund && existing.payment_status !== 'refunded' && refundAmount > 0) {
        const { data: refundClaim } = await supabase
            .from('utility_orders')
            .update({ payment_status: 'refunded', updated_at: new Date().toISOString() })
            .eq('id', orderId)
            .eq('payment_status', 'paid')
            .select('id')
            .maybeSingle()

        if (refundClaim) {
            const amount = refundAmount
            const { error: refundError } = await supabase.rpc('credit_wallet_balance', {
                p_user_id: existing.user_id,
                p_amount: amount,
            })

            if (refundError) {
                // No money moved, so the claim must be given back or the order will
                // read as settled while the customer is still out of pocket.
                console.error('[UtilityCompletion] CRITICAL: refund failed for', existing.reference_code, refundError)
                await supabase
                    .from('utility_orders')
                    .update({ payment_status: 'paid' })
                    .eq('id', orderId)
                    .catch(() => {})
            } else {
                refunded = true

                // wallet_transactions.wallet_id is NOT NULL and `source` is behind a
                // CHECK that only allows payment/refund/admin/purchase/referral — see
                // supabase/migrations/20260813_referral_bonuses.sql. An audit row is
                // worth having, but it must never take down a refund that succeeded,
                // hence the lookup and the swallowed error.
                try {
                    const { data: wallet } = await supabase
                        .from('wallets')
                        .select('id')
                        .eq('user_id', existing.user_id)
                        .single()

                    if (wallet?.id) {
                        await supabase.from('wallet_transactions').insert({
                            wallet_id: wallet.id,
                            user_id: existing.user_id,
                            type: 'credit',
                            amount,
                            description: `Refund: ${serviceLabel(existing.service)} bill payment ${existing.reference_code} could not be completed`,
                            reference: `REFUND-${existing.reference_code}`,
                            source: 'refund',
                            status: 'completed',
                        })
                    }
                } catch (e) {
                    console.error('[UtilityCompletion] Refund audit row failed (non-fatal):', e)
                }
            }
        }
    }

    const finalStatus: UtilityFinalStatus = refunded ? 'refunded' : status

    const updatePayload: any = {
        status: finalStatus,
        updated_at: new Date().toISOString(),
    }
    if (finalStatus !== 'processing') updatePayload.fulfilled_at = new Date().toISOString()
    if (refunded) updatePayload.payment_status = 'refunded'
    // Only stamped when a human acted. Writing the admin's ID for a callback-driven
    // completion would credit them with work the provider did.
    if (actorId) updatePayload.fulfilled_by = actorId
    if (note) {
        updatePayload.fulfillment_note = refunded
            ? `${note} GHS ${Number(existing.total_paid).toFixed(2)} refunded to wallet.`
            : note
    }

    const { error: updateError } = await supabase
        .from('utility_orders')
        .update(updatePayload)
        .eq('id', orderId)

    if (updateError) {
        console.error('[UtilityCompletion] Update error:', updateError)
        return { success: false, error: updateError.message }
    }

    // ── Commission ───────────────────────────────────────────────────────────
    // Placed here rather than in the API route because all three callers of this
    // function — dispatcher, Hubtel callback, admin button — must earn identically.
    // A no-op unless the order was placed with a Commission Services key. Guarded on
    // finalStatus, not `status`: an order that was refunded out from under a
    // 'completed' call paid no bill and earns nothing.
    if (finalStatus === 'completed') {
        await creditCommissionForOrder({ orderId })
        // Storefront sales only — pays the selling shop and its upline the margin
        // they were snapshotted for at checkout. A no-op on a dashboard order.
        await creditResellersForOrder({ orderId })
    }

    // Tell the partner, if this order came from an API key with a webhook configured.
    // Terminal states only — 'processing' is not news.
    if (finalStatus !== 'processing' && existing.api_key_id) {
        await queueApiWebhook({
            apiKeyId: existing.api_key_id,
            payload: {
                event:          `utility.${finalStatus}`,
                reference:      existing.reference_code,
                order_id:       existing.id,
                status:         finalStatus,
                service:        existing.service,
                account_number: existing.account_number,
                account_name:   existing.account_name,
                bill_amount:    Number(existing.bill_amount ?? 0),
                total_paid:     Number(existing.total_paid ?? 0),
                refunded,
                note:           note ?? null,
            },
        })
    }

    // 'processing' is an interim state — the payment is in flight at the provider and
    // the customer has already been told it is pending. Announcing it again is noise.
    if (finalStatus === 'processing') {
        return { success: true, order: existing }
    }

    // ── Notify ───────────────────────────────────────────────────────────────
    const label = serviceLabel(existing.service)
    const amount = Number(existing.bill_amount ?? 0)
    const who = existing.account_name ? ` for ${existing.account_name}` : ''
    const account = existing.account_number

    const title = finalStatus === 'completed'
        ? `${label} Bill Paid ✅`
        : refunded
            ? `${label} Payment Refunded`
            : `${label} Payment Failed`

    const message = finalStatus === 'completed'
        ? `GHS ${amount.toFixed(2)} paid to ${label} account ${account}${who}. Ref: ${existing.reference_code}`
        : refunded
            ? `Your ${label} payment for ${account} could not be completed, so GHS ${Number(existing.total_paid).toFixed(2)} has been returned to your wallet. Ref: ${existing.reference_code}`
            : `Your ${label} payment for ${account} could not be completed. Our team is looking into it. Ref: ${existing.reference_code}`

    supabase.from('notifications').insert({
        user_id: existing.user_id,
        title,
        message,
        type: 'order_update',
        action_url: '/dashboard/utilities',
    }).then(() => {}).catch((e: any) => console.error('[UtilityCompletion] Notification error:', e))

    await sendPushToUser(existing.user_id, {
        title: title.replace(' ✅', ''),
        body: message,
        url: '/dashboard/utilities',
        // Later updates to this same order replace the earlier alert rather than
        // leaving a trail of stale ones in the notification shade.
        tag: `utility-${existing.reference_code}`,
    }).catch(() => {})

    return { success: true, order: existing }
}
