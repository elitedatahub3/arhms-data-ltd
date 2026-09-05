'use client'

import { useEffect, useState, useCallback, useMemo } from 'react'
import { useAuth } from '@/contexts/auth-context'
import { useRouter } from 'next/navigation'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
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
    Wallet,
    ShoppingCart,
    Zap,
    Coins,
    Webhook,
    Phone,
    Receipt,
    Package,
} from 'lucide-react'
import { toast } from 'sonner'
import { formatDate, cn } from '@/lib/utils'

type Lang = 'curl' | 'javascript' | 'nodejs' | 'python' | 'php'
type KeyKind = 'standard' | 'commission'
type Tab = 'standard' | 'commission' | 'webhooks'

interface ApiKey {
    kind: KeyKind
    key_prefix: string
    name: string
    status: 'pending' | 'active' | 'revoked'
    last_used_at: string | null
    created_at: string
    webhook_url: string | null
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
        blurb: 'For data bundle endpoints. Orders are charged to your main wallet.',
        empty: 'Generate a standard key to start selling data bundles over the API.',
        icon: ShoppingCart,
    },
    commission: {
        title: 'Commission Services Key',
        blurb: 'For utility bill endpoints. Pay bills at face value and earn a share of the platform commission, credited to your Commission Wallet.',
        empty: 'Generate a commission key to start earning on bill payments. No shop required.',
        icon: Coins,
    },
}

// ─── Endpoint reference ──────────────────────────────────────────────────────
// Snippets are generated from the method, path and body rather than written out
// five times per endpoint. The previous hand-written version ran to 250 lines for
// four endpoints; there are twelve now, and the copies had already drifted.

interface Endpoint {
    icon: React.ElementType
    method: 'GET' | 'POST'
    path: string
    label: string
    desc: string
    body?: Record<string, any>
    query?: string
    /** Which key the snippet should show in the Authorization header. */
    keyKind?: KeyKind
}

/**
 * Env-var names the snippets read the key from.
 *
 * The samples deliberately do NOT show a literal key. Copying a doc snippet verbatim
 * is the most common way a key ends up committed to git — where deleting the line
 * later does not remove it from history — or, in a bundled frontend, inlined into
 * JavaScript served to every visitor. Showing the variable is the same amount of
 * typing and fails safe.
 */
const ENV_VAR: Record<KeyKind, string> = {
    standard:   'ARHMS_API_KEY',
    commission: 'ARHMS_COMMISSION_KEY',
}

function snippetsFor(ep: Endpoint): Record<Lang, string> {
    const url = `${BASE}${ep.path}${ep.query ? `?${ep.query}` : ''}`
    const ENV = ENV_VAR[ep.keyKind ?? 'standard']
    const json = ep.body ? JSON.stringify(ep.body, null, 2) : null
    const compact = ep.body ? JSON.stringify(ep.body) : null

    return {
        curl: ep.body
            ? `curl -X POST ${url} \\\n  -H "Authorization: $${ENV}" \\\n  -H "Content-Type: application/json" \\\n  -d '${compact}'`
            : `curl -X GET "${url}" \\\n  -H "Authorization: $${ENV}"`,

        // Marked server-side deliberately: /api/v2 sends Access-Control-Allow-Origin: *,
        // so this call SUCCEEDS from a browser and looks correct — while shipping the
        // key to everyone who opens DevTools.
        javascript: ep.body
            ? `// Server-side only — never from browser code.\nconst res = await fetch('${url}', {\n  method: 'POST',\n  headers: {\n    'Authorization': process.env.${ENV},\n    'Content-Type': 'application/json'\n  },\n  body: JSON.stringify(${json})\n})\nconst data = await res.json()`
            : `// Server-side only — never from browser code.\nconst res = await fetch('${url}', {\n  headers: { 'Authorization': process.env.${ENV} }\n})\nconst data = await res.json()`,

        nodejs: ep.body
            ? `const axios = require('axios')\n\nconst { data } = await axios.post(\n  '${url}',\n  ${json?.split('\n').join('\n  ')},\n  { headers: { Authorization: process.env.${ENV} } }\n)`
            : `const axios = require('axios')\n\nconst { data } = await axios.get(\n  '${url}',\n  { headers: { Authorization: process.env.${ENV} } }\n)`,

        python: ep.body
            ? `import os, requests\n\nres = requests.post(\n    '${url}',\n    headers={'Authorization': os.environ['${ENV}']},\n    json=${json?.replace(/true/g, 'True').replace(/false/g, 'False').split('\n').join('\n    ')}\n)\nprint(res.json())`
            : `import os, requests\n\nres = requests.get(\n    '${url}',\n    headers={'Authorization': os.environ['${ENV}']}\n)\nprint(res.json())`,

        php: ep.body
            ? `$ch = curl_init('${url}');\ncurl_setopt_array($ch, [\n  CURLOPT_RETURNTRANSFER => true,\n  CURLOPT_POST => true,\n  CURLOPT_HTTPHEADER => ['Authorization: ' . getenv('${ENV}'), 'Content-Type: application/json'],\n  CURLOPT_POSTFIELDS => '${compact}',\n]);\n$response = curl_exec($ch);\ncurl_close($ch);\necho $response;`
            : `$ch = curl_init('${url}');\ncurl_setopt_array($ch, [\n  CURLOPT_RETURNTRANSFER => true,\n  CURLOPT_HTTPHEADER => ['Authorization: ' . getenv('${ENV}')],\n]);\n$response = curl_exec($ch);\ncurl_close($ch);\necho $response;`,
    }
}

