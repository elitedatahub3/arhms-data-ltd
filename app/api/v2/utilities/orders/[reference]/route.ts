import { NextRequest } from 'next/server'
import {
    validateApiKey, isApiError, apiSuccessV2, apiError,
    logApiRequest, getClientIp, enforceRateLimit,
} from '@/lib/api-auth'
import { billerForService } from '@/lib/api-v2-billers'
import { commissionEarnedFor } from '@/lib/commission-earning'

/**
 * Fulfilment status of one bill payment, by the reference /pay returned.
 *
 * Scoped to the caller's own account: reference_code is table-wide unique and ours to
 * generate, so an unscoped lookup would let anyone holding a commission key read a
 * stranger's bill — including the payer's name and account number.
 */
const ENDPOINT = '/api/v2/utilities/orders/:reference'

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ reference: string }> }
) {
    const startTime = Date.now()
    const ip = getClientIp(request)

    const auth = await validateApiKey(request, { version: 'v2', kind: 'commission' })
    if (isApiError(auth)) {
        logApiRequest({ apiKeyId: null, userId: null, endpoint: ENDPOINT, method: 'GET', statusCode: (auth as any).status, responseTimeMs: Date.now() - startTime, ip, errorMessage: 'Auth failed' })
        return auth
    }

    const limited = await enforceRateLimit(auth, 'orders')
    if (limited) return limited

    const { userId, apiKeyId, supabase } = auth
    const { reference } = await params

    if (!reference || reference.length > 100) {
        return apiError(400, 'Invalid reference')
    }

    const { data: order } = await (supabase.from('utility_orders') as any)
        .select('id, reference_code, status, payment_status, service, account_number, account_name, bill_amount, total_paid, fulfillment_note, created_at, updated_at')
        .eq('reference_code', reference)
        .eq('user_id', userId)
        .maybeSingle()

    if (!order) {
        logApiRequest({ apiKeyId, userId, endpoint: ENDPOINT, method: 'GET', statusCode: 404, responseTimeMs: Date.now() - startTime, ip, errorMessage: 'Order not found' })
        return apiError(404, `No bill payment found with reference: ${reference}`)
    }

    // Read from the ledger rather than a column on the order, so the number shown
    // here and the number actually paid into the wallet cannot drift apart. Null
    // until the order completes and the credit lands.
    const commissionEarned = order.status === 'completed'
        ? await commissionEarnedFor(order.id, supabase)
        : null

    logApiRequest({ apiKeyId, userId, endpoint: ENDPOINT, method: 'GET', statusCode: 200, responseTimeMs: Date.now() - startTime, ip })

    return apiSuccessV2({
        reference:         order.reference_code,
        status:            order.status,
        payment_status:    order.payment_status,
        biller:            billerForService(order.service),
        account_number:    order.account_number,
        account_name:      order.account_name,
        amount:            Number(order.bill_amount),
        commission_earned: commissionEarned,
        note:              order.fulfillment_note ?? null,
        created_at:        order.created_at,
        updated_at:        order.updated_at,
    })
}
