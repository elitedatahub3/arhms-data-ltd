import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { createRouteHandlerClient } from '@/lib/supabase-server'
import { resolveSubPricingContext, ceilingFor } from '@/lib/sub-pricing-context'

/**
 * Results Checker pricing for a sub-agent's own storefront.
 *
 * Mirrors /api/dashboard/sub/pricing exactly, against shop_rc_pricing instead
 * of shop_pricing: floor = the upline's price for that voucher type, cap =
 * floor + the sub's markup ceiling.
 *
 * Without rows here the storefront's Results Checker tile never renders at all
 * — /api/shop/rc/types returns {types: []} for a shop with no priced types, and
 * ShopStorefront hides the tab on an empty list.
 *
 * Not to be confused with /api/dashboard/sub/rc, which is the sub BUYING
 * vouchers at their Lead's price from their own wallet. This route is about
 * what the sub's own customers pay.
 */

export async function GET() {
    try {
        const auth = await createRouteHandlerClient()
        const { data: { user } } = await auth.auth.getUser()
        if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

        const db: any = createServerClient()
        const ctx = await resolveSubPricingContext(db, user.id)
        if ('error' in ctx) return NextResponse.json({ error: ctx.error }, { status: ctx.status })
        if (!ctx.shopId) return NextResponse.json({ needsShop: true, items: [], ceiling: ctx.ceiling })

        const { data: parentRows } = await db
            .from('shop_rc_pricing')
            .select('rc_type_id, selling_price')
            .eq('shop_id', ctx.uplineShopId)

        if (!parentRows?.length) {
            return NextResponse.json({ noParentPricing: true, items: [], ceiling: ctx.ceiling })
        }

        const { data: myRows } = await db
            .from('shop_rc_pricing')
            .select('rc_type_id, selling_price')
            .eq('shop_id', ctx.shopId)

        const myPrice = new Map<string, number>(
            (myRows || []).map((r: any) => [r.rc_type_id, Number(r.selling_price)])
        )

        const { data: types } = await db
            .from('results_checker_types')
            .select('id, name')
            .in('id', parentRows.map((r: any) => r.rc_type_id))

        const nameById = new Map<string, string>(
            (types || []).map((t: any) => [t.id, t.name])
        )

        const items = parentRows
            .filter((row: any) => row.selling_price != null && nameById.has(row.rc_type_id))
            .map((row: any) => {
                const floor = Number(row.selling_price)
                return {
                    rcTypeId: row.rc_type_id,
                    name: nameById.get(row.rc_type_id),
                    parentPrice: floor,
                    maxPrice: ceilingFor(floor, ctx.ceiling),
                    currentPrice: myPrice.get(row.rc_type_id) ?? null,
                }
            })
            .sort((a: any, b: any) => String(a.name).localeCompare(String(b.name)))

        return NextResponse.json({ items, ceiling: ctx.ceiling })
    } catch (err) {
        console.error('[SubRcPricing] GET error:', err)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}

export async function POST(request: NextRequest) {
    try {
        const auth = await createRouteHandlerClient()
        const { data: { user } } = await auth.auth.getUser()
        if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

        const { items } = await request.json()
        if (!Array.isArray(items)) {
            return NextResponse.json({ error: 'Invalid payload' }, { status: 400 })
        }

        const db: any = createServerClient()
        const ctx = await resolveSubPricingContext(db, user.id)
        if ('error' in ctx) return NextResponse.json({ error: ctx.error }, { status: ctx.status })
        if (!ctx.shopId) return NextResponse.json({ error: 'Create your shop first' }, { status: 400 })

        // Parent prices are the authoritative floor — never trust the client.
        const { data: parentRows } = await db
            .from('shop_rc_pricing')
            .select('rc_type_id, selling_price')
            .eq('shop_id', ctx.uplineShopId)

        const parentPrice = new Map<string, number>(
            (parentRows || [])
                .filter((r: any) => r.selling_price != null)
                .map((r: any) => [r.rc_type_id, Number(r.selling_price)])
        )

        const rows: any[] = []
        for (const item of items) {
            const floor = parentPrice.get(item.rcTypeId)
            if (floor == null) continue // type not offered by the parent — skip

            const price = Number(item.sellingPrice)
            if (!Number.isFinite(price)) {
                return NextResponse.json({ error: 'Invalid price' }, { status: 400 })
            }

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

            rows.push({ shop_id: ctx.shopId, rc_type_id: item.rcTypeId, selling_price: price })
        }

        if (rows.length > 0) {
            const { error: upsertErr } = await db
                .from('shop_rc_pricing')
                .upsert(rows, { onConflict: 'shop_id,rc_type_id' })
            if (upsertErr) {
                console.error('[SubRcPricing] upsert error:', upsertErr)
                return NextResponse.json({ error: 'Failed to save pricing' }, { status: 500 })
            }
        }

        // Drop voucher types the sub no longer offers.
        const keptIds = rows.map((r) => r.rc_type_id)
        const pruneQuery = db.from('shop_rc_pricing').delete().eq('shop_id', ctx.shopId)
        const { error: delErr } = keptIds.length > 0
            ? await pruneQuery.not('rc_type_id', 'in', `(${keptIds.join(',')})`)
            : await pruneQuery
        if (delErr) {
            console.error('[SubRcPricing] prune error:', delErr)
            return NextResponse.json({ error: 'Failed to save pricing' }, { status: 500 })
        }

        return NextResponse.json({ success: true, saved: rows.length })
    } catch (err) {
        console.error('[SubRcPricing] POST error:', err)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
