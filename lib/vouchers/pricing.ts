/**
 * Results Checker Voucher – Server-Side Pricing Engine
 *
 * IMPORTANT: Never trust prices from the client. All prices are calculated
 * here on the server using data fetched directly from the database.
 * cost_price is NEVER sent to the browser.
 */

export interface BulkTier {
    min_qty: number
    max_qty: number
    unit_price: number
}

export interface RCType {
    id: string
    name: string
    customer_price: number
    agent_price: number
    dealer_price?: number
    api_price?: number | null   // v2 API only — lib/api-pricing.ts
    cost_price: number          // NEVER expose to client
    is_active: boolean
    display_order: number
    bulk_pricing: BulkTier[]   // [{min_qty, max_qty, unit_price}] — server only has cost guard
}

export interface RCPriceBreakdown {
    unitPrice: number
    isBulk: boolean
    matchedTier: BulkTier | null
    shopMarkup: number
    subtotal: number
    paystackFee: number
    total: number
}

/**
 * Get the base (non-bulk) role price for a type.
 */
export function getBasePrice(type: RCType, userRole: string): number {
    if (userRole === 'dealer' && type.dealer_price && type.dealer_price > 0) {
        return type.dealer_price
    }
    if (userRole === 'agent' && type.agent_price > 0) {
        return type.agent_price
    }
    return type.customer_price
}

/**
 * Find the matching bulk tier for a given quantity.
 * Returns null if no tier matches.
 */
export function findMatchingTier(tiers: BulkTier[], quantity: number): BulkTier | null {
    if (!Array.isArray(tiers) || tiers.length === 0) return null
    return tiers.find(t => quantity >= t.min_qty && quantity <= t.max_qty) ?? null
}

/**
 * Calculate the final price for a Results Checker voucher order.
 *
 * Logic (per spec):
 *   1. Base price from role (agent/dealer/customer)
 *   2. Bulk override: if quantity matches a tier, replace base with tier.unit_price
 *      — floored at cost_price. No proration: all units get the tier rate.
 *   3. Capped shop markup added on top
 *   4. Optional Paystack fee on total
 *
 * Throws if any price falls below the supplier cost price.
 */
export async function calculateRCPrice(params: {
    type: RCType
    quantity: number
    userRole: string
    shopMarkup?: number
    maxShopMarkup?: number
    includePaystackFee?: boolean
    feePercent?: number
}): Promise<RCPriceBreakdown> {
    const {
        type,
        quantity,
        userRole,
        shopMarkup = 0,
        maxShopMarkup = 0,
        includePaystackFee = false,
        feePercent = 1.95
    } = params

    // 1. Resolve role-based base price
    let unitPrice = getBasePrice(type, userRole)

    // 2. Check for a matching bulk tier — replaces base price entirely
    const tiers = Array.isArray(type.bulk_pricing) ? type.bulk_pricing : []
    const matchedTier = findMatchingTier(tiers, quantity)
    const isBulk = matchedTier !== null

    if (matchedTier) {
        // Floor the tier price at cost — never sell below cost
        unitPrice = Math.max(matchedTier.unit_price, type.cost_price)
    }

    // 3. Absolute security guard: price must never drop below supplier cost
    if (unitPrice < type.cost_price) {
        throw new Error('PRICING_ERROR_UNIT_BELOW_COST')
    }

    // 4. Cap markup server-side
    const appliedMarkup = maxShopMarkup > 0
        ? Math.min(shopMarkup, maxShopMarkup)
        : shopMarkup

    const subtotal = parseFloat(((unitPrice + appliedMarkup) * quantity).toFixed(2))

    // 5. Calculate optional gateway processing fee
    let paystackFee = 0
    if (includePaystackFee) {
        paystackFee = parseFloat((subtotal * (feePercent / 100)).toFixed(2))
    }

    return {
        unitPrice,
        isBulk,
        matchedTier,
        shopMarkup: appliedMarkup,
        subtotal,
        paystackFee,
        total: parseFloat((subtotal + paystackFee).toFixed(2)),
    }
}

/**
 * Fetch a single active RC type from the database by ID.
 * Uses service-role client to bypass RLS.
 * Returns the full type including cost_price (server use only).
 */
export async function getRCTypeById(
    supabase: any,
    typeId: string
): Promise<RCType | null> {
    const { data, error } = await (supabase.from('results_checker_types') as any)
        .select('*')
        .eq('id', typeId)
        .eq('is_active', true)
        .single()

    if (error || !data) return null
    return {
        ...data,
        bulk_pricing: Array.isArray(data.bulk_pricing) ? data.bulk_pricing : [],
    } as RCType
}

/**
 * Validate bulk pricing tiers array.
 * Returns an error string if invalid, or null if valid.
 */
export function validateBulkTiers(tiers: BulkTier[], costPrice: number): string | null {
    for (let i = 0; i < tiers.length; i++) {
        const t = tiers[i]
        if (!t.min_qty || t.min_qty < 1) return `Tier ${i + 1}: min_qty must be ≥ 1`
        if (!t.max_qty || t.max_qty < t.min_qty) return `Tier ${i + 1}: max_qty must be ≥ min_qty`
        if (t.unit_price == null || t.unit_price < costPrice) {
            return `Tier ${i + 1}: unit_price (${t.unit_price}) cannot be below cost price (${costPrice})`
        }
    }
    return null
}
