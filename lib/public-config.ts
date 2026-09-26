import { unstable_cache } from 'next/cache'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { PUBLIC_CONFIG_CACHE_TAG, PUBLIC_CONFIG_REVALIDATE_SECONDS } from '@/lib/cache-tags'
import { isUssdEnabled, USSD_ENABLED_KEY } from '@/lib/ussd-availability'

type TierId = '3d' | '14d' | '30d' | 'permanent'

export interface PublicAnnouncementData {
    id: string
    title: string
    message: string
    visible_on?: string | null
}

export interface PublicConfigData {
    guestStorefrontUrl: string
    whatsappGroupLink: string
    whatsappChannelLink: string
    whatsappAdminNumber: string
    whatsappCommunityLink: string
    supportEmail: string
    footerCopyrightText: string
    footerBrandingText: string
    announcementEnabled: boolean
    announcementTitle: string
    announcementMessage: string
    upgradePrices: Record<TierId, number>
    oldUpgradePrices: Record<TierId, number>
    showPriceStrikethrough: boolean
    pageAccess: Record<string, string>
    storefrontAirtimeSettings: Record<string, string>
    activeSystemAnnouncements: PublicAnnouncementData[]
    landingRcOnlyEnabled: boolean
    /** USSD master switch, so navs can drop their short-code links. */
    ussdEnabled: boolean
}

const PUBLIC_SETTING_KEYS = [
    'guest_storefront_url',
    'whatsapp_group_link',
    'whatsapp_channel_link',
    'whatsapp_admin_number',
    'whatsapp_community_link',
    'support_email',
    'footer_copyright_text',
    'footer_branding_text',
    'announcement_enabled',
    'announcement_title',
    'announcement_message',
    'agent_upgrade_price_3d',
    'agent_upgrade_price_14d',
    'agent_upgrade_price_30d',
    'agent_upgrade_price_permanent',
    'agent_upgrade_price_3d_old',
    'agent_upgrade_price_14d_old',
    'agent_upgrade_price_30d_old',
    'agent_upgrade_price_permanent_old',
    'show_price_strikethrough',
    'page_access_dashboard',
    'page_access_data_packages',
    'page_access_orders',
    'page_access_wallet',
    'page_access_complaints',
    'page_access_notifications',
    'page_access_profile',
    'page_access_shop',
    'page_access_storefront',
    'page_access_airtime',
    'page_access_utilities',
    'storefront_airtime_enabled',
    'storefront_mashup_enabled',
    'airtime_fee_mtn_customer',
    'airtime_fee_mtn_agent',
    'airtime_fee_telecel_customer',
    'airtime_fee_telecel_agent',
    'airtime_fee_at_customer',
    'airtime_fee_at_agent',
    'airtime_min_amount',
    'airtime_max_amount',
    'airtime_enabled_mtn',
    'airtime_enabled_telecel',
    'airtime_enabled_at',
    'landing_rc_only_enabled',
    USSD_ENABLED_KEY,
] as const

const PAGE_ACCESS_KEYS = PUBLIC_SETTING_KEYS.filter(key => key.startsWith('page_access_'))
const STOREFRONT_AIRTIME_KEYS = PUBLIC_SETTING_KEYS.filter(key =>
    key === 'storefront_airtime_enabled' ||
    key === 'storefront_mashup_enabled' ||
    key.startsWith('airtime_fee_') ||
    key.startsWith('airtime_enabled_') ||
    key === 'airtime_min_amount' ||
    key === 'airtime_max_amount'
)

const fallbackConfig: PublicConfigData = {
    guestStorefrontUrl: 'https://arhmsgh.com/shop/demo',
    whatsappGroupLink: '',
    whatsappChannelLink: '',
    whatsappAdminNumber: '',
    whatsappCommunityLink: '',
    supportEmail: '',
    footerCopyrightText: '2025 ARHMS TECHNOLOGIES',
    footerBrandingText: 'ARHMS',
    announcementEnabled: false,
    announcementTitle: '',
    announcementMessage: '',
    upgradePrices: {
        '3d': 9.99,
        '14d': 49.99,
        '30d': 99.99,
        permanent: 149.99,
    },
    oldUpgradePrices: {
        '3d': 0,
        '14d': 0,
        '30d': 0,
        permanent: 0,
    },
    showPriceStrikethrough: false,
    pageAccess: {},
    storefrontAirtimeSettings: {},
    activeSystemAnnouncements: [],
    landingRcOnlyEnabled: false,
    // Matches isUssdEnabled(): when the config read fails we assume off, so a
    // dead lookup cannot advertise a service that may not be answering.
    ussdEnabled: false,
}

