/**
 * Client-side pricing cache utility
 * Reduces API calls to /api/admin/get-prices by caching prices in localStorage
 * Cache expires after 5 minutes
 */

const CACHE_KEY = 'agent_pricing_cache'
const CACHE_DURATION = 5 * 60 * 1000 // 5 minutes

export interface PricingData {
    prices: {
        '3d': number
        '14d': number
        '30d': number
        'permanent': number
    }
    oldPrices: {
        '3d': number
        '14d': number
        '30d': number
        'permanent': number
    }
    showStrikethrough: boolean
    // Which agent plans an admin has switched on. A plan is on unless its
    // agent_plan_enabled_<plan> setting is exactly 'false'.
    enabledPlans: {
        '3d': boolean
        '14d': boolean
        '30d': boolean
        'permanent': boolean
    }
    guestStorefrontUrl: string
    whatsappGroupLink: string
    whatsappChannelLink: string
    whatsappAdminNumber: string
    whatsappCommunityLink: string
    dealerPrice6m: number
    dealerPrice3m: number
}

interface CachedData extends PricingData {
    timestamp: number
}

/**
 * Get pricing data from cache or fetch from API if cache is expired/missing
 * @returns Promise<PricingData>
 */
export async function getCachedPricing(): Promise<PricingData> {
    // Check if we're in browser environment
    if (typeof window === 'undefined') {
        // Server-side: fetch directly
        return fetchPricingFromAPI()
    }

    try {
        // Check localStorage for cached pricing
        const cached = localStorage.getItem(CACHE_KEY)

        if (cached) {
            const data: CachedData = JSON.parse(cached)
            const isExpired = Date.now() - data.timestamp > CACHE_DURATION

            if (!isExpired) {
                // Return cached prices (no API call)
                return {
                    prices: data.prices,
                    oldPrices: data.oldPrices,
                    showStrikethrough: data.showStrikethrough,
                    // Caches written before plan toggles existed have no enabledPlans
                    enabledPlans: data.enabledPlans ?? { '3d': true, '14d': true, '30d': true, 'permanent': true },
                    guestStorefrontUrl: data.guestStorefrontUrl,
                    whatsappGroupLink: data.whatsappGroupLink,
                    whatsappChannelLink: data.whatsappChannelLink,
                    whatsappAdminNumber: data.whatsappAdminNumber,
                    whatsappCommunityLink: data.whatsappCommunityLink,
                    dealerPrice6m: data.dealerPrice6m ?? 0,
                    dealerPrice3m: data.dealerPrice3m ?? 0,
                }
            }
        }
    } catch (error) {
        console.error('Error reading pricing cache:', error)
        // Continue to fetch from API
    }

    // Fetch fresh prices from API
    return fetchPricingFromAPI()
}

/**
 * Fetch pricing from API and cache the result
 */
async function fetchPricingFromAPI(): Promise<PricingData> {
    const response = await fetch('/api/admin/get-prices', {
        cache: 'no-store'
    })

    if (!response.ok) {
        throw new Error('Failed to fetch pricing')
    }

    const data: PricingData = await response.json()

    // Cache the prices (only in browser)
    if (typeof window !== 'undefined') {
        try {
            const cacheData: CachedData = {
                ...data,
                timestamp: Date.now()
            }
            localStorage.setItem(CACHE_KEY, JSON.stringify(cacheData))
        } catch (error) {
            console.error('Error caching pricing:', error)
            // Non-critical error, continue anyway
        }
    }

    return data
}

/**
 * Clear the pricing cache
 * Should be called when admin updates prices
 */
export function clearPricingCache(): void {
    if (typeof window !== 'undefined') {
        try {
            localStorage.removeItem(CACHE_KEY)
            console.log('Pricing cache cleared')
        } catch (error) {
            console.error('Error clearing pricing cache:', error)
        }
    }
}

/**
 * Check if pricing cache exists and is valid
 */
export function hasCachedPricing(): boolean {
    if (typeof window === 'undefined') return false

    try {
        const cached = localStorage.getItem(CACHE_KEY)
        if (!cached) return false

        const data: CachedData = JSON.parse(cached)
        const isExpired = Date.now() - data.timestamp > CACHE_DURATION

        return !isExpired
    } catch {
        return false
    }
}
