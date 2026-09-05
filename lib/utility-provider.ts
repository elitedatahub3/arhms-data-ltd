/**
 * Which upstream actually pays a utility bill.
 *
 * One seam, so the answer lives in a single place instead of being re-decided at
 * each of the four call sites that verify an account and the one that pays.
 *
 * It is KingFlexy. Bills went directly to Hubtel until September 2026 and never
 * once succeeded — Hubtel rejects every request with "Could not find Prepaid
 * account", and because utilities share the airtime account, both products failed
 * identically. KingFlexy resells the same Hubtel Commission Services and owns the
 * prepaid account itself.
 *
 * lib/hubtel-utility-service.ts is deliberately still imported for UTILITY_SERVICES,
 * isUtilityService and resolveDestination. Those are the biller CATALOGUE — account
 * patterns, labels, which services need a phone or an email — and describe Ghana's
 * utilities rather than Hubtel's API. Only the two network calls moved.
 */
export {
    lookupUtilityAccount as queryUtilityAccount,
    payUtilityBillViaKingFlexy as payUtilityBill,
    getUtilityOrderStatus,
    listBillers,
} from '@/lib/kingflexy-utility-service'

export type {
    KfPayResult as UtilityPayResult,
    KfOrderStatus as UtilityOrderStatus,
    KfBiller as UtilityBiller,
} from '@/lib/kingflexy-utility-service'

/** Written to utility_orders.provider once an order is dispatched. */
export const UTILITY_PROVIDER = 'kingflexy' as const
