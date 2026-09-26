import SubWholesalePricing from '@/components/shop/sub-wholesale-pricing'

/**
 * A Lead setting what their sub-agents pay.
 *
 * Same screen the sub portal mounts — the floor differs only because the API
 * resolves each caller's own cost.
 */
export default function ShopWholesalePricingPage() {
  return <SubWholesalePricing backHref="/dashboard/shop/sub-agents" />
}
