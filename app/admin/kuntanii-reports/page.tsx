'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { Flag, Loader2, RefreshCw, Search, Copy } from 'lucide-react'

interface KtOrder {
    id: string
    externalOrderId: string
    isShop: boolean
    phone: string
    network: string
    size: string
    dataGb: number | null
    status: 'pending' | 'processing' | 'completed' | 'failed'
    supplierStatus: string | null
    createdAt: string
}

interface Report {
    reportReference: string | null
    phoneNumber: string | null
    dataGb: number | null
    status: string | null
    outcome: string | null
    resolution: string | null
    createdAt: string | null
    resolvedAt: string | null
    refundGhs: number | null
}

/** What we know at Kuntanii for one order, once reported or checked. */
interface ReportState {
    loading?: boolean
    reports?: Report[]
    error?: string
}

type Filter = 'completed' | 'processing' | 'all'

const STATUS_CLASS: Record<string, string> = {
    completed: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400 border-transparent',
    processing: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400 border-transparent',
    pending: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300 border-transparent',
    failed: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400 border-transparent',
}

const OUTCOME_LABEL: Record<string, string> = {
    pending: 'Waiting for review',
    escalated: 'Escalated',
    confirmed_sent: 'Kuntanii says it was sent',
    refunded: 'Refunded to our Kuntanii balance',
    retry_approved: 'Resend approved',
    rejected: 'Rejected',
    resolved: 'Closed',
}

function today(): string {
    return new Date().toISOString().slice(0, 10)
}

function time(iso: string): string {
    return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })
}

function describe(r: Report): string {
    const label = (r.outcome && OUTCOME_LABEL[r.outcome]) || r.status || 'Reported'
    const refund = r.refundGhs ? ` · GHS ${r.refundGhs.toFixed(2)}` : ''
    return `${r.reportReference || 'Report'} — ${label}${refund}`
}

