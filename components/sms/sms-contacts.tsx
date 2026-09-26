'use client'

/**
 * The owner's customer list — the people they can send SMS to.
 *
 * Four ways in: pull everyone who has ordered from the shop, type one number,
 * paste a block, or upload a CSV. All of them post to the same endpoint, which
 * normalises and dedupes, so this component never reasons about phone formats.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { Checkbox } from '@/components/ui/checkbox'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import {
    Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog'
import {
    Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
    ShoppingCart, UserPlus, ClipboardPaste, Upload, Loader2, Trash2, Search, FolderPlus, Users, Lock,
} from 'lucide-react'
import { toast } from 'sonner'
import { SUB_AGENTS_GROUP_ID } from '@/lib/sms/sms-rules'

interface Contact {
    id: string
    phone: string
    name: string | null
    source: 'order' | 'manual' | 'import'
    opted_out: boolean
}

export interface SmsGroup {
    id: string
    name: string
    memberCount: number
    system: boolean
}

const PAGE_SIZE = 100
const ALL = '__all__'

/** 233551234567 → 055 123 4567, which is how owners actually read numbers. */
export function formatGhanaPhone(phone: string) {
    const local = phone.startsWith('233') ? `0${phone.slice(3)}` : phone
    return local.length === 10 ? `${local.slice(0, 3)} ${local.slice(3, 6)} ${local.slice(6)}` : local
}

/**
 * Pulls "number, name" pairs out of pasted text or a CSV.
 *
 * Deliberately forgiving: a header row, blank lines, quoted cells and name-first
 * columns all turn up in real exports. Anything that is not obviously a number
 * is sent anyway and reported back as invalid by the server.
 */
function parseContactsText(text: string): { phone: string; name: string | null }[] {
    const out: { phone: string; name: string | null }[] = []
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim()
        if (!line) continue
        const cells = line.split(/[,;\t]/).map((c) => c.trim().replace(/^"|"$/g, ''))
        const phoneIndex = cells.findIndex((c) => /\d{9,}/.test(c.replace(/[\s+\-()]/g, '')))
        if (phoneIndex === -1) {
            // A line of several numbers separated only by spaces.
            const numbers = line.match(/\+?\d[\d\s-]{8,}\d/g)
            if (numbers) numbers.forEach((n) => out.push({ phone: n.replace(/[\s-]/g, ''), name: null }))
            continue
        }
        const name = cells.filter((_, i) => i !== phoneIndex).find((c) => c && !/^\d+$/.test(c)) || null
        out.push({ phone: cells[phoneIndex].replace(/[\s\-()]/g, ''), name })
    }
    return out
}

