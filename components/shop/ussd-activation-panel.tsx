'use client'

/**
 * USSD short-code activation panel.
 *
 * Extracted from app/dashboard/shop/ussd/page.tsx so the sub-agent portal can
 * show the same purchase flow without a second copy drifting from the first.
 * Both callers hit the same endpoint (/api/shop/ussd/activate) — it resolves
 * the shop, the tier price and the eligibility gates from the session, so the
 * only differences here are where "Back" goes and whether platform branding is
 * allowed to show (the sub portal is de-branded).
 */

import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import {
    Smartphone, ArrowLeft, Check, Wallet, Loader2, Copy, ShieldCheck, Signal, Store, PowerOff,
} from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'

interface ActivationInfo {
    /** Master switch. False means the whole feature is off, for everyone. */
    ussdEnabled: boolean
    hasShop: boolean
    eligible: boolean
    /** Why activation is blocked, straight from the API. Null when it isn't. */
    reason: string | null
    isSub: boolean
    status: 'inactive' | 'active'
    shortCode: string | null
    dialCode: string
    role: string
    price: number
}

export interface UssdActivationPanelProps {
    /** Where the "Back" link goes. */
    backHref: string
    backLabel?: string
    /** Where "Set Up Shop" sends someone who has no shop yet. */
    setupHref: string
    /** Sub portal: hide ARHMS naming so the sub keeps their own brand. */
    deBranded?: boolean
}

// Values must match the gateway channel maps (MOOLRE_PAYMENT_CHANNEL_MAP,
// HUBTEL_CHANNEL_MAP, PAYSWITCH_CHANNEL_MAP), which key AirtelTigo as 'AT'.
const NETWORKS = [
    { value: 'MTN', label: 'MTN' },
    { value: 'Telecel', label: 'Telecel' },
    { value: 'AT', label: 'AirtelTigo' },
]

