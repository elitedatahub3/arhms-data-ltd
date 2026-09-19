'use client'

/**
 * Admin queue for Commission Wallet payouts.
 *
 * Deliberately narrower than /admin/shops/withdrawals: that screen also carries
 * sub-agent release/refund states this queue has no equivalent of. Three actions here —
 * pay by Moolre, record a manual payment, or reject and refund.
 */
import { useCallback, useEffect, useState } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Banknote, RefreshCw, Loader2, Send, Check, X } from 'lucide-react'
import { toast } from 'sonner'
import { formatDate, cn } from '@/lib/utils'

interface Withdrawal {
    id: string
    amount: number
    fee: number
    net_amount: number
    status: 'pending' | 'moolre_pending' | 'completed' | 'rejected'
    payment_type: 'momo' | 'bank'
    network: string | null
    momo_number: string | null
    account_number: string | null
    account_name: string | null
    bank_name: string | null
    branch: string | null
    admin_note: string | null
    created_at: string
    processed_at: string | null
    partner: { first_name: string | null; last_name: string | null; phone_number: string | null; email: string | null } | null
}

const STATUS: Record<Withdrawal['status'], { label: string; className: string }> = {
    pending:        { label: 'Pending',  className: 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300' },
    moolre_pending: { label: 'Sending',  className: 'bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300' },
    completed:      { label: 'Paid',     className: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300' },
    rejected:       { label: 'Rejected', className: 'bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300' },
}

const ghs = (n: number) => `GHS ${Number(n || 0).toFixed(2)}`

export default function AdminCommissionWithdrawalsPage() {
    const [rows, setRows] = useState<Withdrawal[]>([])
    const [loading, setLoading] = useState(true)
    const [status, setStatus] = useState('pending')
    const [busy, setBusy] = useState<string | null>(null)

    const load = useCallback(async () => {
        setLoading(true)
        try {
            const res = await fetch(`/api/admin/commission-withdrawals?status=${status}`, { cache: 'no-store' })
            const json = await res.json()
            if (!res.ok) throw new Error(json.error || 'Could not load payouts')
            setRows(json.withdrawals ?? [])
        } catch (e: any) {
            toast.error(e?.message || 'Could not load payouts')
        } finally {
            setLoading(false)
        }
    }, [status])

    useEffect(() => { load() }, [load])

    const act = async (w: Withdrawal, action: 'manual' | 'moolre' | 'reject') => {
        const payTo = w.momo_number || w.account_number || ''
        const confirmText = action === 'reject'
            ? `Reject this payout and return ${ghs(w.amount)} to the partner's wallet?`
            : action === 'manual'
                ? `Record ${ghs(w.net_amount)} as already paid to ${w.account_name} (${payTo})?`
                : `Send ${ghs(w.net_amount)} to ${w.account_name} (${payTo}) via Moolre now?`

        if (!window.confirm(confirmText)) return

        const note = action === 'reject'
            ? window.prompt('Reason (shown to the partner in their history):') || undefined
            : undefined

        setBusy(w.id)
        try {
            const res = await fetch('/api/admin/commission-withdrawals', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ withdrawalId: w.id, action, adminNote: note }),
            })
            const json = await res.json()
            if (!res.ok) {
                toast.error(json.error || 'Action failed')
                return
            }
            toast.success(
                json.status === 'completed' ? 'Marked as paid'
                    : json.status === 'rejected' ? 'Rejected and refunded'
                        : 'Sent to Moolre — the sync cron will confirm it'
            )
            await load()
        } catch {
            toast.error('Something went wrong')
        } finally {
            setBusy(null)
        }
    }

    return (
        <div className="space-y-6 max-w-5xl">
            <div className="flex items-start justify-between gap-3">
                <div>
                    <h1 className="text-2xl font-bold tracking-tight">Commission Payouts</h1>
                    <p className="text-muted-foreground text-sm mt-1">
                        Withdrawal requests from API partners' Commission Wallets.
                    </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                    <Select value={status} onValueChange={setStatus}>
                        <SelectTrigger className="w-[150px] h-9"><SelectValue /></SelectTrigger>
                        <SelectContent>
                            <SelectItem value="pending">Pending</SelectItem>
                            <SelectItem value="moolre_pending">Sending</SelectItem>
                            <SelectItem value="completed">Paid</SelectItem>
                            <SelectItem value="rejected">Rejected</SelectItem>
                            <SelectItem value="all">All</SelectItem>
                        </SelectContent>
                    </Select>
                    <Button variant="outline" size="sm" onClick={load} disabled={loading}>
                        <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />
                    </Button>
                </div>
            </div>

            {loading && rows.length === 0 ? (
                <div className="space-y-2">{[0, 1, 2].map(i => <Skeleton key={i} className="h-28 w-full" />)}</div>
            ) : rows.length === 0 ? (
                <Card>
                    <CardContent className="py-12 text-center">
                        <Banknote className="w-10 h-10 mx-auto text-muted-foreground/50 mb-3" />
                        <p className="font-medium">Nothing here</p>
                        <p className="text-sm text-muted-foreground mt-1">No payout requests with this status.</p>
                    </CardContent>
                </Card>
            ) : (
                <div className="space-y-3">
                    {rows.map(w => {
                        const payTo = w.momo_number || w.account_number || ''
                        const name = [w.partner?.first_name, w.partner?.last_name].filter(Boolean).join(' ') || 'Partner'
                        return (
                            <Card key={w.id}>
                                <CardHeader className="pb-3">
                                    <div className="flex items-start justify-between gap-3">
                                        <div className="min-w-0">
                                            <CardTitle className="text-base">
                                                {ghs(w.net_amount)}
                                                {w.fee > 0 && (
                                                    <span className="text-xs font-normal text-muted-foreground">
                                                        {' '}(of {ghs(w.amount)}, fee {ghs(w.fee)})
                                                    </span>
                                                )}
                                            </CardTitle>
                                            <CardDescription className="mt-1">
                                                {name}{w.partner?.phone_number ? ` · ${w.partner.phone_number}` : ''}
                                                {' · '}{formatDate(w.created_at)}
                                            </CardDescription>
                                        </div>
                                        <span className={cn('shrink-0 text-[10px] font-bold uppercase px-2 py-1 rounded', STATUS[w.status].className)}>
                                            {STATUS[w.status].label}
                                        </span>
                                    </div>
                                </CardHeader>
                                <CardContent className="space-y-3">
                                    <div className="rounded-xl bg-muted/40 p-3 text-sm">
                                        <div className="flex justify-between gap-3">
                                            <span className="text-muted-foreground">Pay to</span>
                                            <span className="font-semibold text-right">{w.account_name}</span>
                                        </div>
                                        <div className="flex justify-between gap-3 mt-1">
                                            <span className="text-muted-foreground">
                                                {w.payment_type === 'bank' ? (w.bank_name || 'Bank') : (w.network || 'MoMo')}
                                            </span>
                                            <span className="font-mono">{payTo}</span>
                                        </div>
                                        {w.branch && (
                                            <div className="flex justify-between gap-3 mt-1">
                                                <span className="text-muted-foreground">Branch</span><span>{w.branch}</span>
                                            </div>
                                        )}
                                        {w.admin_note && (
                                            <p className="text-xs text-muted-foreground mt-2">Note: {w.admin_note}</p>
                                        )}
                                    </div>

                                    {(w.status === 'pending' || w.status === 'moolre_pending') && (
                                        <div className="flex flex-wrap gap-2">
                                            {w.status === 'pending' && (
                                                <Button size="sm" disabled={busy === w.id} onClick={() => act(w, 'moolre')}>
                                                    {busy === w.id
                                                        ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                                                        : <Send className="w-3.5 h-3.5 mr-1.5" />}
                                                    Pay via Moolre
                                                </Button>
                                            )}
                                            <Button size="sm" variant="outline" disabled={busy === w.id} onClick={() => act(w, 'manual')}>
                                                <Check className="w-3.5 h-3.5 mr-1.5" /> Mark paid manually
                                            </Button>
                                            {w.status === 'pending' && (
                                                <Button
                                                    size="sm"
                                                    variant="outline"
                                                    className="text-red-600 hover:text-red-600"
                                                    disabled={busy === w.id}
                                                    onClick={() => act(w, 'reject')}
                                                >
                                                    <X className="w-3.5 h-3.5 mr-1.5" /> Reject & refund
                                                </Button>
                                            )}
                                        </div>
                                    )}
                                </CardContent>
                            </Card>
                        )
                    })}
                </div>
            )}
        </div>
    )
}
