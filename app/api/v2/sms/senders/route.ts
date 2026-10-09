import { NextRequest } from 'next/server'
import { apiSuccessV2 } from '@/lib/api-auth'
import { loadSmsApiContext } from '@/lib/sms/api-context'
import { getAllowedSenders } from '@/lib/sms/customer-sms'

/** Sender IDs this key may send under. SMS API key only. */
const ENDPOINT = '/api/v2/sms/senders'

export async function GET(request: NextRequest) {
    const ctx = await loadSmsApiContext(request, ENDPOINT, 'sms_read')
    if (ctx instanceof Response) return ctx

    const senders = ctx.account.status === 'active' ? await getAllowedSenders(ctx.db, ctx.account.id) : []

    ctx.log(200)
    return apiSuccessV2({
        senders: senders.map(s => ({ sender: s.sender, type: s.type, is_default: s.isDefault })),
    })
}
