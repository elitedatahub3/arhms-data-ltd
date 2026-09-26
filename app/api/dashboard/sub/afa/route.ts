import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { createRouteHandlerClient } from '@/lib/supabase-server'
import { resolveSubAgentContext } from '@/lib/sub-agents'
import { validateAfaFormData } from '@/lib/afa-validation'
import { resolveAfaCostPrice } from '@/lib/afa-pricing'
import { creditShopRcProfit } from '@/lib/shop-service'

/**
 * AFA registration for sub-agents.
 *
 * A sub registers walk-in customers from their own portal. They pay what their
 * parent shop charges a walk-in (shop_afa_pricing.selling_price), debited from
 * their own wallet, and the parent's shop wallet is credited the margin over
 * the platform's role price.
 *
 * GET  → { available, price, parentShopName, walletBalance, applications[] }
 * POST → { success, order_id, new_balance } (or isDuplicate on replay)
 */

interface SubAfaContext {
    /** Set when the caller may not proceed at all. */
    error?: string
    status?: number
    /** Set when the feature simply is not on for this sub — not an error. */
    unavailable?: string
    uplineShopId?: string
    uplineOwnerId?: string
    shopName?: string
    price?: number
    platformCost?: number
}

/**
 * Resolves everything the sub's AFA page depends on: their eligibility, their
 * parent's price, and the platform's cost against that parent's role.
 *
 * `db` must be a service-role client — sub_agents, the upline's users row and
 * shop_afa_pricing all sit behind RLS an ordinary caller cannot read.
 */
async function resolveSubAfaContext(db: any, userId: string): Promise<SubAfaContext> {
    const sub = await resolveSubAgentContext(db, userId)

    if (!sub.isSub) return { error: 'Not a sub-agent', status: 403 }

    // Gated on the sub's OWN membership only.
    //
    // Deliberately NOT gated on sub.uplineEligible. canOwnSubNetwork() passes
    // only lifetime agents and unexpired dealers, but almost every live Lead
    // here is role 'customer' with no dealer subscription and their networks
    // sell every day — so that check fails for working shops and leaves the sub
    // staring at a state they cannot fix. The sub's own storefront and
    // /api/shop/ussd/activate both reach the same conclusion; see the note in
    // that route's activationBlockReason().
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

    // Global kill switch — the same toggle that governs storefront AFA.
    const { data: setting } = await db
        .from('admin_settings')
        .select('value')
        .eq('key', 'storefront_afa_enabled')
        .maybeSingle()

    if (!setting || setting.value !== 'true') {
        return { unavailable: 'AFA registration is not available right now.' }
    }

    const { data: shop } = await db
        .from('shop_profiles')
        .select('shop_name')
        .eq('id', sub.uplineShopId)
        .maybeSingle()

    const { data: pricing } = await db
        .from('shop_afa_pricing')
        .select('selling_price')
        .eq('shop_id', sub.uplineShopId)
        .maybeSingle()

    if (!pricing) {
        return {
            unavailable: 'Your Lead has not set an AFA registration price yet. Ask them to set one.',
        }
    }

    // The platform's cut is the PARENT's role price — that is the basis their
    // selling price was validated against in /api/shop/afa-pricing. Using the
    // sub's own role here would credit the parent a margin computed from a
    // number they never agreed to.
    const { data: ownerRow } = await db
        .from('users')
        .select('role')
        .eq('id', sub.uplineOwnerId)
        .maybeSingle()

    const costResult = await resolveAfaCostPrice(db, ownerRow?.role || 'customer')
    if (!costResult.ok) {
        return { error: costResult.error, status: 500 }
    }

    return {
        uplineShopId: sub.uplineShopId,
        uplineOwnerId: sub.uplineOwnerId,
        shopName: shop?.shop_name || 'Your Lead',
        price: parseFloat(pricing.selling_price),
        platformCost: costResult.price,
    }
}

