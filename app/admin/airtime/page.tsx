'use client'

import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { 
    Phone, RefreshCw, Loader2, CheckCircle, XCircle, Clock, Settings2, Save, 
    AlertTriangle, ChevronDown, Search, Filter, Calendar, TrendingUp, Coins, 
    User, Mail, ArrowRight, Copy, Info, LayoutDashboard, Database,
    UserCircle,
    CalendarRange,
    ExternalLink,
    X
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
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
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import { 
    format, 
    startOfDay, 
    endOfDay, 
    subDays, 
    startOfWeek, 
    startOfMonth, 
    isWithinInterval, 
    parseISO, 
    isSameDay 
} from 'date-fns'

const NETWORKS = ['MTN', 'Telecel', 'AT'] as const
type Network = typeof NETWORKS[number]

const STATUS_TRANSITIONS: Record<string, string[]> = {
    pending: ['processing', 'failed'],
    processing: ['completed', 'failed'],
    completed: [],
    failed: [],
}

const NETWORK_COLORS: Record<Network, string> = {
    MTN: 'bg-amber-100 text-amber-700 border-amber-200',
    Telecel: 'bg-red-100 text-red-700 border-red-200',
    AT: 'bg-orange-100 text-orange-700 border-orange-200',
}

function MTNLogo() {
    return (
        <svg viewBox="0 0 60 60" className="w-full h-full" fill="none" xmlns="http://www.w3.org/2000/svg">
            <circle cx="30" cy="30" r="30" fill="#FFCC00" />
            <ellipse cx="30" cy="30" rx="23" ry="13" fill="#0056b3" stroke="white" strokeWidth="2" />
            <text x="30" y="35" textAnchor="middle" fontSize="14" fontWeight="900" fill="white" fontStyle="italic" fontFamily="Arial Black, Arial, sans-serif" letterSpacing="0.5">MTN</text>
        </svg>
    )
}
function TelecelLogo() {
    return (
        <svg viewBox="0 0 60 60" className="w-8 h-8" fill="none">
            <circle cx="30" cy="30" r="30" fill="#e63946"/>
            <text x="50%" y="55%" dominantBaseline="middle" textAnchor="middle" fontSize="11" fontWeight="bold" fill="white">Telecel</text>
        </svg>
    )
}
function ATLogo() {
    return (
        <svg viewBox="0 0 60 60" className="w-full h-full bg-white rounded-full shadow-sm" fill="none">
            <text x="29" y="38" textAnchor="end" fontSize="26" fontWeight="bold" fill="#e60000" fontFamily="Arial, sans-serif">a</text>
            <text x="30" y="38" textAnchor="start" fontSize="26" fontWeight="bold" fill="#0056B3" fontFamily="Arial, sans-serif">t</text>
            <text x="30" y="48" textAnchor="middle" fontSize="6.5" fontWeight="bold" fill="#444" fontFamily="Arial, sans-serif" letterSpacing="0.2">life is simple</text>
        </svg>
    )
}

const NetworkLogo = ({ id }: { id: string }) => {
    if (id === 'MTN') return <MTNLogo />
    if (id === 'Telecel') return <TelecelLogo />
    return <ATLogo />
}

function StatusBadge({ status }: { status: string }) {
    const map: Record<string, string> = {
        pending: 'bg-amber-100 text-amber-700 border-amber-200',
        processing: 'bg-blue-100 text-blue-700 border-blue-200',
        completed: 'bg-emerald-100 text-emerald-700 border-emerald-200',
        failed: 'bg-red-100 text-red-700 border-red-200',
    }
    const icons: Record<string, React.ReactNode> = {
        pending: <Clock className="w-3 h-3" />,
        processing: <Loader2 className="w-3 h-3 animate-spin" />,
        completed: <CheckCircle className="w-3 h-3" />,
        failed: <XCircle className="w-3 h-3" />,
    }
    return (
        <span className={cn('inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-black uppercase border tracking-tight', map[status] || 'bg-slate-100 text-slate-600 border-slate-200')}>
            {icons[status]} {status}
        </span>
    )
}

interface Order {
    id: string; reference_code: string; status: string; network: Network
    beneficiary_phone: string; airtime_amount: number; fee_amount: number
    total_paid: number; fee_rate: number; user_role: string; created_at: string
    users?: { first_name: string; last_name: string; email: string; phone_number?: string }
    fulfillment_note?: string; fulfilled_at?: string
    shop_id?: string; shop_name?: string
    type?: string; bundle_preference?: string
    provider?: string | null
    fulfillment_legs?: {
        leg_index: number; amount: number
        status: 'submitting' | 'pending' | 'success' | 'failed'
        transaction_id?: string | null; message?: string | null
    }[]
}

interface AirtimeSettings {
    airtime_fee_mtn_customer: string; airtime_fee_mtn_agent: string
    airtime_fee_telecel_customer: string; airtime_fee_telecel_agent: string
    airtime_fee_at_customer: string; airtime_fee_at_agent: string
    airtime_min_amount: string; airtime_max_amount: string
    airtime_enabled_mtn: string; airtime_enabled_telecel: string; airtime_enabled_at: string
    storefront_airtime_enabled: string
    storefront_mashup_enabled: string
    airtime_auto_fulfillment_enabled: string
    airtime_auto_mtn: string; airtime_auto_telecel: string; airtime_auto_at: string
    // Developer API fee, charged to every API caller. Blank = use the role fee.
    airtime_fee_mtn_api?: string; airtime_fee_telecel_api?: string; airtime_fee_at_api?: string
}

// ─── Status Action Modal ───────────────────────────────────────────────────────
function ActionModal({ order, onClose, onSuccess }: { order: Order | null; onClose: () => void; onSuccess: () => void }) {
    const [targetStatus, setTargetStatus] = useState('')
    const [note, setNote] = useState('')
    const [loading, setLoading] = useState(false)

    useEffect(() => { if (order) { setTargetStatus(''); setNote('') } }, [order])

    if (!order) return null
    const transitions = STATUS_TRANSITIONS[order.status] || []

    const handleSubmit = async () => {
        if (!targetStatus) return
        if (targetStatus === 'failed' && !note.trim()) {
            toast.error('A reason note is required when marking as failed')
            return
        }
        setLoading(true)
        try {
            const res = await fetch('/api/admin/airtime/orders', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ orderId: order.id, status: targetStatus, fulfillmentNote: note }),
            })
            const d = await res.json()
            if (!res.ok) { toast.error(d.error || 'Failed to update order'); return }
            toast.success(`Order marked as ${targetStatus}`)
            onSuccess()
            onClose()
        } catch { toast.error('An error occurred') }
        finally { setLoading(false) }
    }

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4 animate-in fade-in duration-200">
            <div className="bg-white dark:bg-slate-900 rounded-3xl shadow-2xl w-full max-w-sm overflow-hidden animate-in zoom-in-95 duration-200">
                <div className="h-1.5 bg-gradient-to-r from-slate-800 to-slate-950" />
                <div className="p-8">
                    <h3 className="text-xl font-black text-slate-900 dark:text-white mb-1 uppercase tracking-tight">Update Status</h3>
                    <p className="text-xs text-slate-500 mb-6 font-bold tracking-widest opacity-70">REF: {order.reference_code}</p>

                    <div className="bg-slate-50 dark:bg-slate-800 bg-opacity-50 border border-slate-100 dark:border-slate-800 rounded-2xl p-4 mb-6 space-y-3">
                        <div className="flex justify-between items-center text-xs">
                            <span className="text-slate-500 font-bold uppercase tracking-wider">Customer</span>
                            <span className="font-black text-slate-900 dark:text-white uppercase">{order.users?.first_name} {order.users?.last_name}</span>
                        </div>
                        <div className="flex justify-between items-center text-xs text-emerald-600">
                            <span className="font-bold uppercase tracking-wider">Amount</span>
                            <span className="font-black">GHS {order.airtime_amount.toFixed(2)}</span>
                        </div>
                        <div className="flex justify-between items-center text-xs">
                            <span className="text-slate-500 font-bold uppercase tracking-wider">Network</span>
                            <Badge variant="outline" className={cn("font-black tracking-tight", NETWORK_COLORS[order.network])}>{order.network}</Badge>
                        </div>
                    </div>

                    {transitions.length === 0 ? (
                        <div className="text-center py-4 space-y-2">
                             <CheckCircle className="w-10 h-10 text-emerald-500 mx-auto" />
                             <p className="text-xs font-bold text-slate-500">This order is completed and cannot be changed.</p>
                        </div>
                    ) : (
                        <div className="space-y-5">
                            <div>
                                <Label className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-2 block">New Status</Label>
                                <div className="flex gap-2">
                                    {transitions.map(s => (
                                        <button
                                            key={s}
                                            onClick={() => setTargetStatus(s)}
                                            className={cn(
                                                'flex-1 h-12 rounded-xl text-xs font-black uppercase tracking-tight border-2 transition-all',
                                                targetStatus === s
                                                    ? s === 'completed' ? 'bg-emerald-600 border-emerald-600 text-white shadow-lg'
                                                        : s === 'failed' ? 'bg-red-600 border-red-600 text-white shadow-lg'
                                                            : 'bg-blue-600 border-blue-600 text-white shadow-lg'
                                                    : 'border-slate-100 dark:border-slate-800 text-slate-400 dark:text-slate-500 hover:border-slate-200'
                                            )}
                                        >{s}</button>
                                    ))}
                                </div>
                            </div>

                            {targetStatus === 'failed' && (
                                <div className="animate-in slide-in-from-top-2 duration-300">
                                    <Label className="text-[10px] font-black uppercase tracking-widest text-red-600 mb-2 block">Reason for Failure</Label>
                                    <Input
                                        value={note}
                                        onChange={e => setNote(e.target.value)}
                                        placeholder="Reason..."
                                        className="rounded-xl border-red-100 h-12 font-bold"
                                        autoFocus
                                    />
                                    <p className="text-[10px] text-red-400 mt-2 font-bold uppercase leading-tight">
                                        Note: This will NOT refund money. Use manual credit if needed.
                                    </p>
                                </div>
                            )}
                        </div>
                    )}

                    <div className="flex gap-3 mt-8">
                        <Button variant="outline" className="flex-1 rounded-xl h-12 font-bold" onClick={onClose} disabled={loading}>Cancel</Button>
                        {transitions.length > 0 && (
                            <Button
                                className="flex-1 rounded-xl h-12 bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900 font-black uppercase tracking-tight shadow-lg"
                                onClick={handleSubmit}
                                disabled={!targetStatus || loading}
                            >
                                {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : 'Confirm'}
                            </Button>
                        )}
                    </div>
                </div>
            </div>
        </div>
    )
}

