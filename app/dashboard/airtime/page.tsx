'use client'

import React, { useState, useEffect, useCallback, useMemo, Suspense } from 'react'
import { Phone, CheckCircle, Copy, Wallet, AlertTriangle, Loader2, ChevronRight, Info, History, X, ArrowRight, RefreshCw, Search, Calendar, Filter, TrendingUp, Coins, Clock, CalendarRange } from 'lucide-react'
import { useAuth } from '@/contexts/auth-context'
import { useSearchParams } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
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
import { format, startOfDay, endOfDay, subDays, startOfWeek, startOfMonth, isWithinInterval, parseISO, isSameDay } from 'date-fns'

// ─── Constants ────────────────────────────────────────────────────────────────
const NETWORKS = [
    { id: 'MTN', label: 'MTN', color: '#F5A623', gradient: 'from-[#F5A623] to-[#FFCC02]', textColor: 'text-[#b37700]', prefixes: ['024','054','055','059','025','053'] },
    { id: 'Telecel', label: 'Telecel', color: '#e63946', gradient: 'from-[#e63946] to-[#ff6b6b]', textColor: 'text-[#9b1e28]', prefixes: ['020','050'] },
    { id: 'AT', label: 'AirtelTigo', color: '#F97316', gradient: 'from-[#F97316] to-[#fb923c]', textColor: 'text-[#9a4e0f]', prefixes: ['027','057','026','056','028','058'] },
]

const QUICK_AMOUNTS = [1, 2, 5, 10, 20, 50]

function detectNetwork(phone: string) {
    if (phone.length < 3) return null
    const prefix = phone.slice(0, 3)
    return NETWORKS.find(n => n.prefixes.includes(prefix)) || null
}

function getNetworkWarning(phone: string, selectedNetwork: string | null) {
    if (!selectedNetwork || phone.length < 3) return null
    const auto = detectNetwork(phone)
    if (!auto) return 'Unrecognized prefix — please confirm your network.'
    if (auto.id !== selectedNetwork) return `This number looks like it belongs to ${auto.label}. Please verify before proceeding.`
    return null
}

// ─── Network Logo SVGs ────────────────────────────────────────────────────────
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

interface AirtimeSettings {
    fee_mtn_customer: number; fee_mtn_agent: number
    fee_telecel_customer: number; fee_telecel_agent: number
    fee_at_customer: number; fee_at_agent: number
    min_amount: number; max_amount: number
    enabled_mtn: boolean; enabled_telecel: boolean; enabled_at: boolean
}

interface AirtimeOrder {
    id: string; reference_code: string; network: string; beneficiary_phone: string
    airtime_amount: number; fee_amount: number; total_paid: number
    status: string; created_at: string; use_exact_amount: boolean
    type?: string; bundle_preference?: string
}

// ─── Status Badge ─────────────────────────────────────────────────────────────
function StatusBadge({ status }: { status: string }) {
    const map: Record<string, string> = {
        pending: 'bg-amber-100 text-amber-700 border-amber-200',
        processing: 'bg-blue-100 text-blue-700 border-blue-200',
        completed: 'bg-emerald-100 text-emerald-700 border-emerald-200',
        failed: 'bg-red-100 text-red-700 border-red-200',
    }
    return (
        <span className={cn('inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold border capitalize', map[status] || 'bg-slate-100 text-slate-600 border-slate-200')}>
            {status}
        </span>
    )
}

// ─── Success Modal ─────────────────────────────────────────────────────────────
function SuccessModal({ order, onClose, onBuyMore }: { order: AirtimeOrder | null; onClose: () => void; onBuyMore: () => void }) {
    const [copied, setCopied] = useState(false)
    if (!order) return null

    const copy = () => {
        navigator.clipboard.writeText(order.reference_code)
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
    }

    return (
        <div className="fixed inset-0 z-[70] flex items-center justify-center overflow-y-auto overscroll-contain bg-black/60 backdrop-blur-sm p-4 animate-in fade-in duration-200">
            <div className="bg-white dark:bg-slate-900 rounded-[2rem] shadow-2xl w-full max-w-sm my-auto max-h-[85dvh] overflow-y-auto animate-in zoom-in-95 duration-300">
                <div className="h-1.5 bg-gradient-to-r from-emerald-400 to-green-500" />
                <div className="p-6 text-center">
                    <div className="w-16 h-16 rounded-full bg-emerald-50 dark:bg-emerald-950/30 border-2 border-emerald-200 dark:border-emerald-800 flex items-center justify-center mx-auto mb-4 animate-in zoom-in duration-500">
                        <CheckCircle className="w-8 h-8 text-emerald-500" />
                    </div>
                    <h2 className="text-xl font-bold text-slate-900 dark:text-white mb-0.5">
                        {order.type === 'mashup' ? 'Mashup Order Placed! 🎯' : 'Order Placed!'}
                    </h2>
                    <p className="text-slate-500 dark:text-slate-400 text-[13px] mb-4">
                        {order.type === 'mashup'
                            ? 'Your MTN Bundle request is pending — admin will fulfil via My MTN App'
                            : 'Your airtime is being processed'}
                    </p>

                    <div className="bg-slate-50 dark:bg-slate-800 rounded-2xl p-4 mb-4 text-left space-y-2.5">
                        <div className="flex justify-between text-sm"><span className="text-slate-500 dark:text-slate-400">Network</span><span className="font-semibold text-slate-900 dark:text-white">{order.network}</span></div>
                        <div className="flex justify-between text-sm"><span className="text-slate-500 dark:text-slate-400">Recipient</span><span className="font-semibold text-slate-900 dark:text-white">{order.beneficiary_phone}</span></div>
                        {order.type === 'mashup' && order.bundle_preference && (
                            <div className="flex justify-between text-sm"><span className="text-slate-500 dark:text-slate-400">Preference</span><span className="font-semibold text-amber-600 dark:text-amber-400 capitalize">{order.bundle_preference === 'data' ? 'Data Focus 📊' : order.bundle_preference === 'voice' ? 'Voice Focus 🎙️' : 'Balanced ⚖️'}</span></div>
                        )}
                        <div className="flex justify-between text-sm"><span className="text-slate-500 dark:text-slate-400">{order.type === 'mashup' ? 'Bundle Value' : 'Airtime'}</span><span className="font-semibold text-emerald-600 dark:text-emerald-400">GHS {order.airtime_amount.toFixed(2)}</span></div>
                        <div className="flex justify-between text-sm border-t border-slate-200 dark:border-slate-700 pt-2.5 mt-1"><span className="text-slate-500 dark:text-slate-400 font-medium">You Paid</span><span className="font-bold text-slate-900 dark:text-white">GHS {order.total_paid.toFixed(2)}</span></div>
                    </div>

                    <button onClick={copy} className="w-full flex items-center justify-between bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-xl px-4 py-3 mb-4 transition-colors group">
                        <div className="text-left">
                            <p className="text-xs text-slate-400 mb-0.5">Reference Code</p>
                            <p className="font-mono font-bold text-slate-800 dark:text-slate-200 text-sm">{order.reference_code}</p>
                        </div>
                        <Copy className={cn('w-4 h-4 transition-colors', copied ? 'text-emerald-500' : 'text-slate-400 group-hover:text-slate-600')} />
                    </button>

                    <p className="text-xs text-slate-400 mb-5 font-medium leading-tight">
                        {order.type === 'mashup'
                            ? 'Admin will buy the bundle via My MTN App and credit your number shortly.'
                            : 'The network provider will send a confirmation SMS once credited.'}
                    </p>

                    <div className="flex gap-3">
                        <Button variant="outline" className="flex-1 rounded-xl h-11" onClick={onBuyMore}>Buy More</Button>
                        <Button className="flex-1 rounded-xl bg-emerald-600 hover:bg-emerald-700 h-11" onClick={onClose}>
                            History <ChevronRight className="w-4 h-4 ml-1" />
                        </Button>
                    </div>
                </div>
            </div>
        </div>
    )
}

