'use client'

import React, { useState, useEffect, useCallback, useMemo } from 'react'
import {
    Receipt, RefreshCw, Loader2, Settings2, Save, AlertTriangle, Search,
    CheckCircle, XCircle, Undo2, Send, Copy, Info,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import {
    Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
    Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import { format, parseISO } from 'date-fns'

// Kept in step with lib/hubtel-utility-service.ts. Duplicated as plain data rather
// than imported because that module reads server-only env on import.
const SERVICES = [
    { id: 'dstv', label: 'DSTV' },
    { id: 'gotv', label: 'GOtv' },
    { id: 'startimes', label: 'StarTimes' },
    { id: 'ecg', label: 'ECG Prepaid' },
    { id: 'ghanawater', label: 'Ghana Water' },
] as const

interface UtilityOrder {
    id: string
    reference_code: string
    client_reference: string | null
    service: string
    account_number: string
    account_name: string | null
    destination: string
    customer_phone: string | null
    customer_email: string | null
    bill_amount: number
    fee_amount: number
    total_paid: number
    commission: number | null
    status: string
    payment_method: string
    payment_status: string
    response_code: string | null
    dispatch_claimed_at: string | null
    fulfillment_note: string | null
    created_at: string
    users?: { first_name: string; last_name: string; email: string; phone_number: string } | null
}

const STATUS_STYLE: Record<string, string> = {
    pending: 'bg-amber-100 text-amber-700 border-amber-200',
    processing: 'bg-blue-100 text-blue-700 border-blue-200',
    completed: 'bg-emerald-100 text-emerald-700 border-emerald-200',
    failed: 'bg-red-100 text-red-700 border-red-200',
    refunded: 'bg-slate-100 text-slate-700 border-slate-300',
}

export default function AdminUtilitiesPage() {
    const [tab, setTab] = useState<'orders' | 'settings'>('orders')

    // Orders
    const [orders, setOrders] = useState<UtilityOrder[]>([])
    const [loading, setLoading] = useState(true)
    const [statusFilter, setStatusFilter] = useState('all')
    const [serviceFilter, setServiceFilter] = useState('all')
    const [search, setSearch] = useState('')

    // Action dialog
    const [actionOrder, setActionOrder] = useState<UtilityOrder | null>(null)
    const [action, setAction] = useState<'complete' | 'refund' | 'fail'>('complete')
    const [note, setNote] = useState('')
    const [acting, setActing] = useState(false)

    // Settings
    const [settings, setSettings] = useState<Record<string, string>>({})
    const [settingsLoading, setSettingsLoading] = useState(true)
    const [saving, setSaving] = useState(false)

    const fetchOrders = useCallback(async () => {
        setLoading(true)
        try {
            const params = new URLSearchParams({ status: statusFilter, service: serviceFilter, limit: '50' })
            if (search) params.set('search', search)
            const res = await fetch(`/api/admin/utilities/orders?${params}`, { cache: 'no-store' })
            const data = await res.json()
            if (!res.ok) throw new Error(data.error || 'Failed to load orders')
            setOrders(data.orders || [])
        } catch (e: any) {
            toast.error(e.message || 'Failed to load orders')
        } finally {
            setLoading(false)
        }
    }, [statusFilter, serviceFilter, search])

    const fetchSettings = useCallback(async () => {
        setSettingsLoading(true)
        try {
            const res = await fetch('/api/admin/utilities/settings', { cache: 'no-store' })
            const data = await res.json()
            if (res.ok) setSettings(data.settings || {})
        } catch {
            toast.error('Failed to load settings')
        } finally {
            setSettingsLoading(false)
        }
    }, [])

    useEffect(() => { fetchOrders() }, [fetchOrders])
    useEffect(() => { fetchSettings() }, [fetchSettings])

    const setSetting = (key: string, value: string) => setSettings(s => ({ ...s, [key]: value }))

    const saveSettings = async () => {
        setSaving(true)
        try {
            const res = await fetch('/api/admin/utilities/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(settings),
            })
            const data = await res.json()
            if (!res.ok) throw new Error(data.error || 'Save failed')
            toast.success('Settings saved')
        } catch (e: any) {
            toast.error(e.message || 'Save failed')
        } finally {
            setSaving(false)
        }
    }

    const runAction = async (orderId: string, act: string, actNote?: string) => {
        setActing(true)
        try {
            const res = await fetch('/api/admin/utilities/orders', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ orderId, action: act, note: actNote }),
            })
            const data = await res.json()
            if (!res.ok) throw new Error(data.error || 'Action failed')
            toast.success('Order updated')
            setActionOrder(null)
            setNote('')
            fetchOrders()
        } catch (e: any) {
            toast.error(e.message || 'Action failed')
        } finally {
            setActing(false)
        }
    }

    const labelFor = (id: string) => SERVICES.find(s => s.id === id)?.label || id

    const stats = useMemo(() => ({
        total: orders.length,
        open: orders.filter(o => o.status === 'pending' || o.status === 'processing').length,
        completed: orders.filter(o => o.status === 'completed').length,
        value: orders.filter(o => o.status === 'completed').reduce((a, o) => a + Number(o.bill_amount), 0),
        commission: orders.reduce((a, o) => a + Number(o.commission || 0), 0),
    }), [orders])

    const autoMasterOn = settings['utility_auto_fulfillment_enabled'] === 'true'
    const launchedOn = settings['utility_public_launch'] === 'true'
    // Absent counts as OPEN for these two, unlike the master gate where absent means
    // closed — they only narrow something that is already open.
    const dashboardOn = settings['utility_dashboard_enabled'] !== 'false'
    const storefrontOn = settings['utility_storefront_enabled'] !== 'false'

    return (
        <div className="space-y-6 pb-24">
            <div className="flex items-start justify-between gap-4 flex-wrap">
                <div>
                    <h1 className="text-2xl font-black flex items-center gap-2">
                        <Receipt className="w-6 h-6" /> Utility Bills
                    </h1>
                    <p className="text-sm text-muted-foreground mt-1">
                        DSTV, GOtv, StarTimes, ECG and Ghana Water payments via Hubtel Commission Services.
                    </p>
                </div>
                <Button variant="outline" onClick={() => { fetchOrders(); fetchSettings() }} disabled={loading}>
                    <RefreshCw className={cn('w-4 h-4 mr-2', loading && 'animate-spin')} /> Refresh
                </Button>
            </div>

            <div className="flex gap-2 bg-slate-100 dark:bg-slate-800 p-1 rounded-xl w-fit">
                {(['orders', 'settings'] as const).map(t => (
                    <button
                        key={t}
                        onClick={() => setTab(t)}
                        className={cn(
                            'px-5 py-2 rounded-lg text-sm font-bold capitalize transition',
                            tab === t ? 'bg-white dark:bg-slate-900 shadow-sm' : 'text-muted-foreground'
                        )}
                    >
                        {t}
                    </button>
                ))}
            </div>

            {tab === 'orders' ? (
                <>
                    {/* Stats */}
                    <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
                        {[
                            { label: 'Orders shown', value: stats.total },
                            { label: 'Awaiting', value: stats.open },
                            { label: 'Completed', value: stats.completed },
                            { label: 'Bills paid', value: `GHS ${stats.value.toFixed(2)}` },
                            { label: 'Commission', value: `GHS ${stats.commission.toFixed(4)}` },
                        ].map(s => (
                            <div key={s.label} className="border rounded-xl p-4">
                                <p className="text-xs text-muted-foreground">{s.label}</p>
                                <p className="text-lg font-black mt-1">{s.value}</p>
                            </div>
                        ))}
                    </div>

                    {/* Filters */}
                    <div className="flex gap-2 flex-wrap">
                        <div className="relative flex-1 min-w-[220px]">
                            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                            <Input
                                value={search}
                                onChange={e => setSearch(e.target.value)}
                                placeholder="Reference, account number or name"
                                className="pl-9"
                            />
                        </div>
                        <Select value={statusFilter} onValueChange={setStatusFilter}>
                            <SelectTrigger className="w-[160px]"><SelectValue /></SelectTrigger>
                            <SelectContent>
                                {['all', 'pending', 'processing', 'completed', 'failed', 'refunded'].map(s => (
                                    <SelectItem key={s} value={s} className="capitalize">{s === 'all' ? 'All statuses' : s}</SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                        <Select value={serviceFilter} onValueChange={setServiceFilter}>
                            <SelectTrigger className="w-[170px]"><SelectValue /></SelectTrigger>
                            <SelectContent>
                                <SelectItem value="all">All services</SelectItem>
                                {SERVICES.map(s => <SelectItem key={s.id} value={s.id}>{s.label}</SelectItem>)}
                            </SelectContent>
                        </Select>
                    </div>

                    {/* Orders */}
                    {loading ? (
                        <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
                    ) : orders.length === 0 ? (
                        <div className="text-center py-16 text-muted-foreground">No utility bill orders match these filters.</div>
                    ) : (
                        <div className="space-y-3">
                            {orders.map(order => (
                                <div key={order.id} className="border rounded-2xl p-4">
                                    <div className="flex items-start justify-between gap-3 flex-wrap">
                                        <div className="min-w-0">
                                            <div className="flex items-center gap-2 flex-wrap">
                                                <span className="font-black">{labelFor(order.service)}</span>
                                                <Badge variant="outline" className={cn('capitalize', STATUS_STYLE[order.status])}>
                                                    {order.status}
                                                </Badge>
                                                <Badge variant="outline" className="capitalize text-xs">{order.payment_method}</Badge>
                                                {order.payment_status === 'refunded' && (
                                                    <Badge variant="outline" className="text-xs bg-slate-100">refunded</Badge>
                                                )}
                                            </div>
                                            <p className="text-sm mt-1">
                                                <span className="font-semibold">{order.account_number}</span>
                                                {order.account_name && <span className="text-muted-foreground"> · {order.account_name}</span>}
                                            </p>
                                            <p className="text-xs text-muted-foreground mt-0.5">
                                                {order.users ? `${order.users.first_name} ${order.users.last_name} · ${order.users.email}` : 'Unknown buyer'}
                                            </p>
                                            <button
                                                onClick={() => { navigator.clipboard.writeText(order.reference_code); toast.success('Reference copied') }}
                                                className="text-xs font-mono text-muted-foreground hover:text-foreground mt-1 flex items-center gap-1"
                                            >
                                                {order.reference_code} <Copy className="w-3 h-3" />
                                            </button>
                                        </div>

                                        <div className="text-right">
                                            <p className="font-black">GHS {Number(order.bill_amount).toFixed(2)}</p>
                                            <p className="text-xs text-muted-foreground">
                                                fee GHS {Number(order.fee_amount).toFixed(2)} · paid GHS {Number(order.total_paid).toFixed(2)}
                                            </p>
                                            <p className="text-xs text-muted-foreground mt-0.5">
                                                {format(parseISO(order.created_at), 'dd MMM yyyy, HH:mm')}
                                            </p>
                                        </div>
                                    </div>

                                    {order.fulfillment_note && (
                                        <p className="text-xs bg-slate-50 dark:bg-slate-800 rounded-lg p-2.5 mt-3">
                                            {order.fulfillment_note}
                                        </p>
                                    )}

                                    {(order.status === 'pending' || order.status === 'processing' || order.status === 'failed') && (
                                        <div className="flex gap-2 mt-3 flex-wrap">
                                            {order.status === 'pending' && !order.dispatch_claimed_at && (
                                                <Button size="sm" variant="outline" onClick={() => runAction(order.id, 'retry')} disabled={acting}>
                                                    <Send className="w-3.5 h-3.5 mr-1.5" /> Send to Hubtel
                                                </Button>
                                            )}
                                            <Button size="sm" variant="outline" onClick={() => { setActionOrder(order); setAction('complete'); setNote('') }}>
                                                <CheckCircle className="w-3.5 h-3.5 mr-1.5" /> Mark paid
                                            </Button>
                                            {order.payment_status !== 'refunded' && (
                                                <Button size="sm" variant="outline" onClick={() => { setActionOrder(order); setAction('refund'); setNote('') }}>
                                                    <Undo2 className="w-3.5 h-3.5 mr-1.5" /> Refund
                                                </Button>
                                            )}
                                            <Button size="sm" variant="outline" onClick={() => { setActionOrder(order); setAction('fail'); setNote('') }}>
                                                <XCircle className="w-3.5 h-3.5 mr-1.5" /> Mark failed
                                            </Button>
                                        </div>
                                    )}

                                    {order.dispatch_claimed_at && order.status === 'pending' && (
                                        <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-2 mt-2 flex items-start gap-1.5">
                                            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                                            Already sent to Hubtel — confirm in the portal before resolving. Re-sending could pay the bill twice.
                                        </p>
                                    )}
                                </div>
                            ))}
                        </div>
                    )}
                </>
            ) : (
                /* ── Settings ────────────────────────────────────────────── */
                <div className="space-y-5">
                    {settingsLoading ? (
                        <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
                    ) : (
                        <>
                            <div className={cn(
                                'border-2 rounded-2xl p-5',
                                launchedOn ? 'border-emerald-300 bg-emerald-50/50' : 'border-slate-300 bg-slate-50'
                            )}>
                                <div className="flex items-start justify-between gap-4">
                                    <div>
                                        <Label className="text-base font-bold flex items-center gap-2">
                                            <Settings2 className="w-4 h-4" /> Open bill payments to everyone
                                        </Label>
                                        <p className="text-sm text-muted-foreground mt-1 max-w-xl">
                                            While off, customers who tap Pay Bills see “Coming soon” and every
                                            utility API refuses them — only admins can use it. The feature still has
                                            to be deployed to production either way: a Mobile Money bill payment is
                                            confirmed by a callback to the live domain, so a build that is not live
                                            cannot complete one. Turn this on when the live tests are done.
                                        </p>
                                    </div>
                                    <Switch
                                        checked={launchedOn}
                                        onCheckedChange={v => setSetting('utility_public_launch', String(v))}
                                    />
                                </div>
                            </div>

                            <div className={cn(
                                'border-2 rounded-2xl p-5',
                                autoMasterOn ? 'border-emerald-300 bg-emerald-50/50' : 'border-amber-300 bg-amber-50/50'
                            )}>
                                <div className="flex items-start justify-between gap-4">
                                    <div>
                                        <Label className="text-base font-bold flex items-center gap-2">
                                            <Settings2 className="w-4 h-4" /> Automatic bill payment
                                        </Label>
                                        <p className="text-sm text-muted-foreground mt-1 max-w-xl">
                                            When off, every bill payment waits for an admin. Turn this on only after a
                                            live GHS 1 test on each service — a bill payment cannot be recalled.
                                        </p>
                                    </div>
                                    <Switch
                                        checked={autoMasterOn}
                                        onCheckedChange={v => setSetting('utility_auto_fulfillment_enabled', String(v))}
                                    />
                                </div>
                            </div>

                            {/* Where bills can be bought. The master switch above decides
                                whether the product is open at all; these decide which way in. */}
                            <div className="border rounded-2xl p-5">
                                <div className="flex items-start justify-between gap-4">
                                    <div>
                                        <Label className="text-base font-bold flex items-center gap-2">
                                            <Settings2 className="w-4 h-4" /> Show on the customer dashboard
                                        </Label>
                                        <p className="text-sm text-muted-foreground mt-1 max-w-xl">
                                            Turns Pay Bills on or off at /dashboard/utilities. Independent of storefronts, so one surface can run while the other is shut.
                                        </p>
                                    </div>
                                    <Switch
                                        checked={dashboardOn}
                                        onCheckedChange={v => setSetting('utility_dashboard_enabled', String(v))}
                                    />
                                </div>
                            </div>

                            <div className="border rounded-2xl p-5">
                                <div className="flex items-start justify-between gap-4">
                                    <div>
                                        <Label className="text-base font-bold flex items-center gap-2">
                                            <Settings2 className="w-4 h-4" /> Sell from shop storefronts
                                        </Label>
                                        <p className="text-sm text-muted-foreground mt-1 max-w-xl">
                                            Lets shops offer bill payments to their own customers. The riskier surface — the buyer is a guest, the shop owner is the account of record and a reseller chain gets paid — so it closes on its own.
                                        </p>
                                    </div>
                                    <Switch
                                        checked={storefrontOn}
                                        onCheckedChange={v => setSetting('utility_storefront_enabled', String(v))}
                                    />
                                </div>
                            </div>

                            <div className="border rounded-2xl p-5 space-y-4">
                                <div>
                                    <Label className="text-base font-bold">Percentages</Label>
                                    <p className="text-sm text-muted-foreground mt-1 max-w-xl">
                                        The cap is the total a customer can be charged over the face value of a
                                        bill. The platform fee below, plus every shop and sub-agent margin, all
                                        come out of it — a shop cannot set a margin that would push past it.
                                    </p>
                                </div>
                                <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
                                    {[
                                        { key: 'utility_total_markup_cap_percent', label: 'Total markup cap %', fallback: '5' },
                                        { key: 'commission_share_percent', label: 'API partner share %', fallback: '40' },
                                        { key: 'utility_api_min_amount', label: 'API min amount', fallback: '1' },
                                        { key: 'utility_api_max_amount', label: 'API max amount', fallback: '1000' },
                                    ].map(f => (
                                        <div key={f.key}>
                                            <Label className="text-xs">{f.label}</Label>
                                            <Input
                                                type="number"
                                                step="0.01"
                                                value={settings[f.key] ?? f.fallback}
                                                onChange={e => setSetting(f.key, e.target.value)}
                                            />
                                        </div>
                                    ))}
                                </div>
                            </div>

                            {SERVICES.map(s => (
                                <div key={s.id} className="border rounded-2xl p-5 space-y-4">
                                    <div className="flex items-center justify-between">
                                        <h3 className="font-black">{s.label}</h3>
                                        <div className="flex items-center gap-5">
                                            <label className="flex items-center gap-2 text-sm">
                                                <Switch
                                                    checked={settings[`utility_enabled_${s.id}`] !== 'false'}
                                                    onCheckedChange={v => setSetting(`utility_enabled_${s.id}`, String(v))}
                                                />
                                                Available
                                            </label>
                                            <label className="flex items-center gap-2 text-sm">
                                                <Switch
                                                    checked={settings[`utility_auto_${s.id}`] === 'true'}
                                                    onCheckedChange={v => setSetting(`utility_auto_${s.id}`, String(v))}
                                                />
                                                Auto-pay
                                            </label>
                                        </div>
                                    </div>

                                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                                        {[
                                            { key: `utility_fee_${s.id}_customer`, label: 'Customer fee %', fallback: '2' },
                                            { key: `utility_fee_${s.id}_agent`, label: 'Agent fee %', fallback: '1' },
                                            { key: `utility_min_amount_${s.id}`, label: 'Min amount', fallback: '1' },
                                            { key: `utility_max_amount_${s.id}`, label: 'Max amount', fallback: '2000' },
                                        ].map(f => (
                                            <div key={f.key}>
                                                <Label className="text-xs text-muted-foreground">{f.label}</Label>
                                                <Input
                                                    value={settings[f.key] ?? f.fallback}
                                                    onChange={e => setSetting(f.key, e.target.value.replace(/[^\d.]/g, ''))}
                                                    inputMode="decimal"
                                                    className="mt-1"
                                                />
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            ))}

                            <div className="flex items-start gap-2 text-xs text-muted-foreground bg-slate-50 dark:bg-slate-800 rounded-xl p-3">
                                <Info className="w-4 h-4 mt-0.5 shrink-0" />
                                <span>
                                    Fees are charged on top of the bill amount. The customer always pays the exact bill
                                    to the provider; the fee is ARHMS&apos; margin, on top of Hubtel&apos;s commission.
                                </span>
                            </div>

                            <Button onClick={saveSettings} disabled={saving} className="w-full sm:w-auto">
                                {saving ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Saving…</> : <><Save className="w-4 h-4 mr-2" />Save settings</>}
                            </Button>
                        </>
                    )}
                </div>
            )}

            {/* Manual resolution */}
            <Dialog open={!!actionOrder} onOpenChange={open => { if (!open && !acting) { setActionOrder(null); setNote('') } }}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>
                            {action === 'complete' ? 'Mark this bill as paid'
                                : action === 'refund' ? 'Refund this bill payment'
                                : 'Mark this bill as failed'}
                        </DialogTitle>
                        <DialogDescription>
                            {action === 'complete'
                                ? 'Use this only when you have confirmed in the Hubtel portal that the bill was actually paid. No money is returned to the customer.'
                                : action === 'refund'
                                    ? `GHS ${Number(actionOrder?.total_paid ?? 0).toFixed(2)} goes back to the customer's wallet. Only do this if the bill was NOT paid.`
                                    : 'Closes the order without touching the balance. Use when the money has been handled another way.'}
                        </DialogDescription>
                    </DialogHeader>

                    {actionOrder && (
                        <div className="text-sm space-y-1 border rounded-xl p-3">
                            <p><span className="text-muted-foreground">Service:</span> <strong>{labelFor(actionOrder.service)}</strong></p>
                            <p><span className="text-muted-foreground">Account:</span> <strong>{actionOrder.account_number}</strong> {actionOrder.account_name && `(${actionOrder.account_name})`}</p>
                            <p><span className="text-muted-foreground">Bill:</span> <strong>GHS {Number(actionOrder.bill_amount).toFixed(2)}</strong></p>
                            <p className="font-mono text-xs text-muted-foreground">{actionOrder.reference_code}</p>
                        </div>
                    )}

                    {action !== 'complete' && (
                        <div>
                            <Label className="text-sm">Reason (shown on the order)</Label>
                            <Textarea
                                value={note}
                                onChange={e => setNote(e.target.value)}
                                placeholder="e.g. Hubtel portal shows the transaction was declined."
                                className="mt-1.5"
                            />
                        </div>
                    )}

                    <DialogFooter>
                        <Button variant="outline" onClick={() => setActionOrder(null)} disabled={acting}>Cancel</Button>
                        <Button
                            onClick={() => actionOrder && runAction(actionOrder.id, action, note || undefined)}
                            disabled={acting || (action !== 'complete' && !note.trim())}
                        >
                            {acting ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Working…</> : 'Confirm'}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    )
}
