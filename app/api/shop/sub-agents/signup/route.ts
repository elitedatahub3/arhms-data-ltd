import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { Ratelimit } from '@upstash/ratelimit'
import { Redis } from '@upstash/redis'

let signupRateLimit: Ratelimit | null = null
try {
  signupRateLimit = new Ratelimit({
    redis: Redis.fromEnv(),
    limiter: Ratelimit.slidingWindow(3, '1 h'),
    prefix: 'rl:sub-signup',
  })
} catch (e) {
  console.error('[SubAgentSignup] Redis init failed:', e)
}

/**
 * POST /api/shop/sub-agents/signup
 *
 * Sub-agent signup:
 *   1. Validate invite code
 *   2. Create Supabase Auth user (email + password)
 *   3. Create users table row
 *   4. Create sub_agents row (status='pending', awaiting Lead approval)
 *   5. Increment invite usage
 *
 * Rate-limited to 3 signups per hour per IP (prevent abuse)
 */
export async function POST(request: NextRequest) {
  try {
    const { email, password, phone, inviteId, shopId } = await request.json()

    // Validation
    if (!email || !password || !phone || !inviteId || !shopId) {
      return NextResponse.json(
        { error: 'Missing required fields' },
        { status: 400 }
      )
    }

    if (password.length < 8) {
      return NextResponse.json(
        { error: 'Password must be at least 8 characters' },
        { status: 400 }
      )
    }

    const cleanPhone = String(phone).replace(/\D/g, '')
    if (!/^0\d{9}$/.test(cleanPhone)) {
      return NextResponse.json(
        { error: 'Invalid phone number format' },
        { status: 400 }
      )
    }

    // Rate limit by IP
    try {
      if (signupRateLimit) {
        const ip = request.headers.get('x-forwarded-for') || 'unknown'
        const { success } = await signupRateLimit.limit(`signup:${ip}`)
        if (!success) {
          return NextResponse.json(
            { error: 'Too many signup attempts. Try again later.' },
            { status: 429 }
          )
        }
      }
    } catch (rlErr) {
      console.warn('[SubAgentSignup] Rate limit check failed:', rlErr)
    }

    const supabase: any = createServerClient()

    // 1. Validate invite code
    const { data: invite, error: inviteError } = await supabase
      .from('shop_invites')
      .select('id, shop_id, max_uses, used_count, expires_at, revoked_at')
      .eq('id', inviteId)
      .single()

    if (inviteError || !invite) {
      return NextResponse.json(
        { error: 'Invalid invite code' },
        { status: 400 }
      )
    }

    const now = new Date()
    if (invite.revoked_at) {
      return NextResponse.json(
        { error: 'This invite has been revoked' },
        { status: 400 }
      )
    }

    if (invite.expires_at && new Date(invite.expires_at) < now) {
      return NextResponse.json(
        { error: 'This invite has expired' },
        { status: 400 }
      )
    }

    if (invite.max_uses && invite.used_count >= invite.max_uses) {
      return NextResponse.json(
        { error: 'This invite has reached its usage limit' },
        { status: 400 }
      )
    }

    // 2. Create Supabase Auth user
    const { data: authData, error: authError } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: `${process.env.NEXT_PUBLIC_SITE_URL}/auth/callback`,
      },
    })

    if (authError || !authData?.user) {
      console.error('[SubAgentSignup] Auth error:', authError)
      return NextResponse.json(
        { error: authError?.message || 'Failed to create account' },
        { status: 500 }
      )
    }

    const userId = authData.user.id

    // 3. Ensure the users table row. The `on_auth_user_created` trigger
    //    (supabase/triggers.sql -> handle_new_user) ALREADY inserts a
    //    public.users row when the auth user is created above, so a plain
    //    INSERT here collides on the primary key and fails ("Failed to create
    //    user record"). Upsert on `id` updates that trigger-created row (and
    //    still inserts if the trigger is somehow absent), setting the phone.
    const { error: userCreateError } = await supabase
      .from('users')
      .upsert({
        id: userId,
        email,
        phone_number: cleanPhone,
        first_name: '',
        last_name: '',
        role: 'customer', // Subs start as customers, auto-upgraded on approval
        status: 'active',
      }, { onConflict: 'id' })

    if (userCreateError) {
      console.error('[SubAgentSignup] User create error:', userCreateError)
      // Clean up auth user if users insert fails
      await supabase.auth.admin.deleteUser(userId)
      return NextResponse.json(
        { error: 'Failed to create user record' },
        { status: 500 }
      )
    }

    // 4. Create sub_agents row (status='pending', awaiting Lead approval)
    const { error: subCreateError } = await supabase
      .from('sub_agents')
      .insert({
        user_id: userId,
        upline_shop_id: shopId,
        status: 'pending',
        joined_via_invite: inviteId,
      })

    if (subCreateError) {
      console.error('[SubAgentSignup] Sub create error:', subCreateError)
      // Clean up auth + users if sub insert fails
      await supabase.auth.admin.deleteUser(userId)
      await supabase.from('users').delete().eq('id', userId)
      return NextResponse.json(
        { error: 'Failed to create sub-agent record' },
        { status: 500 }
      )
    }

    // 5. Increment invite usage
    await supabase
      .from('shop_invites')
      .update({ used_count: (invite.used_count || 0) + 1 })
      .eq('id', inviteId)

    return NextResponse.json({
      success: true,
      message: 'Account created. Pending approval from your Lead.',
      userId,
      phone: cleanPhone,
    })
  } catch (err: any) {
    console.error('[SubAgentSignup] Critical error:', err)
    return NextResponse.json(
      { error: 'Signup failed. Please try again.' },
      { status: 500 }
    )
  }
}
