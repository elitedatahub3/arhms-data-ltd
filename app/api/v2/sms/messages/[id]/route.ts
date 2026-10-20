import { NextRequest } from 'next/server'
import { apiError, apiSuccessV2 } from '@/lib/api-auth'
import { loadSmsApiContext } from '@/lib/sms/api-context'

const PAGE_SIZE = 100
const MESSAGE_STATUSES = ['queued', 'sending', 'sent', 'delivered', 'undelivered', 'failed', 'expired', 'rejected']
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Delivery report for one send: the summary, a count per status, and the
 * per-recipient rows 100 at a time (?page=0, ?status=delivered).
 * SMS API key only.
 */
const ENDPOINT = '/api/v2/sms/messages/[id]'

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const ctx = await loadSmsApiContext(request, ENDPOINT, 'sms_read')
    if (ctx instanceof Response) return ctx

    const { id } = await params
    if (!UUID.test(id)) {
        ctx.log(404, 'Bad id')
        return apiError(404, 'Message not found')
    }

    const url = new URL(request.url)
    const page = Math.max(0, parseInt(url.searchParams.get('page') || '0') || 0)
    const status = url.searchParams.get('status')

    // account_id in the filter is the ownership check.
    const { data: campaign } = await ctx.db
        .from('sms_campaigns')
        .select('id, message, status, recipients_count, segments, credits_charged, sender_used, reference, created_at, completed_at')
        .eq('id', id)
        .eq('account_id', ctx.account.id)
        .maybeSingle()

    if (!campaign) {
        ctx.log(404, 'Not found')
        return apiError(404, 'Message not found')
    }

    const delivery: Record<string, number> = {}
    await Promise.all(MESSAGE_STATUSES.map(async (s) => {
        const { count } = await ctx.db
            .from('sms_messages')
            .select('id', { count: 'exact', head: true })
            .eq('campaign_id', id)
            .eq('status', s)
        if (count) delivery[s] = count
    }))

    let query = ctx.db
        .from('sms_messages')
        .select('recipient, status, error, status_updated_at')
        .eq('campaign_id', id)
    if (status && MESSAGE_STATUSES.includes(status)) query = query.eq('status', status)

    const { data: rows } = await query
        .order('created_at', { ascending: true })
        .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1)

    const c = campaign as any
    ctx.log(200)
    return apiSuccessV2({
        message_id:      c.id,
        status:          c.status,
        message:         c.message,
        sender:          c.sender_used,
        reference:       c.reference,
        recipients:      c.recipients_count,
        segments:        c.segments,
        credits_charged: c.credits_charged,
        created_at:      c.created_at,
        completed_at:    c.completed_at,
        delivery,
        page,
        page_size:       PAGE_SIZE,
        results: ((rows as any[]) || []).map(r => ({
            recipient:  r.recipient,
            status:     r.status,
            error:      r.error,
            updated_at: r.status_updated_at,
        })),
    })
}
