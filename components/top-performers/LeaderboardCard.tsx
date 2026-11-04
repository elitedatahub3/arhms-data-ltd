'use client'

import { useState } from 'react'
import { Award, CalendarClock, Crown, Loader2, Medal, RefreshCw, Search, type LucideIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn, formatCurrency } from '@/lib/utils'

export type Board = 'dashboard' | 'shop'

export interface LeaderboardEntry {
    /** null for official accounts: shown by sales, never ranked or awarded. */
    rank: number | null
    name: string
    total: number
    isOfficial: boolean
    isMe: boolean
}

interface LeaderboardCardProps {
    board: Board
    title: string
    subtitle: string
    countsNote: string
    icon: LucideIcon
    iconClassName: string
    entries: LeaderboardEntry[]
    prizes: [string, string, string]
    month: string
    monthLabel: string
    daysLeft: number
    refreshing: boolean
    onRefresh: () => void
}

/** Gold, silver, bronze — indexed by rank - 1. */
const PLACE_STYLES = [
    {
        icon: Crown,
        badge: 'bg-amber-400 text-amber-950 shadow-amber-500/40',
        block: 'bg-gradient-to-b from-amber-300 to-amber-500 text-amber-950 shadow-amber-500/30 h-36 sm:h-40',
        chip: 'bg-amber-200 text-amber-900 dark:bg-amber-500/25 dark:text-amber-200',
    },
    {
        icon: Medal,
        badge: 'bg-slate-300 text-slate-800 shadow-slate-400/40',
        block: 'bg-gradient-to-b from-slate-200 to-slate-400 text-slate-900 shadow-slate-400/30 h-28 sm:h-32',
        chip: 'bg-slate-200 text-slate-800 dark:bg-slate-500/25 dark:text-slate-200',
    },
    {
        icon: Award,
        badge: 'bg-orange-400 text-orange-950 shadow-orange-500/40',
        block: 'bg-gradient-to-b from-orange-300 to-orange-500 text-orange-950 shadow-orange-500/30 h-24 sm:h-28',
        chip: 'bg-orange-200 text-orange-900 dark:bg-orange-500/25 dark:text-orange-200',
    },
]

function PodiumColumn({ entry, place, prize }: { entry?: LeaderboardEntry; place: number; prize: string }) {
    const style = PLACE_STYLES[place - 1]
    const Icon = style.icon
    return (
        <div className="flex flex-1 min-w-0 flex-col items-center justify-end gap-2">
            <div className={cn('flex h-10 w-10 items-center justify-center rounded-full shadow-lg', style.badge)}>
                <Icon className="h-5 w-5" />
            </div>
            <div
                className={cn(
                    'flex w-full flex-col items-center justify-center rounded-2xl px-1.5 text-center shadow-lg',
                    style.block,
                    entry?.isMe && 'ring-2 ring-primary ring-offset-2 ring-offset-card'
                )}
            >
                <span className="text-3xl font-black leading-none">{place}</span>
                <span className="mt-1.5 w-full truncate text-xs font-bold sm:text-sm">{entry ? entry.name : '—'}</span>
                <span className="text-[11px] font-semibold opacity-80">{entry ? formatCurrency(entry.total) : 'Open spot'}</span>
            </div>
            {prize && (
                <span className={cn('w-full rounded-lg px-1.5 py-1 text-center text-[10px] font-bold uppercase leading-tight', style.chip)}>
                    {prize}
                </span>
            )}
        </div>
    )
}

