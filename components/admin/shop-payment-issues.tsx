'use client'

import { useCallback, useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { toast } from 'sonner'

type Issue = {
    reference: string
    provider: string | null
    slug: string | null
    attempts: number
    lastError: string | null
    createdAt: string
    lastCheckedAt: string | null
    shopName: string | null
    guestPhone: string | null
    payerPhone: string | null
    item: string | null
    price: number | null
}

/**
 * Storefront payments that were paid but never became an order.
 *
 * Renders nothing when there is nothing to act on, so it costs the payments page
 * no space on a good day.
 */
export function ShopPaymentIssues() {
    const [issues, setIssues] = useState<Issue[]>([])
    const [stalePending, setStalePending] = useState(0)
    const [migrated, setMigrated] = useState(true)
    const [busy, setBusy] = useState<string | null>(null)

    const load = useCallback(async () => {
        try {
            const res = await fetch('/api/admin/shop-payment-issues', { cache: 'no-store' })
            const data = await res.json()
            if (!res.ok) return
            setIssues(data.issues || [])
            setStalePending(data.stalePending || 0)
            setMigrated(data.migrated !== false)
        } catch {
            /* the main page still works without this panel */
        }
    }, [])

    useEffect(() => { load() }, [load])

    const act = async (reference: string, action: 'retry' | 'resolve') => {
        let note: string | undefined
        if (action === 'resolve') {
            const entered = window.prompt('How was this resolved? (e.g. "refunded via MoMo", "delivered manually")')
            if (entered === null) return
            note = entered
        }
        setBusy(reference)
        try {
            const res = await fetch('/api/admin/shop-payment-issues', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ reference, action, note }),
            })
            const data = await res.json()
            if (action === 'resolve') {
                if (res.ok) toast.success('Marked resolved')
                else toast.error(data.error || 'Could not update')
            } else if (data.success) {
                toast.success('Order created')
            } else {
                toast.error(`Not settled: ${data.detail || data.outcome || data.error || 'unknown'}`)
            }
        } catch {
            toast.error('Network error')
        } finally {
            setBusy(null)
            load()
        }
    }

    if (!migrated) {
        return (
            <Card className="border-amber-300">
                <CardContent className="py-3 text-sm text-amber-700">
                    Storefront payment ledger not set up yet. Run migration
                    <code className="mx-1">20261013000000_shop_payment_ledger.sql</code>
                    to see paid storefront payments that did not become orders.
                </CardContent>
            </Card>
        )
    }

    if (issues.length === 0 && stalePending === 0) return null

    return (
        <Card className="border-red-300 dark:border-red-800">
            <CardHeader className="space-y-1 pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                    Storefront: paid, no order
                    {issues.length > 0 && <Badge variant="destructive">{issues.length}</Badge>}
                </CardTitle>
                <p className="text-sm text-muted-foreground">
                    The buyer paid but the order could not be created. Retry once the cause is
                    fixed (e.g. a missing price), or refund / deliver by hand and mark it resolved.
                </p>
                {stalePending > 0 && (
                    <p className="text-sm font-medium text-amber-700">
                        {stalePending} storefront payment{stalePending === 1 ? ' is' : 's are'} still pending after 90 minutes.
                        Check that verify-paystack-momo-payments is running at cron-job.org.
                    </p>
                )}
            </CardHeader>
            {issues.length > 0 && (
                <CardContent className="space-y-3">
                    {issues.map((i) => (
                        <div key={i.reference} className="rounded-md border p-3 text-sm space-y-1">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                                <span className="font-mono font-semibold break-all">{i.reference}</span>
                                <span className="text-xs text-muted-foreground">
                                    {new Date(i.createdAt).toLocaleString()} · {i.provider ?? 'unknown rail'} · {i.attempts} attempt{i.attempts === 1 ? '' : 's'}
                                </span>
                            </div>
                            <div className="text-muted-foreground">
                                {i.shopName ?? i.slug ?? 'Unknown shop'} · {i.item ?? 'item unknown'}
                                {i.price != null && <> · GHS {Number(i.price).toFixed(2)}</>}
                                {i.guestPhone && <> · to {i.guestPhone}</>}
                                {i.payerPhone && i.payerPhone !== i.guestPhone && <> · paid by {i.payerPhone}</>}
                            </div>
                            {i.lastError && <div className="text-red-600">{i.lastError}</div>}
                            <div className="flex gap-2 pt-1">
                                <Button size="sm" disabled={busy === i.reference} onClick={() => act(i.reference, 'retry')}>
                                    {busy === i.reference ? 'Working…' : 'Retry settle'}
                                </Button>
                                <Button size="sm" variant="outline" disabled={busy === i.reference} onClick={() => act(i.reference, 'resolve')}>
                                    Mark resolved
                                </Button>
                            </div>
                        </div>
                    ))}
                </CardContent>
            )}
        </Card>
    )
}
