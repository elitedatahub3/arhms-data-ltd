'use client'

import { useEffect, useState, Fragment, useMemo } from 'react'
import { formatCurrency, formatDate } from '@/lib/utils'
import { getOrderDisplayStatus } from '@/lib/order-status-display'
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select'
import {
    Pagination,
    PaginationContent,
    PaginationItem,
    PaginationLink,
    PaginationNext,
    PaginationPrevious,
    PaginationEllipsis
} from '@/components/ui/pagination'
import {
    Tabs,
    TabsContent,
    TabsList,
    TabsTrigger,
} from '@/components/ui/tabs'
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    DialogFooter,
} from '@/components/ui/dialog'
import {
    Search,
    MoreVertical,
    CheckCircle2,
    XCircle,
    Clock,
    RefreshCw,
    Download,
    ChevronDown,
    User,
    Package,
    Phone,
    FileText,
    Loader2,
    Calendar as CalendarIcon,
    Trash2
} from 'lucide-react'
import { toast } from 'sonner'
import { Label } from '@/components/ui/label'

// Simple browser-side cache to reduce Vercel CPU usage
const adminCache = {
    orders: { data: null as any[] | null, timestamp: 0 },
    batches: {} as Record<string, { data: any[], total: number, timestamp: 0 }>
}
const CACHE_DURATION = 300000 // 5 minutes (increased from 30s to save CPU)

