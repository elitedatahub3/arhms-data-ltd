/**
 * Dealer subscription plans — single source of truth for id, duration and the
 * admin_settings keys behind each plan's price and on/off switch.
 */

export type DealerPlanId = 'dealer_3d' | 'dealer_2w' | 'dealer_1m' | 'dealer_3m' | 'dealer_6m'

export interface DealerPlan {
    id: DealerPlanId
    days: number
    /** Short name, e.g. "3 Days" */
    shortLabel: string
    /** Label stored on the payment and shown in notifications */
    label: string
    priceKey: string
    enabledKey: string
}

export const DEALER_PLANS: readonly DealerPlan[] = [
    { id: 'dealer_3d', days: 3, shortLabel: '3 Days', label: '3 Days Dealer Subscription', priceKey: 'dealer_subscription_price_3d', enabledKey: 'dealer_plan_enabled_3d' },
    { id: 'dealer_2w', days: 14, shortLabel: '2 Weeks', label: '2 Weeks Dealer Subscription', priceKey: 'dealer_subscription_price_2w', enabledKey: 'dealer_plan_enabled_2w' },
    { id: 'dealer_1m', days: 30, shortLabel: '1 Month', label: '1 Month Dealer Subscription', priceKey: 'dealer_subscription_price_1m', enabledKey: 'dealer_plan_enabled_1m' },
    { id: 'dealer_3m', days: 90, shortLabel: '3 Months', label: '3 Months Dealer Subscription', priceKey: 'dealer_subscription_price_3m', enabledKey: 'dealer_plan_enabled_3m' },
    { id: 'dealer_6m', days: 180, shortLabel: '6 Months', label: '6 Months Dealer Subscription', priceKey: 'dealer_subscription_price_6m', enabledKey: 'dealer_plan_enabled_6m' },
]

export const DEALER_PLAN_SETTING_KEYS: string[] = DEALER_PLANS.flatMap(p => [p.priceKey, p.enabledKey])

export function isDealerPlanId(value: unknown): value is DealerPlanId {
    return typeof value === 'string' && DEALER_PLANS.some(p => p.id === value)
}

export function getDealerPlan(id: DealerPlanId): DealerPlan {
    return DEALER_PLANS.find(p => p.id === id)!
}

/** price + on/off per plan, as returned by /api/admin/get-prices */
export type DealerPlanConfig = Record<DealerPlanId, { price: number; enabled: boolean }>

/**
 * Build the plan config from admin_settings rows. A plan is on unless an admin
 * has explicitly switched it off, and a missing/zero price means it cannot be
 * bought — so a missing setting never produces a free plan.
 */
export function buildDealerPlanConfig(rows: { key: string; value: string }[] | null | undefined): DealerPlanConfig {
    const get = (key: string) => rows?.find(r => r.key === key)?.value
    const config = {} as DealerPlanConfig
    for (const plan of DEALER_PLANS) {
        const price = parseFloat(get(plan.priceKey) || '0')
        config[plan.id] = {
            price: Number.isFinite(price) && price > 0 ? price : 0,
            enabled: get(plan.enabledKey) !== 'false',
        }
    }
    return config
}

export function isDealerPlanAvailable(config: DealerPlanConfig, id: DealerPlanId): boolean {
    return config[id].enabled && config[id].price > 0
}
