'use client'

/**
 * Past sends and, for one of them, who it reached.
 *
 * Delivery reports arrive from the networks minutes after a send, so an open
 * campaign that is still moving refreshes itself rather than asking the owner
 * to keep reloading.
 */

import { useCallback, useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { ArrowLeft, RefreshCw, History } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { formatGhanaPhone } from '@/components/sms/sms-contacts'

interface Campaign {
    id: string
    message: string
    status: 'queued' | 'processing' | 'completed' | 'failed' | 'blocked'
    recipients_count: number
    segments: number
    credits_charged: number
    sender_used: string
    created_at: string
    completed_at: string | null
}

interface MessageRow {
    recipient: string
    status: string
    error: string | null
    status_updated_at: string | null
}

const STATUS_CLASS: Record<string, string> = {
    queued: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
    sending: 'bg-blue-100 text-blue-800 dark:bg-blue-950/40 dark:text-blue-300',
    processing: 'bg-blue-100 text-blue-800 dark:bg-blue-950/40 dark:text-blue-300',
    sent: 'bg-blue-100 text-blue-800 dark:bg-blue-950/40 dark:text-blue-300',
    delivered: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300',
    completed: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300',
    undelivered: 'bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300',
    expired: 'bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300',
    failed: 'bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-300',
    rejected: 'bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-300',
    blocked: 'bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-300',
}

function StatusPill({ status }: { status: string }) {
    return (
        <span className={cn('inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold capitalize', STATUS_CLASS[status] || STATUS_CLASS.queued)}>
            {status}
        </span>
    )
}

const formatDate = (iso: string) =>
    new Date(iso).toLocaleString('en-GH', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

export function SmsHistory({ openCampaignId, onOpen }: { openCampaignId: string | null; onOpen: (id: string | null) => void }) {
    if (openCampaignId) return <CampaignDetail id={openCampaignId} onBack={() => onOpen(null)} />
    return <CampaignList onOpen={onOpen} />
}

function CampaignList({ onOpen }: { onOpen: (id: string) => void }) {
    const [campaigns, setCampaigns] = useState<Campaign[]>([])
    const [total, setTotal] = useState(0)
    const [page, setPage] = useState(0)
    const [loading, setLoading] = useState(true)

    useEffect(() => {
        (async () => {
            setLoading(true)
            try {
                const res = await fetch(`/api/sms/campaigns?page=${page}`, { cache: 'no-store' })
                const data = await res.json()
                if (data?.success) { setCampaigns(data.campaigns); setTotal(data.total) }
                else toast.error(data?.error || 'Could not load your sends')
            } catch {
                toast.error('Could not load your sends')
            } finally {
                setLoading(false)
            }
        })()
    }, [page])

    const pages = Math.max(1, Math.ceil(total / 30))

    return (
        <Card>
            <CardHeader><CardTitle className="text-base flex items-center gap-2"><History className="w-4 h-4" /> Sent messages</CardTitle></CardHeader>
            <CardContent className="space-y-3">
                {loading ? (
                    <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-16 w-full" />)}</div>
                ) : campaigns.length === 0 ? (
                    <p className="text-sm text-muted-foreground text-center py-8">Nothing sent yet.</p>
                ) : (
                    <div className="divide-y rounded-xl border">
                        {campaigns.map((c) => (
                            <button key={c.id} type="button" onClick={() => onOpen(c.id)} className="w-full text-left p-3 hover:bg-muted/50 space-y-1">
                                <div className="flex items-center justify-between gap-2">
                                    <span className="text-xs text-muted-foreground">{formatDate(c.created_at)} · {c.sender_used}</span>
                                    <StatusPill status={c.status} />
                                </div>
                                <p className="text-sm line-clamp-2">{c.message}</p>
                                <p className="text-xs text-muted-foreground">
                                    {c.recipients_count.toLocaleString()} recipient{c.recipients_count === 1 ? '' : 's'} · {c.credits_charged.toLocaleString()} credits
                                </p>
                            </button>
                        ))}
                    </div>
                )}
                {pages > 1 && (
                    <div className="flex items-center justify-between text-sm">
                        <Button size="sm" variant="outline" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Newer</Button>
                        <span className="text-muted-foreground">Page {page + 1} of {pages}</span>
                        <Button size="sm" variant="outline" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>Older</Button>
                    </div>
                )}
            </CardContent>
        </Card>
    )
}

function CampaignDetail({ id, onBack }: { id: string; onBack: () => void }) {
    const [campaign, setCampaign] = useState<Campaign | null>(null)
    const [delivery, setDelivery] = useState<Record<string, number>>({})
    const [messages, setMessages] = useState<MessageRow[]>([])
    const [page, setPage] = useState(0)
    const [filter, setFilter] = useState<string | null>(null)
    const [loading, setLoading] = useState(true)

    const load = useCallback(async () => {
        try {
            const params = new URLSearchParams({ page: String(page) })
            if (filter) params.set('status', filter)
            const res = await fetch(`/api/sms/campaigns/${id}?${params}`, { cache: 'no-store' })
            const data = await res.json()
            if (data?.success) {
                setCampaign(data.campaign)
                setDelivery(data.delivery || {})
                setMessages(data.messages || [])
            } else {
                toast.error(data?.error || 'Could not load that send')
            }
        } catch {
            toast.error('Could not load that send')
        } finally {
            setLoading(false)
        }
    }, [id, page, filter])

    useEffect(() => { load() }, [load])

    // Keep refreshing while anything can still change.
    const inFlight = campaign && (['queued', 'processing'].includes(campaign.status) || (delivery.queued ?? 0) + (delivery.sending ?? 0) + (delivery.sent ?? 0) > 0)
    useEffect(() => {
        if (!inFlight) return
        const t = setInterval(load, 15000)
        return () => clearInterval(t)
    }, [inFlight, load])

    if (loading || !campaign) return <Skeleton className="h-64 w-full rounded-2xl" />

    return (
        <div className="space-y-4">
            <div className="flex items-center justify-between">
                <Button variant="ghost" className="gap-2" onClick={onBack}><ArrowLeft className="w-4 h-4" /> All sends</Button>
                <Button variant="outline" size="sm" className="gap-1" onClick={load}><RefreshCw className="w-3.5 h-3.5" /> Refresh</Button>
            </div>

            <Card>
                <CardContent className="pt-6 space-y-3">
                    <div className="flex items-center justify-between gap-2">
                        <span className="text-xs text-muted-foreground">{formatDate(campaign.created_at)} · from <span className="font-mono">{campaign.sender_used}</span></span>
                        <StatusPill status={campaign.status} />
                    </div>
                    <div className="rounded-2xl bg-muted p-3 text-sm whitespace-pre-wrap break-words">{campaign.message}</div>
                    <p className="text-xs text-muted-foreground">
                        {campaign.recipients_count.toLocaleString()} recipients · {campaign.segments} part{campaign.segments === 1 ? '' : 's'} each · {campaign.credits_charged.toLocaleString()} credits charged
                    </p>
                    <div className="flex flex-wrap gap-2">
                        <button type="button" onClick={() => { setFilter(null); setPage(0) }}
                            className={cn('rounded-full border px-3 py-1 text-xs font-semibold', !filter && 'border-emerald-500 bg-emerald-50 dark:bg-emerald-950/30')}>
                            All · {campaign.recipients_count.toLocaleString()}
                        </button>
                        {Object.entries(delivery).map(([status, count]) => (
                            <button key={status} type="button" onClick={() => { setFilter(status); setPage(0) }}
                                className={cn('rounded-full border px-3 py-1 text-xs font-semibold capitalize', filter === status && 'border-emerald-500 bg-emerald-50 dark:bg-emerald-950/30')}>
                                {status} · {count.toLocaleString()}
                            </button>
                        ))}
                    </div>
                    {inFlight && <p className="text-[11px] text-muted-foreground">Delivery reports are still coming in from the networks — this updates by itself.</p>}
                </CardContent>
            </Card>

            <Card>
                <CardContent className="pt-6 space-y-3">
                    {messages.length === 0 ? (
                        <p className="text-sm text-muted-foreground text-center py-6">No messages in this view.</p>
                    ) : (
                        <div className="divide-y rounded-xl border">
                            {messages.map((m) => (
                                <div key={m.recipient} className="flex items-center justify-between gap-2 p-3">
                                    <div className="min-w-0">
                                        <p className="font-mono text-sm">{formatGhanaPhone(m.recipient)}</p>
                                        {m.error && <p className="text-[11px] text-red-600 truncate">{m.error}</p>}
                                    </div>
                                    <StatusPill status={m.status} />
                                </div>
                            ))}
                        </div>
                    )}
                    <div className="flex items-center justify-between text-sm">
                        <Button size="sm" variant="outline" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Previous</Button>
                        <span className="text-muted-foreground">Page {page + 1}</span>
                        <Button size="sm" variant="outline" disabled={messages.length < 100} onClick={() => setPage((p) => p + 1)}>Next</Button>
                    </div>
                </CardContent>
            </Card>
        </div>
    )
}
