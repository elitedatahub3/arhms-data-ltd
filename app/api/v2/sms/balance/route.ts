import { NextRequest } from 'next/server'
import { apiSuccessV2 } from '@/lib/api-auth'
import { loadSmsApiContext } from '@/lib/sms/api-context'
import { countSentToday, dailyLimitFor } from '@/lib/sms/platform'

/** SMS credit balance, mode and today's usage. SMS API key only. */
const ENDPOINT = '/api/v2/sms/balance'

export async function GET(request: NextRequest) {
    const ctx = await loadSmsApiContext(request, ENDPOINT, 'sms_read')
    if (ctx instanceof Response) return ctx

    const sentToday = await countSentToday(ctx.db, ctx.account.id)
    const dailyLimit = dailyLimitFor(ctx.mode, ctx.settingsMap)

    ctx.log(200)
    return apiSuccessV2({
        credits:     ctx.account.credits,
        status:      ctx.account.status,
        mode:        ctx.mode,
        sent_today:  sentToday,
        // null when the mode has no daily limit.
        daily_limit: dailyLimit > 0 ? dailyLimit : null,
    })
}
