'use client'

import { useState } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/auth-context'
import { formatCurrency } from '@/lib/utils'
import { format } from 'date-fns'
import {
    Card,
    CardContent,
    CardHeader,
    CardTitle,
} from '@/components/ui/card'
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Order } from '@/types/supabase'
import { ArrowRight, Clock, CheckCircle2, XCircle, AlertCircle, ShoppingCart, Loader2, Eye, EyeOff } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * `orders` comes from /api/dashboard/summary, which already carries the same ten
 * rows this widget would fetch — so expanding it costs nothing. The self-fetch
 * stays as the fallback for any caller that doesn't pass them.
 */
export function RecentOrdersWidget({ orders: providedOrders }: { orders?: Order[] } = {}) {
    const { dbUser } = useAuth()
    const [fetchedOrders, setFetchedOrders] = useState<Order[]>([])
    const [isExpanded, setIsExpanded] = useState(false)
    const [isLoading, setIsLoading] = useState(false)
    const [selectedOrder, setSelectedOrder] = useState<Order | null>(null)

    const orders = providedOrders ?? fetchedOrders

    const fetchRecentOrders = async () => {
        if (!dbUser || isLoading) return
        setIsLoading(true)
        try {
            const { data, error } = await supabase
                .from('orders')
                .select('*')
                .eq('user_id', dbUser.id)
                .is('shop_order_id', null)
                .order('created_at', { ascending: false })
                .limit(10)

            if (error) throw error
            setFetchedOrders(data || [])
        } catch (error) {
            console.error('Error fetching recent orders:', error)
        } finally {
            setIsLoading(false)
        }
    }

    const handleShowOrders = () => {
        setIsExpanded(true)
        if (!providedOrders) fetchRecentOrders()
    }

    const getStatusConfig = (status: Order['status']) => {
        switch (status) {
            case 'completed':
                return { color: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 border-green-200 dark:border-green-800', icon: CheckCircle2 }
            case 'pending':
            case 'processing':
                return { color: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400 border-yellow-200 dark:border-yellow-800', icon: Clock }
            case 'failed':
                return { color: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400 border-red-200 dark:border-red-800', icon: XCircle }
            default:
                return { color: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300 border-gray-200 dark:border-gray-700', icon: AlertCircle }
        }
    }

    const getNetworkColor = (network: string) => {
        const net = network.toLowerCase()
        if (net.includes('mtn')) return 'bg-yellow-500 text-black'
        if (net.includes('telecel') || net.includes('vodafone')) return 'bg-red-600 text-white'
        if (net.includes('at') || net.includes('airteltigo')) return 'bg-blue-600 text-white'
        return 'bg-gray-500 text-white'
    }

    // Check if there are any recent failed orders to show an alert banner
    const hasRecentFailedOrder = orders.slice(0, 3).some(o => o.status === 'failed')

    return (
        <Card className="flex flex-col overflow-hidden border shadow-sm rounded-xl bg-white dark:bg-[#111111] border-slate-200 dark:border-[#1f1f1f]">
            <CardHeader className="flex flex-row items-center justify-between pb-3 bg-slate-50 dark:bg-[#111111] border-b border-slate-200 dark:border-[#1f1f1f]">
                <div className="flex items-center gap-2">
                    <div className="p-1.5 bg-indigo-100 dark:bg-indigo-900/30 rounded-md">
                        <ShoppingCart className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
                    </div>
                    <div>
                        <CardTitle className="text-lg font-bold">Recent Orders</CardTitle>
                        <p className="text-xs text-muted-foreground">Your last 10 transactions</p>
                    </div>
                </div>
                <Link href="/dashboard/my-orders">
                    <Button variant="ghost" size="sm" className="hidden sm:flex text-xs h-8 text-indigo-600 hover:text-indigo-700 dark:text-indigo-400">
                        View All
                        <ArrowRight className="w-3.5 h-3.5 ml-1" />
                    </Button>
                </Link>
            </CardHeader>
            <CardContent className="p-0">
                {/* Collapsed state: sleek full-width button */}
                {!isExpanded ? (
                    <div className="p-3">
                        <button
                            onClick={handleShowOrders}
                            className="w-full py-2.5 rounded-lg bg-gray-100 hover:bg-gray-200 dark:bg-gray-800 dark:hover:bg-gray-700 transition-colors flex items-center justify-center gap-2 text-sm font-medium text-gray-700 dark:text-gray-300"
                        >
                            <Eye className="w-4 h-4 text-gray-500 dark:text-gray-400" />
                            View Recent Orders
                        </button>
                    </div>
                ) : (
                    <div className="animate-in fade-in slide-in-from-top-2 duration-300">
                        {/* Hide Button at top of expanded view */}
                        <div className="p-3 border-b border-gray-50 dark:border-gray-800/50">
                            <button
                                onClick={() => setIsExpanded(false)}
                                className="w-full py-2.5 rounded-lg bg-gray-100/80 hover:bg-gray-200 dark:bg-gray-800/80 dark:hover:bg-gray-700 transition-colors flex items-center justify-center gap-2 text-sm font-medium text-gray-700 dark:text-gray-300"
                            >
                                <EyeOff className="w-4 h-4 text-gray-500 dark:text-gray-400" />
                                Hide Recent Orders
                            </button>
                        </div>

                        {hasRecentFailedOrder && (
                            <div className="px-4 py-2.5 bg-red-50 dark:bg-red-900/10 border-b border-red-100 dark:border-red-900/30 flex items-center justify-between">
                                <div className="flex items-center gap-2 text-red-600 dark:text-red-400 text-sm font-medium">
                                    <AlertCircle className="w-4 h-4" />
                                    <span>One of your recent orders failed.</span>
                                </div>
                                <Link href="/dashboard/complaints" className="text-xs font-bold underline text-red-700 dark:text-red-300">
                                    Get Support
                                </Link>
                            </div>
                        )}

                        <div className="divide-y divide-gray-100 dark:divide-gray-800">
                            {isLoading ? (
                                [...Array(3)].map((_, i) => (
                                    <div key={i} className="p-4 flex items-center justify-between animate-pulse">
                                        <div className="flex items-center gap-3">
                                            <div className="w-10 h-10 rounded-full bg-gray-200 dark:bg-gray-800" />
                                            <div className="space-y-2">
                                                <div className="h-4 w-24 bg-gray-200 dark:bg-gray-800 rounded" />
                                                <div className="h-3 w-16 bg-gray-200 dark:bg-gray-800 rounded" />
                                            </div>
                                        </div>
                                        <div className="h-6 w-20 bg-gray-200 dark:bg-gray-800 rounded-full" />
                                    </div>
                                ))
                            ) : orders.length === 0 ? (
                                <div className="p-8 text-center flex flex-col items-center justify-center">
                                    <div className="w-16 h-16 bg-gray-100 dark:bg-gray-800 rounded-full flex items-center justify-center mb-3">
                                        <ShoppingCart className="w-8 h-8 text-gray-400" />
                                    </div>
                                    <p className="text-gray-500 dark:text-gray-400 font-medium">No recent orders found</p>
                                    <p className="text-sm text-gray-400 dark:text-gray-500 mt-1">When you buy data, it will appear here.</p>
                                    <Link href="/dashboard/data-packages" className="mt-4">
                                        <Button size="sm">Buy Data Now</Button>
                                    </Link>
                                </div>
                            ) : (
                                orders.map((order) => {
                                    const StatusIcon = getStatusConfig(order.status).icon
                                    return (
                                        <div
                                            key={order.id}
                                            onClick={() => setSelectedOrder(order)}
                                            className="p-3 sm:p-4 hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors cursor-pointer flex items-center justify-between group"
                                        >
                                            <div className="flex items-center gap-3 sm:gap-4">
                                                <div className={cn(
                                                    "w-10 h-10 sm:w-12 sm:h-12 rounded-xl flex items-center justify-center flex-shrink-0 text-xs sm:text-sm font-black shadow-sm",
                                                    getNetworkColor(order.network)
                                                )}>
                                                    {order.network.substring(0, 3).toUpperCase()}
                                                </div>
                                                <div>
                                                    <p className="font-bold text-sm sm:text-base text-gray-900 dark:text-gray-100">
                                                        {order.size} Data
                                                    </p>
                                                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground mt-0.5">
                                                        <span>{order.phone_number}</span>
                                                        <span>•</span>
                                                        <span>{format(new Date(order.created_at), 'MMM d, h:mm a')}</span>
                                                    </div>
                                                </div>
                                            </div>

                                            <div className="flex flex-col items-end gap-1.5">
                                                <p className="font-bold text-sm sm:text-base">
                                                    {formatCurrency(order.price)}
                                                </p>
                                                <Badge variant="outline" className={cn("px-1.5 py-0 sm:px-2.5 sm:py-0.5 text-[10px] sm:text-xs capitalize flex items-center gap-1 font-semibold", getStatusConfig(order.status).color)}>
                                                    <StatusIcon className="w-3 h-3 hidden sm:inline-block" />
                                                    {order.status}
                                                </Badge>
                                            </div>
                                        </div>
                                    )
                                })
                            )}
                        </div>

                        {orders.length > 0 && (
                            <div className="p-3 bg-gray-50/50 dark:bg-gray-900/20 border-t sm:hidden">
                                <Link href="/dashboard/my-orders">
                                    <Button variant="outline" className="w-full text-sm h-9">
                                        View All Orders
                                    </Button>
                                </Link>
                            </div>
                        )}
                    </div>
                )}
            </CardContent>

            {/* Order Details Modal (No Complaint Button) */}
            <Dialog open={!!selectedOrder} onOpenChange={(open) => !open && setSelectedOrder(null)}>
                <DialogContent className="sm:max-w-md p-0 overflow-hidden rounded-2xl">
                    <DialogHeader className="p-6 bg-gray-50 dark:bg-gray-900 border-b pb-4">
                        <DialogTitle className="text-xl font-black flex items-center gap-2">
                            Order Details
                        </DialogTitle>
                        <p className="text-sm text-muted-foreground mt-1">Reference: {selectedOrder?.reference_code}</p>
                    </DialogHeader>
                    
                    {selectedOrder && (
                        <div className="p-6 space-y-4">
                            <div className="flex items-center justify-between pb-4 border-b border-gray-100 dark:border-gray-800">
                                <div>
                                    <p className="text-sm text-muted-foreground mb-1">Status</p>
                                    <Badge variant="outline" className={cn("capitalize px-3 py-1 text-sm font-bold border-0", getStatusConfig(selectedOrder.status).color.replace('border-', ''))}>
                                        {selectedOrder.status}
                                    </Badge>
                                </div>
                                <div className="text-right">
                                    <p className="text-sm text-muted-foreground mb-1">Amount Paid</p>
                                    <p className="text-2xl font-black text-gray-900 dark:text-white">
                                        {formatCurrency(selectedOrder.price)}
                                    </p>
                                </div>
                            </div>

                            <div className="grid grid-cols-2 gap-4 py-2">
                                <div className="space-y-1">
                                    <p className="text-xs text-muted-foreground">Network</p>
                                    <div className="flex items-center gap-2">
                                        <span className={cn("w-2 h-2 rounded-full", getNetworkColor(selectedOrder.network).split(' ')[0])} />
                                        <p className="font-semibold text-gray-900 dark:text-gray-100">{selectedOrder.network}</p>
                                    </div>
                                </div>
                                <div className="space-y-1">
                                    <p className="text-xs text-muted-foreground">Package Size</p>
                                    <p className="font-semibold text-gray-900 dark:text-gray-100">{selectedOrder.size}</p>
                                </div>
                                <div className="space-y-1">
                                    <p className="text-xs text-muted-foreground">Recipient Number</p>
                                    <p className="font-black font-mono text-base text-gray-900 dark:text-gray-100">{selectedOrder.phone_number}</p>
                                </div>
                                <div className="space-y-1">
                                    <p className="text-xs text-muted-foreground">Order Date</p>
                                    <p className="font-semibold text-sm text-gray-900 dark:text-gray-100">
                                        {format(new Date(selectedOrder.created_at), 'MMM d, yyyy h:mm a')}
                                    </p>
                                </div>
                            </div>
                            
                            {selectedOrder.error_message && (
                                <div className="mt-4 p-3 bg-red-50 dark:bg-red-900/10 border border-red-200 dark:border-red-900/30 rounded-lg">
                                    <p className="text-xs font-bold text-red-600 dark:text-red-400 mb-1">Failure Reason</p>
                                    <p className="text-sm text-red-700 dark:text-red-300">{selectedOrder.error_message}</p>
                                </div>
                            )}

                            <div className="pt-4 border-t border-gray-100 dark:border-gray-800">
                                <p className="text-xs text-center text-muted-foreground">
                                    Need help with this order? Go to <Link href="/dashboard/my-orders" className="text-blue-600 dark:text-blue-400 hover:underline">My Orders</Link> to file a complaint.
                                </p>
                            </div>
                        </div>
                    )}
                </DialogContent>
            </Dialog>
        </Card>
    )
}
