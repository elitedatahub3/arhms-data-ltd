import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { createRouteHandlerClient } from '@/lib/supabase-server'
import { settleOpenOrdersForUser } from '@/lib/bundle-settlement'

export const dynamic = 'force-dynamic'

/** The signed-in user's recent Standard Bundle orders. Never returns cost or KF keys. */
export async function GET(request: NextRequest) {
    const userClient = await createRouteHandlerClient()
    const { data: { user }, error: authError } = await userClient.auth.getUser()
    if (authError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const limit = Math.min(Math.max(Number(request.nextUrl.searchParams.get('limit')) || 30, 1), 100)

    // Settle this buyer's open orders first, so a bundle KingFlexy failed shows as
    // refunded (and the money is back) without waiting for their webhook or the cron.
    // Capped so a slow KingFlexy never holds the list up.
    await Promise.race([
        settleOpenOrdersForUser(user.id).catch(e => console.error('[BundlesHistory] Settle failed:', e)),
        new Promise(resolve => setTimeout(resolve, 8000)),
    ])

    const supabase = createServerClient() as any
    const { data, error } = await supabase
        .from('bundle_orders')
        .select('id, reference_code, network, bundle_label, family_label, beneficiary_phone, total_paid, status, payment_method, fulfillment_note, created_at, fulfilled_at')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(limit)

    if (error) {
        console.error('[BundlesHistory] Query failed:', error.message)
        return NextResponse.json({ error: 'Could not load your orders' }, { status: 500 })
    }

    // fulfillment_note carries provider detail meant for admins. Show buyers only
    // whether money came back.
    const orders = (data || []).map((o: any) => ({
        ...o,
        fulfillment_note: undefined,
        refunded: o.status === 'refunded',
    }))

    return NextResponse.json({ orders })
}
