/**
 * Paid reset of the ARHMS AI monthly allowance (GHS 5 user / GHS 7 shop, admin-set).
 *
 * GET  ?scope=dashboard|shop[&shopId=]  -> { price, questions, balance, topUpAmount }
 * POST { scope, shopId?, idempotencyKey } -> charges the WALLET via chargeUsageReset
 *
 * "Pay with MoMo" is the normal wallet top-up (owner's decision 2026-11-19): the
 * widget sends the user to /dashboard/wallet?amount=<topUpAmount>, then calls POST
 * with the same idempotencyKey once the wallet is credited. The AI itself never pays.
 */
import { NextResponse } from 'next/server'
import { createRouteHandlerClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { topUpAmountFor, type UsageScope } from '@/lib/ai-assistant/helpers'
import { chargeUsageReset, loadUsageTerms, type ResetResult } from '@/lib/ai-assistant/usage-reset'

export const dynamic = 'force-dynamic'

async function currentUserId(): Promise<string | null> {
    const supabase = await createRouteHandlerClient()
    const { data: { user } } = await supabase.auth.getUser()
    return user?.id ?? null
}

const asScope = (v: unknown): UsageScope | null => (v === 'dashboard' || v === 'shop' ? v : null)

export async function GET(request: Request) {
    const userId = await currentUserId()
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const scope = asScope(new URL(request.url).searchParams.get('scope'))
    if (!scope) return NextResponse.json({ error: 'Invalid request' }, { status: 400 })

    const db = createServerClient() as any
    const [terms, { data: wallet }] = await Promise.all([
        loadUsageTerms(db, scope),
        db.from('wallets').select('balance').eq('user_id', userId).maybeSingle(),
    ])
    const balance = Number(Number(wallet?.balance || 0).toFixed(2))
    return NextResponse.json(
        { price: terms.price, questions: terms.limit, balance, topUpAmount: topUpAmountFor(terms.price, balance) },
        { headers: { 'Cache-Control': 'private, no-store' } },
    )
}

export async function POST(request: Request) {
    const userId = await currentUserId()
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    let body: any
    try {
        body = await request.json()
    } catch {
        return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
    }
    const scope = asScope(body?.scope)
    if (!scope) return NextResponse.json({ error: 'Invalid request' }, { status: 400 })

    const db = createServerClient() as any
    const result = await chargeUsageReset(db, {
        userId,
        scope,
        shopId: typeof body?.shopId === 'string' ? body.shopId : null,
        idempotencyKey: body?.idempotencyKey,
    })

    if (result.ok) return NextResponse.json(result)
    const fail = result as Extract<ResetResult, { ok: false }>
    const status = fail.code === 'forbidden' ? 403
        : fail.code === 'bad_request' ? 400
        : fail.code === 'insufficient' ? 402
        : fail.code === 'in_progress' ? 409
        : 500
    return NextResponse.json(fail, { status })
}
