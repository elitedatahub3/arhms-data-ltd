'use client'

import { BadgeCheck } from 'lucide-react'
import { cn, formatCurrency } from '@/lib/utils'

export interface RankRowEntry {
    /** null for official accounts: shown by sales, never ranked. */
    rank: number | null
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
 * seller is to the leader, so the race reads at a glance down the list.
 *
 * `leaderTotal` is the top COMPETING seller's total. Official rows that outsell
 * them simply fill the bar.
 */
export function RankRow({ entry, leaderTotal }: { entry: RankRowEntry; leaderTotal: number }) {
    const medal = entry.rank ? MEDAL[entry.rank] : undefined
    const share = leaderTotal > 0 ? Math.min(100, Math.max(3, (entry.total / leaderTotal) * 100)) : 0

    return (
        <li
            className={cn(
                'rounded-xl px-3 py-2.5 transition-colors',
                entry.isMe && 'bg-primary/10 ring-1 ring-primary/40',
                entry.isOfficial && !entry.isMe && 'bg-primary/[0.04]',
                !entry.isMe && !entry.isOfficial && 'hover:bg-secondary/60'
            )}
        >
            <div className="flex items-center gap-3">
                {entry.isOfficial ? (
                    <span
                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary"
                        title="Official account: not ranked"
                    >
                        <BadgeCheck className="h-4 w-4" />
                    </span>
                ) : (
                    <span
                        className={cn(
                            'flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold tabular-nums',
                            medal ? medal.chip : 'bg-card text-muted-foreground shadow-sm ring-1 ring-border/60'
                        )}
                    >
                        {entry.rank}
                    </span>
                )}

                <span className="flex min-w-0 flex-1 items-center gap-1.5">
                    <span className={cn('truncate text-sm text-foreground', medal ? 'font-bold' : 'font-semibold')}>
                        {entry.name}
                    </span>
                    {entry.isOfficial && (
                        <span className="shrink-0 rounded-md bg-primary/10 px-1.5 py-0.5 text-[10px] font-bold text-primary">Official</span>
                    )}
                    {entry.isMe && <span className="shrink-0 text-xs font-bold text-primary">You</span>}
                </span>

                <span className={cn('shrink-0 text-sm tabular-nums', medal ? 'font-bold text-foreground' : 'font-medium text-muted-foreground')}>
                    {formatCurrency(entry.total)}
                </span>
            </div>

            <div className="ml-10 mt-1.5 h-1 overflow-hidden rounded-full bg-secondary" aria-hidden="true">
                <div
                    className={cn('h-full rounded-full', entry.isOfficial ? 'bg-primary/40' : medal ? medal.bar : 'bg-primary/60')}
                    style={{ width: `${share}%` }}
                />
            </div>
        </li>
    )
}

/** The top competing seller's total: the 100% mark for every bar. */
export function leaderTotalOf(entries: RankRowEntry[]): number {
    return entries.find(e => e.rank === 1)?.total ?? Math.max(0, ...entries.map(e => e.total))
}
