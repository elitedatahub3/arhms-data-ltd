import { createBrowserClient as createSSRBrowserClient } from '@supabase/ssr'
import { createClient } from '@supabase/supabase-js'
import { Database } from '@/types/supabase'

// Determine cookie domain: prod uses .dataking.qzz.io or .arhmsgh.com (shared with subdomains), dev/preview uses default
export const getCookieDomain = (hostOverride?: string) => {
    let host = hostOverride
    if (!host && typeof window !== 'undefined') {
        host = window.location.hostname
    }
    if (!host && process.env.NEXT_PUBLIC_APP_URL) {
        try {
            host = new URL(process.env.NEXT_PUBLIC_APP_URL).hostname
        } catch {}
    }
    if (!host) return undefined

    // Strip port if present
    host = host.split(':')[0].toLowerCase()

    // Localhost / IP / Vercel preview: host-scoped cookies (undefined)
    if (
        host === 'localhost' ||
        host.includes('localhost') ||
        host.endsWith('.vercel.app') ||
        host === '127.0.0.1' ||
        host === '::1'
    ) {
        return undefined
    }

    if (host.endsWith('dataking.qzz.io')) {
        return '.dataking.qzz.io'
    }

    if (host.endsWith('arhmsgh.com')) {
        return '.arhmsgh.com'
    }

    return undefined
}

// Browser client — uses @supabase/ssr so cookie format matches the middleware and route handlers
export const supabase = createSSRBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
        cookies: {
            getAll() {
                if (typeof document === 'undefined') return []
                return document.cookie
                    .split('; ')
                    .filter(Boolean)
                    .map(c => {
                        const [name, ...rest] = c.split('=')
                        return { name, value: rest.join('=') }
                    })
            },
            setAll(cookiesToSet) {
                if (typeof document === 'undefined') return
                cookiesToSet.forEach(({ name, value, options }) => {
                    const cookieDomain = getCookieDomain()
                    const isHttps = typeof window !== 'undefined' && window.location.protocol === 'https:'
                    const opts = {
                        path: '/',
                        sameSite: 'lax',
                        ...(isHttps ? { secure: true } : {}),
                        ...options,
                        ...(cookieDomain ? { domain: cookieDomain } : {})
                    }
                    const optString = Object.entries(opts)
                        .map(([k, v]) => {
                            if (k === 'domain') return `Domain=${v}`
                            if (k === 'path') return `Path=${v}`
                            if (k === 'maxAge') return `Max-Age=${v}`
                            if (k === 'expires') return `Expires=${v}`
                            if (k === 'secure') return v ? 'Secure' : ''
                            if (k === 'sameSite') return `SameSite=${v}`
                            return ''
                        })
                        .filter(Boolean)
                        .join('; ')
                    document.cookie = `${name}=${value}; ${optString}`

                    // If cookie domain is active, also clear any duplicate host-only cookie when expiring
                    if (cookieDomain) {
                        const isExpired = options?.maxAge === 0 || (options?.expires && new Date(options.expires).getTime() <= Date.now())
                        if (isExpired) {
                            document.cookie = `${name}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`
                        }
                    }
                })
            },
        },
    }
)

// Factory for client components that call createBrowserClient().
// Returns the shared singleton browser client above so we don't spin up multiple
// GoTrueClient instances in the same tab.
export const createBrowserClient = () => supabase

function requireServerEnv(name: string) {
    const value = process.env[name]
    if (!value) {
        throw new Error(`${name} is not configured`)
    }
    return value
}

// Server client with service role for admin operations (bypasses RLS)
export const createServerClient = () => {
    const supabaseUrl = requireServerEnv('NEXT_PUBLIC_SUPABASE_URL')
    const supabaseServiceKey = requireServerEnv('SUPABASE_SERVICE_ROLE_KEY')

    return createClient<Database>(supabaseUrl, supabaseServiceKey, {
        auth: {
            autoRefreshToken: false,
            persistSession: false,
        },
    })
}
