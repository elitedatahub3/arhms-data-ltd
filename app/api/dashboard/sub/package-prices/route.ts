import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { createRouteHandlerClient } from '@/lib/supabase-server'
import { resolveSubAgentContext } from '@/lib/sub-agents'

/**
 * GET /api/dashboard/sub/package-prices
 *
 * What the caller (a sub-agent) pays per data package: their upline's
 * `sub_price`. Display-only mirror of resolveDataPrice() in
 * lib/data-order-pricing.ts, which is what actually charges — a package with no
 * positive sub_price is refused there, so it is omitted here rather than
 * defaulted to a retail price the server would never charge.
 *
 * Response: { prices: { [packageId]: number } }
 */
export async function GET() {
  try {
    const auth = await createRouteHandlerClient()
    const { data: { user } } = await auth.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const db: any = createServerClient()
    const ctx = await resolveSubAgentContext(db, user.id)
    if (!ctx.isSub || !ctx.uplineShopId) {
      return NextResponse.json({ error: 'Not a sub-agent' }, { status: 403 })
    }

    const { data: rows, error } = await db
      .from('shop_pricing')
      .select('package_id, sub_price')
      .eq('shop_id', ctx.uplineShopId)
    if (error) throw error

    const prices: Record<string, number> = {}
    for (const row of rows || []) {
      const price = Number(row.sub_price)
      if (Number.isFinite(price) && price > 0) prices[row.package_id] = price
    }

    return NextResponse.json({ prices })
  } catch (err) {
    console.error('[Sub package-prices] Error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
