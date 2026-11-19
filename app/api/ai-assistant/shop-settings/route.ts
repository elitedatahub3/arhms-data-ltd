/**
 * Shop owner's view of their storefront assistant.
 *
 * GET              -> { hasShop, shopId, adminOn, enabled, used, allowance, baseLimit, price }
 * PATCH {enabled}  -> switch the assistant on/off for THEIR shop (owner only)
 *
 * The shop is always the caller's own (owner_id = session user); no shop id is
 * accepted from the client.
 */
import { NextResponse } from 'next/server'
import { createRouteHandlerClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import {
    currentMonthKey,
    monthlyAllowance,
    monthStartIso,
    parseMonthlyLimit,
    parseResetPrice,
    USAGE_DEFAULTS,
    USAGE_SETTING_KEYS,
} from '@/lib/ai-assistant/helpers'

export const dynamic = 'force-dynamic'

async function ownShop() {
    const supabase = await createRouteHandlerClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
    const db = createServerClient() as any
    const { data: shop } = await db.from('shop_profiles').select('id, ai_assistant_enabled').eq('owner_id', user.id).maybeSingle()
    return { db, shop }
}

export async function GET() {
    const r = await ownShop()
    if ('error' in r) return r.error
    const { db, shop } = r
    if (!shop) return NextResponse.json({ hasShop: false })

    const keys = ['ai_storefront_mode', USAGE_SETTING_KEYS.shop.limit, USAGE_SETTING_KEYS.shop.price]
    const [{ data: rows }, { count }, { data: resets }] = await Promise.all([
        db.from('admin_settings').select('key, value').in('key', keys),
        db.from('ai_shop_questions').select('id', { count: 'exact', head: true }).eq('shop_id', shop.id).gte('created_at', monthStartIso()),
        db.from('ai_usage_purchases').select('questions_added')
            .eq('shop_id', shop.id).eq('scope', 'shop').eq('month', currentMonthKey()).eq('status', 'paid'),
    ])
    const s: Record<string, string> = {}
    for (const x of rows || []) s[x.key] = x.value
    const baseLimit = parseMonthlyLimit(s[USAGE_SETTING_KEYS.shop.limit], USAGE_DEFAULTS.shop.limit)

    return NextResponse.json(
        {
            hasShop: true,
            shopId: shop.id,
            adminOn: s.ai_storefront_mode === 'on',
            enabled: shop.ai_assistant_enabled !== false,
            used: count || 0,
            allowance: monthlyAllowance(baseLimit, (resets || []).map((x: any) => Number(x.questions_added))),
            baseLimit,
            price: parseResetPrice(s[USAGE_SETTING_KEYS.shop.price], USAGE_DEFAULTS.shop.price),
        },
        { headers: { 'Cache-Control': 'private, no-store' } },
    )
}

export async function PATCH(request: Request) {
    const r = await ownShop()
    if ('error' in r) return r.error
    const { db, shop } = r
    if (!shop) return NextResponse.json({ error: 'No shop' }, { status: 404 })
    const body = await request.json().catch(() => null)
    if (typeof body?.enabled !== 'boolean') return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
    const { error } = await db.from('shop_profiles').update({ ai_assistant_enabled: body.enabled }).eq('id', shop.id)
    if (error) return NextResponse.json({ error: 'Could not save. Is migration 20261118020000 run?' }, { status: 500 })
    return NextResponse.json({ ok: true, enabled: body.enabled })
}
