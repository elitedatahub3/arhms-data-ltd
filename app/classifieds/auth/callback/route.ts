import { createServerClient } from '@supabase/ssr'
import { createClient } from '@supabase/supabase-js'
import { cookies } from 'next/headers'
import { NextRequest, NextResponse } from 'next/server'

/**
 * Marketplace OAuth callback (marketplace.arhmsgh.com).
 *
 * Mirrors app/auth/callback/route.ts but keeps the user on the marketplace:
 * it exchanges the code, upserts the public.users row from Google metadata so
 * useAuth().dbUser is populated, then meta-refreshes to the `next` path (the
 * tab the user originally wanted) instead of the main-app dashboard. Marketplace
 * buyers skip the phone-setup step entirely.
 *
 * The 200 HTML meta-refresh (not a 302) is deliberate — Vercel's edge can strip
 * Set-Cookie from 302 responses, losing the session.
 */

const LOGIN = '/classifieds/auth/login'

// Only allow internal, single-slash paths as the post-login destination to
// avoid open redirects (e.g. reject `//evil.com` and absolute URLs).
function safeNext(raw: string | null): string {
    if (!raw || !raw.startsWith('/') || raw.startsWith('//')) return '/classifieds'
    return raw
}

export async function GET(request: NextRequest) {
    const requestUrl = new URL(request.url)
    const code = requestUrl.searchParams.get('code')
    const origin = requestUrl.origin

    if (!code) {
        return NextResponse.redirect(new URL(`${LOGIN}?error=oauth_failed`, origin))
    }

    const cookieStore = await cookies()
    // Return path comes from the cookie set before OAuth (see GoogleSignInButton),
    // falling back to a legacy ?next= query for safety. Default: marketplace home.
    const nextCookie = cookieStore.get('mkt_oauth_next')?.value
    const next = safeNext(
        nextCookie ? decodeURIComponent(nextCookie) : requestUrl.searchParams.get('next')
    )
    const supabase = createServerClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        {
            cookies: {
                getAll() {
                    return cookieStore.getAll()
                },
                setAll(cookiesToSet) {
                    try {
                        cookiesToSet.forEach(({ name, value, options }) => {
                            cookieStore.set(name, value, options)
                        })
                    } catch {
                        // The `set` method was called from a Server Component.
                    }
                },
            },
        }
    )

    const { data, error } = await supabase.auth.exchangeCodeForSession(code)

    if (error || !data.user) {
        console.error('[MarketplaceOAuthCallback] Code exchange failed:', error)
        return NextResponse.redirect(new URL(`${LOGIN}?error=oauth_failed`, origin))
    }

    try {
        // Extract name from Google OAuth metadata
        const meta = data.user.user_metadata ?? {}
        const rawName: string = meta.full_name ?? meta.name ?? ''
        const parts = rawName.trim().split(' ')
        const firstName = meta.given_name ?? parts[0] ?? ''
        const lastName = meta.family_name ?? parts.slice(1).join(' ') ?? ''

        const adminClient = createClient(
            process.env.NEXT_PUBLIC_SUPABASE_URL!,
            process.env.SUPABASE_SERVICE_ROLE_KEY!
        )

        const { data: existingUser } = await adminClient
            .from('users')
            .select('id, first_name')
            .eq('id', data.user.id)
            .maybeSingle()

        if (!existingUser) {
            // Brand new marketplace user — create their record with Google name.
            // No phone yet; the become-seller flow collects it if they ever sell.
            await (adminClient.from('users') as any).insert({
                id: data.user.id,
                email: data.user.email,
                first_name: firstName,
                last_name: lastName,
                phone_number: '',
                phone_verified: false,
                role: 'customer',
                status: 'active',
            })
        } else if (!existingUser.first_name && firstName) {
            await (adminClient.from('users') as any)
                .update({ first_name: firstName, last_name: lastName })
                .eq('id', data.user.id)
        }
    } catch (e) {
        // A profile-row hiccup shouldn't strand the user — the session is already
        // set; send them into the marketplace anyway.
        console.error('[MarketplaceOAuthCallback] Profile upsert error:', e)
    }

    const response = new NextResponse(
        `<!DOCTYPE html><html><head><meta http-equiv="refresh" content="0;url=${next}"><script>window.location.href = ${JSON.stringify(next)};</script></head><body>Redirecting...</body></html>`,
        { status: 200, headers: { 'Content-Type': 'text/html' } }
    )
    // Consume the one-time return-path cookie.
    response.cookies.set('mkt_oauth_next', '', { maxAge: 0, path: '/' })
    return response
}
