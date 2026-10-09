/**
 * Sending an SMS campaign — the one path every paid send goes through, from
 * the dashboard and from the developer API alike.
 *
 * Credits are taken up front for the whole list, atomically, before anything is
 * queued — so a send can never go out that was not paid for, and two sends
 * racing on the last few credits cannot both win. Messages the provider rejects
 * are refunded one by one as they fail.
 *
 * Small sends are dispatched inside the request so the caller sees results
 * straight away; larger ones are left queued for the cron worker, because a
 * serverless request cannot outlive a few thousand provider calls.
 *
 * Returns a plain result rather than a response: the dashboard answers in its
 * own JSON shape and the API in the v2 envelope.
 */

import { isKingFlexySmsConfigured } from '@/lib/kingflexy-sms-service'
import { getActiveSmsProvider } from '@/lib/sms-service'
import {
    countSegments,
    getAllowedSenders,
    normaliseRecipients,
    dispatchCampaignBatch,
    settleCampaignIfDone,
    SMS_MESSAGE_MIN,
    SMS_MESSAGE_MAX,
    type SmsAccount,
} from '@/lib/sms/customer-sms'
import { checkMessageContent, type SmsMode } from '@/lib/sms/sms-rules'
import { dailyLimitFor, countSentToday } from '@/lib/sms/platform'

export const MAX_RECIPIENTS = 10000
const DEFAULT_INLINE_MAX = 100

export interface SendCampaignInput {
    db: any
    account: SmsAccount
    mode: SmsMode
    settingsMap: Record<string, any>
    shopId: string | null
    source: 'dashboard' | 'api'
    message: string
    sender?: string | null
    /** Raw numbers, as an array or a comma/space/newline separated string. */
    recipients?: unknown
    contactIds?: unknown
    groupIds?: unknown
    allContacts?: boolean
    /** Idempotency key: a retry with the same reference returns the original send. */
    reference?: string | null
}

export type SendCampaignResult =
    | { ok: true; data: Record<string, any> }
    | { ok: false; status: number; error: string; extra?: Record<string, any> }

const fail = (status: number, error: string, extra?: Record<string, any>): SendCampaignResult =>
    ({ ok: false, status, error, extra })