export function SmsContacts({
    hasShop,
    groups,
    onGroupsChanged,
}: {
    hasShop: boolean
    groups: SmsGroup[]
    onGroupsChanged: () => void
}) {
    const [contacts, setContacts] = useState<Contact[]>([])
    const [total, setTotal] = useState(0)
    const [page, setPage] = useState(0)
    const [search, setSearch] = useState('')
    const [groupFilter, setGroupFilter] = useState(ALL)
    const [loading, setLoading] = useState(true)
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

    const [importing, setImporting] = useState(false)
    const [addOpen, setAddOpen] = useState(false)
    const [pasteOpen, setPasteOpen] = useState(false)
    const [groupOpen, setGroupOpen] = useState(false)

    const [manualPhone, setManualPhone] = useState('')
    const [manualName, setManualName] = useState('')
    const [pasteText, setPasteText] = useState('')
    const [newGroupName, setNewGroupName] = useState('')
    const [saving, setSaving] = useState(false)
    const fileRef = useRef<HTMLInputElement>(null)

    const load = useCallback(async () => {
        setLoading(true)
        try {
            const params = new URLSearchParams({ page: String(page) })
            if (search.trim()) params.set('search', search.trim())
            if (groupFilter !== ALL) params.set('groupId', groupFilter)
            const res = await fetch(`/api/sms/contacts?${params}`, { cache: 'no-store' })
            const data = await res.json()
            if (data?.success) {
                setContacts(data.contacts)
                setTotal(data.total)
            } else {
                toast.error(data?.error || 'Could not load customers')
            }
        } catch {
            toast.error('Could not load customers')
        } finally {
            setLoading(false)
        }
    }, [page, search, groupFilter])

    // Debounced so typing a number does not fire a request per keystroke.
    useEffect(() => {
        const t = setTimeout(load, 300)
        return () => clearTimeout(t)
    }, [load])

    const refresh = () => { load(); onGroupsChanged() }

    const reportAdd = (data: any) => {
        const parts = [data.message || `${data.added} added`]
        if (data.duplicates) parts.push(`${data.duplicates} already on your list`)
        if (data.invalid?.length) parts.push(`${data.invalid.length} invalid skipped`)
        toast.success(parts.join(' · '))
        if (data.invalid?.length) {
            toast.warning(`Not valid Ghana numbers: ${data.invalid.slice(0, 5).join(', ')}${data.invalid.length > 5 ? '…' : ''}`)
        }
    }

    const postContacts = async (body: any) => {
        setSaving(true)
        try {
            const res = await fetch('/api/sms/contacts', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            })
            const data = await res.json()
            if (!res.ok || !data?.success) {
                toast.error(data?.error || 'Could not add customers')
                if (data?.invalid?.length) toast.warning(`Invalid: ${data.invalid.slice(0, 5).join(', ')}`)
                return false
            }
            reportAdd(data)
            refresh()
            return true
        } catch {
            toast.error('Something went wrong. Please try again.')
            return false
        } finally {
            setSaving(false)
        }
    }

    const importFromOrders = async () => {
        setImporting(true)
        try {
            const res = await fetch('/api/sms/contacts/import-orders', { method: 'POST' })
            const data = await res.json()
            if (!res.ok || !data?.success) {
                toast.error(data?.error || 'Import failed')
                return
            }
            toast.success(data.message)
            refresh()
        } catch {
            toast.error('Import failed')
        } finally {
            setImporting(false)
        }
    }

    const addManual = async () => {
        if (!manualPhone.trim()) return
        const ok = await postContacts({ phone: manualPhone.trim(), name: manualName.trim() || null })
        if (ok) { setManualPhone(''); setManualName(''); setAddOpen(false) }
    }

    const addPasted = async () => {
        const parsed = parseContactsText(pasteText)
        if (!parsed.length) {
            toast.error('No phone numbers found in that text')
            return
        }
        const ok = await postContacts({ contacts: parsed, source: 'import' })
        if (ok) { setPasteText(''); setPasteOpen(false) }
    }

    const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0]
        e.target.value = ''
        if (!file) return
        if (file.size > 2 * 1024 * 1024) {
            toast.error('That file is too big. Keep it under 2 MB.')
            return
        }
        const parsed = parseContactsText(await file.text())
        if (!parsed.length) {
            toast.error('No phone numbers found in that file')
            return
        }
        await postContacts({ contacts: parsed, source: 'import' })
    }

    const toggleOptOut = async (contact: Contact) => {
        setContacts((prev) => prev.map((c) => (c.id === contact.id ? { ...c, opted_out: !c.opted_out } : c)))
        const res = await fetch('/api/sms/contacts', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: contact.id, optedOut: !contact.opted_out }),
        })
        if (!res.ok) {
            toast.error('Could not update that customer')
            load()
        }
    }

    const remove = async (contact: Contact) => {
        if (!confirm(`Remove ${formatGhanaPhone(contact.phone)} from your list?`)) return
        const res = await fetch(`/api/sms/contacts?id=${contact.id}`, { method: 'DELETE' })
        if (!res.ok) { toast.error('Could not remove that customer'); return }
        toast.success('Removed')
        refresh()
    }

    const createGroup = async () => {
        const name = newGroupName.trim()
        if (!name) return
        setSaving(true)
        try {
            const res = await fetch('/api/sms/groups', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name }),
            })
            const data = await res.json()
            if (!res.ok || !data?.success) { toast.error(data?.error || 'Could not create group'); return }
            // Creating a group with customers ticked puts them straight in it.
            if (selectedIds.size) {
                await fetch('/api/sms/groups', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ groupId: data.group.id, addContactIds: [...selectedIds] }),
                })
            }
            toast.success(`Group "${name}" created`)
            setNewGroupName('')
            setGroupOpen(false)
            setSelectedIds(new Set())
            onGroupsChanged()
        } finally {
            setSaving(false)
        }
    }

    const addSelectedToGroup = async (groupId: string) => {
        if (!selectedIds.size) return
        const res = await fetch('/api/sms/groups', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ groupId, addContactIds: [...selectedIds] }),
        })
        const data = await res.json()
        if (!res.ok || !data?.success) { toast.error(data?.error || 'Could not add to group'); return }
        toast.success(`${selectedIds.size} added to group`)
        setSelectedIds(new Set())
        onGroupsChanged()
    }

    const removeSelectedFromGroup = async () => {
        if (!selectedIds.size || groupFilter === ALL) return
        await fetch('/api/sms/groups', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ groupId: groupFilter, removeContactIds: [...selectedIds] }),
        })
        toast.success('Removed from group')
        setSelectedIds(new Set())
        refresh()
    }

    const deleteGroup = async (group: SmsGroup) => {
        if (!confirm(`Delete the group "${group.name}"? The customers stay on your list.`)) return
        const res = await fetch(`/api/sms/groups?id=${group.id}`, { method: 'DELETE' })
        if (!res.ok) { toast.error('Could not delete group'); return }
        if (groupFilter === group.id) setGroupFilter(ALL)
        onGroupsChanged()
    }

    const toggleSelected = (id: string) => {
        setSelectedIds((prev) => {
            const next = new Set(prev)
            if (next.has(id)) next.delete(id)
            else next.add(id)
            return next
        })
    }

    const userGroups = groups.filter((g) => !g.system)
    const systemGroup = groups.find((g) => g.id === SUB_AGENTS_GROUP_ID)
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))

    return (
        <div className="space-y-4">
            <Card>
                <CardHeader>
                    <CardTitle className="text-base">Add customers</CardTitle>
                    <CardDescription>Duplicates are merged automatically, so it is safe to import the same list twice.</CardDescription>
                </CardHeader>
                <CardContent className="grid gap-2 grid-cols-2 sm:grid-cols-4">
                    <Button variant="outline" className="h-auto flex-col gap-1 py-3" onClick={importFromOrders} disabled={!hasShop || importing}>
                        {importing ? <Loader2 className="w-5 h-5 animate-spin" /> : <ShoppingCart className="w-5 h-5 text-emerald-600" />}
                        <span className="text-xs font-semibold">From my orders</span>
                    </Button>
                    <Button variant="outline" className="h-auto flex-col gap-1 py-3" onClick={() => setAddOpen(true)}>
                        <UserPlus className="w-5 h-5 text-emerald-600" />
                        <span className="text-xs font-semibold">Add one</span>
                    </Button>
                    <Button variant="outline" className="h-auto flex-col gap-1 py-3" onClick={() => setPasteOpen(true)}>
                        <ClipboardPaste className="w-5 h-5 text-emerald-600" />
                        <span className="text-xs font-semibold">Paste list</span>
                    </Button>
                    <Button variant="outline" className="h-auto flex-col gap-1 py-3" onClick={() => fileRef.current?.click()} disabled={saving}>
                        <Upload className="w-5 h-5 text-emerald-600" />
                        <span className="text-xs font-semibold">Upload CSV</span>
                    </Button>
                    <input ref={fileRef} type="file" accept=".csv,.txt,text/csv,text/plain" className="hidden" onChange={onFile} />
                </CardContent>
            </Card>

            <Card>
                <CardHeader className="pb-3">
                    <div className="flex items-center justify-between gap-2">
                        <CardTitle className="text-base flex items-center gap-2"><Users className="w-4 h-4" /> Groups</CardTitle>
                        <Button size="sm" variant="outline" className="gap-1" onClick={() => setGroupOpen(true)}>
                            <FolderPlus className="w-4 h-4" /> New group
                        </Button>
                    </div>
                </CardHeader>
                <CardContent className="flex flex-wrap gap-2">
                    {systemGroup && (
                        <span className="inline-flex items-center gap-1.5 rounded-full border border-teal-300 bg-teal-50 dark:bg-teal-950/30 px-3 py-1 text-xs font-semibold">
                            <Lock className="w-3 h-3" /> {systemGroup.name} · {systemGroup.memberCount}
                        </span>
                    )}
                    {userGroups.map((g) => (
                        <span key={g.id} className="inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold">
                            {g.name} · {g.memberCount}
                            <button type="button" onClick={() => deleteGroup(g)} className="text-muted-foreground hover:text-red-600" aria-label={`Delete ${g.name}`}>
                                <Trash2 className="w-3 h-3" />
                            </button>
                        </span>
                    ))}
                    {!systemGroup && !userGroups.length && (
                        <p className="text-xs text-muted-foreground">Group customers (e.g. &quot;VIP&quot;, &quot;Wholesale&quot;) to message them together.</p>
                    )}
                    {systemGroup && (
                        <p className="w-full text-[11px] text-muted-foreground">My Sub-Agents updates itself as sub-agents join or are suspended.</p>
                    )}
                </CardContent>
            </Card>

            <Card>
                <CardHeader className="pb-3">
                    <CardTitle className="text-base">Your customers ({total.toLocaleString()})</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                    <div className="flex flex-col sm:flex-row gap-2">
                        <div className="relative flex-1">
                            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                            <Input value={search} onChange={(e) => { setSearch(e.target.value); setPage(0) }} placeholder="Search number or name" className="pl-9" />
                        </div>
                        <Select value={groupFilter} onValueChange={(v) => { setGroupFilter(v); setPage(0); setSelectedIds(new Set()) }}>
                            <SelectTrigger className="sm:w-48"><SelectValue placeholder="All customers" /></SelectTrigger>
                            <SelectContent>
                                <SelectItem value={ALL}>All customers</SelectItem>
                                {userGroups.map((g) => <SelectItem key={g.id} value={g.id}>{g.name}</SelectItem>)}
                            </SelectContent>
                        </Select>
                    </div>

                    {selectedIds.size > 0 && (
                        <div className="flex flex-wrap items-center gap-2 rounded-xl bg-muted p-2 text-sm">
                            <span className="font-semibold">{selectedIds.size} selected</span>
                            {userGroups.length > 0 && (
                                <Select onValueChange={addSelectedToGroup}>
                                    <SelectTrigger className="h-8 w-44"><SelectValue placeholder="Add to group…" /></SelectTrigger>
                                    <SelectContent>
                                        {userGroups.map((g) => <SelectItem key={g.id} value={g.id}>{g.name}</SelectItem>)}
                                    </SelectContent>
                                </Select>
                            )}
                            {groupFilter !== ALL && (
                                <Button size="sm" variant="outline" className="h-8" onClick={removeSelectedFromGroup}>Remove from group</Button>
                            )}
                            <Button size="sm" variant="ghost" className="h-8" onClick={() => setSelectedIds(new Set())}>Clear</Button>
                        </div>
                    )}

                    {loading ? (
                        <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
                    ) : contacts.length === 0 ? (
                        <p className="text-sm text-muted-foreground text-center py-8">
                            {search || groupFilter !== ALL ? 'No customers match.' : 'No customers yet. Add some using the buttons above.'}
                        </p>
                    ) : (
                        <div className="divide-y rounded-xl border">
                            {contacts.map((c) => (
                                <div key={c.id} className="flex items-center gap-3 p-3">
                                    <Checkbox checked={selectedIds.has(c.id)} onCheckedChange={() => toggleSelected(c.id)} />
                                    <div className="flex-1 min-w-0">
                                        <p className="font-mono text-sm font-semibold">{formatGhanaPhone(c.phone)}</p>
                                        <p className="text-xs text-muted-foreground truncate">
                                            {c.name || 'No name'} · {c.source === 'order' ? 'from orders' : c.source === 'import' ? 'imported' : 'added'}
                                        </p>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        {c.opted_out && <Badge variant="outline" className="text-[10px]">Opted out</Badge>}
                                        <Switch checked={!c.opted_out} onCheckedChange={() => toggleOptOut(c)} aria-label="Receives SMS" />
                                        <button type="button" onClick={() => remove(c)} className="text-muted-foreground hover:text-red-600" aria-label="Remove">
                                            <Trash2 className="w-4 h-4" />
                                        </button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}

                    {pages > 1 && (
                        <div className="flex items-center justify-between text-sm">
                            <Button size="sm" variant="outline" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Previous</Button>
                            <span className="text-muted-foreground">Page {page + 1} of {pages}</span>
                            <Button size="sm" variant="outline" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>Next</Button>
                        </div>
                    )}
                    <p className="text-[11px] text-muted-foreground">Switch a customer off if they ask not to receive messages — they are skipped on every send.</p>
                </CardContent>
            </Card>

            <Dialog open={addOpen} onOpenChange={setAddOpen}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Add a customer</DialogTitle>
                        <DialogDescription>Any Ghana number — 055…, 024…, or 233….</DialogDescription>
                    </DialogHeader>
                    <div className="space-y-3">
                        <div className="space-y-2">
                            <Label>Phone number</Label>
                            <Input value={manualPhone} onChange={(e) => setManualPhone(e.target.value)} placeholder="0551234567" inputMode="tel" autoFocus />
                        </div>
                        <div className="space-y-2">
                            <Label>Name (optional)</Label>
                            <Input value={manualName} onChange={(e) => setManualName(e.target.value)} placeholder="Ama" />
                        </div>
                    </div>
                    <DialogFooter>
                        <Button onClick={addManual} disabled={saving || !manualPhone.trim()} className="bg-emerald-600 hover:bg-emerald-700">
                            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Add customer'}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <Dialog open={pasteOpen} onOpenChange={setPasteOpen}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Paste a list</DialogTitle>
                        <DialogDescription>One customer per line. Add a name after a comma if you have one.</DialogDescription>
                    </DialogHeader>
                    <Textarea
                        value={pasteText}
                        onChange={(e) => setPasteText(e.target.value)}
                        rows={8}
                        placeholder={'0551234567, Ama\n0209876543, Kofi\n0241112223'}
                        className="font-mono text-sm"
                    />
                    <p className="text-xs text-muted-foreground">{parseContactsText(pasteText).length} numbers found</p>
                    <DialogFooter>
                        <Button onClick={addPasted} disabled={saving || !pasteText.trim()} className="bg-emerald-600 hover:bg-emerald-700">
                            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Add all'}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <Dialog open={groupOpen} onOpenChange={setGroupOpen}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>New group</DialogTitle>
                        <DialogDescription>
                            {selectedIds.size ? `The ${selectedIds.size} customers you ticked will be added to it.` : 'Tick customers in the list to add them later.'}
                        </DialogDescription>
                    </DialogHeader>
                    <Input value={newGroupName} onChange={(e) => setNewGroupName(e.target.value)} placeholder="e.g. VIP customers" maxLength={60} autoFocus />
                    <DialogFooter>
                        <Button onClick={createGroup} disabled={saving || !newGroupName.trim()} className="bg-emerald-600 hover:bg-emerald-700">
                            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Create group'}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    )
}
