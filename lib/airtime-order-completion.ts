/**
 * The single place an airtime order changes state.
 *
 * Two callers move an airtime order out of 'pending': an admin pressing a button
 * in /admin/airtime, and the Hubtel Commission Services callback. Both must do the
 * same six things — update the row, sync a storefront order down to `orders` and
 * `shop_orders`, notify the buyer in-app, push, SMS the beneficiary on success.
 *
 * Keeping one implementation is the point: when this lived only inside the admin
 * PATCH, an automatic completion would have skipped the shop sync and the customer
 * SMS, and the two paths would have drifted the first time either was edited.
 */
import { createServerClient } from '@/lib/supabase'
import { sendAirtimeCompletedSMS } from '@/lib/sms-service'
import { sendPushToUser } from '@/lib/web-push'
import { queueApiWebhook } from '@/lib/api-webhook'

export type AirtimeFinalStatus = 'processing' | 'completed' | 'failed'

export interface FinalizeAirtimeOrderParams {
    orderId: string
    status: AirtimeFinalStatus
    /** Reason / provider detail. Required by callers when status is 'failed'. */
    note?: string | null
    /** The admin who acted, when a human did. Absent for provider-driven completions. */
    actorId?: string | null
    /** Pass the already-loaded row to save a round trip. */
    existingOrder?: any
}

export interface FinalizeAirtimeOrderResult {
    success: boolean
    error?: string
    order?: any
}

export async function finalizeAirtimeOrder(
    params: FinalizeAirtimeOrderParams
): Promise<FinalizeAirtimeOrderResult> {
    const { orderId, status, note, actorId } = params
    const supabase = createServerClient() as any

    let existing = params.existingOrder
    if (!existing) {
        const { data, error } = await supabase
            .from('airtime_orders')
            .select('*')
            .eq('id', orderId)
            .single()
        if (error || !data) return { success: false, error: 'Order not found' }
        existing = data
    }

    const updatePayload: any = {
        status,
        fulfilled_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
    }
    // Only stamped when a human acted. Writing the admin's ID for a callback-driven
    // completion would credit them with work the provider did.
    if (actorId) updatePayload.fulfilled_by = actorId
    if (note) updatePayload.fulfillment_note = note

    const { error: updateError } = await supabase
        .from('airtime_orders')
        .update(updatePayload)
        .eq('id', orderId)

    if (updateError) {
        console.error('[AirtimeCompletion] Update error:', updateError)
        return { success: false, error: updateError.message }
    }

    // No commission is earned on airtime. It is sold through the STANDARD API key
    // like a data bundle — priced with the ordinary role fee — and only utility bill
    // payments pay a Commission Services partner a share. See lib/commission-earning.

    // Tell the partner, if this order came from an API key with a webhook configured.
    // Terminal states only — 'processing' is not news.
    if (status !== 'processing' && existing.api_key_id) {
        await queueApiWebhook({
            apiKeyId: existing.api_key_id,
            payload: {
                event:          `airtime.${status}`,
                reference:      existing.reference_code,
                order_id:       existing.id,
                status,
                network:        existing.network,
                recipient:      existing.beneficiary_phone,
                airtime_amount: Number(existing.airtime_amount ?? 0),
                total_paid:     Number(existing.total_paid ?? 0),
                note:           note ?? null,
            },
        })
    }

    // ── Storefront sync ──────────────────────────────────────────────────────
    // A shop order lives in three tables; the customer watches the shop_orders copy.
    if (existing.reference_code && String(existing.reference_code).startsWith('SHOP-')) {
        try {
            const refSuffix = String(existing.reference_code).replace('SHOP-', '')

            await supabase.from('orders').update({ status }).eq('reference_code', existing.reference_code)

            const { data: sOrder } = await supabase
                .from('shop_orders')
                .select('id')
                .ilike('paystack_reference', `%${refSuffix}`)
                .single()

            if (sOrder?.id) {
                await supabase
                    .from('shop_orders')
                    .update({ status, updated_at: new Date().toISOString() })
                    .eq('id', sOrder.id)
            }
        } catch (e) {
            console.error('[AirtimeCompletion] Shop sync failed (non-fatal):', e)
        }
    }

    // 'processing' is an interim state — the order is in flight at the provider and
    // the customer has already been told it is pending. Announcing it again would be
    // noise, so notifications only fire on a terminal state.
    if (status === 'processing') {
        return { success: true, order: existing }
    }

    const isMashup = existing.type === 'mashup'
    const amount = Number(existing.airtime_amount ?? 0)

    const title = status === 'completed'
        ? (isMashup ? 'Mashup Bundle Sent ✅' : 'Airtime Sent ✅')
        : (isMashup ? 'Mashup Order Failed' : 'Airtime Order Failed')

    const message = status === 'completed'
        ? (isMashup
            ? `Your MTN Mashup bundle for ${existing.beneficiary_phone} has been activated. Ref: ${existing.reference_code}`
            : `GHS ${amount.toFixed(2)} airtime for ${existing.beneficiary_phone} has been sent successfully. Ref: ${existing.reference_code}`)
        : `Your ${isMashup ? 'Mashup' : 'airtime'} order ${existing.reference_code} could not be completed. Please contact support.`

    supabase.from('notifications').insert({
        user_id: existing.user_id,
        title,
        message,
        type: 'order_update',
        action_url: '/dashboard/airtime',
    }).then(() => {}).catch((e: any) => console.error('[AirtimeCompletion] Notification error:', e))

    await sendPushToUser(existing.user_id, {
        title: title.replace(' ✅', ''),
        body: status === 'completed'
            ? (isMashup
                ? `Your MTN Mashup bundle for ${existing.beneficiary_phone} has been activated.`
                : `GHS ${amount.toFixed(2)} airtime for ${existing.beneficiary_phone} sent successfully.`)
            : `Your ${isMashup ? 'Mashup' : 'airtime'} order ${existing.reference_code} could not be completed. Contact support.`,
        url: '/dashboard/airtime',
        // Later updates to this same order replace the earlier alert rather
        // than leaving a trail of stale ones in the notification shade.
        tag: `airtime-${existing.reference_code}`,
    }).catch(() => {})

    if (status === 'completed') {
        sendAirtimeCompletedSMS(existing.beneficiary_phone, amount)
            .catch(err => console.error('[AirtimeCompletion] Completed SMS failed:', err))
    }

    return { success: true, order: existing }
}
