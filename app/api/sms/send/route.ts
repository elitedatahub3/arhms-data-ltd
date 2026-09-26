import { NextResponse } from 'next/server'
import { Ratelimit } from '@upstash/ratelimit'
import { Redis } from '@upstash/redis'
import { loadSmsContext, smsBlockReason, isCustomerSmsEnabled, SMS_DISABLED_MESSAGE } from '@/lib/sms/sms-purchase'
import {
    countSegments,
    getAllowedSenders,
    normaliseRecipients,
    dispatchCampaignBatch,
    settleCampaignIfDone,
    SMS_MESSAGE_MIN,
    SMS_MESSAGE_MAX,
} from '@/lib/sms/customer-sms'

// Sends are paid for, so this is a guard against a runaway client loop rather
// than a cost control. Lazy-init so a missing Redis env var does not crash the
// module — the same fail-open shape as the admin broadcast route.
let sendRateLimit: Ratelimit | null = null
try {
    sendRateLimit = new Ratelimit({
        redis: Redis.fromEnv(),
        limiter: Ratelimit.slidingWindow(20, '10 m'),
        prefix: 'rl:customer-sms-send',
    })
} catch (e) {
    console.error('[CustomerSmsSend] Redis init failed — send rate limit disabled:', e)
}

const MAX_RECIPIENTS = 10000
const DEFAULT_INLINE_MAX = 100

/**
 * Sends a Customer SMS campaign.
 *
 * Credits are taken up front for the whole list, atomically, before anything is
 * queued — so a send can never go out that was not paid for, and two sends
 * racing on the last few credits cannot both win. Messages the provider rejects
 * are refunded one by one as they fail.
 *
 * Small sends are dispatched inside this request so the owner sees results
 * straight away; larger ones are left queued for the cron worker, because a
 * serverless request cannot outlive a few thousand provider calls.
 */
