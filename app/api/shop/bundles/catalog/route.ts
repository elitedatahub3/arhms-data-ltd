import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { isBundleNetwork } from '@/lib/kingflexy-bundles-service'
import { resolveBundleTier } from '@/lib/bundle-pricing'
import { getPricedCatalog, loadBundleSettings } from '@/lib/bundle-order-intent'
import { SPECIAL_FAMILY } from '@/lib/datagod-bundles-service'
import { filterFamiliesByScope, isBundlesStorefrontOpen, loadBundleShop, parseBundleScope, shopBundleMarkup } from '@/lib/bundle-shop'

export const dynamic = 'force-dynamic'

/**
 * GET /api/shop/bundles/catalog?slug=&network=&scope=all|special|no-special
 *
 * Public (storefront buyers are guests). Prices = the shop owner's own Standard
 * Bundles price + the shop's percentage. Never exposes cost or provider keys.
 */
export async function GET(request: NextRequest) {
    const sp = request.nextUrl.searchParams
    const network = sp.get('network')
    if (!isBundleNetwork(network)) return NextResponse.json({ error: 'Choose MTN, Telecel or AirtelTigo.' }, { status: 400 })
    const scope = parseBundleScope(sp.get('scope'))

    const supabase = createServerClient() as any
    const found = await loadBundleShop(supabase, sp.get('slug'))
    if (!found.shop) return NextResponse.json({ error: found.error }, { status: found.status })
    const shop = found.shop

    const [settings, { data: owner }] = await Promise.all([
        loadBundleSettings(supabase),
        supabase.from('users').select('role, is_api_user, agent_expires_at, dealer_expires_at').eq('id', shop.owner_id).single(),
    ])
    if (!isBundlesStorefrontOpen(settings)) {
        return NextResponse.json({ enabled: false, catalog: { network, available: false, families: [], bundles: [] } })
    }

    const res = await getPricedCatalog(network, resolveBundleTier(owner), settings)
    if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.status || 502 })

    const bundles = filterFamiliesByScope(res.catalog.bundles, scope).map(b => ({
        ...b,
        price: Math.round((b.price + shopBundleMarkup(b.price, shop.bundle_markup_percent)) * 100) / 100,
    }))
    const families = res.catalog.families.filter(f =>
        bundles.some(b => b.family === f.key) && (scope !== 'special' || f.key === SPECIAL_FAMILY)
    )

    return NextResponse.json(
        { enabled: true, catalog: { network, available: res.catalog.available && bundles.length > 0, families, bundles } },
        { headers: { 'Cache-Control': 'no-store' } }
    )
}
