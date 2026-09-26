'use client'

/**
 * Admin: Customer SMS.
 *
 * Sender IDs move pending → submitted (handed to the provider) → approved or
 * rejected. Nothing here registers the name with the networks — "submitted"
 * records that an admin has done that outside the platform.
 *
 * The Settings tab holds the unlock prices, master switch, pool senders and the
 * credit bundle price list.
 */

import { useCallback, useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
    Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog'
import { Loader2, MessageSquare, Plus, Trash2, Save, ExternalLink } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'

type SenderStatus = 'pending' | 'submitted' | 'approved' | 'rejected'

interface SenderRequest {
    id: string
    sender: string
    business_name: string | null
    ghana_card_url: string | null
    status: SenderStatus
    rejection_reason: string | null
    submitted_at: string | null
    approved_at: string | null
    created_at: string
    account: {
        id: string
        user_id: string
        status: string
        user: { first_name: string | null; last_name: string | null; email: string | null; phone_number: string | null } | null
        shop: { shop_name: string | null; shop_slug: string | null } | null
    }
}

interface Bundle {
    id?: string
    name: string
    credits: number | string
    price: number | string
    sort_order: number | string
    is_active: boolean
}

const STATUS_TABS: { value: SenderStatus; label: string }[] = [
    { value: 'pending', label: 'Pending' },
    { value: 'submitted', label: 'Submitted' },
    { value: 'approved', label: 'Approved' },
    { value: 'rejected', label: 'Rejected' },
]

const PRICE_FIELDS = [
    { key: 'sms_unlock_price_customer', label: 'Customer' },
    { key: 'sms_unlock_price_agent', label: 'Agent' },
    { key: 'sms_unlock_price_dealer', label: 'Dealer' },
    { key: 'sms_unlock_price_sub', label: 'Sub-agent' },
]

export default function AdminCustomerSmsPage() {
    return (
        <div className="space-y-6 p-4 md:p-6 max-w-5xl">
            <div>
                <h1 className="text-2xl font-black flex items-center gap-2"><MessageSquare className="w-6 h-6" /> Customer SMS</h1>
                <p className="text-sm text-muted-foreground">Approve shop sender IDs and manage pricing.</p>
            </div>
            <Tabs defaultValue="senders">
                <TabsList>
                    <TabsTrigger value="senders">Sender IDs</TabsTrigger>
                    <TabsTrigger value="settings">Settings & bundles</TabsTrigger>
                </TabsList>
                <TabsContent value="senders" className="mt-4"><SenderQueue /></TabsContent>
                <TabsContent value="settings" className="mt-4"><SmsSettings /></TabsContent>
            </Tabs>
        </div>
    )
}

function SenderQueue() {
    const [status, setStatus] = useState<SenderStatus>('pending')
    const [rows, setRows] = useState<SenderRequest[]>([])
    const [counts, setCounts] = useState<Record<string, number>>({})
    const [loading, setLoading] = useState(true)
    const [busyId, setBusyId] = useState<string | null>(null)
    const [rejecting, setRejecting] = useState<SenderRequest | null>(null)
    const [reason, setReason] = useState('')

    const load = useCallback(async () => {
        setLoading(true)
        try {
            const res = await fetch(`/api/admin/sms-senders?status=${status}`, { cache: 'no-store' })
            const data = await res.json()
            if (data?.success) { setRows(data.senders); setCounts(data.counts || {}) }
            else toast.error(data?.error || 'Failed to load sender IDs')
        } catch {
            toast.error('Failed to load sender IDs')
        } finally {
            setLoading(false)
        }
    }, [status])

    useEffect(() => { load() }, [load])

    const transition = async (row: SenderRequest, next: SenderStatus, rejectionReason?: string) => {
        setBusyId(row.id)
        try {
            const res = await fetch('/api/admin/sms-senders', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: row.id, status: next, reason: rejectionReason }),
            })
            const data = await res.json()
            if (!res.ok || !data?.success) { toast.error(data?.error || 'Update failed'); return false }
            toast.success(`${row.sender} → ${next}`)
            load()
            return true
        } catch {
            toast.error('Update failed')
            return false
        } finally {
            setBusyId(null)
        }
    }

    const confirmReject = async () => {
        if (!rejecting || !reason.trim()) return
        if (await transition(rejecting, 'rejected', reason.trim())) {
            setRejecting(null)
            setReason('')
        }
    }

    return (
        <div className="space-y-4">
            <div className="flex flex-wrap gap-2">
                {STATUS_TABS.map((t) => (
                    <button key={t.value} type="button" onClick={() => setStatus(t.value)}
                        className={cn('rounded-full border px-3 py-1.5 text-sm font-semibold', status === t.value && 'border-emerald-500 bg-emerald-50 dark:bg-emerald-950/30')}>
                        {t.label} <span className="text-muted-foreground">({counts[t.value] ?? 0})</span>
                    </button>
                ))}
            </div>

            {loading ? (
                <div className="space-y-2">{[0, 1].map((i) => <Skeleton key={i} className="h-28 w-full" />)}</div>
            ) : rows.length === 0 ? (
                <Card><CardContent className="py-10 text-center text-sm text-muted-foreground">No {status} sender IDs.</CardContent></Card>
            ) : rows.map((row) => {
                const user = row.account?.user
                const owner = [user?.first_name, user?.last_name].filter(Boolean).join(' ') || user?.email || 'Unknown'
                const busy = busyId === row.id
                return (
                    <Card key={row.id}>
                        <CardContent className="pt-6 space-y-3">
                            <div className="flex flex-wrap items-start justify-between gap-3">
                                <div>
                                    <p className="font-mono text-xl font-black">{row.sender}</p>
                                    <p className="text-sm">{row.business_name || '—'}</p>
                                    <p className="text-xs text-muted-foreground">
                                        {row.account?.shop?.shop_name || 'No shop'} · {owner} · {user?.phone_number || 'no phone'}
                                    </p>
                                    <p className="text-xs text-muted-foreground">Requested {new Date(row.created_at).toLocaleString('en-GH')}</p>
                                    {row.rejection_reason && <p className="text-xs text-red-600 mt-1">Reason: {row.rejection_reason}</p>}
                                </div>
                                {row.ghana_card_url && (
                                    <a href={row.ghana_card_url} target="_blank" rel="noreferrer" className="text-xs inline-flex items-center gap-1 underline">
                                        Ghana Card <ExternalLink className="w-3 h-3" />
                                    </a>
                                )}
                            </div>
                            <div className="flex flex-wrap gap-2">
                                {row.status === 'pending' && (
                                    <Button size="sm" variant="outline" disabled={busy} onClick={() => transition(row, 'submitted')}>
                                        Mark submitted to provider
                                    </Button>
                                )}
                                {(row.status === 'pending' || row.status === 'submitted') && (
                                    <Button size="sm" disabled={busy} onClick={() => transition(row, 'approved')} className="bg-emerald-600 hover:bg-emerald-700">
                                        {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Approve'}
                                    </Button>
                                )}
                                {row.status !== 'rejected' && (
                                    <Button size="sm" variant="destructive" disabled={busy} onClick={() => { setRejecting(row); setReason('') }}>
                                        {row.status === 'approved' ? 'Revoke' : 'Reject'}
                                    </Button>
                                )}
                            </div>
                        </CardContent>
                    </Card>
                )
            })}

            <Dialog open={!!rejecting} onOpenChange={(open) => !open && setRejecting(null)}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>{rejecting?.status === 'approved' ? 'Revoke' : 'Reject'} {rejecting?.sender}</DialogTitle>
                        <DialogDescription>The shop sees this reason by SMS and on their dashboard, so make it something they can act on.</DialogDescription>
                    </DialogHeader>
                    <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3}
                        placeholder="e.g. Sender IDs cannot contain the word DATA. Please use your business name." />
                    <DialogFooter>
                        <Button variant="destructive" onClick={confirmReject} disabled={!reason.trim() || busyId === rejecting?.id}>Confirm</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    )
}

