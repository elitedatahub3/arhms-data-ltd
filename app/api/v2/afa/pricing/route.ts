import { NextRequest } from 'next/server'
import {
    validateApiKey, isApiError, apiSuccessV2, apiError,
    logApiRequest, getClientIp, enforceRateLimit,
} from '@/lib/api-auth'
import { resolveAfaCostPrice } from '@/lib/afa-pricing'
import { VALID_ID_TYPES, VALID_REGIONS, MIN_AFA_AGE, ID_FORMAT_PATTERNS } from '@/lib/afa-validation'

/**
 * What an AFA registration costs this caller, and what a valid application looks like.
 *
 * The register endpoint never accepts a price from the request, so this is the only
 * way for a partner to know what they will be charged — the same role-tiered figure
 * the dashboard resolves. It also returns the allowlists, so an integrator builds
 * their form against the live values rather than hardcoding regions that will later
 * 400 on them.
 */
const ENDPOINT = '/api/v2/afa/pricing'

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

    const { userId, apiKeyId, userRole, supabase } = auth

    const price = await resolveAfaCostPrice(supabase, userRole)

    if (!price.ok) {
        logApiRequest({ apiKeyId, userId, endpoint: ENDPOINT, method: 'GET', statusCode: 503, responseTimeMs: Date.now() - startTime, ip, errorMessage: 'AFA pricing not configured' })
        return apiError(503, price.error)
    }

    logApiRequest({ apiKeyId, userId, endpoint: ENDPOINT, method: 'GET', statusCode: 200, responseTimeMs: Date.now() - startTime, ip })

    return apiSuccessV2({
        price:    price.price,
        currency: 'GHS',
        role:     userRole,
        id_types: VALID_ID_TYPES.map(t => ({
            id_type: t,
            format:  ID_FORMAT_PATTERNS[t].hint,
        })),
        regions:      VALID_REGIONS,
        minimum_age:  MIN_AFA_AGE,
    })
}
