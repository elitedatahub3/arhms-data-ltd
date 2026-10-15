/**
 * API-user pricing.
 *
 * An admin switches an account on as an API user (users.is_api_user). Only API
 * users can call the developer API, and they pay the admin-set API price for a
 * product — customer, agent and dealer alike — both over the API and on the
 * dashboard (data, results checker, AFA). When a product has no API price (NULL or
 * 0), they pay their ordinary role price: dealer → agent → base.
 *
 * Everyone else never sees these prices. Storefront and sub-agent pricing ignore
 * them.
 */

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

/** True when a users row (read with '*') is switched on as an API user. */
export function isApiUserRow(row: any): boolean {
    return row?.is_api_user === true
}

/**
 * Whether `userId` is an API user. Reads with '*' so a database without the
 * is_api_user column answers false instead of failing the caller's request.
 */
export async function fetchIsApiUser(supabase: any, userId: string): Promise<boolean> {
    const { data } = await supabase.from('users').select('*').eq('id', userId).maybeSingle()
    return isApiUserRow(data)
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

// Results checker: the API price is applied inside calculateRCPrice (apiUser), so
// wallet, direct-pay and v2 purchases share one rule.

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
