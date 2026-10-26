'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Wifi, Wallet, ShoppingCart, Loader2, History, RefreshCw, CheckCircle2, AlertTriangle, Clock, XCircle, RotateCcw } from 'lucide-react'
import { toast } from 'sonner'
import { useAuth } from '@/contexts/auth-context'
import { refreshDashboardSummary } from '@/hooks/use-dashboard-summary'
import { supabase } from '@/lib/supabase'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'

type NetworkId = 'MTN' | 'Telecel' | 'AT'

const NETWORKS: { id: NetworkId; label: string; prefixes: string[]; card: string; band: string; chip: string; ring: string; badge: string }[] = [
    {
        id: 'MTN', label: 'MTN', prefixes: ['024', '025', '053', '054', '055', '059', '098'],
        card: 'bg-[#FFC20E] text-black', band: 'bg-black/10 hover:bg-black/15 text-black', chip: 'bg-black/10 text-black',
        ring: 'border-[#FFC20E] ring-2 ring-[#FFC20E]/40', badge: 'bg-[#FFC20E] text-black',
    },
    {
        id: 'Telecel', label: 'Telecel', prefixes: ['020', '050'],
        card: 'bg-[#E3262F] text-white', band: 'bg-black/15 hover:bg-black/25 text-white', chip: 'bg-white/20 text-white',
        ring: 'border-[#E3262F] ring-2 ring-[#E3262F]/30', badge: 'bg-[#E3262F] text-white',
    },
    {
        id: 'AT', label: 'AirtelTigo', prefixes: ['026', '027', '028', '056', '057', '058'],
        card: 'bg-[#2563EB] text-white', band: 'bg-black/15 hover:bg-black/25 text-white', chip: 'bg-white/20 text-white',
        ring: 'border-[#2563EB] ring-2 ring-[#2563EB]/30', badge: 'bg-[#2563EB] text-white',
    },
]

interface Family { key: string; label: string; description: string | null }
interface Bundle { key: string; size: string; plan: string | null; family: string; familyLabel: string; validity: string | null; price: number }
interface Catalog { network: NetworkId; available: boolean; families: Family[]; bundles: Bundle[] }
interface Order {
    id: string; reference_code: string; network: NetworkId; bundle_label: string; family_label: string | null
    beneficiary_phone: string; total_paid: number; status: string; created_at: string
}