const STANDARD_ENDPOINTS: Endpoint[] = [
    {
        icon: Package, method: 'GET', path: '/api/v2/packages', label: 'List packages',
        desc: 'Every available bundle with your role-specific price. Call this first — it is the only way to know which network/size pairs exist.',
        query: 'network=MTN',
    },
    {
        icon: ShoppingCart, method: 'POST', path: '/api/v2/data/purchase', label: 'Buy a bundle',
        desc: 'Charges your wallet atomically. `reference` is your idempotency key — sending the same one twice returns the existing order without charging again.',
        body: { network: 'MTN', volume_gb: 5, recipient: '0551617309', reference: 'order_001' },
    },
    {
        icon: Zap, method: 'POST', path: '/api/v2/data/bulk', label: 'Buy up to 100',
        desc: 'Every order is validated and priced before the wallet is touched, so a bad entry costs nothing.',
        body: { orders: [
            { network: 'MTN', volume_gb: 5, recipient: '0551617309', reference: 'b_001' },
            { network: 'Telecel', volume_gb: 2, recipient: '0201234567', reference: 'b_002' },
        ] },
    },
    {
        icon: Phone, method: 'POST', path: '/api/v2/airtime/purchase', label: 'Send airtime',
        desc: 'Networks: MTN, Telecel, AT. Priced with your ordinary role fee, same as the dashboard. Set `use_exact_amount` to charge the fee on top instead of taking it out of the amount.',
        body: { network: 'MTN', amount: 10, recipient: '0551617309', reference: 'air_001' },
    },
    {
        icon: Wallet, method: 'GET', path: '/api/v2/wallet/balance', label: 'Wallet balance',
        desc: 'Your spending balance in GHS. Top up from the dashboard wallet page.',
    },
    {
        icon: Clock, method: 'GET', path: '/api/v2/orders/order_001', label: 'Order status',
        desc: 'Data and airtime orders — the `type` field says which you got. Bill payments have their own endpoint on the Commission API tab. Status flows pending → processing → completed | failed.',
    },
]

