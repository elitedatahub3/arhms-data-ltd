import { getPublicConfig } from '@/lib/public-config'
import { createServerClient } from '@/lib/supabase'
import dynamic from 'next/dynamic'
import { unstable_cache } from 'next/cache'

// Lazy-load the 44KB LandingClientShell so it's split into a separate
// JS chunk — prevents tab crashes on low-end phones with 512MB RAM
const LandingClientShell = dynamic(
    () => import('@/components/landing/LandingClientShell').then(m => ({ default: m.LandingClientShell })),
    { loading: () => null }
)

// Alternate homepage that advertises only the Results Checker product.
// Rendered when the `landing_rc_only_enabled` admin toggle is ON.
const ResultCheckerLanding = dynamic(
    () => import('@/components/landing/ResultCheckerLanding').then(m => ({ default: m.ResultCheckerLanding })),
    { loading: () => null }
)

// Refresh every 10 minutes so a new approved shop is picked up quickly.
// NOTE: the root layout opts every route out of static rendering, so this export
// on its own never cached anything — each landing view re-ran the queries below.
// The data is cached explicitly with unstable_cache instead.
export const revalidate = 600
const LANDING_DATA_REVALIDATE_SECONDS = 600

// The oldest approved, active, priced shop — the fallback "Buy as Guest" target.
// Null when there is none; throws on a real query error so it isn't cached.
const getCachedFallbackShopSlug = unstable_cache(
    async (): Promise<string | null> => {
        const supabaseAdmin = createServerClient()
        const { data: shop, error } = await (supabaseAdmin
            .from('shop_profiles')
            .select('shop_slug')
            .eq('approval_status', 'approved')
            .eq('is_active', true)
            .eq('pricing_status', 'approved')
            .order('created_at', { ascending: true })
            .limit(1)
            .maybeSingle() as any)
        if (error) throw error
        return shop?.shop_slug ?? null
    },
    ['landing-fallback-shop-slug-v1'],
    { revalidate: LANDING_DATA_REVALIDATE_SECONDS }
)

export default async function HomePage() {
    // Fetch public config server-side — serializable data only passed to client
    const config = await getPublicConfig()

    // When the admin toggle is ON, the homepage advertises only the Results
    // Checker product. No guest-store resolution is needed — the CTA links
    // straight to /dashboard/results-checker.
    if (config.landingRcOnlyEnabled) {
        return (
            <ResultCheckerLanding
                initialAdminPhone={config.whatsappAdminNumber}
                initialWhatsappGroupLink={config.whatsappGroupLink}
                initialWhatsappChannelLink={config.whatsappChannelLink}
            />
        )
    }

    // Resolve the guest store URL:
    // 1. Use the admin-configured URL if it's set and not the placeholder
    // 2. Otherwise fall back to the first approved, active shop in the database
    // 3. Otherwise leave empty (button stays hidden)
    let guestUrl = config.guestStorefrontUrl
    const isPlaceholder = !guestUrl || guestUrl.endsWith('/shop/demo')

    if (isPlaceholder) {
        try {
            const shopSlug = await getCachedFallbackShopSlug()

            if (shopSlug) {
                const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://arhmsgh.com'
                guestUrl = `${baseUrl}/shop/${shopSlug}`
            } else {
                guestUrl = ''
            }
        } catch {
            guestUrl = ''
        }
    }

    return (
        <LandingClientShell
            initialGuestUrl={guestUrl}
            initialAdminPhone={config.whatsappAdminNumber}
            initialPlanPrices={config.upgradePrices}
            initialWhatsappGroupLink={config.whatsappGroupLink}
            initialWhatsappChannelLink={config.whatsappChannelLink}
        />
    )
}
