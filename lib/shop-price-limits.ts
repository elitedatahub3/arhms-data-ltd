/**
 * Shop owners price their own data packages, Results Checker vouchers and AFA
 * registrations freely — the only floor is that they must sell above cost.
 *
 * This is a sanity limit, not a business rule: it only exists to catch a typo
 * (50000 for 5) before it goes live on a storefront. It is mirrored by the
 * shop_pricing.check_profit_margin_range constraint and the price cascade in
 * 20261016000000_shop_pricing_uncapped.sql — change all three together.
 */
export const MAX_SHOP_PROFIT_GHS = 1000

type PackageCosts = {
    price: number | string | null
    agent_price?: number | string | null
    dealer_price?: number | string | null
}

/**
 * What a shop owner pays for a data package — the base their profit sits on.
 *
 * Shared by the pricing save, checkout and settlement (lib/shop-order-processor.ts),
 * and mirrored by the price cascade in 20261016000000_shop_pricing_uncapped.sql:
 * a role price applies only when it is set above zero, otherwise the base price.
 *
 * Deliberately not lib/pricing/cost-basis.ts resolveOwnerCost(), which also
 * weighs role expiry. Settlement is what pays the owner and it reads the role
 * alone; pricing against a different cost than settlement would let a shelf
 * price pass here and then be refused after the customer paid.
 */
export function ownerCostPrice(pkg: PackageCosts, ownerRole: string | null | undefined): number {
    const dealer = Number(pkg.dealer_price)
    const agent = Number(pkg.agent_price)
    if (ownerRole === 'dealer' && dealer > 0) return dealer
    if (ownerRole === 'agent' && agent > 0) return agent
    return Number(pkg.price) || 0
}
