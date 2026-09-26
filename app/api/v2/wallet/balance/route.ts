import { NextRequest } from 'next/server'
import {
    validateApiKey, isApiError, apiSuccessV2, apiError,
    logApiRequest, getClientIp, enforceRateLimit,
} from '@/lib/api-auth'

/**
 * Spending balance — the wallet orders are charged against.
 *
 * Standard key only, like every endpoint outside /api/v2/utilities/*. A commission
 * partner's bills are debited from this same wallet, but they read its balance
 * through the dashboard rather than here; their API surface is the four documented
 * Commission Services endpoints plus /api/v2/commission/*.
 */
const ENDPOINT = '/api/v2/wallet/balance'

export async function GET(request: NextRequest) {
    const startTime = Date.now()
    const ip = getClientIp(request)

    const auth = await validateApiKey(request, { version: 'v2', kind: 'standard' })
    if (isApiError(auth)) {
        logApiRequest({ apiKeyId: null, userId: null, endpoint: ENDPOINT, method: 'GET', statusCode: (auth as any).status, responseTimeMs: Date.now() - startTime, ip, errorMessage: 'Auth failed' })
        return auth
    }

    const limited = await enforceRateLimit(auth, 'balance')
    if (limited) return limited

    const { userId, apiKeyId, supabase } = auth

    const { data: wallet, error } = await (supabase.from('wallets') as any)
        .select('balance, total_spent')
        .eq('user_id', userId)
        .single()

    if (error || !wallet) {
        logApiRequest({ apiKeyId, userId, endpoint: ENDPOINT, method: 'GET', statusCode: 404, responseTimeMs: Date.now() - startTime, ip, errorMessage: 'Wallet not found' })
        return apiError(404, 'Wallet not found')
    }

    logApiRequest({ apiKeyId, userId, endpoint: ENDPOINT, method: 'GET', statusCode: 200, responseTimeMs: Date.now() - startTime, ip })

    return apiSuccessV2({
        balance:     (wallet as any).balance,
        total_spent: (wallet as any).total_spent,
        currency:    'GHS',
    })
}
