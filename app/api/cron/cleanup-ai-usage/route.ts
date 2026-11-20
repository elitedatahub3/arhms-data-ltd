import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { areCronJobsEnabled, cronDisabledResponse } from '@/lib/cron-control'

/**
 * Daily clean-up for ARHMS AI usage logs (cron-job.org, apex URL only:
 * https://arhmsgh.com/api/cron/cleanup-ai-usage, header Authorization: Bearer CRON_SECRET).
 *
 * The hourly/daily/monthly limits reset by themselves (they count rows inside clock
 * windows); this job only keeps the log tables small so those counts stay fast.
 *
 * Deletes:
 *   - ai_shop_questions older than 62 days (limits need at most the current month;
 *     62 days keeps last month for the owner's usage card)
 *   - resolved ai_unanswered rows older than 90 days
 * Keeps: ai_chat_messages (conversation history, usage cards) and ai_usage_purchases
 * (payment records).
 *
 * Deletes in batches so a big backlog can't time out; the next run continues.
 */
const BATCH = 5000
const MAX_BATCHES = 10

async function deleteOld(db: any, table: string, cutoffIso: string, extra?: (q: any) => any): Promise<number> {
    let total = 0
    for (let i = 0; i < MAX_BATCHES; i++) {
        let sel = db.from(table).select('id').lt('created_at', cutoffIso).limit(BATCH)
        if (extra) sel = extra(sel)
        const { data: rows, error: selError } = await sel
        if (selError) throw new Error(`${table}: ${selError.message}`)
        const ids = (rows || []).map((r: any) => r.id)
        if (!ids.length) break
        const { error: delError } = await db.from(table).delete().in('id', ids)
        if (delError) throw new Error(`${table}: ${delError.message}`)
        total += ids.length
        if (ids.length < BATCH) break
    }
    return total
}

export async function GET(request: NextRequest) {
    if (!areCronJobsEnabled()) return cronDisabledResponse()

    const authHeader = request.headers.get('authorization')
    if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const db = createServerClient() as any
    const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString()

    try {
        const shopQuestions = await deleteOld(db, 'ai_shop_questions', daysAgo(62))
        const unanswered = await deleteOld(db, 'ai_unanswered', daysAgo(90), q => q.eq('resolved', true))
        console.log(`[cleanup-ai-usage] deleted ${shopQuestions} shop questions, ${unanswered} resolved unanswered`)
        return NextResponse.json({ success: true, deleted: { ai_shop_questions: shopQuestions, ai_unanswered: unanswered } })
    } catch (err: any) {
        console.error('[cleanup-ai-usage] failed', err?.message || err)
        return NextResponse.json({ success: false, error: 'Clean-up failed' }, { status: 500 })
    }
}
