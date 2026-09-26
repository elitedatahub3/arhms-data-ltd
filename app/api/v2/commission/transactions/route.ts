import { NextRequest } from 'next/server'
import {
    validateApiKey, isApiError, apiSuccessV2, apiError,
    logApiRequest, getClientIp, enforceRateLimit,
} from '@/lib/api-auth'

/**
 * The earnings statement: one row per order that paid a commission.
 *
 * Paged rather than unbounded — a busy partner accumulates a row per completed order,
 * and the natural client behaviour of "fetch everything and sum it" would otherwise
 * get slower every day.
 */
const ENDPOINT = '/api/v2/commission/transactions'
const MAX_LIMIT = 100

export async function GET(request: NextRequest) {
    const startTime = Date.now()
    const ip = getClientIp(request)

    const auth = await validateApiKey(request, { version: 'v2', kind: 'commission' })
    if (isApiError(auth)) {
        logApiRequest({ apiKeyId: null, userId: null, endpoint: ENDPOINT, method: 'GET', statusCode: (auth as any).status, responseTimeMs: Date.now() - startTime, ip, errorMessage: 'Auth failed' })
        return auth
    }

    const limited = await enforceRateLimit(auth, 'commission')
    if (limited) return limited

    const { userId, apiKeyId, supabase } = auth
    const { searchParams } = new URL(request.url)

    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10) || 1)
    const requestedLimit = parseInt(searchParams.get('limit') || '30', 10) || 30
    const limit = Math.min(MAX_LIMIT, Math.max(1, requestedLimit))
    const offset = (page - 1) * limit

    const source = searchParams.get('source')
    if (source && !['airtime', 'utility'].includes(source)) {
        return apiError(400, 'source must be "airtime" or "utility"')
    }

    let query = (supabase.from('commission_transactions') as any)
        .select('id, source, order_id, amount, description, reference, created_at', { count: 'exact' })
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1)

    if (source) query = query.eq('source', source)

    const { data: rows, error, count } = await query

    if (error) {
        logApiRequest({ apiKeyId, userId, endpoint: ENDPOINT, method: 'GET', statusCode: 500, responseTimeMs: Date.now() - startTime, ip, errorMessage: error.message })
        return apiError(500, 'Failed to load commission transactions')
    }

    const total = count || 0

    logApiRequest({ apiKeyId, userId, endpoint: ENDPOINT, method: 'GET', statusCode: 200, responseTimeMs: Date.now() - startTime, ip })

    return apiSuccessV2({
        transactions: ((rows as any[]) || []).map((r: any) => ({
            id:          r.id,
            source:      r.source,
            order_id:    r.order_id,
            amount:      Number(r.amount),
            description: r.description,
            reference:   r.reference,
            created_at:  r.created_at,
        })),
        total,
        page,
        limit,
        total_pages: Math.ceil(total / limit),
    })
}
