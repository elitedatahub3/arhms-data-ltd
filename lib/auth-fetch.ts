import { supabase } from '@/lib/supabase'

/**
 * Cookies remain the primary credential. The Authorization header covers phones
 * where the browser client holds a valid session but the server cannot use the
 * cookie one — which turned every cookie-only route into a 401 "Unauthorized"
 * (the dealer Shop page) while the rest of the dashboard kept working.
 * lib/supabase-server.ts falls back to this token only when the cookie fails.
 */

/** Same-origin API paths that should carry the session token. */
function wantsSessionToken(url: URL): boolean {
    if (url.origin !== window.location.origin) return false
    if (!url.pathname.startsWith('/api/')) return false
    // The developer API authenticates with the partner's API key — never add ours.
    if (url.pathname.startsWith('/api/v1/') || url.pathname.startsWith('/api/v2/')) return false
    return true
}

let installed = false

/**
 * Makes every same-origin /api/ fetch carry the session token, so the Bearer
 * fallback in lib/supabase-server.ts covers the whole app instead of one page.
 * Called once from the auth provider. Idempotent; a no-op on the server.
 */
export function installAuthFetch(): void {
    if (installed || typeof window === 'undefined') return
    installed = true

    const nativeFetch = window.fetch.bind(window)
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        try {
            const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
            const url = new URL(raw, window.location.href)
            const existing = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
            if (wantsSessionToken(url) && !existing.has('Authorization')) {
                const { data } = await supabase.auth.getSession()
                const token = data.session?.access_token
                if (token) {
                    existing.set('Authorization', `Bearer ${token}`)
                    if (input instanceof Request) return nativeFetch(new Request(input, { ...init, headers: existing }))
                    return nativeFetch(input, { ...init, headers: existing })
                }
            }
        } catch {
            // Never let the token lookup break a request — fall through untouched.
        }
        return nativeFetch(input, init)
    }
}
