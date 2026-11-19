/**
 * get_site_info: live, customer-facing fees, prices and limits, read at question
 * time so ARHMS AI never quotes a stale number after an admin changes a setting.
 *
 * Customer-facing values ONLY. Never cost prices, margins, supplier names or keys.
 * Every topic reuses the logic the matching page/route already uses.
 */
import { getPublicConfig } from '@/lib/public-config'
import { resolveAfaCostPrice } from '@/lib/afa-pricing'
import { commissionWithdrawalSettings } from '@/lib/commission-withdrawal'
import { unlockPriceKeyForRole } from '@/lib/sms/sms-purchase'

/**
 * Dealer plans, same keys as lib/dealer-plans.ts DEALER_PLANS. Read directly here so
 * this file also builds on branches without that module; a plan is offered only
 * when switched on with a price above 0 (the upgrade page's rule).
 */
const DEALER_PLAN_KEYS = [
    { label: '3 Days', priceKey: 'dealer_subscription_price_3d', enabledKey: 'dealer_plan_enabled_3d' },
    { label: '2 Weeks', priceKey: 'dealer_subscription_price_2w', enabledKey: 'dealer_plan_enabled_2w' },
    { label: '1 Month', priceKey: 'dealer_subscription_price_1m', enabledKey: 'dealer_plan_enabled_1m' },
    { label: '3 Months', priceKey: 'dealer_subscription_price_3m', enabledKey: 'dealer_plan_enabled_3m' },
    { label: '6 Months', priceKey: 'dealer_subscription_price_6m', enabledKey: 'dealer_plan_enabled_6m' },
] as const

export const SITE_INFO_TOPICS = [
    'airtime',
    'wallet_topup',
    'upgrade_plans',
    'afa',
    'bills',
    'results_checker',
    'withdrawals',
    'sms',
    'delivery_status',
    'support_contacts',
    'features_on',
] as const
export type SiteInfoTopic = (typeof SITE_INFO_TOPICS)[number]

/** Same minimum the wallet page enforces (app/dashboard/wallet/page.tsx MIN_AMOUNT). */
const WALLET_TOPUP_MIN_GHS = 5
/** app/api/dashboard/sub/withdraw/route.ts */
const SUB_AGENT_MIN_WITHDRAWAL_GHS = 10
const BILL_SERVICES = ['ecg', 'ghanawater', 'dstv', 'gotv', 'startimes'] as const
const NETS = [['mtn', 'MTN'], ['telecel', 'Telecel'], ['at', 'AirtelTigo']] as const

const num = (v: unknown, fallback: number) => {
    const n = parseFloat(String(v ?? ''))
    return Number.isFinite(n) ? n : fallback
}

async function settings(db: any, keys: string[]): Promise<Record<string, string>> {
    const { data, error } = await db.from('admin_settings').select('key, value').in('key', keys)
    if (error) throw error
    const s: Record<string, string> = {}
    for (const r of data || []) s[r.key] = r.value
    return s
}

/** agent/dealer pay agent-tier fees on airtime and bills; everyone else the customer tier. */
const feeTier = (role: string | null | undefined) => (role === 'agent' || role === 'dealer' ? 'agent' : 'customer')

