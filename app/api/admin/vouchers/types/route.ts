import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { validateAdminAccess } from '@/lib/auth-utils'
import { validateBulkTiers } from '@/lib/vouchers/pricing'

// GET: Fetch all voucher types with stock counts
export async function GET() {
    try {
        const auth = await validateAdminAccess(false)
        if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status })

        const supabase = createServerClient()

        // Fetch all types (including inactive for admin view)
        const { data: types, error } = await (supabase.from('results_checker_types') as any)
            .select('*')
            .order('display_order', { ascending: true })

        if (error) return NextResponse.json({ error: error.message }, { status: 500 })

        // For each type, get stock counts
        const typesWithStock = await Promise.all(
            (types || []).map(async (type: any) => {
                const { count: available } = await (supabase.from('results_checker_inventory') as any)
                    .select('*', { count: 'exact', head: true })
                    .eq('type_id', type.id)
                    .eq('status', 'available')

                const { count: reserved } = await (supabase.from('results_checker_inventory') as any)
                    .select('*', { count: 'exact', head: true })
                    .eq('type_id', type.id)
                    .eq('status', 'reserved')

                const { count: sold } = await (supabase.from('results_checker_inventory') as any)
                    .select('*', { count: 'exact', head: true })
                    .eq('type_id', type.id)
                    .eq('status', 'sold')

                // cost_price IS returned here — this is the admin-only endpoint and the
                // admin edit form needs it to round-trip. Public/shop endpoints
                // (/api/shop/rc/*) still strip it.
                return {
                    ...type,
                    bulk_pricing: Array.isArray(type.bulk_pricing) ? type.bulk_pricing : [],
                    stock: { available: available || 0, reserved: reserved || 0, sold: sold || 0 }
                }
            })
        )

        return NextResponse.json({ data: typesWithStock })
    } catch (err: any) {
        console.error('[RC Types GET]', err)
        return NextResponse.json({ error: 'Failed to fetch types' }, { status: 500 })
    }
}

// POST: Create a new voucher type
export async function POST(request: NextRequest) {
    try {
        const auth = await validateAdminAccess(false)
        if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status })

        const body = await request.json()
        const { name, customer_price, agent_price, dealer_price, api_price, cost_price, display_order, bulk_pricing } = body

        if (!name || !customer_price || !agent_price || !cost_price) {
            return NextResponse.json({ error: 'Name, customer_price, agent_price, and cost_price are required' }, { status: 400 })
        }

        // Parse prices
        const cp = parseFloat(customer_price)
        const ap = parseFloat(agent_price)
        const dp = dealer_price ? parseFloat(dealer_price) : 0
        const cost = parseFloat(cost_price)
        // Developer API price; blank = API callers pay their role price.
        const apiPrice = Number(api_price) > 0 ? parseFloat(api_price) : null

        // Server-side pricing sanity check
        if (cp < cost || ap < cost || (dp > 0 && dp < cost) || (apiPrice !== null && apiPrice < cost)) {
            return NextResponse.json({ error: 'Selling prices cannot be below cost price' }, { status: 400 })
        }

        // Validate bulk pricing tiers
        const tiers = Array.isArray(bulk_pricing) ? bulk_pricing : []
        const tierError = validateBulkTiers(tiers, cost)
        if (tierError) return NextResponse.json({ error: tierError }, { status: 400 })

        const supabase = createServerClient()
        const { data, error } = await (supabase.from('results_checker_types') as any)
            .insert({
                name,
                customer_price: cp,
                agent_price: ap,
                dealer_price: dp,
                api_price: apiPrice,
                cost_price: cost,
                display_order: display_order || 0,
                is_active: true,
                bulk_pricing: tiers,
            })
            .select()
            .single()

        if (error) {
            if (error.code === '23505') return NextResponse.json({ error: 'A type with this name already exists' }, { status: 409 })
            return NextResponse.json({ error: error.message }, { status: 500 })
        }

        return NextResponse.json({ data })
    } catch (err: any) {
        console.error('[RC Types POST]', err)
        return NextResponse.json({ error: 'Failed to create type' }, { status: 500 })
    }
}