// ─── Main Admin Page ───────────────────────────────────────────────────────────
export default function AdminAirtimePage() {
    const [activeTab, setActiveTab] = useState<'orders' | 'settings'>('orders')

    // Orders state
    const [orders, setOrders] = useState<Order[]>([])
    const [ordersLoading, setOrdersLoading] = useState(true)
    const [statusFilter, setStatusFilter] = useState('all')
    const [typeFilter, setTypeFilter] = useState('all')
    const [networkFilter, setNetworkFilter] = useState('all')
    const [search, setSearch] = useState('')
    const [selectedOrder, setSelectedOrder] = useState<Order | null>(null)
    
    // Time filtering
    const [timePeriod, setTimePeriod] = useState('Today')
    const [isCustomDialogOpen, setIsCustomDialogOpen] = useState(false)
    const [customStart, setCustomStart] = useState('')
    const [customEnd, setCustomEnd] = useState('')

    // Settings state
    const [settings, setSettings] = useState<AirtimeSettings>({
        airtime_fee_mtn_customer: '5', airtime_fee_mtn_agent: '3',
        airtime_fee_telecel_customer: '5', airtime_fee_telecel_agent: '3',
        airtime_fee_at_customer: '5', airtime_fee_at_agent: '3',
        airtime_min_amount: '1', airtime_max_amount: '500',
        airtime_enabled_mtn: 'true', airtime_enabled_telecel: 'true', airtime_enabled_at: 'true',
        storefront_airtime_enabled: 'false',
        storefront_mashup_enabled: 'false',
        // Defaults match the migration: auto-fulfilment is off until a human turns
        // it on after a live test, because a mis-sent top-up cannot be recalled.
        airtime_auto_fulfillment_enabled: 'false',
        airtime_auto_mtn: 'false', airtime_auto_telecel: 'false', airtime_auto_at: 'false',
    })
    const [settingsLoading, setSettingsLoading] = useState(true)
    const [savingSettings, setSavingSettings] = useState(false)

    const loadOrders = useCallback(async () => {
        setOrdersLoading(true)
        try {
            // We fetch more orders for the admin to allow frontend filtering by time period
            const params = new URLSearchParams({ 
                status: 'all', // Fetch all to allow local filtering
                network: networkFilter,
                limit: '200' // Increased limit for admin overview
            })
            const res = await fetch(`/api/admin/airtime/orders?${params}`)
            if (res.ok) { 
                const d = await res.json()
                setOrders(d.orders || []) 
            }
        } catch (e) { console.error(e) }
        setOrdersLoading(false)
    }, [networkFilter])

    const loadSettings = useCallback(async () => {
        setSettingsLoading(true)
        try {
            const res = await fetch('/api/admin/airtime/settings')
            if (res.ok) { const d = await res.json(); setSettings(d.settings) }
        } catch (e) { console.error(e) }
        setSettingsLoading(false)
    }, [])

    useEffect(() => { loadOrders() }, [loadOrders])
    useEffect(() => { if (activeTab === 'settings') loadSettings() }, [activeTab, loadSettings])

    const saveSettings = async () => {
        setSavingSettings(true)
        try {
            const res = await fetch('/api/admin/airtime/settings', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings)
            })
            if (res.ok) toast.success('Settings saved successfully!')
            else { const d = await res.json(); toast.error(d.error || 'Failed to save') }
        } catch { toast.error('An error occurred') }
        setSavingSettings(false)
    }

    // Filtering Logic (Frontend)
    const filteredOrders = useMemo(() => {
        return orders.filter(order => {
            // Search
            const matchesSearch = 
                order.beneficiary_phone.toLowerCase().includes(search.toLowerCase()) ||
                order.reference_code.toLowerCase().includes(search.toLowerCase()) ||
                order.users?.first_name?.toLowerCase().includes(search.toLowerCase()) ||
                order.users?.last_name?.toLowerCase().includes(search.toLowerCase()) ||
                order.users?.email?.toLowerCase().includes(search.toLowerCase())
            if (!matchesSearch) return false

            // Status
            if (statusFilter !== 'all' && order.status !== statusFilter) return false

            // Type filter (airtime vs mashup) — driven by typeFilter state
            if (typeFilter !== 'all' && (order.type || 'airtime') !== typeFilter) return false

            // Time Period
            if (timePeriod === 'All') return true
            const date = parseISO(order.created_at)
            const now = new Date()
            if (timePeriod === 'Today') return isSameDay(date, now)
            if (timePeriod === 'Yesterday') return isSameDay(date, subDays(now, 1))
            if (timePeriod === 'This Week') return isWithinInterval(date, { start: startOfWeek(now), end: endOfDay(now) })
            if (timePeriod === 'This Month') return isWithinInterval(date, { start: startOfMonth(now), end: endOfDay(now) })
            if (timePeriod === 'Custom' && customStart && customEnd) {
                return isWithinInterval(date, { 
                    start: startOfDay(new Date(customStart)), 
                    end: endOfDay(new Date(customEnd)) 
                })
            }
            return true
        })
    }, [orders, search, statusFilter, timePeriod, customStart, customEnd])

    // Statistics
    const stats = useMemo(() => {
        const completed = filteredOrders.filter(o => o.status === 'completed')
        return {
            totalRevenue: completed.reduce((acc, o) => acc + o.total_paid, 0),
            totalProfit: completed.reduce((acc, o) => acc + o.fee_amount, 0),
            totalVolume: completed.reduce((acc, o) => acc + o.airtime_amount, 0),
            totalCount: filteredOrders.length,
            pendingCount: filteredOrders.filter(o => o.status === 'pending').length
        }
    }, [filteredOrders])

    const statusTabs = ['all', 'pending', 'processing', 'completed', 'failed']

    return (
        <div className="max-w-7xl mx-auto px-4 py-8 space-y-8 min-h-screen pb-40">
            {/* Header */}
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div>
                    <h1 className="text-3xl font-black text-slate-900 dark:text-white uppercase tracking-tighter flex items-center gap-3">
                        <div className="bg-emerald-500/10 p-2 rounded-2xl">
                             <Phone className="w-8 h-8 text-emerald-500" />
                        </div>
                        Airtime Intelligence
                    </h1>
                    <p className="text-slate-500 font-bold text-sm mt-1 uppercase tracking-widest opacity-70">Global Revenue & Fulfillment Control</p>
                </div>
                
                <div className="flex gap-2">
                    <Button 
                        variant="outline" 
                        onClick={loadOrders} 
                        disabled={ordersLoading} 
                        className="rounded-2xl border-slate-200 h-12 px-6 font-bold"
                    >
                        <RefreshCw className={cn('w-4 h-4 mr-2', ordersLoading && 'animate-spin')} />
                        Refresh
                    </Button>
                    <button
                        onClick={() => setActiveTab(activeTab === 'orders' ? 'settings' : 'orders')}
                        className={cn(
                            "h-12 w-12 rounded-2xl flex items-center justify-center transition-all border-2",
                            activeTab === 'settings' 
                                ? "bg-slate-900 border-slate-900 text-white shadow-xl rotate-90" 
                                : "bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400"
                        )}
                        title={activeTab === 'orders' ? "Switch to Settings" : "Switch to Orders"}
                    >
                        <Settings2 className="w-5 h-5" />
                    </button>
                </div>
            </div>

            {/* Statistics Dashboard */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <div className="bg-white dark:bg-slate-900 rounded-[2.5rem] p-6 shadow-sm border border-slate-100 dark:border-slate-800 group hover:shadow-xl transition-all duration-500">
                    <div className="flex items-center gap-3 mb-4">
                        <div className="bg-emerald-100 dark:bg-emerald-950/40 p-2.5 rounded-2xl group-hover:scale-110 transition-transform">
                            <TrendingUp className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />
                        </div>
                        <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Total Revenue</span>
                    </div>
                    <div className="space-y-1">
                        <p className="text-2xl font-black text-slate-900 dark:text-white truncate tracking-tighter">
                            GHS {stats.totalRevenue.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                        </p>
                        <p className="text-[10px] font-bold text-slate-400 flex items-center gap-1">
                            <Coins className="w-3 h-3 text-emerald-500" /> Volume: GHS {stats.totalVolume.toFixed(2)}
                        </p>
                    </div>
                </div>

                <div className="bg-white dark:bg-slate-900 rounded-[2.5rem] p-6 shadow-sm border border-slate-100 dark:border-slate-800 group hover:shadow-xl transition-all duration-500">
                    <div className="flex items-center gap-3 mb-4">
                        <div className="bg-blue-100 dark:bg-blue-950/40 p-2.5 rounded-2xl group-hover:scale-110 transition-transform">
                            <LayoutDashboard className="w-5 h-5 text-blue-600 dark:text-blue-400" />
                        </div>
                        <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Profit Engine</span>
                    </div>
                    <div className="space-y-1">
                        <p className="text-2xl font-black text-emerald-500 truncate tracking-tighter">
                            GHS {stats.totalProfit.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                        </p>
                        <div className="flex gap-2">
                             <Badge variant="outline" className="text-[9px] font-black uppercase text-blue-500 border-blue-100 px-1 py-0">{stats.totalCount} Orders</Badge>
                        </div>
                    </div>
                </div>

                <div className="bg-white dark:bg-slate-900 rounded-[2.5rem] p-6 shadow-sm border border-slate-100 dark:border-slate-800 group hover:shadow-xl transition-all duration-500">
                    <div className="flex items-center gap-3 mb-4">
                        <div className="bg-amber-100 dark:bg-amber-950/40 p-2.5 rounded-2xl group-hover:scale-110 transition-transform">
                            <Clock className="w-5 h-5 text-amber-600 dark:text-amber-400" />
                        </div>
                        <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Pending Task</span>
                    </div>
                    <div className="space-y-1">
                        <p className={cn("text-2xl font-black tracking-tighter", stats.pendingCount > 0 ? "text-amber-500 animate-pulse" : "text-slate-400")}>
                            {stats.pendingCount} Action{stats.pendingCount !== 1 ? 's' : ''}
                        </p>
                        <p className="text-[10px] font-bold text-slate-400 uppercase tracking-tight">Requires Fulfillment</p>
                    </div>
                </div>

                <div className="bg-slate-900 dark:bg-white rounded-[2.5rem] p-6 shadow-xl border-none flex flex-col justify-center">
                    <div className="flex items-center gap-3 mb-2">
                        <div className="bg-white/10 dark:bg-black/10 p-1.5 rounded-lg">
                            <Database className="w-4 h-4 text-white dark:text-black" />
                        </div>
                        <span className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest">Selected Period</span>
                    </div>
                    <p className="text-xl font-black text-white dark:text-black uppercase tracking-tighter">{timePeriod}</p>
                </div>
            </div>

            {/* Main Interface */}
            <div className="bg-slate-50 dark:bg-slate-950/50 rounded-[3rem] p-2 md:p-6 border border-slate-100 dark:border-slate-800/50">
                {activeTab === 'orders' ? (
                    <div className="space-y-6">
                        {/* Advanced Filtering */}
                        <div className="bg-white dark:bg-slate-900 rounded-[2rem] p-4 border border-slate-100 dark:border-slate-800/50 shadow-sm space-y-4">
                            <div className="flex flex-col lg:flex-row gap-3">
                                <div className="relative flex-1 group">
                                    <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 group-focus-within:text-slate-900 transition-colors" />
                                    <Input
                                        placeholder="Scan reference, phone, or customer name..."
                                        value={search}
                                        onChange={e => setSearch(e.target.value)}
                                        className="pl-12 h-14 rounded-2xl bg-slate-50 dark:bg-slate-800/50 border-transparent focus:bg-white dark:focus:bg-slate-800 font-bold transition-all text-sm"
                                    />
                                </div>
                                <div className="flex gap-2">
                                    <Select value={networkFilter} onValueChange={setNetworkFilter}>
                                        <SelectTrigger className="w-36 h-14 rounded-2xl bg-slate-50 dark:bg-slate-800/50 border-transparent font-black uppercase text-xs tracking-wider">
                                            <SelectValue placeholder="Network" />
                                        </SelectTrigger>
                                        <SelectContent className="rounded-2xl border-slate-100 font-bold">
                                            <SelectItem value="all">Global</SelectItem>
                                            {NETWORKS.map(n => <SelectItem key={n} value={n}>{n}</SelectItem>)}
                                        </SelectContent>
                                    </Select>

                                    <Select value={timePeriod} onValueChange={(val) => {
                                        if (val === 'Custom') setIsCustomDialogOpen(true)
                                        else setTimePeriod(val)
                                    }}>
                                        <SelectTrigger className="w-36 h-14 rounded-2xl bg-slate-50 dark:bg-slate-800/50 border-transparent font-black uppercase text-xs tracking-wider">
                                            <Calendar className="w-4 h-4 mr-1 text-slate-400" />
                                            <SelectValue placeholder="Time" />
                                        </SelectTrigger>
                                        <SelectContent className="rounded-2xl border-slate-100 font-bold">
                                            {['Today', 'Yesterday', 'This Week', 'This Month', 'Custom'].map(period => (
                                                <SelectItem key={period} value={period}>{period}</SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                </div>
                            </div>

                            <div className="flex gap-1.5 overflow-x-auto pb-2 scrollbar-hide">
                                {statusTabs.map(s => (
                                    <button
                                        key={s}
                                        onClick={() => setStatusFilter(s)}
                                        className={cn(
                                            'px-6 py-2.5 rounded-2xl text-[10px] font-black uppercase tracking-widest transition-all border-2 shrink-0',
                                            statusFilter === s 
                                                ? 'bg-slate-900 border-slate-900 text-white shadow-lg scale-[0.98]' 
                                                : 'bg-white dark:bg-slate-800 border-slate-100 dark:border-slate-800 text-slate-400 hover:border-slate-200'
                                        )}
                                    >{s}</button>
                                ))}
                                {/* Type filter pills */}
                                <div className="w-px bg-slate-200 dark:bg-slate-700 mx-1 self-stretch" />
                                {(['all', 'airtime', 'mashup'] as const).map(t => (
                                    <button
                                        key={t}
                                        onClick={() => setTypeFilter(t)}
                                        className={cn(
                                            'px-5 py-2.5 rounded-2xl text-[10px] font-black uppercase tracking-widest transition-all border-2 shrink-0',
                                            typeFilter === t
                                                ? (t === 'mashup' ? 'bg-amber-500 border-amber-500 text-white shadow-lg scale-[0.98]' : 'bg-indigo-600 border-indigo-600 text-white shadow-lg scale-[0.98]')
                                                : 'bg-white dark:bg-slate-800 border-slate-100 dark:border-slate-800 text-slate-400 hover:border-slate-200'
                                        )}
                                    >{t === 'all' ? 'All Types' : t === 'mashup' ? '🎯 Mashup' : '📱 Airtime'}</button>
                                ))}
                            </div>
                        </div>

                        {/* Results Grid */}
                        {ordersLoading ? (
                             <div className="flex flex-col items-center justify-center py-32 space-y-4">
                                <div className="relative">
                                    <Loader2 className="w-12 h-12 animate-spin text-emerald-500" />
                                    <Database className="w-4 h-4 text-slate-400 absolute inset-0 m-auto" />
                                </div>
                                <p className="text-xs font-black text-slate-400 uppercase tracking-[0.3em]">Synchronizing Ledger</p>
                            </div>
                        ) : filteredOrders.length === 0 ? (
                            <div className="bg-white dark:bg-slate-900 rounded-[3rem] py-32 text-center border-2 border-dashed border-slate-100 dark:border-slate-800">
                                <Phone className="w-16 h-16 mx-auto mb-6 text-slate-100 dark:text-slate-800" />
                                <p className="font-black text-slate-900 dark:text-white text-xl uppercase tracking-tighter">Zero Records Found</p>
                                <p className="text-slate-400 font-bold text-sm uppercase tracking-widest mt-1 opacity-70">Adjust your filters to scan more data</p>
                            </div>
                        ) : (
                            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                                {filteredOrders.map(order => {
                                    const isFailed = order.status === 'failed'
                                    // Sanity check: if fee_rate exceeds 100%, the record has corrupt data (old production bug)
                                    const hasCorruptData = order.fee_rate > 100 || (order.total_paid > order.airtime_amount * 3 && order.airtime_amount > 0)

                                    return (
                                    <div key={order.id} className="group relative bg-white dark:bg-slate-900 rounded-[2.5rem] p-6 shadow-sm border border-slate-100 dark:border-slate-800 hover:shadow-2xl hover:border-emerald-200 transition-all duration-500 overflow-hidden">
                                        {/* Top Level: Network and Status */}
                                        <div className="flex items-start justify-between mb-5">
                                            <div className="flex items-center gap-4">
                                                <div className="w-14 h-14 rounded-3xl bg-slate-50 dark:bg-slate-800/50 flex items-center justify-center border border-slate-100 dark:border-slate-800 transition-transform group-hover:scale-110 duration-500">
                                                    <NetworkLogo id={order.network} />
                                                </div>
                                                <div>
                                                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                                                        <span className="font-black text-slate-900 dark:text-white uppercase tracking-tighter text-lg">{order.network} {order.type === 'mashup' ? 'Mashup' : 'Order'}</span>
                                                        <StatusBadge status={order.status} />
                                                        {order.type === 'mashup' && (
                                                            <Badge variant="outline" className="bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 border-amber-200 dark:border-amber-800 uppercase tracking-widest text-[9px] font-black shadow-sm">
                                                                🎯 Mashup
                                                            </Badge>
                                                        )}
                                                        {order.shop_name && (
                                                            <Badge variant="outline" className="bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-400 border-purple-200 dark:border-purple-800 uppercase tracking-widest text-[9px] font-black shadow-sm">
                                                                Shop: {order.shop_name}
                                                            </Badge>
                                                        )}
                                                        {hasCorruptData && (
                                                            <Badge variant="outline" className="bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400 border-red-200 dark:border-red-800 uppercase tracking-widest text-[9px] font-black shadow-sm">
                                                                ⚠️ Data Error
                                                            </Badge>
                                                        )}
                                                    </div>
                                                    {order.type === 'mashup' && order.bundle_preference && (
                                                        <p className="text-[10px] font-black text-amber-600 dark:text-amber-400 uppercase tracking-widest mb-0.5">
                                                            Pref: {order.bundle_preference === 'data' ? 'Data Focus 📊' : order.bundle_preference === 'voice' ? 'Voice Focus 🎙️' : 'Balanced ⚖️'}
                                                        </p>
                                                    )}
                                                    <p className="font-mono text-[10px] font-black text-slate-400 uppercase tracking-widest">REF: {order.reference_code}</p>
                                                </div>
                                            </div>
                                            
                                            <div className="text-right">
                                                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Revenue</p>
                                                {isFailed ? (
                                                    <p className="text-xl font-black text-slate-400 tracking-tighter">—</p>
                                                ) : (
                                                    <p className="text-xl font-black text-slate-900 dark:text-white tracking-tighter">GHS {order.airtime_amount.toFixed(2)}</p>
                                                )}
                                            </div>
                                        </div>

                                        {/* Customer and Beneficiary Section */}
                                        <div className="grid grid-cols-2 gap-3 mb-5">
                                            <div className="bg-slate-50 dark:bg-slate-800/50 rounded-3xl p-4 border border-slate-100 dark:border-slate-800/30">
                                                <div className="flex items-center gap-2.5 mb-2">
                                                    <div className="w-8 h-8 rounded-full bg-slate-900 dark:bg-white text-white dark:text-slate-900 flex items-center justify-center font-black text-[10px] uppercase">
                                                        {order.users?.first_name?.[0]?.toUpperCase()}{order.users?.last_name?.[0]?.toUpperCase()}
                                                    </div>
                                                    <div>
                                                        <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Initiator</p>
                                                        <p className="text-xs font-black text-slate-900 dark:text-white truncate max-w-[100px] uppercase">{order.users?.first_name} {order.users?.last_name}</p>
                                                    </div>
                                                </div>
                                                <div className="flex items-center gap-1.5 text-[10px] text-slate-500 font-bold overflow-hidden">
                                                     <Mail className="w-3 h-3 shrink-0" />
                                                     <span className="truncate">{order.users?.email}</span>
                                                </div>
                                            </div>

                                            <div className="bg-emerald-50 dark:bg-emerald-950/20 rounded-3xl p-4 border border-emerald-100/50 dark:border-emerald-800/30 relative overflow-hidden group/beneficiary">
                                                <p className="text-[9px] font-black text-emerald-600/60 uppercase tracking-widest mb-2 relative z-10">Beneficiary Target</p>
                                                <div className="flex items-center justify-between relative z-10">
                                                    <span className="text-sm font-black text-emerald-700 dark:text-emerald-400 font-mono tracking-tighter">{order.beneficiary_phone}</span>
                                                    <button 
                                                        onClick={() => { navigator.clipboard.writeText(order.beneficiary_phone); toast.success('Target Copied!') }}
                                                        className="w-7 h-7 bg-white dark:bg-slate-900 rounded-lg flex items-center justify-center shadow-sm hover:scale-110 active:scale-95 transition-all outline-none"
                                                        title="Copy Beneficiary Number"
                                                    >
                                                        <Copy className="w-3.5 h-3.5 text-emerald-600" />
                                                    </button>
                                                </div>
                                                <Phone className="absolute -bottom-2 -right-2 w-12 h-12 text-emerald-500/5 group-hover/beneficiary:scale-150 transition-transform duration-700" />
                                            </div>
                                        </div>

                                        {/* Breakdown Box */}
                                        <div className="flex items-center justify-between bg-slate-900 dark:bg-slate-100 rounded-3xl p-4 mb-5">
                                            <div className="space-y-0.5">
                                                <p className="text-[8px] font-black text-slate-500 uppercase tracking-[0.2em]">Net Value</p>
                                                <p className="text-lg font-black text-white dark:text-slate-900 tracking-tighter">GHS {order.airtime_amount.toFixed(2)}</p>
                                            </div>
                                            <div className="h-8 w-px bg-white/10 dark:bg-black/10" />
                                            <div className="space-y-0.5 text-center">
                                                <p className="text-[8px] font-black text-slate-500 uppercase tracking-[0.2em]">Platform Profit</p>
                                                <div className="flex items-center gap-1 justify-center">
                                                    {isFailed || hasCorruptData ? (
                                                        <p className="text-sm font-black text-slate-500">—</p>
                                                    ) : (
                                                        <>
                                                            <Coins className="w-3 h-3 text-emerald-400" />
                                                            <p className="text-sm font-black text-emerald-400">GHS {order.fee_amount.toFixed(2)}</p>
                                                        </>
                                                    )}
                                                </div>
                                            </div>
                                            <div className="h-8 w-px bg-white/10 dark:bg-black/10" />
                                            <div className="space-y-0.5 text-right">
                                                <p className="text-[8px] font-black text-slate-500 uppercase tracking-[0.2em]">Markup</p>
                                                {isFailed || hasCorruptData ? (
                                                    <p className="text-sm font-black text-slate-500">—</p>
                                                ) : (
                                                    <p className="text-sm font-black text-white dark:text-slate-900 tracking-tighter">{order.fee_rate.toFixed(1)}%</p>
                                                )}
                                            </div>
                                        </div>

                                        {/* Hubtel delivery legs — an order over GHS 100 goes out in
                                            several top-ups, and an admin finishing one by hand needs
                                            to know exactly how much already landed. */}
                                        {(order.fulfillment_legs?.length ?? 0) > 0 && (() => {
                                            const legs = order.fulfillment_legs!
                                            const done = legs.filter(l => l.status === 'success')
                                            const deliveredValue = done.reduce((sum, l) => sum + Number(l.amount), 0)
                                            const anyFailed = legs.some(l => l.status === 'failed')
                                            return (
                                                <div className={cn(
                                                    "rounded-3xl p-4 mb-5 border",
                                                    anyFailed
                                                        ? "bg-rose-50 dark:bg-rose-950/20 border-rose-100 dark:border-rose-900/30"
                                                        : "bg-sky-50 dark:bg-sky-950/20 border-sky-100 dark:border-sky-900/30"
                                                )}>
                                                    <div className="flex items-center justify-between mb-2">
                                                        <p className="text-[9px] font-black text-slate-500 uppercase tracking-[0.2em]">
                                                            Hubtel Delivery · {done.length}/{legs.length} legs
                                                        </p>
                                                        <p className="text-[10px] font-black text-slate-700 dark:text-slate-300 uppercase tracking-tight">
                                                            GHS {deliveredValue.toFixed(2)} sent
                                                        </p>
                                                    </div>
                                                    <div className="flex flex-wrap gap-1.5">
                                                        {legs.map(leg => (
                                                            <span
                                                                key={leg.leg_index}
                                                                title={leg.message || leg.transaction_id || ''}
                                                                className={cn(
                                                                    "px-2 py-1 rounded-lg text-[9px] font-black uppercase tracking-widest",
                                                                    leg.status === 'success' && "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400",
                                                                    leg.status === 'failed' && "bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400",
                                                                    (leg.status === 'pending' || leg.status === 'submitting') && "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
                                                                )}
                                                            >
                                                                {leg.leg_index}. GHS {Number(leg.amount).toFixed(2)} · {leg.status}
                                                            </span>
                                                        ))}
                                                    </div>
                                                </div>
                                            )
                                        })()}

                                        {order.fulfillment_note && (
                                            <div className="bg-amber-50 dark:bg-amber-950/20 rounded-3xl p-4 mb-5 border border-amber-100 dark:border-amber-900/30">
                                                <p className="text-[9px] font-black text-amber-600/70 uppercase tracking-[0.2em] mb-1">Fulfilment Note</p>
                                                <p className="text-[11px] font-bold text-amber-700 dark:text-amber-400 leading-relaxed">{order.fulfillment_note}</p>
                                            </div>
                                        )}

                                        {/* Footer: Date and Actions */}
                                        <div className="flex items-center justify-between pt-4 border-t border-slate-100 dark:border-slate-800/50">
                                            <div className="flex items-center gap-2">
                                                <div className="bg-slate-100 dark:bg-slate-800 p-1.5 rounded-lg flex items-center gap-1.5">
                                                     <Calendar className="w-3 h-3 text-slate-400" />
                                                     <span className="text-[10px] font-black text-slate-500 uppercase tracking-tight">
                                                        {format(parseISO(order.created_at), 'MMM d, yyyy · p')}
                                                     </span>
                                                </div>
                                            </div>
                                            
                                            <div className="flex gap-2">
                                                <Button 
                                                    size="sm" 
                                                    className={cn(
                                                        "rounded-2xl h-10 px-6 font-black uppercase text-[10px] tracking-widest transition-all",
                                                        STATUS_TRANSITIONS[order.status]?.length > 0
                                                            ? "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900 shadow-lg hover:shadow-2xl"
                                                            : "bg-slate-100 dark:bg-slate-800 text-slate-300 dark:text-slate-600 pointer-events-none"
                                                    )}
                                                    onClick={() => setSelectedOrder(order)}
                                                >
                                                    Fulfill <ExternalLink className="w-3 h-3 ml-2" />
                                                </Button>
                                            </div>
                                        </div>
                                    </div>
                                    )
                                })}
                            </div>
                        )}
                    </div>
                ) : (
                    <div className="space-y-6 animate-in fade-in duration-500">
                        {settingsLoading ? (
                             <div className="flex flex-col items-center justify-center py-32 space-y-4">
                                <Loader2 className="w-12 h-12 animate-spin text-emerald-500" />
                                <p className="text-xs font-black text-slate-400 uppercase tracking-[0.3em]">Loading Configurations</p>
                            </div>
                        ) : (
                            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                                <div className="lg:col-span-2 space-y-6">
                                    {/* Per-network fee configuration */}
                                    <div className="bg-white dark:bg-slate-900 rounded-[2.5rem] border border-slate-100 dark:border-slate-800 overflow-hidden shadow-sm">
                                        <div className="px-8 py-6 border-b border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/50">
                                            <h2 className="text-xl font-black text-slate-900 dark:text-white uppercase tracking-tighter">Fee Intelligence</h2>
                                            <p className="text-xs text-slate-500 font-bold uppercase tracking-widest mt-1 opacity-70">Variable Rate Configuration</p>
                                        </div>
                                        <div className="divide-y divide-slate-100 dark:divide-slate-800">
                                            {NETWORKS.map(net => {
                                                const custKey = `airtime_fee_${net.toLowerCase()}_customer` as keyof AirtimeSettings
                                                const agentKey = `airtime_fee_${net.toLowerCase()}_agent` as keyof AirtimeSettings
                                                const apiKey = `airtime_fee_${net.toLowerCase()}_api` as keyof AirtimeSettings
                                                const enabledKey = `airtime_enabled_${net.toLowerCase()}` as keyof AirtimeSettings
                                                const isEnabled = settings[enabledKey] !== 'false'

                                                // Live preview calculation (Inline to avoid closure issues)
                                                const previewValue = (type: 'customer' | 'agent') => {
                                                    const key = `airtime_fee_${net.toLowerCase()}_${type}` as keyof AirtimeSettings
                                                    const fee = parseFloat(settings[key] || '0')
                                                    return (10 * (1 + fee / 100)).toFixed(2)
                                                }

                                                return (
                                                    <div key={net} className="px-8 py-8 group hover:bg-slate-50/30 dark:hover:bg-slate-800/20 transition-colors">
                                                        <div className="flex items-center justify-between mb-6">
                                                            <div className="flex items-center gap-4">
                                                                <div className="w-12 h-12 rounded-2xl bg-white dark:bg-slate-800 flex items-center justify-center border border-slate-100 dark:border-slate-800 group-hover:scale-110 transition-transform shadow-sm">
                                                                    <NetworkLogo id={net} />
                                                                </div>
                                                                <div>
                                                                    <h3 className="font-black text-slate-900 dark:text-white uppercase tracking-tight text-lg">{net} Network</h3>
                                                                    <span className={cn('text-[10px] font-black uppercase tracking-[0.2em]', isEnabled ? 'text-emerald-500' : 'text-slate-300')}>
                                                                        {isEnabled ? 'Operational' : 'Deactivated'}
                                                                    </span>
                                                                </div>
                                                            </div>
                                                            <div className="flex items-center gap-3 bg-slate-100 dark:bg-slate-800 px-4 py-2 rounded-2xl">
                                                                <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{isEnabled ? 'ON' : 'OFF'}</span>
                                                                <Switch
                                                                    checked={isEnabled}
                                                                    onCheckedChange={v => setSettings(s => ({ ...s, [enabledKey]: v ? 'true' : 'false' }))}
                                                                />
                                                            </div>
                                                        </div>
                                                        
                                                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                                                            <div className="space-y-4">
                                                                <div className="flex justify-between items-center">
                                                                    <Label className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Customer Surcharge</Label>
                                                                    <Badge variant="outline" className="text-emerald-500 border-emerald-100 font-bold">GHS {previewValue('customer')}</Badge>
                                                                </div>
                                                                <div className="relative group/input">
                                                                    <Input
                                                                        type="number"
                                                                        value={settings[custKey]}
                                                                        onChange={e => setSettings(s => ({ ...s, [custKey]: e.target.value }))}
                                                                        className="rounded-2xl h-14 pr-12 bg-slate-50 border-none font-black text-xl group-hover/input:bg-white transition-all shadow-inner"
                                                                        min="0" max="100" step="0.1"
                                                                    />
                                                                    <span className="absolute right-5 top-1/2 -translate-y-1/2 text-slate-400 font-black text-sm">%</span>
                                                                </div>
                                                                <p className="text-[9px] font-bold text-slate-400 uppercase tracking-tight">Markup above face value for retail clients</p>
                                                            </div>

                                                            <div className="space-y-4">
                                                                <div className="flex justify-between items-center">
                                                                    <Label className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Agent Premium</Label>
                                                                    <Badge variant="outline" className="text-blue-500 border-blue-100 font-bold">GHS {previewValue('agent')}</Badge>
                                                                </div>
                                                                <div className="relative group/input">
                                                                    <Input
                                                                        type="number"
                                                                        value={settings[agentKey]}
                                                                        onChange={e => setSettings(s => ({ ...s, [agentKey]: e.target.value }))}
                                                                        className="rounded-2xl h-14 pr-12 bg-slate-50 border-none font-black text-xl group-hover/input:bg-white transition-all shadow-inner"
                                                                        min="0" max="100" step="0.1"
                                                                    />
                                                                    <span className="absolute right-5 top-1/2 -translate-y-1/2 text-slate-400 font-black text-sm">%</span>
                                                                </div>
                                                                <p className="text-[9px] font-bold text-slate-400 uppercase tracking-tight">Preferred pricing for verified resellers</p>
                                                            </div>
                                                        </div>

                                                        <div className="mt-6 space-y-2">
                                                            <Label className="text-[10px] font-black text-slate-500 uppercase tracking-widest">API Fee (all API users)</Label>
                                                            <div className="relative group/input">
                                                                <Input
                                                                    type="number"
                                                                    value={settings[apiKey] ?? ''}
                                                                    onChange={e => setSettings(s => ({ ...s, [apiKey]: e.target.value }))}
                                                                    placeholder="Blank = use customer/agent fee"
                                                                    className="rounded-2xl h-12 pr-12 bg-slate-50 border-none font-black text-lg group-hover/input:bg-white transition-all shadow-inner"
                                                                    min="0" max="99" step="0.1"
                                                                />
                                                                <span className="absolute right-5 top-1/2 -translate-y-1/2 text-slate-400 font-black text-sm">%</span>
                                                            </div>
                                                            <p className="text-[9px] font-bold text-slate-400 uppercase tracking-tight">Charged on every developer API top-up, whatever the caller&apos;s role</p>
                                                        </div>
                                                    </div>
                                                )
                                            })}
                                        </div>
                                    </div>
                                </div>

                                <div className="space-y-6">
                                    {/* Auto-Fulfilment (Hubtel Commission Services) */}
                                    <div className="bg-white dark:bg-slate-900 rounded-[2.5rem] p-8 border border-slate-100 dark:border-slate-800 shadow-sm space-y-8">
                                        <div className="space-y-2">
                                            <h2 className="text-xl font-black text-slate-900 dark:text-white uppercase tracking-tighter">Auto-Fulfilment</h2>
                                            <p className="text-xs text-slate-500 font-bold uppercase tracking-widest opacity-70">Send Airtime Automatically Via Hubtel</p>
                                        </div>

                                        <div className="bg-rose-50 dark:bg-rose-950/20 rounded-2xl p-4 border border-rose-100 dark:border-rose-950 flex gap-3">
                                            <AlertTriangle className="w-5 h-5 text-rose-500 shrink-0" />
                                            <p className="text-[10px] font-bold text-rose-600 dark:text-rose-400 uppercase leading-relaxed">
                                                Airtime cannot be recalled once sent. Test each network with a GHS 1 order before switching it on. The Hubtel prepaid account must be funded.
                                            </p>
                                        </div>

                                        <div className="space-y-6">
                                            <div className="flex items-center justify-between p-4 bg-slate-50 dark:bg-slate-800/50 rounded-2xl border border-slate-100 dark:border-slate-800">
                                                <div>
                                                    <Label className="text-xs font-black text-slate-900 dark:text-white uppercase tracking-widest">⚡ Auto-Fulfil Master Switch</Label>
                                                    <p className="text-[10px] text-slate-500 font-bold uppercase tracking-tight mt-1">Off = every airtime order waits for an admin, exactly as before.</p>
                                                </div>
                                                <Switch
                                                    checked={settings.airtime_auto_fulfillment_enabled === 'true'}
                                                    onCheckedChange={v => setSettings(s => ({ ...s, airtime_auto_fulfillment_enabled: v ? 'true' : 'false' }))}
                                                />
                                            </div>

                                            {(['MTN', 'Telecel', 'AT'] as const).map(net => {
                                                const key = `airtime_auto_${net.toLowerCase()}` as keyof AirtimeSettings
                                                const masterOff = settings.airtime_auto_fulfillment_enabled !== 'true'
                                                return (
                                                    <div
                                                        key={net}
                                                        className={`flex items-center justify-between p-4 rounded-2xl border border-slate-100 dark:border-slate-800 transition-opacity ${masterOff ? 'opacity-40' : ''}`}
                                                    >
                                                        <div>
                                                            <Label className="text-xs font-black text-slate-900 dark:text-white uppercase tracking-widest">{net} Auto-Fulfil</Label>
                                                            <p className="text-[10px] text-slate-500 font-bold uppercase tracking-tight mt-1">
                                                                Orders over GHS 100 are split into multiple top-ups automatically.
                                                            </p>
                                                        </div>
                                                        <Switch
                                                            checked={settings[key] === 'true'}
                                                            disabled={masterOff}
                                                            onCheckedChange={v => setSettings(s => ({ ...s, [key]: v ? 'true' : 'false' }))}
                                                        />
                                                    </div>
                                                )
                                            })}

                                            <p className="text-[10px] text-slate-400 font-bold uppercase tracking-tight leading-relaxed">
                                                Mashup orders are never auto-fulfilled — they are MTN bundles, not airtime, and stay manual.
                                            </p>
                                        </div>
                                    </div>

                                    {/* System Limits */}
                                    <div className="bg-white dark:bg-slate-900 rounded-[2.5rem] p-8 border border-slate-100 dark:border-slate-800 shadow-sm space-y-8">
                                        <div className="space-y-2">
                                            <h2 className="text-xl font-black text-slate-900 dark:text-white uppercase tracking-tighter">Thresholds & Storefronts</h2>
                                            <p className="text-xs text-slate-500 font-bold uppercase tracking-widest opacity-70">Transaction Boundaries & Global Features</p>
                                        </div>
                                        
                                        <div className="space-y-6">
                                            <div className="flex items-center justify-between p-4 bg-slate-50 dark:bg-slate-800/50 rounded-2xl border border-slate-100 dark:border-slate-800">
                                                <div>
                                                    <Label className="text-xs font-black text-slate-900 dark:text-white uppercase tracking-widest">Storefront Airtime Support</Label>
                                                    <p className="text-[10px] text-slate-500 font-bold uppercase tracking-tight mt-1">Enable guest airtime purchases across all shop storefronts globally.</p>
                                                </div>
                                                <Switch
                                                    checked={settings.storefront_airtime_enabled === 'true'}
                                                    onCheckedChange={v => setSettings(s => ({ ...s, storefront_airtime_enabled: v ? 'true' : 'false' }))}
                                                />
                                            </div>
                                            <div className="flex items-center justify-between p-4 bg-amber-50/50 dark:bg-amber-950/10 rounded-2xl border border-amber-100 dark:border-amber-900/30">
                                                <div>
                                                    <Label className="text-xs font-black text-slate-900 dark:text-white uppercase tracking-widest">🎯 Storefront Mashup (MTN Bundles)</Label>
                                                    <p className="text-[10px] text-slate-500 font-bold uppercase tracking-tight mt-1">Enable the MTN Mashup tab on all shop storefronts — admin fulfils via My MTN App.</p>
                                                </div>
                                                <Switch
                                                    checked={settings.storefront_mashup_enabled === 'true'}
                                                    onCheckedChange={v => setSettings(s => ({ ...s, storefront_mashup_enabled: v ? 'true' : 'false' }))}
                                                />
                                            </div>
                                            <div className="space-y-3">
                                                <Label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Global Floor (Min)</Label>
                                                <div className="relative">
                                                     <Input type="number" value={settings.airtime_min_amount} onChange={e => setSettings(s => ({ ...s, airtime_min_amount: e.target.value }))} className="rounded-2xl h-14 pl-12 bg-slate-50 border-none font-black text-xl shadow-inner" min="0.5" step="0.5" />
                                                     <Coins className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-emerald-500" />
                                                     <span className="absolute right-5 top-1/2 -translate-y-1/2 text-slate-400 font-black text-xs uppercase">GHS</span>
                                                </div>
                                            </div>

                                            <div className="space-y-3">
                                                <Label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Global Ceiling (Max)</Label>
                                                <div className="relative">
                                                     <Input type="number" value={settings.airtime_max_amount} onChange={e => setSettings(s => ({ ...s, airtime_max_amount: e.target.value }))} className="rounded-2xl h-14 pl-12 bg-slate-50 border-none font-black text-xl shadow-inner" min="1" step="1" />
                                                     <AlertTriangle className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-amber-500" />
                                                     <span className="absolute right-5 top-1/2 -translate-y-1/2 text-slate-400 font-black text-xs uppercase">GHS</span>
                                                </div>
                                            </div>
                                        </div>

                                        <div className="pt-4 space-y-4">
                                            <Button 
                                                onClick={saveSettings} 
                                                disabled={savingSettings} 
                                                className="w-full h-16 rounded-[1.5rem] bg-slate-900 hover:bg-black text-white dark:bg-white dark:text-black font-black uppercase tracking-widest text-sm shadow-xl hover:shadow-2xl transition-all"
                                            >
                                                {savingSettings ? <Loader2 className="w-5 h-5 animate-spin mr-2" /> : <Save className="w-5 h-5 mr-2" />}
                                                Commit Changes
                                            </Button>
                                            
                                            <div className="bg-amber-50 dark:bg-amber-950/20 rounded-2xl p-4 border border-amber-100 dark:border-amber-950 flex gap-3">
                                                <AlertTriangle className="w-5 h-5 text-amber-500 shrink-0" />
                                                <p className="text-[10px] font-bold text-amber-600 dark:text-amber-400 uppercase leading-relaxed">
                                                    Caution: Changes to fee structures take effect immediately across all user dashboards.
                                                </p>
                                            </div>
                                        </div>
                                    </div>

                                    {/* Info Card */}
                                    <div className="bg-gradient-to-br from-emerald-500 to-green-600 rounded-[2.5rem] p-8 text-white shadow-xl shadow-emerald-500/20 relative overflow-hidden">
                                        <div className="relative z-10 space-y-4">
                                            <h3 className="text-xl font-black uppercase tracking-tighter">Profit Summary</h3>
                                            <p className="text-xs font-bold text-emerald-50 tracking-widest uppercase opacity-80 leading-relaxed">
                                                Your current fee structure is generating an average of <strong>{((parseFloat(settings.airtime_fee_mtn_customer) + parseFloat(settings.airtime_fee_mtn_agent))/2).toFixed(1)}%</strong> profit per MTN transaction.
                                            </p>
                                            <div className="h-1 w-full bg-white/20 rounded-full overflow-hidden">
                                                <div className="h-full bg-white w-2/3" />
                                            </div>
                                        </div>
                                        <Coins className="absolute -bottom-4 -right-4 w-32 h-32 text-white/10 rotate-12" />
                                    </div>
                                </div>
                            </div>
                        )}
                    </div>
                )}
            </div>

            {/* Overlays */}
            <ActionModal 
                order={selectedOrder} 
                onClose={() => setSelectedOrder(null)} 
                onSuccess={loadOrders} 
            />

            {/* Custom Date Dialog */}
            <Dialog open={isCustomDialogOpen} onOpenChange={setIsCustomDialogOpen}>
                <DialogContent className="rounded-[2.5rem] max-w-[400px] border-none shadow-2xl">
                    <DialogHeader>
                        <DialogTitle className="text-xl font-black uppercase tracking-tighter">Custom Range</DialogTitle>
                        <DialogDescription className="font-bold text-slate-500">
                            Select specific dates for revenue scanning.
                        </DialogDescription>
                    </DialogHeader>
                    <div className="grid gap-6 py-4">
                        <div className="space-y-3">
                            <Label htmlFor="start" className="text-[10px] font-black uppercase tracking-widest text-slate-400">Scan Start</Label>
                            <Input
                                id="start"
                                type="date"
                                value={customStart}
                                onChange={(e) => setCustomStart(e.target.value)}
                                className="rounded-2xl h-14 bg-slate-50 border-none font-black text-lg focus:bg-white transition-all shadow-inner"
                            />
                        </div>
                        <div className="space-y-3">
                            <Label htmlFor="end" className="text-[10px] font-black uppercase tracking-widest text-slate-400">Scan End</Label>
                            <Input
                                id="end"
                                type="date"
                                value={customEnd}
                                onChange={(e) => setCustomEnd(e.target.value)}
                                className="rounded-2xl h-14 bg-slate-50 border-none font-black text-lg focus:bg-white transition-all shadow-inner"
                            />
                        </div>
                    </div>
                    <DialogFooter className="gap-2 sm:gap-0">
                        <Button 
                            variant="outline" 
                            onClick={() => setIsCustomDialogOpen(false)}
                            className="rounded-2xl h-14 font-bold flex-1"
                        >
                            Cancel
                        </Button>
                        <Button 
                            onClick={() => {
                                setTimePeriod('Custom')
                                setIsCustomDialogOpen(false)
                            }}
                            className="bg-slate-900 text-white rounded-2xl h-14 font-black flex-1 uppercase tracking-widest text-xs shadow-lg"
                            disabled={!customStart || !customEnd}
                        >
                            Apply Filter
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    )
}