let publicConfigClient: SupabaseClient | null = null

function getPublicConfigClient(): SupabaseClient {
    if (!publicConfigClient) {
        const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
        const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

        if (!supabaseUrl || !anonKey) {
            throw new Error('Supabase public config environment is not configured')
        }

        publicConfigClient = createClient(supabaseUrl, anonKey, {
            auth: {
                autoRefreshToken: false,
                persistSession: false,
            },
        })
    }

    return publicConfigClient!
}

let ussdSwitchClient: SupabaseClient | null = null

/**
 * Service-role reader for the USSD master switch.
 *
 * Everything else on this config comes from public_admin_settings, an allowlist
 * view over admin_settings that the anon key is allowed to read. That view does
 * not expose ussd_enabled — the migration that adds it
 * (20260822000000_ussd_master_switch) never reached production — so the key came
 * back missing and isUssdEnabled(), which fails closed, read it as off. USSD was
 * switched ON in admin_settings the whole time: the storefront short-code card
 * showed, because the storefront loads settings with the service role, while
 * every nav gated on this config quietly dropped its USSD link and PageAccessGuard
 * answered /dashboard/shop/ussd and /dashboard/sub/ussd with "Service Maintenance".
 *
 * So the switch is read here the way the rest of the USSD stack already reads it:
 * straight from admin_settings, server-side. /api/shop/ussd/activate and
 * app/shop/[shopSlug]/page.tsx both do exactly this. A flag that decides whether a
 * live, paid service is advertised must not disagree with them over a view.
 *
 * Returns null when there is no service key, so the caller falls back to the view
 * value and the fail-closed default survives.
 */
function getUssdSwitchClient(): SupabaseClient | null {
    if (ussdSwitchClient) return ussdSwitchClient

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!supabaseUrl || !serviceKey) return null

    ussdSwitchClient = createClient(supabaseUrl, serviceKey, {
        auth: {
            autoRefreshToken: false,
            persistSession: false,
        },
    })

    return ussdSwitchClient
}

/**
 * The stored ussd_enabled value, or undefined when it could not be read at all.
 *
 * undefined is distinct from null on purpose: null means the row is genuinely
 * absent (switch off), while undefined means "ask the view instead". It never
 * throws, because a failure here must not take the whole public config down to
 * fallbackConfig — that would blank the announcement bar and every price.
 */
async function readUssdSwitchValue(): Promise<string | null | undefined> {
    const client = getUssdSwitchClient()
    if (!client) return undefined

    try {
        const { data, error } = await client
            .from('admin_settings')
            .select('value')
            .eq('key', USSD_ENABLED_KEY)
            .maybeSingle()

        if (error) throw error
        return (data as { value: string } | null)?.value ?? null
    } catch {
        console.error('[PublicConfig] Unable to read the USSD master switch; falling back to the public view')
        return undefined
    }
}

function mapRows(rows: Array<{ key: string; value: string }>) {
    return rows.reduce<Record<string, string>>((acc, row) => {
        acc[row.key] = row.value
        return acc
    }, {})
}

function parsePrice(value: string | undefined, fallback: number) {
    const parsed = Number.parseFloat(value || '')
    return Number.isFinite(parsed) ? parsed : fallback
}

