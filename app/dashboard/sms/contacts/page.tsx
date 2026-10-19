'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Users, Plus, FolderPlus, Pencil, Trash2, ChevronRight, Megaphone, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { parseContactsText, type SmsGroup } from '@/components/sms/sms-contacts'
import { SmsActiveGate, SmsPageHeader, useSmsPlatform } from '@/components/sms/platform/sms-platform-shell'
import { smsFetch } from '@/lib/sms/sms-fetch'

/**
 * Contact groups for the SMS Platform: reusable recipient lists, each opened
 * on its own page to add or remove numbers.
 */
export default function SmsContactGroupsPage() {
    const router = useRouter()
    const { groups, reload, reloadGroups } = useSmsPlatform()
    const [createOpen, setCreateOpen] = useState(false)
    const [renaming, setRenaming] = useState<SmsGroup | null>(null)
    const [deleting, setDeleting] = useState<SmsGroup | null>(null)

    const refresh = async () => { await Promise.all([reload(), reloadGroups()]) }

    return (
        <>
            <SmsPageHeader
                title="Contact Groups"
                description="Reusable recipient lists for your SMS campaigns."
                icon={Users}
                action={
                    <Button className="gap-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 font-bold shadow-sm" onClick={() => setCreateOpen(true)}>
                        <Plus className="w-4 h-4" /> New Group
                    </Button>
                }
            />

            <SmsActiveGate>
                {(info) => groups.length === 0 ? (
                    <div className="rounded-3xl border-2 border-dashed border-gray-200 bg-card px-6 py-14 text-center dark:border-zinc-800">
                        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-emerald-50 dark:bg-emerald-950/40">
                            <FolderPlus className="w-6 h-6 text-emerald-600" />
                        </div>
                        <p className="mt-4 font-bold">No contact groups yet</p>
                        <p className="mx-auto mt-1 max-w-xs text-sm text-muted-foreground">
                            Create a group like &quot;Customers&quot; or &quot;VIP list&quot;, add numbers once, then message them in one tap from the composer.
                        </p>
                        <Button className="mt-5 gap-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 font-bold" onClick={() => setCreateOpen(true)}>
                            <Plus className="w-4 h-4" /> Create your first group
                        </Button>
                    </div>
                ) : (
                    <div className="space-y-4">
                        <div className="grid grid-cols-2 gap-3">
                            <div className="rounded-2xl border border-emerald-200 bg-emerald-50/70 p-4 dark:border-emerald-900 dark:bg-emerald-950/30">
                                <p className="text-xs font-semibold text-muted-foreground">Groups</p>
                                <p className="mt-1 text-xl font-black">{groups.length.toLocaleString()}</p>
                            </div>
                            <div className="rounded-2xl border border-sky-200 bg-sky-50/70 p-4 dark:border-sky-900 dark:bg-sky-950/30">
                                <p className="text-xs font-semibold text-muted-foreground">Total contacts</p>
                                <p className="mt-1 text-xl font-black">{info.contactCount.toLocaleString()}</p>
                            </div>
                        </div>

                        <div className="space-y-2">
                            {groups.map((g) => {
                                const row = (
                                    <div className="flex items-center gap-3 rounded-2xl border bg-card p-3 shadow-sm transition-colors hover:border-emerald-300">
                                        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-50 dark:bg-emerald-950/40">
                                            <Users className="w-5 h-5 text-emerald-600" />
                                        </div>
                                        <div className="min-w-0 flex-1">
                                            <p className="truncate font-bold">{g.name}</p>
                                            <p className="text-xs text-muted-foreground">
                                                {g.memberCount.toLocaleString()} contact(s)
                                                {g.system ? ' · updates automatically' : g.createdAt ? ` · created ${new Date(g.createdAt).toLocaleDateString()}` : ''}
                                            </p>
                                        </div>
                                        {!g.system && (
                                            <>
                                                <Button size="icon" variant="ghost" aria-label={`Rename ${g.name}`}
                                                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); setRenaming(g) }}>
                                                    <Pencil className="w-4 h-4" />
                                                </Button>
                                                <Button size="icon" variant="ghost" aria-label={`Delete ${g.name}`}
                                                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); setDeleting(g) }}>
                                                    <Trash2 className="w-4 h-4" />
                                                </Button>
                                                <ChevronRight className="w-4 h-4 text-muted-foreground" />
                                            </>
                                        )}
                                    </div>
                                )
                                return g.system
                                    ? <div key={g.id}>{row}</div>
                                    : <Link key={g.id} href={`/dashboard/sms/contacts/${g.id}`} className="block">{row}</Link>
                            })}
                        </div>

                        <Link href="/dashboard/sms/compose" className="block">
                            <div className="flex items-center justify-center gap-2 rounded-2xl bg-muted/70 py-3 text-sm font-semibold transition-colors hover:bg-muted">
                                <Megaphone className="w-4 h-4 text-emerald-600" /> Compose a campaign with these groups
                            </div>
                        </Link>
                    </div>
                )}
            </SmsActiveGate>

            <CreateGroupDialog
                open={createOpen}
                onOpenChange={setCreateOpen}
                onCreated={async (id) => { await refresh(); router.push(`/dashboard/sms/contacts/${id}`) }}
            />
            <RenameGroupDialog group={renaming} onClose={() => setRenaming(null)} onSaved={refresh} />
            <DeleteGroupDialog group={deleting} onClose={() => setDeleting(null)} onDeleted={refresh} />
        </>
    )
}