export default function AdminOrdersPage() {
    const [orders, setOrders] = useState<any[]>([])
    const [loading, setLoading] = useState(true)
    const [searchTerm, setSearchTerm] = useState('')
    const [debouncedSearch, setDebouncedSearch] = useState('')
    const [availableNetworkFilter, setAvailableNetworkFilter] = useState('MTN')
    const [historyNetworkFilter, setHistoryNetworkFilter] = useState('all')
    const [batches, setBatches] = useState<any[]>([])
    const [activeTab, setActiveTab] = useState('available')
    const [historyFilter, setHistoryFilter] = useState('today')
    const [customStart, setCustomStart] = useState('')
    const [customEnd, setCustomEnd] = useState('')
    const [isCustomDialogOpen, setIsCustomDialogOpen] = useState(false)

    // Batch pagination state
    const [batchPage, setBatchPage] = useState(1)
    const [batchTotalCount, setBatchTotalCount] = useState(0)
    const BATCHES_PER_PAGE = 12

    // Download protection states
    const [isDownloading, setIsDownloading] = useState(false)
    const [lastDownloadTime, setLastDownloadTime] = useState(0)
    const DOWNLOAD_COOLDOWN = 3000 // 3 seconds cooldown

    // Debounce search term
    useEffect(() => {
        const timer = setTimeout(() => {
            setDebouncedSearch(searchTerm)
        }, 500)
        return () => clearTimeout(timer)
    }, [searchTerm])

    useEffect(() => {
        const loadInitialData = async () => {
            setLoading(true)
            await Promise.all([fetchOrders(), fetchBatches(1, true)])
            setLoading(false)
        }
        loadInitialData()
        // No realtime channel here: the old one had an empty handler, yet still
        // streamed every orders row change to the tab, costing Supabase egress for nothing.
    }, [])

    // Reset batches when network or date filter changes
    useEffect(() => {
        if (loading) return // Avoid double fetch on mount
        fetchBatches(1, true, false)
    }, [historyNetworkFilter, historyFilter, customStart, customEnd])

    useEffect(() => {
        fetchBatches(batchPage)
    }, [batchPage])

    const fetchOrders = async (force = false) => {
        // Use cache if available and not forced
        const fetchNow = Date.now()
        if (!force && adminCache.orders.data && (fetchNow - adminCache.orders.timestamp < CACHE_DURATION)) {
            setOrders(adminCache.orders.data)
            return
        }

        try {
            const response = await fetch('/api/admin/orders?available=true&limit=200')
            if (!response.ok) {
                const result = await response.json()
                throw new Error(result.error || 'Failed to fetch orders')
            }
            const data = await response.json()
            const freshOrders = data.orders || []

            // Update cache
            adminCache.orders = { data: freshOrders, timestamp: fetchNow }
            setOrders(freshOrders)
        } catch (error: any) {
            console.error('Error fetching orders:', error)
            toast.error(error.message || 'Failed to load orders')
        }
    }

    const fetchBatches = async (pageToFetch: number, isNewFilter = false, force = false) => {
        let startDate = null
        let endDate = null
        const today = new Date()

        if (historyFilter === 'today') {
            startDate = new Date(today.getFullYear(), today.getMonth(), today.getDate()).toISOString()
        } else if (historyFilter === 'yesterday') {
            // Start of yesterday
            const yStart = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)
            // End of yesterday (Start of today)
            const yEnd = new Date(today.getFullYear(), today.getMonth(), today.getDate())

            startDate = yStart.toISOString()
            endDate = yEnd.toISOString()
        } else if (historyFilter === 'last7days') {
            startDate = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString()
        } else if (historyFilter === 'custom' && customStart) {
            startDate = new Date(customStart).toISOString()
            if (customEnd) {
                // Set to end of the day
                const end = new Date(customEnd)
                end.setHours(23, 59, 59, 999)
                endDate = end.toISOString()
            }
        }

        const offset = (pageToFetch - 1) * BATCHES_PER_PAGE
        let url = `/api/admin/batches?limit=${BATCHES_PER_PAGE}&offset=${offset}&network=${historyNetworkFilter}`
        if (startDate) url += `&startDate=${startDate}`
        if (endDate) url += `&endDate=${endDate}`

        // Add search term if active tab is downloaded
        if (activeTab === 'downloaded' && debouncedSearch) {
            url += `&search=${encodeURIComponent(debouncedSearch)}`
        }

        // Cache Check
        const cacheKey = `${url}_${isNewFilter}`
        const currentTime = Date.now()
        if (!force && adminCache.batches[cacheKey] && (currentTime - adminCache.batches[cacheKey].timestamp < CACHE_DURATION)) {
            const cached = adminCache.batches[cacheKey]
            setBatches(cached.data)
            setBatchTotalCount(cached.total)
            return
        }

        try {
            const response = await fetch(url)
            if (!response.ok) {
                const result = await response.json()
                throw new Error(result.error || 'Failed to fetch batches')
            }
            const data = await response.json()
            const newBatches = data.batches || []

            setBatches(newBatches)
            if (isNewFilter) setBatchPage(1)

            // Update Cache
            adminCache.batches[cacheKey] = { data: newBatches, total: data.totalCount || 0, timestamp: currentTime as any }

            setBatchTotalCount(data.totalCount || 0)
        } catch (error: any) {
            console.error('Error fetching batches:', error)
        }
    }

    const totalBatchPages = Math.ceil(batchTotalCount / BATCHES_PER_PAGE)

    const renderBatchPaginationItems = () => {
        const items = []
        const maxVisible = 5
        let startPage = Math.max(1, batchPage - Math.floor(maxVisible / 2))
        let endPage = Math.min(totalBatchPages, startPage + maxVisible - 1)

        if (endPage - startPage + 1 < maxVisible) {
            startPage = Math.max(1, endPage - maxVisible + 1)
        }

        if (startPage > 1) {
            items.push(
                <PaginationItem key="1">
                    <PaginationLink onClick={() => setBatchPage(1)} className="cursor-pointer">1</PaginationLink>
                </PaginationItem>
            )
            if (startPage > 2) items.push(<PaginationEllipsis key="e1" />)
        }

        for (let i = startPage; i <= endPage; i++) {
            items.push(
                <PaginationItem key={i}>
                    <PaginationLink
                        isActive={batchPage === i}
                        onClick={() => setBatchPage(i)}
                        className="cursor-pointer"
                    >
                        {i}
                    </PaginationLink>
                </PaginationItem>
            )
        }

        if (endPage < totalBatchPages) {
            if (endPage < totalBatchPages - 1) items.push(<PaginationEllipsis key="e2" />)
            items.push(
                <PaginationItem key={totalBatchPages}>
                    <PaginationLink onClick={() => setBatchPage(totalBatchPages)} className="cursor-pointer">{totalBatchPages}</PaginationLink>
                </PaginationItem>
            )
        }

        return items
    }

    const handleUpdateStatus = async (orderId: string, newStatus: string) => {
        try {
            const response = await fetch('/api/admin/orders/update-status', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ orderIds: [orderId], status: newStatus })
            })

            const result = await response.json()
            if (!response.ok) throw new Error(result.error || 'Failed to update status')

            // Remove from available orders if it was there
            setOrders(prev => prev.filter(o => o.id !== orderId))
            toast.success(`Order marked as ${newStatus}`)

            // Refresh both orders and batches to reflect the change
            fetchOrders(true)
            fetchBatches(1, true, true)
        } catch (error: any) {
            console.error('Update status error:', error)
            toast.error(`Error: ${error.message || 'Failed to update status'}`)
        }
    }

    const generateExcelFile = async (ordersToExport: any[], filename: string, mode: 'standard' | 'cost' | 'sales' = 'standard') => {
        // Perform export - CUSTOM FORMAT (Beneficiary Msisdn / GIGGS)
        const rows: any[][] = []

        // Data Rows
        let total = 0
        ordersToExport.forEach((order: any) => {
            // Strip leading zero for auto-formatting in Excel
            const phone = (order.phone_number || '').replace(/^0/, '')
            const size = (order.size || '').replace(/GB/i, '').trim()

            if (mode === 'standard') {
                rows.push([phone, size])
            } else if (mode === 'cost') {
                const cost = order.cost_price || 0
                total += cost
                rows.push([phone, size, cost])
            } else if (mode === 'sales') {
                const sales = order.price || 0
                total += sales
                rows.push([phone, size, sales])
            }
        })

        // Add Sum Row for cost/sales
        if (mode !== 'standard') {
            rows.push(['', 'TOTAL SUM', total])
        }

        // @ts-ignore
        const { utils, writeFile } = await import('xlsx-js-style')

        const worksheet = utils.aoa_to_sheet(rows)

        // Styling
        const range = utils.decode_range(worksheet['!ref'] || 'A1:B1')

        // Set widths
        worksheet['!cols'] = [
            { wch: 25 }, // Beneficiary Msisdn
            { wch: 15 }, // GIGGS
            { wch: 15 }  // Price/Cost
        ]

        const PINK_COLOR = 'FF00FF'
        const BORDER_COLOR = 'CCCCCC'

        for (let R = range.s.r; R <= range.e.r; ++R) {
            for (let C = range.s.c; C <= range.e.c; ++C) {
                const cell_address = utils.encode_cell({ r: R, c: C })
                if (!worksheet[cell_address]) continue

                // Standard data styling (no headers)
                worksheet[cell_address].s = {
                    font: { sz: 12, bold: false, color: { rgb: '000000' } },
                    alignment: { horizontal: "center", vertical: "center" },
                    border: {
                        bottom: { style: 'thin', color: { rgb: BORDER_COLOR } },
                        right: { style: 'thin', color: { rgb: BORDER_COLOR } },
                        left: { style: 'thin', color: { rgb: BORDER_COLOR } },
                        top: { style: 'thin', color: { rgb: BORDER_COLOR } }
                    }
                }
            }
        }

        const workbook = utils.book_new()
        utils.book_append_sheet(workbook, worksheet, "Orders")

        writeFile(workbook, filename)
    }

    const handleRefund = async (order: any) => {
        if (!confirm('Are you sure you want to refund this order? This will credit the user\'s wallet.')) return

        try {
            const response = await fetch('/api/admin/orders/refund', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ orderId: order.id })
            })

            const result = await response.json()
            if (!response.ok) throw new Error(result.error || 'Failed to process refund')

            // Update local state
            setOrders(prev => Array.isArray(prev) ? prev.filter(o => o.id !== order.id) : [])
            toast.success('Order refunded successfully')

            // Refresh both orders and batches to reflect the change
            fetchOrders(true)
            fetchBatches(1, true, true)

        } catch (error: any) {
            console.error('Refund error:', error)
            toast.error(error.message || 'Failed to process refund')
        }
    }

    const handleExportExcel = async () => {
        // Check if download is in progress
        if (isDownloading) {
            toast.error('Download already in progress. Please wait...')
            return
        }

        // Check cooldown period
        const now = Date.now()
        const timeSinceLastDownload = now - lastDownloadTime
        if (timeSinceLastDownload < DOWNLOAD_COOLDOWN) {
            const remainingSeconds = Math.ceil((DOWNLOAD_COOLDOWN - timeSinceLastDownload) / 1000)
            toast.error(`Please wait ${remainingSeconds} second(s) before downloading again`)
            return
        }

        const pendingOrders = (Array.isArray(filteredOrders) ? filteredOrders : []).filter(o => o.status === 'pending')

        if (pendingOrders.length === 0) {
            toast.error('No PENDING orders to export')
            return
        }

        if (!confirm(`This will export ${pendingOrders.length} pending orders and move them to the "Downloaded" tab. Continue?`)) {
            return
        }

        setIsDownloading(true)
        try {
            const idempotencyKey = `batch_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`

            // Detect if all orders have the same network for intelligent labeling
            const uniqueNetworks = Array.from(new Set(
                pendingOrders
                    .map(o => o.network?.toString().trim())
                    .filter(Boolean)
            ))
            const batchNetworkLabel = uniqueNetworks.length === 1 ? uniqueNetworks[0] : 'Multiple'

            const response = await fetch('/api/admin/orders/batch', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    orderIds: pendingOrders.map((o: any) => o.id),
                    network: batchNetworkLabel,
                    idempotencyKey: idempotencyKey
                })
            })

            const result = await response.json()
            if (!response.ok) {
                // Handle concurrent download error (409)
                if (response.status === 409) {
                    toast.error(result.error || 'Some orders are already being downloaded by another admin')
                    setIsDownloading(false)
                    return
                }
                throw new Error(result.error || 'Failed to create batch')
            }

            // Get the filename from the backend response (includes admin name)
            const fileName = result.filename || `arhms_orders_${new Date().toISOString().replace(/[:.]/g, '-')}.xlsx`

            // 3. Perform export - CUSTOM FORMAT (Beneficiary Msisdn / GIGGS)
            const rows: any[][] = []

            // Data Rows
            pendingOrders.forEach((order: any) => {
                // Strip leading zero for auto-formatting
                const phone = (order.phone_number || '').replace(/^0/, '')
                const size = (order.size || '').replace(/GB/i, '').trim()

                rows.push([phone, size])
            })

            // @ts-ignore
            const { utils, writeFile } = await import('xlsx-js-style')

            const worksheet = utils.aoa_to_sheet(rows)

            // Styling
            const range = utils.decode_range(worksheet['!ref'] || 'A1:B1')

            // Set widths
            worksheet['!cols'] = [
                { wch: 25 }, // Beneficiary Msisdn
                { wch: 15 }  // GIGGS
            ]

            const PINK_COLOR = 'FF00FF'
            const BORDER_COLOR = 'CCCCCC'

            for (let R = range.s.r; R <= range.e.r; ++R) {
                for (let C = range.s.c; C <= range.e.c; ++C) {
                    const cell_address = utils.encode_cell({ r: R, c: C })
                    if (!worksheet[cell_address]) continue

                    worksheet[cell_address].s = {
                        font: { sz: 12, bold: false, color: { rgb: '000000' } },
                        alignment: { horizontal: "center", vertical: "center" },
                        border: {
                            bottom: { style: 'thin', color: { rgb: BORDER_COLOR } },
                            right: { style: 'thin', color: { rgb: BORDER_COLOR } },
                            left: { style: 'thin', color: { rgb: BORDER_COLOR } },
                            top: { style: 'thin', color: { rgb: BORDER_COLOR } }
                        }
                    }
                }
            }

            const workbook = utils.book_new()
            utils.book_append_sheet(workbook, worksheet, "Orders")

            writeFile(workbook, fileName)
            toast.success('Orders exported and moved to batches')

            setLastDownloadTime(Date.now())
            fetchOrders()
            fetchBatches(1, true)
        } catch (error: any) {
            console.error('Export error:', error)
            // Only show error if download actually failed (not after successful download)
            if (error.message && !error.message.includes('preview') && !error.message.includes('failed')) {
                toast.error(error.message || 'Failed to export orders')
            }
        } finally {
            setIsDownloading(false)
        }
    }

    const reDownloadBatch = async (batch: any) => {
        try {
            const response = await fetch(`/api/admin/orders?batchId=${batch.id}`)
            if (!response.ok) throw new Error('Failed to fetch batch orders')
            const data = await response.json()
            const batchOrdersList = data.orders || []

            if (batchOrdersList.length === 0) {
                toast.error('No orders found in this batch')
                return
            }

            // Perform export - CUSTOM FORMAT (Beneficiary Msisdn / GIGGS)
            const rows: any[][] = []

            // Build Data Rows
            batchOrdersList.forEach((order: any) => {
                // Strip leading zero for auto-formatting
                const phone = (order.phone_number || '').replace(/^0/, '')
                const size = (order.size || '').replace(/GB/i, '').trim()

                rows.push([phone, size])
            })

            // @ts-ignore
            const { utils, writeFile } = await import('xlsx-js-style')
            const worksheet = utils.aoa_to_sheet(rows)

            const range = utils.decode_range(worksheet['!ref'] || 'A1:B1')
            // Set widths
            worksheet['!cols'] = [{ wch: 25 }, { wch: 15 }]

            // Styling
            const PINK_COLOR = 'FF00FF'
            const BORDER_COLOR = 'CCCCCC'

            for (let R = range.s.r; R <= range.e.r; ++R) {
                for (let C = range.s.c; C <= range.e.c; ++C) {
                    const cell_address = utils.encode_cell({ r: R, c: C })
                    if (!worksheet[cell_address]) continue

                    worksheet[cell_address].s = {
                        font: { sz: 12, bold: false, color: { rgb: '000000' } },
                        alignment: { horizontal: "center", vertical: "center" },
                        border: {
                            bottom: { style: 'thin', color: { rgb: BORDER_COLOR } },
                            right: { style: 'thin', color: { rgb: BORDER_COLOR } },
                            left: { style: 'thin', color: { rgb: BORDER_COLOR } },
                            top: { style: 'thin', color: { rgb: BORDER_COLOR } }
                        }
                    }
                }
            }

            const workbook = utils.book_new()
            utils.book_append_sheet(workbook, worksheet, "Orders")
            writeFile(workbook, batch.filename)
            toast.success('Batch re-downloaded')
        } catch (error) {
            toast.error('Failed to re-download batch')
        }
    }

    const handleDownloadAllFiltered = async (exportMode: 'standard' | 'cost' | 'sales' = 'standard') => {
        if (filteredBatches.length === 0) {
            toast.error('No batches to download')
            return
        }

        const label = exportMode === 'cost' ? 'Cost' : exportMode === 'sales' ? 'Sales' : 'Orders'
        const toastId = toast.loading(`Preparing ${label} download for ${filteredBatches.length} batches...`)

        try {
            const batchIds = (Array.isArray(filteredBatches) ? filteredBatches : []).map(b => b.id).join(',')
            const response = await fetch(`/api/admin/orders?batchIds=${batchIds}`)

            if (!response.ok) throw new Error('Failed to fetch orders')
            const data = await response.json()
            const allOrders = data.orders || []

            if (allOrders.length === 0) {
                toast.error('No orders found in selected batches', { id: toastId })
                return
            }

            const prefix = exportMode === 'standard' ? 'arhms_merged' : `arhms_${exportMode}`
            const filename = `${prefix}_${historyFilter}_${new Date().toISOString().substring(0, 10)}.xlsx`

            await generateExcelFile(allOrders, filename, exportMode)

            toast.success(`Downloaded all filtered ${label}`, { id: toastId })
        } catch (error) {
            console.error('Bulk download error:', error)
            toast.error('Failed to download filtered batches', { id: toastId })
        }
    }

    // Batch Card Component defined locally to access props/state needs
    function BatchCard({ batch, onRefund, onFail }: { batch: any, onRefund?: any, onFail?: any }) {
        const [batchOrders, setBatchOrders] = useState<any[]>([])
        const [isLoadingOrders, setIsLoadingOrders] = useState(false)
        const [hasLoaded, setHasLoaded] = useState(false)
        const [isUpdating, setIsUpdating] = useState(false)

        const loadBatchOrders = async () => {
            setIsLoadingOrders(true)
            try {
                const response = await fetch(`/api/admin/orders?batchId=${batch.id}&limit=5000`)
                if (response.ok) {
                    const data = await response.json()
                    setBatchOrders(data.orders || [])
                }
            } catch (error) {
                console.error('Failed to load batch orders', error)
            } finally {
                setIsLoadingOrders(false)
                setHasLoaded(true)
            }
        }

        const onUpdateBatchStatus = async (status: string) => {
            if (!confirm(`Mark all ${batchOrders.length} orders as ${status}?`)) return
            setIsUpdating(true)
            try {
                const response = await fetch('/api/admin/orders/update-status', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ batchId: batch.id, status })
                })

                if (!response.ok) throw new Error('Failed to update')

                toast.success('Batch updated successfully')
                // Refresh local orders
                const updatedOrders = (Array.isArray(batchOrders) ? batchOrders : []).map(o => ({ ...o, status }))
                setBatchOrders(updatedOrders)
                fetchBatches(1, true) // Update global counts if needed
            } catch (error) {
                toast.error('Failed to update batch status')
            } finally {
                setIsUpdating(false)
            }
        }

        const onDeleteFailedOrders = async () => {
            const failedCount = batchOrders.filter(o => o.status === 'failed').length

            if (failedCount === 0) {
                toast.error('No failed orders to delete in this batch')
                return
            }

            if (!confirm(`Delete ${failedCount} failed order(s)? This will permanently remove them from the system and cannot be undone.`)) return

            setIsUpdating(true)
            try {
                const response = await fetch('/api/admin/orders/delete-failed', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ batchId: batch.id })
                })

                const result = await response.json()
                if (!response.ok) throw new Error(result.error || 'Failed to delete')

                toast.success(result.message || 'Failed orders deleted')
                fetchOrders() // Refresh available orders
                fetchBatches(1, true) // Refresh batches list
            } catch (error: any) {
                toast.error(error.message || 'Failed to delete failed orders')
            } finally {
                setIsUpdating(false)
            }
        }

        const displayNetwork = useMemo(() => {
            if (batch.network !== 'Multiple') return batch.network
            if (batchOrders.length === 0) return 'Multiple'
            const uniqueNets = Array.from(new Set(batchOrders.map(o => o.network?.toString().trim()).filter(Boolean)))
            return uniqueNets.length === 1 ? uniqueNets[0] : 'Multiple'
        }, [batch.network, batchOrders])

        return (
            <Card key={batch.id} className="group relative overflow-hidden border-muted/40 shadow-lg hover:shadow-2xl hover:-translate-y-1 transition-all duration-300 flex flex-col h-auto min-h-[300px] max-h-[600px] bg-gradient-to-br from-white to-slate-50 dark:from-slate-950 dark:to-slate-900/50 dark:border-blue-900/20">
                <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/10 to-transparent translate-x-[-200%] group-hover:animate-shine pointer-events-none" />
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2 flex-shrink-0">
                    <div className="flex flex-col overflow-hidden">
                        <CardTitle className="text-sm font-medium truncate" title={batch.filename}>
                            {batch.filename}
                        </CardTitle>
                        <div className="flex gap-2 mt-1">
                            <Badge variant="outline" className="w-fit">{displayNetwork}</Badge>
                            {batch.filename.includes('arhms_') && !batch.filename.includes('arhms_orders_') && (
                                <Badge variant="secondary" className="w-fit text-[10px] bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400 border-purple-200">
                                    Only {batch.filename.split('_')[1]}
                                </Badge>
                            )}
                        </div>
                    </div>
                    <FileText className="w-8 h-8 text-blue-100 dark:text-blue-900 flex-shrink-0" />
                </CardHeader>

                <CardContent className="flex-1 overflow-hidden flex flex-col py-2">
                    <div className="flex items-center justify-between mb-2 flex-shrink-0">
                        <span className="text-xs text-muted-foreground">{formatDate(batch.created_at)}</span>
                        <span className="text-sm font-bold text-blue-600">{batch.order_count} orders</span>
                    </div>

                    <div className="flex-1 overflow-y-auto border rounded-md bg-muted/5 p-2 space-y-2">
                        {!hasLoaded && !isLoadingOrders ? (
                            <div className="h-full flex items-center justify-center min-h-[100px]">
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={loadBatchOrders}
                                    className="text-blue-600 hover:text-blue-700 font-bold"
                                >
                                    <FileText className="w-4 h-4 mr-2" />
                                    Click to View {batch.order_count} Orders
                                </Button>
                            </div>
                        ) : isLoadingOrders ? (
                            <div className="h-full flex items-center justify-center min-h-[100px]">
                                <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
                            </div>
                        ) : hasLoaded && batchOrders.length === 0 ? (
                            <div className="h-full flex items-center justify-center text-xs text-muted-foreground py-10">
                                No orders found
                            </div>
                        ) : (
                            Array.isArray(batchOrders) && batchOrders.map(order => (
                                <div key={order.id} className="text-xs p-2 bg-background rounded border flex items-center justify-between">
                                    <div className="flex flex-col">
                                        <div className="flex items-center gap-1">
                                            <span className="font-bold text-[10px]">{order.users?.first_name} {order.users?.last_name}</span>
                                            {order.shop_name && (
                                                <Badge variant="secondary" className="text-[9px] h-4 px-1.5 bg-blue-100 text-blue-700 hover:bg-blue-100 border-blue-200">
                                                    Shop: {order.shop_name}
                                                </Badge>
                                            )}
                                        </div>
                                        <span className="font-mono text-xs">{order.phone_number}</span>
                                        <span className="text-[10px] text-muted-foreground">{order.network} {order.size}</span>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        {getStatusBadge(displayStatus(order))}
                                        {order.payment_status === 'refunded' ? (
                                            <Badge variant="outline" className="text-[10px] px-1.5 py-0.5 bg-gray-100 text-gray-500">
                                                No actions
                                            </Badge>
                                        ) : (
                                            <DropdownMenu>
                                                <DropdownMenuTrigger asChild>
                                                    <Button variant="ghost" size="icon" className="h-6 w-6 p-0 hover:bg-muted">
                                                        <MoreVertical className="w-3.5 h-3.5" />
                                                    </Button>
                                                </DropdownMenuTrigger>
                                                <DropdownMenuContent align="end">
                                                    {order.status !== 'processing' && (
                                                        <DropdownMenuItem onClick={async () => {
                                                            await handleUpdateStatus(order.id, 'processing')
                                                            // Update local state
                                                            setBatchOrders(prev => Array.isArray(prev) ? prev.map(o => o.id === order.id ? { ...o, status: 'processing' } : o) : [])
                                                        }}>
                                                            <Clock className="w-4 h-4 mr-2 text-blue-500" />
                                                            Mark as Processing
                                                        </DropdownMenuItem>
                                                    )}
                                                    {order.status !== 'failed' && (
                                                        <DropdownMenuItem onClick={async () => {
                                                            await handleUpdateStatus(order.id, 'failed')
                                                            // Update local state
                                                            setBatchOrders(prev => Array.isArray(prev) ? prev.map(o => o.id === order.id ? { ...o, status: 'failed' } : o) : [])
                                                        }}>
                                                            <XCircle className="w-4 h-4 mr-2 text-red-500" />
                                                            Mark as Failed
                                                        </DropdownMenuItem>
                                                    )}
                                                    {order.status !== 'completed' && (
                                                        <DropdownMenuItem onClick={async () => {
                                                            await handleUpdateStatus(order.id, 'completed')
                                                            // Update local state
                                                            setBatchOrders(prev => Array.isArray(prev) ? prev.map(o => o.id === order.id ? { ...o, status: 'completed' } : o) : [])
                                                        }}>
                                                            <CheckCircle2 className="w-4 h-4 mr-2 text-green-500" />
                                                            Mark as Completed
                                                        </DropdownMenuItem>
                                                    )}
                                                    <DropdownMenuItem onClick={async () => {
                                                        await handleRefund(order)
                                                        // Update local state
                                                        setBatchOrders(prev => Array.isArray(prev) ? prev.map(o => o.id === order.id ? { ...o, payment_status: 'refunded', status: 'failed' } : o) : [])
                                                    }}>
                                                        <RefreshCw className="w-4 h-4 mr-2 text-amber-500" />
                                                        Refund Order
                                                    </DropdownMenuItem>
                                                </DropdownMenuContent>
                                            </DropdownMenu>
                                        )}
                                    </div>
                                </div>
                            ))
                        )}
                    </div>
                </CardContent>

                <CardFooter className="p-4 pt-2 border-t flex-shrink-0 gap-2">
                    <Button
                        className="flex-1 bg-green-600 hover:bg-green-700 text-white"
                        size="sm"
                        onClick={() => onUpdateBatchStatus('completed')}
                        disabled={isUpdating}
                    >
                        {isUpdating ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <CheckCircle2 className="w-4 h-4 mr-2" />}
                        Mark All Completed
                    </Button>
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button variant="outline" size="icon" className="h-9 w-9">
                                <MoreVertical className="w-4 h-4" />
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => onUpdateBatchStatus('processing')}>
                                <Clock className="w-4 h-4 mr-2 text-blue-500" />
                                Mark All Processing
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => onUpdateBatchStatus('failed')}>
                                <XCircle className="w-4 h-4 mr-2 text-red-500" />
                                Mark All Failed
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => reDownloadBatch(batch)}>
                                <Download className="w-4 h-4 mr-2" />
                                Re-download
                            </DropdownMenuItem>
                            <div className="h-px bg-border my-1" />
                            <DropdownMenuItem
                                onClick={onDeleteFailedOrders}
                                className="text-red-600 focus:text-red-700 focus:bg-red-50"
                            >
                                <Trash2 className="w-4 h-4 mr-2" />
                                Delete Failed Orders
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                </CardFooter>
            </Card>
        )
    }

    const filteredOrders = useMemo(() => {
        return orders.filter(order => {
            const matchesSearch =
                !debouncedSearch ||
                order.phone_number?.includes(debouncedSearch) ||
                order.users?.email?.toLowerCase().includes(debouncedSearch.toLowerCase()) ||
                order.users?.first_name?.toLowerCase().includes(debouncedSearch.toLowerCase()) ||
                order.users?.last_name?.toLowerCase().includes(debouncedSearch.toLowerCase())

            const matchesNetwork = availableNetworkFilter === 'all' || order.network === availableNetworkFilter

            return matchesSearch && matchesNetwork
        })
    }, [orders, debouncedSearch, availableNetworkFilter])

    const filteredBatches = useMemo(() => {
        // Most filtering now happens on server.
        // We keep this to ensure we always have an array even during loading.
        return batches || []
    }, [batches])

    // A refunded order stores status='failed' + payment_status='refunded'
    // (the base orders.status CHECK cannot hold 'refunded'), so derive the label.
    // Also resolves 'processing' → 'verifying' when the supplier reports the
    // order as held for review. Display only — `status` is untouched.
    const displayStatus = (order: any) => getOrderDisplayStatus(order)

    const getStatusBadge = (status: string) => {
        const styles: Record<string, string> = {
            pending: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
            processing: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
            verifying: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
            completed: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
            failed: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
            refunded: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400',
        }
        // Simplified badge for the small list view
        return (
            <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium uppercase ${styles[status] || styles.pending}`}>
                {status === 'in_review' ? 'Review' : status}
            </span>
        )
    }

    return (
        <div className="space-y-6">
            <div className="flex flex-col items-center gap-4 text-center">
                <div>
                    <h1 className="text-2xl font-bold">Orders Management</h1>
                    <p className="text-muted-foreground">View and manage all customer orders</p>
                </div>
                <div className="flex flex-wrap justify-center gap-2">
                    <Button
                        onClick={handleExportExcel}
                        variant="default"
                        className="bg-emerald-600 hover:bg-emerald-700 text-white border-none"
                        disabled={isDownloading}
                    >
                        {isDownloading ? (
                            <>
                                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                                Exporting...
                            </>
                        ) : (
                            <>
                                <Download className="w-4 h-4 mr-2" />
                                Export to Excel
                            </>
                        )}
                    </Button>
                    <Button
                        onClick={() => { fetchOrders(); fetchBatches(1, true); }}
                        variant="outline"
                        disabled={loading}
                        className="transition-all duration-150 active:scale-95 hover:bg-primary/10 active:bg-primary/20 disabled:opacity-70"
                    >
                        <RefreshCw className={`w-4 h-4 mr-2 transition-transform ${loading ? 'animate-spin' : 'group-active:rotate-180'}`} />
                        {loading ? 'Refreshing...' : 'Refresh'}
                    </Button>
                </div>
            </div>

            <Tabs defaultValue="available" value={activeTab} onValueChange={setActiveTab}>
                <TabsList className="grid w-full grid-cols-2 max-w-[400px]">
                    <TabsTrigger value="available">Available ({orders.length})</TabsTrigger>
                    <TabsTrigger value="downloaded">Downloaded History ({batchTotalCount})</TabsTrigger>
                </TabsList>

                <TabsContent value="available" className="space-y-4">
                    <Card className="border-none shadow-none bg-transparent">
                        <CardHeader className="px-0 pt-0">
                            <div className="flex flex-col md:flex-row gap-4">
                                <div className="relative flex-1">
                                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                                    <Input
                                        id="order-search"
                                        name="order-search"
                                        placeholder="Search orders..."
                                        value={searchTerm}
                                        onChange={(e) => setSearchTerm(e.target.value)}
                                        className="pl-9 bg-secondary/50 border-0 focus-visible:ring-1 focus-visible:ring-purple-500 transition-all rounded-xl"
                                    />
                                </div>
                                <div className="flex flex-wrap gap-1.5">
                                    {['All', 'MTN', 'Telecel', 'AT-iShare', 'AT-BigTime', 'Special MTN Mashup', 'EXPRESS MTN'].map((network) => (
                                        <Button
                                            key={network}
                                            variant={availableNetworkFilter === (network === 'All' ? 'all' : network) ? 'default' : 'outline'}
                                            size="sm"
                                            onClick={() => setAvailableNetworkFilter(network === 'All' ? 'all' : network)}
                                            className={`transition-all duration-150 active:scale-95 ${availableNetworkFilter === (network === 'All' ? 'all' : network)
                                                ? network === 'MTN' || network === 'Special MTN Mashup' || network === 'EXPRESS MTN'
                                                    ? 'bg-yellow-500 hover:bg-yellow-600 text-black'
                                                    : network === 'Telecel'
                                                        ? 'bg-red-600 hover:bg-red-700 text-white'
                                                        : network === 'AT-iShare' || network === 'AT-BigTime'
                                                            ? 'bg-blue-600 hover:bg-blue-700 text-white'
                                                            : 'bg-primary text-primary-foreground'
                                                : 'hover:bg-muted'
                                                }`}
                                        >
                                            {network === 'AT-BigTime' ? 'BigTime' : network === 'Special MTN Mashup' ? 'Mashup' : network === 'EXPRESS MTN' ? 'Express' : network}
                                        </Button>
                                    ))}
                                </div>
                            </div>
                        </CardHeader>
                    </Card>

                    {filteredOrders.length === 0 ? (
                        <div className="flex flex-col items-center justify-center p-12 bg-muted/20 rounded-lg border border-dashed">
                            <Package className="w-12 h-12 text-muted-foreground/50 mb-4" />
                            <p className="text-muted-foreground text-center">No orders found matching your criteria.</p>
                        </div>
                    ) : (
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                            {Array.isArray(filteredOrders) && filteredOrders.map((order) => (
                                <Card key={order.id} className="relative overflow-hidden border shadow-sm lg:hover:shadow-md transition-all duration-200">
                                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                                        <div className="font-mono text-sm text-muted-foreground">
                                            {order.reference_code}
                                        </div>
                                        <div className="flex items-center gap-1.5">
                                            {/* Held on purpose: the buyer accepted the MTN registration wait.
                                                Without this it looks like an ordinary stuck pending order. */}
                                            {order.awaiting_registration && (
                                                <Badge
                                                    variant="secondary"
                                                    className="text-[9px] h-5 px-1.5 bg-amber-100 text-amber-700 hover:bg-amber-100 border-amber-200 dark:bg-amber-900/30 dark:text-amber-400"
                                                    title="Waiting for MTN to register this number — delivers automatically"
                                                >
                                                    Awaiting registration
                                                </Badge>
                                            )}
                                            {getStatusBadge(displayStatus(order))}
                                        </div>
                                    </CardHeader>
                                    <CardContent className="space-y-4 pt-4">
                                        <div className="flex items-start gap-3">
                                            <div className="w-8 h-8 rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center flex-shrink-0">
                                                <User className="w-4 h-4 text-slate-500" />
                                            </div>
                                            <div>
                                                <div className="flex items-center gap-1.5 flex-wrap">
                                                    <p className="text-sm font-semibold">{order.users?.first_name} {order.users?.last_name}</p>
                                                    {order.shop_name && (
                                                        <Badge variant="secondary" className="text-[9px] h-4 px-1.5 bg-blue-100 text-blue-700 hover:bg-blue-100 border-blue-200">
                                                            Shop: {order.shop_name}
                                                        </Badge>
                                                    )}
                                                </div>
                                                <p className="text-xs text-muted-foreground">{order.users?.email}</p>
                                            </div>
                                        </div>

                                        <div className="grid grid-cols-2 gap-2 text-sm">
                                            <div className="flex items-center gap-2 p-2 bg-muted/50 rounded-md">
                                                <Phone className="w-3 h-3 text-muted-foreground" />
                                                <span className="font-mono text-xs">{order.phone_number}</span>
                                            </div>
                                            <div className="flex items-center gap-2 p-2 bg-muted/50 rounded-md">
                                                <Package className="w-3 h-3 text-muted-foreground" />
                                                <span className="text-xs font-medium">{order.network} {order.size}</span>
                                            </div>
                                        </div>

                                        <div className="flex items-center justify-between pt-2 border-t">
                                            <p className="text-sm text-muted-foreground">Price</p>
                                            <p className="font-bold text-lg">{formatCurrency(order.price)}</p>
                                        </div>

                                        <div className="text-xs text-muted-foreground flex items-center gap-1">
                                            <Clock className="w-3 h-3" />
                                            {formatDate(order.created_at)}
                                        </div>
                                    </CardContent>

                                    <CardFooter className="bg-muted/10 p-4 pt-0 mt-4 flex justify-between items-center border-t border-muted/20">
                                        <div className="w-full pt-4">
                                            <DropdownMenu>
                                                <DropdownMenuTrigger asChild>
                                                    <Button variant="outline" className="w-full">
                                                        Actions <ChevronDown className="w-4 h-4 ml-2" />
                                                    </Button>
                                                </DropdownMenuTrigger>
                                                <DropdownMenuContent align="end">
                                                    <DropdownMenuLabel>Manage Order</DropdownMenuLabel>
                                                    {order.status !== 'completed' && (
                                                        <DropdownMenuItem onClick={() => handleUpdateStatus(order.id, 'completed')}>
                                                            <CheckCircle2 className="w-4 h-4 mr-2 text-green-500" />
                                                            Mark as Completed
                                                        </DropdownMenuItem>
                                                    )}
                                                    {order.status !== 'failed' && (
                                                        <DropdownMenuItem onClick={() => handleUpdateStatus(order.id, 'failed')}>
                                                            <XCircle className="w-4 h-4 mr-2 text-red-500" />
                                                            Mark as Failed
                                                        </DropdownMenuItem>
                                                    )}
                                                    {order.status !== 'processing' && (
                                                        <DropdownMenuItem onClick={() => handleUpdateStatus(order.id, 'processing')}>
                                                            <Clock className="w-4 h-4 mr-2 text-blue-500" />
                                                            Mark as Processing
                                                        </DropdownMenuItem>
                                                    )}
                                                    {order.payment_status !== 'refunded' && (
                                                        <DropdownMenuItem onClick={() => handleRefund(order)}>
                                                            <RefreshCw className="w-4 h-4 mr-2 text-amber-500" />
                                                            Refund Order
                                                        </DropdownMenuItem>
                                                    )}
                                                </DropdownMenuContent>
                                            </DropdownMenu>
                                        </div>
                                    </CardFooter>
                                </Card>
                            ))}
                        </div>
                    )}
                </TabsContent>

                <TabsContent value="downloaded" className="space-y-4">
                    <div className="flex flex-col md:flex-row gap-4 justify-between">
                        <div className="relative flex-1 max-w-sm">
                            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                            <Input
                                id="batch-search-history"
                                name="batch-search-history"
                                placeholder="Search batches by phone, ref..."
                                value={searchTerm}
                                onChange={(e) => setSearchTerm(e.target.value)}
                                className="pl-9 bg-secondary/50 border-0 focus-visible:ring-1 focus-visible:ring-purple-500 transition-all rounded-xl"
                            />
                        </div>
                        <div className="flex flex-wrap gap-1.5 pt-1">
                            {['All', 'MTN', 'Telecel', 'AT-iShare', 'AT-BigTime', 'Special MTN Mashup', 'EXPRESS MTN'].map((network) => (
                                <Button
                                    key={network}
                                    id={`network-filter-${network.toLowerCase().replace(/\s+/g, '-')}`}
                                    name={`network-filter-${network.toLowerCase().replace(/\s+/g, '-')}`}
                                    variant={historyNetworkFilter === (network === 'All' ? 'all' : network) ? 'default' : 'outline'}
                                    size="sm"
                                    onClick={() => setHistoryNetworkFilter(network === 'All' ? 'all' : network)}
                                    className={`transition-all duration-150 active:scale-95 text-[10px] h-8 ${historyNetworkFilter === (network === 'All' ? 'all' : network)
                                        ? network === 'MTN' || network === 'Special MTN Mashup' || network === 'EXPRESS MTN'
                                            ? 'bg-yellow-500 hover:bg-yellow-600 text-black'
                                            : network === 'Telecel'
                                                ? 'bg-red-600 hover:bg-red-700 text-white'
                                                : network === 'AT-iShare' || network === 'AT-BigTime'
                                                    ? 'bg-blue-600 hover:bg-blue-700 text-white'
                                                    : 'bg-primary text-primary-foreground'
                                        : 'hover:bg-muted'
                                        }`}
                                >
                                    {network === 'AT-BigTime' ? 'BigTime' : network === 'Special MTN Mashup' ? 'Mashup' : network === 'EXPRESS MTN' ? 'Express' : network}
                                </Button>
                            ))}
                        </div>
                    </div>

                    <div className="flex flex-col sm:flex-row justify-between gap-4 items-center">
                        <div className="flex flex-wrap gap-2 items-center">
                            <Button
                                variant="outline"
                                size="sm"
                                className="bg-background border-dashed"
                                onClick={() => handleDownloadAllFiltered('standard')}
                                disabled={filteredBatches.length === 0}
                            >
                                <Download className="w-4 h-4 mr-2" />
                                Download ({batchTotalCount})
                            </Button>
                            <Button
                                variant="outline"
                                size="sm"
                                className="bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100 dark:bg-emerald-900/20 dark:text-emerald-400 dark:border-emerald-800"
                                onClick={() => handleDownloadAllFiltered('cost')}
                                disabled={filteredBatches.length === 0}
                            >
                                <Download className="w-4 h-4 mr-2" />
                                Download Cost
                            </Button>
                            <Button
                                variant="outline"
                                size="sm"
                                className="bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100 dark:bg-blue-900/20 dark:text-blue-400 dark:border-blue-800"
                                onClick={() => handleDownloadAllFiltered('sales')}
                                disabled={filteredBatches.length === 0}
                            >
                                <Download className="w-4 h-4 mr-2" />
                                Download Sales
                            </Button>
                        </div>
                        <div className="flex items-center space-x-1 bg-muted/50 p-1 rounded-lg">
                            {['today', 'yesterday', 'all'].map((filter) => (
                                <button
                                    key={filter}
                                    onClick={() => setHistoryFilter(filter)}
                                    className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all ${historyFilter === filter
                                        ? 'bg-background shadow text-foreground'
                                        : 'text-muted-foreground hover:text-foreground'
                                        }`}
                                >
                                    {filter.charAt(0).toUpperCase() + filter.slice(1)}
                                </button>
                            ))}
                            <button
                                onClick={() => setIsCustomDialogOpen(true)}
                                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all ${historyFilter === 'custom'
                                    ? 'bg-background shadow text-foreground'
                                    : 'text-muted-foreground hover:text-foreground'
                                    }`}
                            >
                                {historyFilter === 'custom' && customStart && customEnd
                                    ? `${new Date(customStart).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} - ${new Date(customEnd).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
                                    : 'Custom'}
                            </button>
                        </div>
                    </div>
                    {filteredBatches.length === 0 ? (
                        <div className="flex flex-col items-center justify-center p-12 bg-muted/20 rounded-lg border border-dashed">
                            <Download className="w-12 h-12 text-muted-foreground/50 mb-4" />
                            <p className="text-muted-foreground text-center">No download history found.</p>
                        </div>
                    ) : (
                        <>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                {Array.isArray(batches) && batches.map((batch) => (
                                    <BatchCard key={batch.id} batch={batch} onRefund={handleRefund} onFail={handleUpdateStatus} />
                                ))}
                            </div>

                            {totalBatchPages > 1 && (
                                <div className="flex flex-col md:flex-row items-center justify-between gap-4 py-8">
                                    <p className="text-sm text-muted-foreground">
                                        Showing {(batchPage - 1) * BATCHES_PER_PAGE + 1} to {Math.min(batchPage * BATCHES_PER_PAGE, batchTotalCount)} of {batchTotalCount} batches
                                    </p>
                                    <Pagination>
                                        <PaginationContent>
                                            <PaginationItem>
                                                <PaginationPrevious
                                                    onClick={() => setBatchPage(prev => Math.max(1, prev - 1))}
                                                    className={batchPage === 1 ? 'pointer-events-none opacity-50' : 'cursor-pointer'}
                                                />
                                            </PaginationItem>
                                            {renderBatchPaginationItems()}
                                            <PaginationItem>
                                                <PaginationNext
                                                    onClick={() => setBatchPage(prev => Math.min(totalBatchPages, prev + 1))}
                                                    className={batchPage === totalBatchPages ? 'pointer-events-none opacity-50' : 'cursor-pointer'}
                                                />
                                            </PaginationItem>
                                        </PaginationContent>
                                    </Pagination>
                                </div>
                            )}
                        </>
                    )}
                </TabsContent>
            </Tabs>

            <Dialog open={isCustomDialogOpen} onOpenChange={setIsCustomDialogOpen}>
                <DialogContent className="sm:max-w-sm" aria-describedby="date-range-description">
                    <DialogHeader>
                        <DialogTitle>Select Date Range</DialogTitle>
                        <DialogDescription id="date-range-description">
                            Choose a start and end date to filter history.
                        </DialogDescription>
                    </DialogHeader>
                    <div className="grid gap-4 py-4">
                        <div className="grid gap-2">
                            <Label htmlFor="start">Start Date</Label>
                            <Input
                                id="start-date"
                                name="start-date"
                                type="date"
                                value={customStart}
                                onChange={(e) => setCustomStart(e.target.value)}
                            />
                        </div>
                        <div className="grid gap-2">
                            <Label htmlFor="end">End Date</Label>
                            <Input
                                id="end-date"
                                name="end-date"
                                type="date"
                                value={customEnd}
                                onChange={(e) => setCustomEnd(e.target.value)}
                            />
                        </div>
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setIsCustomDialogOpen(false)}>Cancel</Button>
                        <Button onClick={() => {
                            if (customStart && customEnd) {
                                setHistoryFilter('custom')
                                setIsCustomDialogOpen(false)
                            } else {
                                toast.error('Please select both dates')
                            }
                        }}>Apply Filter</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    )
}
