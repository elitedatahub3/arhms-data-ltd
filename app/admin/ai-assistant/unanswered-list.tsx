'use client'

import { useCallback, useEffect, useState } from 'react'
import { Check, HelpCircle, Loader2, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'

interface Row {
    id: string
    question: string
    surface: string
    created_at: string
}

/** Event the knowledge editor listens for to open a pre-filled new entry. */
export const KB_PREFILL_EVENT = 'arhms-ai-kb-prefill'

/** Questions ARHMS AI couldn't answer, with one-tap "Add to knowledge". */
export function UnansweredList({ canEdit }: { canEdit: boolean }) {
    const [rows, setRows] = useState<Row[]>([])
    const [ready, setReady] = useState(true)
    const [loading, setLoading] = useState(true)

    const load = useCallback(async () => {
        setLoading(true)
        try {
            const res = await fetch('/api/admin/ai-assistant/unanswered', { cache: 'no-store' })
            if (!res.ok) throw new Error()
            const data = await res.json()
            setRows(data.rows || [])
            setReady(data.ready)
        } catch {
            toast.error('Could not load unanswered questions')
        } finally {
            setLoading(false)
        }
    }, [])

    useEffect(() => { load() }, [load])

    const resolve = async (row: Row) => {
        const res = await fetch('/api/admin/ai-assistant/unanswered', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: row.id }),
        })
        if (!res.ok) {
            toast.error('Could not update')
            return
        }
        setRows(r => r.filter(x => x.id !== row.id))
    }

    const addToKnowledge = (row: Row) => {
        window.dispatchEvent(new CustomEvent(KB_PREFILL_EVENT, { detail: { question: row.question } }))
        resolve(row)
    }

    return (
        <div className="space-y-3 rounded-xl border border-border p-4">
            <div>
                <h2 className="flex items-center gap-2 text-lg font-bold">
                    <HelpCircle className="h-5 w-5 text-primary" /> Couldn&apos;t answer
                </h2>
                <p className="text-xs text-muted-foreground">
                    Real ARHMS questions the assistant had no answer for. Add an answer to the knowledge base, or make the page text clearer: the assistant re-reads every page on each deploy.
                </p>
            </div>

            {!ready ? (
                <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                    Run migration <code>20261118020000_ai_site_and_shop.sql</code> in Supabase to start collecting these.
                </p>
            ) : loading ? (
                <div className="flex justify-center py-4"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
            ) : rows.length === 0 ? (
                <p className="py-3 text-center text-sm text-muted-foreground">Nothing unanswered. 🎉</p>
            ) : (
                <ul className="divide-y divide-border">
                    {rows.map(r => (
                        <li key={r.id} className="flex items-start gap-3 py-3">
                            <div className="min-w-0 flex-1">
                                <p className="text-sm">{r.question}</p>
                                <p className="mt-0.5 text-[10px] text-muted-foreground">
                                    {r.surface} · {new Date(r.created_at).toLocaleString()}
                                </p>
                            </div>
                            {canEdit && (
                                <div className="flex shrink-0 gap-1">
                                    <Button size="sm" variant="outline" onClick={() => addToKnowledge(r)}>
                                        <Plus className="mr-1 h-3.5 w-3.5" /> Add answer
                                    </Button>
                                    <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => resolve(r)} aria-label="Dismiss">
                                        <Check className="h-4 w-4" />
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
