import { useEffect, useState } from 'react'

export interface PageAccessSettings {
    dashboard: boolean
    dataPackages: boolean
    orders: boolean
    wallet: boolean
    complaints: boolean
    notifications: boolean
    profile: boolean
    shop: boolean
    storefront: boolean
    airtime: boolean
    utilities: boolean
    /**
     * USSD master switch, not a page-access toggle — it rides here because this
     * hook is the single settings fetch every nav already makes.
     */
    ussd: boolean
}

const PAGE_ROUTE_MAP: Record<string, keyof PageAccessSettings> = {
    '/dashboard': 'dashboard',
    '/dashboard/data-packages': 'dataPackages',
    '/dashboard/my-orders': 'orders',
    '/dashboard/wallet': 'wallet',
    '/dashboard/complaints': 'complaints',
    '/dashboard/notifications': 'notifications',
    '/dashboard/profile': 'profile',
    '/dashboard/shop': 'shop',
    '/dashboard/shop/ussd': 'ussd',
    '/dashboard/sub/ussd': 'ussd',
    '/dashboard/airtime': 'airtime',
    '/dashboard/utilities': 'utilities',
}

function sameSettings(a: PageAccessSettings, b: PageAccessSettings): boolean {
    return (Object.keys(b) as Array<keyof PageAccessSettings>).every(k => a[k] === b[k])
}

const DEFAULT_PAGE_ACCESS: PageAccessSettings = {
    dashboard: true,
    dataPackages: true,
    orders: true,
    wallet: true,
    complaints: true,
    notifications: true,
    profile: true,
    shop: true,
    storefront: true,
    airtime: true,
    utilities: true,
    // The only flag that starts closed: the others default open so a slow
    // fetch does not blank the nav, but a USSD link shown for a second and
    // then withdrawn is worse than one that never appears.
    ussd: false,
}

/**
 * One fetch shared by every caller. The sidebar, the bottom nav and the page
 * guard all mount this hook at once, and each used to fire its own no-store
 * request — and the guard showed a skeleton until its copy landed. The result
 * is kept for the page's lifetime and quietly re-checked once it is a minute
 * old, so an admin toggle still takes effect on the next navigation.
 */
const REVALIDATE_AFTER_MS = 60_000
let cached: { value: PageAccessSettings; at: number } | null = null
let inflight: Promise<PageAccessSettings | null> | null = null

function loadPageAccess(): Promise<PageAccessSettings | null> {
    if (inflight) return inflight
    inflight = (async () => {
        try {
            const response = await fetch('/api/settings/page-access', { cache: 'no-store' })
            if (!response.ok) throw new Error('Failed to fetch settings')
            const settingsMap = await response.json()

            const value: PageAccessSettings = {
                dashboard: settingsMap.page_access_dashboard !== 'false',
                dataPackages: settingsMap.page_access_data_packages !== 'false',
                orders: settingsMap.page_access_orders !== 'false',
                wallet: settingsMap.page_access_wallet !== 'false',
                complaints: settingsMap.page_access_complaints !== 'false',
                notifications: settingsMap.page_access_notifications !== 'false',
                profile: settingsMap.page_access_profile !== 'false',
                shop: settingsMap.page_access_shop !== 'false',
                storefront: settingsMap.page_access_storefront !== 'false',
                airtime: settingsMap.page_access_airtime !== 'false',
                utilities: settingsMap.page_access_utilities !== 'false',
                ussd: settingsMap.ussd_enabled === 'true',
            }
            cached = { value, at: Date.now() }
            return value
        } catch (error) {
            console.error('Error fetching page access settings:', error)
            // On error, keep the defaults: every page accessible, USSD off. Not
            // cached, so the next mount tries again.
            return null
        } finally {
            inflight = null
        }
    })()
    return inflight
}

export function usePageAccess() {
    const [pageAccess, setPageAccess] = useState<PageAccessSettings>(cached?.value ?? DEFAULT_PAGE_ACCESS)
    const [loading, setLoading] = useState(!cached)

    useEffect(() => {
        if (cached && Date.now() - cached.at < REVALIDATE_AFTER_MS) return
        let active = true
        loadPageAccess().then(value => {
            if (!active) return
            if (value) setPageAccess(prev => (sameSettings(prev, value) ? prev : value))
            setLoading(false)
        })
        return () => { active = false }
    }, [])

    const isPageAccessible = (route: string): boolean => {
        // Exact matches first: /dashboard/shop/ussd has its own switch, and the
        // shop prefix below would otherwise swallow it.
        const exact = PAGE_ROUTE_MAP[route]
        if (exact) return pageAccess[exact]

        // Then prefixes, so /dashboard/shop/pricing follows the shop toggle.
        if (route.startsWith('/dashboard/shop')) {
            return pageAccess.shop
        }

        return true
    }

    return { pageAccess, isPageAccessible, loading }
}
