'use client'

import { useEffect, useState, useCallback, useMemo } from 'react'
import { useAuth } from '@/contexts/auth-context'
import { useRouter } from 'next/navigation'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Input } from '@/components/ui/input'
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
    Copy,
    Check,
    RefreshCw,
    Trash2,
    Loader2,
    Terminal,
    ShieldCheck,
    Clock,
    AlertTriangle,
    Eye,
    EyeOff,
    Activity,
    ShoppingCart,
    Coins,
    Webhook,
    Save,
    ExternalLink,
} from 'lucide-react'
import { toast } from 'sonner'
import { formatDate, cn } from '@/lib/utils'
// The endpoint catalogue and its snippet generator are shared with the public docs
// at /docs — see lib/api-docs.ts for why they are not defined here any more.
import {
    type Lang,
    type KeyKind,
    type Endpoint,
    LANGS,
    BASE,
    STANDARD_KEY_SAMPLE,
    COMMISSION_KEY_SAMPLE,
    snippetsFor,
    STANDARD_ENDPOINTS,
    COMMISSION_ENDPOINTS,
    WEBHOOK_EVENTS,
} from '@/lib/api-docs'

type Tab = 'standard' | 'commission' | 'webhooks'

interface ApiKey {
    kind: KeyKind
    key_prefix: string
    name: string
    status: 'pending' | 'active' | 'revoked'
    last_used_at: string | null
    created_at: string
    webhook_url: string | null
    /** True when an endpoint has a signing secret. The secret itself never leaves the server. */
    has_webhook_secret?: boolean
}

interface ApiLog {
    id: string
    endpoint: string
    method: string
    status_code: number
    response_time_ms: number
    ip_address: string
    error_message: string | null
    created_at: string
}

interface ApiUsage {
    total: number
    failed: number
    succeeded: number
    last24h: number
    /** null when nothing has been called — never shown as 100%. */
    successRate: number | null
    lastCallAt: string | null
}

interface CommissionWallet {
    balance: number
    total_earned: number
    total_withdrawn: number
    currency: string
}

