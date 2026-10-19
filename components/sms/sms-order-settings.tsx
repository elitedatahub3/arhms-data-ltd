'use client'

/**
 * Automatic order confirmations.
 *
 * Switched on, every storefront data or airtime order texts the buyer from the
 * shop's own sender ID and costs the shop a credit. Switched off, nothing is
 * sent at all — so the copy has to say that plainly rather than implying ARHMS
 * still covers it.
 */

import { useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { Loader2, Wifi, Phone, Info, AlertTriangle } from 'lucide-react'
import { toast } from 'sonner'
import { smsFetch } from '@/lib/sms/sms-fetch'

export function SmsOrderSettings({
    dataEnabled,
    airtimeEnabled,
    credits,
    hasOwnSender,
    lastSkip,
    lastSkipAt,
    onChanged,
    onNeedSender,
}: {
    dataEnabled: boolean
    airtimeEnabled: boolean
    credits: number
    hasOwnSender: boolean
    /** Why the most recent confirmation did not send, if one did not. */
    lastSkip?: string | null
    lastSkipAt?: string | null
    onChanged: () => void
    onNeedSender: () => void
}) {
    const [saving, setSaving] = useState<'data' | 'airtime' | null>(null)

    const save = async (kind: 'data' | 'airtime', value: boolean) => {
        if (!hasOwnSender) {
            toast.error('You need an approved sender ID first')
            onNeedSender()
            return
        }
        setSaving(kind)
        try {
            const res = await smsFetch('/api/sms/account', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ [kind]: value }),
            })
            const data = await res.json()
            if (!res.ok || !data?.success) {
                toast.error(data?.error || 'Could not save that setting')
                return
            }
            toast.success(value
                ? `${kind === 'data' ? 'Data' : 'Airtime'} order confirmations are ON`
                : `${kind === 'data' ? 'Data' : 'Airtime'} order confirmations are OFF`)
            onChanged()
        } catch {
            toast.error('Something went wrong. Please try again.')
        } finally {
            setSaving(null)
        }
    }

    const rows = [
        {
            kind: 'data' as const,
            icon: Wifi,
            label: 'Data orders',
            body: 'Texts the buyer when their data order reaches the supplier.',
            value: dataEnabled,
        },
        {
            kind: 'airtime' as const,
            icon: Phone,
            label: 'Airtime orders',
            body: 'Texts the buyer once the airtime has been sent.',
            value: airtimeEnabled,
        },
    ]

    return (
        <div className="space-y-4">
            <Card>
                <CardHeader>
                    <CardTitle className="text-base">Automatic order confirmations</CardTitle>
                    <CardDescription>
                        Text your customers automatically when they buy from your storefront — from your own
                        sender ID, so they know it came from you.
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                    {rows.map((row) => (
                        <div key={row.kind} className="flex items-start justify-between gap-3 rounded-xl border p-3">
                            <div className="flex gap-3 min-w-0">
                                <row.icon className="w-5 h-5 text-emerald-600 mt-0.5 shrink-0" />
                                <div className="min-w-0">
                                    <p className="font-semibold text-sm">{row.label}</p>
                                    <p className="text-xs text-muted-foreground">{row.body}</p>
                                    <p className="text-[11px] text-muted-foreground mt-0.5">Costs 1 SMS credit per order.</p>
                                </div>
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                                {saving === row.kind && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />}
                                <Switch
                                    checked={row.value}
                                    disabled={saving !== null || !hasOwnSender}
                                    onCheckedChange={(v) => save(row.kind, v)}
                                    aria-label={row.label}
                                />
                            </div>
                        </div>
                    ))}

                    {lastSkip && (
                        <div className="flex gap-2 rounded-xl border border-red-300 bg-red-50 dark:bg-red-950/30 p-3 text-xs">
                            <AlertTriangle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
                            <p>
                                <span className="font-semibold">Your last order did not send an SMS.</span> {lastSkip}
                                {lastSkipAt && (
                                    <span className="text-muted-foreground">
                                        {" "}({new Date(lastSkipAt).toLocaleString('en-GH', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })})
                                    </span>
                                )}
                            </p>
                        </div>
                    )}

                    {!hasOwnSender && (
                        <div className="flex gap-2 rounded-xl bg-amber-50 dark:bg-amber-950/30 p-3 text-xs">
                            <Info className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                            <p>
                                You need an approved sender ID before this can be switched on — otherwise your
                                customers would not know who the message is from.{' '}
                                <button type="button" onClick={onNeedSender} className="underline font-semibold">
                                    Request one
                                </button>
                            </p>
                        </div>
                    )}

                    {hasOwnSender && (dataEnabled || airtimeEnabled) && credits < 20 && (
                        <div className="flex gap-2 rounded-xl bg-amber-50 dark:bg-amber-950/30 p-3 text-xs">
                            <Info className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                            <p>
                                Only <span className="font-bold">{credits}</span> credits left. When they run out your
                                customers stop getting confirmations — your orders still go through as normal.
                            </p>
                        </div>
                    )}

                    <p className="text-[11px] text-muted-foreground">
                        With these off, buyers get no order SMS at all. Every confirmation is also listed under
                        History, so you can see exactly what was sent and what it cost.
                    </p>
                </CardContent>
            </Card>

            <Card>
                <CardHeader className="pb-2">
                    <CardTitle className="text-sm">What your customer sees</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                    <div className="rounded-2xl bg-muted p-3 text-sm">
                        <Badge variant="outline" className="mb-1.5 text-[10px]">Data</Badge>
                        <p>Hi! Your MTN 5GB order has been received and is being processed. Thank you for buying from your shop.</p>
                    </div>
                    <div className="rounded-2xl bg-muted p-3 text-sm">
                        <Badge variant="outline" className="mb-1.5 text-[10px]">Airtime</Badge>
                        <p>Hi! GHS 10.00 MTN airtime has been sent to 0551234567. Thank you for buying from your shop.</p>
                    </div>
                </CardContent>
            </Card>
        </div>
    )
}
