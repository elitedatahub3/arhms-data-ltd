import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'

/**
 * Public: what AFA registration looks like on a given storefront.
 *
 * Mirrors /api/shop/rc/types. Returns `enabled: false` — never an error — when
 * the admin toggle is off, the shop is not live, or the owner has not set a
 * price, so the storefront can simply hide the service.
 */
export async function GET(request: NextRequest) {
    const { searchParams } = new URL(request.url)
    const shopSlug = searchParams.get('shopSlug')

    if (!shopSlug) {
        return NextResponse.json({ error: 'shopSlug is required' }, { status: 400 })
    }

    try {
        const db = createServerClient() as any

        // 1. Global toggle
        const { data: settingRow } = await db
            .from('admin_settings')
            .select('value')
            .eq('key', 'storefront_afa_enabled')
            .maybeSingle()

        if (!settingRow || settingRow.value !== 'true') {
            return NextResponse.json({ enabled: false })
        }

        // 2. Shop must be approved and live
        const { data: shop } = await db
            .from('shop_profiles')
            .select('id')
            .ilike('shop_slug', shopSlug.trim())
            .eq('approval_status', 'approved')
            .eq('is_active', true)
            .maybeSingle()

        if (!shop) {
            return NextResponse.json({ enabled: false })
        }

        // 3. Owner must have set a price
        const { data: pricing } = await db
            .from('shop_afa_pricing')
            .select('selling_price')
            .eq('shop_id', shop.id)
            .maybeSingle()

        if (!pricing) {
            return NextResponse.json({ enabled: false })
        }

        return NextResponse.json({
            enabled: true,
            selling_price: parseFloat(pricing.selling_price),
        })

    } catch (error: any) {
        console.error('[shop/afa/config]', error)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
