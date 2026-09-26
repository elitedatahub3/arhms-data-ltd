/**
 * Cost and profit along the reseller chain.
 *
 * The network is three levels deep — Lead (L0) → sub (L1) → sub-of-sub (L2) —
 * and every level keeps the spread it adds. The rule that makes that work
 * generalises the two-level one rather than replacing it:
 *
 *   a level's cost is its upline's wholesale price if it has an upline,
 *   otherwise its platform role price.
 *
 * At one level of downline this reduces exactly to the old behaviour, so
 * existing Lead → sub chains split as they always did.
 *
 * Getting this wrong is expensive and silent: pricing the direct upline at
 * their *platform role* price, as the two-level code did, pays a level-1 sub
 * the entire chain margin and the root Lead nothing at all.
 */

import { resolveOwnerCost, type PricingTiers } from './cost-basis'
import type { SubAgentAncestor } from '../sub-agents'

export interface ChainLevel extends SubAgentAncestor {
    /** What this level charges the level below it. Null when they price nothing. */
    wholesale: number | null
    /** What this level pays: their upline's wholesale, or the platform price at the root. */
    cost: number | null
}

export interface ChainSplit {
    /** The seller's own margin. */
    sellerProfit: number
    /** What the seller pays — their direct upline's wholesale price. */
    sellerCost: number
    /** One entry per ancestor, aligned with the chain, nearest upline first. */
    ancestorProfits: number[]
    /** Seller price minus the root's platform cost — the whole chain's margin. */
    totalMargin: number
}

const toPesewaPrecision = (value: number) => Math.round(value * 100) / 100

const asFiniteNumber = (value: unknown): number | null => {
    if (value === null || value === undefined) return null
    const parsed = typeof value === 'number' ? value : parseFloat(String(value))
    return Number.isFinite(parsed) ? parsed : null
}

/**
 * Resolves what every level in `chain` pays and charges for one package.
 *
 * @param db      A service-role client — shop_pricing and users both sit behind RLS.
 * @param chain   Ancestors nearest-first, from resolveSubAgentChain().
 * @param pricing The platform's tier prices for this package.
 */
export async function resolveChainCosts(
    db: any,
    chain: SubAgentAncestor[],
    packageId: string,
    pricing: PricingTiers
): Promise<ChainLevel[]> {
    if (chain.length === 0) return []

    const [{ data: priceRows }, { data: ownerRows }] = await Promise.all([
        db
            .from('shop_pricing')
            .select('shop_id, selling_price, sub_price')
            .in('shop_id', chain.map((a) => a.shopId))
            .eq('package_id', packageId),
        db
            .from('users')
            .select('id, role, agent_expires_at, dealer_expires_at')
            .in('id', chain.map((a) => a.ownerId)),
    ])

    const priceByShop = new Map<string, any>(
        (priceRows || []).map((row: any) => [row.shop_id, row])
    )
    const ownerById = new Map<string, any>(
        (ownerRows || []).map((row: any) => [row.id, row])
    )

    // sub_price is the explicit wholesale price once a level sets one; until
    // then their retail price stands in, which is what the two-level split has
    // always done.
    const levels: ChainLevel[] = chain.map((ancestor) => {
        const row = priceByShop.get(ancestor.shopId)
        return {
            ...ancestor,
            wholesale: asFiniteNumber(row?.sub_price ?? row?.selling_price),
            cost: null,
        }
    })

    // Cost flows down from the root: each level pays the wholesale of the level
    // above it, and the root pays the platform.
    levels.forEach((level, index) => {
        const above = levels[index + 1]
        if (above) {
            level.cost = above.wholesale
            return
        }

        const owner = ownerById.get(level.ownerId)
        level.cost = resolveOwnerCost(pricing, {
            role: owner?.role || 'customer',
            agentExpiresAt: owner?.agent_expires_at ?? null,
            dealerExpiresAt: owner?.dealer_expires_at ?? null,
        })
    })

    return levels
}

/**
 * Divides `sellingPrice` into one leg per level.
 *
 * Each boundary is clamped to the one above it, so no leg can go negative when
 * an upline has raised their price since the seller last set theirs — the
 * levels nearest the customer simply earn nothing on that sale.
 *
 * Returns null when a level's price is missing entirely. That is a data gap,
 * not a zero: the caller should fall back to unattributed owner-role pricing
 * rather than invent a split.
 */
export function splitChainProfit(
    sellingPrice: number,
    levels: ChainLevel[]
): ChainSplit | null {
    if (levels.length === 0) return null

    const sellerCost = levels[0].wholesale
    if (sellerCost === null) return null

    let boundary = Math.min(sellerCost, sellingPrice)
    const sellerProfit = sellingPrice - boundary
    const ancestorProfits: number[] = []

    for (const level of levels) {
        if (level.cost === null) return null
        const next = Math.min(level.cost, boundary)
        ancestorProfits.push(toPesewaPrecision(boundary - next))
        boundary = next
    }

    return {
        sellerProfit: toPesewaPrecision(sellerProfit),
        sellerCost,
        ancestorProfits,
        totalMargin: toPesewaPrecision(sellingPrice - boundary),
    }
}
