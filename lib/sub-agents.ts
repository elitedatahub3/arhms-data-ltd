/**
 * Sub-agent membership context — the one place that answers "is this user a
 * sub, and may they trade right now?".
 *
 * Every sub gate needs the same three facts: the membership row, who the upline
 * is, and whether that upline is *still* eligible to run a network. Eligibility
 * is evaluated live at every gate (never cached) so a Lead who is shut down
 * stops backing their subs the moment it happens.
 *
 * Eligibility is the Lead's *shop* standing — approved and active — not their
 * user role. The original rule was canOwnSubNetwork() (lifetime agent or paid
 * dealer), but a Lead is made by getting a shop approved, not by buying a
 * subscription: in production essentially every live Lead is role 'customer',
 * so that rule failed for all of them and blocked their subs' wallet purchases.
 * Every other sub gate (AFA, RC, USSD, the sub's own storefront) had already
 * stopped consulting it for that reason; this is the last one to line up. A
 * Lead whose role does clear canOwnSubNetwork() still passes, so an approved
 * shop is a floor and never a demotion.
 *
 * Since the network runs three levels deep (Lead → sub → sub-of-sub), the
 * context also carries the whole ancestor `chain`. Splitting an order's profit
 * needs every level above the seller, not just the nearest one: a level-2 sale
 * owes its direct upline *and* the root Lead. The singular `upline*` fields
 * still describe the direct upline, so callers that only care about one hop are
 * unaffected.
 */

import { canOwnSubNetwork } from './pricing/cost-basis'

/** One level above the user, as resolved by walking `upline_shop_id`. */
export interface SubAgentAncestor {
    shopId: string
    ownerId: string
    /** This ancestor's own depth: 0 for a Lead, 1 for a sub of a Lead. */
    depth: number
    /** True when this ancestor is themselves someone's sub. */
    isSub: boolean
}

export interface SubAgentContext {
    isSub: boolean
    /** 'pending' | 'active' | 'suspended' — null when the user is not a sub. */
    status: string | null
    /** 1 = sub of a Lead, 2 = sub of a sub. Null when the user is not a sub. */
    depth: number | null
    uplineShopId: string | null
    uplineOwnerId: string | null
    /** Live evaluation of the upline's right to own a sub-network. */
    uplineEligible: boolean
    /** Ancestors nearest-first: [direct upline, their upline]. Empty if not a sub. */
    chain: SubAgentAncestor[]
}

const NOT_A_SUB: SubAgentContext = {
    isSub: false,
    status: null,
    depth: null,
    uplineShopId: null,
    uplineOwnerId: null,
    uplineEligible: false,
    chain: [],
}

/**
 * Depth is capped at 2, so a seller has at most two ancestors. The extra hops
 * are slack: if bad data ever produced a cycle, the walk still terminates.
 */
const MAX_CHAIN_HOPS = 4

/** Wording reused by every gate so a blocked sub always reads the same message. */
export const SUB_INACTIVE_ERROR = 'Your sub-agent account is not active'
export const UPLINE_INELIGIBLE_ERROR =
    'Your upline Lead’s shop is not active right now. Please contact support.'
export const DEPTH_LIMIT_ERROR =
    'Your network is already at its maximum depth, so you cannot recruit sub-agents.'

/**
 * Walks the upline chain from `userId`, nearest ancestor first.
 *
 * Returns an empty array when the user is not a sub. Stops at the first
 * ancestor who is not themselves a sub — that is the root Lead.
 *
 * @param db A service-role client — sub_agents sits behind RLS an ordinary
 *           caller cannot read past their own row.
 */
