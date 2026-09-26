'use client'

/**
 * A shop's margin on utility bill payments.
 *
 * One percentage covers all five billers, unlike data where every package carries
 * its own price. A bill has no fixed amount — the customer types it — so the only
 * thing a shop can set is a rate, which is why this screen has one input rather
 * than a table.
 *
 * The ceiling is the part that needs explaining, and the reason this screen fetches
 * it rather than hardcoding 5. A customer never pays more than 5% over the face
 * value of their bill no matter who sold it, and the platform's fee plus every
 * upline's margin come out of that same 5%. So a Lead's ceiling and their sub's
 * ceiling differ, and a sub's ceiling MOVES when their Lead edits theirs. Showing a
 * flat 5% here would let someone set a number the save then rejects.
 */
import { useEffect, useState, useCallback } from 'react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Receipt, Loader2, AlertTriangle, Info } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'

interface ServiceRow {
    service: string
    label: string
    enabled: boolean
    platform_percent: number
    upline_percent: number
    max_percent: number
}

interface Payload {
    shop: { id: string; name: string }
    fee_percent: number
    utilities_enabled: boolean
    cap_percent: number
    available: boolean
    services: ServiceRow[]
}

const SAMPLE_BILL = 100

export default function ShopUtilityPricing({ backHref }: { backHref?: string }) {
    const [data, setData] = useState<Payload | null>(null)
    const [loading, setLoading] = useState(true)
    const [saving, setSaving] = useState(false)
    const [blocked, setBlocked] = useState<string | null>(null)

    const [fee, setFee] = useState('')
    const [enabled, setEnabled] = useState(false)

    const load = useCallback(async () => {
        try {
            const res = await fetch('/api/shop/utility-pricing')
            const json = await res.json()
            if (!res.ok) { setBlocked(json.error || 'Could not load bill payment settings'); return }
            setData(json)
            setFee(String(json.fee_percent ?? 0))
            setEnabled(json.utilities_enabled === true)
        } catch {
            setBlocked('Something went wrong')
        } finally {
            setLoading(false)
        }
    }, [])

    useEffect(() => { load() }, [load])

    // The binding constraint is the TIGHTEST service, because one rate covers them
    // all — a number that fits DSTV but not ECG is not a number this shop can use.
    const tightest = data?.services.reduce<ServiceRow | null>(
        (min, s) => (min === null || s.max_percent < min.max_percent ? s : min), null
    ) ?? null
    const maxPercent = tightest?.max_percent ?? 0

    const parsed = parseFloat(fee)
    const invalid = fee !== '' && (!Number.isFinite(parsed) || parsed < 0 || parsed > maxPercent)

    const save = async () => {
        if (invalid) {
            toast.error(`Your margin cannot exceed ${maxPercent.toFixed(2)}%`)
            return
        }
        setSaving(true)
        try {
            const res = await fetch('/api/shop/utility-pricing', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ fee_percent: parsed || 0, utilities_enabled: enabled }),
            })
            const json = await res.json()
            if (!res.ok) { toast.error(json.error || 'Could not save'); return }
            toast.success(enabled ? 'Bill payments are live on your storefront' : 'Saved')
            await load()
        } catch {
            toast.error('Something went wrong')
        } finally {
            setSaving(false)
        }
    }

    if (loading) return <div className="space-y-4 max-w-2xl"><Skeleton className="h-40 w-full" /><Skeleton className="h-64 w-full" /></div>

    if (blocked) {
        return (
            <Card className="max-w-2xl">
                <CardContent className="py-10 text-center text-sm text-muted-foreground">{blocked}</CardContent>
            </Card>
        )
    }

    const shopEarns = (parsed || 0) / 100 * SAMPLE_BILL
    const platformTakes = (tightest?.platform_percent ?? 0) / 100 * SAMPLE_BILL
    const uplineTakes = (tightest?.upline_percent ?? 0) / 100 * SAMPLE_BILL

    return (
        <div className="space-y-6 max-w-2xl">
            <div>
                <h1 className="text-2xl font-bold tracking-tight">Bill Payments</h1>
                <p className="text-muted-foreground text-sm mt-1">
                    Sell DSTV, GOtv, StarTimes, ECG and Ghana Water from your storefront.
                </p>
            </div>

            {!data?.available && (
                <div className="rounded-xl border border-amber-400/40 bg-amber-50/50 dark:bg-amber-900/10 p-3 text-xs text-amber-800 dark:text-amber-300 flex gap-2">
                    <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                    <span>
                        Bill payments are not open to customers yet. You can set your margin now —
                        the tab appears on your storefront as soon as they go live.
                    </span>
                </div>
            )}

            <Card>
                <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-base">
                        <Receipt className="w-4 h-4" /> Your margin
                    </CardTitle>
                    <CardDescription>
                        You keep this percentage of every bill your customers pay.
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-5">
                    <div className="flex items-center justify-between rounded-xl border border-border/60 p-3">
                        <div>
                            <p className="text-sm font-semibold">Show on my storefront</p>
                            <p className="text-xs text-muted-foreground">Customers can pay bills from your shop page.</p>
                        </div>
                        <Switch checked={enabled} onCheckedChange={setEnabled} />
                    </div>

                    <div>
                        <label className="text-sm font-medium">Margin (%)</label>
                        <div className="flex items-center gap-2 mt-1.5">
                            <Input
                                type="number"
                                step="0.1"
                                min={0}
                                max={maxPercent}
                                value={fee}
                                onChange={e => setFee(e.target.value)}
                                className={cn('w-32 text-right', invalid && 'border-red-400 focus-visible:ring-red-400')}
                            />
                            <span className="text-sm text-muted-foreground">
                                of the bill · max <strong className="text-foreground">{maxPercent.toFixed(2)}%</strong>
                            </span>
                        </div>
                        {invalid && (
                            <p className="text-xs text-red-600 dark:text-red-400 mt-2">
                                Enter a number between 0 and {maxPercent.toFixed(2)}.
                            </p>
                        )}
                    </div>

                    {/* Why the ceiling is what it is. Without this a shop sees an
                        arbitrary limit and assumes the platform is taking the rest. */}
                    <div className="rounded-xl bg-secondary/30 p-3 text-xs space-y-2">
                        <p className="flex items-center gap-1.5 font-semibold">
                            <Info className="w-3.5 h-3.5" /> On a GHS {SAMPLE_BILL} bill your customer pays
                        </p>
                        <div className="space-y-1 font-mono">
                            <div className="flex justify-between"><span>Bill</span><span>GHS {SAMPLE_BILL.toFixed(2)}</span></div>
                            <div className="flex justify-between text-muted-foreground">
                                <span>Platform fee ({(tightest?.platform_percent ?? 0).toFixed(2)}%)</span>
                                <span>GHS {platformTakes.toFixed(2)}</span>
                            </div>
                            {(tightest?.upline_percent ?? 0) > 0 && (
                                <div className="flex justify-between text-muted-foreground">
                                    <span>Your upline ({(tightest?.upline_percent ?? 0).toFixed(2)}%)</span>
                                    <span>GHS {uplineTakes.toFixed(2)}</span>
                                </div>
                            )}
                            <div className="flex justify-between text-emerald-600 dark:text-emerald-400 font-semibold">
                                <span>You keep ({(parsed || 0).toFixed(2)}%)</span>
                                <span>GHS {shopEarns.toFixed(2)}</span>
                            </div>
                            <div className="flex justify-between border-t border-border/60 pt-1 font-bold">
                                <span>Customer pays</span>
                                <span>GHS {(SAMPLE_BILL + platformTakes + uplineTakes + shopEarns).toFixed(2)}</span>
                            </div>
                        </div>
                        <p className="text-muted-foreground pt-1">
                            A customer never pays more than <strong>{data?.cap_percent ?? 5}%</strong> over the bill,
                            whoever sells it. The platform fee
                            {(tightest?.upline_percent ?? 0) > 0 ? ", your upline's share" : ''} and your margin
                            all come out of that same {data?.cap_percent ?? 5}%.
                        </p>
                    </div>

                    <div className="flex gap-2">
                        <Button onClick={save} disabled={saving || invalid} className="gap-2">
                            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                            Save
                        </Button>
                        {backHref && (
                            <Button variant="outline" onClick={() => { window.location.href = backHref }}>Back</Button>
                        )}
                    </div>
                </CardContent>
            </Card>

            <Card>
                <CardHeader className="pb-3">
                    <CardTitle className="text-base">Per biller</CardTitle>
                    <CardDescription>
                        Your one margin applies to all of them, so it is capped by whichever leaves least room.
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    <div className="space-y-2">
                        {data?.services.map(s => (
                            <div key={s.service} className="flex items-center justify-between rounded-lg border border-border/50 px-3 py-2 text-sm">
                                <div className="flex items-center gap-2">
                                    <span className="font-medium">{s.label}</span>
                                    {!s.enabled && (
                                        <span className="text-[10px] uppercase font-bold px-1.5 py-0.5 rounded bg-secondary text-muted-foreground">off</span>
                                    )}
                                    {tightest?.service === s.service && (
                                        <span className="text-[10px] uppercase font-bold px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
                                            your limit
                                        </span>
                                    )}
                                </div>
                                <span className="text-xs text-muted-foreground font-mono">
                                    platform {s.platform_percent.toFixed(2)}%
                                    {s.upline_percent > 0 ? ` · upline ${s.upline_percent.toFixed(2)}%` : ''}
                                    {' · '}you up to {s.max_percent.toFixed(2)}%
                                </span>
                            </div>
                        ))}
                    </div>
                </CardContent>
            </Card>
        </div>
    )
}
