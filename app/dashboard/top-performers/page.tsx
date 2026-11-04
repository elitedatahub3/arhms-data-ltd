'use client'

import { useCallback, useEffect, useState } from 'react'
import { LayoutGrid, Loader2, Store, Trophy, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { formatCurrency } from '@/lib/utils'
import { LeaderboardCard, type Board, type LeaderboardEntry } from '@/components/top-performers/LeaderboardCard'

interface LastBoardResult {
    top3: { rank: number; name: string; total: number }[]
    myPlacement: { rank: number; total: number } | null
}

interface TopPerformersData {
    enabled: boolean
    month: string
    months: string[]
    isCurrent: boolean
    daysLeft: number
    rankingsOnly: boolean
    prizes: Record<Board, [string, string, string]>
    boards: Record<Board, LeaderboardEntry[]>
    lastMonth: { month: string } & Record<Board, LastBoardResult>
}

const BOARD_META: Record<Board, { title: string; subtitle: string; countsNote: string; resultLabel: string }> = {
    dashboard: {
        title: 'Top dashboard sales',
        subtitle: 'Sales made from your dashboard.',
        countsNote: 'Counts your completed purchases made on the website and through the developer API.',
        resultLabel: 'Dashboard Sales',
    },
    shop: {
        title: 'Top shop sales',
        subtitle: 'Sales made through your online shop.',
        countsNote: 'Counts completed sales through your storefront and USSD code.',
        resultLabel: 'Shop Sales',
    },
}

function monthLabel(key: string, short = false) {
    const [y, m] = key.split('-').map(Number)
    return new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-GB', { month: short ? 'short' : 'long', year: 'numeric', timeZone: 'UTC' })
}


function bannerKey(month: string) {
    return `tp-results-dismissed-${month}`
}

export default function TopPerformersPage() {
    const [month, setMonth] = useState<string | null>(null)
    const [data, setData] = useState<TopPerformersData | null>(null)
    const [disabled, setDisabled] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [loading, setLoading] = useState(true)
    const [refreshing, setRefreshing] = useState(false)
    const [bannerHidden, setBannerHidden] = useState(true)

    const load = useCallback(async (target: string | null, quiet = false) => {
        if (quiet) setRefreshing(true)
        else setLoading(true)
        setError(null)
        try {
            const res = await fetch(`/api/top-performers${target ? `?month=${target}` : ''}`, { cache: 'no-store' })
            const body = await res.json()
            if (!res.ok) throw new Error(body.error || 'Could not load the rankings')
            if (body.enabled === false && !body.boards) {
                setDisabled(true)
                return
            }
            setData(body)
            setMonth(body.month)
            try {
                setBannerHidden(localStorage.getItem(bannerKey(body.lastMonth.month)) === '1')
            } catch {
                setBannerHidden(false)
            }
        } catch (e: any) {
            setError(e.message || 'Could not load the rankings')
        } finally {
            setLoading(false)
            setRefreshing(false)
        }
    }, [])

    useEffect(() => { load(null) }, [load])

    const dismissBanner = () => {
        setBannerHidden(true)
        try {
            if (data) localStorage.setItem(bannerKey(data.lastMonth.month), '1')
        } catch { /* private mode: the banner simply comes back next visit */ }
    }

    if (disabled) {
        return (
            <div className="card-premium mx-auto max-w-lg p-8 text-center">
                <Trophy className="mx-auto h-10 w-10 text-muted-foreground" />
                <h2 className="mt-3 text-xl font-black">Top Performers is coming soon</h2>
                <p className="mt-1 text-sm text-muted-foreground">Monthly rankings are not switched on yet. Check back later.</p>
            </div>
        )
    }

    const last = data?.lastMonth
    const hasLastResults = !!last && (last.dashboard.top3.length > 0 || last.shop.top3.length > 0)
    const myLast = last
        ? (['dashboard', 'shop'] as Board[])
            .filter(b => last[b].myPlacement)
            .map(b => `#${last[b].myPlacement!.rank} in ${BOARD_META[b].resultLabel} with ${formatCurrency(last[b].myPlacement!.total)}`)
        : []

    return (
        <div className="space-y-6 animate-slow-fade">
            <div>
                <h2 className="text-2xl font-black tracking-tight text-foreground sm:text-3xl">Monthly top performers</h2>
                <p className="mt-1 text-sm font-medium text-muted-foreground">
                    {data?.rankingsOnly
                        ? 'See where you rank against other sellers this month.'
                        : 'The top 3 sellers in each category win a reward every month.'}
                </p>
                <p className="text-sm text-muted-foreground">
                    Sales are counted from the 1st to the last day of each month (Ghana time). Only completed sales count.
                </p>
            </div>

            {data && hasLastResults && !bannerHidden && (
                <div className="card-premium relative p-4 sm:p-6">
                    <button
                        onClick={dismissBanner}
                        className="absolute right-3 top-3 flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground hover:bg-secondary"
                        aria-label="Dismiss"
                    >
                        <X className="h-4 w-4" />
                    </button>
                    <h3 className="flex items-center gap-2 pr-8 text-lg font-black">
                        <Trophy className="h-5 w-5 text-amber-500" />
                        {monthLabel(last!.month)} rankings are in
                    </h3>
                    {data.rankingsOnly && <p className="mt-1 text-sm text-muted-foreground">Rankings only. Rewards have not started yet.</p>}
                    {myLast.length > 0 && <p className="mt-1 text-sm font-medium text-foreground">You placed {myLast.join(' and ')}.</p>}
                    <div className="mt-4 grid gap-3 sm:grid-cols-2">
                        {(['dashboard', 'shop'] as Board[]).map(b => (
                            <div key={b} className="rounded-xl border border-border/70 bg-secondary/30 p-3">
                                <p className="text-sm font-bold">{BOARD_META[b].resultLabel}</p>
                                {last![b].top3.length === 0 ? (
                                    <p className="mt-1 text-sm text-muted-foreground">No sales recorded.</p>
                                ) : (
                                    <ol className="mt-1 space-y-0.5 text-sm text-muted-foreground">
                                        {last![b].top3.map(w => <li key={w.rank}>#{w.rank} {w.name}</li>)}
                                    </ol>
                                )}
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {data && (
                <label className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-4 py-2 text-sm shadow-sm">
                    <span className="font-semibold text-muted-foreground">Month</span>
                    <select
                        value={month ?? ''}
                        onChange={e => load(e.target.value)}
                        className="bg-transparent font-bold text-foreground outline-none"
                        disabled={loading}
                    >
                        {data.months.map(m => <option key={m} value={m}>{monthLabel(m)}</option>)}
                    </select>
                    {loading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
                </label>
            )}

            {error && (
                <div className="card-premium flex flex-col items-start gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                    <p className="text-sm font-medium text-red-600 dark:text-red-400">{error}</p>
                    <Button variant="outline" size="sm" onClick={() => load(month)}>Try again</Button>
                </div>
            )}

            {!data && loading ? (
                <div className="grid gap-6 lg:grid-cols-2">
                    <Skeleton className="h-[36rem] rounded-2xl" />
                    <Skeleton className="h-[36rem] rounded-2xl" />
                </div>
            ) : data && (
                <div className="grid gap-6 lg:grid-cols-2">
                    {(['dashboard', 'shop'] as Board[]).map(b => (
                        <LeaderboardCard
                            key={`${b}-${data.month}`}
                            board={b}
                            title={BOARD_META[b].title}
                            subtitle={BOARD_META[b].subtitle}
                            countsNote={BOARD_META[b].countsNote}
                            icon={b === 'dashboard' ? LayoutGrid : Store}
                            iconClassName={b === 'dashboard' ? 'bg-gradient-to-br from-blue-500 to-indigo-600' : 'bg-gradient-to-br from-emerald-500 to-teal-600'}
                            entries={data.boards[b]}
                            prizes={data.prizes[b]}
                            month={data.month}
                            monthLabel={monthLabel(data.month)}
                            daysLeft={data.daysLeft}
                            refreshing={refreshing}
                            onRefresh={() => load(data.month, true)}
                        />
                    ))}
                </div>
            )}
        </div>
    )
}
