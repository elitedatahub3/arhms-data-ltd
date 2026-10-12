/**
 * Base URL for callbacks a gateway's SERVER posts to (not browser redirects).
 *
 * NEXT_PUBLIC_APP_URL is https://www.arhmsgh.com, and www answers every path with
 * a 307 to the apex. Browsers follow that; payment gateways do not, so a callback
 * sent to www is dropped at the redirect and the payment waits for a sweep. That
 * is how the Paystack webhook went silent in October 2026. Server callbacks are
 * therefore always built on the apex host.
 */
export function webhookBaseUrl(): string {
    const raw = process.env.NEXT_PUBLIC_APP_URL || 'https://arhmsgh.com'
    try {
        const url = new URL(raw)
        url.hostname = url.hostname.replace(/^www\./, '')
        return url.origin
    } catch {
        return 'https://arhmsgh.com'
    }
}
