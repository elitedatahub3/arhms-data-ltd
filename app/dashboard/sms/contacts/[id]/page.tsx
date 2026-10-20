'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { Users, UserPlus, X, Loader2, Megaphone, Upload } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'
import { Skeleton } from '@/components/ui/skeleton'
import { parseContactsText, formatGhanaPhone } from '@/components/sms/sms-contacts'
import { SmsActiveGate, SmsPageHeader, useSmsPlatform } from '@/components/sms/platform/sms-platform-shell'
import { smsFetch } from '@/lib/sms/sms-fetch'

interface Member {
    id: string
    phone: string
    name: string | null
    opted_out: boolean
}

const PAGE_SIZE = 100

/** One contact group: add numbers to it, see who is in it, take people out. */
export default function SmsContactGroupPage() {
    const { id } = useParams<{ id: string }>()
    const { groups, reload, reloadGroups } = useSmsPlatform()
    const group = groups.find((g) => g.id === id)

    const [members, setMembers] = useState<Member[]>([])
    const [total, setTotal] = useState(0)
    const [page, setPage] = useState(0)
    const [loading, setLoading] = useState(true)
    const [numbers, setNumbers] = useState('')
    const [adding, setAdding] = useState(false)
    const [removingId, setRemovingId] = useState<string | null>(null)

    const load = useCallback(async () => {
        try {
            const res = await smsFetch(`/api/sms/contacts?groupId=${id}&page=${page}`, { cache: 'no-store' })
            const data = await res.json()
            if (data?.success) {
                setMembers(data.contacts)
                setTotal(data.total)
            } else {
                toast.error(data?.error || 'Could not load this group')
            }
        } catch {
            toast.error('Could not load this group')
        } finally {
            setLoading(false)
        }
    }, [id, page])

    useEffect(() => { load() }, [load])

    const afterChange = async () => { await Promise.all([load(), reload(), reloadGroups()]) }

    const addNumbers = async () => {
        const contacts = parseContactsText(numbers)
        if (!contacts.length) { toast.error('Paste at least one number'); return }
        setAdding(true)
        try {
            const res = await smsFetch('/api/sms/contacts', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ contacts, source: 'import', groupId: id }),
            })
            const data = await res.json()
            if (!res.ok || !data?.success) { toast.error(data?.error || 'Could not add those numbers'); return }
            const invalid = (data.invalid || []).length
            toast.success(`${data.grouped} contact(s) in the group${invalid ? ` · ${invalid} invalid number(s) skipped` : ''}`)
            setNumbers('')
            afterChange()
        } finally {
            setAdding(false)
        }
    }

    const onFile = async (file: File | undefined) => {
        if (!file) return
        const text = await file.text()
        setNumbers((prev) => (prev ? `${prev}\n${text}` : text))
    }

    const removeMember = async (member: Member) => {
        setRemovingId(member.id)
        try {
            const res = await smsFetch('/api/sms/groups', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ groupId: id, removeContactIds: [member.id] }),
            })
            const data = await res.json()
            if (!res.ok || !data?.success) { toast.error(data?.error || 'Could not remove'); return }
            afterChange()
        } finally {
            setRemovingId(null)
        }
    }

    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))

    return (
        <>
            <SmsPageHeader
                title={group?.name ?? 'Contact group'}
                description={`${total.toLocaleString()} contact(s) in this group`}
                icon={Users}
                backHref="/dashboard/sms/contacts"
                backLabel="Contact Groups"
                action={
                    <Link href="/dashboard/sms/compose">
                        <Button variant="outline" className="gap-1.5 rounded-xl"><Megaphone className="w-4 h-4 text-emerald-600" /> Send to group</Button>
                    </Link>
                }
            />

            <SmsActiveGate>
                {() => (
                    <div className="space-y-4">
                        <Card>
                            <CardHeader className="pb-3">
                                <CardTitle className="text-base flex items-center gap-2"><UserPlus className="w-4 h-4 text-emerald-600" /> Add numbers</CardTitle>
                                <CardDescription>Paste numbers, one per line or separated by commas. Add a name after a comma: <span className="font-mono">0244123456, Ama</span>.</CardDescription>
                            </CardHeader>
                            <CardContent className="space-y-3">
                                <Textarea rows={5} value={numbers} onChange={(e) => setNumbers(e.target.value)} className="font-mono text-xs"
                                    placeholder={'0244123456, Ama\n0201234567\n233551234567'} />
                                <div className="flex flex-wrap gap-2">
                                    <Button className="gap-1.5 bg-emerald-600 hover:bg-emerald-700" disabled={adding || !numbers.trim()} onClick={addNumbers}>
                                        {adding ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserPlus className="w-4 h-4" />} Add to group
                                    </Button>
                                    <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted">
                                        <Upload className="w-4 h-4" /> Import CSV / text
                                        <input type="file" accept=".csv,.txt,text/csv,text/plain" className="hidden"
                                            onChange={(e) => { onFile(e.target.files?.[0]); e.target.value = '' }} />
                                    </label>
                                </div>
                            </CardContent>
                        </Card>

                        <Card>
                            <CardHeader className="pb-2">
                                <CardTitle className="text-base">Members</CardTitle>
                            </CardHeader>
                            <CardContent className="space-y-1">
                                {loading ? (
                                    <Skeleton className="h-32 w-full" />
                                ) : members.length === 0 ? (
                                    <p className="py-8 text-center text-sm text-muted-foreground">No one in this group yet. Add numbers above.</p>
                                ) : (
                                    <>
                                        {members.map((m) => (
                                            <div key={m.id} className="flex items-center gap-3 rounded-xl px-2 py-2 hover:bg-muted/50">
                                                <div className="min-w-0 flex-1">
                                                    <p className="font-mono text-sm">{formatGhanaPhone(m.phone)}</p>
                                                    {(m.name || m.opted_out) && (
                                                        <p className="text-xs text-muted-foreground">
                                                            {m.name}{m.name && m.opted_out ? ' · ' : ''}{m.opted_out && <span className="text-amber-600">opted out — not messaged</span>}
                                                        </p>
                                                    )}
                                                </div>
                                                <Button size="icon" variant="ghost" aria-label="Remove from group" disabled={removingId === m.id} onClick={() => removeMember(m)}>
                                                    {removingId === m.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <X className="w-4 h-4" />}
                                                </Button>
                                            </div>
                                        ))}
                                        {pages > 1 && (
                                            <div className="flex items-center justify-between pt-3 text-xs text-muted-foreground">
                                                <Button size="sm" variant="outline" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Previous</Button>
                                                <span>Page {page + 1} of {pages}</span>
                                                <Button size="sm" variant="outline" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>Next</Button>
                                            </div>
                                        )}
                                    </>
                                )}
                            </CardContent>
                        </Card>
                    </div>
                )}
            </SmsActiveGate>
        </>
    )
}
