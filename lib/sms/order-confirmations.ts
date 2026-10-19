/**
 * Shop-branded order confirmations.
 *
 * When a shop switches these on, its storefront data and airtime buyers get the
 * confirmation from the SHOP's approved sender ID, charged to the SHOP's SMS
 * credits — instead of the ARHMS house sender at the platform's expense. When
 * they are off, nothing is sent at all: the platform no longer pays to advertise
 * somebody else's shop.
 *
 * Every caller sits inside a fulfilment path, so nothing here may throw and
 * nothing here may be slow enough to matter. Each refusal returns a named
 * reason instead, which the caller logs.
 *
 * The send is a one-recipient campaign rather than a bare provider call. That
 * costs two inserts, and buys the credit ledger, the delivery reports, the
 * refund-on-rejection path and a row in the owner's own History — all of which
 * already exist and would otherwise have to be rebuilt here.
 */

import { getActiveSmsProvider, normalizeGhanaPhone } from '@/lib/sms-service'
import { isKingFlexySmsConfigured } from '@/lib/kingflexy-sms-service'
import { countSegments } from '@/lib/sms/sms-rules'
import { getAllowedSenders, dispatchCampaignBatch, settleCampaignIfDone, findSmsAccountByUser } from '@/lib/sms/customer-sms'

export type OrderSmsKind = 'data' | 'airtime' | 'afa' | 'utility' | 'voucher'

export interface OrderConfirmationParams {
    /** The storefront the order was placed on — a sub-agent's own shop, for a sub. */
    shopId: string
    /** Ours, only for the idempotency key. */
    orderId: string
    kind: OrderSmsKind
    /**
     * Replaces the generated text. USSD sends afa/utility/voucher notices this way:
     * their wording is the caller's, only the sender and the billing are ours.
     */
    message?: string
    /** Distinguishes several notices for one order (a bill's processing vs completed). */
    suffix?: string
    /** The buyer's number, in any Ghana form. */
    phone: string
    details: {
        network?: string | null
        size?: string | null
        amount?: number | null
    }
}

export interface OrderConfirmationResult {
    sent: boolean
    /** Why nothing was sent. Always set when `sent` is false. */
    skipped?: string
    campaignId?: string
}

// Only data and airtime have an owner switch. The USSD notices (afa, utility,
// voucher) go out under the shop whenever it can carry them: the buyer dialled that
// shop's code, and the alternative is the house sender on a stranger's sale.
const TOGGLE_COLUMN: Partial<Record<OrderSmsKind, string>> = {
    data: 'order_sms_data_enabled',
    airtime: 'order_sms_airtime_enabled',
}

/**
 * Kept to one GSM-7 segment wherever possible: the owner pays per segment, and
 * a shop name long enough to spill into a second one doubles their bill on
 * every single order.
 */
function buildMessage(kind: OrderSmsKind, shopName: string, params: OrderConfirmationParams): string {
    if (params.message) return params.message.replace(/\s+/g, ' ').trim()
    const network = (params.details.network || '').trim()

    if (kind === 'airtime') {
        const amount = Number(params.details.amount ?? 0).toFixed(2)
        return `Hi! GHS ${amount} ${network} airtime has been sent to ${params.phone}. Thank you for buying from ${shopName}.`.replace(/\s+/g, ' ').trim()
    }

    const size = (params.details.size || '').trim()
    return `Hi! Your ${network} ${size} order has been received and is being processed. Thank you for buying from ${shopName}.`.replace(/\s+/g, ' ').trim()
}

/**
 * Records why the last confirmation did not send, for the owner to read.
 *
 * Only the reasons they can act on. "Already sent" and "switched off" are the
 * system working as asked, and writing those would bury the real ones.
 */
async function noteSkip(db: any, accountId: string, reason: string) {
    try {
        await db
            .from('sms_accounts')
            .update({ last_order_sms_skip: reason, last_order_sms_skip_at: new Date().toISOString() })
            .eq('id', accountId)
    } catch (err) {
        console.error('[OrderSms] Could not record the skip reason:', err)
    }
}

/**
 * Warns the owner that a confirmation was dropped for want of credits.
 *
 * Throttled to one unread notice per account: a shop that runs dry at midday
 * would otherwise collect one of these per order for the rest of the day.
 */
