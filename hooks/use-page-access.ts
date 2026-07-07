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
    '/dashboard/airtime': 'airtime',
}

export function usePageAccess() {
    const [pageAccess, setPageAccess] = useState<PageAccessSettings>({
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
    })
    const [loading, setLoading] = useState(true)

    useEffect(() => {
        fetchPageAccess()
    }, [])

    const fetchPageAccess = async () => {
        try {
            const response = await fetch('/api/settings/page-access', { cache: 'no-store' })
            if (!response.ok) throw new Error('Failed to fetch settings')
            const settingsMap = await response.json()

            setPageAccess({
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
            })
        } catch (error) {
            console.error('Error fetching page access settings:', error)
            // On error, default to all pages accessible
        } finally {
            setLoading(false)
        }
    }

    const isPageAccessible = (route: string): boolean => {
        // Find best match allowing prefixes for shop routes
        if (route.startsWith('/dashboard/shop')) {
            return pageAccess.shop
        }

        const pageKey = PAGE_ROUTE_MAP[route]
        return pageKey ? pageAccess[pageKey] : true
    }

    return { pageAccess, isPageAccessible, loading }
}
