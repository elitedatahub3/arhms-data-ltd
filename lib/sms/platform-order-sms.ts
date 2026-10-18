/**
 * SMS Platform order confirmations — separate from the shop's.
 *
 * When a user buys data or airtime on the platform itself (dashboard or API)
 * the recipient gets a confirmation SMS. Normally it comes from the house
 * sender. With "Use my sender ID for order confirmations" switched on in the
 * SMS Platform, it comes from the BUYER's own approved sender ID instead,
 * paid from the buyer's SMS credits.
 *
 * This is not the shop setting. Storefront orders are confirmed by
 * lib/sms/order-confirmations.ts under the shop's own toggles
 * (order_sms_data_enabled / order_sms_airtime_enabled); this module never
 * touches a storefront order.
 *
 * Whenever the buyer's sender cannot be used — switch off, no approved
 * sender, out of credits, network refused — the house message goes out
 * exactly as before, so a recipient is never left without a confirmation.
 * Nothing here throws: every caller sits inside a fulfilment path.
 */

import { createServerClient } from '@/lib/supabase'
import { getActiveSmsProvider, normalizeGhanaPhone } from '@/lib/sms-service'
import { isKingFlexySmsConfigured } from '@/lib/kingflexy-sms-service'
import { countSegments } from '@/lib/sms/sms-rules'
import { getAllowedSenders, dispatchCampaignBatch, settleCampaignIfDone } from '@/lib/sms/customer-sms'

export interface PlatformOrderSmsParams {
    /** The buyer — whose sender ID and credits would be used. */
    userId: string | null | undefined
    /** Storefront orders belong to the shop's own confirmation setting; never handled here. */
    isShopOrder: boolean
    recipient: string
    /** The confirmation text, without the house signature — the sender ID is the signature. */
    body: string
    /** Unique per order and message, so a replayed webhook cannot send it twice. */
    reference: string
    /** Sends today's house-branded message; used whenever the buyer's sender is not. */
    houseSend: () => Promise<unknown>
}

/** Records why the last platform confirmation did not use the buyer's sender. Best effort. */
async function noteSkip(db: any, accountId: string, reason: string) {
    try {
        await db.from('sms_accounts')
            .update({ last_platform_order_sms_skip: reason || null, last_platform_order_sms_skip_at: reason ? new Date().toISOString() : null })
            .eq('id', accountId)
    } catch { /* the column may predate its migration */ }
}

/** Tries the buyer's own sender. Returns true only when the message went out under it. */
async function sendUnderBuyerSender(params: PlatformOrderSmsParams): Promise<boolean> {
    if (params.isShopOrder || !params.userId) return false

    const recipient = normalizeGhanaPhone(params.recipient)
    if (!recipient) return false

    const db = createServerClient() as any

    // * rather than naming the column, so a database without
    // 20261018000000_sms_platform_order_sms.sql simply reads it as off.
    const { data: account } = await db.from('sms_accounts').select('*').eq('user_id', params.userId).maybeSingle()
    if (!account || account.platform_order_sms_enabled !== true) return false
    if (account.status !== 'active') {
        await noteSkip(db, account.id, `Your SMS account is ${account.status}.`)
        return false
    }

    const allowed = await getAllowedSenders(db, account.id)
    const own = allowed.find((s: any) => s.type === 'own' && s.isDefault) ?? allowed.find((s: any) => s.type === 'own')
    if (!own) {
        await noteSkip(db, account.id, 'You have no approved sender ID, so the default sender was used.')
        return false
    }

    const gateway = await getActiveSmsProvider('storefront')
    if (gateway !== 'kingflexy' || !isKingFlexySmsConfigured()) {
        console.error(`[PlatformOrderSms] Gateway "${gateway}" cannot carry an own sender ID — house sender used for ${params.reference}.`)
        await noteSkip(db, account.id, 'Own sender IDs are not available right now, so the default sender was used.')
        return false
    }

    const reference = `porder:${params.reference}`.slice(0, 100)
    const { data: existing } = await db.from('sms_campaigns').select('id').eq('account_id', account.id).eq('reference', reference).maybeSingle()
    // Already sent under their name on an earlier pass: do not send it again
    // under any name.
    if (existing) return true

    const message = params.body
    const { segments } = countSegments(message)

    const { error: debitError } = await db.rpc('debit_sms_credits', { p_account_id: account.id, p_amount: segments })
    if (debitError) {
        if (String(debitError.message || '').includes('INSUFFICIENT_CREDITS')) {
            await noteSkip(db, account.id, 'You ran out of SMS credits, so the default sender was used.')
        } else {
            console.error('[PlatformOrderSms] Credit debit failed:', debitError)
        }
        return false
    }

    const refund = async (why: string) => {
        const { error } = await db.rpc('credit_sms_credits', { p_account_id: account.id, p_amount: segments, p_purchased: false })
        if (error) console.error(`[PlatformOrderSms] CRITICAL: refund failed after ${why} for ${params.reference}`, error)
    }

    const { data: campaign, error: campaignError } = await db.from('sms_campaigns')
        .insert({
            account_id: account.id,
            message,
            sender_used: own.sender,
            recipients_count: 1,
            segments,
            credits_charged: segments,
            status: 'processing',
            source: 'order',
            reference,
        })
        .select('id')
        .single()

    if (campaignError || !campaign) {
        await refund('campaign insert')
        // A concurrent pass already holds this reference and will send it.
        if ((campaignError as any)?.code === '23505') return true
        console.error('[PlatformOrderSms] Campaign insert failed:', campaignError)
        return false
    }

    const { error: messageError } = await db.from('sms_messages').insert({
        campaign_id: campaign.id,
        account_id: account.id,
        recipient,
        status: 'queued',
    })
    if (messageError) {
        console.error('[PlatformOrderSms] Message insert failed:', messageError)
        await db.from('sms_campaigns').update({ status: 'failed', completed_at: new Date().toISOString() }).eq('id', campaign.id)
        await refund('message insert')
        return false
    }

    // A rejected message is refunded by the dispatcher itself.
    const result = await dispatchCampaignBatch(db, campaign.id, 1)
    await settleCampaignIfDone(db, campaign.id)

    if (result.sent > 0) {
        await noteSkip(db, account.id, '')
        return true
    }
    await noteSkip(db, account.id, 'The network rejected the message under your sender ID, so the default sender was used.')
    return false
}

/**
 * Sends a platform order confirmation: under the buyer's own sender ID when
 * they have switched that on, otherwise (or if it fails) the house message.
 */
export async function sendPlatformOrderSms(params: PlatformOrderSmsParams): Promise<void> {
    let sentAsBuyer = false
    try {
        sentAsBuyer = await sendUnderBuyerSender(params)
    } catch (err: any) {
        console.error('[PlatformOrderSms] Unexpected error, falling back to house sender:', err?.message || err)
    }
    if (sentAsBuyer) return
    try {
        await params.houseSend()
    } catch (err: any) {
        console.error('[PlatformOrderSms] House SMS failed:', err?.message || err)
    }
}
