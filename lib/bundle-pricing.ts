/**
 * Standard Bundles pricing: KingFlexy catalog price + an admin-set markup.
 *
 * Pure functions only — no database, no network — so scripts/check-bundle-pricing.ts
 * can pin the arithmetic down. Every channel (wallet, MoMo, storefront, v2 API) prices
 * through priceBundle(), so they cannot disagree on what a bundle costs.
 */

export type BundlePriceTier = 'customer' | 'agent' | 'dealer' | 'api'

export const BUNDLE_PRICE_TIERS: BundlePriceTier[] = ['customer', 'agent', 'dealer', 'api']

export const BUNDLE_SETTING_KEYS = {
    enabled: 'bundles_enabled',
    networkEnabled: (n: string) => `bundles_enabled_${n.toLowerCase()}`,
    markupPercent: (t: BundlePriceTier) => `bundles_markup_percent_${t}`,
    markupMinGhs: 'bundles_markup_min_ghs',
    autoDispatch: 'bundles_auto_dispatch',
    storefront: 'storefront_bundles_enabled',
    /** The admin page-access toggle for /dashboard/standard-bundles. */
    pageAccess: 'page_access_standard_bundles',
} as const

/** Every admin_settings key the bundles feature reads. */
export function bundleSettingKeys(): string[] {
    return [
        BUNDLE_SETTING_KEYS.enabled,
        BUNDLE_SETTING_KEYS.networkEnabled('MTN'),
        BUNDLE_SETTING_KEYS.networkEnabled('Telecel'),
        BUNDLE_SETTING_KEYS.networkEnabled('AT'),
        ...BUNDLE_PRICE_TIERS.map(BUNDLE_SETTING_KEYS.markupPercent),
        BUNDLE_SETTING_KEYS.markupMinGhs,
        BUNDLE_SETTING_KEYS.autoDispatch,
        BUNDLE_SETTING_KEYS.storefront,
        BUNDLE_SETTING_KEYS.pageAccess,
    ]
}

export interface BundleMarkupSettings {
    percent: Record<BundlePriceTier, number>
    minGhs: number
}

function parseNonNegative(raw: string | undefined, fallback: number, max = Infinity): number {
    if (raw === undefined || raw === null || String(raw).trim() === '') return fallback
    const n = Number(raw)
    return Number.isFinite(n) && n >= 0 && n <= max ? n : fallback
}

/**
 * Reads markups out of a key→value map. A missing or garbage value falls back to
 * the customer markup rather than to zero: selling below cost is the worse mistake.
 */
export function parseMarkupSettings(settings: Record<string, string | undefined>): BundleMarkupSettings {
    const customer = parseNonNegative(settings[BUNDLE_SETTING_KEYS.markupPercent('customer')], 5, 100)
    const pick = (t: BundlePriceTier) => parseNonNegative(settings[BUNDLE_SETTING_KEYS.markupPercent(t)], customer, 100)
    return {
        percent: { customer, agent: pick('agent'), dealer: pick('dealer'), api: pick('api') },
        minGhs: parseNonNegative(settings[BUNDLE_SETTING_KEYS.markupMinGhs], 0, 1000),
    }
}

export interface BundlePrice {
    cost: number
    markup: number
    total: number
}

/** Money to the pesewa, rounding UP — a fraction of a pesewa is never our loss. */
function ceilToPesewa(x: number): number {
    // Round to 6 places first so 0.1 + 0.2 style float noise does not ceil a whole
    // pesewa up.
    return Math.ceil(Math.round(x * 1e6) / 1e4) / 100
}

export function priceBundle(cost: number, tier: BundlePriceTier, markup: BundleMarkupSettings): BundlePrice {
    const c = Math.round(cost * 100) / 100
    const pctMarkup = (c * markup.percent[tier]) / 100
    const raw = Math.max(pctMarkup, markup.minGhs)
    const total = ceilToPesewa(c + raw)
    return { cost: c, markup: Math.round((total - c) * 100) / 100, total }
}

/**
 * Which markup a user pays. Mirrors lib/api-pricing.ts: an API user pays the API
 * tier everywhere; otherwise a lapsed agent or dealer is priced as a customer the
 * moment their tier expires.
 */
export function resolveBundleTier(userRow: any, now: Date = new Date()): BundlePriceTier {
    if (userRow?.is_api_user === true) return 'api'
    const lapsed = (at: string | null | undefined) => !!at && new Date(at) < now
    if (userRow?.role === 'dealer' && !lapsed(userRow?.dealer_expires_at)) return 'dealer'
    if (userRow?.role === 'agent' && !lapsed(userRow?.agent_expires_at)) return 'agent'
    return 'customer'
}

/**
 * The id a client sends back to buy a bundle. Opaque to the client; the server
 * re-finds the bundle in its own copy of the catalog, so a stale or forged id can
 * only ever match a real, currently-listed bundle at today's price.
 */
export function bundleKey(b: { packId: string | null; value: string | null; amount: number }): string {
    // KingFlexy wants value AND amount sent back, so both identify a bundle.
    return b.packId ? `p:${b.packId}` : `v:${b.amount.toFixed(2)}:${b.value}`
}
