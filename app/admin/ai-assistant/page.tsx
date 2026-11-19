'use client'

import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Loader2, RefreshCw, Save, Sparkles } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import { KnowledgeEditor } from './knowledge-editor'
import { UnansweredList } from './unanswered-list'

type Mode = 'off' | 'admins' | 'all'

const MODELS = [
    { value: 'deepseek-chat', label: 'DeepSeek Chat', hint: 'Fast, recommended' },
    { value: 'deepseek-reasoner', label: 'DeepSeek Reasoner', hint: 'Thinks first: slower, more tokens' },
]

interface Usage {
    questions: number
    users: number
    inputTokens: number
    outputTokens: number
    estUsd: number
}

interface Status {
    mode: Mode
    usage: { dashboardLimit: number; dashboardPrice: number; shopLimit: number; shopPrice: number }
    resetRevenue: { dashboard: { count: number; ghs: number }; shop: { count: number; ghs: number } }
    globalDailyLimit: number
    keyConfigured: boolean
    canEdit: boolean
    model: string
    tableReady: boolean
    today: Usage
    week: Usage
}

const MODES: { value: Mode; label: string; hint: string }[] = [
    { value: 'off', label: 'Off', hint: 'Hidden for everyone' },
    { value: 'admins', label: 'Admins only', hint: 'Admins and sub-admins test it' },
    { value: 'all', label: 'Everyone', hint: 'All dashboard users (not sub-agents)' },
]

function UsageCard({ title, u }: { title: string; u: Usage }) {
    return (
        <div className="rounded-xl border border-border p-4">
            <p className="text-sm font-semibold text-muted-foreground">{title}</p>
            <div className="mt-3 grid grid-cols-3 gap-3">
                <div>
                    <p className="text-2xl font-black">{u.questions}</p>
                    <p className="text-xs text-muted-foreground">questions</p>
                </div>
                <div>
                    <p className="text-2xl font-black">{u.users}</p>
                    <p className="text-xs text-muted-foreground">users</p>
                </div>
                <div>
                    <p className="text-2xl font-black">${u.estUsd.toFixed(2)}</p>
                    <p className="text-xs text-muted-foreground">est. cost</p>
                </div>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
                {u.inputTokens.toLocaleString()} input / {u.outputTokens.toLocaleString()} output tokens
            </p>
        </div>
    )
}

