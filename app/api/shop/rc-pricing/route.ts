import { NextRequest, NextResponse } from 'next/server'
import { createRouteHandlerClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { cookies } from 'next/headers'

export async function POST(request: NextRequest) {
    try {
        const cookieStore = await cookies()
        const supabase = await createRouteHandlerClient()

        // 1. Auth check
        const { data: { user } } = await supabase.auth.getUser()
        if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

        const body = await request.json()
        const { shopId, items } = body

        if (!shopId || !Array.isArray(items)) {
            return NextResponse.json({ error: 'shopId and items[] are required' }, { status: 400 })
        }

        // 2. Verify caller owns this shop
        const { data: shop } = await supabase
            .from('shop_profiles')
            .select('id, owner_id')
            .eq('id', shopId)
            .eq('owner_id', user.id)
            .maybeSingle()

        if (!shop) {
            return NextResponse.json({ error: 'Shop not found or unauthorized' }, { status: 403 })
        }

        // 3. Fetch caller's role for max profit enforcement
        const { data: dbUser } = await supabase
            .from('users')
            .select('role')
            .eq('id', user.id)
            .single()

        const ownerRole = (dbUser as any)?.role || 'customer'
        const maxProfit = ownerRole === 'agent' ? 10 : 5

        // 4. Use service-role client to fetch cost prices and upsert (bypasses RLS)
        const db = createServerClient() as any

        // A sub-agent's voucher prices are bounded by their upline's, not by the
        // role cap above — this route knows nothing of that bound, so it would
        // let them price straight past it.
        const { data: subMembership } = await db
            .from('sub_agents')
            .select('id')
            .eq('user_id', user.id)
            .maybeSingle()

        if (subMembership) {
            return NextResponse.json(
                { error: 'Set your Results Checker prices from your own Pricing page, where your upline’s price is the floor.' },
                { status: 403 }
            )
        }

        // Validate each item against cost price
        if (items.length > 0) {
            const typeIds = items.map((i: any) => i.rcTypeId)
            const { data: types } = await db
                .from('results_checker_types')
                .select('id, cost_price')
                .in('id', typeIds)

            const costMap: Record<string, number> = {}
            for (const t of (types || [])) costMap[t.id] = parseFloat(t.cost_price)

            for (const item of items) {
                const cost = costMap[item.rcTypeId]
                if (cost === undefined) {
                    return NextResponse.json({ error: `Unknown type: ${item.rcTypeId}` }, { status: 400 })
                }
                const selling = parseFloat(item.sellingPrice)
                if (isNaN(selling) || selling <= 0) {
                    return NextResponse.json({ error: 'Selling price must be a positive number' }, { status: 400 })
                }
                const profit = selling - cost
                if (profit <= 0) {
                    return NextResponse.json({ error: 'Selling price must be above cost price' }, { status: 400 })
                }
                if (profit > maxProfit) {
                    return NextResponse.json({
                        error: `Profit cannot exceed GHS ${maxProfit.toFixed(2)} per voucher`
                    }, { status: 400 })
                }
            }
        }

        // 5. Upsert pricing rows
        if (items.length > 0) {
            const upsertRows = items.map((item: any) => ({
                shop_id: shopId,
                rc_type_id: item.rcTypeId,
                selling_price: parseFloat(item.sellingPrice),
                updated_at: new Date().toISOString(),
            }))

            const { error: upsertError } = await db
                .from('shop_rc_pricing')
                .upsert(upsertRows, { onConflict: 'shop_id,rc_type_id' })

            if (upsertError) {
                console.error('[shop/rc-pricing] Upsert error:', upsertError)
                return NextResponse.json({ error: 'Failed to save RC pricing' }, { status: 500 })
            }
        }

        return NextResponse.json({ success: true })

    } catch (error: any) {
        console.error('[shop/rc-pricing]', error)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}

export async function GET(request: NextRequest) {
    try {
        const cookieStore = await cookies()
        const supabase = await createRouteHandlerClient()

        const { data: { user } } = await supabase.auth.getUser()
        if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

        const { searchParams } = new URL(request.url)
        const shopId = searchParams.get('shopId')
        if (!shopId) return NextResponse.json({ error: 'shopId is required' }, { status: 400 })

        // Verify ownership
        const { data: shop } = await supabase
            .from('shop_profiles')
            .select('id')
            .eq('id', shopId)
            .eq('owner_id', user.id)
            .maybeSingle()

        if (!shop) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

        const db = createServerClient() as any
        const { data: pricing } = await db
            .from('shop_rc_pricing')
            .select('rc_type_id, selling_price')
            .eq('shop_id', shopId)

        return NextResponse.json({ pricing: pricing || [] })

    } catch (error: any) {
        console.error('[shop/rc-pricing GET]', error)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