const COMMISSION_ENDPOINTS: Endpoint[] = [
    {
        icon: Package, method: 'GET', path: '/api/v2/utilities/billers', label: 'Biller catalogue',
        desc: 'Every biller, including ones an admin has switched off, so your picker can grey them out instead of guessing. Read min_amount / max_amount from here rather than hardcoding them.',
        keyKind: 'commission',
    },
    {
        icon: Receipt, method: 'GET', path: '/api/v2/utilities/lookup', label: 'Verify an account',
        desc: 'Resolves a smartcard, IUC or meter number to the customer name. Show it back to your user before charging — a mistyped digit belongs to somebody else. ECG answers a phone number with a list of meters in `meters`; every other biller fills `account_name` instead. 404 = no such account, 502 = provider unreachable, retry.',
        query: 'biller=dstv&account=7041234567',
        keyKind: 'commission',
    },
    {
        icon: Receipt, method: 'POST', path: '/api/v2/utilities/pay', label: 'Pay a bill',
        desc: 'Billers: ecg, ghana_water, dstv, gotv, startimes. ECG and Ghana Water need `phone`; Ghana Water also needs `email` for its receipt. For ECG, `account` is the specific meter from lookup. The account is re-verified server-side before any money moves.',
        body: { biller: 'dstv', account: '7041234567', amount: 65.00, reference: 'bill_dstv_7041234567_01' },
        keyKind: 'commission',
    },
    {
        icon: Clock, method: 'GET', path: '/api/v2/utilities/orders/UTIL-DSTV-3f9a2b1c4d5e6f70', label: 'Bill status',
        desc: 'Poll with the reference from the /pay RESPONSE — ours, not the one you sent. commission_earned stays null until the order completes.',
        keyKind: 'commission',
    },
    {
        icon: Coins, method: 'GET', path: '/api/v2/commission/balance', label: 'Commission balance',
        desc: 'What you have earned. Separate from your spending wallet.',
        keyKind: 'commission',
    },
    {
        icon: Activity, method: 'GET', path: '/api/v2/commission/transactions', label: 'Earnings statement',
        desc: 'One row per bill payment that paid a commission. Paged — pass ?page= and ?limit= (max 100).',
        keyKind: 'commission',
    },
]

export default function DeveloperApiPage() {
    const { dbUser } = useAuth()
    const router = useRouter()

    const [keys, setKeys] = useState<ApiKey[] | undefined>(undefined)
    const [logs, setLogs] = useState<ApiLog[]>([])
    const [logsLoading, setLogsLoading] = useState(true)
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

    const [tab, setTab] = useState<Tab>('standard')
    const [activeLang, setActiveLang] = useState<Lang>('curl')
    const [copiedSnippet, setCopiedSnippet] = useState<string | null>(null)

    const fetchKeys = useCallback(async () => {
        const res = await fetch('/api/user/api-keys')
        const json = await res.json()
        setKeys(json.keys ?? [])
    }, [])

    const fetchLogs = useCallback(async () => {
        setLogsLoading(true)
        try {
            const res = await fetch('/api/user/api-keys/logs')
            if (res.ok) {
                const json = await res.json()
                setLogs(json.data?.logs ?? [])
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
            <div>
                <h1 className="text-2xl font-bold tracking-tight">Developer API</h1>
                <p className="text-muted-foreground text-sm mt-1">
                    Integrate ARHMS into your own apps. Agent plan required.
                </p>
            </div>

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
                                Airtime and bill payments settle asynchronously — sometimes instantly, sometimes
                                minutes later when the provider calls back. Rather than polling every order, register
                                an HTTPS endpoint and we will POST to it the moment an order reaches a terminal state.
                            </p>

                            <div className="rounded-xl border border-border/60 overflow-hidden">
                                <div className="px-4 py-3 bg-secondary/30 text-xs font-semibold">1. Register your endpoint</div>
                                <div className="px-4 py-3">
                                    <pre className="text-xs font-mono bg-muted/40 rounded-lg p-3 overflow-x-auto whitespace-pre">
{`curl -X PATCH ${BASE}/api/user/api-keys \\
  -H "Content-Type: application/json" \\
  -d '{"kind":"commission","webhook_url":"https://your-app.com/hooks/arhms"}'`}
                                    </pre>
                                    <p className="text-xs text-muted-foreground mt-2">
                                        Called from your logged-in dashboard session. The response contains a
                                        <code className="font-mono mx-1">webhook_secret</code> shown once — store it.
                                    </p>
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
