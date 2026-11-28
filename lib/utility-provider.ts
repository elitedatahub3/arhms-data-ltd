/**
 * Which upstream actually pays a utility bill: KingFlexy or Datagod.
 *
 * One seam, so the answer lives in a single place instead of being re-decided at
 * each of the call sites that verify an account and the one that pays.
 *
 * Chosen PER BILLER by an admin (Admin → Utilities, the picker on each biller card),
 * stored in admin_settings as utility_provider_<service> (ecg, ghanawater, dstv,
 * gotv, startimes). A missing or unknown value means KingFlexy, so nothing moves
 * until an admin flips a card.
 *
 * Same rule as lib/airtime-provider.ts and lib/bundle-provider.ts: the switch only
 * decides where NEW orders go. Each order stores the provider that took it in
 * utility_orders.provider, and status checks always ask THAT provider, so flipping
 * the switch never strands an order already in flight.
 *
 * Bills went directly to Hubtel until September 2026 and never once succeeded.
 * lib/hubtel-utility-service.ts is still imported for UTILITY_SERVICES and friends:
 * the biller CATALOGUE (account patterns, labels, which services need a phone or an
 * email), not Hubtel's API.
 */
import { createServerClient } from '@/lib/supabase'
import type { UtilityQueryParams, UtilityQueryResult } from '@/lib/hubtel-utility-service'
import {
    lookupUtilityAccount as lookupViaKingFlexy,
    payUtilityBillViaKingFlexy,
    getUtilityOrderStatus as getKfUtilityOrderStatus,
    listBillers,
} from '@/lib/kingflexy-utility-service'
import {
    lookupUtilityAccountViaDatagod,
    payUtilityBillViaDatagod,
    getDgUtilityOrderStatus,
    type DgPayResult,
    type DgOrderStatus,
} from '@/lib/datagod-utility-service'

export { listBillers }

export type {
    KfBiller as UtilityBiller,
} from '@/lib/kingflexy-utility-service'

export type UtilityPayResult = DgPayResult
export type UtilityOrderStatus = DgOrderStatus

export const UTILITY_PROVIDERS = ['kingflexy', 'datagod'] as const
export type UtilityProvider = typeof UTILITY_PROVIDERS[number]

export const UTILITY_PROVIDER_LABEL: Record<UtilityProvider, string> = {
    kingflexy: 'KingFlexy',
    datagod: 'Datagod',
}

export function isUtilityProvider(v: unknown): v is UtilityProvider {
    return typeof v === 'string' && (UTILITY_PROVIDERS as readonly string[]).includes(v)
}

/**
 * Unknown or missing → KingFlexy. admin_settings.value is JSONB, so a value saved
 * as '"datagod"' comes back as the string datagod, and one saved by hand with the
 * quotes kept arrives as "\"datagod\"" — accept both.
 */
export function parseUtilityProvider(raw: unknown): UtilityProvider {
    const s = String(raw ?? '').trim().replace(/^"+|"+$/g, '').toLowerCase()
    return isUtilityProvider(s) ? s : 'kingflexy'
}

export function utilityProviderSettingKey(service: string): string {
    return `utility_provider_${service}`
}

/** The provider an admin chose for this biller; KingFlexy when unset or unreadable. */
export async function resolveUtilityProvider(supabase: any, service: string): Promise<UtilityProvider> {
    try {
        const { data } = await supabase
            .from('admin_settings')
            .select('value')
            .eq('key', utilityProviderSettingKey(service))
            .maybeSingle()
        return parseUtilityProvider(data?.value)
    } catch {
        return 'kingflexy'
    }
}

/** The provider an existing order belongs to. Rows from before the switch are KingFlexy. */
export function orderUtilityProvider(order: any): UtilityProvider {
    return parseUtilityProvider(order?.provider)
}

/**
 * Account lookup, routed to the biller's current provider. Same signature the five
 * call sites already use; `email` is optional and only Datagod's Ghana Water needs it.
 */
export async function queryUtilityAccount(
    params: Pick<UtilityQueryParams, 'service' | 'accountNumber' | 'phone'> & { email?: string; service: string }
): Promise<UtilityQueryResult> {
    const provider = await resolveUtilityProvider(createServerClient() as any, params.service)
    if (provider === 'datagod') {
        return lookupUtilityAccountViaDatagod({
            service: params.service,
            accountNumber: params.accountNumber,
            phone: params.phone,
            email: params.email,
        })
    }
    return lookupViaKingFlexy({ service: params.service, accountNumber: params.accountNumber, phone: params.phone })
}

export interface UtilityPayForOrderParams {
    provider: UtilityProvider
    service: string
    accountNumber: string
    amount: number
    phone?: string | null
    email?: string | null
    reference: string
    /** Datagod only: the most it may charge us (what the customer paid). */
    maxCost?: number
}

/** Pays one already-claimed order with the provider stamped on it at claim time. */
export async function payUtilityBillForOrder(p: UtilityPayForOrderParams): Promise<UtilityPayResult> {
    if (p.provider === 'datagod') {
        return payUtilityBillViaDatagod({
            service: p.service,
            accountNumber: p.accountNumber,
            amount: p.amount,
            phone: p.phone,
            email: p.email,
            reference: p.reference,
            maxCost: p.maxCost,
        })
    }
    return payUtilityBillViaKingFlexy({
        service: p.service,
        accountNumber: p.accountNumber,
        amount: p.amount,
        phone: p.phone,
        reference: p.reference,
    })
}

/**
 * Settlement status from the order's own provider. KingFlexy is asked by THEIR
 * reference (external_transaction_id); Datagod by OUR reference_code, which it
 * echoes — so a Datagod order can be asked about even with no stored supplier ref.
 */
export async function getUtilityOrderStatusForOrder(order: any): Promise<UtilityOrderStatus> {
    if (orderUtilityProvider(order) === 'datagod') {
        return getDgUtilityOrderStatus(order.reference_code)
    }
    if (!order?.external_transaction_id) {
        return { success: false, error: 'no supplier reference on the order' }
    }
    return getKfUtilityOrderStatus(order.external_transaction_id)
}
