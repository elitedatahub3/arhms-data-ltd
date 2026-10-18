/**
 * Shop profit for Results Checker and AFA sales — one calculation for every
 * surface that sells them (web storefront, USSD, the payment webhooks and crons).
 *
 * Data bundles already split correctly in lib/shop-order-processor.ts. Checkers and
 * AFA did not, in two ways this module exists to close:
 *
 *   1. Checkers measured a shop's profit against the platform's own cost_price, so
 *      the owner pocketed the platform's margin too. The rule everywhere now is the
 *      data one: profit = selling price − what the owner would pay on the dashboard
 *      (their role price).
 *
 *   2. Neither split a sub-agent's sale up the chain. The sub was credited the whole
 *      margin above the root's cost and every upline got nothing — even though the
 *      sub's own pricing screen floors on the upline's price. A sub's cost is now
 *      their direct upline's price, and each level above keeps its own spread,
 *      exactly as data does (lib/pricing/chain-cost.ts).
 *
 * The split is computed ONCE, when the order row is created, and stored on it
 * (shop_markup plus parent_/grandparent_ columns). Every settlement path then pays
 * what the row says through creditOrderProfit(), so a webhook, a browser poll and a
 * cron racing each other all pay the same legs, once each.
 */
import { ownerCostPrice } from '@/lib/shop-price-limits'
import { resolveSubAgentChain } from '@/lib/sub-agents'
import { resolveChainCostsWith, splitChainProfit } from '@/lib/pricing/chain-cost'
import type { PricingTiers } from '@/lib/pricing/cost-basis'
import { AFA_PRICE_KEYS } from '@/lib/afa-pricing'
import { creditShopRcProfit } from '@/lib/shop-service'

export type ProfitKind = 'rc' | 'afa'

export interface ProfitSplit {
    /** What the seller pays per unit: their upline's price, or their role price at the root. */
    unitCost: number
    /** The seller's own profit, for the whole quantity. Never negative. */
    sellerProfit: number
    /** One leg per upline, nearest first, for the whole quantity. Empty for a Lead. */
    ancestors: Array<{ shopId: string; ownerId: string; profit: number }>
    /** Selling total minus the root's platform cost. Zero or less means nobody earns. */
    totalMargin: number
}

/** The order-row columns that carry a split. Mirrors shop_orders. */
export const PROFIT_SPLIT_COLUMNS = [
    'parent_shop_id',
    'parent_profit',
    'grandparent_shop_id',
    'grandparent_profit',
] as const

const money = (value: number) => Math.round(value * 100) / 100

const asNumber = (value: unknown): number | null => {
    if (value === null || value === undefined || value === '') return null
    const n = typeof value === 'number' ? value : parseFloat(String(value))
    return Number.isFinite(n) ? n : null
}

/** The platform's price tiers for one item, or null when it is not priced at all. */
async function loadTiers(db: any, kind: ProfitKind, itemId: string | null): Promise<PricingTiers | null> {
    if (kind === 'rc') {
        const { data } = await db
            .from('results_checker_types')
            .select('customer_price, agent_price, dealer_price')
            .eq('id', itemId)
            .maybeSingle()
        const price = asNumber((data as any)?.customer_price)
        if (price === null) return null
        return {
            price,
            agentPrice: asNumber((data as any)?.agent_price),
            dealerPrice: asNumber((data as any)?.dealer_price),
        }
    }

    const { data } = await db
        .from('admin_settings')
        .select('key, value')
        .in('key', AFA_PRICE_KEYS as unknown as string[])
    const byKey: Record<string, unknown> = {}
    for (const row of (data || []) as any[]) byKey[row.key] = row.value
    const price = asNumber(byKey.afa_price_customer)
    if (price === null || price <= 0) return null
    return {
        price,
        agentPrice: asNumber(byKey.afa_price_agent),
        dealerPrice: asNumber(byKey.afa_price_dealer),
    }
}

/** What each of these shops charges the level below it for the item. */
function wholesaleLoader(db: any, kind: ProfitKind, itemId: string | null) {
    return async (shopIds: string[]): Promise<Map<string, number | null>> => {
        const query = kind === 'rc'
            ? db.from('shop_rc_pricing').select('shop_id, selling_price').in('shop_id', shopIds).eq('rc_type_id', itemId)
            : db.from('shop_afa_pricing').select('shop_id, selling_price').in('shop_id', shopIds)
        const { data } = await query
        return new Map<string, number | null>(
            ((data || []) as any[]).map((row) => [row.shop_id, asNumber(row.selling_price)])
        )
    }
}

/**
 * What an owner pays the platform per unit — the floor their own pricing page shows.
 * Null when the platform has not priced the item.
 */
export async function ownerUnitCost(
    db: any,
    kind: ProfitKind,
    itemId: string | null,
    ownerRole: string | null | undefined
): Promise<number | null> {
    const tiers = await loadTiers(db, kind, itemId)
    if (!tiers) return null
    return ownerCostPrice(
        { price: tiers.price, agent_price: tiers.agentPrice, dealer_price: tiers.dealerPrice },
        ownerRole
    )
}

/**
 * Splits one sale between the seller and every upline.
 *
 * @param db        Service-role client — sub_agents, users and pricing sit behind RLS.
 * @param ownerId   The SELLING shop's owner.
 * @param itemId    results_checker_types.id for checkers; ignored for AFA.
 * @param unitPrice The seller's own selling price, read from the database, never the client.
 *
 * Returns null only when the platform has no price for the item, which the caller
 * treats as "not for sale". Every other oddity resolves to a valid split.
 */
