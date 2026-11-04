'use client'

import { useCallback, useEffect, useState } from 'react'
import { CheckCircle2, Loader2, RefreshCw, Save, Send, Trophy, Undo2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { cn, formatCurrency } from '@/lib/utils'

type Board = 'dashboard' | 'shop'

interface Config {
    enabled: boolean
    rankingsOnly: boolean
    contactPhone: string
    prizes: Record<Board, [string, string, string]>
}

interface Winner {
    id: string
    month: string
    board: Board
    rank: number
    display_name: string
    total: number
    prize_label: string | null
    phone_number: string | null
    sms_sent_at: string | null
    sms_error: string | null
    claimed_at: string | null
}

interface PreviewEntry { rank: number; name: string; total: number }

const BOARD_LABEL: Record<Board, string> = { dashboard: 'Dashboard Sales', shop: 'Shop Sales' }
const PLACES = ['1st', '2nd', '3rd']

function monthLabel(month: string) {
    const [y, m] = month.slice(0, 7).split('-').map(Number)
    return new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' })
}

export default function AdminTopPerformersPage() {
    const [config, setConfig] = useState<Config | null>(null)
    const [winners, setWinners] = useState<Winner[]>([])
    const [preview, setPreview] = useState<Record<Board, PreviewEntry[]> | null>(null)
    const [loading, setLoading] = useState(true)
    const [saving, setSaving] = useState(false)
    const [busy, setBusy] = useState<string | null>(null)

    const load = useCallback(async () => {
        setLoading(true)
        try {
            const [adminRes, boardRes] = await Promise.all([
                fetch('/api/admin/top-performers', { cache: 'no-store' }),
                fetch('/api/top-performers', { cache: 'no-store' }),
            ])
            const adminBody = await adminRes.json()
            if (!adminRes.ok) throw new Error(adminBody.error || 'Failed to load settings')
            setConfig(adminBody.config)
            setWinners(adminBody.winners || [])

            const boardBody = await boardRes.json().catch(() => null)
            if (boardRes.ok && boardBody?.boards) setPreview(boardBody.boards)
            else if (boardBody?.error) toast.error(`Preview: ${boardBody.error}`)
        } catch (e: any) {
            toast.error(e.message || 'Failed to load')
        } finally {
            setLoading(false)
        }
    }, [])

    useEffect(() => { load() }, [load])

    const setPrize = (board: Board, index: number, value: string) => {
        setConfig(c => {
            if (!c) return c
            const list = [...c.prizes[board]] as [string, string, string]
            list[index] = value
            return { ...c, prizes: { ...c.prizes, [board]: list } }
        })
    }

    const save = async () => {
        if (!config) return
        if (config.enabled && !config.rankingsOnly && !config.contactPhone.trim()) {
            toast.error('Add the contact phone winners should call before turning rewards on')
            return
        }
        setSaving(true)
        try {
            const res = await fetch('/api/admin/top-performers', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(config),
            })
            const body = await res.json()
            if (!res.ok) throw new Error(body.error || 'Save failed')
            toast.success('Top Performers settings saved')
        } catch (e: any) {
            toast.error(e.message || 'Save failed')
        } finally {
            setSaving(false)
        }
    }

    const act = async (id: string, action: 'resend-sms' | 'mark-claimed' | 'unmark-claimed') => {
        setBusy(`${id}:${action}`)
        try {
            const res = await fetch('/api/admin/top-performers', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id, action }),
            })
            const body = await res.json()
            if (!res.ok) throw new Error(body.error || 'Action failed')
            toast.success(action === 'resend-sms' ? 'SMS sent' : action === 'mark-claimed' ? 'Marked as claimed' : 'Claim undone')
            await load()
        } catch (e: any) {
            toast.error(e.message || 'Action failed')
        } finally {
            setBusy(null)
        }
    }

    if (loading && !config) {
        return <div className="flex justify-center p-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
    }
    if (!config) return null

    const months = Array.from(new Set(winners.map(w => w.month)))

    return (
        <div className="space-y-6">
            <div className="flex items-start justify-between gap-4">
                <div>
                    <h1 className="flex items-center gap-2 text-2xl font-black tracking-tight">
                        <Trophy className="h-6 w-6 text-amber-500" /> Top Performers
                    </h1>
                    <p className="mt-1 text-sm text-muted-foreground">
                        Monthly leaderboards for dashboard + API sales and shop (storefront + USSD) sales. On the 1st of
                        each month the top 3 of each board are frozen and texted to contact you for their reward.
                        You pay rewards by hand.
                    </p>
                </div>
                <Button variant="outline" size="icon" onClick={load} disabled={loading} aria-label="Reload">
                    <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
                </Button>
            </div>

            {/* Settings */}
            <section className="card-premium space-y-5 p-4 sm:p-6">
                <h2 className="text-lg font-bold">Settings</h2>
                <div className="grid gap-4 sm:grid-cols-2">
                    <div className="flex items-start justify-between gap-4 rounded-xl border border-border p-4">
                        <div>
                            <p className="font-semibold">Leaderboard on</p>
                            <p className="text-xs text-muted-foreground">Shows the Top Performers page and nav link to every user.</p>
                        </div>
                        <Switch checked={config.enabled} onCheckedChange={v => setConfig({ ...config, enabled: v })} />
                    </div>
                    <div className="flex items-start justify-between gap-4 rounded-xl border border-border p-4">
                        <div>
                            <p className="font-semibold">Rankings only</p>
                            <p className="text-xs text-muted-foreground">Hides prizes and sends no winner SMS. A month that closes while this is on never gets winner SMS.</p>
                        </div>
                        <Switch checked={config.rankingsOnly} onCheckedChange={v => setConfig({ ...config, rankingsOnly: v })} />
                    </div>
                </div>

                <div className="max-w-sm space-y-1.5">
                    <Label htmlFor="tp-contact">Contact phone in the winner SMS</Label>
                    <Input
                        id="tp-contact"
                        value={config.contactPhone}
                        maxLength={20}
                        placeholder="e.g. 0241234567"
                        onChange={e => setConfig({ ...config, contactPhone: e.target.value })}
                    />
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                    {(['dashboard', 'shop'] as Board[]).map(board => (
                        <div key={board} className="space-y-3 rounded-xl border border-border p-4">
                            <p className="font-semibold">{BOARD_LABEL[board]} prizes</p>
                            {PLACES.map((place, i) => (
                                <div key={place} className="flex items-center gap-3">
                                    <span className="w-10 text-sm font-bold text-muted-foreground">{place}</span>
                                    <Input
                                        value={config.prizes[board][i]}
                                        maxLength={60}
                                        placeholder={i === 0 ? 'e.g. GHS 150 wallet top-up' : 'Leave empty for no prize'}
                                        onChange={e => setPrize(board, i, e.target.value)}
                                    />
                                </div>
                            ))}
                        </div>
                    ))}
                </div>

                <Button onClick={save} disabled={saving} className="font-bold">
                    {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                    Save settings
                </Button>
            </section>

            {/* Live preview */}
            <section className="card-premium p-4 sm:p-6">
                <h2 className="text-lg font-bold">This month so far</h2>
                <p className="text-xs text-muted-foreground">Refreshes every 5 minutes. Admin accounts never rank.</p>
                {!preview ? (
                    <p className="mt-4 text-sm text-muted-foreground">Preview unavailable. Has migration 20261104000000_top_performers been run?</p>
                ) : (
                    <div className="mt-4 grid gap-4 md:grid-cols-2">
                        {(['dashboard', 'shop'] as Board[]).map(board => (
                            <div key={board} className="rounded-xl border border-border p-3">
                                <p className="mb-2 text-sm font-bold">{BOARD_LABEL[board]}</p>
                                {preview[board].length === 0 ? (
                                    <p className="text-sm text-muted-foreground">No completed sales yet.</p>
                                ) : (
                                    <ol className="space-y-1 text-sm">
                                        {preview[board].slice(0, 10).map(e => (
                                            <li key={e.rank} className="flex justify-between gap-3">
                                                <span className="truncate"><span className="font-bold text-muted-foreground">#{e.rank}</span> {e.name}</span>
                                                <span className="tabular-nums text-muted-foreground">{formatCurrency(e.total)}</span>
                                            </li>
                                        ))}
                                    </ol>
                                )}
                            </div>
                        ))}
                    </div>
                )}
            </section>

            {/* Winners */}
            <section className="card-premium p-4 sm:p-6">
                <h2 className="text-lg font-bold">Winners</h2>
                <p className="text-xs text-muted-foreground">
                    Frozen by the daily cron (/api/cron/top-performers-winners) on the first run of each month.
                </p>
                {months.length === 0 ? (
                    <p className="mt-4 text-sm text-muted-foreground">No month has been finalised yet.</p>
                ) : months.map(month => (
                    <div key={month} className="mt-5">
                        <p className="mb-2 font-semibold">{monthLabel(month)}</p>
                        <div className="overflow-x-auto rounded-xl border border-border">
                            <table className="w-full min-w-[720px] text-sm">
                                <thead className="bg-secondary/50 text-left text-xs uppercase text-muted-foreground">
                                    <tr>
                                        <th className="px-3 py-2">Board</th>
                                        <th className="px-3 py-2">Place</th>
                                        <th className="px-3 py-2">Seller</th>
                                        <th className="px-3 py-2">Sales</th>
                                        <th className="px-3 py-2">Prize</th>
                                        <th className="px-3 py-2">SMS</th>
                                        <th className="px-3 py-2">Claimed</th>
                                        <th className="px-3 py-2" />
                                    </tr>
                                </thead>
                                <tbody>
                                    {winners.filter(w => w.month === month).map(w => (
                                        <tr key={w.id} className="border-t border-border">
                                            <td className="px-3 py-2">{BOARD_LABEL[w.board]}</td>
                                            <td className="px-3 py-2 font-bold">#{w.rank}</td>
                                            <td className="px-3 py-2">
                                                {w.display_name}
                                                {w.phone_number && <span className="block text-xs text-muted-foreground">{w.phone_number}</span>}
                                            </td>
                                            <td className="px-3 py-2 tabular-nums">{formatCurrency(Number(w.total))}</td>
                                            <td className="px-3 py-2">{w.prize_label || <span className="text-muted-foreground">None</span>}</td>
                                            <td className="px-3 py-2">
                                                {w.sms_sent_at ? (
                                                    <span className="text-emerald-600">Sent {new Date(w.sms_sent_at).toLocaleDateString('en-GB')}</span>
                                                ) : w.sms_error ? (
                                                    <span className="text-red-600" title={w.sms_error}>Failed: {w.sms_error}</span>
                                                ) : w.prize_label ? (
                                                    <span className="text-amber-600">Not sent</span>
                                                ) : (
                                                    <span className="text-muted-foreground">-</span>
                                                )}
                                            </td>
                                            <td className="px-3 py-2">
                                                {w.claimed_at ? <span className="text-emerald-600">{new Date(w.claimed_at).toLocaleDateString('en-GB')}</span> : 'No'}
                                            </td>
                                            <td className="px-3 py-2">
                                                <div className="flex justify-end gap-2">
                                                    {w.prize_label && (
                                                        <Button size="sm" variant="outline" disabled={!!busy} onClick={() => act(w.id, 'resend-sms')}>
                                                            {busy === `${w.id}:resend-sms` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                                                            <span className="ml-1.5">{w.sms_sent_at ? 'Resend' : 'Send'} SMS</span>
                                                        </Button>
                                                    )}
                                                    {w.claimed_at ? (
                                                        <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => act(w.id, 'unmark-claimed')}>
                                                            <Undo2 className="h-3.5 w-3.5" /><span className="ml-1.5">Undo</span>
                                                        </Button>
                                                    ) : (
                                                        <Button size="sm" disabled={!!busy} onClick={() => act(w.id, 'mark-claimed')}>
                                                            <CheckCircle2 className="h-3.5 w-3.5" /><span className="ml-1.5">Mark claimed</span>
                                                        </Button>
                                                    )}
                                                </div>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>
                ))}
            </section>
        </div>
    )
}
