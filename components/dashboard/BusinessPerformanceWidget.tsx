'use client'

import { useState, useEffect, useMemo, useRef } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/auth-context'
import { formatCurrency } from '@/lib/utils'
import { Card, CardContent } from '@/components/ui/card'
import { TrendingUp, TrendingDown, Activity, Wallet, Target, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { startOfDay, startOfWeek, subDays, isAfter, isBefore, format, parseISO } from 'date-fns'

interface PerformanceData {
    successRate: number
    totalOrders: number
    todayRevenue: number
    weekRevenue: number
    current7DaysRevenue: number
    prev7DaysRevenue: number
    dailyData: { date: string; amount: number }[]
}

// SparklineBar sets height imperatively via ref to avoid JSX inline style prop
function SparklineBar({ heightPercent, isToday }: { heightPercent: number; isToday: boolean }) {
    const ref = useRef<HTMLDivElement>(null)
    useEffect(() => {
        if (ref.current) {
            ref.current.style.height = `${heightPercent}%`
        }
    }, [heightPercent])
    return (
        <div
            ref={ref}
            className={cn(
                "w-full rounded-sm transition-all duration-500 ease-out group-hover/bar:bg-indigo-400",
                isToday
                    ? "bg-indigo-500 dark:bg-indigo-400 shadow-[0_0_8px_rgba(99,102,241,0.5)]"
                    : "bg-indigo-200 dark:bg-indigo-900/50"
            )}
            role="presentation"
            aria-hidden="true"
        />
    )
}

interface PerformanceSource {
    totalCount: number
    completedCount: number
    completedLast14Days: Array<{ price: number; created_at: string }>
}

/**
 * `source` comes from /api/dashboard/summary. Without it this widget made three
 * round trips *in series* — two counts and then the 14-day rows — which on a
 * phone is three times the latency before the cards appear. The self-fetch is
 * kept as a fallback for any other caller.
 */
export function BusinessPerformanceWidget({ data: source }: { data?: PerformanceSource } = {}) {
    const { dbUser } = useAuth()
    const [data, setData] = useState<PerformanceData | null>(null)
    const [isLoading, setIsLoading] = useState(true)

    useEffect(() => {
        if (dbUser || source) {
            fetchPerformanceData()
        }
    }, [dbUser, source])

    const fetchPerformanceData = async () => {
        try {
            setIsLoading(true)
            const now = new Date()
            const todayStart = startOfDay(now).toISOString()
            const weekStart = startOfWeek(now, { weekStartsOn: 1 }).toISOString()
            const fourteenDaysAgo = subDays(startOfDay(now), 14).toISOString()
            const sevenDaysAgo = subDays(startOfDay(now), 7).toISOString()

            let totalCount: number | null
            let completedCount: number | null
            let recentOrdersRaw: { price: number; created_at: string }[] | null

            if (source) {
                totalCount = source.totalCount
                completedCount = source.completedCount
                recentOrdersRaw = source.completedLast14Days
            } else {
                // Fetch exactly what we need, in parallel
                const [totalRes, completedRes, recentRes] = await Promise.all([
                    // 1. All-time total orders (for success rate denominator)
                    supabase
                        .from('orders')
                        .select('*', { count: 'exact', head: true })
                        .eq('user_id', dbUser!.id)
                        .is('shop_order_id', null),
                    // 2. All-time completed orders (for success rate numerator)
                    supabase
                        .from('orders')
                        .select('*', { count: 'exact', head: true })
                        .eq('user_id', dbUser!.id)
                        .eq('status', 'completed')
                        .is('shop_order_id', null),
                    // 3. Completed orders from the last 14 days, for revenue and the sparkline
                    supabase
                        .from('orders')
                        .select('price, created_at')
                        .eq('user_id', dbUser!.id)
                        .eq('status', 'completed')
                        .gte('created_at', fourteenDaysAgo),
                ])
                totalCount = totalRes.count
                completedCount = completedRes.count
                recentOrdersRaw = recentRes.data as any
            }

            const recentOrders = (recentOrdersRaw ?? []) as { price: number; created_at: string }[]

            // Process recent orders
            let todayRev = 0
            let weekRev = 0
            let current7 = 0
            let prev7 = 0
            
            // For sparkline: tracking daily sums over the last 7 days
            const dailyMap: Record<string, number> = {}
            for (let i = 6; i >= 0; i--) {
                const dateKey = format(subDays(now, i), 'MMM d')
                dailyMap[dateKey] = 0
            }

            if (recentOrders) {
                recentOrders.forEach(order => {
                    const price = Number(order.price) || 0
                    const orderDate = order.created_at

                    // Today
                    if (orderDate >= todayStart) {
                        todayRev += price
                    }
                    // This week
                    if (orderDate >= weekStart) {
                        weekRev += price
                    }

                    // 7-day vs previous 7-day comparison
                    if (orderDate >= sevenDaysAgo) {
                        current7 += price
                        // Bucket into daily map
                        const dateKey = format(parseISO(orderDate), 'MMM d')
                        if (dailyMap[dateKey] !== undefined) {
                            dailyMap[dateKey] += price
                        }
                    } else if (orderDate >= fourteenDaysAgo && orderDate < sevenDaysAgo) {
                        prev7 += price
                    }
                })
            }

            // Map the daily totals to array
            const dailyArray = Object.keys(dailyMap).map(key => ({
                date: key,
                amount: dailyMap[key]
            }))
            
            const total = totalCount || 0
            const completed = completedCount || 0
            const successRate = total > 0 ? (completed / total) * 100 : 0

            setData({
                successRate,
                totalOrders: total,
                todayRevenue: todayRev,
                weekRevenue: weekRev,
                current7DaysRevenue: current7,
                prev7DaysRevenue: prev7,
                dailyData: dailyArray
            })

        } catch (error) {
            console.error('Error fetching performance data:', error)
        } finally {
            setIsLoading(false)
        }
    }

    if (isLoading || !data) {
        return (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
                {[1, 2, 3].map(i => (
                    <Card key={i} className="animate-pulse">
                        <CardContent className="p-6 h-32 bg-gray-100 dark:bg-gray-800 rounded-xl" />
                    </Card>
                ))}
            </div>
        )
    }

    // Calculations for UI
    const trendPercent = data.prev7DaysRevenue > 0 
        ? ((data.current7DaysRevenue - data.prev7DaysRevenue) / data.prev7DaysRevenue) * 100 
        : (data.current7DaysRevenue > 0 ? 100 : 0)
    
    const isUp = trendPercent >= 0
    const TrendIcon = isUp ? TrendingUp : TrendingDown
    const trendColor = isUp ? 'text-green-500 bg-green-50 dark:bg-green-500/10' : 'text-red-500 bg-red-50 dark:bg-red-500/10'

    // Sparkline normalization
    const maxDaily = Math.max(...data.dailyData.map(d => d.amount), 1)

    return (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
            
            {/* Success Rate Circle */}
            <Card className="bg-white dark:bg-[#111111] border border-slate-200 dark:border-[#1f1f1f] shadow-sm overflow-hidden group">
                <CardContent className="p-5 flex items-center gap-5">
                    <div className="relative w-16 h-16 flex items-center justify-center shrink-0">
                        <svg className="w-full h-full -rotate-90 transform" viewBox="0 0 36 36">
                            {/* Background Circle */}
                            <path
                                className="text-gray-100 dark:text-gray-800"
                                strokeWidth="4"
                                stroke="currentColor"
                                fill="none"
                                d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                            />
                            {/* Progress Circle */}
                            <path
                                className="text-indigo-500 transition-all duration-1000 ease-out"
                                strokeWidth="4"
                                strokeDasharray={`${data.successRate}, 100`}
                                strokeLinecap="round"
                                stroke="currentColor"
                                fill="none"
                                d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                            />
                        </svg>
                        <div className="absolute flex flex-col items-center justify-center text-center">
                            <span className="text-sm font-black text-gray-900 dark:text-white">{Math.round(data.successRate)}%</span>
                        </div>
                    </div>
                    <div>
                        <div className="flex items-center gap-1.5 text-muted-foreground mb-1">
                            <Target className="w-4 h-4" />
                            <p className="text-xs font-semibold uppercase tracking-wider">Success Rate</p>
                        </div>
                        <p className="text-xl font-bold text-gray-900 dark:text-white">{data.totalOrders} <span className="text-sm font-medium text-muted-foreground">total orders</span></p>
                    </div>
                </CardContent>
            </Card>

            {/* Revenue Block */}
            <Card className="bg-white dark:bg-[#111111] border border-slate-200 dark:border-[#1f1f1f] shadow-sm relative overflow-hidden group">
                <div className="absolute -right-6 -top-6 w-24 h-24 bg-gradient-to-br from-emerald-100 to-emerald-200 dark:from-emerald-900/30 dark:to-emerald-800/30 rounded-full blur-2xl opacity-50 group-hover:opacity-100 transition-opacity" />
                <CardContent className="p-5 flex flex-col justify-center h-full relative z-10">
                    <div className="flex items-center gap-2 mb-2 text-muted-foreground">
                        <Wallet className="w-4 h-4 text-emerald-500" />
                        <p className="text-xs font-semibold uppercase tracking-wider">Revenue Insight</p>
                    </div>
                    <div className="flex items-end justify-between gap-2">
                        <div className="min-w-0">
                            <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-0.5">Today</p>
                            <p className="text-xl sm:text-2xl font-black text-gray-900 dark:text-white break-all leading-tight">
                                {formatCurrency(data.todayRevenue)}
                            </p>
                        </div>
                        <div className="text-right border-l border-gray-200 dark:border-gray-800 pl-3 sm:pl-4 shrink-0">
                            <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-0.5">This Week</p>
                            <p className="text-base sm:text-lg font-bold text-gray-700 dark:text-gray-300 break-all">
                                {formatCurrency(data.weekRevenue)}
                            </p>
                        </div>
                    </div>
                </CardContent>
            </Card>

            {/* 7-Day Trend Sparkline */}
            <Card className="bg-white dark:bg-[#111111] border border-slate-200 dark:border-[#1f1f1f] shadow-sm font-sans flex flex-col">
                <CardContent className="p-5 flex flex-col h-full justify-between">
                    <div className="flex items-center justify-between mb-3">
                        <div className="flex items-center gap-1.5 text-muted-foreground">
                            <Activity className="w-4 h-4 text-indigo-500" />
                            <p className="text-xs font-semibold uppercase tracking-wider">7-Day Trend</p>
                        </div>
                        <div className={cn("flex flex-col items-end shrink-0")}>
                            <div className={cn("px-2 py-0.5 rounded flex items-center gap-1", trendColor)}>
                                <TrendIcon className="w-3.5 h-3.5" />
                                <span className="text-xs font-bold">{Math.abs(trendPercent).toFixed(1)}%</span>
                            </div>
                        </div>
                    </div>

                    {/* Miniature Bar Chart Sparkline */}
                    <div className="flex items-end justify-between gap-1 h-12 w-full mt-auto">
                        {data.dailyData.map((day, i) => {
                            const heightPercent = Math.max((day.amount / maxDaily) * 100, 5) // Min 5% height so empty days still show a blip
                            const isToday = i === data.dailyData.length - 1
                            
                            return (
                                <div key={i} className="flex flex-col items-center flex-1 gap-1 group/bar relative">
                                    {/* Tooltip on hover */}
                                    <div className="absolute -top-8 bg-gray-900 text-white text-[10px] py-1 px-2 rounded opacity-0 group-hover/bar:opacity-100 transition-opacity whitespace-nowrap z-20 shadow-md transform pointer-events-none">
                                        {formatCurrency(day.amount)}
                                    </div>
                                    <SparklineBar heightPercent={heightPercent} isToday={isToday} />
                                </div>
                            )
                        })}
                    </div>
                </CardContent>
            </Card>
        </div>
    )
}
