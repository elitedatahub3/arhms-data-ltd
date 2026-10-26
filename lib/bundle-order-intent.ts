/**
 * The one place a Standard Bundle purchase is validated and priced.
 *
 * The wallet route, the MoMo gateway route, the storefront and the v2 API all call
 * buildBundleIntent(), exactly as utilities share lib/utility-order-intent.ts, so the
 * price a customer is shown, the price they are charged and the bundle we ask
 * KingFlexy for can never drift apart.
 *
 * The client never supplies a price. It sends an opaque bundle key; the server
 * re-finds that bundle in its own (cached) copy of KingFlexy's catalog and prices it
 * from there.
 */
import { validateGhanaianPhone } from '@/lib/phone-validation'
import {
    getBundleCatalog,
    isBundleNetwork,
    type BundleNetwork,
    type KfBundle,
    type KfBundleFamily,
} from '@/lib/kingflexy-bundles-service'
import {
    BUNDLE_SETTING_KEYS,
    bundleKey,
    bundleSettingKeys,
    parseMarkupSettings,
    priceBundle,
    type BundlePriceTier,
} from '@/lib/bundle-pricing'

export type BundleSettings = Record<string, string>

export async function loadBundleSettings(supabase: any): Promise<BundleSettings> {
    const { data } = await supabase.from('admin_settings').select('key, value').in('key', bundleSettingKeys())
    const out: BundleSettings = {}
    for (const row of (data || [])) out[row.key] = row.value
    return out
}

export function isBundlesEnabled(settings: BundleSettings): boolean {
    return settings[BUNDLE_SETTING_KEYS.enabled] === 'true'
}

/** The dashboard surface: master switch AND the admin page-access toggle. */
export function isBundlesDashboardOpen(settings: BundleSettings): boolean {
    return isBundlesEnabled(settings) && settings[BUNDLE_SETTING_KEYS.pageAccess] !== 'false'
}

export function isBundleNetworkEnabled(settings: BundleSettings, network: BundleNetwork): boolean {
    // Per-network switches default ON: the master switch is the launch gate.
    return isBundlesEnabled(settings) && settings[BUNDLE_SETTING_KEYS.networkEnabled(network)] !== 'false'
}

/** The phone-validation network names, mapped onto KingFlexy's. */
const PHONE_NETWORK_TO_BUNDLE: Record<string, BundleNetwork> = {
    MTN: 'MTN',
    Telecel: 'Telecel',
    AirtelTigo: 'AT',
}

export const BUNDLE_NETWORK_LABEL: Record<BundleNetwork, string> = {
    MTN: 'MTN',
    Telecel: 'Telecel',
    AT: 'AirtelTigo',
}

export interface PricedBundle {
    key: string
    size: string
    plan: string | null
    family: string
    familyLabel: string
    validity: string | null
    price: number
}

export interface PricedCatalog {
    network: BundleNetwork
    available: boolean
    families: KfBundleFamily[]
    bundles: PricedBundle[]
}

// Flat result types: strictNullChecks is off here, so boolean discriminants do not narrow.
export interface PricedCatalogResult {
    ok: boolean
    catalog?: PricedCatalog
    status?: number
    error?: string
}

/** What a buyer sees: our prices for their tier, never KingFlexy's cost or keys. */
export async function getPricedCatalog(
    network: BundleNetwork,
    tier: BundlePriceTier,
    settings: BundleSettings
): Promise<PricedCatalogResult> {
    if (!isBundleNetworkEnabled(settings, network)) {
        return { ok: true, catalog: { network, available: false, families: [], bundles: [] } }
    }
    const res = await getBundleCatalog(network)
    if (!res.success) return { ok: false, status: 502, error: res.error }

    const markup = parseMarkupSettings(settings)
    return {
        ok: true,
        catalog: {
            network,
            available: res.catalog.enabled && res.catalog.bundles.length > 0,
            families: res.catalog.families,
            bundles: res.catalog.bundles.map(b => ({
                key: bundleKey(b),
                size: b.size,
                plan: b.plan,
                family: b.family,
                familyLabel: b.familyLabel,
                validity: b.validity,
                price: priceBundle(b.amount, tier, markup).total,
            })),
        },
    }
}

