import { NextRequest } from 'next/server'
import {
    validateApiKey, isApiError, apiSuccessV2,
    logApiRequest, getClientIp, enforceRateLimit,
} from '@/lib/api-auth'

/**
 * Commission earnings to date. Distinct from /api/v2/wallet/balance, which is the
 * spending balance orders are charged against.
 *
 * A partner who has not earned yet has no wallet row at all — the row is created
 * lazily by credit_commission_wallet_balance on the first earning — so a missing row
 * is reported as a zero balance rather than a 404.
 */
const ENDPOINT = '/api/v2/commission/balance'

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

    const { data: wallet } = await (supabase.from('commission_wallets') as any)
        .select('balance, total_earned, total_withdrawn')
        .eq('owner_id', userId)
        .maybeSingle()

    logApiRequest({ apiKeyId, userId, endpoint: ENDPOINT, method: 'GET', statusCode: 200, responseTimeMs: Date.now() - startTime, ip })

    return apiSuccessV2({
        balance:         Number((wallet as any)?.balance ?? 0),
        total_earned:    Number((wallet as any)?.total_earned ?? 0),
        total_withdrawn: Number((wallet as any)?.total_withdrawn ?? 0),
        currency:        'GHS',
    })
}
