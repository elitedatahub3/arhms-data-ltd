import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { Database } from '@/types/supabase'

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
                    // For app directory, headers() cannot be easily injected here
                    // However, we just need domain handling if possible.
                    // Best practice for nextjs app router server components is to just use standard setAll
                    // or inject the domain properly. Since it's server side, let's leave as is for now
                    // since it's mostly route handlers and middleware doing the login setting.
                    cookiesToSet.forEach(({ name, value, options }) => {
                        try { cookieStore.set(name, value, options) } catch {}
                    })
                },
            },
        }
    )
}

// Alias kept for backward-compat with existing imports of createRouteClient
export const createRouteClient = createRouteHandlerClient
