/**
 * Gateway fee percentages, resolved the same way at checkout and at settlement.
 *
 * This exists because the two ends had drifted apart in shape. A checkout route
 * resolves a percent, adds it to the price and charges the total; lib/shop-order-
 * processor.ts then RE-DERIVES the percent from the same settings and rejects the
 * order if the paid amount differs by more than five pesewas. That check is a real
 * fraud control and worth keeping, but it means the two must agree exactly — and
 * they only agreed by both hand-rolling the same ladder of admin_settings lookups.
 * Adding a provider with its own fee keys to one side and not the other fails every
 * storefront order AFTER the customer has paid.
 *
 * So: one ladder, used by both, parameterised by provider.
 *
 * Pure on purpose — settings map in, number out. No database handle and no env
 * reads, so the client-side fee previews can import it and show the customer the
 * same figure the handset will ask for. Callers do their own query using the key
 * lists exported here.
 */

import type { PaymentProvider } from '@/lib/payment-provider'

/** The last-resort percent when nothing is configured anywhere. */
export const DEFAULT_GATEWAY_FEE_PERCENT = 1.95

/**
 * Whether a provider bills against the Paystack fee settings at all.
 *
 * Hubtel has its own percent (HUBTEL_FEE_PERCENT, via calculateHubtelFee) and
 * PaySwitch/Moolre are settled on the gateway's side, so only the two Paystack
 * rails read these keys.
 */
function usesPaystackFeeKeys(provider: PaymentProvider): boolean {
    return provider === 'paystack' || provider === 'paystack_momo'
}

/**
 * admin_settings keys a web checkout must SELECT to resolve its fee.
 *
 * Exported as one list so a route cannot fetch the hosted-checkout keys and then
 * resolve the MoMo ones — it would silently fall through to the 1.95 default and
 * undercharge without anything logging it.
 */
export const WEB_FEE_SETTING_KEYS = [
    'paystack_fee_percent',
    'agent_paystack_fee_percent',
    'paystack_momo_fee_percent',
    'agent_paystack_momo_fee_percent',
] as const

function firstConfiguredPercent(
    settingsMap: Record<string, any>,
    keys: string[]
): number | null {
    for (const key of keys) {
        const raw = settingsMap?.[key]
        if (raw === undefined || raw === null || raw === '') continue
        const parsed = typeof raw === 'string' ? parseFloat(raw) : Number(raw)
        // A configured 0 means "deliberately free" and must win over the default.
        if (!isNaN(parsed)) return parsed
    }
    return null
}

/**
 * Fee percent for a web-scope checkout.
 *
 * The MoMo keys fall back to the hosted-checkout keys when unset. That fallback is
 * what makes the day the provider is switched on a no-op: if the seed migration
 * never ran, or an admin has only ever configured the original keys, the customer
 * is charged exactly what they were charged yesterday rather than dropping to the
 * hardcoded default.
 */
export function resolveWebFeePercent(
    settingsMap: Record<string, any>,
    opts: {
        role?: string | null
        provider: PaymentProvider
        /**
         * What to charge when no key is configured at all.
         *
         * Defaults to 1.95, which is what the wallet, data and storefront flows have
         * always fallen back to. The utility flow deliberately passes 0: it read its
         * percent with `|| '0'`, so an unconfigured key meant a free transfer there,
         * and quietly turning that into 1.95% would raise the price of every utility
         * bill the day this shipped.
         */
        fallbackPercent?: number
    }
): number {
    const fallback = opts.fallbackPercent ?? DEFAULT_GATEWAY_FEE_PERCENT
    if (!usesPaystackFeeKeys(opts.provider)) return fallback

    const isAgent = opts.role === 'agent'
    const keys: string[] = []

    if (opts.provider === 'paystack_momo') {
        if (isAgent) keys.push('agent_paystack_momo_fee_percent')
        keys.push('paystack_momo_fee_percent')
    }
    if (isAgent) keys.push('agent_paystack_fee_percent')
    keys.push('paystack_fee_percent')

    return firstConfiguredPercent(settingsMap, keys) ?? fallback
}

/**
 * shop_global_settings keys a storefront checkout or the order processor must
 * SELECT for a given role and provider.
 */
export function shopFeeSettingKeys(
    ownerRole: string,
    provider: PaymentProvider
): string[] {
    const keys: string[] = []
    if (provider === 'paystack_momo') {
        keys.push(`shop_paystack_momo_fee_percent_${ownerRole}`, 'shop_paystack_momo_fee_percent')
    }
    keys.push(`shop_paystack_fee_percent_${ownerRole}`, 'shop_paystack_fee_percent')
    return keys
}

/**
 * Fee percent for a storefront order.
 *
 * Priority: per-shop override -> role-specific global -> legacy global -> default,
 * with the MoMo keys inserted above their hosted-checkout equivalents.
 *
 * The per-shop override is shared between both Paystack rails deliberately. A
 * shop's negotiated rate is a fact about the shop, not about which API collected
 * the money, so splitting it into two columns would mean an admin who set one and
 * not the other silently charges a different price the day the rail changes.
 *
 * A per-shop override of exactly 0 means "deliberately free for this shop"; only
 * null means "inherit from global".
 */
export function resolveShopFeePercent(
    settingsMap: Record<string, any>,
    opts: {
        shopOverride?: number | string | null
        ownerRole: string
        provider: PaymentProvider
    }
): number {
    if (!usesPaystackFeeKeys(opts.provider)) return DEFAULT_GATEWAY_FEE_PERCENT

    if (opts.shopOverride !== null && opts.shopOverride !== undefined && opts.shopOverride !== '') {
        const parsed = parseFloat(String(opts.shopOverride))
        if (!isNaN(parsed)) return parsed
    }

    return (
        firstConfiguredPercent(settingsMap, shopFeeSettingKeys(opts.ownerRole, opts.provider))
        ?? DEFAULT_GATEWAY_FEE_PERCENT
    )
}
