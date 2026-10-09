'use client'

/**
 * Admin: SMS Platform business registrations.
 *
 * An owner registers their business from /dashboard/sms/business and sends
 * their Ghana Card and certificate over WhatsApp. Approving here puts their
 * account in Business Mode (higher daily limit, links allowed, more sender IDs);
 * rejecting sends them the reason so they can fix it and resubmit.
 */

import { useCallback, useEffect, useState } from 'react'
import { Building2, Check, X, Globe, MessageCircle, Loader2, RefreshCw, User } from 'lucide-react'
import { toast } from 'sonner'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Skeleton } from '@/components/ui/skeleton'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'

type Status = 'pending' | 'approved' | 'rejected' | 'draft'

interface Registration {
    id: string
    business_name: string
    description: string
    domain: string | null
    whatsapp: string | null
    status: Status
    rejection_reason: string | null
    submitted_at: string | null
    reviewed_at: string | null
    ghana_card_masked: string | null
    account: { id: string; mode: string; credits: number; status: string }
    owner: { first_name: string | null; last_name: string | null; email: string | null; phone_number: string | null; role: string } | null
}

const FILTERS: { id: Status; label: string }[] = [
    { id: 'pending', label: 'Pending' },
    { id: 'approved', label: 'Approved' },
    { id: 'rejected', label: 'Rejected' },
    { id: 'draft', label: 'Drafts' },
]