export default function KuntaniiReportsPage() {
    const [date, setDate] = useState(today())
    const [orders, setOrders] = useState<KtOrder[] | null>(null)
    const [loading, setLoading] = useState(false)
    const [filter, setFilter] = useState<Filter>('completed')
    const [search, setSearch] = useState('')
    const [selected, setSelected] = useState<Set<string>>(new Set())
    const [note, setNote] = useState('Customer says the bundle never arrived.')
    const [state, setState] = useState<Record<string, ReportState>>({})
    const [bulkBusy, setBulkBusy] = useState(false)

    const patch = (id: string, s: ReportState) => setState(prev => ({ ...prev, [id]: { ...prev[id], ...s } }))

    const load = useCallback(async () => {
        setLoading(true)
        setSelected(new Set())
        setState({})
        try {
            const res = await fetch(`/api/admin/kuntanii/not-received?date=${date}`)
            const data = await res.json()
            if (!res.ok) { toast.error(data?.error || 'Could not load orders'); setOrders([]); return }
            setOrders(data.orders)
        } catch {
            toast.error('Network error. Please try again.')
        } finally {
            setLoading(false)
        }
    }, [date])

    useEffect(() => { load() }, [load])

    const visible = useMemo(() => {
        const q = search.replace(/\s+/g, '')
        return (orders || []).filter(o =>
            (filter === 'all' || o.status === filter) && (!q || o.phone.includes(q) || o.externalOrderId.includes(q)))
    }, [orders, filter, search])

    const counts = useMemo(() => {
        const c = { completed: 0, processing: 0, all: orders?.length || 0 }
        for (const o of orders || []) {
            if (o.status === 'completed') c.completed++
            else if (o.status === 'processing') c.processing++
        }
        return c
    }, [orders])

    const check = async (id: string) => {
        patch(id, { loading: true, error: undefined })
        try {
            const res = await fetch(`/api/admin/kuntanii/not-received?orderId=${encodeURIComponent(id)}`)
            const data = await res.json()
            if (!res.ok || !data.success) patch(id, { loading: false, error: data?.error || 'Lookup failed' })
            else patch(id, { loading: false, reports: data.reports, error: data.notFound ? 'Kuntanii has no record of this order' : undefined })
        } catch {
            patch(id, { loading: false, error: 'Network error' })
        }
    }

    /** Report one order; returns true on success. */
    const report = async (id: string): Promise<boolean> => {
        patch(id, { loading: true, error: undefined })
        try {
            const res = await fetch('/api/admin/kuntanii/not-received', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ orderId: id, description: note }),
            })
            const data = await res.json()
            const r = data?.results?.[0]
            if (!res.ok || !r?.success) {
                patch(id, { loading: false, error: r?.error || data?.error || 'Report failed' })
                return false
            }
            setState(prev => ({ ...prev, [id]: { loading: false, reports: [...(prev[id]?.reports || []), r.report] } }))
            return true
        } catch {
            patch(id, { loading: false, error: 'Network error' })
            return false
        }
    }

    const reportOne = async (o: KtOrder) => {
        if (!confirm(`Report ${o.phone} (${o.size}) as NOT RECEIVED to Kuntanii?`)) return
        if (await report(o.id)) toast.success(`Reported ${o.phone}`)
        else toast.error(`Could not report ${o.phone}`)
    }

    const reportSelected = async () => {
        const ids = [...selected]
        if (ids.length === 0) return
        if (!confirm(`Report ${ids.length} order(s) as NOT RECEIVED to Kuntanii?`)) return
        setBulkBusy(true)
        let ok = 0
        for (const id of ids) if (await report(id)) ok++ // one at a time: Kuntanii rate-limits
        setBulkBusy(false)
        setSelected(new Set())
        if (ok === ids.length) toast.success(`Reported ${ok} order(s)`)
        else toast.warning(`Reported ${ok} of ${ids.length}. See the red notes for the rest.`)
    }

    const copyList = () => {
        const lines = visible.map(o => `${o.externalOrderId}\t${o.phone}\t${o.size}\t${time(o.createdAt)}\t${o.status}`)
        navigator.clipboard.writeText(['External Order ID\tPhone\tSize\tTime (GMT)\tStatus', ...lines].join('\n'))
            .then(() => toast.success(`Copied ${lines.length} order(s)`), () => toast.error('Copy failed'))
    }

    const toggle = (id: string) => setSelected(prev => {
        const next = new Set(prev)
        if (next.has(id)) next.delete(id); else next.add(id)
        return next
    })

    const reportable = visible.filter(o => o.status === 'completed')
    const allSelected = reportable.length > 0 && reportable.every(o => selected.has(o.id))

    return (
        <div className="space-y-6">
            <div>
                <h1 className="text-2xl font-bold flex items-center gap-2">
                    <Flag className="w-6 h-6 text-orange-600" />
                    Kuntanii Reports
                </h1>
                <p className="text-sm text-muted-foreground mt-1">
                    Tell Kuntanii when a customer did not receive a bundle they marked delivered
                </p>
            </div>

            <div className="max-w-5xl space-y-4">
                <Card className="rounded-3xl">
                    <CardContent className="pt-6 space-y-4">
                        <div className="flex flex-wrap gap-3 items-center">
                            <Input type="date" value={date} max={today()} onChange={e => setDate(e.target.value || today())} className="w-auto h-11 rounded-xl" />
                            <div className="relative flex-1 min-w-[180px]">
                                <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                                <Input placeholder="Search phone or order ID" value={search} onChange={e => setSearch(e.target.value)} className="h-11 rounded-xl pl-9" />
                            </div>
                            <Button variant="outline" className="h-11 rounded-xl" onClick={load} disabled={loading}>
                                <RefreshCw className={cn('w-4 h-4 mr-2', loading && 'animate-spin')} />Reload
                            </Button>
                        </div>
                        <div className="flex flex-wrap gap-2">
                            {(['completed', 'processing', 'all'] as Filter[]).map(f => (
                                <Button key={f} size="sm" variant={filter === f ? 'default' : 'outline'} className="rounded-full" onClick={() => setFilter(f)}>
                                    {f === 'completed' ? 'Delivered' : f === 'processing' ? 'Still processing' : 'All'} ({counts[f]})
                                </Button>
                            ))}
                        </div>
                        <div className="space-y-2">
                            <label className="text-xs font-semibold text-muted-foreground">Note sent with each report</label>
                            <Textarea value={note} onChange={e => setNote(e.target.value)} rows={2} maxLength={500} className="rounded-xl" />
                        </div>
                        <p className="text-xs text-muted-foreground">
                            Only <b>delivered</b> orders can be reported. Kuntanii reviews each one; a refund goes to our Kuntanii balance,
                            it does <b>not</b> refund the customer. Still-processing orders are just queued at Kuntanii, so wait for them.
                        </p>
                    </CardContent>
                </Card>

                <Card className="rounded-3xl">
                    <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0 flex-wrap">
                        <CardTitle className="text-lg">{visible.length} order(s)</CardTitle>
                        <div className="flex gap-2 flex-wrap">
                            <Button size="sm" variant="outline" className="rounded-xl" onClick={copyList} disabled={visible.length === 0}>
                                <Copy className="w-4 h-4 mr-2" />Copy list
                            </Button>
                            <Button size="sm" className="rounded-xl bg-orange-600 hover:bg-orange-700 text-white" onClick={reportSelected} disabled={selected.size === 0 || bulkBusy}>
                                {bulkBusy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Flag className="w-4 h-4 mr-2" />}
                                Report selected ({selected.size})
                            </Button>
                        </div>
                    </CardHeader>
                    <CardContent>
                        {loading || !orders ? (
                            <div className="space-y-2">{[0, 1, 2].map(i => <Skeleton key={i} className="h-14 rounded-xl" />)}</div>
                        ) : visible.length === 0 ? (
                            <p className="text-sm text-muted-foreground py-8 text-center">No Kuntanii orders here for {date}.</p>
                        ) : (
                            <div className="space-y-2">
                                {reportable.length > 0 && (
                                    <label className="flex items-center gap-2 text-xs text-muted-foreground px-1">
                                        <input type="checkbox" checked={allSelected} onChange={() =>
                                            setSelected(allSelected ? new Set() : new Set(reportable.map(o => o.id)))} />
                                        Select all delivered
                                    </label>
                                )}
                                {visible.map(o => {
                                    const st = state[o.id] || {}
                                    const canReport = o.status === 'completed'
                                    return (
                                        <div key={o.id} className="rounded-2xl border p-3 flex flex-col gap-2">
                                            <div className="flex items-center gap-3 flex-wrap">
                                                <input type="checkbox" disabled={!canReport} checked={selected.has(o.id)} onChange={() => toggle(o.id)} aria-label={`Select ${o.phone}`} />
                                                <div className="flex-1 min-w-[160px]">
                                                    <p className="font-bold">{o.phone} <span className="font-normal text-muted-foreground">· {o.size}</span></p>
                                                    <p className="text-xs text-muted-foreground break-all">
                                                        {time(o.createdAt)} GMT · {o.externalOrderId}{o.isShop ? ' · storefront' : ''}
                                                    </p>
                                                </div>
                                                <Badge className={STATUS_CLASS[o.status] || STATUS_CLASS.pending}>
                                                    {o.status === 'completed' ? 'Delivered' : o.status}
                                                </Badge>
                                                <Button size="sm" variant="outline" className="rounded-xl" disabled={st.loading} onClick={() => check(o.id)}>
                                                    Check
                                                </Button>
                                                <Button size="sm" className="rounded-xl bg-orange-600 hover:bg-orange-700 text-white" disabled={!canReport || st.loading} onClick={() => reportOne(o)}>
                                                    {st.loading ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Report'}
                                                </Button>
                                            </div>
                                            {st.error && <p className="text-xs text-red-600">{st.error}</p>}
                                            {st.reports && st.reports.length === 0 && !st.error && (
                                                <p className="text-xs text-muted-foreground">No reports at Kuntanii for this order.</p>
                                            )}
                                            {st.reports?.map((r, i) => (
                                                <p key={r.reportReference || i} className="text-xs font-medium text-orange-700 dark:text-orange-400">{describe(r)}</p>
                                            ))}
                                        </div>
                                    )
                                })}
                            </div>
                        )}
                    </CardContent>
                </Card>
            </div>
        </div>
    )
}
