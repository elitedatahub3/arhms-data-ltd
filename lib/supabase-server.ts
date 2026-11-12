import { createServerClient } from '@supabase/ssr'
import { cookies, headers } from 'next/headers'
import { Database } from '@/types/supabase'

/**
 * Drop-in async replacement for createRouteHandlerClient from @supabase/auth-helpers-nextjs.
 * Uses @supabase/ssr so the cookie format matches the middleware and browser client.
 *
 * Bearer fallback: some phones end up with a valid session in the browser client
 * but no cookie session the server can use, and every cookie-only route then
 * answers 401 "Unauthorized" while the rest of the dashboard works (seen on the
 * dealer Shop page). A page that sends `Authorization: Bearer <access token>`
 * (lib/auth-fetch.ts) is authenticated by that token whenever the cookie session
 * fails — for auth.getUser() and for RLS reads alike. Requests without the header
 * behave exactly as before.
 *
 * Usage:  const supabase = await createRouteHandlerClient()
 */
export async function createRouteHandlerClient(_options?: any) {
    const cookieStore = await cookies()

    let bearer: string | null = null
    try {
        const auth = (await headers()).get('authorization') || ''
        if (auth.startsWith('Bearer ')) bearer = auth.slice(7).trim() || null
    } catch {
        // No request scope (e.g. called outside a route handler) — cookie-only.
    }

    const client = createServerClient<Database>(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        {
            ...(bearer ? { global: { headers: { Authorization: `Bearer ${bearer}` } } } : {}),
            cookies: {
                getAll() {
                    return cookieStore.getAll()
                },
                setAll(cookiesToSet) {
                    cookiesToSet.forEach(({ name, value, options }) => {
                        try { cookieStore.set(name, value, options) } catch {}
                    })
                },
            },
        }
    )

    if (bearer) {
        // getUser() with no argument reads the cookie session only. Try that first,
        // then verify the header token with the auth server — never trusted unchecked.
        const cookieGetUser = client.auth.getUser.bind(client.auth)
        client.auth.getUser = (async (jwt?: string) => {
            if (jwt) return cookieGetUser(jwt)
            const fromCookie = await cookieGetUser()
            if (fromCookie.data?.user) return fromCookie
            return cookieGetUser(bearer!)
        }) as typeof client.auth.getUser
    }

    return client
}

// Alias kept for backward-compat with existing imports of createRouteClient
export const createRouteClient = createRouteHandlerClient
