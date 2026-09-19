import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'

export const revalidate = 600 // 10 minute ISR

interface Params {
    params: Promise<{ shopSlug: string }>
}

export async function GET(_req: NextRequest, { params }: Params) {
    const { shopSlug } = await params

    try {
        const cleanSlug = shopSlug.trim()
        const supabaseAdmin = createServerClient()
        const { data: shop } = await (supabaseAdmin
            .from('shop_profiles')
            .select('shop_name, description, logo_url, brand_color, shop_slug')
            .ilike('shop_slug', cleanSlug)
            .eq('approval_status', 'approved')
            .eq('is_active', true)
            .single() as any)

        if (!shop) {
            return new NextResponse('Not Found', { status: 404 })
        }

        const isValidHex = (color: string) => /^#([A-Fa-f0-9]{3}){1,4}$/.test(color)
        const themeColor = isValidHex(shop.brand_color || '') ? shop.brand_color : '#2563eb'

        // Use shop logo if it's a plain URL (not a data URI); otherwise fall back to platform icon
        const logoSrc = shop.logo_url && shop.logo_url.startsWith('http')
            ? shop.logo_url
            : '/icon-192x192.png'

        const shortName = shop.shop_name.length > 12
            ? shop.shop_name.substring(0, 12).trim() + '…'
            : shop.shop_name

        const manifest = {
            name: `${shop.shop_name} — Buy Data Bundles`,
            short_name: shortName,
            description: shop.description || `Buy affordable data bundles from ${shop.shop_name}`,
            start_url: `/shop/${shop.shop_slug}`,
            scope: `/shop/${shop.shop_slug}`,
            display: 'standalone',
            orientation: 'portrait',
            theme_color: themeColor,
            background_color: themeColor,
            icons: [
                {
                    src: logoSrc,
                    sizes: '192x192',
                    type: 'image/png',
                },
                {
                    src: logoSrc,
                    sizes: '512x512',
                    type: 'image/png',
                },
                {
                    src: '/icon-maskable.png',
                    sizes: '512x512',
                    type: 'image/png',
                    purpose: 'maskable',
                },
            ],
            categories: ['shopping', 'utilities'],
            lang: 'en',
        }

        return NextResponse.json(manifest, {
            headers: {
                'Content-Type': 'application/manifest+json',
                'Cache-Control': 'public, max-age=600, stale-while-revalidate=3600',
            },
        })
    } catch (err) {
        console.error('[ShopManifest] Error generating manifest:', err)
        return new NextResponse('Internal Server Error', { status: 500 })
    }
}
