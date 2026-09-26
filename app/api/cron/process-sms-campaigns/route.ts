import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { areCronJobsEnabled, cronDisabledResponse, validateCronSecret } from '@/lib/cron-control'
import { dispatchCampaignBatch, settleCampaignIfDone } from '@/lib/sms/customer-sms'

/**
 * Drains queued Customer SMS campaigns — the sends too large to dispatch inside
 * the request that created them.
 *
 * Scheduled on cron-job.org, not Vercel. Register it against the apex domain
 * (https://arhmsgh.com/api/cron/process-sms-campaigns), never www: the www host
 * 307-redirects cross-host and the redirect drops the Authorization header, so
 * the job would report green while every run is a 401.
 *
 * Budgeted per tick so a single run stays well inside the function timeout;
 * a big campaign simply takes several ticks.
 */

const MESSAGES_PER_TICK = 500
const MAX_RUNTIME_MS = 45_000

const supabaseAdmin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
)

export async function GET(request: NextRequest) {
    if (!areCronJobsEnabled()) return cronDisabledResponse()

    validateCronSecret()
    const authHeader = request.headers.get('authorization')
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const startedAt = Date.now()
    let budget = MESSAGES_PER_TICK
    const results = { campaigns: 0, sent: 0, failed: 0, settled: 0 }

    // Oldest first, so an early big send is not starved by later small ones.
    // 'processing' is included: a campaign spanning ticks stays in it, and the
    // per-message claim in dispatchCampaignBatch is what stops double-sending.
    const { data: campaigns, error } = await supabaseAdmin
        .from('sms_campaigns')
        .select('id, status')
        .in('status', ['queued', 'processing'])
        .or(`scheduled_at.is.null,scheduled_at.lte.${new Date().toISOString()}`)
        .order('created_at', { ascending: true })
        .limit(10)

    if (error) {
        console.error('[CronSmsCampaigns] query failed:', error)
        return NextResponse.json({ error: error.message }, { status: 500 })
    }

    for (const campaign of campaigns || []) {
        if (budget <= 0 || Date.now() - startedAt > MAX_RUNTIME_MS) break

        if (campaign.status === 'queued') {
            await supabaseAdmin.from('sms_campaigns').update({ status: 'processing' }).eq('id', campaign.id).eq('status', 'queued')
        }

        const batch = await dispatchCampaignBatch(supabaseAdmin, campaign.id, budget)
        budget -= batch.sent + batch.failed
        results.campaigns++
        results.sent += batch.sent
        results.failed += batch.failed

        if (await settleCampaignIfDone(supabaseAdmin, campaign.id)) results.settled++
    }

    return NextResponse.json({ success: true, ...results, elapsedMs: Date.now() - startedAt })
}
