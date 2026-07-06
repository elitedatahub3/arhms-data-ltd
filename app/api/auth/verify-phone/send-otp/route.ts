import { createServerClient } from '@supabase/ssr'
import { getCookieDomain } from '@/lib/supabase'
import { createClient } from '@supabase/supabase-js'
import { cookies } from 'next/headers'
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'

const bodySchema = z.object({
    phone_number: z.string().min(9).max(15).optional(),
})

export async function POST(request: NextRequest) {
    try {
        const cookieStore = await cookies()
        const supabase = createServerClient(
            process.env.NEXT_PUBLIC_SUPABASE_URL!,
            process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
            {
                cookies: {
                    getAll() { return cookieStore.getAll() },
                    setAll(cookiesToSet) {
                        const host = request.headers.get('x-forwarded-host') || request.headers.get('host') || ''
                        const domain = getCookieDomain(host.split(':')[0])
                        cookiesToSet.forEach(({ name, value, options }) => {
                            const opts = { ...options, ...(domain && { domain }) }
                            cookieStore.set(name, value, opts)
                        })
                    },
                },
            }
        )

        const { data: { user: authUser }, error: authError } = await supabase.auth.getUser()
        if (authError || !authUser) {
            console.error('[SendOTP] Auth error:', authError?.message)
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        // Parse phone_number from request body
        let submittedPhone: string | undefined
        try {
            const raw = await request.json()
            const parsed = bodySchema.safeParse(raw)
            if (parsed.success) submittedPhone = parsed.data.phone_number?.trim()
        } catch {
            // No body or invalid JSON
        }

        const adminClient = createClient(
            process.env.NEXT_PUBLIC_SUPABASE_URL!,
            process.env.SUPABASE_SERVICE_ROLE_KEY!
        )

        // If a new phone number was submitted, check uniqueness first
        if (submittedPhone) {
            const { data: existing } = await adminClient
                .from('users')
                .select('id')
                .eq('phone_number', submittedPhone)
                .neq('id', authUser.id)
                .maybeSingle()

            if (existing) {
                return NextResponse.json({ error: 'This phone number is already registered to another account.' }, { status: 409 })
            }
        }

        // Determine the phone number to save/use
        const phoneToSave = submittedPhone ?? null

        if (!phoneToSave) {
            return NextResponse.json({ error: 'Please enter your phone number.' }, { status: 400 })
        }

        // Try to update existing user record
        const { error: updateErr, data: updatedData } = await (adminClient.from('users') as any)
            .update({ phone_number: phoneToSave, phone_verified: true })
            .eq('id', authUser.id)
            .select('id')

        // If no rows were updated, user doesn't exist in public.users — insert them
        if (!updateErr && (!updatedData || updatedData.length === 0)) {
            console.warn('[SendOTP] User missing from public.users, inserting now...')
            const { error: insertErr } = await (adminClient.from('users') as any)
                .insert({
                    id: authUser.id,
                    email: authUser.email,
                    phone_number: phoneToSave,
                    phone_verified: true,
                    role: 'customer',
                    status: 'active'
                })
            if (insertErr) {
                console.error('[SendOTP] User insert error:', insertErr)
                return NextResponse.json({ error: 'Failed to save phone number. Please try again.' }, { status: 500 })
            }
        } else if (updateErr) {
            console.error('[SendOTP] Phone save error:', updateErr)
            return NextResponse.json({ error: 'Failed to save phone number. Please try again.' }, { status: 500 })
        }

        console.log('[SendOTP] Phone saved and verified for user:', authUser.id)

        // All users bypass OTP — return otpBypassed so the frontend redirects to dashboard
        const response = NextResponse.json({ success: true, otpBypassed: true })

        // Set a short-lived cookie so the middleware skips the phone-verified DB check
        // on the immediately following /dashboard redirect (prevents race condition).
        response.cookies.set('phone_just_verified', '1', {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'lax',
            maxAge: 30, // 30 seconds — enough to survive the redirect
            path: '/'
        })

        return response
    } catch (e) {
        console.error('[SendOTP] Error:', e)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
