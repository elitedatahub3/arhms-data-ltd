import { NextRequest, NextResponse } from 'next/server'
import { createRouteHandlerClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { revalidatePath } from 'next/cache'
import { loadBundleSettings } from '@/lib/bundle-order-intent'
import { isBundlesStorefrontOpen, SHOP_BUNDLE_MAX_PERCENT } from '@/lib/bundle-shop'

/**
 * A shop's Standard Bundles settings: on/off for its storefront, and one
 * percentage added on top of the owner's own Standard Bundles price.
 *
 * GET  → { available, enabled, percent, max_percent }
 * POST { enabled, percent }
 */
async function ownedShop() {
    const supabaseUser = await createRouteHandlerClient()
    const { data: { user } } = await supabaseUser.auth.getUser()
    if (!user) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }

    const db = createServerClient() as any
    const { data: shop } = await db
        .from('shop_profiles')
        .select('id, shop_slug, bundles_enabled, bundle_markup_percent')
        .eq('owner_id', user.id)
        .maybeSingle()
    if (!shop) return { error: NextResponse.json({ error: 'You do not have a shop' }, { status: 404 }) }
    return { db, shop }
}

export async function GET() {
    const ctx = await ownedShop()
    if ('error' in ctx) return ctx.error
    const settings = await loadBundleSettings(ctx.db)
    return NextResponse.json({
        available: isBundlesStorefrontOpen(settings),
        enabled: ctx.shop.bundles_enabled === true,
        percent: Number(ctx.shop.bundle_markup_percent || 0),
        max_percent: SHOP_BUNDLE_MAX_PERCENT,
    })
}

export async function POST(request: NextRequest) {
    const ctx = await ownedShop()
    if ('error' in ctx) return ctx.error

    let body: any
    try {
        body = await request.json()
    } catch {
        return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
    }

    const percent = Number(body?.percent)
    if (!Number.isFinite(percent) || percent < 0 || percent > SHOP_BUNDLE_MAX_PERCENT) {
        return NextResponse.json({ error: `Your percentage must be between 0 and ${SHOP_BUNDLE_MAX_PERCENT}.` }, { status: 400 })
    }
    const enabled = body?.enabled === true

    if (enabled) {
        const settings = await loadBundleSettings(ctx.db)
        if (!isBundlesStorefrontOpen(settings)) {
            return NextResponse.json({ error: 'Standard Bundles are not open for shops yet.' }, { status: 403 })
        }
    }

    const { error } = await ctx.db
        .from('shop_profiles')
        .update({ bundles_enabled: enabled, bundle_markup_percent: Math.round(percent * 100) / 100 })
        .eq('id', ctx.shop.id)
    if (error) {
        console.error('[shop/bundle-pricing] save failed:', error.message)
        return NextResponse.json({ error: 'Could not save. Has migration 20261127020000 been run?' }, { status: 500 })
    }

    // The storefront page is ISR-cached; show the change now.
    try { if (ctx.shop.shop_slug) revalidatePath(`/shop/${ctx.shop.shop_slug}`) } catch { /* non-fatal */ }
    return NextResponse.json({ success: true })
}
