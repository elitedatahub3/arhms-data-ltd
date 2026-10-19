'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { MessageSquare, Sparkles, TrendingUp, TrendingDown, ShoppingBag, Wallet, Coins, Crown, History } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { SmsPaymentForm } from '@/components/sms/sms-payment-form'
import { SmsActiveGate, SmsPageHeader, useSmsPlatform, type SmsPlatformAccount } from '@/components/sms/platform/sms-platform-shell'
import { smsFetch } from '@/lib/sms/sms-fetch'

interface Bundle {
    id: string
    name: string
    credits: number
    price: number
    pricePerSms: number
}

interface Purchase {
    id: string
    credits: number
    amount: number
    status: string
    created_at: string
}

export default function SmsCreditsPage() {
    return (
        <>
            <SmsPageHeader title="Credits" description="One credit sends one SMS part to one number." icon={Coins} />
            <SmsActiveGate>
                {(info) => <Credits info={info} />}
            </SmsActiveGate>
        </>
    )
}

function Credits({ info }: { info: SmsPlatformAccount }) {
    const { reload } = useSmsPlatform()
    const [bundles, setBundles] = useState<Bundle[]>([])
    const [purchases, setPurchases] = useState<Purchase[]>([])
    const [loading, setLoading] = useState(true)
    const [selected, setSelected] = useState<Bundle | null>(null)
    // The balance when the purchase started, so an existing balance does not
    // read as "settled" on the first poll.
    const [startCredits, setStartCredits] = useState(0)

    const load = useCallback(async () => {
        try {
            const res = await smsFetch('/api/sms/credits?portal=platform', { cache: 'no-store' })
            const data = await res.json()
            if (data?.success) {
                setBundles(data.bundles || [])
                setPurchases(data.recentPurchases || [])
            } else {
                toast.error(data?.error || 'Could not load credit bundles')
            }
        } catch {
            toast.error('Could not load credit bundles')
        } finally {
            setLoading(false)
        }
    }, [])

    useEffect(() => { load() }, [load])

    // The cheapest per message gets the badge, but only when there is a choice.
    const bestId = useMemo(() => {
        if (bundles.length < 2) return null
        return bundles.reduce((best, b) => (b.pricePerSms < best.pricePerSms ? b : best), bundles[0]).id
    }, [bundles])

    const isSettled = useCallback(async () => {
        const res = await smsFetch('/api/sms/credits?portal=platform', { cache: 'no-store' })
        const data = await res.json()
        return Number(data?.credits) > startCredits
    }, [startCredits])

    const onSettled = useCallback(() => {
        toast.success(`${selected?.credits.toLocaleString() ?? ''} SMS credits added`)
        setSelected(null)
        reload()
        load()
    }, [selected, reload, load])

    const { account } = info

    return (
        <div className="space-y-5">
            <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-emerald-600 via-emerald-600 to-teal-700 p-5 text-white shadow-sm">
                <div className="flex items-start justify-between gap-3">
                    <p className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-emerald-50/90">
                        <MessageSquare className="w-3.5 h-3.5" /> Credit balance
                    </p>
                    <span className="flex items-center gap-1 rounded-full bg-white/15 px-2.5 py-1 text-[10px] font-black uppercase tracking-wide">
                        <Sparkles className="w-3 h-3" /> {info.mode === 'business' ? 'Business mode' : 'Platform mode'}
                    </span>
                </div>
                <p className="mt-1 flex items-baseline gap-2">
                    <span className="text-5xl font-black">{account.credits.toLocaleString()}</span>
                    <span className="text-lg font-bold text-emerald-50/80">SMS</span>
                </p>
                <div className="mt-4 grid grid-cols-2 gap-2">
                    <div className="rounded-2xl bg-white/10 p-3">
                        <p className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide text-emerald-50/80"><TrendingUp className="w-3 h-3" /> Total purchased</p>
                        <p className="mt-1 text-xl font-black">{account.totalPurchased.toLocaleString()}</p>
                    </div>
                    <div className="rounded-2xl bg-white/10 p-3">
                        <p className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide text-emerald-50/80"><TrendingDown className="w-3 h-3" /> Total used</p>
                        <p className="mt-1 text-xl font-black">{account.totalUsed.toLocaleString()}</p>
                    </div>
                </div>
            </div>

            <div className="space-y-3">
                <div className="flex items-center justify-between gap-2">
                    <p className="flex items-center gap-2 font-bold"><ShoppingBag className="w-4 h-4 text-emerald-600" /> Buy Credits</p>
                    <Link href="/dashboard/wallet" className="flex items-center gap-1 text-xs font-semibold text-emerald-700 hover:underline dark:text-emerald-400">
                        <Wallet className="w-3.5 h-3.5" /> Top up main wallet
                    </Link>
                </div>

                {loading ? (
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                        {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-36 rounded-2xl" />)}
                    </div>
                ) : bundles.length === 0 ? (
                    <Card><CardContent className="py-10 text-center text-sm text-muted-foreground">
                        No credit bundles are on sale yet. Please check back soon.
                    </CardContent></Card>
                ) : (
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                        {bundles.map((b) => {
                            const best = b.id === bestId
                            return (
                                <div key={b.id} className={cn(
                                    'relative flex flex-col rounded-2xl border bg-card p-3 shadow-sm',
                                    best ? 'border-emerald-400 ring-1 ring-emerald-300' : 'border-transparent'
                                )}>
                                    {best && (
                                        <span className="absolute -top-2.5 left-3 flex items-center gap-1 rounded-full bg-emerald-600 px-2 py-0.5 text-[9px] font-black uppercase text-white">
                                            <Crown className="w-2.5 h-2.5" /> Best
                                        </span>
                                    )}
                                    <p className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">Messages</p>
                                    <p className="text-lg font-black">{b.credits.toLocaleString()}</p>
                                    <p className="mt-1 font-black text-emerald-700 dark:text-emerald-400">GH₵{b.price.toFixed(2)}</p>
                                    <p className="text-[10px] text-muted-foreground">≈ GHS {b.pricePerSms.toFixed(3)}/SMS</p>
                                    <Button size="sm" className="mt-3 w-full gap-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 font-bold"
                                        onClick={() => { setStartCredits(account.credits); setSelected(b) }}>
                                        <Coins className="w-3.5 h-3.5" /> Buy
                                    </Button>
                                </div>
                            )
                        })}
                    </div>
                )}
            </div>

            <Card>
                <CardHeader className="pb-2">
                    <CardTitle className="text-base flex items-center gap-2"><History className="w-4 h-4 text-emerald-600" /> Credit history</CardTitle>
                </CardHeader>
                <CardContent>
                    {purchases.length === 0 ? (
                        <p className="py-6 text-center text-sm text-muted-foreground">No purchases yet.</p>
                    ) : (
                        <div className="divide-y">
                            {purchases.map((p) => (
                                <div key={p.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                                    <div>
                                        <p className="font-semibold">+{Number(p.credits).toLocaleString()} SMS</p>
                                        <p className="text-xs text-muted-foreground">{new Date(p.created_at).toLocaleString()}</p>
                                    </div>
                                    <div className="text-right">
                                        <p className="font-bold">GHS {Number(p.amount).toFixed(2)}</p>
                                        <p className={cn('text-[11px] font-semibold capitalize',
                                            p.status === 'completed' ? 'text-emerald-600' : p.status === 'failed' ? 'text-red-600' : 'text-amber-600')}>
                                            {p.status}
                                        </p>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </CardContent>
            </Card>

            <Dialog open={!!selected} onOpenChange={(o) => { if (!o) setSelected(null) }}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Buy {selected?.credits.toLocaleString()} SMS credits</DialogTitle>
                        <DialogDescription>GH₵{selected?.price.toFixed(2)} · ≈ GHS {selected?.pricePerSms.toFixed(3)} per SMS</DialogDescription>
                    </DialogHeader>
                    {selected && (
                        <SmsPaymentForm
                            key={selected.id}
                            endpoint="/api/sms/credits/purchase"
                            extraBody={{ bundleId: selected.id, portal: 'platform' }}
                            amount={selected.price}
                            payLabel="Buy credits"
                            isSettled={isSettled}
                            onSettled={onSettled}
                        />
                    )}
                </DialogContent>
            </Dialog>
        </div>
    )
}