export async function GET() {
    try {
        const auth = await createRouteHandlerClient()
        const { data: { user } } = await auth.auth.getUser()
        if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

        const db: any = createServerClient()
        const ctx = await resolveSubAfaContext(db, user.id)

        if (ctx.error) return NextResponse.json({ error: ctx.error }, { status: ctx.status })

        // The sub's own history is readable either way, so fetch it before the
        // availability check — a sub whose Lead just un-priced AFA should still
        // see what they submitted previously.
        const { data: applications } = await db
            .from('afa_orders')
            .select('id, full_name, phone, id_type, id_number, region, location, status, payment_amount, created_at')
            .eq('user_id', user.id)
            .order('created_at', { ascending: false })
            .limit(50)

        const { data: wallet } = await db
            .from('wallets')
            .select('balance')
            .eq('user_id', user.id)
            .maybeSingle()

        if (ctx.unavailable) {
            return NextResponse.json({
                available: false,
                reason: ctx.unavailable,
                walletBalance: Number(wallet?.balance) || 0,
                applications: applications || [],
            })
        }

        return NextResponse.json({
            available: true,
            price: ctx.price,
            parentShopName: ctx.shopName,
            walletBalance: Number(wallet?.balance) || 0,
            applications: applications || [],
        })
    } catch (err) {
        console.error('[SubAFA] GET error:', err)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}

export async function POST(request: NextRequest) {
    try {
        const auth = await createRouteHandlerClient()
        const { data: { user } } = await auth.auth.getUser()
        if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

        let body: any
        try {
            body = await request.json()
        } catch {
            return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
        }

        const { referenceCode, formData } = body

        if (!referenceCode || typeof referenceCode !== 'string' || referenceCode.length > 100) {
            return NextResponse.json({ error: 'Invalid reference code.' }, { status: 400 })
        }
        if (!formData || typeof formData !== 'object') {
            return NextResponse.json({ error: 'Missing form data' }, { status: 400 })
        }

        // Identical allowlists, ID formats and 18+ rule to the other two entry points.
        const validationError = validateAfaFormData(formData)
        if (validationError) {
            return NextResponse.json({ error: validationError.error }, { status: validationError.status })
        }

        const db: any = createServerClient()
        const ctx = await resolveSubAfaContext(db, user.id)

        if (ctx.error) return NextResponse.json({ error: ctx.error }, { status: ctx.status })
        if (ctx.unavailable) return NextResponse.json({ error: ctx.unavailable }, { status: 503 })

        const price = ctx.price!
        const margin = Math.round((price - ctx.platformCost!) * 100) / 100

        // Fails closed. This happens when an admin raises the role price after
        // the Lead set theirs; the alternatives are silently overcharging the
        // sub or selling below platform cost, and both are worse than stopping.
        if (margin < 0) {
            return NextResponse.json(
                { error: `${ctx.shopName} needs to update their AFA price before you can register. Please contact them.` },
                { status: 409 }
            )
        }

        /**
         * Pays the Lead their margin. Idempotent on the reference via the unique
         * index on shop_wallet_transactions, so it is safe to call on both the
         * success and the duplicate path.
         */
        const creditParent = async () => {
            if (margin <= 0) return
            const credit = await creditShopRcProfit({
                ownerId: ctx.uplineOwnerId!,
                amount: margin,
                description: `AFA Registration by sub-agent: ${formData.full_name}`,
                reference: referenceCode,
            })
            if (!credit.credited && credit.reason !== 'already credited') {
                // The sub has been charged and the order exists; a failed credit
                // is a reconciliation problem, not a reason to fail their sale.
                console.error('[SubAFA] Parent credit not applied:', credit.reason, referenceCode)
            }
        }

        const { data: rpcResult, error: rpcError } = await db.rpc('process_sub_afa_order', {
            p_user_id:        user.id,
            p_amount:         price,
            p_form_data:      formData,
            p_reference_code: referenceCode,
            p_shop_id:        ctx.uplineShopId,
            p_shop_name:      ctx.shopName,
            p_shop_markup:    margin,
            p_cost_price:     ctx.platformCost,
        })

        if (rpcError) {
            // Graceful duplicate — the client's referenceCode is an idempotency
            // key, so a retried submit must not debit twice.
            if (
                rpcError.code === '23505' ||
                rpcError.message?.includes('afa_orders_reference_code_unique') ||
                rpcError.message?.includes('duplicate key')
            ) {
                const { data: existingOrder } = await db
                    .from('afa_orders')
                    .select('id')
                    .eq('reference_code', referenceCode)
                    .eq('user_id', user.id)
                    .maybeSingle()

                // Retry the credit rather than returning straight away. If the
                // first attempt committed the order but died before paying the
                // Lead, this is the only chance to recover it — and the helper
                // is idempotent on the reference, so a already-paid credit is a
                // no-op rather than a second payment.
                await creditParent()

                return NextResponse.json({
                    success: true,
                    isDuplicate: true,
                    order_id: existingOrder?.id ?? null,
                })
            }

            // The UI matches on this literal to show a top-up prompt.
            if (rpcError.message?.includes('INSUFFICIENT_BALANCE')) {
                return NextResponse.json({ error: 'INSUFFICIENT_BALANCE' }, { status: 400 })
            }
            if (rpcError.message?.includes('WALLET_NOT_FOUND')) {
                return NextResponse.json({ error: 'Wallet not found' }, { status: 404 })
            }

            console.error('[SubAFA] RPC error:', rpcError)
            return NextResponse.json({ error: 'Failed to process registration' }, { status: 500 })
        }

        // Credit the Lead. creditShopRcProfit is not RC-specific — it is the
        // generic shop-wallet credit for sales that produce no shop_orders row.
        await creditParent()

        // Best-effort admin alert — never block a completed registration on it.
        try {
            const { data: adminUsers } = await db.from('users').select('email').eq('role', 'admin')
            const recipients = new Set<string>()
            if (process.env.ADMIN_EMAIL) recipients.add(process.env.ADMIN_EMAIL)
            for (const u of (adminUsers || []) as any[]) if (u.email) recipients.add(u.email)

            if (recipients.size > 0) {
                const { sendAdminNewAfaApplicationAlert } = await import('@/lib/email-service')
                await Promise.allSettled(
                    Array.from(recipients).map(email =>
                        sendAdminNewAfaApplicationAlert(
                            {
                                applicantName: formData.full_name,
                                phone: formData.phone,
                                region: formData.region,
                            },
                            email
                        )
                    )
                )
            }
        } catch (emailError) {
            console.error('[SubAFA] Admin alert failed:', emailError)
        }

        return NextResponse.json({
            success: true,
            order_id: rpcResult?.order_id,
            new_balance: rpcResult?.new_balance,
        })
    } catch (err) {
        console.error('[SubAFA] POST error:', err)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