export async function sendCampaign(input: SendCampaignInput): Promise<SendCampaignResult> {
    const { db, account, mode, settingsMap, shopId, source } = input

    if (account.status === 'locked') return fail(403, 'Unlock SMS before sending')
    if (account.status === 'suspended') return fail(403, 'Your SMS access is suspended. Please contact support.')

    const message = String(input.message || '').trim()
    const reference = input.reference ? String(input.reference).slice(0, 100) : null

    if (message.length < SMS_MESSAGE_MIN || message.length > SMS_MESSAGE_MAX) {
        return fail(400, `Message must be between ${SMS_MESSAGE_MIN} and ${SMS_MESSAGE_MAX} characters`)
    }

    // Idempotency first: a retry of a send that already went out must get the
    // original back even if the rules below would now say no.
    if (reference) {
        const { data: existing } = await db
            .from('sms_campaigns')
            .select('id, status, recipients_count, segments, credits_charged, sender_used')
            .eq('account_id', account.id)
            .eq('reference', reference)
            .maybeSingle()

        if (existing) {
            return {
                ok: true,
                data: {
                    duplicate: true,
                    campaignId: (existing as any).id,
                    status: (existing as any).status,
                    recipients: (existing as any).recipients_count,
                    segments: (existing as any).segments,
                    creditsCharged: (existing as any).credits_charged,
                    sender: (existing as any).sender_used,
                },
            }
        }
    }

    const content = checkMessageContent(message, mode)
    if (!content.ok) {
        return fail(400, content.error!, { needsBusinessMode: !!content.needsBusinessMode })
    }

    // ── Sender ───────────────────────────────────────────────────────────────
    const allowed = await getAllowedSenders(db, account.id)
    if (!allowed.length) {
        return fail(400, 'You have no sender ID to send from yet. Request one and wait for approval.')
    }

    const requestedSender = String(input.sender || '').trim()
    const fallback = allowed.find(s => s.isDefault) ?? allowed.find(s => s.type === 'own') ?? allowed[0]
    const senderEntry = requestedSender
        ? allowed.find(s => s.sender.toLowerCase() === requestedSender.toLowerCase())
        : fallback

    // Anything not on the allowed list is refused outright: sending under a
    // name the networks have not approved for this account is exactly the
    // impersonation the approval process exists to stop.
    if (!senderEntry) {
        return fail(400, 'That sender ID is not approved for your account', { allowedSenders: allowed.map(s => s.sender) })
    }

    // Refuse a send that cannot possibly arrive, BEFORE any credits move. Only
    // KingFlexy accepts a per-account sender ID; on Moolre or Hubtel a name not
    // registered on the platform's own account comes back "Sender ID is not
    // approved" for every recipient.
    const storefrontGateway = await getActiveSmsProvider('storefront')
    if (senderEntry.type === 'own' && !(storefrontGateway === 'kingflexy' && isKingFlexySmsConfigured())) {
        console.error('[SendCampaign] Blocked: own sender ID with no KingFlexy gateway configured.')
        return fail(503, 'Sending under your own sender ID is not available right now. Please contact support.')
    }

    // ── Recipients ───────────────────────────────────────────────────────────
    const raw = input.recipients
    const numbers: string[] = Array.isArray(raw)
        ? raw.map(String)
        : typeof raw === 'string'
            ? raw.split(/[\s,;]+/)
            : []

    const { recipients, invalid, optedOut } = await normaliseRecipients(db, account.id, {
        numbers,
        contactIds: Array.isArray(input.contactIds) ? input.contactIds.map(String) : [],
        groupIds: Array.isArray(input.groupIds) ? input.groupIds.map(String) : [],
        allContacts: input.allContacts === true,
        shopId,
    })

    if (!recipients.length) return fail(400, 'No valid recipients to send to', { invalid, optedOut })
    if (recipients.length > MAX_RECIPIENTS) {
        return fail(400, `A single send can reach at most ${MAX_RECIPIENTS.toLocaleString()} numbers`)
    }

    // ── Daily limit ──────────────────────────────────────────────────────────
    const dailyLimit = dailyLimitFor(mode, settingsMap)
    if (dailyLimit > 0) {
        const sentToday = await countSentToday(db, account.id)
        if (sentToday + recipients.length > dailyLimit) {
            const left = Math.max(0, dailyLimit - sentToday)
            return fail(429, mode === 'business'
                ? `This send would pass your daily limit of ${dailyLimit.toLocaleString()} messages. You can send ${left.toLocaleString()} more today.`
                : `This send would pass the Platform Mode daily limit of ${dailyLimit.toLocaleString()} messages. You can send ${left.toLocaleString()} more today, or register your business for a higher limit.`,
                { dailyLimit, sentToday, needsBusinessMode: mode !== 'business' })
        }
    }

    // ── Charge ───────────────────────────────────────────────────────────────
    const { segments } = countSegments(message)
    const creditsNeeded = segments * recipients.length

    const { data: balanceAfter, error: debitError } = await db
        .rpc('debit_sms_credits', { p_account_id: account.id, p_amount: creditsNeeded })

    if (debitError) {
        if (debitError.message?.includes('INSUFFICIENT_CREDITS')) {
            return fail(402, `Not enough SMS credits. This send needs ${creditsNeeded} but you have ${account.credits}.`,
                { creditsNeeded, credits: account.credits })
        }
        console.error('[SendCampaign] debit failed:', debitError)
        return fail(500, 'Could not charge your SMS credits')
    }

    // From here the credits are gone, so every failure path gives them back.
    const refundAll = async (why: string) => {
        console.error(`[SendCampaign] Refunding ${creditsNeeded} credits (${why}) for account`, account.id)
        const { error } = await db.rpc('credit_sms_credits', {
            p_account_id: account.id,
            p_amount: creditsNeeded,
            p_purchased: false,
        })
        if (error) console.error('[SendCampaign] CRITICAL: refund failed', error)
    }

    const { data: campaign, error: campaignError } = await db.from('sms_campaigns')
        .insert({
            account_id: account.id,
            message,
            sender_used: senderEntry.sender,
            recipients_count: recipients.length,
            segments,
            credits_charged: creditsNeeded,
            status: 'queued',
            source,
            reference,
        })
        .select('id')
        .single()

    if (campaignError || !campaign) {
        await refundAll('campaign insert failed')
        // A unique violation here means a concurrent retry with the same
        // reference won the race; the caller should look it up, not resend.
        if ((campaignError as any)?.code === '23505') return fail(409, 'This send is already in progress')
        console.error('[SendCampaign] campaign insert failed:', campaignError)
        return fail(500, 'Could not create the send')
    }

    const campaignId = (campaign as any).id

    const CHUNK = 1000
    for (let i = 0; i < recipients.length; i += CHUNK) {
        const rows = recipients.slice(i, i + CHUNK).map(recipient => ({
            campaign_id: campaignId,
            account_id: account.id,
            recipient,
            status: 'queued',
        }))
        const { error } = await db.from('sms_messages').insert(rows)
        if (error) {
            console.error('[SendCampaign] message insert failed:', error)
            // Nothing has been sent yet, so the whole campaign is void.
            await db.from('sms_messages').delete().eq('campaign_id', campaignId)
            await db.from('sms_campaigns')
                .update({ status: 'failed', completed_at: new Date().toISOString() })
                .eq('id', campaignId)
            await refundAll('message insert failed')
            return fail(500, 'Could not queue your messages. Your credits have been refunded.')
        }
    }

    const inlineMaxRaw = Number(String(settingsMap.sms_inline_send_max ?? '').replace(/^"+|"+$/g, ''))
    const inlineMax = inlineMaxRaw > 0 ? inlineMaxRaw : DEFAULT_INLINE_MAX

    if (recipients.length <= inlineMax) {
        await db.from('sms_campaigns').update({ status: 'processing' }).eq('id', campaignId)
        const result = await dispatchCampaignBatch(db, campaignId, recipients.length)
        await settleCampaignIfDone(db, campaignId)

        const { data: finalAccount } = await db
            .from('sms_accounts')
            .select('credits')
            .eq('id', account.id)
            .maybeSingle()

        return {
            ok: true,
            data: {
                campaignId,
                status: result.remaining > 0 ? 'processing' : 'completed',
                recipients: recipients.length,
                segments,
                creditsCharged: creditsNeeded,
                sender: senderEntry.sender,
                sent: result.sent,
                failed: result.failed,
                invalid,
                optedOut,
                balance: (finalAccount as any)?.credits ?? balanceAfter,
            },
        }
    }

    return {
        ok: true,
        data: {
            campaignId,
            status: 'queued',
            recipients: recipients.length,
            segments,
            creditsCharged: creditsNeeded,
            sender: senderEntry.sender,
            invalid,
            optedOut,
            balance: balanceAfter,
            message: 'Your messages are queued and will go out within a few minutes.',
        },
    }
}