export function UssdActivationPanel({
    backHref,
    backLabel = 'Back to Shop',
    setupHref,
    deBranded = false,
}: UssdActivationPanelProps) {
    const [info, setInfo] = useState<ActivationInfo | null>(null)
    const [loading, setLoading] = useState(true)
    const [method, setMethod] = useState<'wallet' | 'momo'>('wallet')
    const [phone, setPhone] = useState('')
    const [network, setNetwork] = useState('MTN')
    const [reference, setReference] = useState<string | null>(null)
    // Set when Paystack answers 'send_otp' — Telecel and AirtelTigo ask the payer to
    // type a code instead of approving a prompt, so the charge stops half-finished
    // until we send one back.
    const [otpPrompt, setOtpPrompt] = useState<string | null>(null)
    const [otp, setOtp] = useState('')
    const [submitting, setSubmitting] = useState(false)
    const [polling, setPolling] = useState(false)
    const [copied, setCopied] = useState(false)

    const walletLabel = deBranded ? 'Wallet' : 'ARHMS Wallet'

    const loadInfo = useCallback(async () => {
        try {
            const res = await fetch('/api/shop/ussd/activate', { cache: 'no-store' })
            const data = await res.json()
            if (data?.success) setInfo(data)
        } catch {
            toast.error('Could not load activation details')
        } finally {
            setLoading(false)
        }
    }, [])

    useEffect(() => { loadInfo() }, [loadInfo])

    // Gateway payments settle on a webhook, so the page polls until the short
    // code appears rather than trusting the initiate response.
    useEffect(() => {
        if (!polling || !reference) return
        let attempts = 0
        const timer = setInterval(async () => {
            attempts++
            try {
                const res = await fetch('/api/shop/ussd/activate', { cache: 'no-store' })
                const data = await res.json()
                if (data?.status === 'active') {
                    setInfo(data)
                    setPolling(false)
                    clearInterval(timer)
                    toast.success(`Your short code is ${data.shortCode}`)
                    return
                }
            } catch { /* keep polling */ }

            if (attempts >= 40) {
                setPolling(false)
                clearInterval(timer)
                toast.error('Still waiting on payment confirmation. Refresh in a moment.')
            }
        }, 3000)
        return () => clearInterval(timer)
    }, [polling, reference])

    const activate = async () => {
        if (method === 'momo' && !phone.trim()) {
            toast.error('Enter the number to charge')
            return
        }

        setSubmitting(true)
        try {
            const res = await fetch('/api/shop/ussd/activate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    paymentMethod: method === 'wallet' ? 'wallet' : undefined,
                    phone: phone.trim(),
                    network,
                }),
            })
            const data = await res.json()

            if (!res.ok || !data?.success) {
                toast.error(data?.error || 'Activation failed')
                return
            }

            if (data.activated) {
                toast.success(data.message || 'Short code activated!')
                await loadInfo()
                return
            }

            // The charge exists but the network wants a one-time code before it will
            // move any money. Nothing to poll for yet.
            if (data.otpRequired) {
                setReference(data.reference)
                setOtpPrompt(data.message || 'Enter the one-time code sent to your phone.')
                return
            }

            // The gateway confirms on a webhook, so the prompt landing on the handset
            // is only the start — poll until the short code actually exists.
            setReference(data.reference)
            setPolling(true)
            toast.success(data.message || 'Approve the prompt on your phone')
        } catch {
            toast.error('Something went wrong. Please try again.')
        } finally {
            setSubmitting(false)
        }
    }

    const submitOtpCode = async () => {
        if (!otp.trim() || !reference) return

        setSubmitting(true)
        try {
            const res = await fetch('/api/shop/ussd/activate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ otp: otp.trim(), reference }),
            })
            const data = await res.json()

            if (!res.ok || !data?.success) {
                toast.error(data?.error || 'That code was not accepted')
                return
            }

            // Still asking: a wrong digit gets another go rather than dropping the
            // buyer back to a form that would start a second charge.
            if (data.otpRequired) {
                setOtp('')
                setOtpPrompt(data.message || 'Enter the one-time code sent to your phone.')
                return
            }

            setOtpPrompt(null)
            setOtp('')

            if (data.activated) {
                toast.success(data.message || 'Short code activated!')
                await loadInfo()
                return
            }

            setPolling(true)
            toast.success(data.message || 'Code accepted — confirming payment')
        } catch {
            toast.error('Something went wrong. Please try again.')
        } finally {
            setSubmitting(false)
        }
    }

    const copyInstructions = async () => {
        if (!info?.shortCode) return
        await navigator.clipboard.writeText(`Dial ${info.dialCode} and enter short code ${info.shortCode}`)
        setCopied(true)
        toast.success('Copied!')
        setTimeout(() => setCopied(false), 2000)
    }

    if (loading) {
        return (
            <div className="space-y-6 pb-20 md:pb-6">
                <Skeleton className="h-10 w-40" />
                <Skeleton className="h-64 w-full rounded-3xl" />
            </div>
        )
    }

    // ── SWITCHED OFF ─────────────────────────────────────────────────────────
    // Ahead of every other state: while USSD is off there is nothing to buy and
    // an owner's existing code does not answer, so showing either would mislead.
    if (info && !info.ussdEnabled) {
        return (
            <div className="space-y-6 pb-20 md:pb-6">
                <Link href={backHref}><Button variant="ghost" className="gap-2"><ArrowLeft className="w-4 h-4" /> {backLabel}</Button></Link>
                <Card>
                    <CardContent className="py-12 text-center space-y-3">
                        <PowerOff className="w-10 h-10 mx-auto text-muted-foreground" />
                        <p className="font-bold">USSD is currently unavailable</p>
                        <p className="text-sm text-muted-foreground max-w-sm mx-auto">
                            Short codes are switched off for now. Your storefront is unaffected — customers can still
                            buy from you online.
                        </p>
                    </CardContent>
                </Card>
            </div>
        )
    }

    if (!info?.hasShop) {
        return (
            <div className="space-y-6 pb-20 md:pb-6">
                <Link href={backHref}><Button variant="ghost" className="gap-2"><ArrowLeft className="w-4 h-4" /> Back</Button></Link>
                <Card>
                    <CardContent className="py-12 text-center space-y-3">
                        <Store className="w-10 h-10 mx-auto text-muted-foreground" />
                        <p className="font-bold">You need a shop first</p>
                        <p className="text-sm text-muted-foreground">Set up your shop, then come back to activate a short code.</p>
                        <Link href={setupHref}><Button className="mt-2">Set Up Shop</Button></Link>
                    </CardContent>
                </Card>
            </div>
        )
    }

    // ── ALREADY ACTIVE ───────────────────────────────────────────────────────
    if (info.status === 'active' && info.shortCode) {
        return (
            <div className="space-y-6 pb-20 md:pb-6">
                <Link href={backHref}><Button variant="ghost" className="gap-2"><ArrowLeft className="w-4 h-4" /> {backLabel}</Button></Link>

                <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-slate-900 to-black p-8 border border-slate-800 text-center">
                    <div className="inline-flex items-center gap-1.5 px-3 py-1 bg-yellow-400/10 text-yellow-400 rounded-full text-xs font-black border border-yellow-400/30 mb-4">
                        <Check className="w-3.5 h-3.5" /> ACTIVE FOR LIFE
                    </div>
                    <p className="text-slate-400 text-sm">Your customers dial</p>
                    <p className="text-3xl sm:text-4xl font-black text-white font-mono mt-1">{info.dialCode}</p>
                    <p className="text-slate-400 text-sm mt-4">then enter short code</p>
                    <p className="text-4xl sm:text-5xl font-black text-yellow-400 tracking-[0.3em] mt-1">{info.shortCode}</p>

                    <Button onClick={copyInstructions} variant="secondary" className="mt-6 h-11 gap-2 rounded-xl font-bold">
                        {copied ? <Check className="w-4 h-4 text-green-500" /> : <Copy className="w-4 h-4" />}
                        {copied ? 'Copied!' : 'Copy instructions'}
                    </Button>
                </div>

                <Card>
                    <CardHeader>
                        <CardTitle className="text-base">Put it where customers will see it</CardTitle>
                        <CardDescription>
                            The short code already shows on your storefront. Add it to your flyers, status updates and shop signage —
                            it works on any phone, with no internet.
                        </CardDescription>
                    </CardHeader>
                </Card>
            </div>
        )
    }

    // ── PURCHASE ─────────────────────────────────────────────────────────────
    return (
        <div className="space-y-6 pb-20 md:pb-6">
            <Link href={backHref}><Button variant="ghost" className="gap-2"><ArrowLeft className="w-4 h-4" /> {backLabel}</Button></Link>

            <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-slate-900 to-slate-800 dark:from-black dark:to-zinc-900 p-8 border border-slate-700">
                <Smartphone className="w-10 h-10 text-yellow-400 mb-4" />
                <h1 className="text-2xl sm:text-3xl font-black text-white">USSD Short Code</h1>
                <p className="text-slate-300 mt-2 max-w-lg">
                    Get your own 4-character short code. Customers dial{' '}
                    <span className="font-mono text-white">{info.dialCode || 'the USSD code'}</span>,
                    enter your code, and buy your bundles and result checkers straight from their phone — no internet, no app.
                </p>
                <div className="mt-6 flex items-baseline gap-2">
                    <span className="text-4xl font-black text-yellow-400">GHS {Number(info.price).toFixed(2)}</span>
                    <span className="text-slate-400 text-sm">one time · yours for life</span>
                </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-3">
                {[
                    { icon: Signal, title: 'Works with no internet', body: 'Any phone that can dial can buy from you.' },
                    { icon: Wallet, title: 'Your prices, your profit', body: 'Sales use your storefront prices and pay into your shop wallet.' },
                    { icon: ShieldCheck, title: 'No recurring fee', body: 'Pay once. The code stays yours.' },
                ].map((f) => (
                    <Card key={f.title}>
                        <CardContent className="pt-6 space-y-2">
                            <f.icon className="w-5 h-5 text-emerald-600" />
                            <p className="font-bold text-sm">{f.title}</p>
                            <p className="text-xs text-muted-foreground">{f.body}</p>
                        </CardContent>
                    </Card>
                ))}
            </div>

            {!info.eligible ? (
                <Card>
                    <CardContent className="py-8 text-center space-y-2">
                        <p className="font-bold">You can&apos;t activate a short code yet</p>
                        <p className="text-sm text-muted-foreground">
                            {info.reason || 'Your shop is awaiting approval. Once approved, you can activate your short code here.'}
                        </p>
                    </CardContent>
                </Card>
            ) : (
                <Card>
                    <CardHeader>
                        <CardTitle className="text-base">Pay for your short code</CardTitle>
                        <CardDescription>Priced for your account: GHS {Number(info.price).toFixed(2)}</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-5">
                        <div className="grid grid-cols-2 gap-3">
                            <button
                                type="button"
                                onClick={() => setMethod('wallet')}
                                className={cn(
                                    'rounded-2xl border-2 p-4 text-left transition-colors',
                                    method === 'wallet' ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-950/30' : 'border-gray-200 dark:border-gray-800'
                                )}
                            >
                                <Wallet className="w-5 h-5 text-emerald-600 mb-2" />
                                <p className="font-bold text-sm">{walletLabel}</p>
                                <p className="text-xs text-muted-foreground">Instant — no phone prompt</p>
                            </button>
                            <button
                                type="button"
                                onClick={() => setMethod('momo')}
                                className={cn(
                                    'rounded-2xl border-2 p-4 text-left transition-colors',
                                    method === 'momo' ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-950/30' : 'border-gray-200 dark:border-gray-800'
                                )}
                            >
                                <Smartphone className="w-5 h-5 text-emerald-600 mb-2" />
                                <p className="font-bold text-sm">Mobile Money</p>
                                <p className="text-xs text-muted-foreground">Approve on your phone</p>
                            </button>
                        </div>

                        {method === 'momo' && (
                            <div className="space-y-4">
                                <div className="space-y-2">
                                    <Label>Network</Label>
                                    <div className="flex gap-2">
                                        {NETWORKS.map((n) => (
                                            <button
                                                key={n.value}
                                                type="button"
                                                onClick={() => setNetwork(n.value)}
                                                className={cn(
                                                    'flex-1 rounded-xl border-2 py-2 text-sm font-bold transition-colors',
                                                    network === n.value ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-950/30' : 'border-gray-200 dark:border-gray-800'
                                                )}
                                            >
                                                {n.label}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                                <div className="space-y-2">
                                    <Label>Mobile money number</Label>
                                    <Input
                                        value={phone}
                                        onChange={(e) => setPhone(e.target.value)}
                                        placeholder="0XXXXXXXXX"
                                        inputMode="tel"
                                    />
                                </div>
                                <p className="text-xs text-muted-foreground">
                                    You&apos;ll get a prompt on this number to approve the payment.
                                </p>
                            </div>
                        )}

                        {otpPrompt ? (
                            // The charge is already open with the network, so this
                            // replaces the pay button rather than sitting beside it —
                            // pressing "Activate" again here would start a second one.
                            <div className="space-y-3 rounded-2xl border-2 border-emerald-500 bg-emerald-50 dark:bg-emerald-950/30 p-4">
                                <div className="space-y-2">
                                    <Label>One-time code</Label>
                                    <Input
                                        value={otp}
                                        onChange={(e) => setOtp(e.target.value)}
                                        placeholder="Enter the code"
                                        inputMode="numeric"
                                        autoFocus
                                    />
                                </div>
                                <p className="text-xs text-muted-foreground">{otpPrompt}</p>
                                <Button
                                    onClick={submitOtpCode}
                                    disabled={submitting || !otp.trim()}
                                    className="w-full h-12 rounded-xl bg-yellow-400 hover:bg-yellow-500 text-slate-900 font-black text-base"
                                >
                                    {submitting ? (
                                        <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Confirming…</>
                                    ) : (
                                        <>Confirm payment</>
                                    )}
                                </Button>
                            </div>
                        ) : (
                            <Button
                                onClick={activate}
                                disabled={submitting || polling}
                                className="w-full h-12 rounded-xl bg-yellow-400 hover:bg-yellow-500 text-slate-900 font-black text-base"
                            >
                                {submitting || polling ? (
                                    <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> {polling ? 'Waiting for payment…' : 'Processing…'}</>
                                ) : (
                                    <>Activate for GHS {Number(info.price).toFixed(2)}</>
                                )}
                            </Button>
                        )}

                        <p className="text-xs text-center text-muted-foreground">
                            One-time payment. Your short code is generated the moment payment clears.
                        </p>
                    </CardContent>
                </Card>
            )}
        </div>
    )
}
