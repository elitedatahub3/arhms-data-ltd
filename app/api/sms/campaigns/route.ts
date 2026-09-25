import { NextResponse } from 'next/server'
import { loadSmsContext } from '@/lib/sms/sms-purchase'

const PAGE_SIZE = 30
const CAMPAIGN_STATUSES = ['queued', 'processing', 'completed', 'failed', 'blocked']

/** The caller's sends, newest first, 30 per page. */
export async function GET(request: Request) {
    try {
        const ctx = await loadSmsContext()
        if ('error' in ctx) return NextResponse.json({ error: ctx.error }, { status: ctx.status })

        const { supabaseAdmin, account } = ctx
        const url = new URL(request.url)
        const page = Math.max(0, parseInt(url.searchParams.get('page') || '0'))
        const status = url.searchParams.get('status')

        let query = supabaseAdmin
            .from('sms_campaigns')
            .select('id, message, status, recipients_count, segments, credits_charged, sender_used, source, created_at, completed_at', { count: 'exact' })
            .eq('account_id', account.id)

        if (status && CAMPAIGN_STATUSES.includes(status)) query = query.eq('status', status)

        const { data, count } = await query
            .order('created_at', { ascending: false })
            .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1)

        return NextResponse.json({ success: true, campaigns: data || [], total: count ?? 0, page })
    } catch (error: any) {
        console.error('[SmsCampaigns] GET error:', error)
        return NextResponse.json({ error: 'Failed to load your sends' }, { status: 500 })
    }
}
