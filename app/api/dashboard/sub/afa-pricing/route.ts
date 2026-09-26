import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { createRouteHandlerClient } from '@/lib/supabase-server'
import { resolveSubPricingContext, ceilingFor } from '@/lib/sub-pricing-context'

/**
 * AFA registration pricing for a sub-agent's own storefront.
 *
 * Same bounds as the data and Results Checker screens — floor = the upline's
 * price, cap = floor + the sub's markup ceiling — against shop_afa_pricing,
 * which holds one row per shop rather than a catalogue.
 *
 * Without a row here the storefront's AFA tile never renders:
 * /api/shop/afa/config returns {enabled: false} for a shop with no price, and
 * ShopStorefront gates the tab on `!!afaConfig?.selling_price`.
 *
 * Not to be confused with /api/dashboard/sub/afa, which is the sub registering
 * a walk-in at their Lead's price from their own wallet. This route is about
 * what the sub's own storefront customers pay.
 */

export async function GET() {
    try {
        const auth = await createRouteHandlerClient()
        const { data: { user } } = await auth.auth.getUser()
        if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

        const db: any = createServerClient()
        const ctx = await resolveSubPricingContext(db, user.id)
        if ('error' in ctx) return NextResponse.json({ error: ctx.error }, { status: ctx.status })
        if (!ctx.shopId) return NextResponse.json({ needsShop: true, ceiling: ctx.ceiling })

        const { data: parentRow } = await db
            .from('shop_afa_pricing')
            .select('selling_price')
            .eq('shop_id', ctx.uplineShopId)
            .maybeSingle()

        if (parentRow?.selling_price == null) {
            return NextResponse.json({ noParentPricing: true, ceiling: ctx.ceiling })
        }

        const { data: myRow } = await db
            .from('shop_afa_pricing')
            .select('selling_price')
            .eq('shop_id', ctx.shopId)
            .maybeSingle()

        const parentPrice = Number(parentRow.selling_price)

        return NextResponse.json({
            parentPrice,
            maxPrice: ceilingFor(parentPrice, ctx.ceiling),
            currentPrice: myRow?.selling_price != null ? Number(myRow.selling_price) : null,
            ceiling: ctx.ceiling,
        })
    } catch (err) {
        console.error('[SubAfaPricing] GET error:', err)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}

export async function POST(request: NextRequest) {
    try {
        const auth = await createRouteHandlerClient()
        const { data: { user } } = await auth.auth.getUser()
        if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

        const { sellingPrice } = await request.json()

        const db: any = createServerClient()
        const ctx = await resolveSubPricingContext(db, user.id)
        if ('error' in ctx) return NextResponse.json({ error: ctx.error }, { status: ctx.status })
        if (!ctx.shopId) return NextResponse.json({ error: 'Create your shop first' }, { status: 400 })

        // The parent's price is the authoritative floor — never trust the client.
        const { data: parentRow } = await db
            .from('shop_afa_pricing')
            .select('selling_price')
            .eq('shop_id', ctx.uplineShopId)
            .maybeSingle()

        if (parentRow?.selling_price == null) {
            return NextResponse.json(
                { error: 'Your Lead has not priced AFA registration yet.' },
                { status: 409 }
            )
        }

        const price = Number(sellingPrice)
        if (!Number.isFinite(price)) {
            return NextResponse.json({ error: 'Invalid price' }, { status: 400 })
        }

        const floor = Number(parentRow.selling_price)
        const cap = ceilingFor(floor, ctx.ceiling)

        if (price <= floor) {
            return NextResponse.json(
                { error: `Price must be above the parent price of ₵${floor.toFixed(2)}` },
                { status: 400 }
            )
        }
        if (price > cap) {
            return NextResponse.json(
                { error: `Price cannot exceed ₵${cap.toFixed(2)} (parent + ceiling)` },
                { status: 400 }
            )
        }

        const { error: upsertErr } = await db
            .from('shop_afa_pricing')
            .upsert(
                { shop_id: ctx.shopId, selling_price: price, updated_at: new Date().toISOString() },
                { onConflict: 'shop_id' }
            )

        if (upsertErr) {
            console.error('[SubAfaPricing] upsert error:', upsertErr)
            return NextResponse.json({ error: 'Failed to save pricing' }, { status: 500 })
        }

        return NextResponse.json({ success: true, sellingPrice: price })
    } catch (err) {
        console.error('[SubAfaPricing] POST error:', err)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
