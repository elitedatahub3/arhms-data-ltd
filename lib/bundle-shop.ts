/**
 * Standard Bundles on shop storefronts.
 *
 * The buyer is a guest, so the shop owner is the account of record (as for
 * storefront bill payments): the order is priced at the OWNER's tier, the shop's
 * percentage goes on top, and that percentage is the shop's profit
 * (bundle_orders.shop_profit), paid into the shop wallet once delivered.
 *
 * MTN placement on the storefront:
 *  - shop sells no MTN data → only the MTN Special Bundles show, inside the DATA
 *    tile as its MTN tab; the rest live in the Standard Bundles tile.
 *  - shop sells MTN data → everything, Special Bundles included, lives in the
 *    Standard Bundles tile.
 */
import { BUNDLE_SETTING_KEYS } from '@/lib/bundle-pricing'
import { isBundlesEnabled, type BundleSettings } from '@/lib/bundle-order-intent'
import { creditShopRcProfit } from '@/lib/shop-service'
import { SPECIAL_FAMILY } from '@/lib/datagod-bundles-service'

export const SHOP_BUNDLE_MAX_PERCENT = 10

/** Which part of the catalog a storefront panel shows. */
export type StorefrontBundleScope = 'special' | 'all' | 'no-special'

export function parseBundleScope(raw: unknown): StorefrontBundleScope {
    return raw === 'special' || raw === 'no-special' ? raw : 'all'
}

export function filterFamiliesByScope<T extends { family: string }>(items: T[], scope: StorefrontBundleScope): T[] {
    if (scope === 'special') return items.filter(i => i.family === SPECIAL_FAMILY)
    if (scope === 'no-special') return items.filter(i => i.family !== SPECIAL_FAMILY)
    return items
}

/** Admin side: master switch AND the storefront switch. */
export function isBundlesStorefrontOpen(settings: BundleSettings): boolean {
    return isBundlesEnabled(settings) && settings[BUNDLE_SETTING_KEYS.storefront] === 'true'
}

export interface StorefrontShop {
    id: string
    shop_name: string
    owner_id: string
    bundles_enabled: boolean
    bundle_markup_percent: number
}

/** The shop behind a storefront, only if it is live and sells Standard Bundles. */
export async function loadBundleShop(supabase: any, slug: unknown): Promise<{ shop?: StorefrontShop; status?: number; error?: string }> {
    if (typeof slug !== 'string' || !slug.trim()) return { status: 400, error: 'Shop is required.' }
    const { data } = await supabase
        .from('shop_profiles')
        .select('id, shop_name, owner_id, bundles_enabled, bundle_markup_percent, approval_status, is_active')
        .eq('shop_slug', slug.trim())
        .maybeSingle()
    if (!data || data.approval_status !== 'approved' || data.is_active !== true) return { status: 404, error: 'Shop not found' }
    if (data.bundles_enabled !== true) return { status: 403, error: 'This shop does not sell Standard Bundles.' }
    return { shop: data }
}

function clampPercent(p: unknown): number {
    const n = Number(p)
    return Number.isFinite(n) && n > 0 ? Math.min(n, SHOP_BUNDLE_MAX_PERCENT) : 0
}

/** The shop's cut on top of the owner's price, rounded UP to the pesewa. */
export function shopBundleMarkup(ownerPrice: number, percent: unknown): number {
    const raw = (ownerPrice * clampPercent(percent)) / 100
    return Math.ceil(Math.round(raw * 1e6) / 1e4) / 100
}

/**
 * Pays the shop its profit for a delivered storefront bundle. For a Special
 * Bundle that only partly delivered, the shop earns only on the delivered share
 * (the failed share, profit included, went back in the partial refund).
 * Idempotent: the shop_wallet_transactions reference is the guard.
 */
export async function creditShopBundleProfit(supabase: any, order: any, partialRefund = 0): Promise<void> {
    if (order?.source !== 'storefront' || !order?.shop_id) return
    const profit = Number(order.shop_profit || 0)
    const total = Number(order.total_paid || 0)
    if (!(profit > 0) || !(total > 0)) return
    const deliveredShare = Math.max(0, 1 - Number(partialRefund || 0) / total)
    const amount = Math.floor(profit * deliveredShare * 100) / 100
    if (!(amount > 0)) return

    const res = await creditShopRcProfit({
        ownerId: order.user_id,
        amount,
        description: `Standard Bundle profit: ${order.network} ${order.bundle_label} to ${order.beneficiary_phone}`,
        reference: `BUNDLE-${order.reference_code}`,
    })
    if (res.credited || res.reason === 'already credited') {
        await supabase.from('bundle_orders').update({ shop_credited_at: new Date().toISOString() }).eq('id', order.id).is('shop_credited_at', null)
    } else {
        console.error('[BundleShop] Shop profit not credited for', order.reference_code, res.reason)
    }
}
