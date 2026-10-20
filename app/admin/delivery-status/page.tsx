'use client'

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Activity, Loader2 } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Skeleton } from '@/components/ui/skeleton'
import { DeliveryStatusCard } from '@/components/delivery/DeliveryStatusCard'
import { formatDuration, tierText, type ChannelEstimate, type DeliverySignal } from '@/lib/delivery-estimate'

interface Row {
    signal: DeliverySignal
    estimate: ChannelEstimate
}

function stamp(iso: string | null): string {
    return iso ? new Date(iso).toLocaleString() : '—'
}

function ChannelControl({ row, onSaved }: { row: Row; onSaved: () => void }) {
    const { signal, estimate } = row
    const [reason, setReason] = useState(signal.downReason ?? '')
    const [saving, setSaving] = useState(false)

    const save = async (isManuallyDown: boolean) => {
        setSaving(true)
        try {
            const res = await fetch('/api/admin/delivery-status', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ channel: signal.channel, isManuallyDown, reason }),
            })
            const json = await res.json().catch(() => ({}))
            if (!res.ok) throw new Error(json.error || 'Save failed')
            toast.success(isManuallyDown ? `${signal.channel} marked down` : `${signal.channel} back to live`)
            onSaved()
        } catch (e: any) {
            toast.error(e.message)
        } finally {
            setSaving(false)
        }
    }

    return (
        <div className="space-y-3 rounded-xl border border-border/60 p-4">
            <div className="flex items-center justify-between gap-3">
                <div>
                    <p className="font-bold">{signal.channel}</p>
                    <p className="text-xs text-muted-foreground">
                        {tierText(estimate)}
                        {estimate.state === 'live' && ` · ${estimate.percent}% · last ${formatDuration(estimate.lastTook)} · now ${formatDuration(estimate.current)}`}
                    </p>
                </div>
                <div className="flex items-center gap-2">
                    {saving && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
                    <span className="text-xs font-semibold text-muted-foreground">Mark down</span>
                    <Switch checked={signal.isManuallyDown} disabled={saving} onCheckedChange={(v) => save(v)} />
                </div>
            </div>
            <div className="flex gap-2">
                <Input
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    maxLength={120}
                    placeholder="Reason shown to customers (optional)"
                    className="h-9 text-sm"
                />
                {signal.isManuallyDown && (
                    <Button size="sm" variant="outline" disabled={saving} onClick={() => save(true)}>
                        Save
                    </Button>
                )}
            </div>
            <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-[11px] text-muted-foreground sm:grid-cols-2">
                <div><dt className="inline font-semibold">C placed: </dt><dd className="inline">{stamp(signal.cCreatedAt)}</dd></div>
                <div><dt className="inline font-semibold">C delivered: </dt><dd className="inline">{stamp(signal.cDeliveredAt)}</dd></div>
                <div><dt className="inline font-semibold">P placed (oldest open after C): </dt><dd className="inline">{stamp(signal.pCreatedAt)}</dd></div>
                {signal.isManuallyDown && (
                    <div><dt className="inline font-semibold">Down since: </dt><dd className="inline">{stamp(signal.downSince)}</dd></div>
                )}
            </dl>
        </div>
    )
}

export default function AdminDeliveryStatusPage() {
    const [rows, setRows] = useState<Row[] | null>(null)
    const [error, setError] = useState<string | null>(null)

    const load = useCallback(async () => {
        try {
            const res = await fetch('/api/admin/delivery-status', { cache: 'no-store' })
            const json = await res.json()
            if (!res.ok) throw new Error(json.error || 'Failed to load')
            setRows(json.channels)
            setError(null)
        } catch (e: any) {
            setError(e.message)
        }
    }, [])

    useEffect(() => {
        load()
    }, [load])

    return (
        <div className="mx-auto max-w-5xl space-y-6 p-4 md:p-6">
            <div>
                <h1 className="flex items-center gap-2 text-2xl font-black tracking-tight">
                    <Activity className="h-6 w-6" /> Delivery Status
                </h1>
                <p className="text-sm text-muted-foreground">
                    The live estimate customers see on the dashboard, storefronts and buy-confirm screens. Marking a
                    channel down freezes its numbers, empties its bar and shows &ldquo;Experiencing delays&rdquo;.
                </p>
            </div>

            <div className="grid gap-6 lg:grid-cols-5">
                <div className="lg:col-span-2">
                    <DeliveryStatusCard />
                </div>
                <Card className="lg:col-span-3">
                    <CardHeader>
                        <CardTitle className="text-base">Channels</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                        {error && <p className="text-sm text-rose-500">{error}</p>}
                        {!rows && !error && [0, 1, 2].map((i) => <Skeleton key={i} className="h-28 w-full rounded-xl" />)}
                        {rows?.map((row) => (
                            <ChannelControl
                                key={`${row.signal.channel}-${row.signal.isManuallyDown}`}
                                row={row}
                                onSaved={load}
                            />
                        ))}
                    </CardContent>
                </Card>
            </div>
        </div>
    )
}
