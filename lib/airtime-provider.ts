/**
 * Which upstream actually delivers airtime.
 *
 * One seam, so the answer lives in a single place instead of being re-decided at
 * each call site — mirrors lib/utility-provider.ts.
 *
 * It is KingFlexy. Auto-fulfillment used to target Hubtel Commission Services, but
 * that never shipped past testing: Hubtel's prepaid account has never reliably
 * worked, the same account utility bills used to hit before that product moved to
 * KingFlexy for the same reason. KingFlexy's Airtime v2 API replaces it outright.
 *
 * lib/hubtel-airtime-service.ts and its webhook are left in place, dormant — only
 * relevant to any legacy provider = 'hubtel' rows already in flight.
 */
export {
    purchaseAirtimeViaKingFlexy as purchaseAirtime,
    getKfAirtimeOrderStatus as getAirtimeOrderStatus,
} from '@/lib/kingflexy-airtime-service'

export type {
    KfAirtimePurchaseResult as AirtimePurchaseResult,
    KfAirtimeStatusResult as AirtimeStatusResult,
} from '@/lib/kingflexy-airtime-service'

/** Written to airtime_orders.provider once an order is dispatched. */
export const AIRTIME_PROVIDER = 'kingflexy' as const
