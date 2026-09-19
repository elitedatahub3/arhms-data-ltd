import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'

export async function GET(request: NextRequest) {
    const { searchParams } = new URL(request.url)
    const shopSlug = searchParams.get('shopSlug')

    if (!shopSlug) {
        return NextResponse.json({ error: 'shopSlug is required' }, { status: 400 })
    }

    try {
        const db = createServerClient() as any

        // 1. Check global toggle
        const { data: settingRow } = await db
            .from('admin_settings')
            .select('value')
            .eq('key', 'storefront_rc_enabled')
            .maybeSingle()

        if (!settingRow || settingRow.value !== 'true') {
            return NextResponse.json({ types: [] })
        }

        // 2. Fetch shop
        const { data: shop } = await db
            .from('shop_profiles')
            .select('id')
            .ilike('shop_slug', shopSlug.trim())
            .eq('approval_status', 'approved')
            .eq('is_active', true)
            .maybeSingle()

        if (!shop) {
            return NextResponse.json({ types: [] })
        }

        // 3. Fetch shop's RC pricing joined with type info
        const { data: pricingRows } = await db
            .from('shop_rc_pricing')
            .select('rc_type_id, selling_price, results_checker_types(id, name, cost_price, is_active)')
            .eq('shop_id', shop.id)

        if (!pricingRows || pricingRows.length === 0) {
            return NextResponse.json({ types: [] })
        }

        // 4. For each type, count available inventory
        const activeRows = pricingRows.filter(
            (row: any) => row.results_checker_types?.is_active
        )

        const types = await Promise.all(
            activeRows.map(async (row: any) => {
                const rcType = row.results_checker_types
                const { count } = await db
                    .from('results_checker_inventory')
                    .select('id', { count: 'exact', head: true })
                    .eq('type_id', rcType.id)
                    .eq('status', 'available')

                return {
                    id: rcType.id,
                    name: rcType.name,
                    selling_price: parseFloat(row.selling_price),
                    cost_price: parseFloat(rcType.cost_price),
                    stock_count: count || 0,
                }
            })
        )

        return NextResponse.json({ types: types })

    } catch (error: any) {
        console.error('[shop/rc/types]', error)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
