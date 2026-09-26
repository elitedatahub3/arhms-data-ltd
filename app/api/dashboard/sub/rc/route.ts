import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { createRouteHandlerClient } from '@/lib/supabase-server'
import { resolveSubAgentContext } from '@/lib/sub-agents'
import { purchaseWithWallet } from '@/lib/vouchers/checkout'

/**
 * Results Checker vouchers for sub-agents.
 *
 * A sub buys vouchers at whatever their Lead charges a walk-in customer
 * (shop_rc_pricing.selling_price), debited from their own wallet. Vouchers are
 * delivered instantly — unlike AFA there is no admin queue — and the Lead's
 * shop wallet is credited the margin over the platform's cost_price.
 *
 * GET  → { available, types[], walletBalance, orders[] }
 * POST → { success, vouchers[], newBalance }
 */

interface SubRcContext {
    error?: string
    status?: number
    unavailable?: string
    uplineShopId?: string
    uplineOwnerId?: string
    shopName?: string
}

/** Membership + upline identity. Mirrors the AFA route's gates exactly. */
async function resolveSubRcContext(db: any, userId: string): Promise<SubRcContext> {
    const sub = await resolveSubAgentContext(db, userId)

    if (!sub.isSub) return { error: 'Not a sub-agent', status: 403 }

    // Gated on the sub's OWN membership only — not sub.uplineEligible. See the
    // matching note in /api/dashboard/sub/afa: canOwnSubNetwork() fails for the
    // role-'customer' Leads that make up most live shops.
    if (sub.status !== 'active') {
        return {
            error: sub.status === 'suspended'
                ? 'Your sub-agent account is suspended. Contact your Lead to be reinstated.'
                : 'Your account is still awaiting approval from your Lead.',
            status: 403,
        }
    }

    if (!sub.uplineShopId || !sub.uplineOwnerId) {
        return { error: 'Your upline shop could not be found. Please contact support.', status: 403 }
    }

    // Same global toggle that governs Results Checker on storefronts.
    const { data: setting } = await db
        .from('admin_settings')
        .select('value')
        .eq('key', 'storefront_rc_enabled')
        .maybeSingle()

    if (!setting || setting.value !== 'true') {
        return { unavailable: 'Results Checker is not available right now.' }
    }

    const { data: shop } = await db
        .from('shop_profiles')
        .select('shop_name')
        .eq('id', sub.uplineShopId)
        .maybeSingle()

    return {
        uplineShopId: sub.uplineShopId,
        uplineOwnerId: sub.uplineOwnerId,
        shopName: shop?.shop_name || 'Your Lead',
    }
}

/**
 * The voucher types this sub may buy: the ones their Lead has priced, joined
 * with live stock. cost_price is loaded but never returned to the browser.
 */
async function loadPricedTypes(db: any, uplineShopId: string) {
    const { data: pricingRows } = await db
        .from('shop_rc_pricing')
        .select('rc_type_id, selling_price, results_checker_types(id, name, is_active)')
        .eq('shop_id', uplineShopId)

    const active = (pricingRows || []).filter((r: any) => r.results_checker_types?.is_active)

    return Promise.all(
        active.map(async (row: any) => {
            const t = row.results_checker_types
            const { count } = await db
                .from('results_checker_inventory')
                .select('id', { count: 'exact', head: true })
                .eq('type_id', t.id)
                .eq('status', 'available')

            return {
                id: t.id,
                name: t.name,
                price: parseFloat(row.selling_price),
                stock: count || 0,
            }
        })
    )
}