export async function computeShopProfit(
    db: any,
    params: { kind: ProfitKind; ownerId: string; itemId?: string | null; unitPrice: number; qty?: number }
): Promise<ProfitSplit | null> {
    const { kind, ownerId, unitPrice } = params
    const itemId = params.itemId ?? null
    const qty = Math.max(1, Math.floor(params.qty ?? 1))

    const tiers = await loadTiers(db, kind, itemId)
    if (!tiers) return null

    const [{ data: owner }, chain] = await Promise.all([
        db.from('users').select('role').eq('id', ownerId).maybeSingle(),
        resolveSubAgentChain(db, ownerId),
    ])

    const roleCost = ownerCostPrice(
        { price: tiers.price, agent_price: tiers.agentPrice, dealer_price: tiers.dealerPrice },
        (owner as any)?.role || 'customer'
    )

    if (chain.length > 0) {
        const levels = await resolveChainCostsWith(db, chain, wholesaleLoader(db, kind, itemId), tiers)
        const split = splitChainProfit(unitPrice, levels)

        if (split) {
            return {
                unitCost: split.sellerCost,
                sellerProfit: money(split.sellerProfit * qty),
                ancestors: levels.map((level, i) => ({
                    shopId: level.shopId,
                    ownerId: level.ownerId,
                    profit: money((split.ancestorProfits[i] ?? 0) * qty),
                })),
                totalMargin: money(split.totalMargin * qty),
            }
        }

        // An upline stopped selling this item after the sub priced it. The sale is
        // still real, so price it like a Lead's with nothing attributed upward —
        // the same fallback data orders take — and say so.
        console.warn('[ShopProfit] Sub sale with no upline price; unattributed.', { kind, ownerId, itemId })
    }

    return {
        unitCost: roleCost,
        sellerProfit: money(Math.max(0, unitPrice - roleCost) * qty),
        ancestors: [],
        totalMargin: money((unitPrice - roleCost) * qty),
    }
}

/** The order-row fields for a split, ready to spread into an insert. */
export function profitColumns(split: ProfitSplit): Record<string, unknown> {
    const [parent, grandparent] = split.ancestors
    return {
        shop_markup: split.sellerProfit,
        parent_shop_id: parent?.shopId ?? null,
        parent_profit: parent ? parent.profit : null,
        grandparent_shop_id: grandparent?.shopId ?? null,
        grandparent_profit: grandparent ? grandparent.profit : null,
    }
}

/**
 * Inserts an order row carrying split columns, surviving a database that does not
 * have them yet (migration 20261018020000_shop_profit_split.sql).
 *
 * Losing the columns costs the uplines their legs on this order, which the backfill
 * script can find later. Failing the insert would cost the customer their order.
 */
export async function insertOrderWithSplit(
    db: any,
    table: string,
    row: Record<string, unknown>,
    select = 'id'
): Promise<{ data: any; error: any }> {
    const first = await db.from(table).insert(row).select(select).single()
    if (!first.error || !/parent_|grandparent_/.test(String(first.error.message || ''))) return first

    console.error(`[ShopProfit] ${table} has no split columns yet — run 20261018020000_shop_profit_split.sql. Upline legs dropped for this order.`)
    const stripped = { ...row }
    for (const column of PROFIT_SPLIT_COLUMNS) delete stripped[column]
    return db.from(table).insert(stripped).select(select).single()
}

/**
 * Pays every leg stored on a completed order: the selling shop, then each upline.
 *
 * Each leg has its own ledger reference — `ref`, `ref:up1`, `ref:up2` — so the
 * unique (reference, type) index on shop_wallet_transactions lets every settlement
 * path call this freely and still pay each leg exactly once.
 */
export async function creditOrderProfit(
    db: any,
    order: {
        shop_id?: string | null
        shop_markup?: unknown
        parent_shop_id?: string | null
        parent_profit?: unknown
        grandparent_shop_id?: string | null
        grandparent_profit?: unknown
    },
    reference: string,
    description: string
): Promise<void> {
    const legs: Array<{ shopId: string; amount: number; reference: string; label: string }> = []
    const push = (shopId: string | null | undefined, amount: unknown, ref: string, label: string) => {
        const value = asNumber(amount) ?? 0
        if (shopId && value > 0) legs.push({ shopId, amount: money(value), reference: ref, label })
    }
    push(order.shop_id, order.shop_markup, reference, description)
    push(order.parent_shop_id, order.parent_profit, `${reference}:up1`, `${description} (sub-agent sale)`)
    push(order.grandparent_shop_id, order.grandparent_profit, `${reference}:up2`, `${description} (sub-agent sale)`)
    if (legs.length === 0) return

    const { data: shops } = await db
        .from('shop_profiles')
        .select('id, owner_id')
        .in('id', legs.map((leg) => leg.shopId))
    const ownerByShop = new Map<string, string>(((shops || []) as any[]).map((s) => [s.id, s.owner_id]))

    for (const leg of legs) {
        const ownerId = ownerByShop.get(leg.shopId)
        if (!ownerId) {
            console.error('[ShopProfit] No owner for shop', leg.shopId, 'leg', leg.reference)
            continue
        }
        // One leg failing must not stop the others — each is independently idempotent.
        try {
            await creditShopRcProfit({ ownerId, amount: leg.amount, description: leg.label, reference: leg.reference })
        } catch (error: any) {
            console.error('[ShopProfit] Credit failed for', leg.reference, error?.message)
        }
    }
}
