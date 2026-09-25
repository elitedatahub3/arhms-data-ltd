'use client'

/**
 * Sender ID requests: the brand name the owner's customers see as the sender.
 *
 * The tips sit above the input on purpose — the most common rejection is a name
 * like "KOFI DATA" or "MTN BUNDLES", and it is far kinder to say so before the
 * owner types it than after an admin and a network have both refused it.
 */

import { useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Lightbulb, Loader2, XCircle, CheckCircle2, Clock, Send } from 'lucide-react'
import { toast } from 'sonner'
import { validateSenderId, SENDER_ID_TIPS, SENDER_ID_MAX } from '@/lib/sms/sms-rules'

export interface SenderIdRow {
    id: string
    sender: string
    status: 'pending' | 'submitted' | 'approved' | 'rejected'
    rejection_reason: string | null
    is_default: boolean
    created_at: string
}

const STATUS_META: Record<SenderIdRow['status'], { label: string; className: string; icon: any; help: string }> = {
    pending: {
        label: 'Under review',
        className: 'bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300',
        icon: Clock,
        help: 'We are checking your request before sending it to the networks.',
    },
    submitted: {
        label: 'With the networks',
        className: 'bg-blue-100 text-blue-800 dark:bg-blue-950/40 dark:text-blue-300',
        icon: Send,
        help: 'Sent to the networks for registration. This can take a few working days.',
    },
    approved: {
        label: 'Approved',
        className: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300',
        icon: CheckCircle2,
        help: 'Your customers will see this name as the sender.',
    },
    rejected: {
        label: 'Not approved',
        className: 'bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-300',
        icon: XCircle,
        help: 'You can request a different name.',
    },
}

export function SmsSenderIds({
    senderIds,
    shopName,
    onChanged,
}: {
    senderIds: SenderIdRow[]
    shopName?: string | null
    onChanged: () => void
}) {
    const [sender, setSender] = useState('')
    const [businessName, setBusinessName] = useState(shopName || '')
    const [submitting, setSubmitting] = useState(false)

    const check = sender.trim() ? validateSenderId(sender) : null

    const submit = async () => {
        const result = validateSenderId(sender)
        if (!result.ok) {
            toast.error(result.error)
            return
        }
        setSubmitting(true)
        try {
            const res = await fetch('/api/sms/senders', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sender: sender.trim(), businessName: businessName.trim() }),
            })
            const data = await res.json()
            if (!res.ok || !data?.success) {
                toast.error(data?.error || 'Could not submit your sender ID')
                return
            }
            toast.success(data.message || 'Sender ID submitted')
            setSender('')
            onChanged()
        } catch {
            toast.error('Something went wrong. Please try again.')
        } finally {
            setSubmitting(false)
        }
    }

    return (
        <div className="space-y-4">
            <Card className="border-amber-300 bg-amber-50/60 dark:border-amber-900 dark:bg-amber-950/20">
                <CardHeader className="pb-3">
                    <CardTitle className="text-base flex items-center gap-2">
                        <Lightbulb className="w-4 h-4 text-amber-600" /> Before you choose a name
                    </CardTitle>
                </CardHeader>
                <CardContent>
                    <ul className="space-y-2 text-sm">
                        {SENDER_ID_TIPS.map((tip) => (
                            <li key={tip} className="flex gap-2">
                                <span className="text-amber-600 font-bold">•</span>
                                <span>{tip}</span>
                            </li>
                        ))}
                    </ul>
                    <div className="mt-4 grid grid-cols-2 gap-2 text-xs">
                        <div className="rounded-lg border border-emerald-300 bg-white dark:bg-transparent p-2">
                            <p className="font-bold text-emerald-700 dark:text-emerald-400 mb-1">Good</p>
                            <p className="font-mono">KofiStores · AmaBeauty · GH Gadgets</p>
                        </div>
                        <div className="rounded-lg border border-red-300 bg-white dark:bg-transparent p-2">
                            <p className="font-bold text-red-700 dark:text-red-400 mb-1">Rejected</p>
                            <p className="font-mono">KofiData · MTN Bundle · MoMo Hub</p>
                        </div>
                    </div>
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle className="text-base">Request a sender ID</CardTitle>
                    <CardDescription>Your customers will see this name instead of a phone number.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    <div className="space-y-2">
                        <Label>Sender ID</Label>
                        <Input
                            value={sender}
                            onChange={(e) => setSender(e.target.value.slice(0, SENDER_ID_MAX))}
                            placeholder="e.g. KofiStores"
                            maxLength={SENDER_ID_MAX}
                        />
                        <div className="flex justify-between text-xs">
                            <span className={check && !check.ok ? 'text-red-600' : 'text-emerald-600'}>
                                {check ? (check.ok ? 'Looks good' : check.error) : ''}
                            </span>
                            <span className="text-muted-foreground">{sender.length}/{SENDER_ID_MAX}</span>
                        </div>
                    </div>
                    <div className="space-y-2">
                        <Label>Registered business name</Label>
                        <Input value={businessName} onChange={(e) => setBusinessName(e.target.value)} placeholder="As on your business documents" />
                    </div>
                    <Button onClick={submit} disabled={submitting || !check?.ok} className="w-full h-11 rounded-xl bg-emerald-600 hover:bg-emerald-700 font-bold">
                        {submitting ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Submitting…</> : 'Submit for approval'}
                    </Button>
                </CardContent>
            </Card>

            {senderIds.length > 0 && (
                <Card>
                    <CardHeader><CardTitle className="text-base">Your sender IDs</CardTitle></CardHeader>
                    <CardContent className="space-y-3">
                        {senderIds.map((row) => {
                            const meta = STATUS_META[row.status]
                            const Icon = meta.icon
                            return (
                                <div key={row.id} className="rounded-xl border p-3 space-y-1">
                                    <div className="flex items-center justify-between gap-2">
                                        <p className="font-mono font-bold">{row.sender}</p>
                                        <div className="flex items-center gap-1.5">
                                            {row.is_default && <Badge variant="outline">Default</Badge>}
                                            <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ${meta.className}`}>
                                                <Icon className="w-3 h-3" /> {meta.label}
                                            </span>
                                        </div>
                                    </div>
                                    <p className="text-xs text-muted-foreground">
                                        {row.status === 'rejected' && row.rejection_reason ? `Reason: ${row.rejection_reason}` : meta.help}
                                    </p>
                                </div>
                            )
                        })}
                    </CardContent>
                </Card>
            )}
        </div>
    )
}