const STATUS_STYLE: Record<string, { label: string; className: string; icon: any }> = {
    pending: { label: 'Pending', className: 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300', icon: Clock },
    processing: { label: 'Processing', className: 'bg-blue-100 text-blue-800 dark:bg-blue-500/15 dark:text-blue-300', icon: Loader2 },
    completed: { label: 'Delivered', className: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300', icon: CheckCircle2 },
    failed: { label: 'Failed', className: 'bg-red-100 text-red-800 dark:bg-red-500/15 dark:text-red-300', icon: XCircle },
    refunded: { label: 'Refunded', className: 'bg-slate-200 text-slate-800 dark:bg-slate-500/20 dark:text-slate-300', icon: RotateCcw },
}

function ghs(n: number) {
    return `GH₵${Number(n || 0).toFixed(2)}`
}

function networkForPhone(phone: string): NetworkId | null {
    const digits = phone.replace(/\D/g, '')
    if (digits.length < 3) return null
    return NETWORKS.find(n => n.prefixes.includes(digits.slice(0, 3)))?.id ?? null
}

function newReference() {
    const rand = Array.from(crypto.getRandomValues(new Uint8Array(6))).map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase()
    return `BNDL-${Date.now().toString(36).toUpperCase()}-${rand}`
}

function NetworkMark({ id, className }: { id: NetworkId; className?: string }) {
    const n = NETWORKS.find(x => x.id === id)!
    return (
        <span className={cn('inline-flex shrink-0 items-center justify-center rounded-full font-black text-[10px] tracking-tight', n.badge, className)}>
            {id === 'AT' ? 'at' : id === 'Telecel' ? 't' : 'MTN'}
        </span>
    )
}

export default function StandardBundlesPage() {
    const { dbUser } = useAuth() as any
    const [tab, setTab] = useState<'buy' | 'history'>('buy')
    const [network, setNetwork] = useState<NetworkId>('MTN')
    const [enabledNetworks, setEnabledNetworks] = useState<Record<NetworkId, boolean>>({ MTN: true, Telecel: true, AT: true })
    const [featureOff, setFeatureOff] = useState(false)
    const [catalog, setCatalog] = useState<Catalog | null>(null)
    const [catalogLoading, setCatalogLoading] = useState(true)
    const [catalogError, setCatalogError] = useState<string | null>(null)
    const [family, setFamily] = useState<string | null>(null)
    const [balance, setBalance] = useState<number | null>(null)

    const [selected, setSelected] = useState<Bundle | null>(null)
    const [phone, setPhone] = useState('')
    const [submitting, setSubmitting] = useState(false)
    const referenceRef = useRef<string | null>(null)

    const [orders, setOrders] = useState<Order[]>([])
    const [ordersLoading, setOrdersLoading] = useState(false)

    const theme = NETWORKS.find(n => n.id === network)!

    // ── Wallet ───────────────────────────────────────────────────────────────
    const loadBalance = useCallback(async () => {
        if (!dbUser?.id) return
        const { data } = await supabase.from('wallets').select('balance').eq('user_id', dbUser.id).single()
        if (data) setBalance(Number((data as any).balance) || 0)
    }, [dbUser?.id])

    useEffect(() => { loadBalance() }, [loadBalance])

    // ── Catalog ──────────────────────────────────────────────────────────────
    const loadCatalog = useCallback(async (net: NetworkId) => {
        setCatalogLoading(true)
        setCatalogError(null)
        try {
            const res = await fetch(`/api/bundles/catalog?network=${net}`, { cache: 'no-store' })
            const body = await res.json().catch(() => ({}))
            if (!res.ok) throw new Error(body?.error || 'Could not load bundles')
            if (body.networks) setEnabledNetworks(body.networks)
            if (!body.enabled) {
                setFeatureOff(true)
                setCatalog(null)
                return
            }
            setFeatureOff(false)
            setCatalog(body.catalog)
            setFamily(prev => (body.catalog?.families?.some((f: Family) => f.key === prev) ? prev : body.catalog?.families?.[0]?.key ?? null))
        } catch (e: any) {
            setCatalogError(e?.message || 'Could not load bundles')
            setCatalog(null)
        } finally {
            setCatalogLoading(false)
        }
    }, [])

    useEffect(() => { loadCatalog(network) }, [network, loadCatalog])

    // ── History ──────────────────────────────────────────────────────────────
    const loadOrders = useCallback(async () => {
        setOrdersLoading(true)
        try {
            const res = await fetch('/api/bundles/history?limit=50', { cache: 'no-store' })
            if (res.ok) setOrders((await res.json()).orders || [])
        } finally {
            setOrdersLoading(false)
        }
    }, [])

    useEffect(() => { if (tab === 'history') loadOrders() }, [tab, loadOrders])

    // Poll while anything is still on its way, so the badge flips to Delivered
    // without a refresh.
    const hasOpenOrders = orders.some(o => o.status === 'pending' || o.status === 'processing')
    useEffect(() => {
        if (tab !== 'history' || !hasOpenOrders) return
        const t = setInterval(() => { loadOrders(); loadBalance() }, 8000)
        return () => clearInterval(t)
    }, [tab, hasOpenOrders, loadOrders, loadBalance])

    // ── Derived ──────────────────────────────────────────────────────────────
    const visibleBundles = useMemo(
        () => (catalog?.bundles || []).filter(b => !family || b.family === family),
        [catalog, family]
    )
    const activeFamily = catalog?.families.find(f => f.key === family) ?? null

    const phoneNetwork = networkForPhone(phone)
    const phoneDigits = phone.replace(/\D/g, '')
    const phoneMismatch = phoneDigits.length >= 3 && phoneNetwork !== network
    const phoneValid = /^0\d{9}$/.test(phoneDigits) && !phoneMismatch
    const insufficient = selected != null && balance != null && balance < selected.price

    function openBuy(b: Bundle) {
        setSelected(b)
        referenceRef.current = newReference()
        if (!phone && dbUser?.phone_number && networkForPhone(dbUser.phone_number) === network) {
            setPhone(String(dbUser.phone_number).replace(/\D/g, '').replace(/^233/, '0'))
        }
    }

    async function confirmBuy() {
        if (!selected || !phoneValid || submitting) return
        setSubmitting(true)
        try {
            const res = await fetch('/api/bundles/create', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ network, bundleKey: selected.key, phone: phoneDigits, referenceCode: referenceRef.current }),
            })
            const body = await res.json().catch(() => ({}))
            if (!res.ok || !body?.success) {
                toast.error(body?.error || 'Purchase failed')
                // A stale bundle: reload so the list matches what can be bought.
                if (res.status === 404) loadCatalog(network)
                return
            }
            toast.success(`${network === 'AT' ? 'AirtelTigo' : network} ${selected.size} is on its way to ${phoneDigits}`)
            if (body.order?.new_balance != null) setBalance(Number(body.order.new_balance))
            refreshDashboardSummary?.()
            setSelected(null)
            setTab('history')
        } catch {
            toast.error('Network error. Check History before trying again — you may already have been charged.')
        } finally {
            setSubmitting(false)
        }
    }

    // ── Render ───────────────────────────────────────────────────────────────
    return (
        <div className="max-w-6xl mx-auto space-y-5 pb-24">
            <div>
                <h1 className="flex items-center gap-2 text-xl sm:text-2xl font-black tracking-tight">
                    <Wifi className="w-6 h-6 text-sky-500" /> Standard Bundles
                </h1>
                <p className="text-sm text-muted-foreground mt-1">
                    MTN, Telecel and AirtelTigo internet bundles, straight from your wallet.
                </p>
            </div>

            <div className="rounded-2xl border bg-card p-4 sm:p-5 flex items-center justify-between gap-3">
                <div>
                    <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><Wallet className="w-3.5 h-3.5" /> Wallet balance</p>
                    <p className="text-2xl sm:text-3xl font-black mt-1">{balance == null ? '—' : ghs(balance)}</p>
                </div>
                <div className="flex gap-1 rounded-full bg-secondary p-1">
                    {(['buy', 'history'] as const).map(t => (
                        <button
                            key={t}
                            onClick={() => setTab(t)}
                            className={cn('px-4 py-1.5 rounded-full text-sm font-bold transition-colors', tab === t ? 'bg-background shadow-sm' : 'text-muted-foreground')}
                        >
                            {t === 'buy' ? 'Buy' : 'History'}
                        </button>
                    ))}
                </div>
            </div>

            {tab === 'buy' && (
                <>
                    <div className="grid grid-cols-3 gap-2 sm:gap-3">
                        {NETWORKS.map(n => {
                            const live = enabledNetworks[n.id] !== false
                            return (
                                <button
                                    key={n.id}
                                    disabled={!live}
                                    onClick={() => setNetwork(n.id)}
                                    className={cn(
                                        'relative rounded-xl sm:rounded-2xl border bg-card px-1.5 py-2 sm:p-4 flex flex-col items-center gap-0.5 sm:gap-1.5 transition-all',
                                        network === n.id ? n.ring : 'hover:border-foreground/20',
                                        !live && 'opacity-50 cursor-not-allowed'
                                    )}
                                >
                                    {network === n.id && <CheckCircle2 className="absolute top-1 right-1 sm:top-2 sm:right-2 w-3 h-3 sm:w-4 sm:h-4 text-emerald-500" />}
                                    <NetworkMark id={n.id} className="w-6 h-6 text-[7px] sm:w-9 sm:h-9 sm:text-[10px]" />
                                    <span className="text-xs sm:text-sm font-bold leading-tight">{n.label}</span>
                                    <span className={cn('flex items-center gap-1 text-[10px] sm:text-[11px] leading-tight', live ? 'text-emerald-600' : 'text-amber-600')}>
                                        <span className={cn('w-1.5 h-1.5 rounded-full', live ? 'bg-emerald-500' : 'bg-amber-500')} />
                                        {live ? 'Live' : 'Unavailable'}
                                    </span>
                                </button>
                            )
                        })}
                    </div>

                    {featureOff ? (
                        <EmptyState icon={AlertTriangle} title="Standard Bundles are not available right now" text="Please check back soon." />
                    ) : catalogLoading ? (
                        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
                            {Array.from({ length: 10 }).map((_, i) => <div key={i} className="h-44 rounded-2xl bg-secondary animate-pulse" />)}
                        </div>
                    ) : catalogError ? (
                        <EmptyState
                            icon={AlertTriangle}
                            title="Could not load bundles"
                            text={catalogError}
                            action={<Button variant="outline" onClick={() => loadCatalog(network)}><RefreshCw className="w-4 h-4 mr-2" />Try again</Button>}
                        />
                    ) : !catalog?.available ? (
                        <EmptyState icon={Clock} title={`${theme.label} bundles are paused`} text="The provider has paused this network for now. Try another network or check back later." />
                    ) : (
                        <>
                            <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1">
                                {catalog.families.map(f => (
                                    <button
                                        key={f.key}
                                        onClick={() => setFamily(f.key)}
                                        className={cn(
                                            'shrink-0 px-4 py-2 rounded-full text-sm font-bold border transition-colors',
                                            family === f.key ? 'bg-foreground text-background border-foreground' : 'bg-card hover:bg-secondary'
                                        )}
                                    >
                                        {f.label}
                                    </button>
                                ))}
                            </div>
                            {activeFamily?.description && <p className="text-sm text-muted-foreground">{activeFamily.description}</p>}

                            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
                                {visibleBundles.map(b => (
                                    <div key={b.key} className={cn('rounded-2xl overflow-hidden flex flex-col shadow-sm', theme.card)}>
                                        <div className="flex items-center justify-between p-3">
                                            <NetworkMark id={network} className="w-7 h-7 ring-2 ring-white/40" />
                                            <span className={cn('text-[10px] font-bold px-2 py-0.5 rounded-full', theme.chip)}>{network}</span>
                                        </div>
                                        <div className="flex-1 flex flex-col items-center justify-center text-center px-2 pb-3">
                                            <p className="text-xl sm:text-2xl font-black leading-tight">{b.size}</p>
                                            <p className="text-sm font-bold mt-1">{ghs(b.price)}</p>
                                            {b.validity && <p className="text-[11px] opacity-80 mt-0.5">{b.validity}</p>}
                                        </div>
                                        <button
                                            onClick={() => openBuy(b)}
                                            className={cn('flex items-center justify-center gap-1.5 py-2.5 text-sm font-bold transition-colors', theme.band)}
                                        >
                                            <ShoppingCart className="w-4 h-4" /> Buy Now
                                        </button>
                                    </div>
                                ))}
                            </div>
                            {!visibleBundles.length && <EmptyState icon={Wifi} title="No bundles in this group" text="Try another tab." />}
                        </>
                    )}
                </>
            )}

            {tab === 'history' && (
                <div className="rounded-2xl border bg-card">
                    <div className="flex items-center justify-between p-4 border-b">
                        <h2 className="flex items-center gap-2 font-bold"><History className="w-4 h-4" /> Recent bundle orders</h2>
                        <Button size="sm" variant="ghost" onClick={() => { loadOrders(); loadBalance() }} disabled={ordersLoading}>
                            <RefreshCw className={cn('w-4 h-4', ordersLoading && 'animate-spin')} />
                        </Button>
                    </div>
                    {ordersLoading && !orders.length ? (
                        <div className="p-8 flex justify-center"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
                    ) : !orders.length ? (
                        <EmptyState icon={History} title="No bundle orders yet" text="Bundles you buy will show here." />
                    ) : (
                        <ul className="divide-y">
                            {orders.map(o => {
                                const s = STATUS_STYLE[o.status] ?? STATUS_STYLE.pending
                                return (
                                    <li key={o.id} className="p-4 flex items-center gap-3">
                                        <NetworkMark id={o.network} className="w-9 h-9 shrink-0" />
                                        <div className="min-w-0 flex-1">
                                            <p className="font-bold truncate">{o.bundle_label} <span className="font-normal text-muted-foreground">→ {o.beneficiary_phone}</span></p>
                                            <p className="text-xs text-muted-foreground truncate">
                                                {new Date(o.created_at).toLocaleString()} · {o.reference_code}
                                            </p>
                                        </div>
                                        <div className="text-right shrink-0">
                                            <p className="font-bold text-sm">{ghs(o.total_paid)}</p>
                                            <span className={cn('inline-flex items-center gap-1 text-[11px] font-bold px-2 py-0.5 rounded-full mt-1', s.className)}>
                                                <s.icon className={cn('w-3 h-3', o.status === 'processing' && 'animate-spin')} /> {s.label}
                                            </span>
                                        </div>
                                    </li>
                                )
                            })}
                        </ul>
                    )}
                </div>
            )}

            <Dialog open={!!selected} onOpenChange={open => { if (!open && !submitting) setSelected(null) }}>
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>Buy {theme.label} {selected?.size}</DialogTitle>
                        <DialogDescription>
                            {selected?.familyLabel}{selected?.validity ? ` · ${selected.validity}` : ''}
                        </DialogDescription>
                    </DialogHeader>

                    <div className="space-y-4">
                        <div className="space-y-1.5">
                            <Label htmlFor="bundle-phone">{theme.label} number to receive the bundle</Label>
                            <Input
                                id="bundle-phone"
                                inputMode="numeric"
                                autoComplete="tel"
                                placeholder={`e.g. ${theme.prefixes[0]}1234567`}
                                value={phone}
                                maxLength={10}
                                onChange={e => setPhone(e.target.value.replace(/\D/g, '').slice(0, 10))}
                            />
                            {phoneMismatch && (
                                <p className="text-xs text-red-600 flex items-center gap-1">
                                    <AlertTriangle className="w-3.5 h-3.5" />
                                    {phoneNetwork ? `This looks like a ${NETWORKS.find(n => n.id === phoneNetwork)?.label} number.` : 'Unrecognised prefix.'} Enter a {theme.label} number.
                                </p>
                            )}
                        </div>

                        <div className="rounded-xl bg-secondary/60 p-3 space-y-1.5 text-sm">
                            <div className="flex justify-between"><span className="text-muted-foreground">Bundle</span><span className="font-bold">{theme.label} {selected?.size}</span></div>
                            <div className="flex justify-between"><span className="text-muted-foreground">Price</span><span className="font-bold">{ghs(selected?.price ?? 0)}</span></div>
                            <div className="flex justify-between"><span className="text-muted-foreground">Wallet after</span><span className={cn('font-bold', insufficient && 'text-red-600')}>{balance == null || !selected ? '—' : ghs(balance - selected.price)}</span></div>
                        </div>

                        {insufficient && (
                            <p className="text-sm text-red-600">Your wallet balance is too low for this bundle. <a href="/dashboard/wallet" className="underline font-bold">Top up</a></p>
                        )}
                    </div>

                    <DialogFooter className="gap-2">
                        <Button variant="outline" onClick={() => setSelected(null)} disabled={submitting}>Cancel</Button>
                        <Button onClick={confirmBuy} disabled={!phoneValid || insufficient || submitting}>
                            {submitting ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Wallet className="w-4 h-4 mr-2" />}
                            Pay {ghs(selected?.price ?? 0)} from wallet
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    )
}

function EmptyState({ icon: Icon, title, text, action }: { icon: any; title: string; text: string; action?: ReactNode }) {
    return (
        <div className="rounded-2xl border border-dashed bg-card p-8 text-center space-y-2">
            <Icon className="w-8 h-8 mx-auto text-muted-foreground" />
            <p className="font-bold">{title}</p>
            <p className="text-sm text-muted-foreground">{text}</p>
            {action && <div className="pt-2">{action}</div>}
        </div>
    )
}
