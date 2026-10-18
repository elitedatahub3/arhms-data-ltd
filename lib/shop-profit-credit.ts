/**
 * Pays the legs of a shop sale — the Node-side half of lib/shop-profit.ts.
 *
 * Split out so lib/shop-profit.ts (pricing and the split arithmetic) stays importable
 * from the edge runtime: this file imports the shop-wallet code, which imports
 * Node-only packages.
 */
import { creditShopRcProfit } from '@/lib/shop-service'

const money = (value: number) => Math.round(value * 100) / 100

const asNumber = (value: unknown): number | null => {
    if (value === null || value === undefined || value === '') return null
    const n = typeof value === 'number' ? value : parseFloat(String(value))
    return Number.isFinite(n) ? n : null
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
