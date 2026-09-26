import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { Ratelimit } from '@upstash/ratelimit'
import { Redis } from '@upstash/redis'
import { resolveSubAgentContext, canRecruit, DEPTH_LIMIT_ERROR } from '@/lib/sub-agents'

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
 * A Postgres/GoTrue error caused by the users.phone_number unique index.
 *
 * The index is enforced inside the `on_auth_user_created` trigger, and GoTrue
 * does not pass the Postgres detail through — it reports any trigger failure as
 * a flat "Database error creating new user". So the opaque form counts too: by
 * the time we test it we have already ruled out the other failure modes.
 */
function isDuplicatePhoneError(message?: string | null): boolean {
  if (!message) return false
  const m = message.toLowerCase()
  return (
    m.includes('users_phone_number_unique') ||
    m.includes('duplicate key') ||
    m.includes('database error creating new user')
  )
}

/**
 * silasbaffoe@icloud.com -> s***e@icloud.com
 *
 * Enough for someone to recognise their own account (a typo'd domain reads at a
 * glance) without handing an anonymous signer-upper the address on the phone.
 */
function maskEmail(address?: string | null): string {
  if (!address || !address.includes('@')) return 'another account'
  const [local, domain] = address.split('@')
  const shown = local.length <= 2 ? '' : `${local[0]}***${local[local.length - 1]}`
  return `${shown || '***'}@${domain}`
}

/** A GoTrue error raised when the email is already registered. */
function isEmailExistsError(message?: string | null): boolean {
  if (!message) return false
  const m = message.toLowerCase()
  return (
    m.includes('already been registered') ||
    m.includes('already registered') ||
    m.includes('email_exists') ||
    m.includes('user already exists')
  )
}

/** Shown whenever a Lead tries to join their own shop through their own link. */
const OWN_SHOP_ERROR =
  "This is your own shop's invite link — you can't join your own shop as a sub-agent. " +
  'Share it with the person you are recruiting, and sign out first if you are testing it on their phone.'

