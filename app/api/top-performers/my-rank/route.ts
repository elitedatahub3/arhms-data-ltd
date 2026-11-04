import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { createRouteHandlerClient } from '@/lib/supabase-server'
import { getUserRank, monthKey, parseMonthParam, readTopPerformersConfig, type Board } from '@/lib/top-performers'

export const dynamic = 'force-dynamic'

/**
 * GET /api/top-performers/my-rank?board=dashboard|shop&month=YYYY-MM
 *
 * The caller's own place on one board — the "Check my rank" button. Asked for on
 * demand rather than with every board load, because it ranks every seller.
 */
export async function GET(request: NextRequest) {
    const supabaseAuth = await createRouteHandlerClient()
    const { data: { user }, error: authError } = await supabaseAuth.auth.getUser()
    if (authError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const params = request.nextUrl.searchParams
    const board = params.get('board') as Board
    if (board !== 'dashboard' && board !== 'shop') {
        return NextResponse.json({ error: 'board must be dashboard or shop' }, { status: 400 })
    }
    const month = parseMonthParam(params.get('month')) ?? monthKey()

    const db = createServerClient() as any
    const [config, { data: dbUser }] = await Promise.all([
        readTopPerformersConfig(),
        db.from('users').select('role').eq('id', user.id).maybeSingle(),
    ])
    if (!config.enabled && !['admin', 'sub-admin'].includes(dbUser?.role)) {
        return NextResponse.json({ enabled: false })
    }

    try {
        const rank = await getUserRank(board, month, user.id)
        return NextResponse.json({ board, month, ...rank }, { headers: { 'Cache-Control': 'private, no-store' } })
    } catch (error: any) {
        console.error('[TopPerformers] Rank read failed:', error?.message || error)
        return NextResponse.json({ error: 'Could not check your rank right now.' }, { status: 500 })
    }
}
