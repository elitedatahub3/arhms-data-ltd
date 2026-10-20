'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { Code2, Copy, KeyRound, Loader2, RefreshCw, Trash2, AlertTriangle, Check, Lock, Building2 } from 'lucide-react'
import { toast } from 'sonner'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { SmsActiveGate, SmsPageHeader, type SmsPlatformAccount } from '@/components/sms/platform/sms-platform-shell'
import { AdminApprovalDialog, WhatsAppAdminButton, useAdminWhatsApp } from '@/components/sms/platform/admin-approval-dialog'
import { useAuth } from '@/contexts/auth-context'

interface KeyRow {
    kind: string
    key_prefix: string
    status: string
    last_used_at: string | null
    created_at: string
}

function copy(text: string) {
    navigator.clipboard?.writeText(text).then(() => toast.success('Copied'), () => toast.error('Could not copy'))
}

function CodeBlock({ code }: { code: string }) {
    return (
        <div className="relative">
            <pre className="overflow-x-auto rounded-xl bg-gray-950 p-3 pr-10 text-[11px] leading-relaxed text-gray-100"><code>{code}</code></pre>
            <button type="button" onClick={() => copy(code)} aria-label="Copy"
                className="absolute right-2 top-2 rounded-md p-1.5 text-gray-400 hover:bg-white/10 hover:text-white">
                <Copy className="w-3.5 h-3.5" />
            </button>
        </div>
    )
}

export default function SmsApiPage() {
    return (
        <>
            <SmsPageHeader title="API & Docs" description="Send SMS from your own website, app or server." icon={Code2} />
            <SmsActiveGate>
                {(info) => (
                    <div className="space-y-5">
                        {info.businessStatus === 'approved' ? <KeyCard /> : <BusinessRequired status={info.businessStatus} />}
                        <Docs />
                    </div>
                )}
            </SmsActiveGate>
        </>
    )
}

// Docs stay readable so a developer can build ahead; only the key waits for approval.
function BusinessRequired({ status }: { status: SmsPlatformAccount['businessStatus'] }) {
    const body = status === 'pending'
        ? 'Your business is in review. Your API key unlocks here as soon as it is approved.'
        : status === 'rejected'
            ? 'Your business registration needs changes. Fix it and resubmit to unlock the API.'
            : 'Register and verify your business to get an SMS API key.'
    return (
        <Card className="border-amber-200 dark:border-amber-900">
            <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2"><Lock className="w-4 h-4 text-amber-600" /> API key locked</CardTitle>
                <CardDescription>The SMS API is available once your business is approved.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
                <p className="text-sm text-muted-foreground">{body}</p>
                {status !== 'pending' && (
                    <Link href="/dashboard/sms/business">
                        <Button className="gap-2 bg-emerald-600 hover:bg-emerald-700">
                            <Building2 className="w-4 h-4" /> {status === 'rejected' ? 'Fix business details' : 'Verify your business'}
                        </Button>
                    </Link>
                )}
            </CardContent>
        </Card>
    )
}