function CreateGroupDialog({ open, onOpenChange, onCreated }: {
    open: boolean
    onOpenChange: (open: boolean) => void
    onCreated: (id: string) => void
}) {
    const [name, setName] = useState('')
    const [numbers, setNumbers] = useState('')
    const [saving, setSaving] = useState(false)

    const create = async () => {
        setSaving(true)
        try {
            const res = await smsFetch('/api/sms/groups', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: name.trim() }),
            })
            const data = await res.json()
            if (!res.ok || !data?.success) { toast.error(data?.error || 'Could not create the group'); return }

            const contacts = parseContactsText(numbers)
            if (contacts.length) {
                const addRes = await smsFetch('/api/sms/contacts', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ contacts, source: 'import', groupId: data.group.id }),
                })
                const added = await addRes.json()
                if (!addRes.ok || !added?.success) toast.error(added?.error || 'Group created, but the numbers could not be added')
                else toast.success(`Group created with ${added.grouped} contact(s)`)
            } else {
                toast.success('Group created')
            }

            setName('')
            setNumbers('')
            onOpenChange(false)
            onCreated(data.group.id)
        } catch {
            toast.error('Could not create the group')
        } finally {
            setSaving(false)
        }
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>New group</DialogTitle>
                    <DialogDescription>Name it, and paste numbers now or add them later.</DialogDescription>
                </DialogHeader>
                <div className="space-y-3">
                    <div className="space-y-1.5">
                        <Label htmlFor="group-name">Group name</Label>
                        <Input id="group-name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="e.g. VIP customers" />
                    </div>
                    <div className="space-y-1.5">
                        <Label htmlFor="group-numbers">Numbers (optional)</Label>
                        <Textarea id="group-numbers" rows={5} value={numbers} onChange={(e) => setNumbers(e.target.value)}
                            placeholder={'One per line, or "number, name"\n0244123456, Ama\n0201234567'} className="font-mono text-xs" />
                    </div>
                </div>
                <DialogFooter>
                    <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
                    <Button className="bg-emerald-600 hover:bg-emerald-700" disabled={saving || !name.trim()} onClick={create}>
                        {saving && <Loader2 className="w-4 h-4 animate-spin mr-1" />} Create group
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}

function RenameGroupDialog({ group, onClose, onSaved }: { group: SmsGroup | null; onClose: () => void; onSaved: () => void }) {
    const [name, setName] = useState('')
    const [saving, setSaving] = useState(false)

    useEffect(() => { if (group) setName(group.name) }, [group])

    const save = async () => {
        if (!group) return
        setSaving(true)
        try {
            const res = await smsFetch('/api/sms/groups', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ groupId: group.id, name: name.trim() }),
            })
            const data = await res.json()
            if (!res.ok || !data?.success) { toast.error(data?.error || 'Could not rename'); return }
            toast.success('Group renamed')
            onClose()
            onSaved()
        } finally {
            setSaving(false)
        }
    }

    return (
        <Dialog open={!!group} onOpenChange={(o) => { if (!o) onClose() }}>
            <DialogContent>
                <DialogHeader><DialogTitle>Rename group</DialogTitle></DialogHeader>
                <Input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
                <DialogFooter>
                    <Button variant="outline" onClick={onClose}>Cancel</Button>
                    <Button className="bg-emerald-600 hover:bg-emerald-700" disabled={saving || !name.trim()} onClick={save}>Save</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}

function DeleteGroupDialog({ group, onClose, onDeleted }: { group: SmsGroup | null; onClose: () => void; onDeleted: () => void }) {
    const [busy, setBusy] = useState(false)

    const remove = async () => {
        if (!group) return
        setBusy(true)
        try {
            const res = await smsFetch(`/api/sms/groups?id=${group.id}`, { method: 'DELETE' })
            const data = await res.json()
            if (!res.ok || !data?.success) { toast.error(data?.error || 'Could not delete'); return }
            toast.success('Group deleted')
            onClose()
            onDeleted()
        } finally {
            setBusy(false)
        }
    }

    return (
        <Dialog open={!!group} onOpenChange={(o) => { if (!o) onClose() }}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Delete &quot;{group?.name}&quot;?</DialogTitle>
                    <DialogDescription>The group is removed. The contacts in it stay saved in your contacts.</DialogDescription>
                </DialogHeader>
                <DialogFooter>
                    <Button variant="outline" onClick={onClose}>Cancel</Button>
                    <Button className="bg-red-600 hover:bg-red-700" disabled={busy} onClick={remove}>Delete group</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}
