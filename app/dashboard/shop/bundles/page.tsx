'use client'

/**
 * My Shop > Standard Bundles: switch them on for the storefront, set the shop's
 * percentage, and see the storefront's Standard Bundle orders.
 */
import { useCallback, useEffect, useState } from 'react'
import { Loader2, RefreshCw, Wifi } from 'lucide-react'
import { Button } from '@/components/ui/button'
import ShopBundlePricing from '@/components/shop/bundle-pricing'
import { cn } from '@/lib/utils'

const STATUS_CLASS: Record<string, string> = {
    pending: 'bg-amber-100 text-amber-800',
    processing: 'bg-blue-100 text-blue-800',
    completed: 'bg-emerald-100 text-emerald-800',
    failed: 'bg-red-100 text-red-800',
    refunded: 'bg-slate-200 text-slate-800',
}

const ghs = (n: number) => `GH₵${Number(n || 0).toFixed(2)}`

export default function ShopStandardBundlesPage() {
    const [orders, setOrders] = useState<any[]>([])
    const [summary, setSummary] = useState<any>(null)
    const [loading, setLoading] = useState(true)

    const load = useCallback(async () => {
        setLoading(true)
        try {
            const res = await fetch('/api/shop/bundles/orders', { cache: 'no-store' })
            const body = await res.json()
            if (res.ok) {
                setOrders(body.orders || [])
                setSummary(body.summary || null)
            }
        } finally {
            setLoading(false)
        }
    }, [])

    useEffect(() => { load() }, [load])

    return (
        <div className="max-w-4xl mx-auto space-y-5 pb-20">
            <div>
                <h1 className="flex items-center gap-2 text-2xl font-black"><Wifi className="w-6 h-6 text-sky-500" /> Standard Bundles</h1>
                <p className="text-sm text-muted-foreground">Sell Standard Bundles on your storefront and earn your own percentage on every delivered bundle.</p>
            </div>

            <ShopBundlePricing standalone />

            {summary && (
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    <Stat label="Orders" value={String(summary.orders)} />
                    <Stat label="Delivered" value={String(summary.delivered)} />
                    <Stat label="Delivered sales" value={ghs(summary.sales)} />
                    <Stat label="Your profit" value={ghs(summary.profit)} />
                </div>
            )}

            <div className="rounded-2xl border bg-card overflow-hidden">
                <div className="flex items-center justify-between p-4 border-b">
                    <h2 className="font-bold">Storefront orders</h2>
                    <Button variant="ghost" size="icon" onClick={load} disabled={loading}>
                        <RefreshCw className={cn('w-4 h-4', loading && 'animate-spin')} />
                    </Button>
                </div>
                {loading && !orders.length ? (
                    <div className="p-8 flex justify-center"><Loader2 className="w-5 h-5 animate-spin" /></div>
                ) : !orders.length ? (
                    <p className="p-8 text-center text-sm text-muted-foreground">No Standard Bundle orders from your storefront yet.</p>
                ) : (
                    <div className="divide-y">
                        {orders.map(o => (
                            <div key={o.reference_code} className="p-4 flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                    <p className="font-bold">{o.network} {o.bundle_label}</p>
                                    <p className="text-xs text-muted-foreground">To {o.beneficiary_phone} · {new Date(o.created_at).toLocaleString()}</p>
                                    <p className="font-mono text-[11px] text-muted-foreground break-all">{o.reference_code}</p>
                                    {Number(o.refunded_amount) > 0 && (
                                        <p className="text-[11px] text-amber-700">{ghs(o.refunded_amount)} returned to your wallet for the part not delivered. Refund your customer.</p>
                                    )}
                                    {o.payment_status === 'refunded' && (
                                        <p className="text-[11px] text-amber-700">Not delivered. What the customer paid is back in your wallet. Refund your customer.</p>
                                    )}
                                </div>
                                <div className="text-right shrink-0">
                                    <p className="font-bold">{ghs(o.total_paid)}</p>
                                    {o.status === 'completed' && Number(o.shop_profit) > 0 && <p className="text-[11px] text-emerald-600">+{ghs(o.shop_profit)} profit</p>}
                                    <span className={cn('inline-block mt-1 text-[11px] font-bold px-2 py-0.5 rounded-full capitalize', STATUS_CLASS[o.status])}>{o.status}</span>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>
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