export function LeaderboardCard({
    board,
    title,
    subtitle,
    countsNote,
    icon: Icon,
    iconClassName,
    entries,
    prizes,
    month,
    monthLabel,
    daysLeft,
    refreshing,
    onRefresh,
}: LeaderboardCardProps) {
    const [checking, setChecking] = useState(false)
    const [myRank, setMyRank] = useState<string | null>(null)

    const byRank = (rank: number) => entries.find(e => e.rank === rank)
    // Everyone off the podium, by sales — official accounts included wherever they fall.
    const rest = entries.filter(e => e.rank === null || e.rank > 3)
    const hasOfficial = entries.some(e => e.isOfficial)

    const checkMyRank = async () => {
        setChecking(true)
        try {
            const res = await fetch(`/api/top-performers/my-rank?board=${board}&month=${month}`, { cache: 'no-store' })
            const body = await res.json()
            if (!res.ok) throw new Error(body.error || 'Could not check your rank')
            setMyRank(
                body.isOfficial
                    ? `Official accounts are shown for reference and are not ranked. Sales in ${monthLabel}: ${formatCurrency(body.total)}.`
                    : body.rank
                    ? `You are #${body.rank} of ${body.participants} with ${formatCurrency(body.total)} in ${monthLabel}.`
                    : `You have no completed ${board === 'shop' ? 'shop sales' : 'purchases'} in ${monthLabel} yet.`
            )
        } catch (e: any) {
            setMyRank(e.message || 'Could not check your rank')
        } finally {
            setChecking(false)
        }
    }

    return (
        <section className="card-premium flex flex-col p-4 sm:p-6">
            <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-3">
                    <div className={cn('flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-white shadow-md', iconClassName)}>
                        <Icon className="h-5 w-5" />
                    </div>
                    <div>
                        <h3 className="text-base font-black tracking-tight text-foreground sm:text-lg">{title}</h3>
                        <p className="text-xs font-medium text-muted-foreground sm:text-sm">{subtitle}</p>
                    </div>
                </div>
                <Button
                    variant="outline"
                    size="icon"
                    className="h-9 w-9 shrink-0 rounded-full"
                    onClick={onRefresh}
                    disabled={refreshing}
                    aria-label="Refresh rankings"
                >
                    <RefreshCw className={cn('h-4 w-4', refreshing && 'animate-spin')} />
                </Button>
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-2">
                <span className="text-sm font-bold text-foreground">{monthLabel}</span>
                {daysLeft > 0 && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2.5 py-1 text-xs font-bold text-amber-800 dark:bg-amber-500/20 dark:text-amber-200">
                        <CalendarClock className="h-3.5 w-3.5" />
                        {daysLeft} day{daysLeft === 1 ? '' : 's'} left
                    </span>
                )}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">{countsNote}</p>

            {/* Podium: 2 - 1 - 3 */}
            <div className="mx-auto mt-6 flex w-full max-w-md items-end gap-2 sm:gap-3">
                <PodiumColumn entry={byRank(2)} place={2} prize={prizes[1]} />
                <PodiumColumn entry={byRank(1)} place={1} prize={prizes[0]} />
                <PodiumColumn entry={byRank(3)} place={3} prize={prizes[2]} />
            </div>

            <div className="mt-6 flex-1 rounded-2xl border border-border/70 bg-secondary/30 p-2">
                {entries.length === 0 ? (
                    <p className="px-3 py-8 text-center text-sm text-muted-foreground">
                        No completed sales yet this month. The first sale takes the top spot.
                    </p>
                ) : rest.length === 0 ? (
                    <p className="px-3 py-6 text-center text-sm text-muted-foreground">Places 4 and below are still open.</p>
                ) : (
                    <ol className="max-h-[28rem] space-y-1 overflow-y-auto">
                        {rest.map(entry => (
                            <li
                                key={entry.rank ?? `official-${entry.name}-${entry.total}`}
                                className={cn(
                                    'flex items-center gap-3 rounded-xl px-3 py-2.5',
                                    entry.isMe ? 'bg-primary/10 ring-1 ring-primary/40' : 'hover:bg-secondary/60'
                                )}
                            >
                                {entry.isOfficial ? (
                                    <span className="shrink-0 rounded-full bg-primary/10 px-2 py-1 text-[10px] font-bold uppercase text-primary">
                                        Official
                                    </span>
                                ) : (
                                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-card text-xs font-bold text-muted-foreground shadow-sm">
                                        {entry.rank}
                                    </span>
                                )}
                                <span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
                                    {entry.name}
                                    {entry.isMe && <span className="ml-1.5 text-xs font-bold text-primary">(you)</span>}
                                </span>
                                <span className="shrink-0 text-sm font-medium tabular-nums text-muted-foreground">
                                    {formatCurrency(entry.total)}
                                </span>
                            </li>
                        ))}
                    </ol>
                )}
            </div>

            <div className="mt-4 space-y-2">
                <Button onClick={checkMyRank} disabled={checking} className="rounded-full font-bold">
                    {checking ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Search className="mr-2 h-4 w-4" />}
                    Check my rank
                </Button>
                {myRank && <p className="text-sm font-medium text-foreground">{myRank}</p>}
                {hasOfficial && (
                    <p className="text-xs text-muted-foreground">Official ARHMS accounts are shown for reference and do not compete for prizes.</p>
                )}
                <p className="text-xs text-muted-foreground">Pending, processing, failed and refunded orders do not count.</p>
            </div>
        </section>
    )
}
