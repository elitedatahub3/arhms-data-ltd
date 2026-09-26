import { NextRequest, NextResponse } from 'next/server'
import { createRouteHandlerClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { resolveAfaCostPrice, maxShopAfaProfit } from '@/lib/afa-pricing'

/**
 * Shop owner reads / sets their AFA registration selling price.
 *
 * Mirrors /api/shop/rc-pricing. The owner's cost floor is their own role price
 * (afa_price_dealer / _agent / _customer) — what they would pay registering from
 * their own dashboard — and the markup cap is the same rule used for data
 * packages and RC vouchers.
 */

/** Loads the shop the caller owns, plus their role. Null when not the owner. */
async function loadOwnedShop(supabase: any, userId: string, shopId: string) {
    const { data: shop } = await supabase
        .from('shop_profiles')
        .select('id, owner_id')
        .eq('id', shopId)
        .eq('owner_id', userId)
        .maybeSingle()

    if (!shop) return null

    const { data: dbUser } = await supabase
        .from('users')
        .select('role')
        .eq('id', userId)
        .single()

    return { shop, ownerRole: (dbUser as any)?.role || 'customer' }
}

export async function POST(request: NextRequest) {
    try {
        const supabase = await createRouteHandlerClient()

        const { data: { user } } = await supabase.auth.getUser()
        if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

        const body = await request.json()
        const { shopId, sellingPrice } = body

        if (!shopId) {
            return NextResponse.json({ error: 'shopId is required' }, { status: 400 })
        }

        const owned = await loadOwnedShop(supabase, user.id, shopId)
        if (!owned) {
            return NextResponse.json({ error: 'Shop not found or unauthorized' }, { status: 403 })
        }

        // Service-role client: admin_settings is not readable under the caller's RLS.
        const db = createServerClient() as any

        // A sub-agent's AFA price is bounded by their upline's, not by their own
        // role cost — this route knows nothing of that bound, so it would let
        // them price straight past it.
        const { data: subMembership } = await db
            .from('sub_agents')
            .select('id')
            .eq('user_id', user.id)
            .maybeSingle()

        if (subMembership) {
            return NextResponse.json(
                { error: 'Set your AFA price from your own Pricing page, where your upline’s price is the floor.' },
                { status: 403 }
            )
        }

        const costResult = await resolveAfaCostPrice(db, owned.ownerRole)
        if (!costResult.ok) {
            return NextResponse.json({ error: costResult.error }, { status: 500 })
        }

        const cost = costResult.price
        const maxProfit = maxShopAfaProfit(owned.ownerRole)
        const selling = parseFloat(sellingPrice)

        if (isNaN(selling) || selling <= 0) {
            return NextResponse.json({ error: 'Selling price must be a positive number' }, { status: 400 })
        }

        const profit = selling - cost
        if (profit <= 0) {
            return NextResponse.json({ error: 'Selling price must be above cost price' }, { status: 400 })
        }
        if (profit > maxProfit) {
            return NextResponse.json({
                error: `Profit cannot exceed GHS ${maxProfit.toFixed(2)} per registration`
            }, { status: 400 })
        }

        const { error: upsertError } = await db
            .from('shop_afa_pricing')
            .upsert(
                {
                    shop_id: shopId,
                    selling_price: selling,
                    updated_at: new Date().toISOString(),
                },
                { onConflict: 'shop_id' }
            )

        if (upsertError) {
            console.error('[shop/afa-pricing] Upsert error:', upsertError)
            return NextResponse.json({ error: 'Failed to save AFA pricing' }, { status: 500 })
        }

        return NextResponse.json({ success: true })

    } catch (error: any) {
        console.error('[shop/afa-pricing]', error)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}

export async function GET(request: NextRequest) {
    try {
        const supabase = await createRouteHandlerClient()

        const { data: { user } } = await supabase.auth.getUser()
        if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

        const { searchParams } = new URL(request.url)
        const shopId = searchParams.get('shopId')
        if (!shopId) return NextResponse.json({ error: 'shopId is required' }, { status: 400 })

        const owned = await loadOwnedShop(supabase, user.id, shopId)
        if (!owned) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

        const db = createServerClient() as any

        const costResult = await resolveAfaCostPrice(db, owned.ownerRole)

        const { data: pricing } = await db
            .from('shop_afa_pricing')
            .select('selling_price')
            .eq('shop_id', shopId)
            .maybeSingle()

        // The cost is returned alongside the price so the pricing page can render
        // the floor and the live profit without duplicating the role lookup.
        return NextResponse.json({
            pricing: pricing ? { selling_price: parseFloat(pricing.selling_price) } : null,
            cost_price: costResult.ok ? costResult.price : null,
            max_profit: maxShopAfaProfit(owned.ownerRole),
        })

    } catch (error: any) {
        console.error('[shop/afa-pricing GET]', error)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
