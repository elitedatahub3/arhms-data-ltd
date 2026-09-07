import ShopUtilityPricing from '@/components/shop/utility-pricing'

/**
 * A shop owner setting their margin on utility bills.
 *
 * Same screen the sub portal mounts — the ceiling differs by caller because
 * /api/shop/utility-pricing resolves each shop's own upline before answering.
 */
export default function ShopUtilityPricingPage() {
  return <ShopUtilityPricing backHref="/dashboard/shop" />
}
