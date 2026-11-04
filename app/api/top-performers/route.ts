import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { createRouteHandlerClient } from '@/lib/supabase-server'
import {
    BOARDS,
    browsableMonths,
    daysLeftInMonth,
    getBoard,
    monthKey,
    monthStartDate,
    parseMonthParam,
    previousMonthKey,
    readTopPerformersConfig,
    visiblePrizes,
    type Board,
    type BoardEntry,
} from '@/lib/top-performers'

export const dynamic = 'force-dynamic'

/**
 * GET /api/top-performers?month=YYYY-MM
 *
 * Both boards for one month, plus last month's results for the "rankings are in"
 * banner. The boards themselves are cached and shared by every viewer; the only
 * per-caller part is the `isMe` flag, so user ids never leave the server.
 *
 * Admins can always open it (to preview before switching it on); everyone else
 * gets { enabled: false } while the switch is off.
 */
export async function GET(request: NextRequest) {
    const supabaseAuth = await createRouteHandlerClient()
    const { data: { user }, error: authError } = await supabaseAuth.auth.getUser()
    if (authError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const db = createServerClient() as any
    const [config, { data: dbUser }] = await Promise.all([
        readTopPerformersConfig(),
        db.from('users').select('role').eq('id', user.id).maybeSingle(),
    ])
    const isAdmin = ['admin', 'sub-admin'].includes(dbUser?.role)
    if (!config.enabled && !isAdmin) return NextResponse.json({ enabled: false })

    const month = parseMonthParam(request.nextUrl.searchParams.get('month')) ?? monthKey()
    const lastMonth = previousMonthKey()

    const strip = (entries: BoardEntry[]) =>
        entries.map(({ rank, name, total, userId }) => ({ rank, name, total, isMe: userId === user.id }))

    try {
        const [dashboard, shop, lastDashboard, lastShop, { data: winnerRows }] = await Promise.all([
            getBoard('dashboard', month),
            getBoard('shop', month),
            getBoard('dashboard', lastMonth),
            getBoard('shop', lastMonth),
            db.from('top_performer_winners')
                .select('board, rank, display_name, total, user_id')
                .eq('month', monthStartDate(lastMonth))
                .order('rank'),
        ])

        // Last month's podium: the frozen winners once the cron has run, the live
        // board until then.
        const lastBoards: Record<Board, BoardEntry[]> = { dashboard: lastDashboard, shop: lastShop }
        const lastResults = Object.fromEntries(BOARDS.map(board => {
            const frozen = (winnerRows || []).filter((w: any) => w.board === board)
            const top3 = frozen.length
                ? frozen.map((w: any) => ({ rank: w.rank, name: w.display_name, total: Number(w.total) }))
                : lastBoards[board].slice(0, 3).map(({ rank, name, total }) => ({ rank, name, total }))
            const mine = lastBoards[board].find(e => e.userId === user.id)
            return [board, { top3, myPlacement: mine ? { rank: mine.rank, total: mine.total } : null }]
        }))

        return NextResponse.json({
            enabled: config.enabled,
            month,
            months: browsableMonths(),
            isCurrent: month === monthKey(),
            daysLeft: daysLeftInMonth(month),
            rankingsOnly: config.rankingsOnly,
            prizes: visiblePrizes(config),
            boards: { dashboard: strip(dashboard), shop: strip(shop) },
            lastMonth: { month: lastMonth, ...lastResults },
        }, { headers: { 'Cache-Control': 'private, no-store' } })
    } catch (error: any) {
        console.error('[TopPerformers] Board read failed:', error?.message || error)
        return NextResponse.json({ error: 'Rankings are unavailable right now. Please try again shortly.' }, { status: 500 })
    }
}
