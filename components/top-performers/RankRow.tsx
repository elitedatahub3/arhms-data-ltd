'use client'

import { BadgeCheck } from 'lucide-react'
import { cn, formatCurrency } from '@/lib/utils'

export interface RankRowEntry {
    /** Prize rank. null for official accounts, which never win. */
    rank: number | null
    /** Place on the board by sales, official accounts included. */
    position: number
    name: string
    total: number
    isOfficial?: boolean
    isMe?: boolean
}

/** Chip and bar colours for places 1-3; everyone else is neutral. */
const MEDAL: Record<number, { chip: string; bar: string }> = {
    1: { chip: 'bg-amber-400 text-amber-950', bar: 'bg-amber-400' },
    2: { chip: 'bg-slate-300 text-slate-800 dark:bg-slate-400', bar: 'bg-slate-400' },
    3: { chip: 'bg-orange-400 text-orange-950', bar: 'bg-orange-400' },
}

/**
 * One leaderboard line: place, name, sales, and a thin bar showing how close the
 * seller is to #1, so the race reads at a glance down the list.
 *
 * `prize` is set when this seller holds a prize place but sits below the podium
 * (official accounts above them took the top spots).
 */
export function RankRow({ entry, leaderTotal, prize }: { entry: RankRowEntry; leaderTotal: number; prize?: string }) {
    const medal = MEDAL[entry.position]
    const share = leaderTotal > 0 ? Math.min(100, Math.max(3, (entry.total / leaderTotal) * 100)) : 0

    return (
        <li
            className={cn(
                'rounded-xl px-3 py-2.5 transition-colors',
                entry.isMe ? 'bg-primary/10 ring-1 ring-primary/40' : 'hover:bg-secondary/60'
            )}
        >
            <div className="flex items-center gap-3">
                <span
                    className={cn(
                        'flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold tabular-nums',
                        medal ? medal.chip : 'bg-card text-muted-foreground shadow-sm ring-1 ring-border/60'
                    )}
                >
                    {entry.position}
                </span>

                <span className="flex min-w-0 flex-1 items-center gap-1.5">
                    <span className={cn('truncate text-sm text-foreground', medal ? 'font-bold' : 'font-semibold')}>
                        {entry.name}
                    </span>
                    {entry.isOfficial && (
                        <span
                            className="inline-flex shrink-0 items-center gap-0.5 rounded-md bg-primary/10 px-1.5 py-0.5 text-[10px] font-bold text-primary"
                            title="Official ARHMS account: does not win prizes"
                        >
                            <BadgeCheck className="h-3 w-3" /> Official
                        </span>
                    )}
                    {prize && (
                        <span className="shrink-0 truncate rounded-md bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-800 dark:bg-amber-500/20 dark:text-amber-200">
                            {prize}
                        </span>
                    )}
                    {entry.isMe && <span className="shrink-0 text-xs font-bold text-primary">You</span>}
                </span>

                <span className={cn('shrink-0 text-sm tabular-nums', medal ? 'font-bold text-foreground' : 'font-medium text-muted-foreground')}>
                    {formatCurrency(entry.total)}
                </span>
            </div>

            <div className="ml-10 mt-1.5 h-1 overflow-hidden rounded-full bg-secondary" aria-hidden="true">
                <div className={cn('h-full rounded-full', medal ? medal.bar : 'bg-primary/60')} style={{ width: `${share}%` }} />
            </div>
        </li>
    )
}

/** The #1 total on the board: the 100% mark for every bar. */
export function leaderTotalOf(entries: RankRowEntry[]): number {
    return Math.max(0, ...entries.map(e => e.total))
}

/**
 * The prize a seller holds, if any. Official accounts never take one, so prizes
 * follow the competing sellers wherever they sit on the board.
 */
export function prizeFor(entry: RankRowEntry, prizes: readonly string[]): string {
    return !entry.isOfficial && entry.rank !== null && entry.rank <= 3 ? prizes[entry.rank - 1] || '' : ''
}
