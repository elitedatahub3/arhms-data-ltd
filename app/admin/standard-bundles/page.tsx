'use client'

import { useCallback, useEffect, useState } from 'react'
import { Wifi, RefreshCw, Loader2, Search, Send, CheckCircle2, RotateCcw, Activity, Save, PlugZap } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'

// Keys mirror lib/bundle-pricing.ts BUNDLE_SETTING_KEYS. Inlined rather than
// imported to keep server-only modules out of the client bundle.
const TIERS = [
    { key: 'customer', label: 'Customers' },
    { key: 'agent', label: 'Agents' },
    { key: 'dealer', label: 'Dealers' },
    { key: 'api', label: 'API users' },
] as const

const SWITCHES: { key: string; label: string; hint: string }[] = [
    { key: 'bundles_enabled', label: 'Standard Bundles on', hint: 'Master switch. Off hides the page and stops all new orders.' },
    { key: 'page_access_standard_bundles', label: 'Show dashboard page', hint: 'Page-access toggle for /dashboard/standard-bundles.' },
    { key: 'bundles_enabled_mtn', label: 'MTN', hint: '' },
    { key: 'bundles_enabled_telecel', label: 'Telecel', hint: '' },
    { key: 'bundles_enabled_at', label: 'AirtelTigo', hint: '' },
    { key: 'bundles_auto_dispatch', label: 'Send orders automatically', hint: 'Off holds new orders as Pending until you press Send.' },
]

// Mirrors lib/bundle-provider.ts. A missing setting means KingFlexy.
const PROVIDERS = [
    { key: 'kingflexy', label: 'KingFlexy' },
    { key: 'datagod', label: 'Datagod' },
] as const
const PROVIDER_LABEL: Record<string, string> = { kingflexy: 'KingFlexy', datagod: 'Datagod' }
const PROVIDER_NETWORKS = [
    { key: 'bundles_provider_mtn', label: 'MTN' },
    { key: 'bundles_provider_telecel', label: 'Telecel' },
    { key: 'bundles_provider_at', label: 'AirtelTigo' },
] as const

const STATUS_TABS =['all', 'pending', 'processing', 'completed', 'refunded', 'failed'] as const

const STATUS_CLASS: Record<string, string> = {
    pending: 'bg-amber-100 text-amber-800',
    processing: 'bg-blue-100 text-blue-800',
    completed: 'bg-emerald-100 text-emerald-800',
    failed: 'bg-red-100 text-red-800',
    refunded: 'bg-slate-200 text-slate-800',
}

const ghs = (n: number) => `GHS ${Number(n || 0).toFixed(2)}`

