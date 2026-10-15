/**
 * Authoritative price resolution for a data package purchase.
 *
 * Extracted from app/api/orders/purchase/route.ts so that the wallet path and
 * the direct-pay path (/api/orders/gateway-init) charge exactly the same
 * amount. Never trust a client-supplied price — always resolve here.
 */

import {
    resolveSubAgentContext,
    SUB_INACTIVE_ERROR,
    UPLINE_INELIGIBLE_ERROR,
} from './sub-agents'
import { hasApiPrice, isApiUserRow } from './api-pricing'

export interface ResolvedDataPrice {
    price: number
    role: string
    isSubAgent: boolean
    uplineShopId: string | null
}

export interface ResolveDataPriceResult {
    ok: boolean
    data?: ResolvedDataPrice
    /** Set when ok is false — safe to surface to the client. */
    error?: string
    /** HTTP status to respond with when ok is false. */
    status?: number
}

/**
 * Resolves what `userId` must pay for `pkg`.
 *
 * Sub-agents pay their upline's `sub_price` (and are gated on their own status
 * plus a live evaluation of the upline's eligibility). Everyone else gets
 * role pricing: dealer → agent → base.
 *
 * @param supabase A service-role client (needs to read sub_agents/shop_pricing).
 */
export async function resolveDataPrice(
    supabase: any,
    userId: string,
    pkg: any
): Promise<ResolveDataPriceResult> {
    // Get user role + sub-agent status for price calculation
    const { data: userRoleData } = await supabase
        .from('users')
        // '*' so a database without is_api_user (migration 20261015010000) still works.
        .select('*')
        .eq('id', userId)
        .single()

    const userRole = (userRoleData as any)?.role
    const isAgent = userRole === 'agent'
    const isDealer = userRole === 'dealer'

    // Check if user is a sub-agent. Membership, upline and the upline's live
    // eligibility all come from the shared resolver — see lib/sub-agents.ts.
    const subContext = await resolveSubAgentContext(supabase, userId)

    if (subContext.isSub) {
        const uplineShopId = subContext.uplineShopId

        // Eligibility gate: sub must be active + upline must be eligible
        if (subContext.status !== 'active') {
            return { ok: false, error: SUB_INACTIVE_ERROR, status: 403 }
        }

        if (!subContext.uplineEligible) {
            return { ok: false, error: UPLINE_INELIGIBLE_ERROR, status: 403 }
        }

        // Get sub_price from upline's pricing for this package
        const { data: subPricingData } = await supabase
            .from('shop_pricing')
            .select('sub_price')
            .eq('shop_id', uplineShopId)
            .eq('package_id', pkg.id)
            .single()

        if (!subPricingData || !subPricingData.sub_price) {
            return {
                ok: false,
                error: 'This package is not yet available for sub-agents',
                status: 400,
            }
        }

        return {
            ok: true,
            data: {
                price: subPricingData.sub_price,
                role: userRole || 'customer',
                isSubAgent: true,
                uplineShopId,
            },
        }
    }

    // API users pay the admin-set API price when the package has one — see
    // lib/api-pricing.ts. Otherwise, role-based pricing.
    const price = (isApiUserRow(userRoleData) && hasApiPrice((pkg as any).api_price))
        ? Number((pkg as any).api_price)
        : (isDealer && (pkg as any).dealer_price > 0)
        ? (pkg as any).dealer_price
        : (isAgent && (pkg as any).agent_price > 0)
            ? (pkg as any).agent_price
            : (pkg as any).price

    return {
        ok: true,
        data: {
            price,
            role: userRole || 'customer',
            isSubAgent: false,
            uplineShopId: null,
        },
    }
}
