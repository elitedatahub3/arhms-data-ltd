/**
 * Which provider sells Standard Bundles for each network: KingFlexy or Datagod.
 *
 * Same rule as lib/airtime-provider.ts: the switch (admin_settings
 * bundles_provider_<network>) only decides where NEW orders go. Each order stores
 * the provider that took it in bundle_orders.provider, and dispatch, status checks
 * and refunds always ask that stored provider, so flipping the switch never
 * strands an order in flight.
 */
import {
    getBundleCatalog as getKfBundleCatalog,
    invalidateBundleCatalog as invalidateKfBundleCatalog,
    purchaseBundleViaKingFlexy,
    getKfBundleOrderStatus,
    diagnoseKfBundleCatalog,
    type BundleNetwork,
    type CatalogResult,
    type KfBundleStatusResult,
} from '@/lib/kingflexy-bundles-service'
import {
    getDgBundleCatalog,
    invalidateDgBundleCatalog,
    purchaseBundleViaDatagod,
    getDgBundleOrderStatus,
    diagnoseDgBundleCatalog,
    type DgBundlePurchaseResult,
} from '@/lib/datagod-bundles-service'

export const BUNDLE_PROVIDERS = ['kingflexy', 'datagod'] as const
export type BundleProvider = typeof BUNDLE_PROVIDERS[number]

export const BUNDLE_PROVIDER_LABEL: Record<BundleProvider, string> = {
    kingflexy: 'KingFlexy',
    datagod: 'Datagod',
}

export function isBundleProvider(v: unknown): v is BundleProvider {
    return typeof v === 'string' && (BUNDLE_PROVIDERS as readonly string[]).includes(v)
}

/** Unknown or missing → KingFlexy, the provider every pre-switch order used. */
export function parseBundleProvider(raw: unknown): BundleProvider {
    const s = String(raw ?? '').trim().toLowerCase()
    return isBundleProvider(s) ? s : 'kingflexy'
}

export function bundleProviderSettingKey(network: string): string {
    return `bundles_provider_${network.toLowerCase()}`
}

export function resolveBundleProvider(settings: Record<string, string | undefined>, network: BundleNetwork): BundleProvider {
    return parseBundleProvider(settings[bundleProviderSettingKey(network)])
}

/** The provider an existing order belongs to. Rows from before the column default to KingFlexy. */
export function orderProvider(order: any): BundleProvider {
    return parseBundleProvider(order?.provider)
}

export function getProviderCatalog(provider: BundleProvider, network: BundleNetwork): Promise<CatalogResult> {
    return provider === 'datagod' ? getDgBundleCatalog(network) : getKfBundleCatalog(network)
}

/** Admin Test connection only: uncached, with the precise failure reason. */
export function diagnoseProviderCatalog(provider: BundleProvider, network: BundleNetwork): Promise<CatalogResult> {
    return provider === 'datagod' ? diagnoseDgBundleCatalog(network) : diagnoseKfBundleCatalog(network)
}

export function invalidateAllBundleCatalogs(): void {
    invalidateKfBundleCatalog()
    invalidateDgBundleCatalog()
}

/** Purchase an already-claimed bundle_orders row with the provider stored on it. */
export function purchaseBundleForOrder(order: any): Promise<DgBundlePurchaseResult> {
    if (orderProvider(order) === 'datagod') {
        return purchaseBundleViaDatagod({
            network: order.network,
            phone: order.beneficiary_phone,
            reference: order.reference_code,
            dgBundleId: order.dg_bundle_id,
            maxCost: Number(order.cost_amount),
        })
    }
    return purchaseBundleViaKingFlexy({
        network: order.network,
        phone: order.beneficiary_phone,
        reference: order.reference_code,
        value: order.kf_value,
        amount: Number(order.cost_amount),
        packId: order.kf_pack_id,
    })
}

export function getBundleOrderStatusForOrder(order: any): Promise<KfBundleStatusResult> {
    return orderProvider(order) === 'datagod'
        ? getDgBundleOrderStatus(order.reference_code)
        : getKfBundleOrderStatus(order.reference_code)
}