// ─── Confirm Sheet ─────────────────────────────────────────────────────────────
function ConfirmSheet({ open, onCancel, onConfirm, isLoading, details }: {
    open: boolean; onCancel: () => void; onConfirm: () => void; isLoading: boolean
    details: { network: string; phone: string; airtime: number; fee: number; total: number; mode: boolean; orderType?: 'airtime' | 'mashup'; preference?: string }
}) {
    if (!open) return null
    return (
        <div className="fixed inset-0 z-[70] flex items-center justify-center overflow-y-auto overscroll-contain bg-black/50 backdrop-blur-sm p-4 animate-in fade-in duration-200">
            <div className="bg-white dark:bg-slate-900 rounded-3xl shadow-2xl w-full max-w-sm my-auto max-h-[85dvh] overflow-y-auto animate-in zoom-in-95 duration-300">
                <div className="h-1.5 bg-gradient-to-r from-slate-700 to-slate-900 rounded-t-3xl" />
                <div className="p-6">
                    <h3 className="text-lg font-bold text-slate-900 dark:text-white mb-1">Confirm Payment</h3>
                    <p className="text-sm text-slate-500 dark:text-slate-400 mb-5">Please review before proceeding</p>
                    <div className="space-y-2.5 mb-6">
                        <div className="flex justify-between text-sm"><span className="text-slate-500 dark:text-slate-400">Network</span><span className="font-semibold dark:text-white">{details.network}</span></div>
                        <div className="flex justify-between text-sm"><span className="text-slate-500 dark:text-slate-400">Recipient</span><span className="font-semibold dark:text-white">{details.phone}</span></div>
                        {details.orderType === 'mashup' && details.preference && (
                            <div className="flex justify-between text-sm"><span className="text-slate-500 dark:text-slate-400">Bundle Pref</span><span className="font-semibold text-amber-600 dark:text-amber-400 capitalize">{details.preference === 'data' ? 'Data Focus' : details.preference === 'voice' ? 'Voice Focus' : 'Balanced'}</span></div>
                        )}
                        <div className="flex justify-between text-sm"><span className="text-slate-500 dark:text-slate-400">{details.orderType === 'mashup' ? 'Bundle Value' : 'Airtime to send'}</span><span className="font-semibold text-emerald-600 dark:text-emerald-400">GHS {details.airtime.toFixed(2)}</span></div>
                        <div className="flex justify-between text-sm"><span className="text-slate-500 dark:text-slate-400">Service fee</span><span className="font-semibold dark:text-white">GHS {details.fee.toFixed(2)}</span></div>
                        <div className="flex justify-between text-sm border-t border-slate-100 dark:border-slate-700 pt-2.5 mt-1">
                            <span className="font-bold text-slate-800 dark:text-slate-200">Total to Pay</span>
                            <span className="font-bold text-lg text-slate-900 dark:text-white">GHS {details.total.toFixed(2)}</span>
                        </div>
                    </div>
                    <div className="flex gap-3">
                        <Button variant="outline" className="flex-1 rounded-xl h-11" onClick={onCancel} disabled={isLoading}>Cancel</Button>
                        <Button
                            className="flex-1 rounded-xl bg-slate-900 hover:bg-slate-800 text-white h-11"
                            onClick={onConfirm}
                            disabled={isLoading}
                        >
                            {isLoading ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Processing...</> : <>Confirm & Pay <ArrowRight className="w-4 h-4 ml-1" /></>}
                        </Button>
                    </div>
                </div>
            </div>
        </div>
    )
}

// ─── Hybrid Bundle Estimation Engine ────────────────────────────────────────
const SKEW = {
    balanced: { data: 1.00, voice: 1.00 },
    data:     { data: 1.25, voice: 0.60 },
    voice:    { data: 0.60, voice: 1.40 },
}
const TIERS = [
    { amount: 1,  dataMB: 10,  voiceMin: 9  },
    { amount: 2,  dataMB: 20,  voiceMin: 18 },
    { amount: 5,  dataMB: 75,  voiceMin: 72 },
]
type BundleEst = { mode: 'exact'; dataMB: number; voiceMin: number } | { mode: 'estimate'; dataLowMB: number; dataHighMB: number; voiceLowMin: number; voiceHighMin: number }
function estimateMashupBundle(amount: number, pref: 'balanced' | 'data' | 'voice'): BundleEst {
    const skew = SKEW[pref]
    if (amount >= 10) {
        return { mode: 'exact', dataMB: Math.round(amount * 18 * skew.data), voiceMin: Math.round(amount * 17.3 * skew.voice) }
    }
    const lower = [...TIERS].reverse().find(t => t.amount <= amount) || TIERS[0]
    const upper = TIERS.find(t => t.amount >= amount) || TIERS[TIERS.length - 1]
    return { mode: 'estimate', dataLowMB: lower.dataMB, dataHighMB: upper.dataMB, voiceLowMin: lower.voiceMin, voiceHighMin: upper.voiceMin }
}