async function warnOutOfCredits(db: any, userId: string, portalPath: string) {
    try {
        // Deduped on the title, not a type of its own: notifications.type is
        // CHECK-constrained to a fixed list, and a value outside it fails the
        // insert — which would lose the warning entirely.
        const TITLE = 'SMS credits finished'

        const { data: existing } = await db
            .from('notifications')
            .select('id')
            .eq('user_id', userId)
            .eq('title', TITLE)
            .eq('is_read', false)
            .limit(1)
            .maybeSingle()

        if (existing) return

        await db.from('notifications').insert({
            user_id: userId,
            title: TITLE,
            message: 'Your customers are no longer getting order confirmation SMS. Top up your SMS credits to start again.',
            type: 'system',
            action_url: `${portalPath}?tab=credits`,
        })
    } catch (err) {
        console.error('[OrderSms] Could not write the out-of-credits notice:', err)
    }
}

/**
 * Sends one shop-branded order confirmation, or explains why it did not.
 *
 * @param db A service-role client — this reads and writes other people's rows.
 */
export async function sendShopOrderConfirmation(
    db: any,
    params: OrderConfirmationParams
): Promise<OrderConfirmationResult> {
    try {
        if (!params.shopId || !params.phone) return { sent: false, skipped: 'missing shop or phone' }

        // Stored in the 233XXXXXXXXX form every other SMS row uses. The guest
        // phone arrives as 0XXXXXXXXX, and the delivery webhook matches rows on
        // the recipient string — an un-normalised row would never be updated.
        const recipient = normalizeGhanaPhone(params.phone)
        if (!recipient) return { sent: false, skipped: 'invalid phone' }

        // ── Who owns this shop, and do they have an SMS account? ─────────────
        // Resolved through owner_id rather than sms_accounts.shop_id, which is
        // null for an account that existed before the shop did.
        const { data: shop } = await db
            .from('shop_profiles')
            .select('id, owner_id, shop_name')
            .eq('id', params.shopId)
            .maybeSingle()

        if (!shop?.owner_id) return { sent: false, skipped: 'shop not found' }

        // The SHOP's Customer SMS account — never the owner's SMS Platform account.
        const account = await findSmsAccountByUser(
            db,
            shop.owner_id,
            'shop',
            `id, user_id, status, credits${TOGGLE_COLUMN[params.kind] ? `, ${TOGGLE_COLUMN[params.kind]}` : ''}`,
        )

        if (!account) return { sent: false, skipped: 'no sms account' }
        if (account.status !== 'active') return { sent: false, skipped: `account ${account.status}` }
        const toggle = TOGGLE_COLUMN[params.kind]
        if (toggle && !account[toggle]) return { sent: false, skipped: `${params.kind} confirmations off` }

        // ── Sender ───────────────────────────────────────────────────────────
        // Their OWN approved name only. Falling back to a pool sender would put
        // someone else's brand on this shop's order, which is the whole thing
        // this feature exists to stop.
        const allowed = await getAllowedSenders(db, account.id)
        const own = allowed.find((s: any) => s.type === 'own' && s.isDefault) ?? allowed.find((s: any) => s.type === 'own')
        if (!own) {
            await noteSkip(db, account.id, 'You have no approved sender ID, so there is no name to send from.')
            return { sent: false, skipped: 'no approved sender id' }
        }

        // ── Gateway ──────────────────────────────────────────────────────────
        const gateway = await getActiveSmsProvider('storefront')
        if (gateway !== 'kingflexy' || !isKingFlexySmsConfigured()) {
            console.error(
                `[OrderSms] Storefront gateway "${gateway}" cannot carry a per-shop sender ID` +
                `${gateway === 'kingflexy' ? ' (KINGFLEXY_SMS_KEY missing)' : ''} — confirmation skipped for order ${params.orderId}.`
            )
            await noteSkip(db, account.id, 'Sending is not configured for shop sender IDs yet — contact support.')
            return { sent: false, skipped: 'gateway cannot carry own sender' }
        }

        const message = buildMessage(params.kind, shop.shop_name || 'our shop', params)
        const { segments } = countSegments(message)

        // ── Idempotency ──────────────────────────────────────────────────────
        // Supplier webhooks replay and sync crons re-run over the same order.
        // The reference is unique per (account, reference), so the check below
        // and the insert's own constraint both hold the line.
        const reference = `order:${params.orderId}:${params.kind}${params.suffix ? `:${params.suffix}` : ''}`.slice(0, 100)

        const { data: existing } = await db
            .from('sms_campaigns')
            .select('id')
            .eq('account_id', account.id)
            .eq('reference', reference)
            .maybeSingle()

        if (existing) return { sent: false, skipped: 'already sent', campaignId: existing.id }

        // ── Charge ───────────────────────────────────────────────────────────
        const { error: debitError } = await db.rpc('debit_sms_credits', {
            p_account_id: account.id,
            p_amount: segments,
        })

        if (debitError) {
            if (String(debitError.message || '').includes('INSUFFICIENT_CREDITS')) {
                // A sub-agent reads their SMS pages under /dashboard/sub.
                const { data: sub } = await db.from('sub_agents').select('id').eq('user_id', shop.owner_id).maybeSingle()
                await warnOutOfCredits(db, shop.owner_id, sub ? '/dashboard/sub/sms' : '/dashboard/shop/sms')
                await noteSkip(db, account.id, 'You ran out of SMS credits.')
                return { sent: false, skipped: 'insufficient credits' }
            }
            console.error('[OrderSms] Credit debit failed:', debitError)
            return { sent: false, skipped: 'debit failed' }
        }

        const refund = async (why: string) => {
            const { error } = await db.rpc('credit_sms_credits', {
                p_account_id: account.id,
                p_amount: segments,
                p_purchased: false,
            })
            if (error) console.error(`[OrderSms] CRITICAL: refund failed after ${why} for order ${params.orderId}`, error)
        }

        // ── Campaign of one ──────────────────────────────────────────────────
        const { data: campaign, error: campaignError } = await db
            .from('sms_campaigns')
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
            // 23505 means a concurrent caller won the same reference — theirs
            // will send, so this one must not.
            const skipped = (campaignError as any)?.code === '23505' ? 'already sending' : 'campaign insert failed'
            if (skipped !== 'already sending') console.error('[OrderSms] Campaign insert failed:', campaignError)
            return { sent: false, skipped }
        }

        const { error: messageError } = await db.from('sms_messages').insert({
            campaign_id: campaign.id,
            account_id: account.id,
            recipient,
            status: 'queued',
        })

        if (messageError) {
            console.error('[OrderSms] Message insert failed:', messageError)
            await db.from('sms_campaigns').update({ status: 'failed', completed_at: new Date().toISOString() }).eq('id', campaign.id)
            await refund('message insert')
            return { sent: false, skipped: 'message insert failed' }
        }

        // Inline: one message to one number, and the buyer is waiting.
        const result = await dispatchCampaignBatch(db, campaign.id, 1)
        await settleCampaignIfDone(db, campaign.id)

        if (result.sent > 0) {
            // Clear a stale reason so the screen does not keep explaining a
            // problem that has since been fixed.
            await noteSkip(db, account.id, '')
            return { sent: true, campaignId: campaign.id }
        }

        await noteSkip(db, account.id, 'The network rejected the message. Your credits were refunded.')
        return { sent: false, skipped: 'provider rejected', campaignId: campaign.id }
    } catch (error: any) {
        // Never let a confirmation take an order down with it.
        console.error('[OrderSms] Unexpected error (order unaffected):', error?.message || error)
        return { sent: false, skipped: 'unexpected error' }
    }
}

/**
 * A USSD notice for a shop's buyer: under the SHOP's sender ID when it can carry it,
 * otherwise through `fallback` (the house path). The buyer is never left without one.
 *
 * "Already sent" is not a failure: a replayed settlement must not text twice.
 */
export async function sendShopOrHouseSms(
    db: any,
    params: OrderConfirmationParams,
    fallback: () => Promise<unknown>
): Promise<{ via: 'shop' | 'house' | 'none'; skipped?: string }> {
    const outcome = await sendShopOrderConfirmation(db, params)
    if (outcome.sent) return { via: 'shop' }
    if (outcome.skipped === 'already sent' || outcome.skipped === 'already sending') {
        return { via: 'none', skipped: outcome.skipped }
    }
    try {
        await fallback()
    } catch (err: any) {
        console.error('[OrderSms] House fallback failed:', err?.message || err)
    }
    return { via: 'house', skipped: outcome.skipped }
}
