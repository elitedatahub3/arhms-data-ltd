import { apexBaseUrl } from './webhook-base-url'

/**
 * Public storefront link for a shop, e.g. https://arhmsgh.com/shop/felix-s-shop.
 * Built on the apex host so shared links and QR scans skip the www -> apex 307.
 * Falls back to the current origin locally / on preview where the env var is unset.
 */
export function shopUrl(slug: string): string {
    const base = apexBaseUrl() ?? (typeof window !== 'undefined' ? window.location.origin : 'https://arhmsgh.com')
    return `${base}/shop/${slug}`
}
