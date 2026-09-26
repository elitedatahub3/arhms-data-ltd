import { NextRequest } from 'next/server'
import {
    validateApiKey, isApiError, apiSuccessV2, apiError,
    logApiRequest, getClientIp, enforceRateLimit,
} from '@/lib/api-auth'
import { describeBillers, billerCatalogSettingKeys } from '@/lib/api-v2-billers'
import { isUtilityVisibleTo, UTILITY_LAUNCH_KEY } from '@/lib/utility-order-intent'

/**
 * The biller catalogue, including billers an admin has switched off.
 *
 * Returning disabled ones is the point: an integrator building a picker needs to
 * know a biller exists in order to grey it out. Omitting it makes their UI silently
 * lose an option and look broken rather than temporarily unavailable.
 *
 * min_amount / max_amount come from here too, so nobody hardcodes GHS 1–1000 and
 * then breaks when an admin moves the ceiling.
 */
const ENDPOINT = '/api/v2/utilities/billers'

export async function GET(request: NextRequest) {
    const startTime = Date.now()
    const ip = getClientIp(request)

    const auth = await validateApiKey(request, { version: 'v2', kind: 'commission' })
    if (isApiError(auth)) {
        logApiRequest({ apiKeyId: null, userId: null, endpoint: ENDPOINT, method: 'GET', statusCode: (auth as any).status, responseTimeMs: Date.now() - startTime, ip, errorMessage: 'Auth failed' })
        return auth
    }

    const limited = await enforceRateLimit(auth, 'billers')
    if (limited) return limited

    const { userId, apiKeyId, userRole, supabase } = auth

    const { data: rows } = await (supabase.from('admin_settings') as any)
        .select('key, value')
        .in('key', [
            ...billerCatalogSettingKeys(),
            UTILITY_LAUNCH_KEY,
            'utility_api_min_amount',
            'utility_api_max_amount',
        ])

    const settings: Record<string, string> = {}
    for (const row of ((rows as any[]) || [])) settings[row.key] = row.value

    // Whole-product gate, distinct from the per-biller `enabled` flag below.
    if (!isUtilityVisibleTo(userRole, settings)) {
        logApiRequest({ apiKeyId, userId, endpoint: ENDPOINT, method: 'GET', statusCode: 503, responseTimeMs: Date.now() - startTime, ip, errorMessage: 'Utilities not launched' })
        return apiError(503, 'Utility bill payments are currently disabled.')
    }

    logApiRequest({ apiKeyId, userId, endpoint: ENDPOINT, method: 'GET', statusCode: 200, responseTimeMs: Date.now() - startTime, ip })

    return apiSuccessV2({
        billers:    describeBillers(settings),
        min_amount: Number(settings['utility_api_min_amount'] ?? 1),
        max_amount: Number(settings['utility_api_max_amount'] ?? 1000),
        currency:   'GHS',
    })
}
