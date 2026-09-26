import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { createRouteHandlerClient } from '@/lib/supabase-server'

/**
 * GET /api/dashboard/summary
 *
 * Everything the dashboard home needs, in one request.
 *
 * The page and its widgets used to issue roughly twenty separate queries from
 * the browser on every visit — six for the stat tiles, nine for shop status,
 * three (serially!) for the performance widget, plus recent orders, today's
 * totals and the unread count. Each is its own round trip, and on a phone on
 * Ghanaian mobile data the round trip, not the query, is the cost. Run together
 * on the server they cost one.
 *
 * Every figure keeps the exact scope it had client-side — lifetime counts stay
 * lifetime, windows stay the same window — so no number on the dashboard
 * changes meaning. Aggregates that used to be computed by downloading rows to
 * the phone (shop revenue and profit) are summed here and sent as numbers.
 *
 * Authorization: the caller is identified from their session cookie, and every
 * query below is scoped to that id. The service-role client bypasses RLS, so
 * that scoping is what enforces access — the same contract as
 * app/api/dashboard/sub/data/route.ts.
 */
export async function GET() {
    try {
        const supabaseAuth = await createRouteHandlerClient()
        const { data: { user }, error: authError } = await supabaseAuth.auth.getUser()

        if (authError || !user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const userId = user.id
        const supabase: any = createServerClient()

        const now = new Date()
        const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString()
        const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999).toISOString()
        const thirtyDaysAgo = new Date(now)
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)
        const fourteenDaysAgo = new Date(now.getFullYear(), now.getMonth(), now.getDate())
        fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 14)

        const ownOrders = () => supabase.from('orders').select('*', { count: 'exact', head: true })
            .eq('user_id', userId).is('shop_order_id', null)

        // allSettled everywhere: one failing section must not blank the whole
        // dashboard, which is the behaviour the page already relies on.
        const [
            totalRes,
            completedRes,
            processingRes,
            failedRes,
            pendingRes,
            walletRes,
            recentRes,
            todayOrdersRes,
            todayAfaRes,
            completed14Res,
            unreadRes,
            shopRes,
        ] = await Promise.allSettled([
            ownOrders(),
            ownOrders().eq('status', 'completed'),
            ownOrders().eq('status', 'processing'),
            ownOrders().eq('status', 'failed'),
            ownOrders().eq('status', 'pending'),
            supabase.from('wallets').select('balance').eq('user_id', userId).maybeSingle(),
            supabase.from('orders').select('*').eq('user_id', userId).is('shop_order_id', null)
                .order('created_at', { ascending: false }).limit(10),
            supabase.from('orders').select('status, size, price').eq('user_id', userId)
                .is('shop_order_id', null).gte('created_at', startOfToday).lte('created_at', endOfToday),
            supabase.from('afa_orders').select('status, payment_amount').eq('user_id', userId)
                .gte('created_at', startOfToday).lte('created_at', endOfToday),
            supabase.from('orders').select('price, created_at').eq('user_id', userId)
                .eq('status', 'completed').is('shop_order_id', null)
                .gte('created_at', fourteenDaysAgo.toISOString()),
            supabase.from('notifications').select('*', { count: 'exact', head: true })
                .eq('user_id', userId).eq('is_read', false),
            supabase.from('shop_profiles')
                .select('id, approval_status, shop_slug, shop_name, brand_color')
                .eq('owner_id', userId).maybeSingle(),
        ])

        const val = (r: PromiseSettledResult<any>) => (r.status === 'fulfilled' ? r.value : null)

        const totalOrders = val(totalRes)?.count || 0
        const completedOrders = val(completedRes)?.count || 0

        // ── Shop section: mirrors fetchShopStatus() in dashboard-client.tsx ──
        const shop = val(shopRes)?.data || null
        let shopSection: any = { hasShop: false, hasPricingConfigured: false, isApproved: false }

        if (shop) {
            const isApproved = shop.approval_status === 'approved'
            const shopOrders = () => supabase.from('shop_orders')
                .select('*', { count: 'exact', head: true }).eq('shop_id', shop.id)

            const [pricingRes, graphRes, sTotal, sCompleted, sPending, sProcessing, sFailed, revenueRes, shopWalletRes] =
                await Promise.allSettled([
                    supabase.from('shop_pricing').select('id', { count: 'exact', head: true }).eq('shop_id', shop.id),
                    isApproved
                        ? supabase.from('shop_orders').select('created_at, selling_price, profit')
                            .eq('shop_id', shop.id).gte('created_at', thirtyDaysAgo.toISOString())
                        : Promise.resolve({ data: [] }),
                    isApproved ? shopOrders() : Promise.resolve({ count: 0 }),
                    isApproved ? shopOrders().eq('status', 'completed') : Promise.resolve({ count: 0 }),
                    isApproved ? shopOrders().eq('status', 'pending') : Promise.resolve({ count: 0 }),
                    isApproved ? shopOrders().eq('status', 'processing') : Promise.resolve({ count: 0 }),
                    isApproved ? shopOrders().eq('status', 'failed') : Promise.resolve({ count: 0 }),
                    isApproved
                        ? supabase.from('shop_orders').select('selling_price, profit')
                            .eq('shop_id', shop.id).eq('status', 'completed')
                        : Promise.resolve({ data: [] }),
                    isApproved
                        ? supabase.from('shop_wallets').select('*').eq('owner_id', userId).maybeSingle()
                        : Promise.resolve({ data: null }),
                ])

            // Summed here rather than shipping every completed order to the phone.
            const revenueRows: Array<{ selling_price: number; profit: number }> = val(revenueRes)?.data || []

            shopSection = {
                hasShop: true,
                isApproved,
                hasPricingConfigured: (val(pricingRes)?.count || 0) > 0,
                shopId: shop.id,
                shopName: shop.shop_name,
                brandColor: shop.brand_color,
                ...(shop.shop_slug && { shopSlug: shop.shop_slug }),
                wallet: val(shopWalletRes)?.data || null,
                graphData: val(graphRes)?.data || [],
                orderStats: {
                    total: val(sTotal)?.count || 0,
                    completed: val(sCompleted)?.count || 0,
                    pending: val(sPending)?.count || 0,
                    processing: val(sProcessing)?.count || 0,
                    failed: val(sFailed)?.count || 0,
                    revenue: revenueRows.reduce((s, r) => s + (r.selling_price || 0), 0),
                    profit: revenueRows.reduce((s, r) => s + (r.profit || 0), 0),
                },
            }
        }

        return NextResponse.json({
            // Stat tiles — all lifetime, as before.
            stats: {
                totalOrders,
                completedOrders,
                processingOrders: val(processingRes)?.count || 0,
                failedOrders: val(failedRes)?.count || 0,
                pendingOrders: val(pendingRes)?.count || 0,
                walletBalance: val(walletRes)?.data?.balance || 0,
            },
            recentOrders: val(recentRes)?.data || [],
            // Raw rows: the widget does its own GB parsing and status bucketing.
            today: {
                orders: val(todayOrdersRes)?.data || [],
                afaOrders: val(todayAfaRes)?.data || [],
            },
            performance: {
                totalCount: totalOrders,
                completedCount: completedOrders,
                completedLast14Days: val(completed14Res)?.data || [],
            },
            unreadNotifications: val(unreadRes)?.count || 0,
            shop: shopSection,
        })
    } catch (error) {
        console.error('[dashboard/summary] failed:', error)
        return NextResponse.json({ error: 'Failed to load dashboard' }, { status: 500 })
    }
}
