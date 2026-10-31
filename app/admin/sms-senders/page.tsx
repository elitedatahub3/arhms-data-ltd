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
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
    Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog'
import { Loader2, MessageSquare, ExternalLink, AlertTriangle, Coins, Search, Store, UserPlus } from 'lucide-react'
import { validateSenderId, SENDER_ID_MAX } from '@/lib/sms/sms-rules'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { SmsSettings } from '@/components/admin/sms-settings'

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

interface ShopHit {
    id: string
    shopName: string | null
    shopSlug: string | null
    approvalStatus: string
    ownerId: string
    ownerName: string | null
    ownerPhone: string | null
    /** null when the shop has never opened Customer SMS. */
    accountStatus: 'locked' | 'active' | 'suspended' | null
}

const STATUS_TABS: { value: SenderStatus; label: string }[] = [
    { value: 'pending', label: 'Pending' },
    { value: 'submitted', label: 'Submitted' },
    { value: 'approved', label: 'Approved' },
    { value: 'rejected', label: 'Rejected' },
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
    // Non-null only while KingFlexy is the gateway: the sender IDs it will
    // actually accept, and what the platform has left to send with.
    const [providerSenders, setProviderSenders] = useState<string[] | null>(null)
    const [providerBalance, setProviderBalance] = useState<number | null>(null)
    const [providerError, setProviderError] = useState<string | null>(null)
    const [rejecting, setRejecting] = useState<SenderRequest | null>(null)
    const [reason, setReason] = useState('')

    // "Add for a shop" — the other direction from the request queue, for when the
    // name is already registered at the provider and ARHMS just has to agree.
    const [addOpen, setAddOpen] = useState(false)
    const [shopQuery, setShopQuery] = useState('')
    const [shopResults, setShopResults] = useState<ShopHit[]>([])
    const [searching, setSearching] = useState(false)
    const [picked, setPicked] = useState<ShopHit | null>(null)
    const [newSender, setNewSender] = useState('')
    const [newStatus, setNewStatus] = useState<'approved' | 'submitted' | 'pending'>('approved')
    const [adding, setAdding] = useState(false)

    const load = useCallback(async () => {
        setLoading(true)
        try {
            const res = await fetch(`/api/admin/sms-senders?status=${status}`, { cache: 'no-store' })
            const data = await res.json()
            if (data?.success) {
                setRows(data.senders)
                setCounts(data.counts || {})
                setProviderSenders(data.providerSenders ?? null)
                setProviderBalance(data.providerBalance ?? null)
                setProviderError(data.providerError ?? null)
            }
            else toast.error(data?.error || 'Failed to load sender IDs')
        } catch {
            toast.error('Failed to load sender IDs')
        } finally {
            setLoading(false)
        }
    }, [status])

    useEffect(() => { load() }, [load])

    // Debounced by the effect below; the endpoint caps at 20 hits.
    const searchShops = useCallback(async (q: string) => {
        if (q.trim().length < 2) { setShopResults([]); return }
        setSearching(true)
        try {
            const res = await fetch(`/api/admin/sms-senders?lookup=${encodeURIComponent(q.trim())}`, { cache: 'no-store' })
            const data = await res.json()
            if (data?.success) setShopResults(data.shops || [])
        } catch {
            toast.error('Shop search failed')
        } finally {
            setSearching(false)
        }
    }, [])

    useEffect(() => {
        if (!addOpen) return
        const t = setTimeout(() => searchShops(shopQuery), 300)
        return () => clearTimeout(t)
    }, [addOpen, shopQuery, searchShops])

    const addSender = async () => {
        if (!picked) { toast.error('Choose a shop first'); return }
        const check = validateSenderId(newSender)
        if (!check.ok) { toast.error(check.error); return }

        setAdding(true)
        try {
            const res = await fetch('/api/admin/sms-senders', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ shopId: picked.id, sender: newSender.trim(), status: newStatus }),
            })
            const data = await res.json()
            if (!res.ok || !data?.success) { toast.error(data?.error || 'Could not add the sender ID'); return }

            toast.success(`${newSender.trim()} added for ${picked.shopName}`)
            if (data.accountStatus !== 'active') {
                toast.info('That shop has not unlocked Customer SMS yet, so it cannot send until they do.')
            }
            setAddOpen(false)
            setPicked(null)
            setNewSender('')
            setShopQuery('')
            setShopResults([])
            setStatus(newStatus)
            load()
        } catch {
            toast.error('Something went wrong. Please try again.')
        } finally {
            setAdding(false)
        }
    }

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
            {providerBalance !== null && (
                <Card className={cn(providerBalance < 500 && 'border-amber-400')}>
                    <CardContent className="py-3 flex items-center gap-2 text-sm">
                        <Coins className="w-4 h-4 text-emerald-600" />
                        <span className="font-semibold">{providerBalance.toLocaleString()}</span>
                        <span className="text-muted-foreground">SMS credits left on the ARHMS KingFlexy account</span>
                        {providerBalance < 500 && (
                            <span className="text-amber-700 dark:text-amber-400 font-semibold">
                                — top up, or every shop&apos;s sends start failing
                            </span>
                        )}
                    </CardContent>
                </Card>
            )}

            {providerError && (
                <Card className="border-amber-400">
                    <CardContent className="py-3 flex items-center gap-2 text-sm">
                        <AlertTriangle className="w-4 h-4 text-amber-600" />
                        <span>Could not read the KingFlexy sender list: {providerError}</span>
                    </CardContent>
                </Card>
            )}

            <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm text-muted-foreground">
                    Shops request sender IDs here. You can also add one yourself — useful once the name is
                    registered on the ARHMS KingFlexy account.
                </p>
                <Button size="sm" className="gap-1.5 bg-emerald-600 hover:bg-emerald-700" onClick={() => setAddOpen(true)}>
                    <UserPlus className="w-4 h-4" /> Add sender ID for a shop
                </Button>
            </div>

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
                                    {providerSenders && !providerSenders.some(x => x.toLowerCase().replace(/[^a-z0-9]/g, '') === row.sender.toLowerCase().replace(/[^a-z0-9]/g, '')) && (
                                        <p className="mt-1 inline-flex items-center gap-1.5 rounded-md bg-amber-100 dark:bg-amber-950/40 px-2 py-1 text-xs font-semibold text-amber-800 dark:text-amber-300">
                                            <AlertTriangle className="w-3.5 h-3.5" />
                                            Not registered on the KingFlexy account — sends under it will be rejected
                                        </p>
                                    )}
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

            <Dialog open={addOpen} onOpenChange={(open) => { setAddOpen(open); if (!open) { setPicked(null); setShopQuery(''); setShopResults([]) } }}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Add a sender ID for a shop</DialogTitle>
                        <DialogDescription>
                            Creates the sender ID on the shop&apos;s behalf. Approving it here does NOT register it with
                            the networks — do that on the KingFlexy account first, or its sends will be refused.
                        </DialogDescription>
                    </DialogHeader>

                    <div className="space-y-3">
                        <div className="space-y-2">
                            <Label>Shop</Label>
                            {picked ? (
                                <div className="flex items-center justify-between gap-2 rounded-xl border p-3">
                                    <div className="min-w-0">
                                        <p className="font-semibold text-sm truncate">{picked.shopName}</p>
                                        <p className="text-xs text-muted-foreground truncate">
                                            {picked.ownerName || 'Unknown owner'} · {picked.ownerPhone || 'no phone'} ·{' '}
                                            {picked.accountStatus
                                                ? `SMS ${picked.accountStatus}`
                                                : 'never opened Customer SMS'}
                                        </p>
                                    </div>
                                    <Button size="sm" variant="ghost" onClick={() => setPicked(null)}>Change</Button>
                                </div>
                            ) : (
                                <>
                                    <div className="relative">
                                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                                        <Input
                                            value={shopQuery}
                                            onChange={(e) => setShopQuery(e.target.value)}
                                            placeholder="Search by shop name or slug"
                                            className="pl-9"
                                            autoFocus
                                        />
                                    </div>
                                    {searching && <p className="text-xs text-muted-foreground">Searching…</p>}
                                    {!searching && shopQuery.trim().length >= 2 && shopResults.length === 0 && (
                                        <p className="text-xs text-muted-foreground">No shops match.</p>
                                    )}
                                    {shopResults.length > 0 && (
                                        <div className="max-h-56 overflow-y-auto divide-y rounded-xl border">
                                            {shopResults.map((hit) => (
                                                <button
                                                    key={hit.id}
                                                    type="button"
                                                    onClick={() => setPicked(hit)}
                                                    className="w-full text-left p-2.5 hover:bg-muted/60 flex items-center gap-2"
                                                >
                                                    <Store className="w-4 h-4 text-muted-foreground shrink-0" />
                                                    <span className="min-w-0">
                                                        <span className="block text-sm font-semibold truncate">{hit.shopName}</span>
                                                        <span className="block text-[11px] text-muted-foreground truncate">
                                                            {hit.ownerName || 'Unknown owner'} ·{' '}
                                                            {hit.accountStatus ? `SMS ${hit.accountStatus}` : 'no SMS account yet'}
                                                        </span>
                                                    </span>
                                                </button>
                                            ))}
                                        </div>
                                    )}
                                </>
                            )}
                        </div>

                        <div className="space-y-2">
                            <Label>Sender ID</Label>
                            <Input
                                value={newSender}
                                onChange={(e) => setNewSender(e.target.value.slice(0, SENDER_ID_MAX))}
                                placeholder="e.g. KofiStores"
                                maxLength={SENDER_ID_MAX}
                            />
                            <div className="flex justify-between text-xs">
                                <span className={newSender.trim() && !validateSenderId(newSender).ok ? 'text-red-600' : 'text-emerald-600'}>
                                    {newSender.trim() ? (validateSenderId(newSender).ok ? 'Looks good' : validateSenderId(newSender).error) : ''}
                                </span>
                                <span className="text-muted-foreground">{newSender.length}/{SENDER_ID_MAX}</span>
                            </div>
                        </div>

                        <div className="space-y-2">
                            <Label>Status</Label>
                            <div className="flex rounded-lg border overflow-hidden">
                                {([
                                    { value: 'approved' as const, label: 'Approved', hint: 'Live now' },
                                    { value: 'submitted' as const, label: 'Submitted', hint: 'With the networks' },
                                    { value: 'pending' as const, label: 'Pending', hint: 'Review later' },
                                ]).map((opt, i) => (
                                    <button
                                        key={opt.value}
                                        type="button"
                                        onClick={() => setNewStatus(opt.value)}
                                        className={cn(
                                            'flex-1 px-3 py-2 text-sm font-medium transition-colors',
                                            i > 0 && 'border-l',
                                            newStatus === opt.value ? 'bg-primary text-primary-foreground' : 'bg-background hover:bg-muted'
                                        )}
                                    >
                                        {opt.label}
                                    </button>
                                ))}
                            </div>
                            {newStatus === 'approved' && (
                                <p className="text-[11px] text-muted-foreground">
                                    The shop is told by SMS and in-app, and this becomes their default sender if they have no other.
                                </p>
                            )}
                        </div>
                    </div>

                    <DialogFooter>
                        <Button
                            onClick={addSender}
                            disabled={adding || !picked || !validateSenderId(newSender).ok}
                            className="bg-emerald-600 hover:bg-emerald-700"
                        >
                            {adding ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Add sender ID'}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

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