// ─── Main Page ────────────────────────────────────────────────────────────────
function AirtimePageInner() {
    const { dbUser } = useAuth()
    const searchParams = useSearchParams()
    const [activeTab, setActiveTab] = useState<'buy' | 'history'>('buy')

    // Settings & wallet
    const [settings, setSettings] = useState<AirtimeSettings | null>(null)
    const [walletBalance, setWalletBalance] = useState<number | null>(null)
    const [userRole, setUserRole] = useState<'customer' | 'agent'>('customer')
    const [settingsLoading, setSettingsLoading] = useState(true)

    // Form state
    const [selectedNetwork, setSelectedNetwork] = useState<string | null>(null)
    const [isManualSelection, setIsManualSelection] = useState(false)
    const [phone, setPhone] = useState('')
    const [amount, setAmount] = useState('')
    const [useExact, setUseExact] = useState(false)
    const [mode, setMode] = useState<'airtime' | 'mashup'>('airtime')
    const [bundlePreference, setBundlePreference] = useState<'balanced' | 'data' | 'voice'>('balanced')

    // UI state
    const [isSubmitting, setIsSubmitting] = useState(false)
    const [showConfirm, setShowConfirm] = useState(false)
    const [successOrder, setSuccessOrder] = useState<AirtimeOrder | null>(null)

    // Freeze the page behind an open overlay so the sheet can't scroll away on mobile
    useEffect(() => {
        if (!showConfirm && !successOrder) return
        const previous = document.body.style.overflow
        document.body.style.overflow = 'hidden'
        return () => { document.body.style.overflow = previous }
    }, [showConfirm, successOrder])

    // Handle query params
    useEffect(() => {
        const modeParam = searchParams.get('mode')
        if (modeParam === 'mashup') {
            setMode('mashup')
            setSelectedNetwork('MTN')
            setIsManualSelection(true)
        }
    }, [searchParams])

    // History & Filtering
    const [orders, setOrders] = useState<AirtimeOrder[]>([])
    const [historyLoading, setHistoryLoading] = useState(false)
    const [searchQuery, setSearchQuery] = useState('')
    const [timePeriod, setTimePeriod] = useState('Today')
    const [isCustomDialogOpen, setIsCustomDialogOpen] = useState(false)
    const [customStart, setCustomStart] = useState('')
    const [customEnd, setCustomEnd] = useState('')

    // Load settings + wallet
    useEffect(() => {
        const loadData = async () => {
            if (!dbUser) return
            setSettingsLoading(true)
            try {
                const settingsRes = await fetch('/api/admin/airtime/settings')
                if (settingsRes.ok) {
                    const { settings: raw } = await settingsRes.json()
                    setSettings({
                        fee_mtn_customer: parseFloat(raw.airtime_fee_mtn_customer || '5'),
                        fee_mtn_agent: parseFloat(raw.airtime_fee_mtn_agent || '3'),
                        fee_telecel_customer: parseFloat(raw.airtime_fee_telecel_customer || '5'),
                        fee_telecel_agent: parseFloat(raw.airtime_fee_telecel_agent || '3'),
                        fee_at_customer: parseFloat(raw.airtime_fee_at_customer || '5'),
                        fee_at_agent: parseFloat(raw.airtime_fee_at_agent || '3'),
                        min_amount: parseFloat(raw.airtime_min_amount || '1'),
                        max_amount: parseFloat(raw.airtime_max_amount || '500'),
                        enabled_mtn: raw.airtime_enabled_mtn !== 'false',
                        enabled_telecel: raw.airtime_enabled_telecel !== 'false',
                        enabled_at: raw.airtime_enabled_at !== 'false',
                    })
                }

                const { data: walletData } = await supabase
                    .from('wallets')
                    .select('balance')
                    .eq('user_id', dbUser.id)
                    .single()

                if (walletData) {
                    setWalletBalance((walletData as any).balance || 0)
                    setUserRole(dbUser.role === 'agent' ? 'agent' : 'customer')
                }
            } catch (e) {
                console.error('[Airtime] Error loading initial data:', e)
            } finally {
                setSettingsLoading(false)
            }
        }
        loadData()
    }, [dbUser])

    // History loader
    const loadHistory = useCallback(async () => {
        setHistoryLoading(true)
        try {
            const res = await fetch('/api/airtime/history')
            if (res.ok) {
                const d = await res.json()
                setOrders(d.orders || [])
            }
        } catch (e) { console.error(e) }
        setHistoryLoading(false)
    }, [])

    useEffect(() => {
        if (activeTab === 'history') loadHistory()
    }, [activeTab, loadHistory])

    // Fee calculation
    const getFeeRate = useCallback(() => {
        if (!settings || !selectedNetwork) return 5
        const netKey = selectedNetwork.toLowerCase()
        const roleKey = userRole
        const key = `fee_${netKey}_${roleKey}` as keyof AirtimeSettings
        return (settings[key] as number) || 5
    }, [settings, selectedNetwork, userRole])

    const parsedAmount = parseFloat(amount) || 0
    const feeRate = getFeeRate()

    let airtimeAmount = 0, feeAmount = 0, totalPaid = 0
    if (parsedAmount > 0) {
        const round2 = (n: number) => Math.round(n * 100) / 100
        if (useExact) {
            airtimeAmount = parsedAmount
            feeAmount = round2(parsedAmount * (feeRate / 100))
            totalPaid = round2(parsedAmount + feeAmount)
        } else {
            totalPaid = parsedAmount
            feeAmount = round2(parsedAmount * (feeRate / 100))
            airtimeAmount = round2(parsedAmount - feeAmount)
        }
    }

    const phoneWarning = phone.length >= 3 ? getNetworkWarning(phone, selectedNetwork) : null
    const isPhoneValid = /^0\d{9}$/.test(phone)
    const isAmountValid = parsedAmount >= (settings?.min_amount || 1) && parsedAmount <= (settings?.max_amount || 500)
    const hasEnoughBalance = walletBalance !== null && totalPaid > 0 && walletBalance >= totalPaid
    // "Pay processing fee separately" must be turned on before checkout — the deduct-from-amount
    // mode silently shorts the beneficiary, which is exactly what the amber warning below the
    // toggle is nagging about. Requiring it removes the trap instead of just flagging it.
    const canProceed = selectedNetwork && isPhoneValid && isAmountValid && hasEnoughBalance && useExact && !isSubmitting

    const handlePhoneChange = (val: string) => {
        const clean = val.replace(/\D/g, '')
        setPhone(clean.slice(0, 10))

        if (!isManualSelection) {
            if (clean.length === 0) {
                setSelectedNetwork(null)
            } else if (clean.length >= 3) {
                const auto = detectNetwork(clean)
                if (auto) {
                    setSelectedNetwork(auto.id as string)
                }
            }
        }
    }

    const handleSubmit = async () => {
        if (!canProceed) return
        setIsSubmitting(true)
        setShowConfirm(false)
        try {
            const res = await fetch('/api/airtime/create', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    beneficiaryPhone: phone,
                    network: selectedNetwork,
                    amount: parsedAmount,
                    useExactAmount: useExact,
                    type: mode,
                    bundlePreference: mode === 'mashup' ? bundlePreference : undefined,
                }),
            })
            const data = await res.json()
            if (!res.ok) {
                toast.error(data.error || 'Failed to place order')
                return
            }
            if (data.walletBalance !== undefined) setWalletBalance(data.walletBalance)
            else if (data.order?.new_balance !== undefined) setWalletBalance(data.order.new_balance)
            setSuccessOrder(data.order)
            setPhone(''); setAmount(''); setSelectedNetwork(null); setUseExact(false); setIsManualSelection(false)
        } catch {
            toast.error('An unexpected error occurred. Please try again.')
        } finally {
            setIsSubmitting(false)
        }
    }

    const handleBuyMore = () => { setSuccessOrder(null); setActiveTab('buy') }
    const handleSuccessClose = () => { setSuccessOrder(null); setActiveTab('history') }

    // Filtering Logic
    const filteredOrders = useMemo(() => {
        return orders.filter(order => {
            // Search
            const matchesSearch = 
                order.beneficiary_phone.toLowerCase().includes(searchQuery.toLowerCase()) ||
                order.reference_code.toLowerCase().includes(searchQuery.toLowerCase())
            if (!matchesSearch) return false

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
    }, [orders, searchQuery, timePeriod, customStart, customEnd])

    // Statistics
    const stats = useMemo(() => {
        const today = new Date()
        return {
            totalSpent: filteredOrders.reduce((acc, o) => acc + (o.status === 'completed' ? o.total_paid : 0), 0),
            totalOrders: filteredOrders.length,
            todaySpent: filteredOrders.reduce((acc, o) => {
                if (o.status === 'completed' && isSameDay(parseISO(o.created_at), today)) {
                    return acc + o.total_paid
                }
                return acc
            }, 0)
        }
    }, [filteredOrders])

    if (settingsLoading) {
        return (
            <div className="min-h-[60vh] flex items-center justify-center">
                <Loader2 className="w-8 h-8 animate-spin text-slate-400" />
            </div>
        )
    }

    return (
        <div className="max-w-2xl mx-auto px-4 py-8 space-y-6">
            {/* Page Header */}
            <div>
                <h1 className="text-2xl font-bold text-slate-900 dark:text-white flex items-center gap-2">
                    <Phone className="w-6 h-6 text-emerald-500" /> Buy Airtime
                </h1>
                <p className="text-slate-500 dark:text-slate-400 text-sm mt-1 font-medium">Top up any Ghana network instantly from your wallet</p>
            </div>

            {/* Wallet Balance Card */}
            <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-slate-800 to-slate-900 p-6 shadow-xl">
                <div className="absolute top-0 right-0 w-40 h-40 bg-white/5 rounded-full -translate-y-1/2 translate-x-1/4" />
                <div className="relative">
                    <div className="flex items-center gap-2 text-slate-400 text-sm mb-2 font-medium">
                        <Wallet className="w-4 h-4" /> Wallet Balance
                    </div>
                    <div className="text-3xl font-bold text-white mb-1">
                        GHS {walletBalance !== null ? walletBalance.toFixed(2) : '—'}
                    </div>
                    {walletBalance !== null && walletBalance < 5 && (
                        <div className={cn('flex items-center gap-1.5 text-xs font-semibold mt-2', walletBalance < 1 ? 'text-red-400' : 'text-amber-400')}>
                            <AlertTriangle className="w-3.5 h-3.5" />
                            {walletBalance < 1 ? 'Your balance is too low. Please top up.' : 'Low balance. Consider topping up soon.'}
                        </div>
                    )}
                </div>
            </div>

            {/* Tab bar */}
            <div className="flex bg-slate-100 dark:bg-slate-800 rounded-xl p-1 gap-1">
                {(['buy', 'history'] as const).map(tab => (
                    <button
                        key={tab}
                        onClick={() => setActiveTab(tab)}
                        className={cn(
                            'flex-1 py-2 rounded-lg text-sm font-bold transition-all capitalize flex items-center justify-center gap-2',
                            activeTab === tab
                                ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-sm scale-[0.98]'
                                : 'text-slate-500 hover:text-slate-700'
                        )}
                    >
                        {tab === 'buy' ? <Phone className="w-4 h-4" /> : <History className="w-4 h-4" />}
                        {tab === 'buy' ? 'Buy Airtime' : 'History'}
                    </button>
                ))}
            </div>

            {/* ── BUY TAB ─────────────────────────────────────────────────────────── */}
            {activeTab === 'buy' && (
                <div className="space-y-6 animate-in fade-in slide-in-from-bottom-2 duration-300">

                    <div>
                        <Label className="text-sm font-bold text-slate-700 dark:text-slate-300 mb-3 block">{mode === 'mashup' ? 'Network (MTN Only 🔒)' : 'Select Network'}</Label>
                        <div className="grid grid-cols-3 gap-3">
                            {NETWORKS.map(net => {
                                const enabledKey = `enabled_${net.id.toLowerCase()}` as keyof AirtimeSettings
                                const isEnabled = settings ? settings[enabledKey] as boolean : true
                                const isSelected = selectedNetwork === net.id
                                return (
                                    <button
                                        key={net.id}
                                        onClick={() => { setSelectedNetwork(net.id); setIsManualSelection(true) }}
                                        disabled={!isEnabled || (mode === 'mashup' && net.id !== 'MTN')}
                                        className={cn(
                                            'relative flex flex-col items-center gap-2.5 p-4 rounded-2xl border-2 transition-all duration-200 font-bold text-sm',
                                            isSelected
                                                ? `bg-gradient-to-br ${net.gradient} border-transparent shadow-lg scale-[1.03]`
                                                : 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 hover:border-slate-400',
                                            !isEnabled && 'opacity-50 cursor-not-allowed grayscale'
                                        )}
                                    >
                                        <NetworkLogo id={net.id} />
                                        <span className={isSelected ? 'text-white' : 'text-slate-700 dark:text-slate-300'}>{net.label}</span>
                                        {!isEnabled && (
                                            <span className="absolute top-2 right-2 bg-slate-200 text-slate-500 text-[9px] font-bold px-1.5 py-0.5 rounded-full">OFF</span>
                                        )}
                                        {isSelected && <div className="absolute inset-0 rounded-2xl ring-2 ring-white/40" />}
                                    </button>
                                )
                            })}
                        </div>
                    </div>

                    {/* Bundle Preference — Mashup only */}
                    {mode === 'mashup' && (
                        <div>
                            <Label className="text-sm font-bold text-slate-700 dark:text-slate-300 mb-3 block">Bundle Preference</Label>
                            <div className="grid grid-cols-3 gap-3">
                                {([{ id: 'balanced' as const, label: 'Balanced', icon: '⚖️', desc: 'Data & Voice' }, { id: 'data' as const, label: 'Data Focus', icon: '📊', desc: '+25% Data' }, { id: 'voice' as const, label: 'Voice Focus', icon: '🎙️', desc: '+40% Voice' }]).map(pref => (
                                    <button key={pref.id} onClick={() => setBundlePreference(pref.id)} className={cn('flex flex-col items-center gap-1.5 p-3.5 rounded-2xl border-2 transition-all', bundlePreference === pref.id ? 'bg-amber-50 border-amber-400 shadow-md dark:bg-amber-950/20 dark:border-amber-600' : 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 hover:border-amber-200')}>
                                        <span className="text-xl">{pref.icon}</span>
                                        <span className={cn('text-xs font-black', bundlePreference === pref.id ? 'text-amber-700 dark:text-amber-400' : 'text-slate-600 dark:text-slate-400')}>{pref.label}</span>
                                        <span className="text-[9px] text-slate-400 font-semibold">{pref.desc}</span>
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}
                    <div>
                        <Label htmlFor="beneficiary-phone" className="text-sm font-bold text-slate-700 dark:text-slate-300 mb-2 block">
                            Beneficiary Phone Number
                        </Label>
                        <div className="relative">
                            <Phone className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                            <Input
                                id="beneficiary-phone"
                                type="tel"
                                inputMode="numeric"
                                placeholder="0XXXXXXXXX"
                                value={phone}
                                onChange={e => handlePhoneChange(e.target.value)}
                                className="pl-9 rounded-xl h-12 font-mono text-base font-bold"
                                maxLength={10}
                            />
                            {phone.length === 10 && (
                                <div className={cn('absolute right-3 top-1/2 -translate-y-1/2 w-5 h-5 rounded-full flex items-center justify-center', isPhoneValid ? 'bg-emerald-100' : 'bg-red-100')}>
                                    {isPhoneValid ? <CheckCircle className="w-3.5 h-3.5 text-emerald-600" /> : <X className="w-3.5 h-3.5 text-red-600" />}
                                </div>
                            )}
                        </div>
                        {phoneWarning && (
                            <p className="mt-2 text-xs text-amber-600 flex items-center gap-1.5 font-medium">
                                <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> {phoneWarning}
                            </p>
                        )}
                        {phone.length > 0 && phone.length < 10 && (
                            <p className="mt-1.5 text-xs text-slate-400 font-medium">{10 - phone.length} more digits needed</p>
                        )}
                    </div>

                    <div>
                        <Label className="text-sm font-bold text-slate-700 dark:text-slate-300 mb-3 block">Quick Amount (GHS)</Label>
                        <div className="flex gap-2 flex-wrap">
                            {QUICK_AMOUNTS.map(q => (
                                <button
                                    key={q}
                                    onClick={() => setAmount(String(q))}
                                    className={cn(
                                        'px-4 py-2 rounded-xl text-sm font-bold border-2 transition-all',
                                        amount === String(q)
                                            ? 'bg-slate-900 border-slate-900 text-white shadow-md'
                                            : 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:border-slate-400'
                                    )}
                                >
                                    {q}
                                </button>
                            ))}
                        </div>
                    </div>

                    <div>
                        <Label htmlFor="airtime-amount" className="text-sm font-bold text-slate-700 dark:text-slate-300 mb-2 block">
                            Custom Amount (GHS)
                            {settings && <span className="font-normal text-slate-400 ml-2">Min: {settings.min_amount} · Max: {settings.max_amount}</span>}
                        </Label>
                        <div className="relative">
                            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 font-bold text-sm">GHS</span>
                            <Input
                                id="airtime-amount"
                                type="number"
                                inputMode="decimal"
                                placeholder="0.00"
                                value={amount}
                                onChange={e => setAmount(e.target.value)}
                                className="pl-12 rounded-xl h-12 text-base font-bold"
                                min={settings?.min_amount || 1}
                                max={settings?.max_amount || 500}
                                step="0.01"
                            />
                        </div>
                    </div>

                    {/* Mashup Bundle Estimator */}
                    {mode === 'mashup' && parsedAmount > 0 && selectedNetwork === 'MTN' && (() => {
                        const est = estimateMashupBundle(parsedAmount, bundlePreference)
                        return (
                            <div className="rounded-2xl border-2 border-amber-200 dark:border-amber-800 bg-amber-50/50 dark:bg-amber-950/10 overflow-hidden">
                                <div className="px-4 py-3 bg-amber-100/60 dark:bg-amber-900/20 border-b border-amber-200 dark:border-amber-800 flex items-center justify-between">
                                    <p className="text-sm font-black text-amber-800 dark:text-amber-400">🎯 Estimated Bundle</p>
                                    <span className={cn('text-[9px] font-black px-2 py-1 rounded-full uppercase tracking-wider', est.mode === 'exact' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-400' : 'bg-amber-100 text-amber-700 dark:bg-amber-950/30 dark:text-amber-400')}>{est.mode === 'exact' ? '✓ Exact' : '~ Estimate'}</span>
                                </div>
                                <div className="p-4 grid grid-cols-2 gap-3">
                                    <div className="bg-white dark:bg-slate-800 rounded-xl p-3 border border-amber-100 dark:border-slate-700 text-center">
                                        <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-1">📊 Data</p>
                                        <p className="text-sm font-black text-slate-900 dark:text-white">{est.mode === 'exact' ? (est.dataMB >= 1024 ? `${(est.dataMB/1024).toFixed(1)} GB` : `${est.dataMB} MB`) : `${est.dataLowMB}–${est.dataHighMB} MB`}</p>
                                    </div>
                                    <div className="bg-white dark:bg-slate-800 rounded-xl p-3 border border-amber-100 dark:border-slate-700 text-center">
                                        <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-1">🎙️ Voice</p>
                                        <p className="text-sm font-black text-slate-900 dark:text-white">{est.mode === 'exact' ? `${est.voiceMin} Mins` : `${est.voiceLowMin}–${est.voiceHighMin} Mins`}</p>
                                    </div>
                                </div>
                                <p className="text-[10px] text-slate-400 font-bold px-4 pb-3 leading-tight">{est.mode === 'exact' ? 'Estimated values — actual bundle may vary slightly.' : "Range estimate — actual bundle depends on MTN's current rates."}</p>
                            </div>
                        )
                    })()}

                    <div 
                        onClick={() => setUseExact(!useExact)}
                        className={cn(
                            "group flex items-start gap-3.5 rounded-2xl p-5 border transition-all cursor-pointer select-none",
                            useExact 
                                ? "bg-emerald-50/60 dark:bg-emerald-950/20 border-emerald-500/50 shadow-sm ring-1 ring-emerald-500/20" 
                                : "bg-slate-50 dark:bg-slate-900/40 border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700"
                        )}
                    >
                        <div className={cn(
                            "mt-0.5 flex items-center justify-center w-5 h-5 rounded-md border-2 transition-all",
                            useExact 
                                ? "bg-emerald-600 border-emerald-600 text-white" 
                                : "border-slate-300 dark:border-slate-600 group-hover:border-slate-400"
                        )}>
                            {useExact && <CheckCircle className="w-3.5 h-3.5 stroke-[3px]" />}
                        </div>
                        <div className="flex-1 space-y-1">
                            <h4 className={cn(
                                "text-[13.5px] font-bold tracking-tight transition-colors",
                                useExact ? "text-emerald-700 dark:text-emerald-400" : "text-slate-800 dark:text-slate-200"
                            )}>
                                Pay processing fee separately (Beneficiary receives exactly this amount)
                            </h4>
                            <p className="text-[11.5px] text-slate-500 dark:text-slate-400 leading-relaxed font-semibold">
                                {useExact 
                                    ? "Perfect for sending round numbers. The service fee will be added to your total payment." 
                                    : "Standard Mode: The service fee will be deducted from whatever amount you type."}
                            </p>
                        </div>
                    </div>

                    {parsedAmount > 0 && selectedNetwork && (
                        <div className="rounded-2xl border border-slate-200 dark:border-slate-700 overflow-hidden shadow-sm">
                            <div className="bg-slate-50 dark:bg-slate-800 px-4 py-3 border-b border-slate-200 dark:border-slate-700">
                                <p className="text-sm font-bold text-slate-700 dark:text-slate-300">Fee Breakdown</p>
                            </div>
                            <div className="p-4 space-y-2.5 text-sm font-medium">
                                {useExact ? (
                                    <>
                                        <div className="flex justify-between font-bold"><span className="text-slate-500">You type</span><span>GHS {parsedAmount.toFixed(2)}</span></div>
                                        <div className="flex justify-between text-emerald-600 font-bold"><span>Beneficiary receives</span><span>GHS {airtimeAmount.toFixed(2)} ✓</span></div>
                                        <div className="flex justify-between font-bold"><span className="text-slate-500">Service fee ({feeRate}%)</span><span>+ GHS {feeAmount.toFixed(2)}</span></div>
                                        <div className="flex justify-between border-t border-slate-200 dark:border-slate-600 pt-2.5 mt-1">
                                            <span className="font-black text-slate-800 dark:text-white uppercase tracking-tight">You pay</span>
                                            <span className="font-black text-lg text-slate-900 dark:text-white">GHS {totalPaid.toFixed(2)}</span>
                                        </div>
                                    </>
                                ) : (
                                    <>
                                        <div className="flex justify-between font-bold"><span className="text-slate-500">You type</span><span>GHS {parsedAmount.toFixed(2)}</span></div>
                                        <div className="flex justify-between font-bold"><span className="text-slate-500">Service fee ({feeRate}%)</span><span>– GHS {feeAmount.toFixed(2)}</span></div>
                                        <div className="flex justify-between items-center rounded-xl bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 px-3 py-2.5 -mx-1">
                                            <span className="text-amber-700 dark:text-amber-400 font-bold flex items-center gap-1.5 uppercase text-[11px] tracking-wider">
                                                <AlertTriangle className="w-4 h-4 shrink-0" /> Beneficiary receives
                                            </span>
                                            <span className="font-black text-amber-700 dark:text-amber-400">GHS {airtimeAmount.toFixed(2)}</span>
                                        </div>
                                        <p className="text-[11px] text-amber-600 dark:text-amber-500 font-black uppercase tracking-tight px-1">Fee deducted — turn on "Pay separately" above to continue</p>
                                        <div className="flex justify-between border-t border-slate-200 dark:border-slate-600 pt-2.5 mt-1">
                                            <span className="font-black text-slate-800 dark:text-white uppercase tracking-tight">You pay</span>
                                            <span className="font-black text-lg text-slate-900 dark:text-white">GHS {totalPaid.toFixed(2)} ✓</span>
                                        </div>
                                    </>
                                )}
                            </div>
                        </div>
                    )}

                    {parsedAmount > 0 && !hasEnoughBalance && walletBalance !== null ? (
                        <div className="rounded-2xl bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-800 p-4 flex items-center gap-3">
                            <AlertTriangle className="w-5 h-5 text-red-500 shrink-0" />
                            <div>
                                <p className="text-sm font-bold text-red-700 dark:text-red-400">Insufficient Balance</p>
                                <p className="text-xs text-red-500 font-semibold">You need GHS {totalPaid.toFixed(2)} but have GHS {walletBalance.toFixed(2)}. Please top up.</p>
                            </div>
                        </div>
                    ) : (
                        <>
                            <Button
                                className="w-full h-14 rounded-2xl bg-slate-900 hover:bg-slate-800 dark:bg-slate-100 dark:hover:bg-white dark:text-slate-900 text-lg font-black shadow-lg transition-all"
                                disabled={!canProceed}
                                onClick={() => setShowConfirm(true)}
                            >
                                Proceed to Payment <ArrowRight className="w-5 h-5 ml-2" />
                            </Button>
                            {!useExact && selectedNetwork && isPhoneValid && isAmountValid && (
                                <p className="text-center text-[11px] text-amber-600 dark:text-amber-500 font-bold -mt-3">
                                    Turn on "Pay processing fee separately" above to continue
                                </p>
                            )}
                        </>
                    )}
                </div>
            )}

            {/* ── HISTORY TAB ──────────────────────────────────────────────────────── */}
            {activeTab === 'history' && (
                <div className="space-y-6 animate-in fade-in slide-in-from-bottom-2 duration-500">
                    <div className="grid grid-cols-3 gap-3">
                        <div className="bg-white dark:bg-slate-800 rounded-2xl p-3.5 border border-slate-200 dark:border-slate-700 shadow-sm">
                            <div className="bg-emerald-100 dark:bg-emerald-950/40 p-2 rounded-lg w-fit mb-2">
                                <Coins className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                            </div>
                            <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-1">Total Spent</p>
                            <p className="text-sm font-black text-slate-900 dark:text-white truncate">GHS {stats.totalSpent.toFixed(2)}</p>
                        </div>
                        <div className="bg-white dark:bg-slate-800 rounded-2xl p-3.5 border border-slate-200 dark:border-slate-700 shadow-sm">
                            <div className="bg-blue-100 dark:bg-blue-950/40 p-2 rounded-lg w-fit mb-2">
                                <History className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                            </div>
                            <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-1">Orders</p>
                            <p className="text-sm font-black text-slate-900 dark:text-white truncate">{stats.totalOrders}</p>
                        </div>
                        <div className="bg-white dark:bg-slate-800 rounded-2xl p-3.5 border border-slate-200 dark:border-slate-700 shadow-sm">
                            <div className="bg-amber-100 dark:bg-amber-950/40 p-2 rounded-lg w-fit mb-2">
                                <TrendingUp className="w-4 h-4 text-amber-600 dark:text-amber-400" />
                            </div>
                            <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-1">Today</p>
                            <p className="text-sm font-black text-slate-900 dark:text-white truncate">GHS {stats.todaySpent.toFixed(2)}</p>
                        </div>
                    </div>

                    <div className="space-y-3">
                        <div className="relative group">
                            <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 group-focus-within:text-slate-600 transition-colors" />
                            <Input 
                                placeholder="Search beneficiary or reference..."
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                                className="pl-10 h-12 rounded-xl bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 focus:ring-2 focus:ring-slate-900/10 font-bold"
                            />
                        </div>
                        <div className="flex gap-2">
                            <div className="flex-1">
                                <Select value={timePeriod} onValueChange={(val) => {
                                    if (val === 'Custom') setIsCustomDialogOpen(true)
                                    else setTimePeriod(val)
                                }}>
                                    <SelectTrigger className="h-12 rounded-xl bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 font-bold">
                                        <div className="flex items-center gap-2">
                                            <Calendar className="w-4 h-4 text-slate-400" />
                                            <SelectValue placeholder="Time Period" />
                                        </div>
                                    </SelectTrigger>
                                    <SelectContent className="rounded-xl">
                                        {['Today', 'Yesterday', 'This Week', 'This Month', 'Custom'].map(period => (
                                            <SelectItem key={period} value={period} className="font-bold">{period}</SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </div>
                            <Button variant="outline" size="icon" className="h-12 w-12 rounded-xl shrink-0" onClick={loadHistory} disabled={historyLoading}>
                                <RefreshCw className={cn('w-4 h-4', historyLoading && 'animate-spin')} />
                            </Button>
                        </div>
                        {timePeriod === 'Custom' && customStart && (
                            <div className="flex items-center gap-2 px-3 py-1.5 bg-slate-100 dark:bg-slate-800 rounded-lg text-xs text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-700 w-fit font-bold">
                                <CalendarRange className="w-3 h-3" />
                                {format(new Date(customStart), 'MMM d')} - {format(new Date(customEnd), 'MMM d, yyyy')}
                                <button onClick={() => setTimePeriod('All')} className="ml-1 text-slate-400 hover:text-red-500" title="Clear Custom Date Filter"><X className="w-3 h-3 bg-white rounded-full p-0.5" /></button>
                            </div>
                        ) }
                    </div>

                    {historyLoading ? (
                        <div className="flex flex-col items-center justify-center py-20 bg-white/50 dark:bg-slate-800/50 rounded-3xl border border-dashed border-slate-200 dark:border-slate-700">
                            <Loader2 className="w-8 h-8 animate-spin text-slate-400 mb-2" />
                            <p className="text-sm font-bold text-slate-500">Syncing your history...</p>
                        </div>
                    ) : filteredOrders.length === 0 ? (
                        <div className="text-center py-20 bg-white dark:bg-slate-800 rounded-3xl border border-dashed border-slate-200 dark:border-slate-700">
                            <div className="bg-slate-100 dark:bg-slate-900/50 w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4">
                                <History className="w-8 h-8 text-slate-300" />
                            </div>
                            <p className="font-black text-slate-900 dark:text-white uppercase tracking-tight">No orders found</p>
                            <p className="text-sm text-slate-500 max-w-[200px] mx-auto font-medium">Try adjusting your filters or search query.</p>
                        </div>
                    ) : (
                        <div className="space-y-4 pb-20">
                            {filteredOrders.map(order => (
                                <div key={order.id} className="group bg-white dark:bg-slate-800 rounded-3xl border border-slate-100 dark:border-slate-700 p-5 shadow-sm hover:shadow-md hover:border-slate-200 dark:hover:border-slate-600 transition-all duration-300">
                                    <div className="flex items-start justify-between mb-4">
                                        <div className="flex items-center gap-4">
                                            <div className="w-12 h-12 rounded-2xl bg-slate-50 dark:bg-slate-900 flex items-center justify-center border border-slate-100 dark:border-slate-800 group-hover:scale-110 transition-transform">
                                                <NetworkLogo id={order.network} />
                                            </div>
                                            <div>
                                                <div className="flex items-center gap-2 mb-0.5">
                                                    <span className="font-black text-slate-900 dark:text-white uppercase tracking-tight">{order.network} {order.type === 'mashup' ? 'Mashup' : 'Airtime'}</span>
                                                    <StatusBadge status={order.status} />
                                                    {order.type === 'mashup' && (
                                                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[9px] font-black bg-amber-100 text-amber-700 border border-amber-200 dark:bg-amber-950/30 dark:text-amber-400 dark:border-amber-800">🎯 Mashup</span>
                                                    )}
                                                </div>
                                                <div className="flex items-center gap-1.5 text-slate-500 text-sm font-bold">
                                                    <Phone className="w-3.5 h-3.5" />
                                                    <span>{order.beneficiary_phone}</span>
                                                    <button 
                                                        onClick={() => { navigator.clipboard.writeText(order.beneficiary_phone); toast.success('Number copied!') }}
                                                        className="p-1 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-md transition-colors"
                                                        title="Copy Beneficiary Number"
                                                    >
                                                        <Copy className="w-3 h-3" />
                                                    </button>
                                                </div>
                                            </div>
                                        </div>
                                        <div className="text-right">
                                            <p className="text-[10px] text-slate-400 uppercase tracking-[0.2em] font-black mb-1">Paid</p>
                                            <p className="text-xl font-black text-slate-900 dark:text-white uppercase tracking-tight">GHS {order.total_paid.toFixed(2)}</p>
                                        </div>
                                    </div>
                                    
                                    <div className="grid grid-cols-3 gap-2 bg-slate-50/50 dark:bg-slate-900/30 rounded-2xl p-3.5 border border-slate-100 dark:border-slate-800/10">
                                        <div className="space-y-1">
                                            <p className="text-[10px] text-slate-400 font-black uppercase tracking-widest">Amount</p>
                                            <p className="text-sm font-black text-emerald-600">GHS {order.airtime_amount.toFixed(2)}</p>
                                        </div>
                                        <div className="space-y-1 text-center">
                                            <p className="text-[10px] text-slate-400 font-black uppercase tracking-widest">Fee</p>
                                            <p className="text-sm font-black text-slate-600 dark:text-slate-400">GHS {order.fee_amount.toFixed(2)}</p>
                                        </div>
                                        <div className="space-y-1 text-right">
                                            <p className="text-[10px] text-slate-400 font-black uppercase tracking-widest">Date</p>
                                            <p className="text-xs font-black text-slate-700 dark:text-slate-200">
                                                {format(parseISO(order.created_at), 'MMM d, p')}
                                            </p>
                                        </div>
                                    </div>

                                    <div className="mt-4 pt-4 border-t border-slate-100 dark:border-slate-700/50 flex items-center justify-between">
                                        <div className="flex items-center gap-2 text-slate-400 font-mono text-[10px] font-bold">
                                            <Info className="w-3 h-3" />
                                            REF: {order.reference_code}
                                        </div>
                                        <div className="flex items-center gap-1.5 text-slate-500 dark:text-slate-400">
                                            <Clock className="w-3.5 h-3.5" />
                                            <span className="text-[11px] font-black uppercase tracking-tight bg-slate-100 dark:bg-slate-900/50 px-2 py-0.5 rounded-md">
                                                {format(parseISO(order.created_at), 'hh:mm a')}
                                            </span>
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}

            {/* Overlays */}
            <ConfirmSheet
                open={showConfirm}
                onCancel={() => setShowConfirm(false)}
                onConfirm={handleSubmit}
                isLoading={isSubmitting}
                details={{ network: selectedNetwork || '', phone, airtime: airtimeAmount, fee: feeAmount, total: totalPaid, mode: useExact, orderType: mode, preference: mode === 'mashup' ? bundlePreference : undefined }}
            />
            <SuccessModal order={successOrder} onClose={handleSuccessClose} onBuyMore={handleBuyMore} />

            {/* Custom Date Dialog */}
            <Dialog open={isCustomDialogOpen} onOpenChange={setIsCustomDialogOpen}>
                <DialogContent className="rounded-3xl max-w-[400px]">
                    <DialogHeader>
                        <DialogTitle className="font-black uppercase tracking-tight">Custom Date Range</DialogTitle>
                        <DialogDescription className="font-semibold">
                            Select a start and end date to filter your airtime orders.
                        </DialogDescription>
                    </DialogHeader>
                    <div className="grid gap-4 py-4">
                        <div className="space-y-2">
                            <Label htmlFor="start" className="font-bold">Start Date</Label>
                            <Input
                                id="start"
                                type="date"
                                value={customStart}
                                onChange={(e) => setCustomStart(e.target.value)}
                                className="rounded-xl font-bold h-12"
                            />
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="end" className="font-bold">End Date</Label>
                            <Input
                                id="end"
                                type="date"
                                value={customEnd}
                                onChange={(e) => setCustomEnd(e.target.value)}
                                className="rounded-xl font-bold h-12"
                            />
                        </div>
                    </div>
                    <DialogFooter className="gap-2 sm:gap-0">
                        <Button 
                            variant="outline" 
                            onClick={() => setIsCustomDialogOpen(false)}
                            className="rounded-xl h-12 font-bold flex-1"
                        >
                            Cancel
                        </Button>
                        <Button 
                            onClick={() => {
                                setTimePeriod('Custom')
                                setIsCustomDialogOpen(false)
                            }}
                            className="bg-slate-900 text-white rounded-xl h-12 font-black flex-1"
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

// ─── Suspense wrapper (required by Next.js 15 for useSearchParams) ────────────
export default function AirtimePage() {
    return (
        <Suspense fallback={<div className="flex items-center justify-center min-h-[60vh]"><div className="w-8 h-8 rounded-full border-4 border-slate-200 border-t-slate-800 animate-spin" /></div>}>
            <AirtimePageInner />
        </Suspense>
    )
}