function KeyCard() {
    const [key, setKey] = useState<KeyRow | null>(null)
    const [loading, setLoading] = useState(true)
    const [busy, setBusy] = useState(false)
    const [fullKey, setFullKey] = useState<string | null>(null)
    const [approvalOpen, setApprovalOpen] = useState(false)
    const adminWhatsApp = useAdminWhatsApp()
    const { dbUser } = useAuth()
    const approvalText = `Hi, I just generated my SMS API key and need admin approval to activate it. Name: ${[dbUser?.first_name, dbUser?.last_name].filter(Boolean).join(' ')}, Email: ${dbUser?.email ?? ''}.`

    const load = useCallback(async () => {
        try {
            const res = await fetch('/api/user/api-keys', { cache: 'no-store' })
            const data = await res.json()
            setKey(((data?.keys || []) as KeyRow[]).find((k) => k.kind === 'sms') ?? null)
        } catch {
            toast.error('Could not load your API key')
        } finally {
            setLoading(false)
        }
    }, [])

    useEffect(() => { load() }, [load])

    const generate = async () => {
        if (key && !confirm('Generate a new key? The current key stops working immediately.')) return
        setBusy(true)
        try {
            const res = await fetch('/api/user/api-keys', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ kind: 'sms' }),
            })
            const data = await res.json()
            if (!res.ok || !data?.success) { toast.error(data?.error || 'Could not generate a key'); return }
            setFullKey(data.key)
            toast.success('Key generated — copy it now, it will not be shown again')
            // A new key waits for the admin; tell the owner how to get it approved.
            if (data.status === 'pending') setApprovalOpen(true)
            load()
        } finally {
            setBusy(false)
        }
    }

    const revoke = async () => {
        if (!confirm('Revoke your SMS API key? Anything using it stops working immediately.')) return
        setBusy(true)
        try {
            const res = await fetch('/api/user/api-keys?kind=sms', { method: 'DELETE' })
            const data = await res.json()
            if (!res.ok || !data?.success) { toast.error(data?.error || 'Could not revoke'); return }
            setFullKey(null)
            toast.success('Key revoked')
            load()
        } finally {
            setBusy(false)
        }
    }

    return (
        <Card>
            <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2"><KeyRound className="w-4 h-4 text-emerald-600" /> Your SMS API key</CardTitle>
                <CardDescription>This key can only send SMS and read SMS reports — it cannot touch your wallet or place orders. New keys need admin approval before they work.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
                {loading ? <Skeleton className="h-16 w-full" /> : (
                    <>
                        {fullKey && (
                            <div className="space-y-2 rounded-xl border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950/30">
                                <p className="text-xs font-bold text-amber-800 dark:text-amber-300 flex items-center gap-1">
                                    <AlertTriangle className="w-3.5 h-3.5" /> Copy this key now. It will not be shown again.
                                </p>
                                <div className="flex gap-2">
                                    <code className="flex-1 break-all rounded-lg bg-background p-2 text-xs">{fullKey}</code>
                                    <Button size="sm" variant="outline" onClick={() => copy(fullKey)}><Copy className="w-3.5 h-3.5" /></Button>
                                </div>
                            </div>
                        )}

                        {key ? (
                            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border p-3">
                                <div>
                                    <p className="font-mono text-sm">{key.key_prefix}••••••••</p>
                                    <p className="text-[11px] text-muted-foreground">
                                        {key.status === 'active'
                                            ? <span className="inline-flex items-center gap-1 text-emerald-600"><Check className="w-3 h-3" /> Active</span>
                                            : key.status === 'pending'
                                                ? <span className="rounded-full bg-yellow-100 px-2 py-0.5 font-bold text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400">Pending approval</span>
                                                : key.status}
                                        {' · '}{key.last_used_at ? `last used ${new Date(key.last_used_at).toLocaleString()}` : 'never used'}
                                    </p>
                                    {key.status === 'pending' && (
                                        <div className="mt-2 space-y-1.5">
                                            <p className="text-[11px] text-muted-foreground">This key works once the admin approves it.</p>
                                            {adminWhatsApp
                                                ? <WhatsAppAdminButton number={adminWhatsApp} text={approvalText} size="sm" />
                                                : <p className="text-[11px] text-muted-foreground">Contact support to get it approved.</p>}
                                        </div>
                                    )}
                                </div>
                                <div className="flex gap-2">
                                    <Button size="sm" variant="outline" className="gap-1" disabled={busy} onClick={generate}><RefreshCw className="w-3.5 h-3.5" /> Regenerate</Button>
                                    <Button size="sm" variant="outline" className="gap-1 text-red-600" disabled={busy} onClick={revoke}><Trash2 className="w-3.5 h-3.5" /> Revoke</Button>
                                </div>
                            </div>
                        ) : (
                            <Button className="gap-2 bg-emerald-600 hover:bg-emerald-700" disabled={busy} onClick={generate}>
                                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <KeyRound className="w-4 h-4" />} Generate SMS API key
                            </Button>
                        )}
                    </>
                )}
            </CardContent>
            <AdminApprovalDialog
                open={approvalOpen}
                onOpenChange={setApprovalOpen}
                title="Admin approval required"
                body="Your SMS API key has been generated but is pending approval. Chat the admin on WhatsApp to get it activated."
                whatsappNumber={adminWhatsApp}
                whatsappText={approvalText}
            />
        </Card>
    )
}

function Endpoint({ method, path, children }: { method: string; path: string; children: React.ReactNode }) {
    return (
        <div className="space-y-2 border-t pt-4 first:border-t-0 first:pt-0">
            <p className="flex flex-wrap items-center gap-2 text-sm">
                <span className={method === 'POST' ? 'rounded bg-emerald-600 px-1.5 py-0.5 text-[10px] font-black text-white' : 'rounded bg-sky-600 px-1.5 py-0.5 text-[10px] font-black text-white'}>{method}</span>
                <code className="font-mono font-semibold break-all">{path}</code>
            </p>
            {children}
        </div>
    )
}

