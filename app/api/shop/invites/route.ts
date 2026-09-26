import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { createRouteHandlerClient } from '@/lib/supabase-server'
import { nanoid } from 'nanoid'
import {
  resolveSubAgentContext,
  canRecruit,
  DEPTH_LIMIT_ERROR,
  SUB_INACTIVE_ERROR,
} from '@/lib/sub-agents'

/**
 * GET /api/shop/invites
 * List all invites for the authenticated user's shop
 *
 * Authorization: User must own the shop
 * Response: Array of invites with usage stats
 */
export async function GET(request: NextRequest) {
  try {
    const supabaseAuth = await createRouteHandlerClient()
    const { data: { user }, error: authError } = await supabaseAuth.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const supabase: any = createServerClient()

    // Get user's shop
    const { data: shop, error: shopError } = await supabase
      .from('shop_profiles')
      .select('id, shop_name')
      .eq('owner_id', user.id)
      .single()

    if (shopError || !shop) {
      return NextResponse.json(
        { error: 'Shop not found' },
        { status: 404 }
      )
    }

    // List invites
    const { data: invites, error: invitesError } = await supabase
      .from('shop_invites')
      .select('id, code, max_uses, used_count, expires_at, revoked_at, created_at')
      .eq('shop_id', shop.id)
      .order('created_at', { ascending: false })

    if (invitesError) {
      console.error('[Invites GET] Error:', invitesError)
      return NextResponse.json(
        { error: 'Failed to fetch invites' },
        { status: 500 }
      )
    }

    return NextResponse.json({
      success: true,
      invites: invites || [],
      shopId: shop.id,
      shopName: shop.shop_name,
    })
  } catch (err: any) {
    console.error('[Invites GET] Critical error:', err)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

/**
 * POST /api/shop/invites
 * Create a new invite code for sub-agent recruitment
 *
 * Authorization: User must own the shop AND be allowed to recruit. A Lead
 * always may; a sub may while they are active and above the depth cap. A
 * level-2 sub is the bottom of the network and is refused here, so they never
 * get a link to hand out — the DB trigger enforces the same rule at signup.
 *
 * Body: { maxUses?: number, expiresInHours?: number }
 * Response: { code, expiresAt }
 */
export async function POST(request: NextRequest) {
  try {
    const supabaseAuth = await createRouteHandlerClient()
    const { data: { user }, error: authError } = await supabaseAuth.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { maxUses, expiresInHours } = await request.json()

    const supabase: any = createServerClient()

    // Get user's shop
    const { data: shop, error: shopError } = await supabase
      .from('shop_profiles')
      .select('id')
      .eq('owner_id', user.id)
      .single()

    if (shopError || !shop) {
      return NextResponse.json(
        { error: 'Shop not found' },
        { status: 404 }
      )
    }

    // Owning a shop is not on its own a licence to recruit: a sub owns one too,
    // which is exactly how the network could previously grow a third level that
    // nothing priced or paid.
    const subContext = await resolveSubAgentContext(supabase, user.id)
    if (!canRecruit(subContext)) {
      return NextResponse.json(
        {
          error: subContext.status !== 'active'
            ? SUB_INACTIVE_ERROR
            : DEPTH_LIMIT_ERROR,
        },
        { status: 403 }
      )
    }

    // Generate unique invite code
    const code = `join-${nanoid(12)}`

    // Calculate expiry
    let expiresAt = null
    if (expiresInHours && expiresInHours > 0) {
      const now = new Date()
      expiresAt = new Date(now.getTime() + expiresInHours * 60 * 60 * 1000).toISOString()
    }

    // Create invite
    const { data: invite, error: createError } = await supabase
      .from('shop_invites')
      .insert({
        shop_id: shop.id,
        code,
        max_uses: maxUses || null,
        expires_at: expiresAt,
      })
      .select('id, code, expires_at')
      .single()

    if (createError) {
      console.error('[Invites POST] Create error:', createError)
      return NextResponse.json(
        { error: 'Failed to create invite' },
        { status: 500 }
      )
    }

    // Build an absolute join URL. NEXT_PUBLIC_APP_URL is the canonical site URL
    // used across the app; fall back to NEXT_PUBLIC_SITE_URL, then the request
    // origin, so the link is never rendered as "undefined/join/...".
    const baseUrl =
      process.env.NEXT_PUBLIC_APP_URL ||
      process.env.NEXT_PUBLIC_SITE_URL ||
      request.nextUrl.origin
    const joinUrl = `${baseUrl.replace(/\/$/, '')}/join/${code}`

    return NextResponse.json({
      success: true,
      invite: {
        id: invite.id,
        code: invite.code,
        url: joinUrl,
        expiresAt: invite.expires_at,
        maxUses,
      },
    })
  } catch (err: any) {
    console.error('[Invites POST] Critical error:', err)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
