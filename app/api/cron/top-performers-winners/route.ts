import { NextRequest, NextResponse } from 'next/server'
import { areCronJobsEnabled, cronDisabledResponse } from '@/lib/cron-control'
import { parseMonthParam, previousMonthKey, readTopPerformersConfig } from '@/lib/top-performers'
import { finalizeMonth, sendPendingWinnerSms } from '@/lib/top-performers-winners'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * Freezes last month's Top Performers and texts the winners to contact the admin.
 *
 * Schedule daily (cron-job.org, 00:30 UTC, non-www URL). Only the first run of a
 * month does real work; the rest find the month frozen and every SMS sent, so a
 * missed day heals itself the next morning.
 *
 *   ?dry=1          — show who would win and the SMS text, write and send nothing
 *   ?month=YYYY-MM  — target another closed month (testing only)
 *
 * Does nothing while the feature is switched off at /admin/top-performers.
 */
export async function GET(request: NextRequest) {
    const authHeader = request.headers.get('authorization')
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    if (!areCronJobsEnabled()) return cronDisabledResponse()

    const config = await readTopPerformersConfig()
    if (!config.enabled) return NextResponse.json({ skipped: 'Top Performers is switched off' })

    const params = request.nextUrl.searchParams
    const dry = params.get('dry') === '1'
    const lastMonth = previousMonthKey()
    const month = parseMonthParam(params.get('month')) ?? lastMonth
    if (month > lastMonth) {
        return NextResponse.json({ error: 'Only a closed month can be finalised' }, { status: 400 })
    }

    try {
        const finalized = await finalizeMonth(month, config, { dry })
        if (dry) return NextResponse.json({ dry: true, rankingsOnly: config.rankingsOnly, ...finalized })

        const sms = await sendPendingWinnerSms(month, config)
        return NextResponse.json({
            ...finalized,
            rankingsOnly: config.rankingsOnly,
            smsSent: sms.filter(s => s.sent).length,
            smsFailed: sms.filter(s => !s.sent),
        })
    } catch (error: any) {
        console.error('[Cron TopPerformers] Failed:', error?.message || error)
        return NextResponse.json({ error: error?.message || 'Failed' }, { status: 500 })
    }
}
