import { createServerClient } from '@supabase/ssr'
import { getCookieDomain } from '@/lib/supabase'
import { cookies } from 'next/headers'
import { NextRequest, NextResponse } from 'next/server'

export async function POST(request: NextRequest) {
  try {
    const { email } = await request.json()

    if (!email) {
      return NextResponse.json({ error: 'Email is required' }, { status: 400 })
    }

    const host = request.headers.get('x-forwarded-host') || request.headers.get('host') || ''
    const domain = getCookieDomain(host.split(':')[0])
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
                        cookiesToSet.forEach(({ name, value, options }) => {
                            const opts = { path: '/', ...options, ...(domain && { domain }) }
                            cookieStore.set(name, value, opts)
                        })
                    } catch {}
                },
            },
        }
    )

    const siteBase = process.env.NEXT_PUBLIC_SITE_URL || process.env.NEXT_PUBLIC_APP_URL || (host ? `https://${host}` : 'https://www.dataking.qzz.io')
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${siteBase}/auth/update-password`
    })

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 400 })
    }

    return NextResponse.json({ message: 'Password reset email sent' })
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