export async function getSiteInfo(db: any, topic: SiteInfoTopic, userRow: any, isSub = false): Promise<Record<string, unknown>> {
    const role = userRow?.role || 'customer'

    switch (topic) {
        case 'airtime': {
            const tier = feeTier(role)
            const keys = ['airtime_min_amount', 'airtime_max_amount', ...NETS.flatMap(([k]) => [`airtime_fee_${k}_${tier}`, `airtime_enabled_${k}`])]
            const s = await settings(db, keys)
            return {
                min_amount_ghs: num(s.airtime_min_amount, 1),
                max_amount_ghs: num(s.airtime_max_amount, 100),
                fee_note: 'The fee is a percentage of the airtime amount.',
                networks: NETS.map(([k, label]) => ({
                    network: label,
                    available: s[`airtime_enabled_${k}`] !== 'false',
                    fee_percent: num(s[`airtime_fee_${k}_${tier}`], 5),
                })),
                page: '/dashboard/airtime',
            }
        }

        case 'wallet_topup': {
            const s = await settings(db, ['paystack_fee_percent', 'agent_paystack_fee_percent'])
            const key = role === 'agent' || role === 'dealer' ? 'agent_paystack_fee_percent' : 'paystack_fee_percent'
            return {
                min_topup_ghs: WALLET_TOPUP_MIN_GHS,
                payment_fee_percent: s[key] != null ? num(s[key], 0) : null,
                note: 'Pay with Mobile Money or card; the balance updates once the payment is confirmed.',
                page: '/dashboard/wallet',
            }
        }

        case 'upgrade_plans': {
            const [cfg, s] = await Promise.all([
                getPublicConfig(),
                settings(db, DEALER_PLAN_KEYS.flatMap(p => [p.priceKey, p.enabledKey])),
            ])
            return {
                your_role: role,
                agent_plans_ghs: cfg.upgradePrices,
                dealer_plans: DEALER_PLAN_KEYS
                    .filter(p => s[p.enabledKey] !== 'false' && num(s[p.priceKey], 0) > 0)
                    .map(p => ({ plan: p.label, price_ghs: num(s[p.priceKey], 0) })),
                page: '/dashboard/upgrade',
            }
        }

        case 'afa': {
            const r = await resolveAfaCostPrice(db, role)
            return {
                price_ghs: r.ok ? r.price : null,
                note: r.ok ? 'Price for your role.' : 'AFA pricing is not available right now.',
                minimum_age: 18,
                page: '/dashboard/afa-orders',
            }
        }

        case 'bills': {
            const tier = feeTier(role)
            const keys = [...BILL_SERVICES.flatMap(svc => [`utility_fee_${svc}_${tier}`, `utility_enabled_${svc}`]), 'page_access_utilities']
            const s = await settings(db, keys)
            return {
                fee_note: 'The fee is a percentage added to the bill amount.',
                services: BILL_SERVICES.map(svc => ({
                    service: svc,
                    available: s[`utility_enabled_${svc}`] !== 'false',
                    fee_percent: num(s[`utility_fee_${svc}_${tier}`], 2),
                })),
                page: '/dashboard/utilities',
            }
        }

        case 'results_checker': {
            const { data, error } = await db.from('results_checker_types').select('*').eq('is_active', true)
                .order('display_order', { ascending: true }).limit(20)
            if (error) throw error
            const col = role === 'dealer' ? 'dealer_price' : role === 'agent' ? 'agent_price' : 'customer_price'
            return {
                vouchers: (data || []).map((t: any) => ({
                    name: t.name,
                    price_ghs: num(t[col], num(t.customer_price, 0)) || num(t.customer_price, 0),
                })),
                page: '/dashboard/results-checker',
            }
        }

        case 'withdrawals': {
            const shopKeys = ['min_withdrawal_amount', 'withdrawal_fee_percent', 'withdrawal_fee_flat']
            const s = await settings(db, [...shopKeys, ...shopKeys.map(k => `${k}_${role}`)])
            const pick = (k: string, d: number) => num(s[`${k}_${role}`] ?? s[k], d)
            const commission = await commissionWithdrawalSettings(db)
            return {
                shop_profit: {
                    min_ghs: pick('min_withdrawal_amount', 0),
                    fee_percent: pick('withdrawal_fee_percent', 0),
                    fee_flat_ghs: pick('withdrawal_fee_flat', 0),
                    page: '/dashboard/shop/withdraw',
                },
                commission_wallet: {
                    min_ghs: commission.minAmount,
                    fee_percent: commission.feePercent,
                    fee_flat_ghs: commission.feeFlat,
                    page: '/dashboard/commission-wallet',
                },
                sub_agent_min_ghs: SUB_AGENT_MIN_WITHDRAWAL_GHS,
                note: 'An admin reviews withdrawal requests before payout.',
            }
        }

        case 'sms': {
            const key = unlockPriceKeyForRole(role, isSub)
            const [s, bundles] = await Promise.all([
                settings(db, [key, 'sms_free_activation']),
                db.from('sms_credit_bundles').select('name, credits, price').order('price', { ascending: true }).limit(12),
            ])
            return {
                activation_price_ghs: s.sms_free_activation === 'true' ? 0 : num(s[key], 0),
                credit_bundles: (bundles.data || []).map((b: any) => ({ name: b.name, credits: b.credits, price_ghs: num(b.price, 0) })),
                page: '/dashboard/sms',
            }
        }

        case 'delivery_status': {
            return {
                note: 'Most bundles arrive within minutes; at busy times it can take longer. The live Delivery Status card on the dashboard home page shows the current delivery time for each network.',
                page: '/dashboard',
            }
        }

        case 'support_contacts': {
            const cfg = await getPublicConfig()
            return {
                whatsapp_number: cfg.whatsappAdminNumber || null,
                whatsapp_group: cfg.whatsappGroupLink || null,
                email: cfg.supportEmail || null,
                complaints_page: '/dashboard/complaints',
            }
        }

        case 'features_on': {
            const cfg = await getPublicConfig()
            return {
                ussd: cfg.ussdEnabled,
                standard_bundles: cfg.standardBundlesEnabled,
                top_performers: cfg.topPerformersEnabled,
                pages: cfg.pageAccess,
            }
        }
    }
}
