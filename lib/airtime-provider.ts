/**
 * Which upstream actually delivers airtime.
 *
 * One seam, so the answer lives in a single place instead of being re-decided at
 * each call site — mirrors lib/utility-provider.ts.
 *
 * Chosen PER NETWORK by an admin (Admin → Airtime → Settings), stored in
 * admin_settings as airtime_supplier_mtn / _telecel / _at. A missing or unknown
 * value means KingFlexy, the long-standing default, so nothing moves until an
 * admin flips a switch.
 *
 *   • kingflexy    — KingFlexy Airtime v2 (lib/kingflexy-airtime-service.ts)
 *   • bundleportal — BundlePortal place_airtime (lib/bundleportal-service.ts)
 *
 * Each order remembers its supplier in airtime_orders.provider, and the status
 * check always asks THAT supplier — flipping the switch never strands an order
 * already in flight with the other one.
 *
 * lib/hubtel-airtime-service.ts and its webhook are left in place, dormant — only
 * relevant to any legacy provider = 'hubtel' rows already in flight.
 */
import { purchaseAirtimeViaKingFlexy, getKfAirtimeOrderStatus } from '@/lib/kingflexy-airtime-service'
import { purchaseAirtimeViaBundlePortal } from '@/lib/bundleportal-service'

export const AIRTIME_SUPPLIERS = ['kingflexy', 'bundleportal'] as const
export type AirtimeSupplier = typeof AIRTIME_SUPPLIERS[number]

export const AIRTIME_SUPPLIER_LABEL: Record<AirtimeSupplier, string> = {
    kingflexy: 'KingFlexy',
    bundleportal: 'BundlePortal',
}

/** admin_settings key holding the supplier for each airtime network. */
export const AIRTIME_SUPPLIER_SETTING_KEY: Record<string, string> = {
    MTN: 'airtime_supplier_mtn',
    Telecel: 'airtime_supplier_telecel',
    AT: 'airtime_supplier_at',
}

export function parseAirtimeSupplier(value: unknown): AirtimeSupplier {
    return (AIRTIME_SUPPLIERS as readonly string[]).includes(value as string) ? value as AirtimeSupplier : 'kingflexy'
}

/** The supplier an admin chose for this network; KingFlexy when unset or unreadable. */
export async function resolveAirtimeSupplier(supabase: any, network: string): Promise<AirtimeSupplier> {
    const key = AIRTIME_SUPPLIER_SETTING_KEY[network]
    if (!key) return 'kingflexy'
    try {
        const { data } = await supabase.from('admin_settings').select('value').eq('key', key).maybeSingle()
        return parseAirtimeSupplier(data?.value)
    } catch {
        return 'kingflexy'
    }
}

export interface AirtimePurchaseParams {
    network: string
    phone: string
    amount: number
    reference: string
}

export interface AirtimePurchaseResult {
    success: boolean
    supplierOrderId?: string
    status?: string
    totalPaid?: number
    newBalance?: number
    error?: string
    /** True when the supplier definitively refused and nothing left our balance with them. */
    knownUnpaid?: boolean
    raw?: any
}

export async function purchaseAirtime(supplier: AirtimeSupplier, params: AirtimePurchaseParams): Promise<AirtimePurchaseResult> {
    if (supplier === 'bundleportal') return purchaseAirtimeViaBundlePortal(params)
    return purchaseAirtimeViaKingFlexy(params)
}

export interface AirtimeStatusResult {
    success: boolean
    status?: 'pending' | 'processing' | 'completed' | 'failed'
    error?: string
    raw?: any
}

/**
 * KingFlexy only. BundlePortal has no per-order status call, so its open legs are
 * settled in one batched get_transactions scan by the sync cron
 * (fetchBundlePortalAirtimeStatuses) and by its webhook.
 */
export async function getAirtimeOrderStatus(reference: string): Promise<AirtimeStatusResult> {
    return getKfAirtimeOrderStatus(reference)
}
