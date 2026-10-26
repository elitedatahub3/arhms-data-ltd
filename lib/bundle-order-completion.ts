/**
 * The single place a Standard Bundle order changes state.
 *
 * The dispatcher, the KingFlexy webhook, the reconciliation cron and the admin
 * buttons all settle orders through here, so every path updates the row, refunds,
 * and tells the customer the same way. Modelled on lib/utility-order-completion.ts.
 *
 * Unlike airtime, a bundle KingFlexy reports as failed or refunded is unambiguous:
 * they have already put the money back on our side, so the customer's goes straight
 * back too. An uncertain outcome (timeout, 5xx) never reaches here with refund=true —
 * the cron asks KingFlexy first.
 */
import { createServerClient } from '@/lib/supabase'
import { sendPushToUser } from '@/lib/web-push'

export type BundleFinalStatus = 'processing' | 'completed' | 'failed' | 'refunded'

export interface FinalizeBundleOrderParams {
    orderId: string
    status: BundleFinalStatus
    note?: string | null
    actorId?: string | null
    /** Put the money back. Only when we KNOW the bundle was not delivered. */
    refund?: boolean
    /** KingFlexy's reported commission, stored for admin profit reporting. */
    kfCommission?: number | null
    providerReference?: string | null
    providerResponse?: any
    existingOrder?: any
}

export interface FinalizeBundleOrderResult {
    success: boolean
    error?: string
    refunded?: boolean
    order?: any
}

export const BUNDLES_USER_PATH = '/dashboard/standard-bundles'

export async function finalizeBundleOrder(params: FinalizeBundleOrderParams): Promise<FinalizeBundleOrderResult> {
    const { orderId, status, note, actorId, refund } = params
    const supabase = createServerClient() as any

    let existing = params.existingOrder
    if (!existing) {
        const { data, error } = await supabase.from('bundle_orders').select('*').eq('id', orderId).single()
        if (error || !data) return { success: false, error: 'Order not found' }
        existing = data
    }

    // ── Refund ───────────────────────────────────────────────────────────────
    // The ROW is the mutex: a webhook racing the cron must not both pay the customer
    // back. Claim payment_status first, credit second, and give the claim back if the
    // credit fails.
    let refunded = false
    const refundAmount = Number(existing.total_paid ?? 0)

    if (refund && existing.payment_status === 'paid' && refundAmount > 0) {
        const { data: claim } = await supabase
            .from('bundle_orders')
            .update({ payment_status: 'refunded', updated_at: new Date().toISOString() })
            .eq('id', orderId)
            .eq('payment_status', 'paid')
            .select('id')
            .maybeSingle()

        if (claim) {
            const { error: creditError } = await supabase.rpc('credit_wallet_balance', {
                p_user_id: existing.user_id,
                p_amount: refundAmount,
            })

            if (creditError) {
                console.error('[BundleCompletion] CRITICAL: refund failed for', existing.reference_code, creditError)
                await supabase.from('bundle_orders').update({ payment_status: 'paid' }).eq('id', orderId)
            } else {
                refunded = true
                // `source` must be one of payment/refund/admin/purchase/referral (see
                // supabase/migrations/20260813_referral_bonuses.sql). The audit row
                // must never take down a refund that already succeeded.
                try {
                    const { data: wallet } = await supabase.from('wallets').select('id').eq('user_id', existing.user_id).single()
                    if (wallet?.id) {
                        const { error: txError } = await supabase.from('wallet_transactions').insert({
                            wallet_id: wallet.id,
                            user_id: existing.user_id,
                            type: 'credit',
                            amount: refundAmount,
                            description: `Refund: ${existing.network} ${existing.bundle_label} bundle to ${existing.beneficiary_phone} could not be delivered`,
                            reference: `REFUND-${existing.reference_code}`,
                            source: 'refund',
                            status: 'completed',
                        })
                        if (txError) console.error('[BundleCompletion] Refund audit row failed (non-fatal):', txError.message)
                    }
                } catch (e) {
                    console.error('[BundleCompletion] Refund audit row failed (non-fatal):', e)
                }
            }
        }
    }

    const finalStatus: BundleFinalStatus = refunded ? 'refunded' : status
    const now = new Date().toISOString()

    const update: any = { status: finalStatus, updated_at: now }
    if (finalStatus !== 'processing') update.fulfilled_at = now
    if (refunded) update.payment_status = 'refunded'
    if (actorId) update.fulfilled_by = actorId
    if (params.kfCommission !== undefined && params.kfCommission !== null) update.kf_commission = params.kfCommission
    if (params.providerReference) update.provider_reference = params.providerReference
    if (params.providerResponse !== undefined) update.provider_response = params.providerResponse
    if (note) {
        update.fulfillment_note = refunded
            ? `${note} GHS ${refundAmount.toFixed(2)} refunded to wallet.`
            : note
    }

    const { error: updateError } = await supabase.from('bundle_orders').update(update).eq('id', orderId)
    if (updateError) {
        console.error('[BundleCompletion] Update error:', updateError)
        return { success: false, error: updateError.message }
    }

    if (finalStatus === 'processing') return { success: true, refunded, order: existing }

    // A refund that was already given earlier must not be announced again when a
    // later failure signal arrives for the same order.
    const alreadyAnnounced = existing.status === finalStatus
    if (alreadyAnnounced) return { success: true, refunded, order: existing }

    // ── Notify ───────────────────────────────────────────────────────────────
    const what = `${existing.network} ${existing.bundle_label}`
    const title = finalStatus === 'completed'
        ? 'Bundle Delivered'
        : refunded ? 'Bundle Refunded' : 'Bundle Failed'
    const message = finalStatus === 'completed'
        ? `${what} has been delivered to ${existing.beneficiary_phone}. Ref: ${existing.reference_code}`
        : refunded
            ? `${what} to ${existing.beneficiary_phone} could not be delivered, so GHS ${refundAmount.toFixed(2)} has been returned to your wallet. Ref: ${existing.reference_code}`
            : `${what} to ${existing.beneficiary_phone} could not be delivered. Our team is looking into it. Ref: ${existing.reference_code}`

    const { error: notifyError } = await supabase.from('notifications').insert({
        user_id: existing.user_id,
        title,
        message,
        type: 'order_update',
        action_url: BUNDLES_USER_PATH,
    })
    if (notifyError) console.error('[BundleCompletion] Notification error:', notifyError.message)

    await sendPushToUser(existing.user_id, {
        title,
        body: message,
        url: BUNDLES_USER_PATH,
        tag: `bundle-${existing.reference_code}`,
    }).catch(() => {})

    return { success: true, refunded, order: existing }
}
