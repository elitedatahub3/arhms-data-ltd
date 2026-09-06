import { Metadata } from 'next'
import Image from 'next/image'
import { notFound } from 'next/navigation'
import { createServerClient } from '@/lib/supabase'
import { createRouteHandlerClient } from '@/lib/supabase-server'
import dynamic from 'next/dynamic'

// Lazy-load the 66KB ShopStorefront into a separate JS chunk
// so the ISR-cached HTML shell renders first, then JS hydrates — prevents
// blank-screen crashes on low-end phones with limited RAM
const ShopStorefront = dynamic(() => import('./ShopStorefront'), { loading: () => null })

interface Props {
    params: Promise<{ shopSlug: string }>
}

// ISR: revalidate every 10 minutes
export const revalidate = 600

export async function generateMetadata({ params }: Props): Promise<Metadata> {
    const { shopSlug } = await params
    // Use service-role so metadata is generated even for unauthenticated crawlers
    const supabaseAdmin = createServerClient()

    const { data: shop } = await (supabaseAdmin
        .from('shop_profiles')
        .select('shop_name, description, logo_url')
        .eq('shop_slug', shopSlug)
        .eq('approval_status', 'approved')
        .eq('is_active', true)
        .single() as any)

    if (!shop) {
        return { title: 'Shop Not Found' }
    }

    return {
        title: shop.shop_name,
        description: shop.description || `Buy affordable data bundles from ${shop.shop_name}`,
        openGraph: {
            title: shop.shop_name,
            description: shop.description || `Buy affordable data bundles from ${shop.shop_name}`,
            images: shop.logo_url ? [{ url: shop.logo_url }] : [],
        },
        icons: {
            icon: shop.logo_url || '/favicon.ico',
        },
        manifest: `/shop/${shopSlug}/manifest.json`,
    }
}