export async function POST(request: Request) {
    try {
        const ctx = await loadSmsContext()
        if ('error' in ctx) return NextResponse.json({ error: ctx.error }, { status: ctx.status })

        const { authUser, supabaseAdmin, account, shop, sub, settingsMap } = ctx

        if (!isCustomerSmsEnabled(settingsMap)) {
            return NextResponse.json({ error: SMS_DISABLED_MESSAGE }, { status: 503 })
        }

        const blockedReason = smsBlockReason(shop, sub)
        if (blockedReason) return NextResponse.json({ error: blockedReason }, { status: 403 })

        if (account.status === 'locked') {
            return NextResponse.json({ error: 'Unlock Customer SMS before sending' }, { status: 403 })
        }
        if (account.status === 'suspended') {
            return NextResponse.json({ error: 'Your Customer SMS access is suspended. Please contact support.' }, { status: 403 })
        }

        try {
            if (sendRateLimit) {
                const { success } = await sendRateLimit.limit(authUser.id)
                if (!success) {
                    return NextResponse.json({ error: 'Too many sends in a short time. Please wait a few minutes.' }, { status: 429 })
                }
            }
        } catch (rlErr) {
            console.error('[CustomerSmsSend] Rate limit check failed, proceeding:', rlErr)
        }

        const body: any = await request.json().catch(() => ({}))
        const message = String(body.message || '').trim()
        const reference = body.reference ? String(body.reference).slice(0, 100) : null

        if (message.length < SMS_MESSAGE_MIN || message.length > SMS_MESSAGE_MAX) {
            return NextResponse.json(
                { error: `Message must be between ${SMS_MESSAGE_MIN} and ${SMS_MESSAGE_MAX} characters` },
                { status: 400 }
            )
        }

        // Idempotency: a retried send with the same reference gets the original
        // campaign back instead of a second send and a second charge.
        if (reference) {
            const { data: existing } = await supabaseAdmin
                .from('sms_campaigns')
                .select('id, status, recipients_count, segments, credits_charged, sender_used')
                .eq('account_id', account.id)
                .eq('reference', reference)
                .maybeSingle()

            if (existing) {
                return NextResponse.json({
                    success: true,
                    duplicate: true,
                    campaignId: (existing as any).id,
                    status: (existing as any).status,
                    recipients: (existing as any).recipients_count,
                    segments: (existing as any).segments,
                    creditsCharged: (existing as any).credits_charged,
                    sender: (existing as any).sender_used,
                })
            }
        }

        // ── Sender ───────────────────────────────────────────────────────────
        const allowed = await getAllowedSenders(supabaseAdmin, account.id)
        if (!allowed.length) {
            return NextResponse.json(
                { error: 'You have no sender ID to send from yet. Request one and wait for approval.' },
                { status: 400 }
            )
        }

        const requestedSender = String(body.sender || '').trim()
        const fallback = allowed.find(s => s.isDefault) ?? allowed.find(s => s.type === 'own') ?? allowed[0]
        const senderEntry = requestedSender
            ? allowed.find(s => s.sender.toLowerCase() === requestedSender.toLowerCase())
            : fallback

        // Anything not on the allowed list is refused outright: sending under a
        // name the networks have not approved for this business is exactly the
        // impersonation the approval process exists to stop.
        if (!senderEntry) {
            return NextResponse.json(
                { error: 'That sender ID is not approved for your account', allowedSenders: allowed.map(s => s.sender) },
                { status: 400 }
            )
        }

        // ── Recipients ───────────────────────────────────────────────────────
        const numbers: string[] = Array.isArray(body.recipients)
            ? body.recipients.map(String)
            : typeof body.recipients === 'string'
                ? body.recipients.split(/[\s,;]+/)
                : []

        const { recipients, invalid, optedOut } = await normaliseRecipients(supabaseAdmin, account.id, {
            numbers,
            contactIds: Array.isArray(body.contactIds) ? body.contactIds : [],
            groupIds: Array.isArray(body.groupIds) ? body.groupIds : [],
            allContacts: body.allContacts === true,
            shopId: shop?.id ?? null,
        })

        if (!recipients.length) {
            return NextResponse.json(
                { error: 'No valid recipients to send to', invalid, optedOut },
                { status: 400 }
            )
        }
        if (recipients.length > MAX_RECIPIENTS) {
            return NextResponse.json(
                { error: `A single send can reach at most ${MAX_RECIPIENTS.toLocaleString()} numbers` },
                { status: 400 }
            )
        }

        // ── Charge ───────────────────────────────────────────────────────────
        const { segments } = countSegments(message)
        const creditsNeeded = segments * recipients.length

        const { data: balanceAfter, error: debitError } = await (supabaseAdmin as any)
            .rpc('debit_sms_credits', { p_account_id: account.id, p_amount: creditsNeeded })

        if (debitError) {
            if (debitError.message?.includes('INSUFFICIENT_CREDITS')) {
                return NextResponse.json(
                    {
                        error: `Not enough SMS credits. This send needs ${creditsNeeded} but you have ${account.credits}.`,
                        creditsNeeded,
                        credits: account.credits,
                    },
                    { status: 402 }
                )
            }
            console.error('[CustomerSmsSend] debit failed:', debitError)
            return NextResponse.json({ error: 'Could not charge your SMS credits' }, { status: 500 })
        }

        // From here the credits are gone, so every failure path gives them back.
        const refundAll = async (why: string) => {
            console.error(`[CustomerSmsSend] Refunding ${creditsNeeded} credits (${why}) for account`, account.id)
            const { error } = await (supabaseAdmin as any).rpc('credit_sms_credits', {
                p_account_id: account.id,
                p_amount: creditsNeeded,
                p_purchased: false,
            })
            if (error) console.error('[CustomerSmsSend] CRITICAL: refund failed', error)
        }

        const { data: campaign, error: campaignError } = await (supabaseAdmin.from('sms_campaigns') as any)
            .insert({
                account_id: account.id,
                message,
                sender_used: senderEntry.sender,
                recipients_count: recipients.length,
                segments,
                credits_charged: creditsNeeded,
                status: 'queued',
                source: 'dashboard',
                reference,
            })
            .select('id')
            .single()

        if (campaignError || !campaign) {
            await refundAll('campaign insert failed')
            // A unique violation here means a concurrent retry with the same
            // reference won the race; the caller should look it up, not resend.
            if ((campaignError as any)?.code === '23505') {
                return NextResponse.json({ error: 'This send is already in progress' }, { status: 409 })
            }
            console.error('[CustomerSmsSend] campaign insert failed:', campaignError)
            return NextResponse.json({ error: 'Could not create the send' }, { status: 500 })
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
            const { error } = await (supabaseAdmin.from('sms_messages') as any).insert(rows)
            if (error) {
                console.error('[CustomerSmsSend] message insert failed:', error)
                // Nothing has been sent yet, so the whole campaign is void.
                await supabaseAdmin.from('sms_messages').delete().eq('campaign_id', campaignId)
                await (supabaseAdmin.from('sms_campaigns') as any)
                    .update({ status: 'failed', completed_at: new Date().toISOString() })
                    .eq('id', campaignId)
                await refundAll('message insert failed')
                return NextResponse.json({ error: 'Could not queue your messages. Your credits have been refunded.' }, { status: 500 })
            }
        }

        const inlineMaxRaw = Number(String(settingsMap.sms_inline_send_max ?? '').replace(/^"+|"+$/g, ''))
        const inlineMax = inlineMaxRaw > 0 ? inlineMaxRaw : DEFAULT_INLINE_MAX

        if (recipients.length <= inlineMax) {
            await (supabaseAdmin.from('sms_campaigns') as any).update({ status: 'processing' }).eq('id', campaignId)
            const result = await dispatchCampaignBatch(supabaseAdmin, campaignId, recipients.length)
            await settleCampaignIfDone(supabaseAdmin, campaignId)

            const { data: finalAccount } = await supabaseAdmin
                .from('sms_accounts')
                .select('credits')
                .eq('id', account.id)
                .maybeSingle()

            return NextResponse.json({
                success: true,
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
            })
        }

        return NextResponse.json({
            success: true,
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
        })
    } catch (error: any) {
        console.error('[CustomerSmsSend] Error:', error)
        return NextResponse.json({ error: error.message || 'Failed to send' }, { status: 500 })
    }
}
