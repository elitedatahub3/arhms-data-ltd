/**
 * Shop owner's storefront assistant: credits, on/off switch, buying packs.
 *
 * GET              -> { hasShop, adminOn, enabled, credits: {total, bought, freeLeft, freeMonthly},
 *                       freePerVisitorDaily, packs, walletBalance, answersThisMonth }
 * PATCH {enabled}  -> switch the assistant on/off for THEIR shop
 * POST  {packId, idempotencyKey} -> buy a credit pack from the wallet (buyCreditPack)
 *
 * The shop is always the caller's own (owner_id = session user); no shop id is
 * accepted from the client.
 */
import { NextResponse } from 'next/server'
import { createRouteHandlerClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { monthStartIso, parseWindowLimit, WINDOW_DEFAULTS, WINDOW_SETTING_KEYS } from '@/lib/ai-assistant/helpers'
import { buyCreditPack, getShopCreditState, loadShopCreditTerms, type BuyResult } from '@/lib/ai-assistant/shop-credits'

export const dynamic = 'force-dynamic'

async function caller() {
    const supabase = await createRouteHandlerClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
    const db = createServerClient() as any
    const { data: shop } = await db.from('shop_profiles').select('id, ai_assistant_enabled').eq('owner_id', user.id).maybeSingle()
    return { db, shop, userId: user.id }
}

export async function GET() {
    const c = await caller()
    if ('error' in c) return c.error
    const { db, shop, userId } = c
    if (!shop) return NextResponse.json({ hasShop: false })

    const [terms, { data: rows }, { data: wallet }, { count: answers }] = await Promise.all([
        loadShopCreditTerms(db),
        db.from('admin_settings').select('key, value').in('key', ['ai_storefront_mode', WINDOW_SETTING_KEYS.visitorDay]),
        db.from('wallets').select('balance').eq('user_id', userId).maybeSingle(),
        db.from('ai_shop_questions').select('id', { count: 'exact', head: true }).eq('shop_id', shop.id).gte('created_at', monthStartIso()),
    ])
    const s: Record<string, string> = {}
    for (const r of rows || []) s[r.key] = r.value
    const credits = await getShopCreditState(db, shop.id, terms.freeMonthly)

    return NextResponse.json(
        {
            hasShop: true,
            adminOn: s.ai_storefront_mode === 'on',
            enabled: shop.ai_assistant_enabled !== false,
            credits: { total: credits.total, bought: credits.bought, freeLeft: credits.freeLeft, freeMonthly: credits.freeMonthly },
            freePerVisitorDaily: parseWindowLimit(s[WINDOW_SETTING_KEYS.visitorDay], WINDOW_DEFAULTS.visitorDay),
            packs: terms.packs.filter(p => p.enabled).map(({ id, name, credits: n, price }) => ({ id, name, credits: n, price })),
            walletBalance: Number(Number(wallet?.balance || 0).toFixed(2)),
            answersThisMonth: answers || 0,
        },
        { headers: { 'Cache-Control': 'private, no-store' } },
    )
}

export async function PATCH(request: Request) {
    const c = await caller()
    if ('error' in c) return c.error
    const { db, shop } = c
    if (!shop) return NextResponse.json({ error: 'No shop' }, { status: 404 })
    const body = await request.json().catch(() => null)
    if (typeof body?.enabled !== 'boolean') return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
    const { error } = await db.from('shop_profiles').update({ ai_assistant_enabled: body.enabled }).eq('id', shop.id)
    if (error) return NextResponse.json({ error: 'Could not save. Is migration 20261118020000 run?' }, { status: 500 })
    return NextResponse.json({ ok: true, enabled: body.enabled })
}

export async function POST(request: Request) {
    const c = await caller()
    if ('error' in c) return c.error
    const body = await request.json().catch(() => null)
    const result = await buyCreditPack(c.db, { userId: c.userId, packId: body?.packId, idempotencyKey: body?.idempotencyKey })
    if (result.ok) return NextResponse.json(result)
    const fail = result as Extract<BuyResult, { ok: false }>
    const status = fail.code === 'forbidden' ? 403 : fail.code === 'bad_request' ? 400 : fail.code === 'insufficient' ? 402 : fail.code === 'in_progress' ? 409 : 500
    return NextResponse.json(fail, { status })
}