export async function resolveSubAgentChain(
    db: any,
    userId: string
): Promise<SubAgentAncestor[]> {
    const chain: SubAgentAncestor[] = []
    if (!userId) return chain

    let cursorUserId: string | null = userId
    const seen = new Set<string>([userId])

    for (let hop = 0; hop < MAX_CHAIN_HOPS && cursorUserId; hop++) {
        const { data: membership } = await db
            .from('sub_agents')
            .select('upline_shop_id')
            .eq('user_id', cursorUserId)
            .maybeSingle()

        const uplineShopId = (membership as any)?.upline_shop_id || null
        if (!uplineShopId) break

        const { data: uplineShop } = await db
            .from('shop_profiles')
            .select('owner_id')
            .eq('id', uplineShopId)
            .maybeSingle()

        const ownerId = (uplineShop as any)?.owner_id || null
        if (!ownerId || seen.has(ownerId)) break
        seen.add(ownerId)

        // Is this ancestor themselves a sub? That decides both their own depth
        // and whether the walk continues.
        const { data: uplineMembership } = await db
            .from('sub_agents')
            .select('id')
            .eq('user_id', ownerId)
            .maybeSingle()

        const isSub = !!uplineMembership

        chain.push({ shopId: uplineShopId, ownerId, depth: isSub ? 1 : 0, isSub })

        if (!isSub) break
        cursorUserId = ownerId
    }

    return chain
}

/**
 * Is the upline still fit to back a sub-network?
 *
 * True while their shop is approved and switched on — that is what makes
 * someone a Lead in the first place. A role that clears canOwnSubNetwork()
 * (lifetime agent, or a dealer whose subscription is live) also passes, so a
 * Lead who bought standing is never blocked by a missing shop row.
 */
async function isUplineEligible(
    db: any,
    uplineShopId: string | null,
    uplineOwnerId: string | null
): Promise<boolean> {
    if (!uplineOwnerId) return false

    if (uplineShopId) {
        const { data: shop } = await db
            .from('shop_profiles')
            .select('approval_status, is_active')
            .eq('id', uplineShopId)
            .maybeSingle()

        const approved = (shop as any)?.approval_status === 'approved'
        if (approved && (shop as any)?.is_active !== false) return true
    }

    const { data: uplineUser } = await db
        .from('users')
        .select('role, agent_expires_at, dealer_expires_at')
        .eq('id', uplineOwnerId)
        .maybeSingle()

    if (!uplineUser) return false

    return canOwnSubNetwork({
        role: (uplineUser as any).role,
        agentExpiresAt: (uplineUser as any).agent_expires_at ?? null,
        dealerExpiresAt: (uplineUser as any).dealer_expires_at ?? null,
    })
}

/**
 * Resolves the sub-agent context for `userId`.
 *
 * @param db A service-role client — sub_agents and the upline's users row are
 *           both behind RLS that an ordinary caller cannot read.
 */
export async function resolveSubAgentContext(
    db: any,
    userId: string
): Promise<SubAgentContext> {
    if (!userId) return NOT_A_SUB

    // `depth` arrived with migrations/20260825_sub_agent_level_3.sql. If the code
    // reaches production first, naming a column the DB does not have fails the
    // whole select — and a null result here reads as "not a sub", which would
    // quietly strip every sub of their portal AND skip the profit split, paying
    // the seller everything and their uplines nothing. So ask for it, and fall
    // back to the columns that have always existed.
    let { data: sub } = await db
        .from('sub_agents')
        .select('status, upline_shop_id, depth')
        .eq('user_id', userId)
        .maybeSingle()

    if (!sub) {
        const fallback = await db
            .from('sub_agents')
            .select('status, upline_shop_id')
            .eq('user_id', userId)
            .maybeSingle()
        sub = fallback.data
    }

    if (!sub) return NOT_A_SUB

    const uplineShopId = sub.upline_shop_id || null
    const chain = await resolveSubAgentChain(db, userId)
    const directUpline = chain[0] ?? null
    const uplineOwnerId = directUpline?.ownerId ?? null

    const uplineEligible = await isUplineEligible(
        db,
        directUpline?.shopId ?? uplineShopId,
        uplineOwnerId
    )

    return {
        isSub: true,
        status: sub.status || null,
        // `depth` is maintained by the enforce_sub_agent_depth() trigger. Fall
        // back to the walked chain so a DB that predates the column still
        // reports a sensible level rather than null.
        depth: (sub as any).depth ?? (chain.length || 1),
        uplineShopId,
        uplineOwnerId,
        uplineEligible,
        chain,
    }
}

/**
 * May this user recruit sub-agents of their own?
 *
 * A Lead always may. A sub may only while they are active and still have room
 * below the depth cap — a level-2 sub is the bottom of the network.
 */
export function canRecruit(context: SubAgentContext): boolean {
    if (!context.isSub) return true
    if (context.status !== 'active') return false
    return (context.depth ?? 1) < 2
}
