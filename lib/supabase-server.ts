import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { Database } from '@/types/supabase'

import { getCookieDomain } from '@/lib/supabase'

/**
 * Drop-in async replacement for createRouteHandlerClient from @supabase/auth-helpers-nextjs.
 * Uses @supabase/ssr so the cookie format matches the middleware and browser client.
 *
 * Usage:  const supabase = await createRouteHandlerClient()
 */
export async function createRouteHandlerClient(_options?: any) {
    const cookieStore = await cookies()
    return createServerClient<Database>(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        {
            cookies: {
                getAll() {
                    return cookieStore.getAll()
                },
                setAll(cookiesToSet) {
                    const domain = getCookieDomain()
                    cookiesToSet.forEach(({ name, value, options }) => {
                        try {
                            const opts = { path: '/', ...options, ...(domain && { domain }) }
                            cookieStore.set(name, value, opts)
                        } catch {}
                    })
                },
            },
        }
    )
}

// Alias kept for backward-compat with existing imports of createRouteClient
export const createRouteClient = createRouteHandlerClient
