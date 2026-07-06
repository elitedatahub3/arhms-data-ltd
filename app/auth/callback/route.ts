import { createServerClient } from '@supabase/ssr'
import { getCookieDomain } from '@/lib/supabase'
import { createClient } from '@supabase/supabase-js'
import { cookies } from 'next/headers'
import { NextRequest, NextResponse } from 'next/server'

export async function GET(request: NextRequest) {
    const requestUrl = new URL(request.url)
    const code = requestUrl.searchParams.get('code')
    const origin = requestUrl.origin

    if (!code) {
        // Implicit flow — fragment-based token, client-side Supabase will pick it up
        return NextResponse.redirect(new URL('/auth/verify-phone', origin))
    }

    const cookieStore = await cookies()
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
                        const host = request.headers.get('x-forwarded-host') || request.headers.get('host') || ''
                        const domain = getCookieDomain(host.split(':')[0])
                        cookiesToSet.forEach(({ name, value, options }) => {
                            const opts = { ...options, ...(domain && { domain }) }
                            cookieStore.set(name, value, opts)
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
        console.error('[OAuthCallback] Code exchange failed:', error)
        return NextResponse.redirect(new URL('/auth/login?error=oauth_failed', origin))
    }

    const adminClient = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!
    )

    try {
        // Extract name from Google OAuth metadata
        const meta = data.user.user_metadata ?? {}
        const rawName: string = meta.full_name ?? meta.name ?? ''
        const parts = rawName.trim().split(' ')
        const firstName = meta.given_name ?? parts[0] ?? ''
        const lastName  = meta.family_name ?? parts.slice(1).join(' ') ?? ''

        // Check if user already exists in public.users
        const { data: existingUser } = await adminClient
            .from('users')
            .select('id, phone_number, first_name, last_name')
            .eq('id', data.user.id)
            .maybeSingle()

        console.log('[OAuthCallback] existing user:', JSON.stringify(existingUser))

        let targetPath = '/auth/phone-setup' // default: new Google users must enter phone

        if (!existingUser) {
            // Brand new user — create their record with Google name, no phone yet
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
        } else {
            // Update name if missing
            const needsNameUpdate = !existingUser.first_name || existingUser.first_name === ''
            if (needsNameUpdate && firstName) {
                await (adminClient.from('users') as any)
                    .update({ first_name: firstName, last_name: lastName })
                    .eq('id', data.user.id)
            }

            // Returning user who already has a phone number → go straight to dashboard
            if (existingUser.phone_number && existingUser.phone_number !== '') {
                targetPath = '/dashboard'
            }
        }

        // Use a 200 HTML meta-refresh instead of 302 redirect.
        // Vercel's edge network can strip Set-Cookie headers from 302 responses,
        // causing the session cookie to be lost. A 200 with meta-refresh ensures
        // the browser stores the cookies BEFORE navigating to the next page.
        return new NextResponse(
            `<!DOCTYPE html><html><head><meta http-equiv="refresh" content="0;url=${targetPath}"><script>window.location.href = '${targetPath}';</script></head><body>Redirecting...</body></html>`,
            { status: 200, headers: { 'Content-Type': 'text/html' } }
        )

    } catch (e) {
        console.error('[OAuthCallback] Error:', e)
        return new NextResponse(
            `<!DOCTYPE html><html><head><meta http-equiv="refresh" content="0;url=/auth/phone-setup"><script>window.location.href = '/auth/phone-setup';</script></head><body>Redirecting...</body></html>`,
            { status: 200, headers: { 'Content-Type': 'text/html' } }
        )
    }
}
