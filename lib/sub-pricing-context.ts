/**
 * Bounds for a sub-agent pricing their own storefront.
 *
 * A sub prices every product relative to what the level directly above them
 * charges: floor = the upline's retail price, cap = that plus the sub's markup
 * ceiling. Shared by the data, Results Checker and AFA pricing screens so all
 * three agree on who the parent is and how much room there is above them.
 *
 * Data is the one product with a separate wholesale price (shop_pricing.
 * sub_price), which a parent may set above their own retail. There the floor
 * has to follow the sub's real cost instead — see subFloorFor/subCapFor.
 *
 * Deliberately level-agnostic: the upline is read from the caller's own
 * sub_agents row, so a level-2 sub is bounded by their level-1 recruiter
 * exactly as a level-1 sub is bounded by their Lead. Nothing here needs to know
 * how deep the caller sits.
 */

const DEFAULT_CEILING = 5.0

export interface SubPricingContext {
    uplineShopId: string
    /** The sub's own shop. Null until they create one. */
    shopId: string | null
    /** How far above the upline's price this sub may go, in GHS. */
    ceiling: number
}

export interface SubPricingContextError {
    error: string
    status: 403
}

/**
 * Resolves the caller's pricing bounds.
 *
 * @param db A service-role client — sub_agents sits behind RLS.
 */
export async function resolveSubPricingContext(
    db: any,
    userId: string
): Promise<SubPricingContext | SubPricingContextError> {
    const { data: sub } = await db
        .from('sub_agents')
        .select('upline_shop_id, markup_ceiling')
        .eq('user_id', userId)
        .maybeSingle()

    if (!sub) return { error: 'Not a sub-agent', status: 403 }

    const { data: shop } = await db
        .from('shop_profiles')
        .select('id')
        .eq('owner_id', userId)
        .maybeSingle()

    // Ceiling: the sub's own markup_ceiling → the platform default.
    //
    // The default is seeded into shop_global_settings (20260703_sub_agents.sql)
    // but was only ever read from admin_settings — so the lookup always missed
    // and every sub silently got DEFAULT_CEILING no matter what an admin set.
    // Read the table it actually lives in first, keeping admin_settings as a
    // fallback so the more familiar table still has an effect.
    let ceiling = sub.markup_ceiling != null ? Number(sub.markup_ceiling) : NaN
    if (!Number.isFinite(ceiling)) {
        for (const table of ['shop_global_settings', 'admin_settings']) {
            const { data: setting } = await db
                .from(table)
                .select('value')
                .eq('key', 'sub_markup_ceiling_default')
                .maybeSingle()

            const candidate = setting?.value != null ? Number(setting.value) : NaN
            if (Number.isFinite(candidate) && candidate > 0) {
                ceiling = candidate
                break
            }
        }
        if (!Number.isFinite(ceiling)) ceiling = DEFAULT_CEILING
    }

    return { uplineShopId: sub.upline_shop_id, shopId: shop?.id ?? null, ceiling }
}

/** Highest price a sub may charge given their upline's price. */
export function ceilingFor(parentPrice: number, ceiling: number): number {
    return Math.round((parentPrice + ceiling) * 100) / 100
}

const DEFAULT_MIN_SUB_MARGIN = 0.5

const round2 = (value: number) => Math.round(value * 100) / 100

/**
 * The platform's minimum spread between what a level pays and what it charges.
 *
 * Read from shop_global_settings first — that is where 20260703_sub_agents.sql
 * seeds `sub_min_margin` — keeping admin_settings as a fallback so the more
 * familiar table still has an effect.
 */
export async function resolveMinSubMargin(db: any): Promise<number> {
    for (const table of ['shop_global_settings', 'admin_settings']) {
        const { data } = await db
            .from(table)
            .select('value')
            .eq('key', 'sub_min_margin')
            .maybeSingle()

        const candidate = data?.value != null ? Number(data.value) : NaN
        if (Number.isFinite(candidate) && candidate >= 0) return candidate
    }
    return DEFAULT_MIN_SUB_MARGIN
}

/**
 * The lowest price a sub may put on their own storefront, in GHS.
 *
 * Normally a pesewa above the parent's retail price: shop_pricing stores
 * profit_margin = price − that retail price and requires it positive, so
 * matching the parent exactly is not allowed.
 *
 * The exception is a parent who prices their downline ABOVE their own shelf
 * price, which /api/shop/sub-pricing permits — selling to someone who resells
 * is not the same trade as selling to a walk-in customer. Their retail price
 * then sits below what this sub actually pays, and flooring there would force
 * the sub to sell under cost and lose money on every order. So once cost
 * overtakes retail, the floor follows cost plus the minimum margin instead.
 *
 * Only the overtaking case is special-cased. The platform-price cascade
 * (20260825_sub_aware_price_cascade.sql) applies `cost + min_margin`
 * unconditionally, which is stricter — deliberately not matched here, because
 * tightening the floor for every sub whose parent has no wholesale price set
 * would put existing, legal prices out of bounds overnight.
 */
export function subFloorFor(parentRetail: number, subCost: number, minMargin: number): number {
    const justAboveParent = round2(parentRetail + 0.01)
    if (subCost <= parentRetail) return justAboveParent
    return Math.max(justAboveParent, round2(subCost + minMargin))
}

/**
 * The sub's markup room sits above whichever is higher — the parent's retail
 * price or the sub's own cost — so there is always `ceiling` to work with, no
 * matter where the parent set their wholesale price.
 */
export function subCapFor(parentRetail: number, subCost: number, ceiling: number): number {
    return ceilingFor(Math.max(parentRetail, subCost), ceiling)
}
