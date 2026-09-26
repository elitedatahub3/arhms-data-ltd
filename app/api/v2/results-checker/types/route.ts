import { NextRequest } from 'next/server'
import {
    validateApiKey, isApiError, apiSuccessV2,
    logApiRequest, getClientIp, enforceRateLimit,
} from '@/lib/api-auth'
import { getBasePrice, type RCType, type BulkTier } from '@/lib/vouchers/pricing'

/**
 * Result checker types, priced for this caller, with live stock.
 *
 * The purchase endpoint takes a type_id and never a price, so this is the catalogue
 * a partner builds their picker from — the same role/bulk pricing the dashboard
 * shows. `cost_price` is deliberately not selected: it is what we pay the supplier
 * and has never left the server.
 *
 * Stock is real, not advisory. Vouchers are sold from inventory we already hold, so
 * a type with `available: 0` will fail the purchase rather than back-order.
 */
const ENDPOINT = '/api/v2/results-checker/types'

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

    const { data: types } = await (supabase.from('results_checker_types') as any)
        .select('id, name, customer_price, agent_price, dealer_price, bulk_pricing, is_active, display_order')
        .eq('is_active', true)
        .order('display_order', { ascending: true })

    const priced = await Promise.all(
        ((types as any[]) || []).map(async (type: any) => {
            const { count } = await (supabase.from('results_checker_inventory') as any)
                .select('*', { count: 'exact', head: true })
                .eq('type_id', type.id)
                .eq('status', 'available')

            const tiers: BulkTier[] = Array.isArray(type.bulk_pricing) ? type.bulk_pricing : []

            // getBasePrice reads only the role price fields, so the missing cost_price
            // is immaterial here — but a bulk tier IS floored at cost during checkout,
            // which is why the advertised tier price is the raw tier value and the
            // purchase response returns the unit price actually charged.
            return {
                type_id:    type.id,
                name:       type.name,
                unit_price: getBasePrice({ ...type, cost_price: 0 } as RCType, userRole),
                currency:   'GHS',
                bulk_tiers: tiers.map(t => ({
                    min_qty:    t.min_qty,
                    max_qty:    t.max_qty,
                    unit_price: t.unit_price,
                })),
                available:  count || 0,
            }
        })
    )

    logApiRequest({ apiKeyId, userId, endpoint: ENDPOINT, method: 'GET', statusCode: 200, responseTimeMs: Date.now() - startTime, ip })

    return apiSuccessV2({ role: userRole, types: priced })
}
