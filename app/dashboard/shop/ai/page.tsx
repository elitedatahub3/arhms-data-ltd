'use client'

/**
 * Shop AI: the owner's storefront-assistant page (My Shop -> Shop AI).
 * Credits left, how they work, on/off switch, and credit packs paid from the wallet.
 */
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, Loader2, Sparkles, Wallet } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'

interface Info {
    hasShop: boolean
    adminOn: boolean
    enabled: boolean
    credits: { total: number; bought: number; freeLeft: number; freeMonthly: number }
    freePerVisitorDaily: number
    packs: { id: string; name: string; credits: number; price: number }[]
    walletBalance: number
    answersThisMonth: number
}

const newKey = () =>
    typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`

export default function ShopAiPage() {
    const [info, setInfo] = useState<Info | null>(null)
    const [loading, setLoading] = useState(true)
    const [buying, setBuying] = useState<string | null>(null)
    const [saving, setSaving] = useState(false)

    const load = useCallback(async () => {
        try {
            const res = await fetch('/api/ai-assistant/shop-settings', { cache: 'no-store' })
            if (res.ok) setInfo(await res.json())
        } catch {
            toast.error('Could not load Shop AI')
        } finally {
            setLoading(false)
        }
    }, [])

    useEffect(() => { load() }, [load])

    const buy = async (packId: string) => {
        setBuying(packId)
        try {
            const res = await fetch('/api/ai-assistant/shop-settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ packId, idempotencyKey: newKey() }),
            })
            const data = await res.json().catch(() => ({}))
            if (res.ok && data.ok) {
                toast.success(`${data.credits} credits added`)
                load()
            } else {
                toast.error(data.error || 'Payment failed. You were not charged.')
            }
        } finally {
            setBuying(null)
        }
    }

    const toggle = async (enabled: boolean) => {
        setSaving(true)
        try {
            const res = await fetch('/api/ai-assistant/shop-settings', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled }),
            })
            if (!res.ok) throw new Error()
            setInfo(i => (i ? { ...i, enabled } : i))
            toast.success(enabled ? 'Shop assistant switched on' : 'Shop assistant switched off')
        } catch {
            toast.error('Could not save')
        } finally {
            setSaving(false)
        }
    }

    return (
        <div className="mx-auto max-w-2xl space-y-5 pb-24">
            <Link href="/dashboard/shop" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
                <ArrowLeft className="h-4 w-4" /> Back to my shop
            </Link>

            <div className="flex items-center gap-4">
                <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                    <Sparkles className="h-7 w-7" />
                </div>
                <div>
                    <h1 className="text-2xl font-black tracking-tight">Shop assistant credits</h1>
                    <p className="text-sm text-muted-foreground">Help your customers get answers on your shop page.</p>
                </div>
            </div>

            {loading ? (
                <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
            ) : !info?.hasShop ? (
                <div className="rounded-2xl border border-border p-6 text-center text-sm text-muted-foreground">
                    You don&apos;t have a shop yet. <Link href="/dashboard/shop/setup" className="font-semibold text-primary">Set up your shop</Link> first.
                </div>
            ) : !info.adminOn ? (
                <div className="rounded-2xl border border-border p-6 text-center text-sm text-muted-foreground">
                    The shop assistant is not available yet. Check back soon.
                </div>
            ) : (
                <>
                    <div className="space-y-4 rounded-2xl border border-border bg-card p-6 shadow-sm">
                        <div className="flex items-start justify-between gap-3">
                            <h2 className="text-xl font-bold">Your credits</h2>
                            <label className="flex items-center gap-2 text-sm text-muted-foreground">
                                {info.enabled ? 'On' : 'Off'}
                                <Switch checked={info.enabled} disabled={saving} onCheckedChange={toggle} aria-label="Shop assistant on or off" />
                            </label>
                        </div>
                        <p className="text-sm leading-relaxed text-muted-foreground">
                            Every customer who visits your shop already gets {info.freePerVisitorDaily} free assistant answers each day.
                            When one of them has used their own, your credits pay for their next answers. With no credits, nothing
                            breaks: they simply wait until tomorrow.
                        </p>
                        <div>
                            <p className="text-5xl font-black">{info.credits.total.toLocaleString()}</p>
                            <p className="text-xs text-muted-foreground">credits left, shared by all your customers</p>
                        </div>
                        <div className="grid grid-cols-2 gap-3 text-sm">
                            <div className="rounded-xl bg-muted/50 p-3">
                                <p className="font-bold">{info.credits.freeLeft} / {info.credits.freeMonthly}</p>
                                <p className="text-xs text-muted-foreground">free this month (used first)</p>
                            </div>
                            <div className="rounded-xl bg-muted/50 p-3">
                                <p className="font-bold">{info.credits.bought.toLocaleString()}</p>
                                <p className="text-xs text-muted-foreground">bought (last until used up)</p>
                            </div>
                        </div>
                        <p className="text-xs text-muted-foreground">{info.answersThisMonth.toLocaleString()} answers given on your shop this month.</p>
                        {!info.enabled && (
                            <p className="rounded-xl bg-amber-50 p-3 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                                The assistant is switched off, so customers don&apos;t see it on your shop page.
                            </p>
                        )}
                    </div>

                    <div className="space-y-4 rounded-2xl border border-border bg-card p-6 shadow-sm">
                        <div className="flex items-start justify-between gap-3">
                            <div>
                                <h2 className="text-xl font-bold">Buy more</h2>
                                <p className="text-sm text-muted-foreground">Paid from your wallet. Buy any time. Bought credits last until they are used up, then buy another pack.</p>
                            </div>
                            <Link href="/dashboard/wallet" className="flex shrink-0 items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-xs font-semibold hover:bg-muted">
                                <Wallet className="h-3.5 w-3.5" /> GHS {info.walletBalance.toFixed(2)}
                            </Link>
                        </div>
                        <div className="space-y-3">
                            {info.packs.map(p => {
                                const short = info.walletBalance < p.price
                                return (
                                    <div key={p.id} className="flex items-center justify-between gap-3 rounded-2xl border border-border p-4">
                                        <div>
                                            <p className="font-bold">{p.name}</p>
                                            <p className="text-sm text-muted-foreground">{p.credits.toLocaleString()} credits</p>
                                        </div>
                                        {short ? (
                                            <Button asChild variant="outline" className="rounded-xl">
                                                <Link href={`/dashboard/wallet?amount=${Math.max(5, Math.ceil((p.price - info.walletBalance) * 100) / 100).toFixed(2)}`}>Top up to buy</Link>
                                            </Button>
                                        ) : (
                                            <Button onClick={() => buy(p.id)} disabled={!!buying} className="rounded-xl px-5 font-semibold">
                                                {buying === p.id ? <Loader2 className="h-4 w-4 animate-spin" /> : `Buy GH₵${p.price.toFixed(2)}`}
                                            </Button>
                                        )}
                                    </div>
                                )
                            })}
                        </div>
                    </div>
                </>
            )}
        </div>
    )
}