const STATUS_BADGE: Record<string, { label: string; className: string }> = {
    pending: { label: 'Pending Approval', className: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400' },
    active:  { label: 'Active',           className: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400' },
    revoked: { label: 'Revoked',          className: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' },
}

const LANGS: { id: Lang; label: string }[] = [
    { id: 'curl',       label: 'cURL'       },
    { id: 'javascript', label: 'JavaScript' },
    { id: 'nodejs',     label: 'Node.js'    },
    { id: 'python',     label: 'Python'     },
    { id: 'php',        label: 'PHP'        },
]

const KEY  = 'YOUR_API_KEY'
// Apex, NOT www. www.arhmsgh.com answers every /api request with a 307 to the apex,
// and a cross-host redirect makes clients drop the Authorization header -- curl and
// axios both do, by design. A partner copying a www sample gets 401 no matter how
// valid their key is, with nothing in the response to explain why. Verified:
//   > Host: www.arhmsgh.com   Authorization: <key>   -> 307
//   > Host: arhmsgh.com       (no Authorization)     -> 401
const BASE = 'https://arhmsgh.com'
const STANDARD_KEY_SAMPLE   = 'kf_live_your_api_key_here'
const COMMISSION_KEY_SAMPLE = 'kf_cs_live_your_commission_key_here'

const KEY_META: Record<KeyKind, { title: string; blurb: string; empty: string; icon: React.ElementType }> = {
    standard: {
        title: 'Standard API Key',
        blurb: 'For data, airtime, result checker and AFA endpoints. Orders are charged to your main wallet.',
        empty: 'Generate a standard key to start selling data, airtime, result checkers and AFA over the API.',
        icon: ShoppingCart,
    },
    commission: {
        title: 'Commission Services Key',
        blurb: 'For utility bill endpoints. Pay bills at face value and earn a share of the platform commission, credited to your Commission Wallet.',
        empty: 'Generate a commission key to start earning on bill payments. No shop required.',
        icon: Coins,
    },
}

const WEBHOOK_CARD: Record<KeyKind, { title: string; blurb: string; keyLabel: string }> = {
    standard: {
        title: 'Data API Webhook',
        blurb: 'Airtime orders settle asynchronously. Get told the moment one completes or fails, instead of polling GET /orders/{reference}.',
        keyLabel: 'Standard API key',
    },
    commission: {
        title: 'Commission Services Webhook',
        blurb: 'Bill payments can take minutes to settle at the biller. Get told the moment one completes, fails or is refunded.',
        keyLabel: 'Commission Services key',
    },
}

export default function DeveloperApiPage() {
    const { dbUser } = useAuth()
    const router = useRouter()

    const [keys, setKeys] = useState<ApiKey[] | undefined>(undefined)
    const [logs, setLogs] = useState<ApiLog[]>([])
    const [logsLoading, setLogsLoading] = useState(true)
    const [usage, setUsage] = useState<ApiUsage | null>(null)
    const [commission, setCommission] = useState<CommissionWallet | null>(null)

    const [generateKind, setGenerateKind] = useState<KeyKind | null>(null)
    const [revokeKind, setRevokeKind] = useState<KeyKind | null>(null)
    const [approvalOpen, setApprovalOpen] = useState(false)
    const [newKey, setNewKey] = useState<{ kind: KeyKind; value: string } | null>(null)
    const [keyCopied, setKeyCopied] = useState(false)
    const [keyVisible, setKeyVisible] = useState(false)
    const [isGenerating, setIsGenerating] = useState(false)
    const [isRevoking, setIsRevoking] = useState(false)
    const [adminWhatsapp, setAdminWhatsapp] = useState('')

    // Webhook form. Drafts are seeded from the saved endpoints once they load, and a
    // kind the user is editing is left alone so a refetch cannot overwrite typing.
    const [webhookDraft, setWebhookDraft] = useState<Partial<Record<KeyKind, string>>>({})
    const [webhookBusy, setWebhookBusy] = useState<KeyKind | null>(null)
    const [newSecret, setNewSecret] = useState<{ kind: KeyKind; value: string } | null>(null)
    const [secretCopied, setSecretCopied] = useState(false)

    const [tab, setTab] = useState<Tab>('standard')
    const [activeLang, setActiveLang] = useState<Lang>('curl')
    const [copiedSnippet, setCopiedSnippet] = useState<string | null>(null)

    const fetchKeys = useCallback(async () => {
        const res = await fetch('/api/user/api-keys')
        const json = await res.json()
        setKeys(json.keys ?? [])
    }, [])

    // Seed each input from what is saved. A kind already in the draft is left alone so
    // a refetch cannot overwrite something being typed.
    useEffect(() => {
        if (!keys) return
        setWebhookDraft(prev => {
            const next = { ...prev }
            for (const k of keys) if (next[k.kind] === undefined) next[k.kind] = k.webhook_url ?? ''
            return next
        })
    }, [keys])

    /**
     * Save, rotate or clear one endpoint.
     *
     * The same PATCH does all three: a URL sets it and mints a fresh secret, null
     * clears both. Rotating is therefore just saving the URL that is already there.
     */
    const saveWebhook = async (kind: KeyKind, url: string | null) => {
        if (url !== null) {
            const trimmed = url.trim()
            if (!trimmed) { toast.error('Enter your endpoint URL'); return }
            // Checked here too so the common mistake is caught without a round trip;
            // the server enforces it regardless.
            if (!trimmed.toLowerCase().startsWith('https://')) { toast.error('The URL must start with https://'); return }
            url = trimmed
        }

        setWebhookBusy(kind)
        try {
            const res = await fetch('/api/user/api-keys', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ kind, webhook_url: url }),
            })
            const json = await res.json()
            if (!res.ok) { toast.error(json.error || 'Could not save the webhook'); return }

            if (json.webhook_secret) {
                setNewSecret({ kind, value: json.webhook_secret })
                setSecretCopied(false)
            } else {
                setNewSecret(null)
                setWebhookDraft(prev => ({ ...prev, [kind]: '' }))
            }
            toast.success(json.message || 'Webhook updated')
            await fetchKeys()
        } catch {
            toast.error('Something went wrong')
        } finally {
            setWebhookBusy(null)
        }
    }

    const copySecret = (value: string) => {
        navigator.clipboard.writeText(value)
            .then(() => { setSecretCopied(true); toast.success('Signing secret copied') })
            .catch(() => toast.error('Could not copy — select the text instead'))
    }

    const fetchLogs = useCallback(async () => {
        setLogsLoading(true)
        try {
            const res = await fetch('/api/user/api-keys/logs')
            if (res.ok) {
                const json = await res.json()
                setLogs(json.data?.logs ?? [])
                setUsage(json.data?.usage ?? null)
            }
        } finally {
            setLogsLoading(false)
        }
    }, [])

    const fetchCommission = useCallback(async () => {
        try {
            const res = await fetch('/api/user/commission-wallet')
            if (res.ok) {
                const json = await res.json()
                setCommission(json.wallet ?? null)
            }
        } catch { /* the strip simply does not render */ }
    }, [])

    useEffect(() => {
        fetchKeys()
        fetchLogs()
        fetchCommission()
        fetch('/api/admin-settings?keys=whatsapp_admin_number')
            .then(r => r.json())
            .then(d => { if (d.whatsapp_admin_number) setAdminWhatsapp(d.whatsapp_admin_number) })
            .catch(() => {})
    }, [fetchKeys, fetchLogs, fetchCommission])

    useEffect(() => {
        if (dbUser && dbUser.role !== 'agent' && dbUser.role !== 'dealer' && dbUser.role !== 'admin' && dbUser.role !== 'sub-admin') {
            router.push('/dashboard/upgrade')
        }
    }, [dbUser, router])

    const keyOf = useCallback(
        (kind: KeyKind): ApiKey | null => keys?.find(k => (k.kind ?? 'standard') === kind) ?? null,
        [keys]
    )

    const handleGenerate = async () => {
        if (!generateKind) return
        setIsGenerating(true)
        try {
            const res = await fetch('/api/user/api-keys', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ kind: generateKind }),
            })
            const json = await res.json()
            if (!res.ok) {
                toast.error(json.error || 'Failed to generate key')
                return
            }
            setNewKey({ kind: generateKind, value: json.key })
            setKeyVisible(true)
            setGenerateKind(null)
            await fetchKeys()
            if (json.status === 'pending') setApprovalOpen(true)
        } catch {
            toast.error('Something went wrong')
        } finally {
            setIsGenerating(false)
        }
    }

    const handleRevoke = async () => {
        if (!revokeKind) return
        setIsRevoking(true)
        try {
            const res = await fetch(`/api/user/api-keys?kind=${revokeKind}`, { method: 'DELETE' })
            if (!res.ok) {
                const json = await res.json()
                toast.error(json.error || 'Failed to revoke key')
                return
            }
            toast.success(`${KEY_META[revokeKind].title} deleted`)
            if (newKey?.kind === revokeKind) setNewKey(null)
            setRevokeKind(null)
            await fetchKeys()
        } catch {
            toast.error('Something went wrong')
        } finally {
            setIsRevoking(false)
        }
    }

    const copyKey = () => {
        if (!newKey) return
        navigator.clipboard.writeText(newKey.value)
        setKeyCopied(true)
        toast.success('API key copied!')
        setTimeout(() => setKeyCopied(false), 2000)
    }

    const copySnippet = (id: string, text: string) => {
        navigator.clipboard.writeText(text)
        setCopiedSnippet(id)
        toast.success('Copied!')
        setTimeout(() => setCopiedSnippet(null), 2000)
    }

    const endpoints = useMemo(
        () => (tab === 'commission' ? COMMISSION_ENDPOINTS : STANDARD_ENDPOINTS),
        [tab]
    )

    const renderKeyCard = (kind: KeyKind) => {
        const meta = KEY_META[kind]
        const apiKey = keyOf(kind)
        const statusInfo = apiKey ? STATUS_BADGE[apiKey.status] : null
        const showNew = newKey?.kind === kind

        return (
            <Card key={kind}>
                <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-base">
                        <meta.icon className="w-4 h-4" /> {meta.title}
                    </CardTitle>
                    <CardDescription>{meta.blurb}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    {keys === undefined ? (
                        <Skeleton className="h-16 w-full" />
                    ) : showNew ? (
                        <div className="rounded-xl border border-emerald-400/40 bg-emerald-50/50 dark:bg-emerald-900/10 p-4 space-y-3">
                            <div className="flex items-center gap-2 text-sm font-medium text-emerald-700 dark:text-emerald-400">
                                <ShieldCheck className="w-4 h-4" />
                                Key generated — copy it now, it won&apos;t be shown again
                            </div>
                            <div className="flex items-center gap-2">
                                <code className="flex-1 text-xs font-mono bg-background rounded-lg px-3 py-2.5 border border-border/50 truncate select-all">
                                    {keyVisible ? newKey!.value : newKey!.value.replace(/./g, '•')}
                                </code>
                                <Button size="icon" variant="ghost" onClick={() => setKeyVisible(v => !v)} className="shrink-0">
                                    {keyVisible ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                                </Button>
                                <Button size="icon" variant="ghost" onClick={copyKey} className="shrink-0">
                                    {keyCopied ? <Check className="w-4 h-4 text-emerald-500" /> : <Copy className="w-4 h-4" />}
                                </Button>
                            </div>
                        </div>
                    ) : apiKey ? (
                        <div className="flex flex-col sm:flex-row sm:items-center gap-4">
                            <div className="flex-1 space-y-1">
                                <span className={cn('text-xs font-semibold px-2.5 py-1 rounded-full', statusInfo?.className)}>
                                    {statusInfo?.label}
                                </span>
                                <p className="text-sm text-muted-foreground">
                                    Prefix: <code className="font-mono text-foreground">{apiKey.key_prefix}…</code>
                                </p>
                                {apiKey.last_used_at && (
                                    <p className="text-xs text-muted-foreground flex items-center gap-1">
                                        <Clock className="w-3 h-3" /> Last used {formatDate(apiKey.last_used_at)}
                                    </p>
                                )}
                                {apiKey.webhook_url && (
                                    <p className="text-xs text-muted-foreground flex items-center gap-1">
                                        <Webhook className="w-3 h-3" /> Webhook set
                                    </p>
                                )}
                                {apiKey.status === 'pending' && (
                                    <p className="text-xs text-yellow-600 dark:text-yellow-400 flex items-center gap-1 mt-1">
                                        <AlertTriangle className="w-3 h-3" />
                                        Awaiting admin approval before you can make API calls.
                                    </p>
                                )}
                            </div>
                            <div className="flex gap-2">
                                <Button variant="outline" size="sm" onClick={() => setGenerateKind(kind)} className="gap-1.5">
                                    <RefreshCw className="w-3.5 h-3.5" /> Regenerate
                                </Button>
                                <Button variant="ghost" size="sm" onClick={() => setRevokeKind(kind)} className="gap-1.5 text-red-500 hover:text-red-600 hover:bg-red-500/10">
                                    <Trash2 className="w-3.5 h-3.5" /> Delete
                                </Button>
                            </div>
                        </div>
                    ) : (
                        <div className="flex flex-col items-center py-6 gap-3 text-center">
                            <div className="w-12 h-12 rounded-2xl bg-primary/10 flex items-center justify-center">
                                <meta.icon className="w-6 h-6 text-primary" />
                            </div>
                            <div>
                                <p className="font-semibold">No {meta.title.toLowerCase()} yet</p>
                                <p className="text-sm text-muted-foreground max-w-sm">{meta.empty}</p>
                            </div>
                            <Button onClick={() => setGenerateKind(kind)} className="gap-2">
                                <Key className="w-4 h-4" /> Generate {kind === 'commission' ? 'Commission' : 'Standard'} Key
                            </Button>
                        </div>
                    )}
                </CardContent>
            </Card>
        )
    }

    return (
        <div className="space-y-6 max-w-4xl">
            {/* Header */}
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <h1 className="text-2xl font-bold tracking-tight">Developer API</h1>
                    <p className="text-muted-foreground text-sm mt-1">
                        Integrate ARHMS into your own apps. Agent plan required.
                    </p>
                </div>
                {/* The full reference lives at /docs, which is public — a partner reading it
                    does not need this dashboard, or an account at all. */}
                <a
                    href="/docs"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="shrink-0 inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-bold transition hover:bg-muted"
                >
                    <ExternalLink className="w-3.5 h-3.5" /> Docs
                </a>
            </div>

            {/* Usage */}
            {usage && usage.total > 0 && (
                <Card>
                    <CardHeader className="pb-3">
                        <CardTitle className="flex items-center gap-2 text-base">
                            <Activity className="w-4 h-4" /> Your API Usage
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                            {[
                                { label: 'Total calls', value: usage.total.toLocaleString() },
                                { label: 'Last 24 hours', value: usage.last24h.toLocaleString() },
                                { label: 'Succeeded', value: usage.succeeded.toLocaleString() },
                                { label: 'Success rate', value: usage.successRate === null ? '—' : `${usage.successRate}%` },
                            ].map(s => (
                                <div key={s.label} className="rounded-xl border border-border/60 p-3">
                                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{s.label}</p>
                                    <p className="text-lg font-black mt-0.5">{s.value}</p>
                                </div>
                            ))}
                        </div>
                        {usage.lastCallAt && (
                            <p className="text-[11px] text-muted-foreground mt-3">
                                Last call {formatDate(usage.lastCallAt)}.
                            </p>
                        )}
                    </CardContent>
                </Card>
            )}

            {renderKeyCard('standard')}
            {renderKeyCard('commission')}

            {/* Commission Wallet */}
            {commission && (commission.total_earned > 0 || keyOf('commission')) && (
                <Card>
                    <CardHeader className="pb-3">
                        <CardTitle className="flex items-center gap-2 text-base">
                            <Coins className="w-4 h-4" /> Commission Wallet
                        </CardTitle>
                        <CardDescription>
                            Earnings from airtime and bill payments made with your Commission Services key.
                        </CardDescription>
                    </CardHeader>
                    <CardContent>
                        <div className="grid grid-cols-3 gap-3">
                            {[
                                { label: 'Available',  value: commission.balance },
                                { label: 'Earned',     value: commission.total_earned },
                                { label: 'Withdrawn',  value: commission.total_withdrawn },
                            ].map(stat => (
                                <div key={stat.label} className="rounded-xl border border-border/60 bg-secondary/20 p-3">
                                    <p className="text-xs text-muted-foreground">{stat.label}</p>
                                    <p className="text-lg font-bold tabular-nums">
                                        GHS {Number(stat.value).toFixed(2)}
                                    </p>
                                </div>
                            ))}
                        </div>
                    </CardContent>
                </Card>
            )}

            {/* Endpoints Reference */}
            <Card>
                <CardHeader>
                    <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
                        <div>
                            <CardTitle className="flex items-center gap-2 text-base">
                                <Terminal className="w-4 h-4" /> API Reference
                            </CardTitle>
                            <CardDescription className="mt-1">
                                Base URL: <code className="font-mono text-foreground text-xs">{BASE}/api/v2</code>
                                &nbsp;— pass your key as <code className="font-mono text-foreground text-xs">Authorization: &lt;your key&gt;</code>
                            </CardDescription>
                        </div>

                        <div className="flex gap-1 flex-wrap">
                            {LANGS.map(lang => (
                                <button
                                    key={lang.id}
                                    type="button"
                                    onClick={() => setActiveLang(lang.id)}
                                    className={cn(
                                        'text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors',
                                        activeLang === lang.id
                                            ? 'bg-primary text-primary-foreground'
                                            : 'bg-secondary/50 text-muted-foreground hover:bg-secondary hover:text-foreground'
                                    )}
                                >
                                    {lang.label}
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* Placed above the tabs so it is read before any snippet is copied. */}
                    <div className="mt-3 rounded-xl border border-border/60 bg-secondary/20 p-3 text-xs space-y-2">
                        <p className="flex items-center gap-1.5 font-semibold">
                            <ShieldCheck className="w-3.5 h-3.5" /> Keep your key on your server
                        </p>
                        <p className="text-muted-foreground">
                            The key is the whole credential — no password, no second factor — and it
                            spends your wallet. Anyone holding the string can place orders as you, and a
                            bill payment cannot be recalled once the provider accepts it.
                        </p>
                        <p className="text-muted-foreground">
                            These endpoints send <code className="font-mono">Access-Control-Allow-Origin: *</code>,
                            so a call from browser code <em>works</em> — and ships your key to everyone who
                            opens DevTools. Let your frontend talk to your own server, and keep the key there.
                        </p>
                        <p className="text-muted-foreground">
                            The samples below read it from an environment variable rather than showing a
                            literal, because a key pasted into a tracked file stays in git history even
                            after the line is deleted. Put it in a gitignored <code className="font-mono">.env</code>:
                        </p>
                        <pre className="font-mono bg-muted/40 rounded-lg p-2.5 overflow-x-auto text-foreground/80">
{`ARHMS_API_KEY=${STANDARD_KEY_SAMPLE}
ARHMS_COMMISSION_KEY=${COMMISSION_KEY_SAMPLE}`}
                        </pre>
                    </div>

                    {/* Tabs */}
                    <div className="flex gap-1 border-b border-border/60 mt-4 -mb-2 overflow-x-auto">
                        {([
                            { id: 'standard',   label: 'Standard API'   },
                            { id: 'commission', label: 'Commission API' },
                            { id: 'webhooks',   label: 'Webhooks'       },
                        ] as { id: Tab; label: string }[]).map(t => (
                            <button
                                key={t.id}
                                type="button"
                                onClick={() => setTab(t.id)}
                                className={cn(
                                    'text-sm font-semibold px-3 py-2 border-b-2 -mb-px transition-colors whitespace-nowrap',
                                    tab === t.id
                                        ? 'border-primary text-foreground'
                                        : 'border-transparent text-muted-foreground hover:text-foreground'
                                )}
                            >
                                {t.label}
                            </button>
                        ))}
                    </div>
                </CardHeader>

                <CardContent className="space-y-4">
                    {tab === 'commission' && (
                        <div className="rounded-xl border border-amber-400/40 bg-amber-50/50 dark:bg-amber-900/10 p-3 text-xs text-amber-800 dark:text-amber-300 flex gap-2">
                            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                            <div className="space-y-2">
                                <p>
                                    Bill payments are irreversible once the provider accepts them.
                                    Verify with <code className="font-mono">/utilities/lookup</code> and show the
                                    returned name to your user before charging.
                                </p>
                                <p>
                                    <code className="font-mono">reference</code> on <code className="font-mono">/pay</code> is
                                    a pure idempotency key, not a distinct-payment key. Reusing one — even with a
                                    different biller, account or amount — returns the ORIGINAL order and never
                                    charges again; it does not re-validate what you sent. Use a unique reference per
                                    bill, and reuse one only to retry the exact same payment after a timeout.
                                </p>
                                <p>
                                    These endpoints accept the Commission Services key only, and it is rejected with
                                    403 everywhere else on <code className="font-mono">/api/v2/*</code>.
                                </p>
                            </div>
                        </div>
                    )}

                    {tab === 'webhooks' ? (
                        <div className="space-y-4 text-sm">
                            <p className="text-muted-foreground">
                                Data bundles, airtime, AFA registrations and bill payments all settle
                                asynchronously — sometimes instantly, sometimes minutes later when the provider calls
                                back. Rather than polling every order, register an HTTPS endpoint and we will POST to
                                it when an order reaches a terminal state. Airtime and bills are sent the instant they
                                settle; data and AFA are swept within about a minute.
                            </p>

                            {/* Configure your endpoint — one card per key kind, because each
                                key carries its own URL and its own signing secret. */}
                            <div className="space-y-2">
                                <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Configure your endpoint</p>
                                <div className="grid gap-3 sm:grid-cols-2">
                                    {(["standard", "commission"] as KeyKind[]).map(kind => {
                                        const key = keys?.find(k => k.kind === kind)
                                        const meta = WEBHOOK_CARD[kind]
                                        const draft = webhookDraft[kind] ?? ''
                                        const busy = webhookBusy === kind
                                        const live = !!key?.webhook_url
                                        const dirty = draft.trim() !== (key?.webhook_url ?? '')

                                        return (
                                            <div key={kind} className="rounded-xl border border-border/60 p-4 space-y-3">
                                                <div className="flex items-center gap-2">
                                                    <Webhook className="w-4 h-4 text-muted-foreground shrink-0" />
                                                    <span className="text-sm font-bold">{meta.title}</span>
                                                    {live && (
                                                        <span className="ml-auto text-[10px] font-black uppercase px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400">
                                                            Active
                                                        </span>
                                                    )}
                                                </div>
                                                <p className="text-xs text-muted-foreground">{meta.blurb}</p>

                                                {!key ? (
                                                    <p className="text-xs text-muted-foreground italic">
                                                        Generate a {meta.keyLabel} first — a webhook belongs to a key.
                                                    </p>
                                                ) : (
                                                    <>
                                                        <div>
                                                            <label className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">Webhook URL</label>
                                                            <Input
                                                                value={draft}
                                                                onChange={e => setWebhookDraft(prev => ({ ...prev, [kind]: e.target.value }))}
                                                                placeholder="https://your-app.com/webhooks/arhms"
                                                                className="mt-1 h-10 rounded-lg font-mono text-xs"
                                                                disabled={busy}
                                                            />
                                                        </div>

                                                        {live && (
                                                            <div className="flex items-center gap-2 rounded-lg bg-muted/40 px-2.5 py-2">
                                                                <Check className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                                                                <span className="text-[11px] text-muted-foreground flex-1">
                                                                    {key.has_webhook_secret
                                                                        ? 'Signing secret configured — hidden after creation.'
                                                                        : 'No signing secret yet. Save again to mint one.'}
                                                                </span>
                                                            </div>
                                                        )}

                                                        <div className="flex flex-wrap gap-2">
                                                            <Button
                                                                size="sm"
                                                                className="flex-1 min-w-[8rem]"
                                                                disabled={busy || (live && !dirty)}
                                                                onClick={() => saveWebhook(kind, draft)}
                                                            >
                                                                {busy
                                                                    ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                                                                    : <Save className="w-3.5 h-3.5 mr-1.5" />}
                                                                {live ? 'Update webhook' : 'Save webhook'}
                                                            </Button>
                                                            {live && (
                                                                <>
                                                                    {/* Re-saving the same URL is what mints a new secret. */}
                                                                    <Button size="sm" variant="outline" disabled={busy}
                                                                        onClick={() => saveWebhook(kind, key.webhook_url)}>
                                                                        <RefreshCw className="w-3.5 h-3.5 mr-1.5" /> Rotate
                                                                    </Button>
                                                                    <Button size="sm" variant="outline" disabled={busy}
                                                                        className="text-red-600 hover:text-red-600"
                                                                        onClick={() => saveWebhook(kind, null)}>
                                                                        <Trash2 className="w-3.5 h-3.5 mr-1.5" /> Disable
                                                                    </Button>
                                                                </>
                                                            )}
                                                        </div>

                                                        {newSecret?.kind === kind && (
                                                            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 space-y-2 dark:border-amber-900/50 dark:bg-amber-950/20">
                                                                <p className="text-[11px] font-bold text-amber-900 dark:text-amber-200">
                                                                    Signing secret — shown once. Store it now.
                                                                </p>
                                                                <div className="flex items-center gap-2">
                                                                    <code className="flex-1 min-w-0 truncate rounded bg-background/60 px-2 py-1 font-mono text-[11px]">{newSecret.value}</code>
                                                                    <Button size="icon" variant="ghost" className="w-7 h-7 shrink-0"
                                                                        onClick={() => copySecret(newSecret.value)}>
                                                                        {secretCopied
                                                                            ? <Check className="w-3.5 h-3.5 text-emerald-500" />
                                                                            : <Copy className="w-3.5 h-3.5" />}
                                                                    </Button>
                                                                </div>
                                                            </div>
                                                        )}
                                                    </>
                                                )}
                                            </div>
                                        )
                                    })}
                                </div>
                                <p className="text-[11px] text-muted-foreground">
                                    Saving mints a <strong>new</strong> signing secret and retires the old one, so update
                                    your server whenever you change the URL. HTTPS only — localhost and private addresses are rejected.
                                </p>
                            </div>

                            {/* Event types */}
                            <div className="rounded-xl border border-border/60 overflow-hidden">
                                <div className="px-4 py-3 bg-secondary/30 text-xs font-semibold">Event types</div>
                                <div className="divide-y divide-border/60">
                                    {WEBHOOK_EVENTS.map(e => (
                                        <div key={e.event} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-2.5">
                                            <code className="font-mono text-xs font-bold text-foreground">{e.event}</code>
                                            <span className="text-[10px] uppercase font-bold text-muted-foreground">
                                                {e.keyKind === 'commission' ? 'Commission key' : 'Standard key'}
                                            </span>
                                            <span className="text-xs text-muted-foreground w-full sm:w-auto sm:flex-1">{e.when}</span>
                                        </div>
                                    ))}
                                </div>
                            </div>

                            <div className="rounded-xl border border-border/60 overflow-hidden">
                                <div className="px-4 py-3 bg-secondary/30 text-xs font-semibold">2. What we send</div>
                                <div className="px-4 py-3">
                                    <pre className="text-xs font-mono bg-muted/40 rounded-lg p-3 overflow-x-auto whitespace-pre">
{`POST https://your-app.com/hooks/arhms
X-Arhms-Event: utility.completed
X-Arhms-Signature: sha256=<hmac>

{
  "event": "utility.completed",
  "reference": "bill_001",
  "order_id": "uuid-…",
  "status": "completed",
  "service": "dstv",
  "account_number": "1234567890",
  "account_name": "KWAME MENSAH",
  "bill_amount": 250,
  "total_paid": 250,
  "sent_at": "2026-…"
}`}
                                    </pre>
                                    <p className="text-xs text-muted-foreground mt-2">
                                        Events: <code className="font-mono">utility.completed</code>,{' '}
                                        <code className="font-mono">utility.failed</code>,{' '}
                                        <code className="font-mono">utility.refunded</code>,{' '}
                                        <code className="font-mono">airtime.completed</code>,{' '}
                                        <code className="font-mono">airtime.failed</code>.
                                    </p>
                                </div>
                            </div>

                            <div className="rounded-xl border border-border/60 overflow-hidden">
                                <div className="px-4 py-3 bg-secondary/30 text-xs font-semibold">3. Verify the signature</div>
                                <div className="px-4 py-3">
                                    <pre className="text-xs font-mono bg-muted/40 rounded-lg p-3 overflow-x-auto whitespace-pre">
{`const crypto = require('crypto')

// Hash the RAW body, before any JSON parsing — re-serialising
// changes the bytes and the signature will not match.
const expected = 'sha256=' + crypto
  .createHmac('sha256', process.env.ARHMS_WEBHOOK_SECRET)
  .update(rawBody, 'utf8')
  .digest('hex')

const ok = crypto.timingSafeEqual(
  Buffer.from(expected),
  Buffer.from(req.headers['x-arhms-signature'])
)`}
                                    </pre>
                                </div>
                            </div>

                            <p className="text-xs text-muted-foreground">
                                We retry up to 3 times with backoff on a timeout or a 5xx. A 4xx is treated as a
                                permanent rejection and is not retried. Respond 2xx as soon as you have stored the
                                event — do your own work afterwards.
                            </p>
                        </div>
                    ) : (
                        endpoints.map((ep, i) => {
                            const snippets = snippetsFor(ep)
                            const id = `${tab}-${i}`
                            return (
                                <div key={id} className="rounded-xl border border-border/60 overflow-hidden">
                                    <div className="flex items-center gap-3 px-4 py-3 bg-secondary/30">
                                        <ep.icon className="w-4 h-4 text-muted-foreground shrink-0" />
                                        <span className={cn(
                                            'text-[10px] font-black px-1.5 py-0.5 rounded font-mono uppercase',
                                            ep.method === 'GET'
                                                ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400'
                                                : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400'
                                        )}>
                                            {ep.method}
                                        </span>
                                        <code className="text-xs font-mono text-foreground truncate">{ep.path}</code>
                                        <span className="ml-auto text-xs text-muted-foreground hidden sm:block shrink-0">{ep.label}</span>
                                    </div>

                                    <div className="px-4 py-3 space-y-2">
                                        <p className="text-xs text-muted-foreground">{ep.desc}</p>
                                        <div className="relative">
                                            <pre className="text-xs font-mono bg-muted/40 rounded-lg p-3 overflow-x-auto text-foreground/80 leading-relaxed whitespace-pre">
                                                {snippets[activeLang]}
                                            </pre>
                                            <Button
                                                size="icon"
                                                variant="ghost"
                                                className="absolute top-2 right-2 w-7 h-7 opacity-60 hover:opacity-100"
                                                onClick={() => copySnippet(id, snippets[activeLang])}
                                            >
                                                {copiedSnippet === id
                                                    ? <Check className="w-3.5 h-3.5 text-emerald-500" />
                                                    : <Copy className="w-3.5 h-3.5" />}
                                            </Button>
                                        </div>
                                    </div>
                                </div>
                            )
                        })
                    )}
                </CardContent>
            </Card>

            {/* Recent Logs */}
            <Card>
                <CardHeader className="flex-row items-center justify-between space-y-0">
                    <div>
                        <CardTitle className="flex items-center gap-2 text-base">
                            <Activity className="w-4 h-4" /> Recent API Logs
                        </CardTitle>
                        <CardDescription>Last 20 requests made with your keys.</CardDescription>
                    </div>
                    <Button variant="ghost" size="sm" onClick={fetchLogs} className="gap-1.5 shrink-0">
                        <RefreshCw className="w-3.5 h-3.5" /> Refresh
                    </Button>
                </CardHeader>
                <CardContent>
                    {logsLoading ? (
                        <div className="space-y-2">
                            {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
                        </div>
                    ) : logs.length === 0 ? (
                        <div className="text-center py-8 text-muted-foreground text-sm">No API calls yet.</div>
                    ) : (
                        <div className="overflow-x-auto">
                            <table className="w-full text-xs">
                                <thead>
                                    <tr className="text-muted-foreground border-b border-border/50">
                                        <th className="text-left pb-2 font-semibold">Endpoint</th>
                                        <th className="text-left pb-2 font-semibold">Status</th>
                                        <th className="text-left pb-2 font-semibold hidden sm:table-cell">Time</th>
                                        <th className="text-right pb-2 font-semibold hidden md:table-cell">Date</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-border/30">
                                    {logs.map((log) => (
                                        <tr key={log.id} className="hover:bg-secondary/20">
                                            <td className="py-2 pr-4">
                                                <span className={cn(
                                                    'text-[9px] font-black px-1 py-0.5 rounded font-mono mr-1.5',
                                                    log.method === 'GET'
                                                        ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400'
                                                        : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400'
                                                )}>
                                                    {log.method}
                                                </span>
                                                <code className="text-foreground/80 truncate max-w-[180px] inline-block align-middle">{log.endpoint}</code>
                                            </td>
                                            <td className="py-2 pr-4">
                                                <span className={cn(
                                                    'font-bold',
                                                    log.status_code < 300 ? 'text-emerald-500'
                                                        : log.status_code < 500 ? 'text-yellow-500'
                                                            : 'text-red-500'
                                                )}>
                                                    {log.status_code}
                                                </span>
                                                {log.error_message && (
                                                    <span className="text-muted-foreground ml-2 hidden lg:inline">{log.error_message}</span>
                                                )}
                                            </td>
                                            <td className="py-2 pr-4 hidden sm:table-cell text-muted-foreground">{log.response_time_ms}ms</td>
                                            <td className="py-2 text-right text-muted-foreground hidden md:table-cell">{formatDate(log.created_at)}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </CardContent>
            </Card>

            {/* Generate / Regenerate Dialog */}
            <Dialog open={generateKind !== null} onOpenChange={open => !open && setGenerateKind(null)}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>
                            {generateKind && keyOf(generateKind) ? 'Regenerate' : 'Generate'}{' '}
                            {generateKind ? KEY_META[generateKind].title : 'API Key'}
                        </DialogTitle>
                        <DialogDescription>
                            {generateKind && keyOf(generateKind)
                                ? 'This will invalidate your current key of this type immediately. Any apps using it will stop working until updated. Your other key is unaffected.'
                                : 'Your key will need admin approval before it becomes active. You will be notified.'}
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setGenerateKind(null)}>Cancel</Button>
                        <Button onClick={handleGenerate} disabled={isGenerating} className="gap-2">
                            {isGenerating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Key className="w-4 h-4" />}
                            {generateKind && keyOf(generateKind) ? 'Regenerate' : 'Generate'}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Admin Approval Dialog — shown after key is generated */}
            <Dialog open={approvalOpen} onOpenChange={setApprovalOpen}>
                <DialogContent className="max-w-sm text-center">
                    <DialogHeader>
                        <div className="flex justify-center mb-3">
                            <div className="w-14 h-14 rounded-full bg-yellow-100 flex items-center justify-center">
                                <ShieldCheck className="w-7 h-7 text-yellow-600" />
                            </div>
                        </div>
                        <DialogTitle className="text-center">Admin Approval Required</DialogTitle>
                        <DialogDescription className="text-center">
                            Your API key has been generated but is <span className="font-semibold text-yellow-600">pending approval</span>. Contact the admin on WhatsApp to get it activated quickly.
                        </DialogDescription>
                    </DialogHeader>
                    <div className="flex flex-col gap-3 py-2">
                        <a
                            href={`https://wa.me/${adminWhatsapp.replace(/\D/g, '')}?text=${encodeURIComponent(`Hi, I just generated my API key and I need admin approval to activate it. My name is ${dbUser?.first_name ?? ''} ${dbUser?.last_name ?? ''} and my email is ${dbUser?.email ?? ''}.`)}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center justify-center gap-2 w-full py-3 px-4 rounded-xl bg-[#25D366] hover:bg-[#1ebe5d] text-white font-bold text-sm transition-colors shadow-md"
                        >
                            <svg viewBox="0 0 24 24" className="w-5 h-5 fill-current"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
                            Contact Admin on WhatsApp
                        </a>
                        <Button variant="outline" onClick={() => setApprovalOpen(false)} className="w-full">
                            I&apos;ll do it later
                        </Button>
                    </div>
                </DialogContent>
            </Dialog>

            {/* Revoke Dialog */}
            <Dialog open={revokeKind !== null} onOpenChange={open => !open && setRevokeKind(null)}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Delete {revokeKind ? KEY_META[revokeKind].title : 'API Key'}</DialogTitle>
                        <DialogDescription>
                            This permanently deletes the key. You can generate a new one anytime, but it will need
                            admin approval again. Your other key is unaffected.
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setRevokeKind(null)}>Cancel</Button>
                        <Button variant="destructive" onClick={handleRevoke} disabled={isRevoking} className="gap-2">
                            {isRevoking ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                            Delete Key
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    )
}
