import SubAgentsManager from '@/components/shop/sub-agents-manager'

/**
 * A level-1 sub recruiting their own sub-agents.
 *
 * Lives under /dashboard/sub so the de-branded portal shell wraps it — mounting
 * it under /dashboard/shop would render the Lead-branded chrome for a user the
 * layout already treats as a sub.
 *
 * A level-2 sub cannot recruit: the nav entry is hidden for them and
 * /api/shop/invites refuses, so the page has nothing to offer but also nothing
 * to break.
 */
export default function SubPortalSubAgentsPage() {
  return <SubAgentsManager pricingHref="/dashboard/sub/sub-pricing" />
}
