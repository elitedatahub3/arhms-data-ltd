'use client'

/**
 * Compose and send.
 *
 * The cost shown is an estimate for group sends (a customer in two groups is
 * only messaged — and charged — once, which the page cannot see), so it is
 * labelled "up to". The segment count is exact: it runs the same countSegments
 * the send route charges with.
 */

import { useMemo, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
    Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
    Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog'
import { Send, Loader2, Users, AlertTriangle, CheckCircle2 } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { countSegments, SMS_MESSAGE_MAX, SMS_MESSAGE_MIN } from '@/lib/sms/sms-rules'
import type { SmsGroup } from '@/components/sms/sms-contacts'

export interface AllowedSender {
    sender: string
    type: 'own' | 'pool'
    isDefault: boolean
}

const ALL_CUSTOMERS = '__all__'

export function SmsCompose({
    credits,
    allowedSenders,
    groups,
    contactCount,
    onSent,
    onNeedCredits,
    onNeedSender,
}: {
    credits: number
    allowedSenders: AllowedSender[]
    groups: SmsGroup[]
    contactCount: number
    onSent: (campaignId: string) => void
    onNeedCredits: () => void
    onNeedSender: () => void
}) {
    const defaultSender = allowedSenders.find((s) => s.isDefault) ?? allowedSenders.find((s) => s.type === 'own') ?? allowedSenders[0]
    const [sender, setSender] = useState(defaultSender?.sender ?? '')
    const [message, setMessage] = useState('')
    const [targets, setTargets] = useState<Set<string>>(new Set())
    const [extraNumbers, setExtraNumbers] = useState('')
    const [confirmOpen, setConfirmOpen] = useState(false)
    const [sending, setSending] = useState(false)
    // A fresh key per compose, so a double-tap or a retry after a timeout returns
    // the first campaign instead of sending (and charging) twice.
    const [reference, setReference] = useState(() => crypto.randomUUID())

    const segmentInfo = useMemo(() => countSegments(message), [message])
    const extraList = useMemo(
        () => extraNumbers.split(/[\s,;]+/).map((n) => n.trim()).filter((n) => /\d{9,}/.test(n)),
        [extraNumbers]
    )

    const estimatedRecipients = useMemo(() => {
        if (targets.has(ALL_CUSTOMERS)) {
            const subs = groups.find((g) => g.system && targets.has(g.id))?.memberCount ?? 0
            return contactCount + subs + extraList.length
        }
        const fromGroups = groups.filter((g) => targets.has(g.id)).reduce((sum, g) => sum + g.memberCount, 0)
        return fromGroups + extraList.length
    }, [targets, groups, contactCount, extraList])

    const estimatedCost = segmentInfo.segments * estimatedRecipients
    const hasOwnSender = allowedSenders.some((s) => s.type === 'own')
    const tooShort = message.trim().length < SMS_MESSAGE_MIN

    const toggleTarget = (id: string) => {
        setTargets((prev) => {
            const next = new Set(prev)
            if (next.has(id)) next.delete(id)
            else next.add(id)
            return next
        })
    }

    const openConfirm = () => {
        if (!allowedSenders.length) { onNeedSender(); return }
        if (tooShort) { toast.error(`Write at least ${SMS_MESSAGE_MIN} characters`); return }
        if (!estimatedRecipients) { toast.error('Choose who to send to'); return }
        if (estimatedCost > credits && !targets.size) {
            toast.error(`This send needs ${estimatedCost} credits but you have ${credits}`)
            onNeedCredits()
            return
        }
        setConfirmOpen(true)
    }

    const send = async () => {
        setSending(true)
        try {
            const res = await fetch('/api/sms/send', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    message: message.trim(),
                    sender,
                    reference,
                    recipients: extraList,
                    groupIds: [...targets].filter((t) => t !== ALL_CUSTOMERS),
                    allContacts: targets.has(ALL_CUSTOMERS),
                }),
            })
            const data = await res.json()

            if (res.status === 402) {
                toast.error(data?.error || 'Not enough SMS credits')
                setConfirmOpen(false)
                onNeedCredits()
                return
            }
            if (!res.ok || !data?.success) {
                toast.error(data?.error || 'Send failed')
                return
            }

            if (data.status === 'queued') {
                toast.success(`${data.recipients} messages queued · ${data.creditsCharged} credits used`)
            } else {
                const failedNote = data.failed ? ` · ${data.failed} failed (refunded)` : ''
                toast.success(`Sent to ${data.sent} customer${data.sent === 1 ? '' : 's'}${failedNote}`)
            }
            if (data.invalid?.length) toast.warning(`${data.invalid.length} invalid number(s) skipped`)
            if (data.optedOut) toast.info(`${data.optedOut} opted-out customer(s) skipped`)

            setConfirmOpen(false)
            setMessage('')
            setExtraNumbers('')
            setTargets(new Set())
            setReference(crypto.randomUUID())
            onSent(data.campaignId)
        } catch {
            // Deliberately keep the reference: retrying after a network error
            // must not become a second send if the first one actually landed.
            toast.error('Could not confirm the send. Check History before trying again.')
        } finally {
            setSending(false)
        }
    }

    if (!allowedSenders.length) {
        return (
            <Card>
                <CardContent className="py-10 text-center space-y-3">
                    <AlertTriangle className="w-8 h-8 mx-auto text-amber-500" />
                    <p className="font-bold">You need a sender ID first</p>
                    <p className="text-sm text-muted-foreground max-w-sm mx-auto">
                        Request your sender ID. Once the networks approve it, you can start messaging your customers.
                    </p>
                    <Button onClick={onNeedSender} className="bg-emerald-600 hover:bg-emerald-700">Request sender ID</Button>
                </CardContent>
            </Card>
        )
    }

    const targetChips = [
        { id: ALL_CUSTOMERS, label: 'All my customers', count: contactCount },
        ...groups.map((g) => ({ id: g.id, label: g.name, count: g.memberCount })),
    ]

    return (
        <>
            <Card>
                <CardHeader>
                    <CardTitle className="text-base flex items-center gap-2"><Send className="w-4 h-4 text-emerald-600" /> Send SMS</CardTitle>
                    {!hasOwnSender && (
                        <CardDescription>
                            You are sending from a shared sender name until your own sender ID is approved.
                        </CardDescription>
                    )}
                </CardHeader>
                <CardContent className="space-y-5">
                    <div className="space-y-2">
                        <Label>Send as</Label>
                        <Select value={sender} onValueChange={setSender}>
                            <SelectTrigger><SelectValue /></SelectTrigger>
                            <SelectContent>
                                {allowedSenders.map((s) => (
                                    <SelectItem key={s.sender} value={s.sender}>
                                        {s.sender} {s.type === 'pool' ? '(shared)' : ''}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>

                    <div className="space-y-2">
                        <Label>To</Label>
                        <div className="flex flex-wrap gap-2">
                            {targetChips.map((t) => (
                                <button
                                    key={t.id}
                                    type="button"
                                    onClick={() => toggleTarget(t.id)}
                                    className={cn(
                                        'inline-flex items-center gap-1.5 rounded-full border-2 px-3 py-1.5 text-xs font-semibold transition-colors',
                                        targets.has(t.id) ? 'border-emerald-500 bg-emerald-50 text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300' : 'border-gray-200 dark:border-gray-800'
                                    )}
                                >
                                    {targets.has(t.id) ? <CheckCircle2 className="w-3.5 h-3.5" /> : <Users className="w-3.5 h-3.5" />}
                                    {t.label} · {t.count.toLocaleString()}
                                </button>
                            ))}
                        </div>
                        <Textarea
                            value={extraNumbers}
                            onChange={(e) => setExtraNumbers(e.target.value)}
                            rows={2}
                            placeholder="Or type numbers: 0551234567, 0209876543"
                            className="font-mono text-sm"
                        />
                    </div>

                    <div className="space-y-2">
                        <Label>Message</Label>
                        <Textarea
                            value={message}
                            onChange={(e) => setMessage(e.target.value.slice(0, SMS_MESSAGE_MAX))}
                            rows={5}
                            placeholder="Hi! New stock just arrived at our shop. Order today on our storefront."
                        />
                        <div className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
                            <span>
                                {message.length}/{SMS_MESSAGE_MAX} · {segmentInfo.segments} SMS part{segmentInfo.segments === 1 ? '' : 's'} · {segmentInfo.remaining} left in this part
                            </span>
                            {segmentInfo.encoding === 'UCS-2' && (
                                <span className="text-amber-600">Emoji or special characters: 70 characters per part</span>
                            )}
                        </div>
                    </div>

                    <div className="grid grid-cols-3 gap-2 rounded-2xl bg-muted/60 p-3 text-center">
                        <div>
                            <p className="text-xs text-muted-foreground">Recipients</p>
                            <p className="font-black">{estimatedRecipients.toLocaleString()}</p>
                        </div>
                        <div>
                            <p className="text-xs text-muted-foreground">Cost</p>
                            <p className={cn('font-black', estimatedCost > credits && 'text-red-600')}>
                                {targets.size ? 'up to ' : ''}{estimatedCost.toLocaleString()}
                            </p>
                        </div>
                        <div>
                            <p className="text-xs text-muted-foreground">Balance</p>
                            <p className="font-black">{credits.toLocaleString()}</p>
                        </div>
                    </div>

                    {estimatedCost > credits && (
                        <p className="text-xs text-red-600 flex items-center gap-1.5">
                            <AlertTriangle className="w-3.5 h-3.5" />
                            You may not have enough credits.
                            <button type="button" onClick={onNeedCredits} className="underline font-semibold">Buy credits</button>
                        </p>
                    )}

                    <Button
                        onClick={openConfirm}
                        disabled={tooShort || !estimatedRecipients || sending}
                        className="w-full h-12 rounded-xl bg-emerald-600 hover:bg-emerald-700 font-bold text-base gap-2"
                    >
                        <Send className="w-4 h-4" /> Review & send
                    </Button>
                    <p className="text-[11px] text-center text-muted-foreground">
                        Messages pretending to be MoMo receipts or network alerts are blocked and may suspend your account.
                    </p>
                </CardContent>
            </Card>

            <Dialog open={confirmOpen} onOpenChange={(open) => !sending && setConfirmOpen(open)}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Send this SMS?</DialogTitle>
                        <DialogDescription>
                            From <span className="font-mono font-semibold">{sender}</span> to {targets.size ? 'up to ' : ''}
                            {estimatedRecipients.toLocaleString()} customer{estimatedRecipients === 1 ? '' : 's'}.
                        </DialogDescription>
                    </DialogHeader>
                    <div className="rounded-2xl bg-muted p-3 text-sm whitespace-pre-wrap break-words">{message.trim()}</div>
                    <p className="text-xs text-muted-foreground">
                        {targets.size ? 'Up to ' : ''}{estimatedCost.toLocaleString()} credits. Duplicates and opted-out customers are not charged, and
                        messages the network rejects are refunded.
                    </p>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setConfirmOpen(false)} disabled={sending}>Edit</Button>
                        <Button onClick={send} disabled={sending} className="bg-emerald-600 hover:bg-emerald-700 gap-2">
                            {sending ? <><Loader2 className="w-4 h-4 animate-spin" /> Sending…</> : <><Send className="w-4 h-4" /> Send now</>}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    )
}
