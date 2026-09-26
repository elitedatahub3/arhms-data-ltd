import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { createRouteHandlerClient } from '@/lib/supabase-server'
import { resolveBrandContext } from '@/lib/brand-context'
import { resolveSubAgentContext, canRecruit } from '@/lib/sub-agents'

/**
 * GET /api/dashboard/sub/data
 * Fetch sub-agent dashboard data (wallet, earnings, status, brand)
 *
 * Authorization: User must be a sub-agent
 * Response: { status, walletBalance, totalEarned, totalWithdrawn, uplineShop, brandConfig }
 */
export async function GET(request: NextRequest) {
  try {
    const supabaseAuth = await createRouteHandlerClient()
    const { data: { user }, error: authError } = await supabaseAuth.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const supabase: any = createServerClient()

    // Check if user is a sub-agent
    const { data: subAgent, error: subError } = await supabase
      .from('sub_agents')
      .select(`
        status,
        upline_shop_id,
        shop_profiles!upline_shop_id(
          shop_name,
          owner:owner_id(first_name, last_name, phone_number)
        )
      `)
      .eq('user_id', user.id)
      .single()

    if (subError || !subAgent) {
      return NextResponse.json(
        { error: 'Not a sub-agent' },
        { status: 403 }
      )
    }

    // Get wallet data
    const { data: wallet } = await supabase
      .from('shop_wallets')
      .select('balance, total_earned, total_withdrawn')
      .eq('owner_id', user.id)
      .single()

    // The sub's OWN storefront slug (null until they create their shop) — used so
    // the dashboard "Shop" tile opens the sub's own store, not the upline's.
    const { data: ownShop } = await supabase
      .from('shop_profiles')
      .select('shop_slug')
      .eq('owner_id', user.id)
      .maybeSingle()

    // Who the sub should contact for help. Google signups carry a placeholder
    // phone ('oauth_<uuid>', see supabase/triggers.sql) that must never reach the
    // UI, so lead with the Lead's name and only show a real Ghanaian number.
    const uplineOwner = (subAgent.shop_profiles as any)?.owner
    const uplineOwnerName =
      [uplineOwner?.first_name, uplineOwner?.last_name]
        .filter((part: string | null) => !!part && String(part).trim() !== '')
        .join(' ')
        .trim() || null
    const rawPhone = String(uplineOwner?.phone_number || '')
    const uplineOwnerPhone = /^(0\d{9}|233\d{9}|\+233\d{9})$/.test(rawPhone) ? rawPhone : null

    // Get brand context
    const brandConfig = await resolveBrandContext(user.id, supabase)

    // May this sub recruit sub-agents of their own? True at level 1, false at
    // level 2 — the portal shell uses it to decide whether to show the
    // recruiting nav entry, and /api/shop/invites enforces the same rule.
    const subContext = await resolveSubAgentContext(supabase, user.id)

    return NextResponse.json({
      status: subAgent.status,
      depth: subContext.depth,
      canRecruit: canRecruit(subContext),
      walletBalance: wallet?.balance || 0,
      totalEarned: wallet?.total_earned || 0,
      totalWithdrawn: wallet?.total_withdrawn || 0,
      ownShopSlug: ownShop?.shop_slug || null,
      uplineShop: {
        shopName: (subAgent.shop_profiles as any)?.shop_name || 'Your Lead',
        // `owner:owner_id(...)` is a to-one embed, so it comes back as an object.
        // Extract the strings — the dashboard renders these directly, and
        // rendering the object crashes React (error #31: "Objects are not valid
        // as a React child").
        contactName: uplineOwnerName,
        contactPhone: uplineOwnerPhone,
      },
      brandConfig,
    })
  } catch (err: any) {
    console.error('[Sub Dashboard] Error:', err)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