export async function GET() {
    try {
        const auth = await createRouteHandlerClient()
        const { data: { user } } = await auth.auth.getUser()
        if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

        const db: any = createServerClient()
        const ctx = await resolveSubRcContext(db, user.id)
        if (ctx.error) return NextResponse.json({ error: ctx.error }, { status: ctx.status })

        const { data: wallet } = await db
            .from('wallets')
            .select('balance')
            .eq('user_id', user.id)
            .maybeSingle()

        const { data: orders } = await db
            .from('results_checker_orders')
            .select('id, type_name, quantity, total_paid, status, created_at, inventory_ids')
            .eq('user_id', user.id)
            .order('created_at', { ascending: false })
            .limit(30)

        if (ctx.unavailable) {
            return NextResponse.json({
                available: false,
                reason: ctx.unavailable,
                types: [],
                walletBalance: Number(wallet?.balance) || 0,
                orders: orders || [],
            })
        }

        const types = await loadPricedTypes(db, ctx.uplineShopId!)

        return NextResponse.json({
            available: types.length > 0,
            reason: types.length === 0
                ? 'Your Lead has not priced any voucher types yet. Ask them to set prices.'
                : undefined,
            types,
            parentShopName: ctx.shopName,
            walletBalance: Number(wallet?.balance) || 0,
            orders: orders || [],
        })
    } catch (err) {
        console.error('[SubRC] GET error:', err)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}

export async function POST(request: NextRequest) {
    try {
        const auth = await createRouteHandlerClient()
        const { data: { user } } = await auth.auth.getUser()
        if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

        const body = await request.json()
        const { typeId, quantity } = body

        const qty = parseInt(quantity)
        if (!typeId || isNaN(qty) || qty < 1 || qty > 10) {
            return NextResponse.json({ error: 'Quantity must be between 1 and 10' }, { status: 400 })
        }

        const db: any = createServerClient()
        const ctx = await resolveSubRcContext(db, user.id)
        if (ctx.error) return NextResponse.json({ error: ctx.error }, { status: ctx.status })
        if (ctx.unavailable) return NextResponse.json({ error: ctx.unavailable }, { status: 503 })

        // Price comes from the Lead's row, never from the client.
        const { data: pricing } = await db
            .from('shop_rc_pricing')
            .select('selling_price')
            .eq('shop_id', ctx.uplineShopId)
            .eq('rc_type_id', typeId)
            .maybeSingle()

        if (!pricing) {
            return NextResponse.json(
                { error: 'This voucher type is not available from your Lead.' },
                { status: 404 }
            )
        }

        const { data: userProfile } = await db
            .from('users')
            .select('role, email, first_name, phone_number')
            .eq('id', user.id)
            .maybeSingle()

        // purchaseWithWallet owns the whole atomic sequence — deduct, reserve,
        // finalize, deliver, and refund on any failure. Passing the Lead's price
        // as an override is the only thing that differs from a normal purchase.
        const result = await purchaseWithWallet({
            userId: user.id,
            userRole: userProfile?.role || 'customer',
            typeId,
            quantity: qty,
            customerName: userProfile?.first_name || 'Sub-Agent',
            customerEmail: userProfile?.email || user.email,
            customerPhone: userProfile?.phone_number,
            unitPriceOverride: parseFloat(pricing.selling_price),
            shopId: ctx.uplineShopId,
            shopName: ctx.shopName,
            shopOwnerId: ctx.uplineOwnerId,
        })

        return NextResponse.json({
            success: true,
            vouchers: result.vouchers.map(v => ({ pin: v.pin, serial_number: v.serial_number })),
            newBalance: result.newBalance,
        })
    } catch (error: any) {
        // Same error vocabulary as /api/vouchers/wallet-purchase, so the two
        // surfaces explain the same failure the same way.
        if (error.message === 'PRODUCT_NOT_AVAILABLE') {
            return NextResponse.json({ error: 'This voucher is currently unavailable' }, { status: 400 })
        }
        if (error.message === 'INSUFFICIENT_BALANCE') {
            return NextResponse.json({ error: 'INSUFFICIENT_BALANCE' }, { status: 400 })
        }
        if (error.message === 'ORDER_CREATION_FAILED') {
            return NextResponse.json({ error: 'Could not create your order. Your wallet has been refunded.' }, { status: 500 })
        }
        if (error.message === 'INSUFFICIENT_INVENTORY') {
            return NextResponse.json({ error: 'Not enough vouchers in stock for that quantity.' }, { status: 400 })
        }
        if (error.message === 'PRICING_ERROR_UNIT_BELOW_COST') {
            // The Lead's price fell below the platform's cost — usually because
            // an admin raised cost_price after they set theirs. Fails closed
            // rather than selling the platform's stock at a loss.
            return NextResponse.json(
                { error: 'Your Lead needs to update their voucher price before you can buy. Please contact them.' },
                { status: 409 }
            )
        }

        console.error('[SubRC] POST error:', error)
        return NextResponse.json({ error: 'Failed to process purchase' }, { status: 500 })
    }
}