export default function AdminAiAssistantPage() {
    const [status, setStatus] = useState<Status | null>(null)
    const [mode, setMode] = useState<Mode>('off')
    const [limit, setLimit] = useState('100')
    const [price, setPrice] = useState('5')
    const [shopLimit, setShopLimit] = useState('300')
    const [shopPrice, setShopPrice] = useState('7')
    const [globalLimit, setGlobalLimit] = useState('3000')
    const [model, setModel] = useState('deepseek-chat')
    const [loading, setLoading] = useState(true)
    const [saving, setSaving] = useState(false)

    const load = useCallback(async () => {
        setLoading(true)
        try {
            const res = await fetch('/api/admin/ai-assistant', { cache: 'no-store' })
            if (!res.ok) throw new Error()
            const data: Status = await res.json()
            setStatus(data)
            setMode(data.mode)
            setLimit(String(data.usage.dashboardLimit))
            setPrice(String(data.usage.dashboardPrice))
            setShopLimit(String(data.usage.shopLimit))
            setShopPrice(String(data.usage.shopPrice))
            setGlobalLimit(String(data.globalDailyLimit ?? 3000))
            setModel(data.model)
        } catch {
            toast.error('Could not load ARHMS AI settings')
        } finally {
            setLoading(false)
        }
    }, [])

    useEffect(() => { load() }, [load])

    const save = async () => {
        const n = parseInt(limit, 10)
        const sn = parseInt(shopLimit, 10)
        if (![n, sn].every(v => Number.isFinite(v) && v >= 1 && v <= 100000)) {
            toast.error('Monthly limits must be between 1 and 100000 questions')
            return
        }
        const p = parseFloat(price)
        const sp = parseFloat(shopPrice)
        if (![p, sp].every(v => Number.isFinite(v) && v >= 0 && v <= 1000)) {
            toast.error('Reset prices must be between GHS 0 and GHS 1000')
            return
        }
        const g = parseInt(globalLimit, 10)
        if (!Number.isFinite(g) || g < 1 || g > 100000) {
            toast.error('Platform daily limit must be between 1 and 100000')
            return
        }
        setSaving(true)
        try {
            const res = await fetch('/api/admin-settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    updates: [
                        { key: 'ai_assistant_mode', value: mode },
                        { key: 'ai_dashboard_monthly_limit', value: String(n) },
                        { key: 'ai_dashboard_reset_price', value: p.toFixed(2) },
                        { key: 'ai_shop_monthly_limit', value: String(sn) },
                        { key: 'ai_shop_reset_price', value: sp.toFixed(2) },
                        { key: 'ai_assistant_global_daily_limit', value: String(g) },
                        { key: 'ai_model_dashboard', value: model },
                    ],
                }),
            })
            if (res.status === 403) throw new Error('Only admins can change this')
            if (!res.ok) throw new Error('Save failed')
            toast.success('ARHMS AI settings saved')
            load()
        } catch (e: any) {
            toast.error(e?.message || 'Save failed')
        } finally {
            setSaving(false)
        }
    }

    return (
        <div className="space-y-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                    <h1 className="flex items-center gap-2 text-2xl font-black tracking-tight">
                        <Sparkles className="h-6 w-6 text-primary" /> ARHMS AI
                    </h1>
                    <p className="text-sm text-muted-foreground">
                        In-app assistant: answers wallet, order and price questions and shows bundle cards. It never buys on its own.
                    </p>
                </div>
                <Button variant="outline" size="sm" onClick={load} disabled={loading}>
                    <RefreshCw className={cn('mr-2 h-4 w-4', loading && 'animate-spin')} /> Refresh
                </Button>
            </div>

            {status && (!status.keyConfigured || !status.tableReady) && (
                <div className="flex gap-3 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
                    <AlertTriangle className="h-5 w-5 shrink-0" />
                    <div className="space-y-1">
                        {!status.tableReady && <p>Run migration <code>20261118000000_ai_assistant.sql</code> in Supabase first.</p>}
                        {!status.keyConfigured && <p>Set <code>DEEPSEEK_API_KEY</code> in Vercel and redeploy — until then every question answers &quot;busy&quot;.</p>}
                    </div>
                </div>
            )}

            <div className="space-y-4 rounded-xl border border-border p-4">
                <div className="space-y-2">
                    <Label>Who can use it</Label>
                    <div className="grid gap-2 sm:grid-cols-3">
                        {MODES.map(m => (
                            <button
                                key={m.value}
                                type="button"
                                onClick={() => setMode(m.value)}
                                className={cn(
                                    'rounded-xl border p-3 text-left transition',
                                    mode === m.value ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'border-border hover:border-primary/50',
                                )}
                            >
                                <p className="font-semibold">{m.label}</p>
                                <p className="text-xs text-muted-foreground">{m.hint}</p>
                            </button>
                        ))}
                    </div>
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-2">
                        <Label htmlFor="ai-limit">Questions per user per month</Label>
                        <Input id="ai-limit" type="number" min={1} max={100000} value={limit} onChange={e => setLimit(e.target.value)} />
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor="ai-price">User reset price (GHS)</Label>
                        <Input id="ai-price" type="number" min={0} step="0.5" value={price} onChange={e => setPrice(e.target.value)} />
                        <p className="text-xs text-muted-foreground">When a user runs out, paying this adds another {limit || '…'} questions for the month.</p>
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor="ai-shop-limit">Questions per shop per month</Label>
                        <Input id="ai-shop-limit" type="number" min={1} max={100000} value={shopLimit} onChange={e => setShopLimit(e.target.value)} />
                        <p className="text-xs text-muted-foreground">Shared by all customers of one storefront.</p>
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor="ai-shop-price">Shop reset price (GHS)</Label>
                        <Input id="ai-shop-price" type="number" min={0} step="0.5" value={shopPrice} onChange={e => setShopPrice(e.target.value)} />
                        <p className="text-xs text-muted-foreground">The shop owner pays this to add another {shopLimit || '…'} questions for the month.</p>
                    </div>
                    <div className="space-y-2 sm:col-span-2">
                        <Label htmlFor="ai-global-limit">Platform limit per day (all users)</Label>
                        <Input id="ai-global-limit" type="number" min={1} max={100000} value={globalLimit} onChange={e => setGlobalLimit(e.target.value)} />
                        <p className="text-xs text-muted-foreground">Safety cap on your DeepSeek spend. When reached, ARHMS AI pauses until tomorrow. Admins have no monthly limit; everyone can send at most 6 messages a minute.</p>
                    </div>
                </div>

                <div className="space-y-2">
                    <Label>Model</Label>
                    <div className="grid gap-2 sm:grid-cols-3">
                        {MODELS.map(m => (
                            <button
                                key={m.value}
                                type="button"
                                onClick={() => setModel(m.value)}
                                className={cn(
                                    'rounded-xl border p-3 text-left transition',
                                    model === m.value ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'border-border hover:border-primary/50',
                                )}
                            >
                                <p className="font-semibold">{m.label}</p>
                                <p className="text-xs text-muted-foreground">{m.hint}</p>
                            </button>
                        ))}
                    </div>
                </div>

                <Button onClick={save} disabled={saving || loading}>
                    {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />} Save
                </Button>
            </div>

            {status && (
                <div className="grid gap-4 md:grid-cols-2">
                    <UsageCard title="Today" u={status.today} />
                    <UsageCard title="Last 7 days" u={status.week} />
                    <div className="rounded-xl border border-border p-4 md:col-span-2">
                        <p className="text-sm font-semibold text-muted-foreground">Paid resets this month</p>
                        <div className="mt-3 grid grid-cols-3 gap-3">
                            <div>
                                <p className="text-2xl font-black">{status.resetRevenue.dashboard.count}</p>
                                <p className="text-xs text-muted-foreground">user resets</p>
                            </div>
                            <div>
                                <p className="text-2xl font-black">{status.resetRevenue.shop.count}</p>
                                <p className="text-xs text-muted-foreground">shop resets</p>
                            </div>
                            <div>
                                <p className="text-2xl font-black">GHS {(status.resetRevenue.dashboard.ghs + status.resetRevenue.shop.ghs).toFixed(2)}</p>
                                <p className="text-xs text-muted-foreground">earned</p>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {status && <UnansweredList canEdit={status.canEdit} />}

            {status && <KnowledgeEditor canEdit={status.canEdit} />}
        </div>
    )
}