export default async function ShopPage({ params }: Props) {
    const { shopSlug } = await params

    // Service-role client for all public data reads — anonymous visitors have no session cookie
    const supabaseAdmin = createServerClient()
    // Session client only for the admin pass-through check
    const supabase = await createRouteHandlerClient()

    // Fetch shop using service-role so unauthenticated visitors can load the page
    const { data: shop } = await (supabaseAdmin
        .from('shop_profiles')
        .select('id, shop_name, shop_slug, description, owner_phone, owner_email, whatsapp_number, logo_url, banner_url, community_link, divider_style, brand_color, brand_accent, approval_status, pricing_status, is_active, owner_id, airtime_fee_mtn, airtime_fee_telecel, airtime_fee_at, ussd_code, ussd_status, utilities_enabled')
        .eq('shop_slug', shopSlug)
        .single() as any)

    // Shop doesn't exist or is not profile-approved → 404
    if (!shop || shop.approval_status !== 'approved' || !shop.is_active) {
        notFound()
    }

    // Fetch global storefront access settings using service-role client (bypasses RLS)
    const { data: adminSettings } = await (supabaseAdmin
        .from('admin_settings')
        .select('key, value')
        .in('key', [
            'page_access_storefront',
            'storefront_airtime_enabled',
            'storefront_mashup_enabled',
            'storefront_rc_enabled',
            'storefront_afa_enabled',
            'storefront_marketplace_ad_enabled',
            'storefront_ussd_card_enabled',
            'ussd_enabled',
            'ussd_dial_code',
            'airtime_fee_mtn_customer',
            'airtime_fee_mtn_agent',
            'airtime_fee_telecel_customer',
            'airtime_fee_telecel_agent',
            'airtime_fee_at_customer',
            'airtime_fee_at_agent',
            'airtime_min_amount',
            'airtime_max_amount',
            'special_mtn_mashup_hidden',
            // The SHOP-scope provider, not the web one. /api/shop/initialize decides
            // with this and ignores whatever the browser sends, so the checkout sheet
            // has to read the same key or it will ask for details the gateway never uses.
            'active_payment_provider_shop',
        ]) as any)

    const adminSettingsMap: Record<string, string> = {}
    for (const row of adminSettings || []) {
        adminSettingsMap[row.key] = row.value
    }

    const storefrontSetting = adminSettingsMap['page_access_storefront']

    // Admin pass-through check (uses session client — admins are always logged in)
    const { data: { user: authUser } } = await supabase.auth.getUser()
    let isAdmin = false
    if (authUser) {
        const { data: user } = await supabaseAdmin
            .from('users')
            .select('role')
            .eq('id', authUser.id)
            .single()
        if ((user as any)?.role === 'admin') isAdmin = true
    }

    // Block if globally disabled and not an admin
    if (storefrontSetting === 'false' && !isAdmin) {
        return (
            <div className="min-h-screen flex flex-col items-center justify-center bg-gradient-to-br from-gray-50 to-gray-100 dark:from-gray-900 dark:to-gray-800 p-6">
                <div className="max-w-md w-full text-center space-y-6">
                    {shop.logo_url ? (
                        <Image src={shop.logo_url} alt={shop.shop_name} width={80} height={80} className="w-20 h-20 rounded-2xl object-cover mx-auto shadow-lg" />
                    ) : (
                        <div className="w-20 h-20 rounded-2xl bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center mx-auto shadow-lg">
                            <span className="text-3xl font-black text-emerald-600">{shop.shop_name[0]}</span>
                        </div>
                    )}

                    <div>
                        <h1 className="text-2xl font-black text-gray-900 dark:text-white">{shop.shop_name}</h1>
                        <p className="text-muted-foreground text-sm mt-1">{shop.description || 'Data bundle shop'}</p>
                    </div>

                    <div className="w-16 h-16 rounded-full bg-yellow-100 dark:bg-yellow-900/30 flex items-center justify-center mx-auto">
                        <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-yellow-600 dark:text-yellow-500"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" /><path d="M12 9v4" /><path d="M12 17h.01" /></svg>
                    </div>

                    <div className="p-5 rounded-2xl bg-white dark:bg-gray-800 shadow-md border border-gray-100 dark:border-gray-700 space-y-2">
                        <h2 className="font-bold text-lg text-gray-900 dark:text-white">Service Maintenance</h2>
                        <p className="text-sm text-muted-foreground">
                            This shop is currently undergoing scheduled maintenance and is temporarily offline. Please check back later!
                        </p>
                    </div>

                    {shop.whatsapp_number && (
                        <a
                            href={`https://wa.me/${shop.whatsapp_number}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-[#25D366] hover:bg-[#1ebe5d] text-white font-semibold text-sm transition-colors shadow-md"
                        >
                            <svg viewBox="0 0 24 24" className="w-4 h-4 fill-current"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" /></svg>
                            Contact on WhatsApp
                        </a>
                    )}
                </div>
            </div>
        )
    }

    // Profile approved but pricing not yet approved → show Under Review page
    if (shop.pricing_status !== 'approved') {
        return (
            <div className="min-h-screen flex flex-col items-center justify-center bg-gradient-to-br from-gray-50 to-gray-100 dark:from-gray-900 dark:to-gray-800 p-6">
                <div className="max-w-md w-full text-center space-y-6">
                    {shop.logo_url ? (
                        <Image src={shop.logo_url} alt={shop.shop_name} width={80} height={80} className="w-20 h-20 rounded-2xl object-cover mx-auto shadow-lg" />
                    ) : (
                        <div className="w-20 h-20 rounded-2xl bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center mx-auto shadow-lg">
                            <span className="text-3xl font-black text-emerald-600">{shop.shop_name[0]}</span>
                        </div>
                    )}

                    <div>
                        <h1 className="text-2xl font-black text-gray-900 dark:text-white">{shop.shop_name}</h1>
                        <p className="text-muted-foreground text-sm mt-1">{shop.description || 'Data bundle shop'}</p>
                    </div>

                    <div className="w-16 h-16 rounded-full bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center mx-auto animate-pulse">
                        <span className="text-3xl">⏳</span>
                    </div>

                    <div className="p-5 rounded-2xl bg-white dark:bg-gray-800 shadow-md border border-gray-100 dark:border-gray-700 space-y-2">
                        <h2 className="font-bold text-lg text-gray-900 dark:text-white">Under Review</h2>
                        <p className="text-sm text-muted-foreground">
                            This shop is currently awaiting admin approval. Check back soon — it will be live shortly!
                        </p>
                    </div>

                    {shop.whatsapp_number && (
                        <a
                            href={`https://wa.me/${shop.whatsapp_number}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-[#25D366] hover:bg-[#1ebe5d] text-white font-semibold text-sm transition-colors shadow-md"
                        >
                            <svg viewBox="0 0 24 24" className="w-4 h-4 fill-current"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" /></svg>
                            Contact on WhatsApp
                        </a>
                    )}
                </div>
            </div>
        )
    }

    // Fetch live approved packages with shop pricing
    // Uses service-role — only selling_price is exposed to client, never cost/profit
    const { data: pricingRows } = await (supabaseAdmin
        .from('shop_pricing')
        .select('package_id, selling_price, data_packages(id, network, size, description, sort_order, is_available)')
        .eq('shop_id', shop.id) as any)

    const packages = (pricingRows || [])
        .filter((row: any) => row.data_packages?.is_available)
        .map((row: any) => ({
            id: row.data_packages.id,
            network: row.data_packages.network,
            size: row.data_packages.size,
            description: row.data_packages.description || null,
            sort_order: row.data_packages.sort_order ?? 999,
            selling_price: parseFloat(row.selling_price),
        }))
        .sort((a: any, b: any) => a.network.localeCompare(b.network) || a.sort_order - b.sort_order)

    // Append owner role to calculate correct airtime max amount limits client-side
    let ownerRole = 'customer'
    if (shop?.owner_id) {
        const { data: uData } = await supabaseAdmin.from('users').select('role').eq('id', shop.owner_id).single()
        ownerRole = (uData as any)?.role || 'customer'
    }

    const { data: adminAnnouncement } = await (supabaseAdmin as any)
        .from('system_announcements')
        .select('title, message, tone, badge_label')
        .eq('is_active', true)
        .in('visible_on', ['storefronts', 'both'])
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()

    // `tone` now carries the colour instead of it being inferred from `type`, so
    // an admin can post a red service alert and a shop owner a green one. `type`
    // stays because it still decides the default tone and the modal's fallback.
    let initialAnnouncement: {
        type: 'admin' | 'shop'
        title?: string
        message: string
        tone?: string
        badgeLabel?: string
    } | null = adminAnnouncement
        ? {
            type: 'admin' as const,
            title: (adminAnnouncement as any).title,
            message: (adminAnnouncement as any).message,
            tone: (adminAnnouncement as any).tone || 'official',
            badgeLabel: (adminAnnouncement as any).badge_label || undefined,
        }
        : null

    if (!initialAnnouncement) {
        const { data: shopAnnouncement } = await (supabaseAdmin as any)
            .from('shop_announcements')
            .select('title, message, tone')
            .eq('shop_id', shop.id)
            .eq('is_active', true)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle()

        if (shopAnnouncement) {
            initialAnnouncement = {
                type: 'shop' as const,
                title: (shopAnnouncement as any).title || undefined,
                message: (shopAnnouncement as any).message,
                tone: (shopAnnouncement as any).tone || 'shop',
            }
        }
    }

    return <ShopStorefront shop={{ ...shop, ownerRole }} packages={packages} adminSettings={adminSettingsMap} initialAnnouncement={initialAnnouncement} />
}
