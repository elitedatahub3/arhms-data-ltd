import { unstable_cache } from 'next/cache'
import { createServerClient } from '@/lib/supabase'

/**
 * Monthly Top Performers — two leaderboards ranked by GHS of completed sales.
 *
 *   dashboard: what a user bought themselves on the website or via the developer API
 *   shop:      what a shop sold through its storefront or USSD code
 *
 * What counts (and the double-count traps) lives in ONE place: the SQL function
 * top_performers_totals (migration 20261104000000_top_performers). Nothing here
 * re-derives a total.
 *
 * Board reads go through unstable_cache because every viewer of a month sees the
 * same top 30 — page `revalidate` is a no-op here (the root layout is dynamic).
 * The current month refreshes every 5 minutes; closed months hourly, since a late
 * completion or refund can still nudge them.
 */

export type Board = 'dashboard' | 'shop'
export const BOARDS: Board[] = ['dashboard', 'shop']

export const TOP_PERFORMERS_KEYS = {
    enabled: 'top_performers_enabled',
    config: 'top_performers_config',
} as const

export const TOP_PERFORMERS_CACHE_TAG = 'top-performers'
export const BOARD_LIMIT = 30
/** The first month the boards can be browsed back to. */
export const FIRST_MONTH = '2026-10'

export interface TopPerformersConfig {
    enabled: boolean
    /** Rankings show, but no prizes are advertised and no winner SMS goes out. */
    rankingsOnly: boolean
    /** The number winners are told to call. */
    contactPhone: string
    /** Prize labels for ranks 1-3. An empty label means "no prize for this place". */
    prizes: Record<Board, [string, string, string]>
}

export const DEFAULT_CONFIG: TopPerformersConfig = {
    enabled: false,
    rankingsOnly: true,
    contactPhone: '',
    prizes: { dashboard: ['', '', ''], shop: ['', '', ''] },
}

export interface BoardEntry {
    rank: number
    userId: string
    name: string
    total: number
}

// ---------------------------------------------------------------------------
// Months (Ghana time is UTC+0, so UTC calendar months are Ghana months)
// ---------------------------------------------------------------------------

/** 'YYYY-MM' for the month containing `date`. */
export function monthKey(date = new Date()): string {
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
}

/** 'YYYY-MM' of the month before `key`. */
export function previousMonthKey(key = monthKey()): string {
    const [y, m] = key.split('-').map(Number)
    return monthKey(new Date(Date.UTC(y, m - 2, 1)))
}

/** 'YYYY-MM-01' — the date the SQL functions take. */
export function monthStartDate(key: string): string {
    return `${key}-01`
}

/** A valid, browsable 'YYYY-MM' (not before FIRST_MONTH, not in the future), else null. */
export function parseMonthParam(value: string | null | undefined): string | null {
    if (!value || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) return null
    if (value < FIRST_MONTH || value > monthKey()) return null
    return value
}

/** Newest first, from the current month back to FIRST_MONTH. */
export function browsableMonths(): string[] {
    const months: string[] = []
    let key = monthKey()
    while (key >= FIRST_MONTH && months.length < 24) {
        months.push(key)
        key = previousMonthKey(key)
    }
    return months
}

/** "November 2026" / "Nov 2026". */
export function monthLabel(key: string, short = false): string {
    const [y, m] = key.split('-').map(Number)
    return new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-GB', {
        month: short ? 'short' : 'long',
        year: 'numeric',
        timeZone: 'UTC',
    })
}

