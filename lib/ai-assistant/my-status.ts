/**
 * get_my_status: the signed-in user's OWN data for areas the order tools don't cover.
 *
 * Rules (security):
 *   - every query filters by the server-verified user id (user_id / owner_id);
 *   - every query names its columns: never '*', so a secret column (api_keys.key_hash,
 *     webhook_secret, payout account numbers) can't leak even by accident;
 *   - a missing table/column returns "not available", never an exception message.
 */
import { shopUrl } from '@/lib/shop-url'
import { getUserRank, monthKey } from '@/lib/top-performers'

export const MY_STATUS_AREAS = [
    'complaints',
    'shop',
    'commission',
    'api_keys',
    'sms',
    'wallet_history',
    'top_performers',
    'notifications',
] as const
export type MyStatusArea = (typeof MY_STATUS_AREAS)[number]

const money = (n: unknown) => Number(Number(n || 0).toFixed(2))

export async function getMyStatus(db: any, userId: string, area: MyStatusArea): Promise<Record<string, unknown>> {
    switch (area) {
        case 'complaints': {
            const { data, error } = await db.from('complaints').select('title, status, created_at')
                .eq('user_id', userId).order('created_at', { ascending: false }).limit(5)
            if (error) throw error
            return { complaints: data || [], page: '/dashboard/complaints', note: data?.length ? undefined : 'No complaints filed.' }
        }

        case 'shop': {
            const { data: shop, error } = await db.from('shop_profiles')
                .select('shop_name, shop_slug, approval_status, is_active, pricing_status')
                .eq('owner_id', userId).maybeSingle()
            if (error) throw error
            if (!shop) return { has_shop: false, page: '/dashboard/shop', note: 'No shop yet. Agents and dealers can open one under Shop.' }
            const { data: wallet } = await db.from('shop_wallets').select('balance, total_earned').eq('owner_id', userId).maybeSingle()
            return {
                has_shop: true,
                shop_name: shop.shop_name,
                shop_link: shop.shop_slug ? shopUrl(shop.shop_slug) : null,
                approval_status: shop.approval_status,
                active: shop.is_active === true,
                pricing_status: shop.pricing_status ?? undefined,
                shop_balance_ghs: wallet ? money(wallet.balance) : null,
                total_earned_ghs: wallet ? money(wallet.total_earned) : null,
                page: '/dashboard/shop',
            }
        }

        case 'commission': {
            const [{ data: wallet }, { data: wds }] = await Promise.all([
                db.from('commission_wallets').select('balance, total_earned, total_withdrawn').eq('owner_id', userId).maybeSingle(),
                db.from('commission_withdrawals').select('amount, net_amount, status, created_at')
                    .eq('user_id', userId).order('created_at', { ascending: false }).limit(3),
            ])
            return {
                balance_ghs: wallet ? money(wallet.balance) : 0,
                total_earned_ghs: wallet ? money(wallet.total_earned) : 0,
                recent_withdrawals: (wds || []).map((w: any) => ({ amount_ghs: money(w.amount), you_receive_ghs: money(w.net_amount), status: w.status, created_at: w.created_at })),
                page: '/dashboard/commission-wallet',
            }
        }

        case 'api_keys': {
            // key_prefix only. NEVER key_hash, the key itself or webhook_secret.
            const { data, error } = await db.from('api_keys').select('kind, status, key_prefix, last_used_at, created_at')
                .eq('user_id', userId).order('created_at', { ascending: false }).limit(5)
            if (error) throw error
            return {
                keys: (data || []).map((k: any) => ({ kind: k.kind || 'standard', status: k.status, starts_with: k.key_prefix, last_used_at: k.last_used_at })),
                note: data?.length ? 'Key values are never shown again after creation; regenerate if lost.' : 'No API keys yet. Generate one on the Developer API page.',
                page: '/dashboard/developer-api',
            }
        }

        case 'sms': {
            const { data, error } = await db.from('sms_accounts').select('status, credits, default_sender, unlocked_at')
                .eq('user_id', userId).limit(2)
            if (error) throw error
            return {
                accounts: (data || []).map((a: any) => ({ status: a.status, credits: a.credits, sender_id: a.default_sender, activated: !!a.unlocked_at })),
                page: '/dashboard/sms',
            }
        }

        case 'wallet_history': {
            const { data, error } = await db.from('wallet_transactions').select('type, amount, description, created_at')
                .eq('user_id', userId).order('created_at', { ascending: false }).limit(6)
            if (error) throw error
            return {
                transactions: (data || []).map((t: any) => ({ type: t.type, amount_ghs: money(t.amount), description: t.description, created_at: t.created_at })),
                page: '/dashboard/transactions',
            }
        }

        case 'top_performers': {
            const rank = await getUserRank('dashboard', monthKey(), userId)
            return { this_month: rank, page: '/dashboard/top-performers' }
        }

        case 'notifications': {
            const { count, error } = await db.from('notifications').select('id', { count: 'exact', head: true })
                .eq('user_id', userId).eq('is_read', false)
            if (error) throw error
            return { unread: count || 0, page: '/dashboard/notifications' }
        }
    }
}