export default function AdminStandardBundlesPage() {
    const [view, setView] = useState<'orders' | 'settings'>('orders')

    // ── Orders ──────────────────────────────────────────────────────────────
    const [status, setStatus] = useState<typeof STATUS_TABS[number]>('all')
    const [q, setQ] = useState('')
    const [orders, setOrders] = useState<any[]>([])
    const [summary, setSummary] = useState<any>(null)
    const [loading, setLoading] = useState(false)
    const [busy, setBusy] = useState<string | null>(null)

    const loadOrders = useCallback(async () => {
        setLoading(true)
        try {
            const params = new URLSearchParams()
            if (status !== 'all') params.set('status', status)
            if (q.trim()) params.set('q', q.trim())
            const res = await fetch(`/api/admin/bundles/orders?${params}`, { cache: 'no-store' })
            const body = await res.json()
            if (!res.ok) throw new Error(body?.error || 'Failed to load orders')
            setOrders(body.orders || [])
            setSummary(body.summary || null)
        } catch (e: any) {
            toast.error(e.message)
        } finally {
            setLoading(false)
        }
    }, [status, q])

    useEffect(() => { if (view === 'orders') loadOrders() }, [view, status]) // eslint-disable-line react-hooks/exhaustive-deps

    async function act(order: any, action: 'send' | 'recheck' | 'complete' | 'refund') {
        const who = PROVIDER_LABEL[order.provider] || 'KingFlexy'
        if (action === 'refund' && order.status === 'processing' &&
            !confirm(`This order is still processing at ${who}. Refunding now could pay for a bundle that is later delivered. Refund anyway?`)) return
        if (action === 'complete' && !confirm(`Mark ${order.reference_code} as delivered? Only do this after confirming with ${who}.`)) return
        setBusy(`${order.id}:${action}`)
        try {
            const res = await fetch('/api/admin/bundles/orders', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ orderId: order.id, action }),
            })
            const body = await res.json()
            if (!res.ok) throw new Error(body?.error || 'Action failed')
            toast.success(action === 'recheck' ? `${who} says: ${body.outcome}` : 'Done')
            loadOrders()
        } catch (e: any) {
            toast.error(e.message)
        } finally {
            setBusy(null)
        }
    }

    // ── Settings ────────────────────────────────────────────────────────────
    const [settings, setSettings] = useState<Record<string, string>>({})
    const [providers, setProviders] = useState<Record<string, Record<string, any>> | null>(null)
    const [settingsLoading, setSettingsLoading] = useState(false)
    const [saving, setSaving] = useState(false)
    const [checking, setChecking] = useState(false)

    const loadSettings = useCallback(async (check = false) => {
        check ? setChecking(true) : setSettingsLoading(true)
        try {
            const res = await fetch(`/api/admin/bundles/settings${check ? '?check=1' : ''}`, { cache: 'no-store' })
            const body = await res.json()
            if (!res.ok) throw new Error(body?.error || 'Failed to load settings')
            setSettings(body.settings || {})
            if (body.providers) setProviders(body.providers)
        } catch (e: any) {
            toast.error(e.message)
        } finally {
            setChecking(false)
            setSettingsLoading(false)
        }
    }, [])

    useEffect(() => { if (view === 'settings') loadSettings() }, [view, loadSettings])

    async function saveSettings() {
        setSaving(true)
        try {
            const res = await fetch('/api/admin/bundles/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ settings }),
            })
            const body = await res.json()
            if (!res.ok) throw new Error(body?.error || 'Save failed')
            toast.success('Settings saved')
        } catch (e: any) {
            toast.error(e.message)
        } finally {
            setSaving(false)
        }
    }

    const isOn = (key: string) => key === 'page_access_standard_bundles' || key.startsWith('bundles_enabled_') || key === 'bundles_auto_dispatch'
        ? settings[key] !== 'false'
        : settings[key] === 'true'

    return (
        <div className="max-w-6xl mx-auto space-y-5 pb-20">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                    <h1 className="flex items-center gap-2 text-2xl font-black"><Wifi className="w-6 h-6 text-sky-500" /> Standard Bundles</h1>
                    <p className="text-sm text-muted-foreground">KingFlexy or Datagod bundles (chosen per network) resold at catalog price plus your markup.</p>
                </div>
                <div className="flex gap-1 rounded-full bg-secondary p-1">
                    {(['orders', 'settings'] as const).map(v => (
                        <button key={v} onClick={() => setView(v)} className={cn('px-4 py-1.5 rounded-full text-sm font-bold capitalize', view === v ? 'bg-background shadow-sm' : 'text-muted-foreground')}>
                            {v}
                        </button>
                    ))}
                </div>
            </div>

            {view === 'orders' && (
                <>
                    {summary && (
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                            <Stat label="Orders today" value={String(summary.orders)} />
                            <Stat label="Delivered sales today" value={ghs(summary.sales)} />
                            <Stat label="Markup earned today" value={ghs(summary.markup)} />
                            <Stat label="KingFlexy commission today" value={ghs(summary.kfCommission)} />
                        </div>
                    )}

                    <div className="flex flex-wrap items-center gap-2">
                        {STATUS_TABS.map(s => (
                            <button key={s} onClick={() => setStatus(s)} className={cn('px-3 py-1.5 rounded-full text-sm font-bold border capitalize', status === s ? 'bg-foreground text-background border-foreground' : 'bg-card')}>
                                {s}
                            </button>
                        ))}
                        <form className="flex gap-2 ml-auto" onSubmit={e => { e.preventDefault(); loadOrders() }}>
                            <Input value={q} onChange={e => setQ(e.target.value)} placeholder="Reference or phone" className="w-48" />
                            <Button type="submit" variant="outline" size="icon"><Search className="w-4 h-4" /></Button>
                            <Button type="button" variant="ghost" size="icon" onClick={loadOrders} disabled={loading}>
                                <RefreshCw className={cn('w-4 h-4', loading && 'animate-spin')} />
                            </Button>
                        </form>
                    </div>

                    <div className="rounded-2xl border bg-card overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead className="text-left text-xs text-muted-foreground border-b">
                                <tr>
                                    <th className="p-3">Order</th>
                                    <th className="p-3">Buyer</th>
                                    <th className="p-3">Bundle</th>
                                    <th className="p-3 text-right">Cost / Paid</th>
                                    <th className="p-3">Status</th>
                                    <th className="p-3">Actions</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y">
                                {loading && !orders.length && (
                                    <tr><td colSpan={6} className="p-8 text-center"><Loader2 className="w-5 h-5 animate-spin inline" /></td></tr>
                                )}
                                {!loading && !orders.length && (
                                    <tr><td colSpan={6} className="p-8 text-center text-muted-foreground">No orders.</td></tr>
                                )}
                                {orders.map(o => {
                                    const open = o.status === 'pending' || o.status === 'processing'
                                    return (
                                        <tr key={o.id} className="align-top">
                                            <td className="p-3">
                                                <p className="font-mono text-xs">{o.reference_code}</p>
                                                {o.provider_reference && <p className="font-mono text-[11px] text-muted-foreground">{o.provider_reference}</p>}
                                                <p className="text-[11px] text-muted-foreground">{new Date(o.created_at).toLocaleString()} · {o.source}/{o.payment_method}</p>
                                                <p className="text-[11px] font-bold text-sky-700">{PROVIDER_LABEL[o.provider] || 'KingFlexy'}</p>
                                            </td>
                                            <td className="p-3">
                                                <p className="font-medium">{[o.users?.first_name, o.users?.last_name].filter(Boolean).join(' ') || '—'}</p>
                                                <p className="text-[11px] text-muted-foreground">{o.users?.email} · {o.price_tier}</p>
                                            </td>
                                            <td className="p-3">
                                                <p className="font-bold">{o.network} {o.bundle_label}</p>
                                                <p className="text-[11px] text-muted-foreground">{o.family_label} → {o.beneficiary_phone}</p>
                                            </td>
                                            <td className="p-3 text-right whitespace-nowrap">
                                                <p className="text-muted-foreground">{ghs(o.cost_amount)}</p>
                                                <p className="font-bold">{ghs(o.total_paid)}</p>
                                                {o.kf_commission != null && <p className="text-[11px] text-emerald-600">+{ghs(o.kf_commission)} KF</p>}
                                            </td>
                                            <td className="p-3 max-w-[220px]">
                                                <span className={cn('inline-block text-[11px] font-bold px-2 py-0.5 rounded-full capitalize', STATUS_CLASS[o.status])}>{o.status}</span>
                                                {o.payment_status === 'refunded' && o.status !== 'refunded' && <span className="ml-1 text-[11px] text-slate-500">(refunded)</span>}
                                                {o.fulfillment_note && <p className="text-[11px] text-muted-foreground mt-1 break-words">{o.fulfillment_note}</p>}
                                            </td>
                                            <td className="p-3">
                                                <div className="flex flex-wrap gap-1">
                                                    {o.status === 'pending' && (
                                                        <ActionButton icon={Send} label="Send" busy={busy === `${o.id}:send`} onClick={() => act(o, 'send')} />
                                                    )}
                                                    {o.status === 'processing' && (
                                                        <ActionButton icon={Activity} label="Recheck" busy={busy === `${o.id}:recheck`} onClick={() => act(o, 'recheck')} />
                                                    )}
                                                    {open && (
                                                        <ActionButton icon={CheckCircle2} label="Delivered" busy={busy === `${o.id}:complete`} onClick={() => act(o, 'complete')} />
                                                    )}
                                                    {open && o.payment_status === 'paid' && (
                                                        <ActionButton icon={RotateCcw} label="Refund" busy={busy === `${o.id}:refund`} onClick={() => act(o, 'refund')} />
                                                    )}
                                                </div>
                                            </td>
                                        </tr>
                                    )
                                })}
                            </tbody>
                        </table>
                    </div>
                </>
            )}

            {view === 'settings' && (
                settingsLoading ? (
                    <div className="p-10 flex justify-center"><Loader2 className="w-6 h-6 animate-spin" /></div>
                ) : (
                    <div className="grid lg:grid-cols-2 gap-5">
                        <section className="rounded-2xl border bg-card p-5 space-y-4">
                            <h2 className="font-bold">Switches</h2>
                            {SWITCHES.map(s => (
                                <div key={s.key} className="flex items-start justify-between gap-4">
                                    <div>
                                        <p className="font-medium text-sm">{s.label}</p>
                                        {s.hint && <p className="text-xs text-muted-foreground">{s.hint}</p>}
                                    </div>
                                    <Switch checked={isOn(s.key)} onCheckedChange={v => setSettings(p => ({ ...p, [s.key]: String(v) }))} />
                                </div>
                            ))}
                        </section>

                        <section className="rounded-2xl border bg-card p-5 space-y-4 lg:col-span-2">
                            <div>
                                <h2 className="font-bold">Provider per network</h2>
                                <p className="text-xs text-muted-foreground">
                                    Decides who takes NEW orders. Orders already sent stay with the provider that took them, so switching is safe at any time.
                                    Run Test connection below before switching a network to a provider.
                                </p>
                            </div>
                            <div className="grid sm:grid-cols-3 gap-3">
                                {PROVIDER_NETWORKS.map(n => {
                                    const current = settings[n.key] === 'datagod' ? 'datagod' : 'kingflexy'
                                    return (
                                        <div key={n.key} className="rounded-xl border p-3">
                                            <p className="font-medium text-sm mb-2">{n.label}</p>
                                            <div role="radiogroup" aria-label={`${n.label} provider`} className="flex gap-1 rounded-full bg-secondary p-1">
                                                {PROVIDERS.map(p => (
                                                    <button
                                                        key={p.key}
                                                        type="button"
                                                        role="radio"
                                                        aria-checked={current === p.key}
                                                        onClick={() => setSettings(s => ({ ...s, [n.key]: p.key }))}
                                                        className={cn('flex-1 px-3 py-1.5 rounded-full text-xs font-bold', current === p.key ? 'bg-background shadow-sm' : 'text-muted-foreground')}
                                                    >
                                                        {p.label}
                                                    </button>
                                                ))}
                                            </div>
                                        </div>
                                    )
                                })}
                            </div>
                        </section>

                        <section className="rounded-2xl border bg-card p-5 space-y-4">
                            <h2 className="font-bold">Markup on the provider&apos;s catalog price</h2>
                            <p className="text-xs text-muted-foreground">
                                The same markup applies whichever provider a network uses. KingFlexy charges the catalog price and pays a commission on top;
                                Datagod&apos;s price is what we pay. Buyers pay the higher of the percentage and the minimum, rounded up to the pesewa.
                            </p>
                            {TIERS.map(t => (
                                <div key={t.key} className="flex items-center justify-between gap-3">
                                    <Label htmlFor={`m-${t.key}`}>{t.label}</Label>
                                    <div className="flex items-center gap-1">
                                        <Input
                                            id={`m-${t.key}`}
                                            type="number" min={0} max={100} step="0.1" className="w-24 text-right"
                                            value={settings[`bundles_markup_percent_${t.key}`] ?? ''}
                                            onChange={e => setSettings(p => ({ ...p, [`bundles_markup_percent_${t.key}`]: e.target.value }))}
                                        />
                                        <span className="text-sm text-muted-foreground">%</span>
                                    </div>
                                </div>
                            ))}
                            <div className="flex items-center justify-between gap-3">
                                <Label htmlFor="m-min">Minimum markup</Label>
                                <div className="flex items-center gap-1">
                                    <span className="text-sm text-muted-foreground">GHS</span>
                                    <Input
                                        id="m-min" type="number" min={0} step="0.01" className="w-24 text-right"
                                        value={settings.bundles_markup_min_ghs ?? ''}
                                        onChange={e => setSettings(p => ({ ...p, bundles_markup_min_ghs: e.target.value }))}
                                    />
                                </div>
                            </div>
                        </section>

                        <section className="rounded-2xl border bg-card p-5 space-y-3 lg:col-span-2">
                            <div className="flex items-center justify-between gap-3">
                                <div>
                                    <h2 className="font-bold">Provider connections</h2>
                                    <p className="text-xs text-muted-foreground">Loads a fresh catalog for each network from KingFlexy and Datagod with our Commission Services keys.</p>
                                </div>
                                <Button variant="outline" onClick={() => loadSettings(true)} disabled={checking}>
                                    {checking ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <PlugZap className="w-4 h-4 mr-2" />} Test connection
                                </Button>
                            </div>
                            {providers && PROVIDERS.filter(p => providers[p.key]).map(p => (
                                <div key={p.key} className="space-y-1">
                                    <p className="text-xs font-bold text-muted-foreground uppercase">{p.label}</p>
                                    <div className="grid sm:grid-cols-3 gap-2">
                                        {Object.entries(providers[p.key]).map(([net, r]: [string, any]) => (
                                            <div key={net} className={cn('rounded-xl border p-3 text-sm', r.ok ? 'border-emerald-300' : 'border-red-300')}>
                                                <p className="font-bold">{net}</p>
                                                <p className={r.ok ? 'text-emerald-700' : 'text-red-700'}>
                                                    {r.ok ? `${r.bundles} bundles${r.enabled ? '' : ` (paused by ${p.label})`}` : r.error}
                                                </p>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            ))}
                        </section>

                        <div className="lg:col-span-2 flex justify-end">
                            <Button onClick={saveSettings} disabled={saving}>
                                {saving ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Save className="w-4 h-4 mr-2" />} Save settings
                            </Button>
                        </div>
                    </div>
                )
            )}
        </div>
    )
}

function Stat({ label, value }: { label: string; value: string }) {
    return (
        <div className="rounded-2xl border bg-card p-4">
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className="text-lg font-black mt-1">{value}</p>
        </div>
    )
}

function ActionButton({ icon: Icon, label, busy, onClick }: { icon: any; label: string; busy: boolean; onClick: () => void }) {
    return (
        <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={onClick} disabled={busy}>
            {busy ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Icon className="w-3 h-3 mr-1" />}{label}
        </Button>
    )
}