/** Whole days left in the current month, counting today. 0 for a closed month. */
export function daysLeftInMonth(key: string, now = new Date()): number {
    if (key !== monthKey(now)) return 0
    const [y, m] = key.split('-').map(Number)
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate()
    return lastDay - now.getUTCDate() + 1
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function cleanPrizes(raw: unknown): [string, string, string] {
    const list = Array.isArray(raw) ? raw : []
    return [0, 1, 2].map(i => String(list[i] ?? '').trim().slice(0, 60)) as [string, string, string]
}

export function parseConfig(enabledValue: string | null | undefined, configValue: string | null | undefined): TopPerformersConfig {
    let stored: any = {}
    try {
        stored = configValue ? JSON.parse(configValue) : {}
    } catch {
        stored = {}
    }
    return {
        enabled: enabledValue === 'true',
        rankingsOnly: stored.rankingsOnly !== false,
        contactPhone: String(stored.contactPhone ?? '').trim().slice(0, 20),
        prizes: {
            dashboard: cleanPrizes(stored.prizes?.dashboard),
            shop: cleanPrizes(stored.prizes?.shop),
        },
    }
}

/** Reads the settings with the service role. Fails closed (feature off). */
export async function readTopPerformersConfig(): Promise<TopPerformersConfig> {
    try {
        const db = createServerClient() as any
        const { data, error } = await db
            .from('admin_settings')
            .select('key, value')
            .in('key', [TOP_PERFORMERS_KEYS.enabled, TOP_PERFORMERS_KEYS.config])
        if (error) throw error
        const map: Record<string, string> = {}
        for (const row of data || []) map[row.key] = row.value
        return parseConfig(map[TOP_PERFORMERS_KEYS.enabled], map[TOP_PERFORMERS_KEYS.config])
    } catch (error) {
        console.error('[TopPerformers] Unable to read settings:', error)
        return DEFAULT_CONFIG
    }
}

/** Prize labels as shown to sellers: none at all while rankings-only. */
export function visiblePrizes(config: TopPerformersConfig): Record<Board, [string, string, string]> {
    return config.rankingsOnly ? DEFAULT_CONFIG.prizes : config.prizes
}

// ---------------------------------------------------------------------------
// Boards
// ---------------------------------------------------------------------------

/** Uncached — the cron uses this so the frozen winners are read fresh. */
export async function fetchBoard(board: Board, key: string, limit = BOARD_LIMIT): Promise<BoardEntry[]> {
    const db = createServerClient() as any
    const { data, error } = await db.rpc('top_performers_month', {
        p_board: board,
        p_month: monthStartDate(key),
        p_limit: limit,
    })
    if (error) throw new Error(`top_performers_month(${board}, ${key}): ${error.message}`)
    return ((data || []) as any[]).map(row => ({
        rank: Number(row.rank),
        userId: row.user_id,
        name: row.display_name,
        total: Number(row.total),
    }))
}

/** The shared top 30 for a month, cached for everyone. */
export function getBoard(board: Board, key: string): Promise<BoardEntry[]> {
    const current = key === monthKey()
    return unstable_cache(
        () => fetchBoard(board, key),
        ['top-performers-board-v1', board, key],
        { revalidate: current ? 300 : 3600, tags: [TOP_PERFORMERS_CACHE_TAG] }
    )()
}

export interface UserRank {
    rank: number | null
    total: number
    participants: number
}

/** One user's place on a board. Not cached: it is asked for on demand. */
export async function getUserRank(board: Board, key: string, userId: string): Promise<UserRank> {
    const db = createServerClient() as any
    const { data, error } = await db.rpc('top_performers_user_rank', {
        p_board: board,
        p_month: monthStartDate(key),
        p_user_id: userId,
    })
    if (error) throw new Error(`top_performers_user_rank(${board}, ${key}): ${error.message}`)
    const row = (data || [])[0]
    return {
        rank: row?.rank == null ? null : Number(row.rank),
        total: Number(row?.total ?? 0),
        participants: Number(row?.participants ?? 0),
    }
}

// ---------------------------------------------------------------------------
// Winner SMS
// ---------------------------------------------------------------------------

export const BOARD_LABELS: Record<Board, string> = {
    dashboard: 'Dashboard Sales',
    shop: 'Shop Sales',
}

/** SMS gateways choke on non-ASCII; prize labels are typed by admins and may hold "₵". */
export function toAscii(text: string): string {
    return text
        .replace(/₵/g, 'GHS ')
        .replace(/[‘’]/g, "'")
        .replace(/[“”]/g, '"')
        .replace(/[–—]/g, '-')
        .replace(/[^\x20-\x7E]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
}

export function winnerSmsText(params: {
    firstName: string
    rank: number
    board: Board
    month: string
    prize: string
    contactPhone: string
}): string {
    const first = toAscii(params.firstName).split(' ')[0] || 'there'
    const contact = params.contactPhone ? ` Contact admin on ${toAscii(params.contactPhone)} to claim your reward.` : ' Contact admin to claim your reward.'
    return `Congrats ${first}! You placed #${params.rank} in ${BOARD_LABELS[params.board]} for ${monthLabel(params.month, true)} on ARHMS. Prize: ${toAscii(params.prize)}.${contact}`
}
