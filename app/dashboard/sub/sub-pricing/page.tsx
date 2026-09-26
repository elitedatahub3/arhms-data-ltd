import SubWholesalePricing from '@/components/shop/sub-wholesale-pricing'

/**
 * A level-1 sub setting what their own recruits pay.
 *
 * Under /dashboard/sub so the de-branded portal chrome wraps it. The floor is
 * what this sub pays their own Lead, resolved through the chain server-side.
 */
export default function SubPortalWholesalePricingPage() {
  return <SubWholesalePricing backHref="/dashboard/sub/sub-agents" />
}
