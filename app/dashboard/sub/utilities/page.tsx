import ShopUtilityPricing from '@/components/shop/utility-pricing'

/**
 * A sub-agent setting their own margin on utility bills.
 *
 * Their ceiling is tighter than their Lead's by exactly what the Lead takes,
 * because the 5% cap is on the total a customer pays, not per level.
 */
export default function SubUtilityPricingPage() {
  return <ShopUtilityPricing backHref="/dashboard/sub" />
}