export default function AdminSmsBusinessesPage() {
    const [status, setStatus] = useState<Status>('pending')
    const [rows, setRows] = useState<Registration[]>([])
    const [counts, setCounts] = useState<Record<string, number>>({})
    const [loading, setLoading] = useState(true)
    const [busyId, setBusyId] = useState<string | null>(null)
    const [rejecting, setRejecting] = useState<Registration | null>(null)
    const [reason, setReason] = useState('')

    const load = useCallback(async () => {
        setLoading(true)
        try {
            const res = await fetch(`/api/admin/sms-businesses?status=${status}`, { cache: 'no-store' })
            const data = await res.json()
            if (!res.ok || !data?.success) { toast.error(data?.error || 'Could not load registrations'); return }
            setRows(data.businesses)
            setCounts(data.counts || {})
        } catch {
            toast.error('Could not load registrations')
        } finally {
            setLoading(false)
        }
    }, [status])

    useEffect(() => { load() }, [load])

    const decide = async (row: Registration, action: 'approve' | 'reject', why?: string) => {
        setBusyId(row.id)
        try {
            const res = await fetch('/api/admin/sms-businesses', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: row.id, action, reason: why }),
            })
            const data = await res.json()
            if (!res.ok || !data?.success) { toast.error(data?.error || 'Could not save'); return }
            toast.success(action === 'approve' ? `${row.business_name} approved — Business Mode on` : 'Rejected; the owner has been told why')
            setRejecting(null)
            setReason('')
            load()
        } finally {
            setBusyId(null)
        }
    }

    return (
        <div className="space-y-6 p-4 md:p-6 max-w-5xl">
            <div className="flex items-start justify-between gap-2">
                <div>
                    <h1 className="text-2xl font-black flex items-center gap-2"><Building2 className="w-6 h-6" /> SMS Businesses</h1>
                    <p className="text-sm text-muted-foreground">Verify business registrations for the SMS Platform. Check the documents sent on WhatsApp before approving.</p>
                </div>
                <Button variant="outline" size="sm" className="gap-1" onClick={load}><RefreshCw className="w-3.5 h-3.5" /> Refresh</Button>
            </div>

            <div className="flex flex-wrap gap-2">
                {FILTERS.map((f) => (
                    <button key={f.id} type="button" onClick={() => setStatus(f.id)}
                        className={cn('rounded-full border px-3 py-1 text-sm font-semibold transition-colors',
                            status === f.id ? 'border-emerald-600 bg-emerald-600 text-white' : 'hover:bg-muted')}>
                        {f.label}{counts[f.id] ? ` · ${counts[f.id]}` : ''}
                    </button>
                ))}
            </div>

            {loading ? (
                <div className="space-y-3"><Skeleton className="h-40 w-full" /><Skeleton className="h-40 w-full" /></div>
            ) : rows.length === 0 ? (
                <Card><CardContent className="py-12 text-center text-sm text-muted-foreground">Nothing here.</CardContent></Card>
            ) : (
                <div className="space-y-3">
                    {rows.map((r) => {
                        const ownerName = [r.owner?.first_name, r.owner?.last_name].filter(Boolean).join(' ') || 'Unknown owner'
                        return (
                            <Card key={r.id}>
                                <CardContent className="p-4 space-y-3">
                                    <div className="flex flex-wrap items-start justify-between gap-2">
                                        <div>
                                            <p className="text-lg font-black">{r.business_name}</p>
                                            <p className="text-xs text-muted-foreground flex items-center gap-1">
                                                <User className="w-3 h-3" /> {ownerName} · {r.owner?.role} · {r.owner?.phone_number || r.owner?.email}
                                            </p>
                                        </div>
                                        <div className="text-right text-xs text-muted-foreground">
                                            {r.submitted_at && <p>Submitted {new Date(r.submitted_at).toLocaleString()}</p>}
                                            <p>Account: {r.account?.mode} mode · {r.account?.credits ?? 0} credits</p>
                                        </div>
                                    </div>

                                    <p className="text-sm whitespace-pre-wrap rounded-xl bg-muted/50 p-3">{r.description || '—'}</p>

                                    <div className="grid gap-2 text-sm sm:grid-cols-3">
                                        <p className="flex items-center gap-1.5 min-w-0">
                                            <Globe className="w-4 h-4 shrink-0 text-muted-foreground" />
                                            {r.domain
                                                ? <a href={`https://${r.domain}`} target="_blank" rel="noopener noreferrer" className="truncate text-emerald-700 hover:underline dark:text-emerald-400">{r.domain}</a>
                                                : '—'}
                                        </p>
                                        <p className="font-mono">{r.ghana_card_masked || 'No Ghana Card'}</p>
                                        <p className="flex items-center gap-1.5">
                                            <MessageCircle className="w-4 h-4 text-muted-foreground" />
                                            {r.whatsapp
                                                ? <a href={`https://wa.me/${r.whatsapp}`} target="_blank" rel="noopener noreferrer" className="font-mono text-emerald-700 hover:underline dark:text-emerald-400">{r.whatsapp}</a>
                                                : '—'}
                                        </p>
                                    </div>

                                    {r.status === 'rejected' && r.rejection_reason && (
                                        <p className="text-xs text-red-600">Rejected: {r.rejection_reason}</p>
                                    )}

                                    {r.status === 'pending' && (
                                        <div className="flex gap-2">
                                            <Button size="sm" className="gap-1 bg-emerald-600 hover:bg-emerald-700" disabled={busyId === r.id}
                                                onClick={() => decide(r, 'approve')}>
                                                {busyId === r.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />} Approve
                                            </Button>
                                            <Button size="sm" variant="outline" className="gap-1 text-red-600" disabled={busyId === r.id}
                                                onClick={() => { setRejecting(r); setReason('') }}>
                                                <X className="w-3.5 h-3.5" /> Reject
                                            </Button>
                                        </div>
                                    )}
                                </CardContent>
                            </Card>
                        )
                    })}
                </div>
            )}

            <Dialog open={!!rejecting} onOpenChange={(o) => { if (!o) setRejecting(null) }}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Reject {rejecting?.business_name}?</DialogTitle>
                        <DialogDescription>The owner sees this reason and can fix their registration and submit again.</DialogDescription>
                    </DialogHeader>
                    <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. The Ghana Card name does not match the business owner." />
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setRejecting(null)}>Cancel</Button>
                        <Button className="bg-red-600 hover:bg-red-700" disabled={reason.trim().length < 3 || busyId === rejecting?.id}
                            onClick={() => rejecting && decide(rejecting, 'reject', reason.trim())}>
                            Reject
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    )
}