/**
 * POST /api/shop/sub-agents/signup
 *
 * Sub-agent signup:
 *   1. Validate invite code
 *   2. Create the Supabase Auth user via the admin API (email auto-confirmed).
 *      The `on_auth_user_created` trigger creates the public.users row from the
 *      metadata we pass (including phone_number), so we do NOT insert users here.
 *   3. Create the sub_agents row (status='pending', awaiting Lead approval).
 *      Idempotent: a returning user who already has a row gets their real status
 *      back instead of a hard error.
 *   4. Increment invite usage
 *
 * We use `auth.admin.createUser` (not `auth.signUp`): signUp on a service-role
 * client silently returns an existing/obfuscated user for a returning email —
 * no error — so the flow used to march on and die at the sub_agents insert.
 *
 * Rate-limited to 3 signups per hour per IP (prevent abuse)
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const email = String(body.email || '').trim().toLowerCase()
    const { password, phone, inviteId, shopId } = body

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

    // 1a. The invite decides which shop is being joined — never the shopId in
    //     the request body, which would otherwise let anyone with any valid
    //     invite enrol under a shop that never invited them.
    const uplineShopId = invite.shop_id

    const { data: uplineShop } = await supabase
      .from('shop_profiles')
      .select('id, owner_id')
      .eq('id', uplineShopId)
      .maybeSingle()

    if (!uplineShop) {
      return NextResponse.json(
        { error: 'This invite is no longer valid. Ask your Lead for a new link.' },
        { status: 400 }
      )
    }

    // 1a-ii. The network is three levels deep, so the inviter may themselves be
    //     a sub. They may only recruit while active and above the depth cap —
    //     a level-2 sub is the bottom. /api/shop/invites refuses to mint the
    //     link in the first place; this catches a link minted before the
    //     inviter was suspended or moved, and the DB trigger backs both up.
    const inviterContext = await resolveSubAgentContext(supabase, uplineShop.owner_id)
    if (!canRecruit(inviterContext)) {
      return NextResponse.json(
        {
          error: inviterContext.status !== 'active'
            ? 'This shop is not currently accepting new sub-agents.'
            : DEPTH_LIMIT_ERROR,
        },
        { status: 400 }
      )
    }

    // 1b. Is this phone already spoken for? The unique index would fire inside
    //     the signup trigger, where GoTrue flattens it into an unactionable
    //     "Database error creating new user". Checking first lets us name the
    //     real problem — most often someone re-signing up because they mistyped
    //     their email the first time, whose original account is already live.
    const { data: phoneOwner } = await supabase
      .from('users')
      .select('id, email')
      .eq('phone_number', cleanPhone)
      .maybeSingle()

    // A Lead testing their own link signs up with their own details, which ends
    // with the Lead enrolled as a sub-agent of their own shop: the portal then
    // shows their existing storefront on "My Shop", so every new recruit they
    // hand the phone to believes a shop was already created for them.
    if (phoneOwner && phoneOwner.id === uplineShop.owner_id) {
      return NextResponse.json({ error: OWN_SHOP_ERROR }, { status: 400 })
    }

    if (phoneOwner && String(phoneOwner.email || '').toLowerCase() !== email) {
      return NextResponse.json(
        {
          error:
            `This phone number is already registered to ${maskEmail(phoneOwner.email)}. ` +
            `Log in with that account, or sign up with a different phone number.`,
        },
        { status: 409 }
      )
    }

    // 2. Create (or resolve) the auth user. The `on_auth_user_created` trigger
    //    (supabase/triggers.sql -> handle_new_user) reads `phone_number` from the
    //    metadata below and inserts the public.users row for us — so there is no
    //    separate users insert here. email_confirm skips the confirmation email
    //    (approval is gated by the Lead, not email verification).
    let userId: string | null = null
    let createdNewAuthUser = false
    let reusedExistingAccount = false

    const { data: created, error: createErr } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { first_name: '', last_name: '', phone_number: cleanPhone },
    })

    if (createErr || !created?.user) {
      const message = createErr?.message || ''

      // Backstop for the check above: the phone can be claimed between our
      // lookup and this insert, and the trigger's unique index is the only
      // thing enforcing it.
      if (isDuplicatePhoneError(message)) {
        const { data: raceOwner } = await supabase
          .from('users')
          .select('email')
          .eq('phone_number', cleanPhone)
          .maybeSingle()
        if (raceOwner && String(raceOwner.email || '').toLowerCase() !== email) {
          return NextResponse.json(
            {
              error:
                `This phone number is already registered to ${maskEmail(raceOwner.email)}. ` +
                `Log in with that account, or sign up with a different phone number.`,
            },
            { status: 409 }
          )
        }
      }

      // Email already registered → resolve the existing account and continue
      // enrolling it as a sub-agent (idempotent retry of a half-finished signup).
      //
      // The password is NEVER touched here. Overwriting it on nothing more than
      // a typed-in email handed anyone who knew an address the keys to that
      // account — including its wallet. The account is re-used only when the
      // phone matches it too, which is exactly the half-finished-signup case;
      // anyone else is told to sign in with the account they already have.
      if (isEmailExistsError(message)) {
        const { data: existing } = await supabase
          .from('users')
          .select('id, phone_number')
          .eq('email', email)
          .maybeSingle()

        if (existing?.id && existing.id === uplineShop.owner_id) {
          return NextResponse.json({ error: OWN_SHOP_ERROR }, { status: 400 })
        }

        if (existing?.id && String(existing.phone_number || '') === cleanPhone) {
          userId = existing.id
          reusedExistingAccount = true
        } else if (existing?.id) {
          return NextResponse.json(
            {
              error:
                'This email already has an account. Sign up with the phone number on that ' +
                'account, or use a different email address.',
            },
            { status: 409 }
          )
        }
      }

      if (!userId) {
        console.error('[SubAgentSignup] createUser error:', {
          message,
          email,
          phone: cleanPhone,
          shopId,
        })
        return NextResponse.json(
          {
            error:
              'We could not create your account. Please try again — if it keeps failing, ' +
              'contact your Lead, as this phone or email may already be in use.',
          },
          { status: 500 }
        )
      }
    } else {
      userId = created.user.id
      createdNewAuthUser = true
    }

    // 3. Create the sub_agents row (status='pending', awaiting Lead approval).
    //    Idempotent: if one already exists (a prior attempt got this far), surface
    //    the real status instead of the confusing "Failed to create" error.
    const { data: existingSub } = await supabase
      .from('sub_agents')
      .select('id, status')
      .eq('user_id', userId)
      .maybeSingle()

    if (existingSub) {
      return NextResponse.json({
        success: true,
        alreadyRegistered: true,
        message:
          existingSub.status === 'active'
            ? 'Your account is already active. Please log in.'
            : 'You have already signed up. Your account is pending approval from your Lead.',
        userId,
        phone: cleanPhone,
      })
    }

    const { error: subCreateError } = await supabase
      .from('sub_agents')
      .insert({
        user_id: userId,
        upline_shop_id: uplineShopId,
        status: 'pending',
        joined_via_invite: inviteId,
      })

    if (subCreateError) {
      console.error('[SubAgentSignup] Sub create error:', subCreateError)
      // Only roll back the account if THIS request created it — never delete a
      // pre-existing user. Deleting the auth user cascades to public.users.
      if (createdNewAuthUser) {
        await supabase.auth.admin.deleteUser(userId)
      }
      return NextResponse.json(
        { error: 'Failed to create sub-agent record' },
        { status: 500 }
      )
    }

    // 4. Increment invite usage
    await supabase
      .from('shop_invites')
      .update({ used_count: (invite.used_count || 0) + 1 })
      .eq('id', inviteId)

    return NextResponse.json({
      success: true,
      usedExistingAccount: reusedExistingAccount,
      message: reusedExistingAccount
        ? 'Your existing account has been linked. Log in with your current password — ' +
          'your Lead still has to approve you.'
        : 'Account created. Pending approval from your Lead.',
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