export interface BundleIntentInput {
    network: unknown
    bundleKey: unknown
    phone: unknown
}

export interface BundleIntent {
    network: BundleNetwork
    phone: string
    bundle: KfBundle
    tier: BundlePriceTier
    cost: number
    markup: number
    totalPaid: number
    /** e.g. "MTN 1.22GB" — ASCII, safe for provider descriptions. */
    label: string
}

export interface BundleIntentResult {
    ok: boolean
    intent?: BundleIntent
    status?: number
    error?: string
}

export async function buildBundleIntent(
    input: BundleIntentInput,
    settings: BundleSettings,
    tier: BundlePriceTier
): Promise<BundleIntentResult> {
    if (!isBundleNetwork(input.network)) {
        return { ok: false, status: 400, error: 'Choose MTN, Telecel or AirtelTigo.' }
    }
    const network = input.network
    if (typeof input.bundleKey !== 'string' || !input.bundleKey) {
        return { ok: false, status: 400, error: 'Choose a bundle.' }
    }
    if (typeof input.phone !== 'string') {
        return { ok: false, status: 400, error: 'Enter the phone number to receive the bundle.' }
    }

    if (!isBundleNetworkEnabled(settings, network)) {
        return { ok: false, status: 503, error: `${BUNDLE_NETWORK_LABEL[network]} bundles are not available right now.` }
    }

    const phoneCheck = validateGhanaianPhone(input.phone)
    if (!phoneCheck.isValid) {
        return { ok: false, status: 400, error: phoneCheck.error || 'Enter a valid Ghana phone number.' }
    }
    // KingFlexy rejects a number on a different carrier anyway; catching it here
    // saves charging and refunding the customer for a guaranteed refusal.
    const phoneNetwork = PHONE_NETWORK_TO_BUNDLE[phoneCheck.network || '']
    if (phoneNetwork !== network) {
        return {
            ok: false,
            status: 400,
            error: `${phoneCheck.normalizedNumber} is not a ${BUNDLE_NETWORK_LABEL[network]} number. Choose a ${BUNDLE_NETWORK_LABEL[network]} number or switch network.`,
        }
    }

    const res = await getBundleCatalog(network)
    if (!res.success) return { ok: false, status: 502, error: res.error }
    if (!res.catalog.enabled) {
        return { ok: false, status: 503, error: `${BUNDLE_NETWORK_LABEL[network]} bundles are paused by the provider. Please try again later.` }
    }

    const bundle = res.catalog.bundles.find(b => bundleKey(b) === input.bundleKey)
    if (!bundle) {
        return { ok: false, status: 404, error: 'That bundle is no longer available. Please refresh and choose again.' }
    }

    const price = priceBundle(bundle.amount, tier, parseMarkupSettings(settings))

    return {
        ok: true,
        intent: {
            network,
            phone: phoneCheck.normalizedNumber,
            bundle,
            tier,
            cost: price.cost,
            markup: price.markup,
            totalPaid: price.total,
            label: `${BUNDLE_NETWORK_LABEL[network]} ${bundle.size}`.replace(/[^\x20-\x7E]/g, ''),
        },
    }
}

/** Columns every channel writes for a new bundle_orders row. */
export function bundleOrderColumns(intent: BundleIntent) {
    return {
        network: intent.network,
        beneficiary_phone: intent.phone,
        family: intent.bundle.family,
        family_label: intent.bundle.familyLabel,
        bundle_label: intent.bundle.size,
        validity: intent.bundle.validity,
        kf_value: intent.bundle.packId ? null : intent.bundle.value,
        kf_pack_id: intent.bundle.packId,
        cost_amount: intent.cost,
        markup_amount: intent.markup,
        total_paid: intent.totalPaid,
        price_tier: intent.tier,
    }
}