function Docs() {
    const [base, setBase] = useState('https://arhmsgh.com')
    useEffect(() => { setBase(window.location.origin) }, [])

    const sendCurl = `curl -X POST ${base}/api/v2/sms/send \\
  -H "Authorization: Bearer YOUR_SMS_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "message": "Your order #1042 is on its way.",
    "recipients": ["0244123456", "233201234567"],
    "sender": "MYBRAND",
    "reference": "order-1042-shipped"
  }'`

    const sendJs = `const res = await fetch('${base}/api/v2/sms/send', {
  method: 'POST',
  headers: {
    Authorization: 'Bearer ' + process.env.SMS_API_KEY,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    message: 'Your code is 4821. It expires in 10 minutes.',
    recipients: ['0244123456'],
    reference: crypto.randomUUID(), // safe to retry with the same value
  }),
})
const { success, data, error } = await res.json()
// data.message_id → GET /api/v2/sms/messages/{message_id} for delivery`

    const sendResponse = `{
  "success": true,
  "data": {
    "message_id": "6f1c…",
    "status": "completed",      // queued | processing | completed
    "duplicate": false,
    "recipients": 2,
    "segments": 1,
    "credits_charged": 2,
    "sender": "MYBRAND",
    "sent": 2, "failed": 0,
    "invalid": [], "opted_out": 0,
    "balance": 498
  },
  "meta": { "version": "v2", "timestamp": "…" }
}`

    return (
        <Card>
            <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2"><Code2 className="w-4 h-4 text-emerald-600" /> Documentation</CardTitle>
                <CardDescription>
                    Base URL <code className="font-mono">{base}</code>. Send your key in the <code className="font-mono">Authorization</code> header as
                    {' '}<code className="font-mono">Bearer &lt;key&gt;</code>. Every response is JSON with <code className="font-mono">success</code> and either <code className="font-mono">data</code> or <code className="font-mono">error</code>.
                </CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
                <Endpoint method="POST" path="/api/v2/sms/send">
                    <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
                        <li><code>message</code> — 3 to 1000 characters. 160 characters is one part (70 with emoji); longer messages cost one credit per part per number.</li>
                        <li><code>recipients</code> — Ghana numbers as an array, or one string separated by commas or spaces. Up to 10,000 per call.</li>
                        <li><code>sender</code> — optional; one of your approved sender IDs. Defaults to your default sender.</li>
                        <li><code>reference</code> — optional but recommended; retrying with the same value returns the first send instead of sending twice.</li>
                    </ul>
                    <CodeBlock code={sendCurl} />
                    <CodeBlock code={sendJs} />
                    <CodeBlock code={sendResponse} />
                </Endpoint>

                <Endpoint method="GET" path="/api/v2/sms/messages/{message_id}">
                    <p className="text-xs text-muted-foreground">
                        Delivery report: a count per status and the recipients 100 at a time. Query <code>?page=1</code> and <code>?status=delivered</code>.
                        Statuses: queued, sending, sent, delivered, undelivered, failed, expired, rejected. Credits for failed and rejected messages are refunded.
                    </p>
                    <CodeBlock code={`curl ${base}/api/v2/sms/messages/MESSAGE_ID \\\n  -H "Authorization: Bearer YOUR_SMS_API_KEY"`} />
                </Endpoint>

                <Endpoint method="GET" path="/api/v2/sms/balance">
                    <p className="text-xs text-muted-foreground">Credits left, your mode (platform or business), messages sent today and your daily limit.</p>
                </Endpoint>

                <Endpoint method="GET" path="/api/v2/sms/senders">
                    <p className="text-xs text-muted-foreground">The sender IDs this key can send under.</p>
                </Endpoint>

                <div className="space-y-2 border-t pt-4">
                    <p className="text-sm font-bold">Errors</p>
                    <div className="overflow-x-auto">
                        <table className="w-full text-xs">
                            <tbody className="[&_td]:py-1 [&_td]:pr-3 [&_td:first-child]:font-mono [&_td:first-child]:font-bold">
                                <tr><td>400</td><td>Invalid message, recipients or sender, or the content is not allowed (links in Platform Mode, scam wording).</td></tr>
                                <tr><td>401</td><td>Missing or invalid API key.</td></tr>
                                <tr><td>402</td><td>Not enough SMS credits.</td></tr>
                                <tr><td>403</td><td>The key is still pending admin approval, is not an SMS key, or the account is suspended.</td></tr>
                                <tr><td>409</td><td>A send with this reference is already in progress.</td></tr>
                                <tr><td>429</td><td>Too many requests, or the send would pass your daily limit.</td></tr>
                                <tr><td>503</td><td>SMS is temporarily unavailable.</td></tr>
                            </tbody>
                        </table>
                    </div>
                </div>
            </CardContent>
        </Card>
    )
}
