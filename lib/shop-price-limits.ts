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
