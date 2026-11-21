'use client'

/**
 * Checkout for a Shop AI credit pack: pay from the Wallet or with Direct Pay
 * (Mobile Money / card). Same flow as the Standard Bundles dialog:
 *   - Wallet  -> POST /api/ai-assistant/shop-settings (buyCreditPack, idempotent)
 *   - Direct  -> POST /api/ai-assistant/shop-credits/pay (quote, prompt/OTP, Paystack page),
 *                then poll /api/payments/verify until the credits are added.
 * Prices and fees always come from the server.
 */
import { useEffect, useRef, useState } from 'react'
import { Loader2, Smartphone, Wallet } from 'lucide-react'
import { toast } from 'sonner'
import { useAuth } from '@/contexts/auth-context'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'

export interface CheckoutPack { id: string; name: string; credits: number; price: number }

type NetworkId = 'MTN' | 'Telecel' | 'AT'
const NETWORKS: { id: NetworkId; label: string; prefixes: string[] }[] = [
    { id: 'MTN', label: 'MTN', prefixes: ['024', '025', '053', '054', '055', '059', '098'] },
    { id: 'Telecel', label: 'Telecel', prefixes: ['020', '050'] },
    { id: 'AT', label: 'AirtelTigo', prefixes: ['026', '027', '028', '056', '057', '058'] },
]
const networkForPhone = (p: string): NetworkId | null => {
    const d = p.replace(/\D/g, '')
    return d.length < 3 ? null : NETWORKS.find(n => n.prefixes.includes(d.slice(0, 3)))?.id ?? null
}
const ghs = (n: number) => `GH₵${Number(n || 0).toFixed(2)}`
const newKey = () =>
    typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`

// MTN approvals can be confirmed only at ~+220s or ~+601s (see Standard Bundles).
const POLL_MS = 5000
const POLL_TIMEOUT_MS = 15 * 60 * 1000
export const CREDIT_PAY_PREFIX = 'AICPAY-'

interface Quote { gateway: string; needsMomoDetails: boolean; price: number; fee: number; total: number }

export function CreditPackCheckout({
    pack,
    walletBalance,
    resumeRef,
    onClose,
    onDone,
}: {
    pack: CheckoutPack | null
    walletBalance: number
    /** A Paystack return (?reference=AICPAY-...) to keep waiting on. */
    resumeRef?: string | null
    onClose: () => void
    onDone: (credits: number | null) => void
}) {
    const { dbUser } = useAuth() as any
    const open = !!pack || !!resumeRef
    const [method, setMethod] = useState<'wallet' | 'direct'>('wallet')
    const [submitting, setSubmitting] = useState(false)
    const walletKey = useRef<string>(newKey())

    const [quote, setQuote] = useState<Quote | null>(null)
    const [quoteLoading, setQuoteLoading] = useState(false)
    const [quoteError, setQuoteError] = useState<string | null>(null)
    const [momoPhone, setMomoPhone] = useState('')
    const [momoNetwork, setMomoNetwork] = useState<NetworkId | ''>('')
    const [momoManual, setMomoManual] = useState(false)
    const [directRef, setDirectRef] = useState<string | null>(null)
    const [otpRequired, setOtpRequired] = useState(false)
    const [otpCode, setOtpCode] = useState('')
    const [otpMessage, setOtpMessage] = useState('')
    const [pollingRef, setPollingRef] = useState<string | null>(null)
    const [slow, setSlow] = useState(false)

    const short = !!pack && walletBalance < pack.price
    const momoDigits = momoPhone.replace(/\D/g, '')

    // Fresh state for each pack opened.
    useEffect(() => {
        if (!pack) return
        walletKey.current = newKey()
        setMethod(walletBalance < pack.price ? 'direct' : 'wallet')
        setDirectRef(null)
        setOtpRequired(false)
        setOtpCode('')
        setSubmitting(false)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pack])

    useEffect(() => {
        if (resumeRef) { setPollingRef(resumeRef); setSubmitting(true) }
    }, [resumeRef])

    useEffect(() => {
        if (dbUser?.phone_number && !momoPhone) setMomoPhone(String(dbUser.phone_number).replace(/\D/g, '').replace(/^233/, '0'))
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [dbUser?.phone_number])

    useEffect(() => {
        if (!momoManual) setMomoNetwork(networkForPhone(momoDigits) ?? '')
    }, [momoDigits, momoManual])

    // The fee comes from the server, so the figure shown is the figure charged.
    useEffect(() => {
        if (method !== 'direct' || !pack) { setQuote(null); setQuoteError(null); return }
        let cancelled = false
        setQuoteLoading(true)
        setQuoteError(null)
        fetch('/api/ai-assistant/shop-credits/pay', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ packId: pack.id, quote: true }),
        })
            .then(r => r.json().then(b => ({ ok: r.ok, b })))
            .then(({ ok, b }) => {
                if (cancelled) return
                if (ok && b?.success) setQuote(b)
                else { setQuote(null); setQuoteError(b?.error || 'Could not price Direct Pay') }
            })
            .catch(() => { if (!cancelled) setQuoteError('Could not price Direct Pay') })
            .finally(() => { if (!cancelled) setQuoteLoading(false) })
        return () => { cancelled = true }
    }, [method, pack])

    const needsMomo = quote?.needsMomoDetails ?? true
    const momoReady = !needsMomo || (/^0\d{9}$/.test(momoDigits) && !!momoNetwork)

    const finish = (credits: number | null) => {
        setPollingRef(null)
        setSlow(false)
        setSubmitting(false)
        setDirectRef(null)
        toast.success(credits ? `Payment received. ${credits} credits added.` : 'Payment received. Your credits have been added.')
        onDone(credits)
    }

    async function payWallet() {
        if (!pack || submitting) return
        setSubmitting(true)
        try {
            const res = await fetch('/api/ai-assistant/shop-settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ packId: pack.id, idempotencyKey: walletKey.current }),
            })
            const data = await res.json().catch(() => ({}))
            if (res.ok && data.ok) {
                toast.success(`${data.credits} credits added`)
                onDone(data.credits)
            } else {
                toast.error(data.error || 'Payment failed. You were not charged.')
                if (res.status !== 409) walletKey.current = newKey()
            }
        } finally {
            setSubmitting(false)
        }
    }

    async function callPay(extra: Record<string, unknown>) {
        const res = await fetch('/api/ai-assistant/shop-credits/pay', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ packId: pack?.id, momoPhone: momoDigits, momoNetwork, ...extra }),
        })
        return { res, body: await res.json().catch(() => ({})) }
    }

    async function startDirect() {
        if (!pack || submitting || !quote) return
        if (!momoReady) { toast.error('Enter the Mobile Money number and network to pay from'); return }
        setSubmitting(true)
        try {
            const { res, body } = await callPay({})
            // A charge is already live for this number: go back to it instead of starting another.
            if (!res.ok && body?.resumable && body?.reference) {
                setDirectRef(body.reference)
                if (body.otpRequired) { setOtpMessage(body.error || ''); setOtpRequired(true); setSubmitting(false) }
                else { toast.info(body.error || 'A payment prompt is already waiting on your phone.'); setPollingRef(body.reference) }
                return
            }
            if (!res.ok || !body?.success) throw new Error(body?.error || 'Payment could not be started')
            if (body.gateway === 'paystack' && body.authorization_url) {
                window.location.href = body.authorization_url
                return
            }
            setDirectRef(body.reference)
            if (body.otpRequired) { setOtpMessage(body.message || ''); setOtpRequired(true); setSubmitting(false); return }
            toast.success(body.message || 'Payment prompt sent. Approve it on your phone.')
            setPollingRef(body.reference)
        } catch (e: any) {
            toast.error(e?.message || 'Failed to start payment')
            setSubmitting(false)
        }
    }

    async function verifyOtp() {
        if (!otpCode.trim() || !directRef) { toast.error('Enter the code sent to your phone'); return }
        setSubmitting(true)
        try {
            const { res, body } = await callPay({ otpCode: otpCode.trim(), reference: directRef })
            if (!res.ok) throw new Error(body?.error || 'Invalid code. Please try again.')
            setOtpRequired(false)
            setOtpCode('')
            toast.success(body?.message || 'Code accepted. Approve the prompt on your phone.')
            setPollingRef(body?.reference || directRef)
        } catch (e: any) {
            toast.error(e?.message || 'Failed to verify the code')
            setSubmitting(false)
        }
    }

    // Poll until the gateway confirms and the credits are added.
    useEffect(() => {
        if (!pollingRef) return
        const startedAt = Date.now()
        let stopped = false
        const tick = async () => {
            if (stopped) return
            const elapsed = Date.now() - startedAt
            if (elapsed > 3 * 60 * 1000) setSlow(true)
            if (elapsed >= POLL_TIMEOUT_MS) {
                stopped = true
                setPollingRef(null)
                setSubmitting(false)
                toast.error('Still waiting on the payment confirmation. If you approved it, your credits will be added once it is confirmed.')
                return
            }
            try {
                const res = await fetch(`/api/payments/verify?reference=${encodeURIComponent(pollingRef)}`, { headers: { Accept: 'application/json' } })
                const data = await res.json().catch(() => ({}))
                if (stopped) return
                if (data.status === 'completed') {
                    if (!data.order) return // credits are written a moment after the claim
                    stopped = true
                    finish(Number(data.order.credits) || null)
                } else if (data.status === 'failed') {
                    stopped = true
                    setPollingRef(null)
                    setSlow(false)
                    setSubmitting(false)
                    toast.error(data.message || data.error || 'Payment failed or was cancelled. You have not been charged.')
                }
            } catch {
                /* network blip: next tick */
            }
        }
        const t = setInterval(tick, POLL_MS)
        return () => { stopped = true; clearInterval(t) }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pollingRef])

    const close = () => { if (!submitting || pollingRef) onClose() }

    return (
        <Dialog open={open} onOpenChange={o => { if (!o) close() }}>
            <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>{pack ? `Buy ${pack.name}` : 'Shop AI credits'}</DialogTitle>
                    <DialogDescription>{pack ? `${pack.credits.toLocaleString()} credits for your shop assistant` : 'Waiting for your payment'}</DialogDescription>
                </DialogHeader>

                {pollingRef ? (
                    <div className="space-y-3 py-4 text-center">
                        <Smartphone className="mx-auto h-10 w-10 text-sky-500" />
                        <p className="font-bold">Approve the payment on your phone</p>
                        <p className="text-sm text-muted-foreground">
                            {slow
                                ? 'Still waiting. MTN can take up to 10 minutes to confirm. You can close this; your credits will still be added once it is confirmed.'
                                : 'Enter your MoMo PIN when the prompt appears. We add the credits as soon as the payment is confirmed.'}
                        </p>
                        <Loader2 className="mx-auto h-6 w-6 animate-spin text-muted-foreground" />
                    </div>
                ) : otpRequired ? (
                    <div className="space-y-3">
                        <p className="text-sm text-muted-foreground">{otpMessage || 'Enter the one-time code sent to your phone.'}</p>
                        <Input inputMode="numeric" autoComplete="one-time-code" placeholder="Code" value={otpCode} maxLength={8}
                            onChange={e => setOtpCode(e.target.value.replace(/\D/g, ''))} />
                    </div>
                ) : pack ? (
                    <div className="space-y-4">
                        <div className="grid grid-cols-2 gap-2">
                            {([
                                { id: 'wallet', icon: Wallet, title: 'Wallet', sub: `${ghs(walletBalance)} available` },
                                { id: 'direct', icon: Smartphone, title: 'Direct Pay', sub: 'Mobile Money' },
                            ] as const).map(m => (
                                <button key={m.id} type="button" onClick={() => setMethod(m.id)}
                                    className={cn('flex items-center gap-2 rounded-xl border p-3 text-left transition-colors',
                                        method === m.id ? 'border-foreground bg-secondary/60 shadow-sm' : 'hover:border-foreground/30')}>
                                    <m.icon className={cn('h-5 w-5 shrink-0', m.id === 'wallet' ? 'text-emerald-600' : 'text-sky-500')} />
                                    <span className="min-w-0">
                                        <span className="block text-sm font-bold">{m.title}</span>
                                        <span className="block truncate text-xs text-muted-foreground">{m.sub}</span>
                                    </span>
                                </button>
                            ))}
                        </div>

                        {method === 'direct' && needsMomo && (
                            <div className="space-y-3">
                                <div className="space-y-1.5">
                                    <Label htmlFor="credit-momo">Mobile Money number to pay from</Label>
                                    <Input id="credit-momo" inputMode="numeric" autoComplete="tel" placeholder="0241234567" value={momoPhone} maxLength={10}
                                        onChange={e => setMomoPhone(e.target.value.replace(/\D/g, '').slice(0, 10))} />
                                </div>
                                <div className="grid grid-cols-3 gap-2">
                                    {NETWORKS.map(n => (
                                        <button key={n.id} type="button" onClick={() => { setMomoNetwork(n.id); setMomoManual(true) }}
                                            className={cn('rounded-xl border py-2 text-xs font-bold transition-colors',
                                                momoNetwork === n.id ? 'border-foreground bg-secondary/60 shadow-sm' : 'text-muted-foreground hover:border-foreground/30')}>
                                            {n.label}
                                        </button>
                                    ))}
                                </div>
                            </div>
                        )}

                        <div className="space-y-1.5 rounded-xl bg-secondary/60 p-3 text-sm">
                            <div className="flex justify-between"><span className="text-muted-foreground">Credits</span><span className="font-bold">{pack.credits.toLocaleString()}</span></div>
                            <div className="flex justify-between"><span className="text-muted-foreground">Price</span><span className="font-bold">{ghs(pack.price)}</span></div>
                            {method === 'wallet' ? (
                                <div className="flex justify-between"><span className="text-muted-foreground">Wallet after</span><span className={cn('font-bold', short && 'text-red-600')}>{ghs(walletBalance - pack.price)}</span></div>
                            ) : (
                                <>
                                    <div className="flex justify-between"><span className="text-muted-foreground">Payment fee</span><span className="font-bold">{quote ? ghs(quote.fee) : quoteLoading ? '…' : '-'}</span></div>
                                    <div className="flex justify-between border-t pt-1.5"><span className="text-muted-foreground">You pay</span><span className="font-black">{quote ? ghs(quote.total) : quoteLoading ? '…' : '-'}</span></div>
                                </>
                            )}
                        </div>

                        {method === 'wallet' && short && (
                            <p className="text-sm text-red-600">
                                Your wallet balance is too low.{' '}
                                <button type="button" className="font-bold underline" onClick={() => setMethod('direct')}>Pay with Mobile Money</button>
                                {' '}or <a href={`/dashboard/wallet?amount=${Math.max(5, Math.ceil((pack.price - walletBalance) * 100) / 100).toFixed(2)}`} className="font-bold underline">top up</a>.
                            </p>
                        )}
                        {method === 'direct' && quoteError && <p className="text-sm text-red-600">{quoteError}</p>}
                    </div>
                ) : null}

                <DialogFooter className="gap-2">
                    {pollingRef ? (
                        <Button variant="outline" onClick={onClose}>Close</Button>
                    ) : otpRequired ? (
                        <>
                            <Button variant="outline" onClick={() => { setOtpRequired(false); setOtpCode('') }} disabled={submitting}>Back</Button>
                            <Button onClick={verifyOtp} disabled={!otpCode.trim() || submitting}>
                                {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Confirm code
                            </Button>
                        </>
                    ) : pack ? (
                        <>
                            <Button variant="outline" onClick={onClose} disabled={submitting}>Cancel</Button>
                            {method === 'wallet' ? (
                                <Button onClick={payWallet} disabled={short || submitting}>
                                    {submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Wallet className="mr-2 h-4 w-4" />}
                                    Pay {ghs(pack.price)} from wallet
                                </Button>
                            ) : (
                                <Button onClick={startDirect} disabled={!quote || quoteLoading || !momoReady || submitting}>
                                    {submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Smartphone className="mr-2 h-4 w-4" />}
                                    {quote ? `Pay ${ghs(quote.total)} now` : 'Pay now'}
                                </Button>
                            )}
                        </>
                    ) : null}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}
