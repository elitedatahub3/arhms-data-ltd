/**
 * Developer API (v2) pricing.
 *
 * The admin can set an API price per product. When set, EVERY API caller pays it —
 * customer, agent and dealer alike; the caller's role is ignored. When it is not set
 * (NULL or 0), the caller pays their ordinary role price, the same tiers the
 * dashboard uses: dealer → agent → base.
 *
 * Only the /api/v2 routes read these columns. Dashboard and storefront pricing never
 * see them.
 */

import { findMatchingTier, type BulkTier } from '@/lib/vouchers/pricing'

export interface ApiPricingContext {
    userRole: string
    isActiveAgent: boolean
    isActiveDealer: boolean
}

/**
 * Role and subscription state, fetched once per request.
 *
 * A lapsed agent or dealer falls back to base price, so the API never charges a
 * tier the caller has stopped paying for.
 */
export async function loadApiPricingContext(
    supabase: any,
    userId: string,
    userRole: string
): Promise<ApiPricingContext> {
    const { data } = await supabase
        .from('users')
        .select('agent_expires_at, dealer_expires_at')
        .eq('id', userId)
        .single()

    const now = new Date()
    const lapsed = (at: string | null | undefined) => !!at && new Date(at) < now

    return {
        userRole,
        isActiveAgent:  userRole === 'agent' && !lapsed((data as any)?.agent_expires_at),
        isActiveDealer: userRole === 'dealer' && !lapsed((data as any)?.dealer_expires_at),
    }
}

export function hasApiPrice(value: unknown): boolean {
    return Number(value) > 0
}

/**
 * What an API caller pays for a data package.
 *
 * Callers select data_packages with '*' rather than naming api_price, so the API
 * keeps working (at role prices) on a database the migration has not reached yet —
 * naming a missing column makes PostgREST fail the whole query.
 */
export function resolveApiDataPrice(pkg: any, ctx: ApiPricingContext): number {
    if (hasApiPrice(pkg.api_price)) return Number(pkg.api_price)
    if (ctx.isActiveDealer && pkg.dealer_price > 0) return pkg.dealer_price
    if (ctx.isActiveAgent && pkg.agent_price > 0) return pkg.agent_price
    return pkg.price
}

/**
 * Fixed unit price for a results-checker API purchase, or null to fall back to the
 * ordinary role/bulk pricing.
 *
 * A bulk tier still applies when it is cheaper than the API price, so a partner
 * buying in volume keeps the volume discount. Tier prices are floored at cost, the
 * same as calculateRCPrice does.
 */
export function resolveApiRcUnitPrice(
    type: { api_price?: number | null; cost_price?: number; bulk_pricing?: BulkTier[] | null },
    quantity: number
): number | null {
    if (!hasApiPrice(type.api_price)) return null
    const apiPrice = Number(type.api_price)

    const tiers = Array.isArray(type.bulk_pricing) ? type.bulk_pricing : []
    const tier = findMatchingTier(tiers, quantity)
    if (tier) {
        const tierPrice = Math.max(tier.unit_price, type.cost_price ?? 0)
        if (tierPrice < apiPrice) return tierPrice
    }
    return apiPrice
}

/** admin_settings key holding the API airtime fee % for a network (mtn, telecel, at). */
export function airtimeApiFeeKey(networkKey: string): string {
    return `airtime_fee_${networkKey}_api`
}

/**
 * Parses an admin_settings fee value. Blank or missing means "not set" and returns
 * null so the caller falls back; 0 is a legitimate fee.
 */
export function parseApiFeeRate(raw: string | null | undefined): number | null {
    if (raw === null || raw === undefined || String(raw).trim() === '') return null
    const n = Number(raw)
    return Number.isFinite(n) && n >= 0 && n < 100 ? n : null
}
