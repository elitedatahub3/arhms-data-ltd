'use client'

import { useEffect, useState, useMemo } from 'react'
import { useAuth } from '@/contexts/auth-context'
import { supabase } from '@/lib/supabase'
import { formatCurrency } from '@/lib/utils'
import { getOrderDisplayStatus, getOrderStatusLabel, getOrderStatusBadgeClass } from '@/lib/order-status-display'
import { NetworkIcon } from '@/components/network-icon'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select'
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog'
import {
    Phone,
    ShoppingCart,
    Loader2,
    MessageSquare,
    Wifi
} from 'lucide-react'
import { toast } from 'sonner'
import { Order, DataPackage, Complaint } from '@/types/supabase'
import { format, differenceInHours } from 'date-fns'
interface OrderWithComplaints extends Order {
    complaints?: Complaint[]
}

const NETWORKS = ['All', 'MTN', 'Telecel', 'AT-iShare', 'AT-BigTime', 'Special MTN Mashup', 'EXPRESS MTN']
const STATUSES = ['All', 'pending', 'processing', 'completed', 'failed']
const TIME_PERIODS = ['Today', 'Yesterday', 'This Week', 'This Month', 'Custom']
const PAGE_SIZE = 25

export default function MyOrdersPage() {
    const { dbUser } = useAuth()
    const [orders, setOrders] = useState<OrderWithComplaints[]>([])

    const [isLoading, setIsLoading] = useState(true)
    const [searchQuery, setSearchQuery] = useState('')
    const [networkFilter, setNetworkFilter] = useState('All')
    const [statusFilter, setStatusFilter] = useState('All')
    const [timePeriod, setTimePeriod] = useState('Today')
    const [customStart, setCustomStart] = useState('')
    const [customEnd, setCustomEnd] = useState('')
    const [isCustomDialogOpen, setIsCustomDialogOpen] = useState(false)

    // Complaint dialog
    const [complaintOrder, setComplaintOrder] = useState<Order | null>(null)
    const [complaintDescription, setComplaintDescription] = useState('')
    const [isSubmitting, setIsSubmitting] = useState(false)

    useEffect(() => {
        if (dbUser) {
            fetchData()
        }
    }, [dbUser])

    const fetchData = async () => {
        try {
            // Only fetch orders from the last 30 days for performance
            const thirtyDaysAgo = new Date()
            thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)

            const { data, error } = await supabase
                .from('orders')
                // Only the complaint's status is ever rendered, so pull just that
                // column. `complaints(*)` shipped every field of every complaint
                // for every order on the page — pure weight on a phone.
                .select('*, complaints(status)')
                .eq('user_id', dbUser?.id as any)
                .is('shop_order_id', null)  // Exclude mirrored shop orders from storefront
                .gte('created_at', thirtyDaysAgo.toISOString())
                .order('created_at', { ascending: false })

            if (error) throw error
            setOrders(data || [])
        } catch (error) {
            console.error('Error fetching data:', error)
            toast.error('Failed to load orders')
        } finally {
            setIsLoading(false)
        }
    }

    // Check if order is within 48 hours for complaint eligibility
    const isWithin48Hours = (createdAt: string) => {
        const orderDate = new Date(createdAt)
        const now = new Date()
        return differenceInHours(now, orderDate) < 48
    }

    // Get product name based on network for consistent display
    const getProductName = (order: Order) => {
        const networkNames: Record<string, string> = {
            'MTN': 'MTN Data Bundle',
            'Telecel': 'Telecel Data Bundle',
            'AT-iShare': 'AT Premium Bundle',
            'AT-BigTime': 'AT BigTime Bundle',
        }
        return networkNames[order.network] || `${order.network} Bundle`
    }

    // Filter orders based on all criteria
    const filteredOrders = useMemo(() => {
        let filtered = orders

        // Time period filter
        const now = new Date()
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
        const yesterday = new Date(today)
        yesterday.setDate(yesterday.getDate() - 1)
        const weekStart = new Date(today)
        weekStart.setDate(weekStart.getDate() - weekStart.getDay())
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)

        filtered = filtered.filter(order => {
            const orderDate = new Date(order.created_at)
            switch (timePeriod) {
                case 'Today':
                    return orderDate >= today
                case 'Yesterday':
                    return orderDate >= yesterday && orderDate < today
                case 'This Week':
                    return orderDate >= weekStart
                case 'This Month':
                    return orderDate >= monthStart
                case 'Custom':
                    if (!customStart || !customEnd) return true
                    const start = new Date(customStart)
                    const end = new Date(customEnd)
                    end.setHours(23, 59, 59, 999)
                    return orderDate >= start && orderDate <= end
                default:
                    return true
            }
        })

        // Network filter
        if (networkFilter !== 'All') {
            filtered = filtered.filter(o => o.network === networkFilter)
        }

        // Status filter
        if (statusFilter !== 'All') {
            filtered = filtered.filter(o => o.status === statusFilter)
        }

        // Phone search
        if (searchQuery) {
            const query = searchQuery.toLowerCase()
            filtered = filtered.filter(o =>
                o.phone_number.includes(query)
            )
        }

        return filtered
    }, [orders, searchQuery, networkFilter, statusFilter, timePeriod])

    // Render a page at a time. The totals above still count every matching
    // order — only the cards are limited — because rendering several hundred of
    // them is what makes this list crawl on a cheap phone.
    const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)
    useEffect(() => {
        setVisibleCount(PAGE_SIZE)
    }, [searchQuery, networkFilter, statusFilter, timePeriod, customStart, customEnd])

    const visibleOrders = useMemo(
        () => filteredOrders.slice(0, visibleCount),
        [filteredOrders, visibleCount]
    )

    // Calculate stats from filtered orders
    const stats = useMemo(() => {
        const paidOrders = filteredOrders.filter(o => o.payment_status !== 'refunded')
        const totalAmount = paidOrders.reduce((sum, o) => sum + (o.price || 0), 0)

        // Parse data sizes and sum them
        let totalDataGB = 0
        paidOrders.forEach(order => {
            const sizeStr = order.size.toLowerCase()
            const match = sizeStr.match(/([\d.]+)\s*(gb|mb)/i)
            if (match) {
                const value = parseFloat(match[1])
                const unit = match[2].toLowerCase()
                if (unit === 'gb') {
                    totalDataGB += value
                } else if (unit === 'mb') {
                    totalDataGB += value / 1024
                }
            }
        })

        return {
            totalOrders: filteredOrders.length,
            totalAmount,
            totalData: totalDataGB.toFixed(totalDataGB >= 1 ? 0 : 2)
        }
    }, [filteredOrders])

    const handleComplaint = (order: Order) => {
        setComplaintOrder(order)
        setComplaintDescription('')
    }

    const submitComplaint = async () => {
        if (!complaintOrder || !complaintDescription) return

        setIsSubmitting(true)
        try {
            const response = await fetch('/api/complaints/submit', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    order_id: complaintOrder.id,
                    title: `Issue with order ${complaintOrder.reference_code}`,
                    description: complaintDescription,
                    priority: 'medium',
                })
            })

            if (!response.ok) {
                const errorData = await response.json()
                throw new Error(errorData.error || 'Failed to submit complaint')
            }

            const { complaint: newComplaintFromServer } = await response.json() // Get actual data from server if needed

            toast.success('Complaint submitted successfully')
            // Refresh logic - optimistically add complaint to state
            const newComplaint = {
                id: 'temp-' + Date.now(),
                order_id: complaintOrder.id,
                status: 'pending' as const,
                title: `Issue with order ${complaintOrder.reference_code}`,
                description: complaintDescription,
                created_at: new Date().toISOString(),
                user_id: dbUser?.id,
                updated_at: new Date().toISOString()
            }
            setOrders(orders.map(o => o.id === complaintOrder.id ? { ...o, complaints: [newComplaint as any] } : o))
            setComplaintOrder(null)
        } catch (error) {
            toast.error('Failed to submit complaint')
        } finally {
            setIsSubmitting(false)
        }
    }

    const getStatusBadgeClass = getOrderStatusBadgeClass

    // const getNetworkIcon = (network: string) => { ... } // Removed

    const formatOrderDate = (dateStr: string) => {
        return format(new Date(dateStr), 'MMM dd, yyyy HH:mm')
    }

    // Format amount for display (no truncation)
    const formatAmount = (amount: number) => {
        return `₵${amount.toFixed(2)}`
    }

    if (isLoading) {
        return (
            <div className="space-y-6 px-4 py-6">
                <div className="text-center space-y-2">
                    <Skeleton className="h-8 w-48 mx-auto" />
                    <Skeleton className="h-4 w-64 mx-auto" />
                </div>
                <div className="grid grid-cols-3 gap-3">
                    {[...Array(3)].map((_, i) => (
                        <Skeleton key={i} className="h-20" />
                    ))}
                </div>
                <div className="space-y-4">
                    {[...Array(3)].map((_, i) => (
                        <Skeleton key={i} className="h-48" />
                    ))}
                </div>
            </div>
        )
    }

    return (
        <div className="space-y-6 pb-8">
            {/* Header */}
            <div className="text-center space-y-1 relative">
                <h1 className="text-2xl font-bold">My Order History</h1>
                <p className="text-sm text-muted-foreground">View and manage your order transactions</p>
            </div>

            {/* Summary Stats - Yellow/Gold Theme */}
            <div className="grid grid-cols-3 gap-2 sm:gap-3">
                <div className="bg-[#1a1a1a] rounded-xl p-3 sm:p-4 text-center text-white">
                    <p className="text-base sm:text-lg font-bold">{stats.totalOrders}</p>
                    <p className="text-[10px] sm:text-xs text-gray-400">Total Orders</p>
                </div>
                <div className="bg-[#FACC15] rounded-xl p-3 sm:p-4 text-center text-black">
                    <p className="text-base sm:text-lg font-bold">{formatAmount(stats.totalAmount)}</p>
                    <p className="text-[10px] sm:text-xs text-black/70">Total Amount</p>
                </div>
                <div className="bg-[#1a1a1a] rounded-xl p-3 sm:p-4 text-center text-white">
                    <p className="text-base sm:text-lg font-bold">{stats.totalData} GB</p>
                    <p className="text-[10px] sm:text-xs text-gray-400">Total Data</p>
                </div>
            </div>

            {/* Time Period Filters - All in one row, compact sizing */}
            <div className="grid grid-cols-5 gap-2">
                {['Today', 'Yesterday', 'This Week', 'This Month'].map((period) => (
                    <button
                        key={period}
                        onClick={() => setTimePeriod(period)}
                        className={`px-2 py-2 text-[10px] sm:text-xs rounded-lg border transition-all whitespace-nowrap overflow-hidden text-ellipsis ${timePeriod === period
                            ? 'bg-[#1a1a1a] text-white border-[#1a1a1a] dark:bg-[#FACC15] dark:text-black dark:border-[#FACC15]'
                            : 'bg-transparent border-gray-300 dark:border-gray-600 hover:border-gray-500'
                            }`}
                    >
                        {period}
                    </button>
                ))}
                <button
                    onClick={() => setIsCustomDialogOpen(true)}
                    className={`px-2 py-2 text-[10px] sm:text-xs rounded-lg border transition-all whitespace-nowrap overflow-hidden text-ellipsis ${timePeriod === 'Custom'
                        ? 'bg-[#1a1a1a] text-white border-[#1a1a1a] dark:bg-[#FACC15] dark:text-black dark:border-[#FACC15]'
                        : 'bg-transparent border-gray-300 dark:border-gray-600 hover:border-gray-500'
                        }`}
                >
                    {timePeriod === 'Custom' && customStart && customEnd
                        ? `${new Date(customStart).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' })}-${new Date(customEnd).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' })}`
                        : 'Custom'}
                </button>
            </div>

            {/* Custom Range Inputs REMOVED - using Dialog now */}


            {/* Filters */}
            <div id="order-filters" className="space-y-4">
                {/* Search by Phone */}
                <div className="space-y-2">
                    <Label className="text-sm font-medium">Search by Phone</Label>
                    <div className="relative">
                        <Phone className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                        <Input
                            placeholder="Enter phone number"
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            className="pl-10"
                        />
                    </div>
                </div>

                {/* Filter Dropdowns */}
                <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                        <Label className="text-sm font-medium">Filter by Status</Label>
                        <Select value={statusFilter} onValueChange={setStatusFilter}>
                            <SelectTrigger className="w-full">
                                <SelectValue placeholder="All Statuses" />
                            </SelectTrigger>
                            <SelectContent>
                                {STATUSES.map((status) => (
                                    <SelectItem key={status} value={status}>
                                        {status === 'All' ? 'All Statuses' : status.charAt(0).toUpperCase() + status.slice(1)}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                    <div className="space-y-2">
                        <Label className="text-sm font-medium">Filter by Network</Label>
                        <Select value={networkFilter} onValueChange={setNetworkFilter}>
                            <SelectTrigger className="w-full">
                                <SelectValue placeholder="All Networks" />
                            </SelectTrigger>
                            <SelectContent>
                                {NETWORKS.map((network) => (
                                    <SelectItem key={network} value={network}>
                                        {network === 'All' ? 'All Networks' : network}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                </div>
            </div>

            {/* Order Cards */}
            <div id="orders-table" className="space-y-4">
                {visibleOrders.length === 0 ? (
                    <Card className="shadow-md dark:shadow-gray-900/50">
                        <CardContent className="py-12 text-center">
                            <ShoppingCart className="w-12 h-12 mx-auto text-muted-foreground/50 mb-4" />
                            <p className="text-muted-foreground">No orders found</p>
                        </CardContent>
                    </Card>
                ) : (
                    visibleOrders.map((order) => (
                        <Card key={order.id} className="overflow-hidden border shadow-md hover:shadow-lg transition-shadow dark:shadow-gray-900/50 dark:hover:shadow-gray-900/70">
                            <CardContent className="p-4 space-y-4">
                                {/* Header Row */}
                                <div className="flex items-start justify-between">
                                    <div className="flex items-center gap-3">
                                        <NetworkIcon network={order.network} size={48} />
                                        <div>
                                            <p className="font-semibold text-base">{getProductName(order)}</p>
                                            <p className="text-sm text-muted-foreground">{order.phone_number}</p>
                                        </div>
                                    </div>
                                    <span className={`px-3 py-1 rounded-full text-xs font-medium whitespace-nowrap ${getStatusBadgeClass(getOrderDisplayStatus(order))}`}>
                                        {getOrderStatusLabel(getOrderDisplayStatus(order))}
                                    </span>
                                </div>

                                {/* Details */}
                                <div className="space-y-2 text-sm border-t border-b py-3">
                                    <div className="flex justify-between">
                                        <span className="text-muted-foreground">Order Date:</span>
                                        <span className="font-medium">{formatOrderDate(order.created_at)}</span>
                                    </div>
                                    <div className="flex justify-between">
                                        <span className="text-muted-foreground">Data Bundle:</span>
                                        <span className="font-medium">{order.size}</span>
                                    </div>
                                    <div className="flex justify-between">
                                        <span className="text-muted-foreground">Amount:</span>
                                        <span className="font-medium">{formatCurrency(order.price)}</span>
                                    </div>
                                </div>

                                {/* Footer - Show complain button for orders within 24 hours */}
                                <div className="flex items-center justify-between">
                                    <span className="text-sm text-muted-foreground">{order.status}</span>
                                    {/* Action Area */}
                                    {order.complaints && order.complaints.length > 0 ? (
                                        <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-blue-50 text-blue-700 dark:bg-blue-900/20 dark:text-blue-400 border border-blue-100 dark:border-blue-800">
                                            <MessageSquare className="w-3.5 h-3.5" />
                                            <span className="text-xs font-medium capitalize">
                                                Complaint: {order.complaints[0].status.replace('_', ' ')}
                                            </span>
                                        </div>
                                    ) : (
                                        order.status === 'completed' && isWithin48Hours(order.created_at) && (
                                            <Button
                                                id="complaint-button"
                                                size="sm"
                                                variant="outline"
                                                onClick={() => handleComplaint(order)}
                                                className="text-orange-600 border-orange-200 hover:bg-orange-50 dark:text-orange-400 dark:border-orange-800 dark:hover:bg-orange-900/20"
                                            >
                                                <MessageSquare className="w-4 h-4 mr-1" />
                                                Complain
                                            </Button>
                                        )
                                    )}
                                </div>
                            </CardContent>
                        </Card>
                    ))
                )}

                {filteredOrders.length > visibleOrders.length && (
                    <div className="flex flex-col items-center gap-2 pt-2">
                        <Button
                            variant="outline"
                            className="w-full sm:w-auto"
                            onClick={() => setVisibleCount(c => c + PAGE_SIZE)}
                        >
                            Load more orders
                        </Button>
                        <p className="text-xs text-muted-foreground">
                            Showing {visibleOrders.length} of {filteredOrders.length}
                        </p>
                    </div>
                )}
            </div>

            {/* Complaint Dialog */}
            <Dialog open={!!complaintOrder} onOpenChange={() => setComplaintOrder(null)}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>File a Complaint</DialogTitle>
                        <DialogDescription>
                            Describe the issue with your order
                        </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4 py-4">
                        <div className="p-4 rounded-xl bg-muted/50 text-sm">
                            <div className="flex justify-between">
                                <span>Phone:</span>
                                <span>{complaintOrder?.phone_number}</span>
                            </div>
                            <div className="flex justify-between mt-1">
                                <span>Package:</span>
                                <span>{complaintOrder?.size}</span>
                            </div>
                            <div className="flex justify-between mt-1">
                                <span>Amount:</span>
                                <span>{formatCurrency(complaintOrder?.price || 0)}</span>
                            </div>
                        </div>
                        <div className="space-y-2">
                            <Label>Description</Label>
                            <Textarea
                                placeholder="Describe your issue..."
                                value={complaintDescription}
                                onChange={(e) => setComplaintDescription(e.target.value)}
                                rows={4}
                            />
                        </div>
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setComplaintOrder(null)}>
                            Cancel
                        </Button>
                        <Button onClick={submitComplaint} disabled={isSubmitting || !complaintDescription}>
                            {isSubmitting ? (
                                <>
                                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                                    Submitting...
                                </>
                            ) : (
                                'Submit Complaint'
                            )}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Custom Date Filter Dialog */}
            <Dialog open={isCustomDialogOpen} onOpenChange={setIsCustomDialogOpen}>
                <DialogContent className="sm:max-w-sm rounded-[24px]">
                    <DialogHeader>
                        <DialogTitle>Select Date Range</DialogTitle>
                        <DialogDescription>
                            Filter your order history by date.
                        </DialogDescription>
                    </DialogHeader>
                    <div className="grid gap-4 py-4">
                        <div className="grid gap-2">
                            <Label htmlFor="u-start">Start Date</Label>
                            <Input
                                id="u-start"
                                type="date"
                                value={customStart}
                                onChange={(e) => setCustomStart(e.target.value)}
                                className="rounded-xl"
                            />
                        </div>
                        <div className="grid gap-2">
                            <Label htmlFor="u-end">End Date</Label>
                            <Input
                                id="u-end"
                                type="date"
                                value={customEnd}
                                onChange={(e) => setCustomEnd(e.target.value)}
                                className="rounded-xl"
                            />
                        </div>
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setIsCustomDialogOpen(false)} className="rounded-xl">Cancel</Button>
                        <Button
                            onClick={() => {
                                if (customStart && customEnd) {
                                    setTimePeriod('Custom')
                                    setIsCustomDialogOpen(false)
                                } else {
                                    toast.error('Please select both dates')
                                }
                            }}
                            className="rounded-xl bg-[#1a1a1a] text-white hover:bg-black dark:bg-brand-gold dark:text-black dark:hover:bg-brand-gold-dark"
                        >
                            Apply Filter
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div >
    )
}
