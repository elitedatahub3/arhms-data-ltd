import { NextResponse } from 'next/server'
import { loadSmsContext } from '@/lib/sms/sms-purchase'

const PAGE_SIZE = 100
const MESSAGE_STATUSES = ['queued', 'sending', 'sent', 'delivered', 'undelivered', 'failed', 'expired', 'rejected']

/**
 * One send: its summary, a count per delivery status, and the per-recipient
 * rows 100 at a time.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
    try {
        const ctx = await loadSmsContext()
        if ('error' in ctx) return NextResponse.json({ error: ctx.error }, { status: ctx.status })

        const { supabaseAdmin, account } = ctx
        const { id } = await params
        const url = new URL(request.url)
        const page = Math.max(0, parseInt(url.searchParams.get('page') || '0'))
        const status = url.searchParams.get('status')

        // account_id in the filter is the ownership check: a campaign id that
        // belongs to someone else simply is not found.
        const { data: campaign } = await supabaseAdmin
            .from('sms_campaigns')
            .select('id, message, status, recipients_count, segments, credits_charged, sender_used, source, created_at, completed_at')
            .eq('id', id)
            .eq('account_id', account.id)
            .maybeSingle()

        if (!campaign) return NextResponse.json({ error: 'Send not found' }, { status: 404 })

        // One head-count per status rather than pulling every row to tally them:
        // a 10,000-recipient send would otherwise be 10 round trips of 1000 rows.
        const delivery: Record<string, number> = {}
        await Promise.all(MESSAGE_STATUSES.map(async (s) => {
            const { count } = await supabaseAdmin
                .from('sms_messages')
                .select('id', { count: 'exact', head: true })
                .eq('campaign_id', id)
                .eq('status', s)
            if (count) delivery[s] = count
        }))

        let messagesQuery = supabaseAdmin
            .from('sms_messages')
            .select('recipient, status, error, status_updated_at')
            .eq('campaign_id', id)

        if (status && MESSAGE_STATUSES.includes(status)) messagesQuery = messagesQuery.eq('status', status)

        const { data: messages } = await messagesQuery
            .order('created_at', { ascending: true })
            .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1)

        return NextResponse.json({
            success: true,
            campaign,
            delivery,
            messages: messages || [],
            page,
        })
    } catch (error: any) {
        console.error('[SmsCampaign] GET error:', error)
        return NextResponse.json({ error: 'Failed to load that send' }, { status: 500 })
    }
}