function SmsSettings() {
    const [settings, setSettings] = useState<Record<string, string>>({})
    const [bundles, setBundles] = useState<Bundle[]>([])
    const [deleteIds, setDeleteIds] = useState<string[]>([])
    const [loading, setLoading] = useState(true)
    const [saving, setSaving] = useState(false)

    const load = useCallback(async () => {
        try {
            const res = await fetch('/api/admin/sms-config', { cache: 'no-store' })
            const data = await res.json()
            if (data?.success) {
                setSettings(data.settings)
                setBundles(data.bundles.filter((b: Bundle) => b.is_active))
                setDeleteIds([])
            } else {
                toast.error(data?.error || 'Failed to load settings')
            }
        } catch {
            toast.error('Failed to load settings')
        } finally {
            setLoading(false)
        }
    }, [])

    useEffect(() => { load() }, [load])

    const setField = (key: string, value: string) => setSettings((s) => ({ ...s, [key]: value }))
    const setBundle = (i: number, patch: Partial<Bundle>) => setBundles((bs) => bs.map((b, idx) => (idx === i ? { ...b, ...patch } : b)))

    const removeBundle = (i: number) => {
        const b = bundles[i]
        if (b.id) setDeleteIds((ids) => [...ids, b.id!])
        setBundles((bs) => bs.filter((_, idx) => idx !== i))
    }

    const save = async () => {
        setSaving(true)
        try {
            const res = await fetch('/api/admin/sms-config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ settings, bundles, deleteBundleIds: deleteIds }),
            })
            const data = await res.json()
            if (!res.ok || !data?.success) { toast.error(data?.error || 'Save failed'); return }
            toast.success('Customer SMS settings saved')
            load()
        } catch {
            toast.error('Save failed')
        } finally {
            setSaving(false)
        }
    }

    if (loading) return <Skeleton className="h-96 w-full" />

    return (
        <div className="space-y-4">
            <Card>
                <CardHeader>
                    <CardTitle className="text-base">Service</CardTitle>
                    <CardDescription>Switching off blocks unlocks, purchases, sender requests and sends for everyone. Existing credits are kept.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    <div className="flex items-center justify-between">
                        <Label>Customer SMS enabled</Label>
                        <Switch checked={settings.sms_customer_enabled !== 'false'}
                            onCheckedChange={(v) => setField('sms_customer_enabled', v ? 'true' : 'false')} />
                    </div>
                    <div className="grid gap-4 sm:grid-cols-2">
                        <div className="space-y-2">
                            <Label>Pool sender IDs</Label>
                            <Input value={settings.sms_pool_senders || ''} onChange={(e) => setField('sms_pool_senders', e.target.value)} placeholder="ARHMSGh" />
                            <p className="text-[11px] text-muted-foreground">Comma-separated. Any unlocked shop may send under these while their own sender ID is pending. Leave empty to require an approved sender ID.</p>
                        </div>
                        <div className="space-y-2">
                            <Label>Send inline up to (recipients)</Label>
                            <Input type="number" min={1} value={settings.sms_inline_send_max || ''} onChange={(e) => setField('sms_inline_send_max', e.target.value)} placeholder="100" />
                            <p className="text-[11px] text-muted-foreground">Larger sends are queued for the process-sms-campaigns cron.</p>
                        </div>
                    </div>
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle className="text-base">Unlock price (GHS, one time)</CardTitle>
                </CardHeader>
                <CardContent className="grid gap-3 grid-cols-2 sm:grid-cols-4">
                    {PRICE_FIELDS.map((f) => (
                        <div key={f.key} className="space-y-1.5">
                            <Label className="text-xs">{f.label}</Label>
                            <Input type="number" min={0} step="0.01" value={settings[f.key] || ''} onChange={(e) => setField(f.key, e.target.value)} placeholder="10" />
                        </div>
                    ))}
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <div className="flex items-center justify-between gap-2">
                        <div>
                            <CardTitle className="text-base">Credit bundles</CardTitle>
                            <CardDescription>1 credit = 1 SMS segment to 1 recipient.</CardDescription>
                        </div>
                        <Button size="sm" variant="outline" className="gap-1"
                            onClick={() => setBundles((bs) => [...bs, { name: '', credits: '', price: '', sort_order: bs.length + 1, is_active: true }])}>
                            <Plus className="w-4 h-4" /> Add
                        </Button>
                    </div>
                </CardHeader>
                <CardContent className="space-y-2">
                    <div className="hidden sm:grid grid-cols-[1fr_110px_110px_90px_110px_40px] gap-2 text-xs text-muted-foreground px-1">
                        <span>Name</span><span>Credits</span><span>Price (GHS)</span><span>Order</span><span>GHS / SMS</span><span />
                    </div>
                    {bundles.map((b, i) => {
                        const perSms = Number(b.credits) > 0 ? Number(b.price) / Number(b.credits) : 0
                        return (
                            <div key={b.id ?? `new-${i}`} className="grid grid-cols-2 sm:grid-cols-[1fr_110px_110px_90px_110px_40px] gap-2 items-center rounded-xl border p-2 sm:border-0 sm:p-0">
                                <Input value={b.name} onChange={(e) => setBundle(i, { name: e.target.value })} placeholder="Starter" className="col-span-2 sm:col-span-1" />
                                <Input type="number" min={1} value={b.credits} onChange={(e) => setBundle(i, { credits: e.target.value })} placeholder="100" />
                                <Input type="number" min={0} step="0.01" value={b.price} onChange={(e) => setBundle(i, { price: e.target.value })} placeholder="5.00" />
                                <Input type="number" value={b.sort_order} onChange={(e) => setBundle(i, { sort_order: e.target.value })} />
                                <span className="text-sm text-muted-foreground">{perSms ? perSms.toFixed(3) : '—'}</span>
                                <Button size="icon" variant="ghost" onClick={() => removeBundle(i)} aria-label="Remove bundle"><Trash2 className="w-4 h-4" /></Button>
                            </div>
                        )
                    })}
                    {!bundles.length && <p className="text-sm text-muted-foreground text-center py-4">No bundles on sale.</p>}
                    <p className="text-[11px] text-muted-foreground">Removed bundles are hidden from shops, not deleted, so past purchases keep their history.</p>
                </CardContent>
            </Card>

            <Button onClick={save} disabled={saving} className="gap-2 bg-emerald-600 hover:bg-emerald-700">
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save settings
            </Button>
        </div>
    )
}
