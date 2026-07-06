import { createServerClient } from '@supabase/ssr'
import { getCookieDomain } from '@/lib/supabase'
import { createClient } from '@supabase/supabase-js'
import { cookies } from 'next/headers'
import { NextRequest, NextResponse } from 'next/server'
import { Redis } from '@upstash/redis'
import { z } from 'zod'

let redis: Redis | null = null
try {
    redis = Redis.fromEnv()
} catch {
    console.error('[ConfirmOTP] Redis init failed')
}

const otpSchema = z.object({
    otp: z.string().length(6).regex(/^\d{6}$/, 'OTP must be a 6-digit number')
})

export async function POST(request: NextRequest) {
    try {
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
                        } catch {}
                    },
                },
            }
        )

        const { data: { user: authUser }, error: authError } = await supabase.auth.getUser()
        if (authError || !authUser) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const body = await request.json()
        const validation = otpSchema.safeParse(body)
        if (!validation.success) {
            return NextResponse.json({ error: 'OTP must be a 6-digit number' }, { status: 400 })
        }

        const { otp } = validation.data

        if (!redis) {
            return NextResponse.json({ error: 'Verification service unavailable. Please try again.' }, { status: 503 })
        }

        const storedOtp = await redis.get<string>(`otp:${authUser.id}`)

        if (!storedOtp) {
            return NextResponse.json({ error: 'OTP has expired. Please request a new one.' }, { status: 410 })
        }

        if (String(storedOtp) !== String(otp)) {
            return NextResponse.json({ error: 'Incorrect OTP. Please try again.' }, { status: 400 })
        }

        // OTP valid — delete immediately (single use)
        await redis.del(`otp:${authUser.id}`)

        const adminClient = createClient(
            process.env.NEXT_PUBLIC_SUPABASE_URL!,
            process.env.SUPABASE_SERVICE_ROLE_KEY!
        )

        const { error: updateError } = await (adminClient.from('users') as any)
            .update({
                phone_verified: true,
                updated_at: new Date().toISOString(),
            })
            .eq('id', authUser.id)

        if (updateError) {
            console.error('[ConfirmOTP] DB update error:', updateError)
            return NextResponse.json({ error: 'Verification failed. Please contact support.' }, { status: 500 })
        }

        const successResponse = NextResponse.json({ success: true, message: 'Phone number verified successfully' })
        // Set a short-lived cookie so the middleware can skip the phone-verified DB check
        // on the immediately following /dashboard redirect (prevents race condition).
        successResponse.cookies.set('phone_just_verified', '1', {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'lax',
            maxAge: 10, // 10 seconds — just long enough to survive the redirect
            path: '/'
        })
        return successResponse
    } catch (e) {
        console.error('[ConfirmOTP] Error:', e)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
