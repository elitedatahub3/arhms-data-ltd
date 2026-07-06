import { createServerClient } from '@supabase/ssr'
import { getCookieDomain } from '@/lib/supabase'
import { createClient } from '@supabase/supabase-js'
import { cookies } from 'next/headers'
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { nameSchema, phoneSchema } from '@/lib/validation'

const schema = z.object({
    first_name: nameSchema,
    last_name: nameSchema,
    phone_number: phoneSchema,
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
        const validation = schema.safeParse(body)
        if (!validation.success) {
            const details = validation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`)
            return NextResponse.json({ error: 'Invalid input', details }, { status: 400 })
        }

        const { first_name, last_name, phone_number } = validation.data

        const adminClient = createClient(
            process.env.NEXT_PUBLIC_SUPABASE_URL!,
            process.env.SUPABASE_SERVICE_ROLE_KEY!
        )

        // Check phone uniqueness
        const { data: existing } = await adminClient
            .from('users')
            .select('id')
            .eq('phone_number', phone_number.trim())
            .neq('id', authUser.id)
            .single()

        if (existing) {
            return NextResponse.json({ error: 'This phone number is already registered to another account' }, { status: 409 })
        }

        // Check if user exists in public.users
        const { data: currentUser } = await adminClient
            .from('users')
            .select('id')
            .eq('id', authUser.id)
            .single()

        let updateError;

        if (currentUser) {
            const { error } = await (adminClient.from('users') as any)
                .update({
                    first_name: first_name.trim(),
                    last_name: last_name.trim(),
                    phone_number: phone_number.trim(),
                    phone_verified: true,
                    updated_at: new Date().toISOString(),
                })
                .eq('id', authUser.id)
            updateError = error;
        } else {
            const { error } = await (adminClient.from('users') as any)
                .insert({
                    id: authUser.id,
                    email: authUser.email,
                    first_name: first_name.trim(),
                    last_name: last_name.trim(),
                    phone_number: phone_number.trim(),
                    phone_verified: true,
                    role: 'customer',
                    status: 'active',
                    updated_at: new Date().toISOString(),
                })
            updateError = error;
        }

        if (updateError) {
            console.error('[CompleteProfile] DB update error:', updateError)
            return NextResponse.json({ error: 'Failed to save profile' }, { status: 500 })
        }

        return NextResponse.json({ success: true })
    } catch (e) {
        console.error('[CompleteProfile] Error:', e)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
