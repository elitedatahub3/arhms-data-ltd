import { NextResponse } from 'next/server'
import { createRouteHandlerClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

/**
 * GET: the signed-in owner's storefront Standard Bundle orders (newest 100) and
 * totals. Storefront orders are placed under the owner (user_id), tagged with
 * their shop_id and source 'storefront'.
 */
export async function GET() {
    const supabaseUser = await createRouteHandlerClient()
    const { data: { user } } = await supabaseUser.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const db = createServerClient() as any
    const { data: shop } = await db.from('shop_profiles').select('id').eq('owner_id', user.id).maybeSingle()
    if (!shop) return NextResponse.json({ orders: [], summary: { orders: 0, delivered: 0, sales: 0, profit: 0 } })

    const { data, error } = await db
        .from('bundle_orders')
        .select('reference_code, network, bundle_label, beneficiary_phone, total_paid, shop_profit, status, payment_status, refunded_amount, shop_credited_at, created_at')
        .eq('shop_id', shop.id)
        .eq('source', 'storefront')
        .order('created_at', { ascending: false })
        .limit(100)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    const summary = { orders: 0, delivered: 0, sales: 0, profit: 0 }
    for (const o of (data || [])) {
        summary.orders++
        if (o.status === 'completed') {
            summary.delivered++
            summary.sales += Number(o.total_paid || 0) - Number(o.refunded_amount || 0)
            if (o.shop_credited_at) summary.profit += Number(o.shop_profit || 0) * (1 - Number(o.refunded_amount || 0) / Math.max(Number(o.total_paid || 0), 0.01))
        }
    }
    summary.sales = Math.round(summary.sales * 100) / 100
    summary.profit = Math.round(summary.profit * 100) / 100

    return NextResponse.json({ orders: data || [], summary })
}
