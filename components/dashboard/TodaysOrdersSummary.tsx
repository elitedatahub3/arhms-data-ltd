'use client'

import { useState, useEffect } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/auth-context'
import { formatCurrency } from '@/lib/utils'
import { Card, CardContent } from '@/components/ui/card'
import { ShoppingCart, CheckCircle2, Clock, Truck, Star, Banknote } from 'lucide-react'

interface TodayOrderStats {
    totalCount: number
    completed: { count: number; gb: number; amount: number }
    pending: { count: number; gb: number; amount: number }
    processing: { count: number; gb: number; amount: number }
    afa: { count: number; amount: number }
    totalSpent: number
}

interface TodayData {
    orders: Array<{ status: string; size: string; price: number }> | null
    afaOrders: Array<{ status: string; payment_amount: number }> | null
}

export function TodaysOrdersSummary({ data }: { data?: TodayData } = {}) {
    const { dbUser } = useAuth()
    const [stats, setStats] = useState<TodayOrderStats>({
        totalCount: 0,
        completed: { count: 0, gb: 0, amount: 0 },
        pending: { count: 0, gb: 0, amount: 0 },
        processing: { count: 0, gb: 0, amount: 0 },
        afa: { count: 0, amount: 0 },
        totalSpent: 0
    })
    const [isLoading, setIsLoading] = useState(true)

    useEffect(() => {
        if (!dbUser) return

        const fetchTodayOrders = async () => {
            try {
                const now = new Date()
                const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString()
                const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999).toISOString()

                // Rows come from /api/dashboard/summary when the dashboard passes
                // them (same two queries, already made server-side). The fetch
                // below is the fallback for any other caller.
                const [regularOrders, afaOrders] = data
                    ? [data.orders, data.afaOrders]
                    : await Promise.all([
                        supabase
                            .from('orders')
                            .select('status, size, price')
                            .eq('user_id', dbUser.id)
                            .is('shop_order_id', null)
                            .gte('created_at', startOfToday)
                            .lte('created_at', endOfToday)
                            .then(r => r.data),
                        supabase
                            .from('afa_orders')
                            // The column is payment_amount — selecting a non-existent
                            // `amount` made the whole query error, so AFA spend always
                            // rendered as 0.
                            .select('status, payment_amount')
                            .eq('user_id', dbUser.id)
                            .gte('created_at', startOfToday)
                            .lte('created_at', endOfToday)
                            .then(r => r.data),
                    ])

                const currentStats = {
                    totalCount: 0,
                    completed: { count: 0, gb: 0, amount: 0 },
                    pending: { count: 0, gb: 0, amount: 0 },
                    processing: { count: 0, gb: 0, amount: 0 },
                    afa: { count: 0, amount: 0 },
                    totalSpent: 0
                }

                if (regularOrders) {
                    currentStats.totalCount += regularOrders.length
                    regularOrders.forEach((order: any) => {
                        const gbMatch = order.size ? String(order.size).match(/(\d+)/) : null
                        const gb = gbMatch ? parseInt(gbMatch[1], 10) : 0
                        const amount = order.price || 0

                        if (order.status === 'completed') {
                            currentStats.completed.count++
                            currentStats.completed.gb += gb
                            currentStats.completed.amount += amount
                            currentStats.totalSpent += amount
                        } else if (order.status === 'processing') {
                            currentStats.processing.count++
                            currentStats.processing.gb += gb
                            currentStats.processing.amount += amount
                            currentStats.totalSpent += amount
                        } else if (order.status === 'pending') {
                            currentStats.pending.count++
                            currentStats.pending.gb += gb
                            currentStats.pending.amount += amount
                            currentStats.totalSpent += amount
                        }
                    })
                }

                if (afaOrders) {
                    currentStats.totalCount += afaOrders.length
                    afaOrders.forEach((order: any) => {
                        const amount = Number(order.payment_amount) || 0
                        currentStats.afa.count++
                        currentStats.afa.amount += amount

                        if (['completed', 'processing', 'pending'].includes(order.status)) {
                            currentStats.totalSpent += amount
                        }
                    })
                }

                setStats(currentStats)
            } catch (error) {
                console.error('Error fetching today orders:', error)
            } finally {
                setIsLoading(false)
            }
        }

        fetchTodayOrders()
    }, [dbUser, data])

    if (isLoading) return null

    return (
        <Card className="border border-border/70 shadow-sm rounded-2xl bg-card overflow-hidden mb-2">
            <CardContent className="p-5">
                <div className="flex justify-between items-start gap-4">
                    <div className="space-y-3 flex-1 min-w-0">
                        <div>
                            <p className="text-muted-foreground font-medium text-sm">Today&apos;s Orders</p>
                            <div className="flex items-center gap-2 mt-1">
                                <ShoppingCart className="w-7 h-7 text-primary" />
                                <span className="text-3xl font-black text-foreground leading-none">
                                    {stats.totalCount}
                                </span>
                            </div>
                        </div>

                        <div className="space-y-1.5 pt-2 text-sm">
                            <div className="flex items-center gap-2">
                                <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                                <span className="text-emerald-600 dark:text-emerald-400 font-medium">
                                    {stats.completed.count} completed ({stats.completed.gb}GB) ({formatCurrency(stats.completed.amount)})
                                </span>
                            </div>

                            <div className="flex items-center gap-2">
                                <Truck className="w-4 h-4 text-blue-500" />
                                <span className="text-blue-600 dark:text-blue-400 font-medium">
                                    {stats.processing.count} processing ({stats.processing.gb}GB) ({formatCurrency(stats.processing.amount)})
                                </span>
                            </div>

                            <div className="flex items-center gap-2">
                                <Clock className="w-4 h-4 text-amber-500" />
                                <span className="text-amber-600 dark:text-amber-400 font-medium">
                                    {stats.pending.count} pending ({stats.pending.gb}GB) ({formatCurrency(stats.pending.amount)})
                                </span>
                            </div>

                            <div className="flex items-center gap-2">
                                <Star className="w-4 h-4 text-violet-500" />
                                <span className="text-violet-600 dark:text-violet-400 font-medium">
                                    {stats.afa.count} AFA orders ({formatCurrency(stats.afa.amount)})
                                </span>
                            </div>

                            <div className="flex items-center gap-2 pt-0.5">
                                <Banknote className="w-4 h-4 text-primary" />
                                <span className="text-foreground font-bold">
                                    {formatCurrency(stats.totalSpent)} spent
                                </span>
                            </div>
                        </div>
                    </div>

                    <div className="hidden sm:flex shrink-0 items-center justify-center w-14 h-14 rounded-2xl bg-primary/10 border border-primary/20">
                        <ShoppingCart className="w-6 h-6 text-primary" />
                    </div>
                </div>
            </CardContent>
        </Card>
    )
}

