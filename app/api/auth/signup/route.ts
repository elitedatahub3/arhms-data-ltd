import { createServerClient } from '@supabase/ssr'
import { getCookieDomain } from '@/lib/supabase'
import { cookies } from 'next/headers'
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { nameSchema, phoneSchema, emailSchema } from '@/lib/validation'
import { sendWelcomeEmail, sendAdminNewUserAlert } from '@/lib/email-service'
import { sendWelcomeSMS } from '@/lib/sms-service'

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()

    const signupSchema = z.object({
      email: emailSchema,
      password: z.string().min(8, 'Password must be at least 8 characters'),
      firstName: nameSchema,
      lastName: nameSchema,
      phoneNumber: phoneSchema
    })

    const validation = signupSchema.safeParse(body)
    if (!validation.success) {
      const errorDetails = validation.error.errors.map(err => `${err.path.join('.')}: ${err.message}`)
      return NextResponse.json({ error: 'Invalid input', details: errorDetails }, { status: 400 })
    }

    const { email, password, firstName, lastName, phoneNumber } = validation.data

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
              // This can be ignored if you have middleware refreshing
              // user sessions.
            }
          },
        },
      }
    )

    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          first_name: firstName,
          last_name: lastName,
          phone_number: phoneNumber,
        },
      },
    })

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 400 })
    }

    sendWelcomeEmail(email, firstName)
      .catch(err => console.error('[Signup] Welcome email failed:', err))

    sendWelcomeSMS(phoneNumber, firstName)
      .catch(err => console.error('[Signup] Welcome SMS failed:', err))

    sendAdminNewUserAlert({
      firstName,
      lastName,
      email,
      phoneNumber
    }).catch(err => console.error('[Signup] Admin new user alert failed:', err))

    import('@/lib/web-push').then(({ sendPushToAdmins }) => {
      sendPushToAdmins({
        title: 'New User Registration 🎉',
        body: `${firstName} ${lastName} just created an account!`,
        url: '/admin/users'
      }).catch(err => console.error('[Signup] Admin push alert failed:', err))
    })

    import('@/lib/notification-service').then(({ notifyAllAdmins }) => {
      notifyAllAdmins({
        title: 'New User Registration 🎉',
        message: `${firstName} ${lastName} (${phoneNumber}) just created a new account.`,
        type: 'system',
        actionUrl: '/admin/users'
      }).catch(err => console.error('[Signup] Admin in-app notification failed:', err))
    })

    return NextResponse.json({ user: data.user, session: data.session })
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
