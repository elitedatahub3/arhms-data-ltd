import { NextRequest, NextResponse } from 'next/server'
import { createRouteHandlerClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { UTILITY_SERVICE_KEYS, UTILITY_SERVICES } from '@/lib/hubtel-utility-service'
import { headroomFor, resolveMarkupCap } from '@/lib/utility-shop-pricing'
import { isUtilityVisibleTo, UTILITY_LAUNCH_KEY } from '@/lib/utility-order-intent'

/**
 * A shop's own margin on utility bills.
 *
 * GET  — the current margin plus the ceiling it is working against today.
 * POST — set the margin and whether the storefront shows the Pay Bills tab.
 *
 * The ceiling is the interesting part. It is not 5%: it is 5% minus the platform's
 * fee minus whatever this shop's upline already takes, because the cap is on the
 * TOTAL a customer pays. Two shops can therefore have different ceilings, and one
 * shop's ceiling moves when its Lead edits theirs. GET returns the live figure so
 * the screen never shows a limit the save will reject.
 */

async function ownedShop(request: NextRequest) {
    const supabaseUser = await createRouteHandlerClient()
    const { data: { user } } = await supabaseUser.auth.getUser()
    if (!user) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }

    const db = createServerClient() as any
    const { data: shop } = await db
        .from('shop_profiles')
        .select('id, owner_id, shop_name, utility_fee_percent, utilities_enabled')
        .eq('owner_id', user.id)
        .maybeSingle()

    if (!shop) return { error: NextResponse.json({ error: 'You do not have a shop' }, { status: 404 }) }

    const { data: profile } = await db.from('users').select('role').eq('id', user.id).maybeSingle()

    return { db, shop, userId: user.id, ownerRole: (profile as any)?.role ?? 'customer' }
}

export async function GET(request: NextRequest) {
    try {
        const ctx = await ownedShop(request)
        if ('error' in ctx) return ctx.error
        const { db, shop, ownerRole } = ctx

        const { data: gateRows } = await db
            .from('admin_settings')
            .select('key, value')
            .in('key', [UTILITY_LAUNCH_KEY, ...UTILITY_SERVICE_KEYS.map(s => `utility_enabled_${s}`)])

        const settings: Record<string, string> = {}
        for (const row of ((gateRows as any[]) || [])) settings[row.key] = row.value

        // Per-service, because the platform's own fee is configured per service and
        // therefore so is the headroom. Today they are all 2%/1%, but nothing
        // guarantees that stays true.
        const services = await Promise.all(
            UTILITY_SERVICE_KEYS.map(async (service) => {
                const h = await headroomFor(db, shop.id, service, ownerRole)
                return {
                    service,
                    label: UTILITY_SERVICES[service].label,
                    enabled: settings[`utility_enabled_${service}`] !== 'false',
                    platform_percent: h.platform,
                    upline_percent: h.upline,
                    max_percent: h.headroom,
                }
            })
        )

        return NextResponse.json({
            success: true,
            shop: { id: shop.id, name: shop.shop_name },
            fee_percent: Number(shop.utility_fee_percent || 0),
            utilities_enabled: shop.utilities_enabled === true,
            cap_percent: await resolveMarkupCap(db),
            // Bills are closed platform-wide until this is opened; the shop's own
            // toggle cannot override it, so the screen should say so.
            available: isUtilityVisibleTo(ownerRole, settings),
            services,
        })
    } catch (err: any) {
        console.error('[ShopUtilityPricing] GET error:', err)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}

export async function POST(request: NextRequest) {
    try {
        const ctx = await ownedShop(request)
        if ('error' in ctx) return ctx.error
        const { db, shop, ownerRole } = ctx

        let body: any
        try { body = await request.json() } catch {
            return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
        }

        const enabled = body?.utilities_enabled === true
        const raw = body?.fee_percent

        if (raw === undefined || raw === null || raw === '') {
            return NextResponse.json({ error: 'fee_percent is required' }, { status: 400 })
        }

        const feePercent = Number(raw)
        if (!Number.isFinite(feePercent) || feePercent < 0) {
            return NextResponse.json({ error: 'fee_percent must be zero or more' }, { status: 400 })
        }

        // Checked against the TIGHTEST service, not an average. One margin covers
        // every biller, so it has to fit the one with the least room — otherwise a
        // shop could be legal on DSTV and over the cap on ECG with the same number.
        let tightest = { service: '', headroom: Number.POSITIVE_INFINITY, platform: 0, upline: 0, cap: 5 }
        for (const service of UTILITY_SERVICE_KEYS) {
            const h = await headroomFor(db, shop.id, service, ownerRole)
            if (h.headroom < tightest.headroom) {
                tightest = { service, headroom: h.headroom, platform: h.platform, upline: h.upline, cap: h.cap }
            }
        }

        if (feePercent > tightest.headroom) {
            const label = UTILITY_SERVICES[tightest.service as keyof typeof UTILITY_SERVICES]?.label ?? tightest.service
            return NextResponse.json({
                error:
                    `Your margin cannot exceed ${tightest.headroom.toFixed(2)}%. ` +
                    `A customer never pays more than ${tightest.cap}% over the bill, and on ${label} ` +
                    `${tightest.platform.toFixed(2)}% is the platform fee` +
                    (tightest.upline > 0 ? ` and ${tightest.upline.toFixed(2)}% goes to your upline` : '') +
                    `.`,
                max_percent: tightest.headroom,
            }, { status: 400 })
        }

        const { error } = await db
            .from('shop_profiles')
            .update({
                utility_fee_percent: feePercent,
                utilities_enabled: enabled,
                updated_at: new Date().toISOString(),
            })
            .eq('id', shop.id)
            .eq('owner_id', shop.owner_id)

        if (error) {
            console.error('[ShopUtilityPricing] update error:', error)
            return NextResponse.json({ error: 'Could not save your bill payment settings' }, { status: 500 })
        }

        return NextResponse.json({
            success: true,
            fee_percent: feePercent,
            utilities_enabled: enabled,
            max_percent: tightest.headroom,
        })
    } catch (err: any) {
        console.error('[ShopUtilityPricing] POST error:', err)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
