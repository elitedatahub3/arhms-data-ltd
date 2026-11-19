'use client'

import { useCallback, useEffect, useState } from 'react'
import { BookOpen, Loader2, Pencil, Plus, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { KB_PREFILL_EVENT } from './unanswered-list'

type Surface = 'dashboard' | 'home' | 'storefront' | 'admin' | 'whatsapp'

interface Row {
    id: string
    category: string
    question: string
    answer: string
    contexts: Surface[]
    is_active: boolean
}

type Draft = Omit<Row, 'id'> & { id?: string }

const SURFACES: { value: Surface; label: string }[] = [
    { value: 'dashboard', label: 'Dashboard' },
    { value: 'home', label: 'Public site' },
    { value: 'storefront', label: 'Shops' },
    { value: 'whatsapp', label: 'WhatsApp' },
    { value: 'admin', label: 'Admin' },
]

const EMPTY: Draft = {
    category: '',
    question: '',
    answer: '',
    contexts: ['dashboard', 'home', 'storefront', 'whatsapp'],
    is_active: true,
}

/** Knowledge base the assistant searches (search_knowledge tool). */
export function KnowledgeEditor({ canEdit }: { canEdit: boolean }) {
    const [rows, setRows] = useState<Row[]>([])
    const [ready, setReady] = useState(true)
    const [loading, setLoading] = useState(true)
    const [draft, setDraft] = useState<Draft | null>(null)
    const [saving, setSaving] = useState(false)

    const load = useCallback(async () => {
        setLoading(true)
        try {
            const res = await fetch('/api/admin/ai-assistant/knowledge', { cache: 'no-store' })
            if (!res.ok) throw new Error()
            const data = await res.json()
            setRows(data.rows || [])
            setReady(data.ready)
        } catch {
            toast.error('Could not load the knowledge base')
        } finally {
            setLoading(false)
        }
    }, [])

    useEffect(() => { load() }, [load])

    // "Add answer" on the Couldn't-answer list opens a new entry with the question filled in.
    useEffect(() => {
        const onPrefill = (e: Event) => {
            const question = String((e as CustomEvent).detail?.question || '').slice(0, 300)
            setDraft({ ...EMPTY, category: 'faq', question })
            document.getElementById('kb-a')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
        }
        window.addEventListener(KB_PREFILL_EVENT, onPrefill)
        return () => window.removeEventListener(KB_PREFILL_EVENT, onPrefill)
    }, [])

    const save = async () => {
        if (!draft) return
        if (!draft.contexts.length) {
            toast.error('Pick at least one place it applies to')
            return
        }
        setSaving(true)
        try {
            const res = await fetch('/api/admin/ai-assistant/knowledge', {
                method: draft.id ? 'PATCH' : 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(draft),
            })
            const data = await res.json().catch(() => ({}))
            if (!res.ok) throw new Error(data.error || 'Save failed')
            toast.success(draft.id ? 'Entry updated' : 'Entry added')
            setDraft(null)
            load()
        } catch (e: any) {
            toast.error(e?.message || 'Save failed')
        } finally {
            setSaving(false)
        }
    }

    const remove = async (row: Row) => {
        if (!confirm(`Delete "${row.question}"?`)) return
        const res = await fetch(`/api/admin/ai-assistant/knowledge?id=${row.id}`, { method: 'DELETE' })
        if (!res.ok) {
            toast.error('Delete failed')
            return
        }
        toast.success('Entry deleted')
        load()
    }

    const toggleSurface = (s: Surface) => {
        if (!draft) return
        const has = draft.contexts.includes(s)
        setDraft({ ...draft, contexts: has ? draft.contexts.filter(c => c !== s) : [...draft.contexts, s] })
    }

    return (
        <div className="space-y-4 rounded-xl border border-border p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                    <h2 className="flex items-center gap-2 text-lg font-bold">
                        <BookOpen className="h-5 w-5 text-primary" /> Knowledge base
                    </h2>
                    <p className="text-xs text-muted-foreground">
                        Facts and policies ARHMS AI searches before answering. Keep prices and fees out: it reads those live.
                    </p>
                </div>
                {canEdit && !draft && (
                    <Button size="sm" onClick={() => setDraft({ ...EMPTY })} disabled={!ready}>
                        <Plus className="mr-2 h-4 w-4" /> Add entry
                    </Button>
                )}
            </div>

            {!ready && (
                <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                    Run migration <code>20261118010000_ai_knowledge.sql</code> in Supabase. Until then ARHMS AI falls back to its built-in help text.
                </p>
            )}

            {draft && (
                <div className="space-y-3 rounded-lg border border-primary/40 bg-primary/5 p-3">
                    <div className="grid gap-3 sm:grid-cols-[180px_1fr]">
                        <div className="space-y-1">
                            <Label htmlFor="kb-cat">Category</Label>
                            <Input id="kb-cat" maxLength={60} value={draft.category} onChange={e => setDraft({ ...draft, category: e.target.value })} placeholder="refunds" />
                        </div>
                        <div className="space-y-1">
                            <Label htmlFor="kb-q">Question</Label>
                            <Input id="kb-q" maxLength={300} value={draft.question} onChange={e => setDraft({ ...draft, question: e.target.value })} placeholder="How do refunds work?" />
                        </div>
                    </div>
                    <div className="space-y-1">
                        <Label htmlFor="kb-a">Answer</Label>
                        <Textarea id="kb-a" rows={4} maxLength={2000} value={draft.answer} onChange={e => setDraft({ ...draft, answer: e.target.value })} />
                        <p className="text-right text-xs text-muted-foreground">{draft.answer.length}/2000</p>
                    </div>
                    <div className="space-y-1">
                        <Label>Applies to</Label>
                        <div className="flex flex-wrap gap-2">
                            {SURFACES.map(s => (
                                <button
                                    key={s.value}
                                    type="button"
                                    onClick={() => toggleSurface(s.value)}
                                    className={cn(
                                        'rounded-full border px-3 py-1 text-xs font-medium transition',
                                        draft.contexts.includes(s.value) ? 'border-primary bg-primary text-primary-foreground' : 'border-border',
                                    )}
                                >
                                    {s.label}
                                </button>
                            ))}
                        </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-3">
                        <label className="flex items-center gap-2 text-sm">
                            <Switch checked={draft.is_active} onCheckedChange={v => setDraft({ ...draft, is_active: v })} /> Active
                        </label>
                        <div className="ml-auto flex gap-2">
                            <Button variant="ghost" size="sm" onClick={() => setDraft(null)}>
                                <X className="mr-1 h-4 w-4" /> Cancel
                            </Button>
                            <Button size="sm" onClick={save} disabled={saving}>
                                {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Save
                            </Button>
                        </div>
                    </div>
                </div>
            )}

            {loading ? (
                <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
            ) : ready && rows.length === 0 ? (
                <p className="py-4 text-center text-sm text-muted-foreground">No entries yet.</p>
            ) : (
                <ul className="divide-y divide-border">
                    {rows.map(r => (
                        <li key={r.id} className={cn('flex gap-3 py-3', !r.is_active && 'opacity-50')}>
                            <div className="min-w-0 flex-1">
                                <p className="text-sm font-semibold">
                                    <span className="mr-2 rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">{r.category}</span>
                                    {r.question}
                                </p>
                                <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{r.answer}</p>
                                <p className="mt-1 text-[10px] text-muted-foreground">
                                    {r.contexts.map(c => SURFACES.find(s => s.value === c)?.label || c).join(' · ')}
                                    {!r.is_active && ' · inactive'}
                                </p>
                            </div>
                            {canEdit && (
                                <div className="flex shrink-0 items-start gap-1">
                                    <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setDraft({ ...r })} aria-label="Edit">
                                        <Pencil className="h-4 w-4" />
                                    </Button>
                                    <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={() => remove(r)} aria-label="Delete">
                                        <Trash2 className="h-4 w-4" />
                                    </Button>
                                </div>
                            )}
                        </li>
                    ))}
                </ul>
            )}
        </div>
    )
}
