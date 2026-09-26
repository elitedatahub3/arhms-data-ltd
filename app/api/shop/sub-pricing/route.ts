import { NextRequest, NextResponse } from 'next/server'
import { createRouteHandlerClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { resolveOwnerCost, isSubPriceValid } from '@/lib/pricing/cost-basis'
import {
    resolveSubAgentContext,
    canRecruit,
    DEPTH_LIMIT_ERROR,
    SUB_INACTIVE_ERROR,
} from '@/lib/sub-agents'
import { resolveMinSubMargin } from '@/lib/sub-pricing-context'

/**
 * Wholesale pricing — what a recruiter charges the level below them.
 *
 * `shop_pricing.sub_price` has existed since the sub-agent system shipped and
 * no route has ever written it. Until now every reader fell back to the
 * recruiter's *retail* price, and wallet-mode purchases refused outright
 * ("This package is not yet available for sub-agents"), because that fallback
 * does not exist on the wallet path.
 *
 * The same screen serves both levels: a Lead sets what their subs pay, and a
 * level-1 sub sets what their own recruits pay. The floor is whatever the
 * caller themselves pays — resolved through the chain, so a sub is floored at
 * their Lead's wholesale price rather than at the platform's role price.
 *
 * There is no ceiling. Wholesale used to be capped at the caller's own retail
 * price, which made the screen unusable for anyone selling on a thin retail
 * margin: price retail at cost + ₵0.50 with a ₵0.50 minimum wholesale margin
 * and the floor and the cap land on the same pesewa, so every value but one
 * was rejected. Selling to a sub who resells is a different trade from selling
 * to a walk-in customer, so a recruiter may charge more than their shelf price.
 * What keeps that honest is the level below: /api/dashboard/sub/pricing floors
 * a sub at their own cost, never merely at their parent's retail.
 */

/**
 * The caller's shop, plus what they pay for each package.
 *
 * Returns an error shape when the caller owns no shop or may not recruit —
 * there is no point pricing a downline you are not allowed to have.
 */
async function resolveContext(db: any, userId: string) {
    const { data: shop } = await db
        .from('shop_profiles')
        .select('id')
        .eq('owner_id', userId)
        .maybeSingle()

    if (!shop) return { error: 'Shop not found', status: 404 as const }

    const subContext = await resolveSubAgentContext(db, userId)
    if (!canRecruit(subContext)) {
        return {
            error: subContext.status !== 'active' ? SUB_INACTIVE_ERROR : DEPTH_LIMIT_ERROR,
            status: 403 as const,
        }
    }

    const { data: dbUser } = await db
        .from('users')
        .select('role, agent_expires_at, dealer_expires_at')
        .eq('id', userId)
        .maybeSingle()

    return {
        shopId: shop.id as string,
        subContext,
        owner: {
            role: (dbUser as any)?.role || 'customer',
            agentExpiresAt: (dbUser as any)?.agent_expires_at ?? null,
            dealerExpiresAt: (dbUser as any)?.dealer_expires_at ?? null,
        },
    }
}

/**
 * What the caller pays for each package they price, keyed by package id.
 *
 * A Lead pays the platform's role price. A sub pays their own upline's
 * wholesale price — the same COALESCE(sub_price, selling_price) rule the order
 * processor settles against, so the floor here and the split there agree.
 */
async function resolveOwnCosts(
    db: any,
    ctx: { subContext: any; owner: any },
    packages: any[]
): Promise<Map<string, number>> {
    const costs = new Map<string, number>()
    const upline = ctx.subContext.chain?.[0] ?? null

    if (upline) {
        const { data: uplineRows } = await db
            .from('shop_pricing')
            .select('package_id, selling_price, sub_price')
            .eq('shop_id', upline.shopId)

        for (const row of uplineRows || []) {
            const raw = row.sub_price ?? row.selling_price
            const value = raw != null ? Number(raw) : NaN
            if (Number.isFinite(value)) costs.set(row.package_id, value)
        }
        return costs
    }

    for (const pkg of packages) {
        costs.set(
            pkg.id,
            resolveOwnerCost(
                {
                    price: Number(pkg.price) || 0,
                    agentPrice: pkg.agent_price != null ? Number(pkg.agent_price) : null,
                    dealerPrice: pkg.dealer_price != null ? Number(pkg.dealer_price) : null,
                },
                ctx.owner
            )
        )
    }
    return costs
}

export async function GET() {
    try {
        const auth = await createRouteHandlerClient()
        const { data: { user } } = await auth.auth.getUser()
        if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

        const db: any = createServerClient()
        const ctx = await resolveContext(db, user.id)
        if ('error' in ctx) {
            return NextResponse.json({ error: ctx.error }, { status: ctx.status })
        }

        const { data: myRows } = await db
            .from('shop_pricing')
            .select('package_id, selling_price, sub_price')
            .eq('shop_id', ctx.shopId)

        const packageIds = (myRows || []).map((r: any) => r.package_id)
        if (packageIds.length === 0) {
            return NextResponse.json({ items: [], minMargin: await resolveMinSubMargin(db) })
        }

        const { data: packages } = await db
            .from('data_packages')
            .select('id, network, size, price, agent_price, dealer_price')
            .in('id', packageIds)

        const costs = await resolveOwnCosts(db, ctx, packages || [])
        const minMargin = await resolveMinSubMargin(db)
        const byId = new Map((packages || []).map((p: any) => [p.id, p]))

        const items = (myRows || [])
            .map((row: any) => {
                const pkg: any = byId.get(row.package_id)
                if (!pkg) return null

                const myCost = costs.get(row.package_id)
                const retail = row.selling_price != null ? Number(row.selling_price) : null
                if (myCost == null || retail == null) return null

                return {
                    packageId: row.package_id,
                    network: pkg.network,
                    size: pkg.size,
                    /** What the caller pays — the floor for their wholesale price. */
                    myCost,
                    /**
                     * The caller's own retail price. Context, not a bound —
                     * it decides how much margin the level below is left with,
                     * since a sub's storefront floor is the higher of this and
                     * their own cost.
                     */
                    myPrice: retail,
                    minPrice: Math.round((myCost + minMargin) * 100) / 100,
                    currentSubPrice: row.sub_price != null ? Number(row.sub_price) : null,
                }
            })
            .filter(Boolean)
            .sort((a: any, b: any) =>
                a.network === b.network ? a.myCost - b.myCost : a.network.localeCompare(b.network)
            )

        return NextResponse.json({ items, minMargin })
    } catch (err) {
        console.error('[SubWholesalePricing] GET error:', err)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}

export async function POST(request: NextRequest) {
    try {
        const auth = await createRouteHandlerClient()
        const { data: { user } } = await auth.auth.getUser()
        if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

        const { items } = await request.json()
        if (!Array.isArray(items)) {
            return NextResponse.json({ error: 'Invalid payload' }, { status: 400 })
        }

        const db: any = createServerClient()
        const ctx = await resolveContext(db, user.id)
        if ('error' in ctx) {
            return NextResponse.json({ error: ctx.error }, { status: ctx.status })
        }

        const { data: myRows } = await db
            .from('shop_pricing')
            .select('package_id, selling_price')
            .eq('shop_id', ctx.shopId)

        const retailByPackage = new Map<string, number>(
            (myRows || [])
                .filter((r: any) => r.selling_price != null)
                .map((r: any) => [r.package_id, Number(r.selling_price)])
        )

        const { data: packages } = await db
            .from('data_packages')
            .select('id, price, agent_price, dealer_price')
            .in('id', Array.from(retailByPackage.keys()))

        const costs = await resolveOwnCosts(db, ctx, packages || [])
        const minMargin = await resolveMinSubMargin(db)

        const updates: { packageId: string; subPrice: number | null }[] = []

        for (const item of items) {
            const retail = retailByPackage.get(item.packageId)
            if (retail == null) continue // not a package this shop offers — skip

            // Clearing a wholesale price is allowed: readers fall back to retail.
            if (item.subPrice === null || item.subPrice === '' || item.subPrice === undefined) {
                updates.push({ packageId: item.packageId, subPrice: null })
                continue
            }

            const subPrice = Number(item.subPrice)
            if (!Number.isFinite(subPrice)) {
                return NextResponse.json({ error: 'Invalid price' }, { status: 400 })
            }

            const myCost = costs.get(item.packageId)
            if (myCost == null) {
                return NextResponse.json(
                    { error: 'Your own cost for one of these packages could not be resolved. Try again shortly.' },
                    { status: 409 }
                )
            }

            if (!isSubPriceValid(subPrice, myCost, minMargin)) {
                return NextResponse.json(
                    {
                        error:
                            `Wholesale price must be at least ₵${(myCost + minMargin).toFixed(2)} ` +
                            `— your own cost plus the ₵${minMargin.toFixed(2)} minimum margin.`,
                    },
                    { status: 400 }
                )
            }

            updates.push({ packageId: item.packageId, subPrice })
        }

        // Update in place — never upsert whole rows here. selling_price and
        // profit_margin belong to the retail screen, and a full-row write from
        // this one would clobber whatever it last saved.
        for (const update of updates) {
            const { error } = await db
                .from('shop_pricing')
                .update({ sub_price: update.subPrice })
                .eq('shop_id', ctx.shopId)
                .eq('package_id', update.packageId)

            if (error) {
                console.error('[SubWholesalePricing] update error:', error)
                return NextResponse.json({ error: 'Failed to save wholesale pricing' }, { status: 500 })
            }
        }

        return NextResponse.json({ success: true, saved: updates.length })
    } catch (err) {
        console.error('[SubWholesalePricing] POST error:', err)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
