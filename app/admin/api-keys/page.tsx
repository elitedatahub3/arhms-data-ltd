'use client'

import { useEffect, useState, useCallback } from 'react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Input } from '@/components/ui/input'
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select'
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog'
import {
    Key,
    RefreshCw,
    ShieldCheck,
    ShieldOff,
    Search,
    Loader2,
    Clock,
    User,
    Activity,
} from 'lucide-react'
import { toast } from 'sonner'
import { formatDate, cn } from '@/lib/utils'

interface ApiKeyRow {
    id: string
    key_prefix: string
    name: string
    status: 'pending' | 'active' | 'revoked'
    /** Absent on rows created before v2; those are all data keys. */
    kind?: 'standard' | 'commission'
    last_used_at: string | null
    created_at: string
    users: {
        id: string
        first_name: string
        last_name: string
        email: string
        role: string
    }
}

const STATUS_BADGE: Record<string, string> = {
    pending: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400',
    active:  'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
    revoked: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
}

// Commission keys reach airtime and bill payments, which cannot be recalled once the
// provider accepts them. Worth telling apart at a glance from a data key.
const KIND_BADGE: Record<string, { label: string; className: string }> = {
    standard:   { label: 'Data',       className: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400' },
    commission: { label: 'Commission', className: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400' },
}

export default function AdminApiKeysPage() {
    const [keys, setKeys] = useState<ApiKeyRow[]>([])
    const [loading, setLoading] = useState(true)
    const [statusFilter, setStatusFilter] = useState('all')
    const [kindFilter, setKindFilter] = useState('all')
    const [search, setSearch] = useState('')
    const [actionKey, setActionKey] = useState<{ id: string; action: 'approve' | 'revoke' } | null>(null)
    const [isActioning, setIsActioning] = useState(false)

    const fetchKeys = useCallback(async () => {
        setLoading(true)
        try {
            const params = new URLSearchParams()
            if (statusFilter !== 'all') params.set('status', statusFilter)
            if (kindFilter !== 'all') params.set('kind', kindFilter)
            const res = await fetch(`/api/admin/api-keys?${params}`)
            const json = await res.json()
            setKeys(json.keys || [])
        } finally {
            setLoading(false)
        }
    }, [statusFilter, kindFilter])

    useEffect(() => { fetchKeys() }, [fetchKeys])

    const handleAction = async () => {
        if (!actionKey) return
        setIsActioning(true)
        try {
            const res = await fetch('/api/admin/api-keys', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ keyId: actionKey.id, action: actionKey.action }),
            })
            const json = await res.json()
            if (!res.ok) {
                toast.error(json.error || 'Action failed')
                return
            }
            toast.success(actionKey.action === 'approve' ? 'Key approved' : 'Key revoked')
            setActionKey(null)
            await fetchKeys()
        } catch {
            toast.error('Something went wrong')
        } finally {
            setIsActioning(false)
        }
    }

    const filtered = keys.filter(k => {
        if (!search) return true
        const q = search.toLowerCase()
        return (
            k.users.first_name?.toLowerCase().includes(q) ||
            k.users.last_name?.toLowerCase().includes(q) ||
            k.users.email?.toLowerCase().includes(q) ||
            k.key_prefix?.toLowerCase().includes(q)
        )
    })

    return (
        <div className="space-y-6">
            <div>
                <h1 className="text-2xl font-bold tracking-tight">API Key Management</h1>
                <p className="text-muted-foreground text-sm mt-1">Approve or revoke developer API keys.</p>
            </div>

            {/* Stats */}
            <div className="grid grid-cols-3 gap-4">
                {(['pending', 'active', 'revoked'] as const).map(s => (
                    <Card key={s} className="p-4">
                        <p className="text-xs text-muted-foreground uppercase tracking-widest font-semibold">{s}</p>
                        <p className="text-2xl font-black mt-1">
                            {loading ? '—' : keys.filter(k => k.status === s).length}
                        </p>
                    </Card>
                ))}
            </div>

            <Card>
                <CardHeader>
                    <div className="flex flex-col sm:flex-row gap-3">
                        <div className="relative flex-1">
                            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                            <Input
                                placeholder="Search by name, email or prefix…"
                                className="pl-9"
                                value={search}
                                onChange={e => setSearch(e.target.value)}
                            />
                        </div>
                        <Select value={statusFilter} onValueChange={setStatusFilter}>
                            <SelectTrigger className="w-40">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="all">All statuses</SelectItem>
                                <SelectItem value="pending">Pending</SelectItem>
                                <SelectItem value="active">Active</SelectItem>
                                <SelectItem value="revoked">Revoked</SelectItem>
                            </SelectContent>
                        </Select>
                        <Select value={kindFilter} onValueChange={setKindFilter}>
                            <SelectTrigger className="w-40">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="all">All types</SelectItem>
                                <SelectItem value="standard">Data</SelectItem>
                                <SelectItem value="commission">Commission</SelectItem>
                            </SelectContent>
                        </Select>
                        <Button variant="ghost" size="icon" onClick={fetchKeys}>
                            <RefreshCw className="w-4 h-4" />
                        </Button>
                    </div>
                </CardHeader>
                <CardContent>
                    {loading ? (
                        <div className="space-y-3">
                            {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-16 w-full" />)}
                        </div>
                    ) : filtered.length === 0 ? (
                        <div className="text-center py-12 text-muted-foreground text-sm">
                            No API keys found.
                        </div>
                    ) : (
                        <div className="space-y-2">
                            {filtered.map(k => (
                                <div
                                    key={k.id}
                                    className="flex flex-col sm:flex-row sm:items-center gap-3 rounded-xl border border-border/50 px-4 py-3 hover:bg-secondary/20 transition-colors"
                                >
                                    <div className="flex-1 min-w-0 space-y-0.5">
                                        <div className="flex items-center gap-2 flex-wrap">
                                            <p className="text-sm font-semibold">
                                                {k.users.first_name} {k.users.last_name}
                                            </p>
                                            <span className={cn('text-[10px] font-bold px-2 py-0.5 rounded-full uppercase', STATUS_BADGE[k.status])}>
                                                {k.status}
                                            </span>
                                            <span className={cn(
                                                'text-[10px] font-bold px-2 py-0.5 rounded-full uppercase',
                                                KIND_BADGE[k.kind ?? 'standard'].className
                                            )}>
                                                {KIND_BADGE[k.kind ?? 'standard'].label}
                                            </span>
                                            <span className="text-[10px] text-muted-foreground bg-secondary/50 px-2 py-0.5 rounded-full uppercase font-semibold">
                                                {k.users.role}
                                            </span>
                                        </div>
                                        <p className="text-xs text-muted-foreground">{k.users.email}</p>
                                        <div className="flex items-center gap-3 text-xs text-muted-foreground">
                                            <span className="font-mono">{k.key_prefix}…</span>
                                            <span>Created {formatDate(k.created_at)}</span>
                                            {k.last_used_at && (
                                                <span className="flex items-center gap-1">
                                                    <Clock className="w-3 h-3" /> Last used {formatDate(k.last_used_at)}
                                                </span>
                                            )}
                                        </div>
                                    </div>
                                    <div className="flex gap-2 shrink-0">
                                        {k.status === 'pending' && (
                                            <Button
                                                size="sm"
                                                className="gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white"
                                                onClick={() => setActionKey({ id: k.id, action: 'approve' })}
                                            >
                                                <ShieldCheck className="w-3.5 h-3.5" /> Approve
                                            </Button>
                                        )}
                                        {k.status === 'active' && (
                                            <Button
                                                size="sm"
                                                variant="ghost"
                                                className="gap-1.5 text-red-500 hover:text-red-600 hover:bg-red-500/10"
                                                onClick={() => setActionKey({ id: k.id, action: 'revoke' })}
                                            >
                                                <ShieldOff className="w-3.5 h-3.5" /> Revoke
                                            </Button>
                                        )}
                                        {k.status === 'revoked' && (
                                            <Button
                                                size="sm"
                                                variant="outline"
                                                className="gap-1.5"
                                                onClick={() => setActionKey({ id: k.id, action: 'approve' })}
                                            >
                                                <ShieldCheck className="w-3.5 h-3.5" /> Re-activate
                                            </Button>
                                        )}
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </CardContent>
            </Card>

            {/* Confirm Dialog */}
            <Dialog open={!!actionKey} onOpenChange={() => setActionKey(null)}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>
                            {actionKey?.action === 'approve' ? 'Approve API Key' : 'Revoke API Key'}
                        </DialogTitle>
                        <DialogDescription>
                            {actionKey?.action === 'approve'
                                ? 'The user will be notified and can start making API calls immediately.'
                                : 'The key will stop working immediately. The user will be notified.'}
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setActionKey(null)}>Cancel</Button>
                        <Button
                            onClick={handleAction}
                            disabled={isActioning}
                            className={cn('gap-2', actionKey?.action === 'revoke' && 'bg-red-600 hover:bg-red-700 text-white')}
                        >
                            {isActioning ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
                            {actionKey?.action === 'approve' ? 'Approve' : 'Revoke'}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    )
}