async function fetchPublicConfig(): Promise<PublicConfigData> {
    try {
        const supabase = getPublicConfigClient()
        const [{ data: settingsRows, error: settingsError }, { data: announcementRows, error: announcementsError }, ussdSwitchValue] = await Promise.all([
            supabase
                .from('public_admin_settings')
                .select('key, value')
                .in('key', [...PUBLIC_SETTING_KEYS]),
            supabase
                .from('system_announcements')
                .select('id, title, message, visible_on')
                .eq('is_active', true)
                .in('visible_on', ['main_site', 'storefronts', 'both'])
                .order('created_at', { ascending: false })
                .limit(20),
            readUssdSwitchValue(),
        ])

        if (settingsError) throw settingsError
        if (announcementsError) throw announcementsError

        const settings = mapRows((settingsRows || []) as Array<{ key: string; value: string }>)

        // admin_settings wins whenever it could be read; the view is the fallback,
        // and both go through isUssdEnabled so "off" still means anything that is
        // not exactly the string 'true'.
        const ussdEnabled = isUssdEnabled(
            ussdSwitchValue !== undefined ? { [USSD_ENABLED_KEY]: ussdSwitchValue } : settings
        )

        const pageAccess = PAGE_ACCESS_KEYS.reduce<Record<string, string>>((acc, key) => {
            if (settings[key]) acc[key] = settings[key]
            return acc
        }, {})
        const storefrontAirtimeSettings = STOREFRONT_AIRTIME_KEYS.reduce<Record<string, string>>((acc, key) => {
            if (settings[key]) acc[key] = settings[key]
            return acc
        }, {})

        return {
            guestStorefrontUrl: settings.guest_storefront_url || fallbackConfig.guestStorefrontUrl,
            whatsappGroupLink: settings.whatsapp_group_link || '',
            whatsappChannelLink: settings.whatsapp_channel_link || '',
            whatsappAdminNumber: settings.whatsapp_admin_number || '',
            whatsappCommunityLink: settings.whatsapp_community_link || '',
            supportEmail: settings.support_email || '',
            footerCopyrightText: settings.footer_copyright_text || fallbackConfig.footerCopyrightText,
            footerBrandingText: settings.footer_branding_text || fallbackConfig.footerBrandingText,
            announcementEnabled: settings.announcement_enabled === 'true',
            announcementTitle: settings.announcement_title || '',
            announcementMessage: settings.announcement_message || '',
            upgradePrices: {
                '3d': parsePrice(settings.agent_upgrade_price_3d, fallbackConfig.upgradePrices['3d']),
                '14d': parsePrice(settings.agent_upgrade_price_14d, fallbackConfig.upgradePrices['14d']),
                '30d': parsePrice(settings.agent_upgrade_price_30d, fallbackConfig.upgradePrices['30d']),
                permanent: parsePrice(settings.agent_upgrade_price_permanent, fallbackConfig.upgradePrices.permanent),
            },
            oldUpgradePrices: {
                '3d': parsePrice(settings.agent_upgrade_price_3d_old, 0),
                '14d': parsePrice(settings.agent_upgrade_price_14d_old, 0),
                '30d': parsePrice(settings.agent_upgrade_price_30d_old, 0),
                permanent: parsePrice(settings.agent_upgrade_price_permanent_old, 0),
            },
            showPriceStrikethrough: settings.show_price_strikethrough === 'true',
            pageAccess,
            storefrontAirtimeSettings,
            activeSystemAnnouncements: ((announcementRows || []) as PublicAnnouncementData[]).map(announcement => ({
                id: announcement.id,
                title: announcement.title,
                message: announcement.message,
                visible_on: announcement.visible_on,
            })),
            landingRcOnlyEnabled: settings.landing_rc_only_enabled === 'true',
            ussdEnabled,
        }
    } catch {
        console.error('[PublicConfig] Unable to fetch public config; using fallback values')
        return fallbackConfig
    }
}

export const getCachedPublicConfig = unstable_cache(
    fetchPublicConfig,
    // v3: added ussdEnabled. Bumped so a cache entry written by the previous
    // deploy cannot answer with the field missing.
    // v4: ussdEnabled now comes from admin_settings rather than the public view,
    // where it read false for every caller. Bumped so the USSD links come back on
    // deploy instead of waiting out a cached 'off'.
    ['public-config-v4'],
    {
        revalidate: PUBLIC_CONFIG_REVALIDATE_SECONDS,
        tags: [PUBLIC_CONFIG_CACHE_TAG],
    }
)

export async function getPublicConfig(): Promise<PublicConfigData> {
    return getCachedPublicConfig()
}
