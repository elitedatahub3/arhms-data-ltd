import { NextResponse } from 'next/server'
import { Ratelimit } from '@upstash/ratelimit'
import { Redis } from '@upstash/redis'
import { loadSmsContext, smsBlockReason, isCustomerSmsEnabled, SMS_DISABLED_MESSAGE } from '@/lib/sms/sms-purchase'
import { sendCampaign } from '@/lib/sms/send-campaign'

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

/**
 * Sends an SMS campaign from the dashboard. The charging, queuing and dispatch
 * live in lib/sms/send-campaign.ts, shared with the developer API.
 */
export async function POST(request: Request) {
    try {
        const ctx = await loadSmsContext()
        if ('error' in ctx) return NextResponse.json({ error: ctx.error }, { status: ctx.status })

        const { authUser, supabaseAdmin, account, shop, sub, settingsMap, mode } = ctx

        if (!isCustomerSmsEnabled(settingsMap)) {
            return NextResponse.json({ error: SMS_DISABLED_MESSAGE }, { status: 503 })
        }

        const blockedReason = smsBlockReason(shop, sub, ctx.userStatus)
        if (blockedReason) return NextResponse.json({ error: blockedReason }, { status: 403 })

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

        const result = await sendCampaign({
            db: supabaseAdmin,
            account,
            mode,
            scope: ctx.scope,
            settingsMap,
            shopId: shop?.id ?? null,
            source: 'dashboard',
            message: body.message,
            sender: body.sender,
            recipients: body.recipients,
            contactIds: body.contactIds,
            groupIds: body.groupIds,
            allContacts: body.allContacts === true,
            reference: body.reference,
        })

        if (result.ok === false) {
            return NextResponse.json({ error: result.error, ...result.extra }, { status: result.status })
        }
        return NextResponse.json({ success: true, ...result.data })
    } catch (error: any) {
        console.error('[CustomerSmsSend] Error:', error)
        return NextResponse.json({ error: error.message || 'Failed to send' }, { status: 500 })
    }
}
