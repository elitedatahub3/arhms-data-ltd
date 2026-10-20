/**
 * AFA registration pricing.
 *
 * The price is admin-set and role-tiered, held as three rows in `admin_settings`.
 * Three callers resolve it and must agree:
 *   - /api/user/afa-registration  — charges the logged-in user's wallet
 *   - /api/shop/afa-pricing       — the floor a shop owner must sell above
 *   - /api/shop/afa/initialize    — the platform's cut on a storefront sale
 *
 * The client never sends a price; it is always re-derived server-side.
 */

import { MAX_SHOP_PROFIT_GHS } from '@/lib/shop-price-limits'

export const AFA_PRICE_KEYS = [
    'afa_price_customer',
    'afa_price_agent',
    'afa_price_dealer',
] as const

/** Which admin_settings key applies to a given user role. */
export function afaPriceKeyForRole(role: string | null | undefined): string {
    if (role === 'agent') return 'afa_price_agent'
    if (role === 'dealer') return 'afa_price_dealer'
    return 'afa_price_customer'
}

/**
 * Flat result shape rather than a discriminated union: this project builds with
 * `strictNullChecks: false`, under which TypeScript will not narrow a union by
 * its `ok` discriminant, so `result.error` inside `if (!result.ok)` would not
 * type-check. Matches the convention used by the payment services.
 */
export interface AfaPriceResult {
    ok: boolean
    /** Set when ok. */
    price?: number
    /** The admin_settings key the price came from. Set when ok. */
    key?: string
    /** Caller-safe message. Set when not ok. */
    error?: string
}

/**
 * Resolves the AFA price for a role.
 *
 * `db` must be a client that can read `admin_settings` — a service-role client in
 * every current caller, since RLS would otherwise block the read.
 *
 * Fails closed: a missing, non-numeric, or non-positive value is a configuration
 * error, never a silent zero-price registration.
 */
export async function resolveAfaCostPrice(
    db: any,
    role: string | null | undefined
): Promise<AfaPriceResult> {
    const CONFIG_ERROR = 'Registration pricing is not configured. Please contact support.'

    const { data, error } = await db
        .from('admin_settings')
        .select('key, value')
        .in('key', AFA_PRICE_KEYS as unknown as string[])

    if (error) {
        console.error('[AFA Pricing] Failed to fetch pricing settings:', error)
        return { ok: false, error: CONFIG_ERROR }
    }

    const settingsMap: Record<string, string> = {}
    for (const row of (data || []) as any[]) settingsMap[row.key] = row.value

    const key = afaPriceKeyForRole(role)
    const rawPrice = settingsMap[key]

    if (!rawPrice) {
        console.error(`[AFA Pricing] Price key "${key}" not found in admin_settings`)
        return { ok: false, error: CONFIG_ERROR }
    }

    const price = parseFloat(rawPrice)
    if (isNaN(price) || price <= 0) {
        console.error(`[AFA Pricing] Price key "${key}" has invalid value: "${rawPrice}"`)
        return { ok: false, error: CONFIG_ERROR }
    }

    return { ok: true, price, key }
}

/** admin_settings key for the flat price every v2 API caller pays, whatever their role. */
export const AFA_API_PRICE_KEY = 'afa_price_api'

/**
 * Resolves the AFA price for a v2 API caller: the admin-set API price when there is
 * one, otherwise the caller's ordinary role price. See lib/api-pricing.ts.
 */
export async function resolveAfaApiPrice(
    db: any,
    role: string | null | undefined
): Promise<AfaPriceResult> {
    const { data } = await db
        .from('admin_settings')
        .select('value')
        .eq('key', AFA_API_PRICE_KEY)
        .maybeSingle()

    const price = parseFloat((data as any)?.value ?? '')
    if (price > 0) return { ok: true, price, key: AFA_API_PRICE_KEY }

    return resolveAfaCostPrice(db, role)
}

/**
 * Maximum markup a shop owner may add on top of their cost price.
 *
 * Owners price freely above cost; this is only the typo guard shared with data
 * packages (/api/shop/pricing) and results checker vouchers (/api/shop/rc-pricing).
 */
export function maxShopAfaProfit(_ownerRole?: string | null): number {
    return MAX_SHOP_PROFIT_GHS
}
