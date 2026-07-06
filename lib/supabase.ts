import { createBrowserClient as createSSRBrowserClient } from '@supabase/ssr'
import { createClient } from '@supabase/supabase-js'
import { Database } from '@/types/supabase'

// Determine cookie domain: prod uses .arhmsgh.com (shared with subdomains), dev/preview uses default
export const getCookieDomain = (hostOverride?: string) => {
    if (typeof window === 'undefined' && !hostOverride) return undefined
    const host = hostOverride || window.location.hostname
    
    if (host.endsWith('arhmsgh.com')) {
        return '.arhmsgh.com'
    }
    if (host.endsWith('dataking.qzz.io')) {
        return '.dataking.qzz.io'  // ← ADD THIS
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
                    const opts = { ...options, ...(cookieDomain && { domain: cookieDomain }) }
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
                })
            },
        },
    }
)

// Factory used by marketplace client components (they call createBrowserClient()).
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
