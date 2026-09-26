import { NextRequest } from 'next/server'
import {
    validateApiKey, isApiError, apiSuccessV2, apiError,
    logApiRequest, getClientIp, enforceRateLimit,
} from '@/lib/api-auth'
import { isUtilityVisibleTo, UTILITY_LAUNCH_KEY } from '@/lib/utility-order-intent'
import { UTILITY_SERVICES } from '@/lib/hubtel-utility-service'
import { queryUtilityAccount } from '@/lib/utility-provider'
import {
    BILLER_KEYS, isBillerKey, serviceForBiller, toLookupPayload, lookupFailureStatus,
} from '@/lib/api-v2-billers'

/**
 * Verify an account before paying it.
 *
 * A smartcard or meter number is a bare string of digits with no check digit, and a
 * mistyped one belongs to somebody else. Integrators are expected to show the
 * returned name — or, for ECG, let the customer pick from `meters` — and get a
 * confirmation before calling /pay.
 *
 * Nothing returned here is trusted on the way back in: /pay re-runs the same query
 * server-side before charging. This exists so the caller can SEE the account, not so
 * the server can learn it.
 */
const ENDPOINT = '/api/v2/utilities/lookup'
const MAX_FIELD = 30

export async function GET(request: NextRequest) {
    const startTime = Date.now()
    const ip = getClientIp(request)

    const auth = await validateApiKey(request, { version: 'v2', kind: 'commission' })
    if (isApiError(auth)) {
        logApiRequest({ apiKeyId: null, userId: null, endpoint: ENDPOINT, method: 'GET', statusCode: (auth as any).status, responseTimeMs: Date.now() - startTime, ip, errorMessage: 'Auth failed' })
        return auth
    }

    // Tight on purpose: every call is a paid round trip to a third party, and
    // scanning it over a range of numbers would enumerate strangers' names.
    const limited = await enforceRateLimit(auth, 'lookup')
    if (limited) return limited

    const { userId, apiKeyId, userRole, supabase } = auth
    const { searchParams } = new URL(request.url)

    const biller = searchParams.get('biller')
    const account = (searchParams.get('account') || '').replace(/\s+/g, '')
    const phone = (searchParams.get('phone') || '').replace(/\s+/g, '')

    if (!isBillerKey(biller)) {
        return apiError(400, `Invalid biller. Must be one of: ${BILLER_KEYS.join(', ')}`)
    }
    if (!account) return apiError(400, 'account is required')
    if (account.length > MAX_FIELD) return apiError(400, `account must be ${MAX_FIELD} characters or fewer`)
    if (phone.length > MAX_FIELD) return apiError(400, `phone must be ${MAX_FIELD} characters or fewer`)

    const service = serviceForBiller(biller)
    const def = UTILITY_SERVICES[service]

    const { data: gateRows } = await (supabase.from('admin_settings') as any)
        .select('key, value')
        .in('key', [UTILITY_LAUNCH_KEY, `utility_enabled_${service}`])

    const settings: Record<string, string> = {}
    for (const row of ((gateRows as any[]) || [])) settings[row.key] = row.value

    // Verifying an account is a call we pay for, so it is gated with the payment.
    if (!isUtilityVisibleTo(userRole, settings)) {
        logApiRequest({ apiKeyId, userId, endpoint: ENDPOINT, method: 'GET', statusCode: 503, responseTimeMs: Date.now() - startTime, ip, errorMessage: 'Utilities not launched' })
        return apiError(503, 'Utility bill payments are currently disabled.')
    }
    if (settings[`utility_enabled_${service}`] === 'false') {
        return apiError(503, `${def.label} is currently disabled.`)
    }

    // ECG queries by phone, not by meter. The contract still requires `account` for
    // every biller, and tells the caller to pass the phone number there as well when
    // they have no meter to hand — so `phone` falls back to `account` rather than
    // rejecting a request that carries the number in the other field.
    const isEcg = def.kind === 'meter-by-phone'
    const resolvedPhone = phone || (isEcg ? account : '')

    if (def.requiresPhone && !/^0\d{9}$/.test(resolvedPhone)) {
        return apiError(400, isEcg
            ? 'A valid Ghana phone number is required for ECG. Pass it as `phone` (or as `account`): 0XXXXXXXXX'
            : 'phone is required for this biller. Use Ghana format: 0XXXXXXXXX')
    }
    if (!isEcg && !def.accountPattern.test(account)) {
        return apiError(400, `Enter a valid ${def.accountLabel}.`)
    }

    const lookup = await queryUtilityAccount({
        service,
        accountNumber: account,
        phone: def.requiresPhone ? resolvedPhone : undefined,
    })

    if (!lookup.success) {
        const status = lookupFailureStatus(lookup)
        logApiRequest({ apiKeyId, userId, endpoint: ENDPOINT, method: 'GET', statusCode: status, responseTimeMs: Date.now() - startTime, ip, errorMessage: lookup.error })
        return apiError(status, status === 502
            ? (lookup.error || 'The billing provider is temporarily unreachable. Retry shortly.')
            : (lookup.error || `That ${def.accountLabel} could not be found.`))
    }

    logApiRequest({ apiKeyId, userId, endpoint: ENDPOINT, method: 'GET', statusCode: 200, responseTimeMs: Date.now() - startTime, ip })

    // session_id is deliberately absent. Ghana Water's is single-use and is spent by
    // the payment, so /pay obtains a fresh one for itself rather than trusting one
    // the caller round-tripped.
    return apiSuccessV2(toLookupPayload(biller, account, lookup))
}
