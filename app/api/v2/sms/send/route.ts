import { NextRequest } from 'next/server'
import { apiError, apiSuccessV2 } from '@/lib/api-auth'
import { loadSmsApiContext } from '@/lib/sms/api-context'
import { sendCampaign } from '@/lib/sms/send-campaign'

/**
 * Send an SMS to one or many numbers. SMS API key only.
 *
 * body: {
 *   message:    string,                 // 3–1000 characters
 *   recipients: string[] | string,      // Ghana numbers; a string may be comma/space separated
 *   sender?:    string,                 // an approved sender ID; defaults to your default
 *   reference?: string,                 // idempotency key — a retry returns the original send
 * }
 *
 * Charged in credits: segments × recipients, taken up front and refunded per
 * message the network rejects.
 */
const ENDPOINT = '/api/v2/sms/send'

export async function POST(request: NextRequest) {
    const ctx = await loadSmsApiContext(request, ENDPOINT, 'sms_send')
    if (ctx instanceof Response) return ctx

    let body: any
    try { body = await request.json() } catch {
        ctx.log(400, 'Invalid JSON')
        return apiError(400, 'Request body must be JSON')
    }

    const result = await sendCampaign({
        db: ctx.db,
        account: ctx.account,
        mode: ctx.mode,
        settingsMap: ctx.settingsMap,
        shopId: ctx.shopId,
        source: 'api',
        message: body?.message,
        sender: body?.sender,
        recipients: body?.recipients,
        reference: body?.reference,
    })

    if (result.ok === false) {
        ctx.log(result.status, result.error)
        return apiError(result.status, result.error)
    }

    const d = result.data
    ctx.log(200)
    return apiSuccessV2({
        message_id:      d.campaignId,
        status:          d.status,
        duplicate:       !!d.duplicate,
        recipients:      d.recipients,
        segments:        d.segments,
        credits_charged: d.creditsCharged,
        sender:          d.sender,
        sent:            d.sent ?? null,
        failed:          d.failed ?? null,
        invalid:         d.invalid ?? [],
        opted_out:       d.optedOut ?? 0,
        balance:         d.balance ?? null,
    })
}
