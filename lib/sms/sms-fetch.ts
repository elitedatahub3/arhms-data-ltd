/**
 * fetch() for the /api/sms routes, tagged with which SMS account the caller
 * means.
 *
 * The SMS Platform and the shop's Customer SMS are separate products with
 * separate accounts (credits, sender IDs, contacts, records), but they share
 * the /api/sms routes and most of the components. The page decides: anything
 * under /dashboard/sms is the platform, everything else (the shop and
 * sub-agent Customer SMS panels) is the shop. A request without the header is
 * treated as the shop, so older clients keep their current behaviour.
 */

export type SmsScope = 'shop' | 'platform'

export const SMS_SCOPE_HEADER = 'x-sms-scope'

export function currentSmsScope(): SmsScope {
    if (typeof window === 'undefined') return 'shop'
    const path = window.location.pathname
    return path === '/dashboard/sms' || path.startsWith('/dashboard/sms/') ? 'platform' : 'shop'
}

export function smsFetch(input: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers)
    headers.set(SMS_SCOPE_HEADER, currentSmsScope())
    return fetch(input, { ...init, headers })
}
