'use client'

/**
 * Standard Bundles on a shop storefront (guest checkout).
 *
 * scope:
 *  - 'special'    only the MTN Special Bundles (shown as the DATA tile's MTN tab
 *                 when the shop sells no MTN data of its own)
 *  - 'no-special' everything except the Special Bundles
 *  - 'all'        everything, Special Bundles first
 *
 * Prices come from /api/shop/bundles/catalog (owner's price + the shop's %).
 * Payment: /api/bundles/gateway-init with shopSlug, then /api/shop/bundles/status.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, ShoppingCart, CheckCircle2, XCircle, RefreshCw, Wifi } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

type NetworkId = 'MTN' | 'Telecel' | 'AT'
type Scope = 'special' | 'no-special' | 'all'

const NETWORKS: { id: NetworkId; label: string; prefixes: string[]; bg: string }[] = [
    { id: 'MTN', label: 'MTN', prefixes: ['024', '025', '053', '054', '055', '059', '098'], bg: 'bg-[#ffcc00] text-black' },
    { id: 'Telecel', label: 'Telecel', prefixes: ['020', '050'], bg: 'bg-[#da291c] text-white' },
    { id: 'AT', label: 'AirtelTigo', prefixes: ['026', '027', '056', '057'], bg: 'bg-[#2463eb] text-white' },
]

const networkForPhone = (digits: string): NetworkId | null =>
    digits.length >= 3 ? NETWORKS.find(n => n.prefixes.includes(digits.slice(0, 3)))?.id ?? null : null

interface Bundle { key: string; size: string; family: string; familyLabel: string; validity: string | null; price: number }
interface Family { key: string; label: string; description: string | null }
interface Quote { gateway: string; needsMomoDetails: boolean; price: number; fee: number; total: number }

const POLL_MS = 4000
const POLL_MAX = 75 // ~5 minutes

export default function StorefrontBundles({
    shopSlug,
    brandColor,
    scope,
    networks: allowedNetworks,
}: {
    shopSlug: string
    brandColor?: string
    scope: Scope
    /** Networks to offer (admin per-network switches). 'special' always means MTN. */
    networks: NetworkId[]
}) {
    const offered = scope === 'special' ? (['MTN'] as NetworkId[]) : allowedNetworks
    const [network, setNetwork] = useState<NetworkId>(offered[0] || 'MTN')
    const [families, setFamilies] = useState<Family[]>([])
    const [bundles, setBundles] = useState<Bundle[]>([])
    const [family, setFamily] = useState<string | null>(null)
    const [loading, setLoading] = useState(true)
    const [loadError, setLoadError] = useState<string | null>(null)

    const [selected, setSelected] = useState<Bundle | null>(null)
    const [phone, setPhone] = useState('')
    const [momoPhone, setMomoPhone] = useState('')
    const [momoNetwork, setMomoNetwork] = useState<NetworkId | ''>('')
    const [quote, setQuote] = useState<Quote | null>(null)
    const [quoteError, setQuoteError] = useState<string | null>(null)
    const [submitting, setSubmitting] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [reference, setReference] = useState<string | null>(null)
    const [otpRequired, setOtpRequired] = useState(false)
    const [otpCode, setOtpCode] = useState('')
    const [stage, setStage] = useState<'form' | 'waiting' | 'done' | 'failed'>('form')
    const [result, setResult] = useState<any>(null)
    const pollCount = useRef(0)

    const phoneDigits = phone.replace(/\D/g, '')
    const momoDigits = momoPhone.replace(/\D/g, '')
    const phoneValid = /^0\d{9}$/.test(phoneDigits) && networkForPhone(phoneDigits) === network

    const loadCatalog = useCallback(async (net: NetworkId) => {
        setLoading(true)
        setLoadError(null)
        try {
            const res = await fetch(`/api/shop/bundles/catalog?slug=${encodeURIComponent(shopSlug)}&network=${net}&scope=${scope}`, { cache: 'no-store' })
            const body = await res.json()
            if (!res.ok) throw new Error(body?.error || 'Could not load bundles')
            const cat = body.catalog || {}
            setFamilies(cat.families || [])
            setBundles(cat.available ? (cat.bundles || []) : [])
            setFamily(prev => (cat.families || []).some((f: Family) => f.key === prev) ? prev : cat.families?.[0]?.key ?? null)
        } catch (e: any) {
            setLoadError(e?.message || 'Could not load bundles')
            setBundles([])
        } finally {
            setLoading(false)
        }
    }, [shopSlug, scope])

    useEffect(() => { loadCatalog(network) }, [network, loadCatalog])

    // Back from a Paystack card page: ?bundle_ref=… resumes the wait.
    useEffect(() => {
        const ref = new URLSearchParams(window.location.search).get('bundle_ref')
        if (ref && ref.startsWith('BUNPAY-')) {
            setSelected({ key: '', size: 'Your bundle', family: '', familyLabel: '', validity: null, price: 0 })
            setReference(ref)
            setStage('waiting')
        }
    }, [])

    useEffect(() => { setMomoNetwork(networkForPhone(momoDigits) ?? '') }, [momoDigits])

    // Server-side quote: the figure shown is the figure charged.
    useEffect(() => {
        if (!selected?.key || !phoneValid || stage !== 'form') { setQuote(null); return }
        let cancelled = false
        const t = setTimeout(async () => {
            try {
                const res = await fetch('/api/bundles/gateway-init', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ shopSlug, network, bundleKey: selected.key, phone: phoneDigits, quote: true }),
                })
                const body = await res.json().catch(() => ({}))
                if (cancelled) return
                if (!res.ok || !body?.success) { setQuote(null); setQuoteError(body?.error || 'Could not price this bundle') }
                else { setQuote(body); setQuoteError(null) }
            } catch {
                if (!cancelled) setQuoteError('Could not price this bundle')
            }
        }, 300)
        return () => { cancelled = true; clearTimeout(t) }
    }, [selected, phoneValid, phoneDigits, network, shopSlug, stage])

    // Poll the payment, then the order.
    useEffect(() => {
        if (stage !== 'waiting' || !reference) return
        pollCount.current = 0
        let stopped = false
        const tick = async () => {
            if (stopped) return
            pollCount.current++
            try {
                const res = await fetch(`/api/shop/bundles/status?ref=${encodeURIComponent(reference)}&slug=${encodeURIComponent(shopSlug)}`, { cache: 'no-store' })
                const body = await res.json()
                if (body?.payment === 'failed') { setStage('failed'); setError('The payment was not completed. You were not charged.'); return }
                if (body?.payment === 'paid' && body.order) {
                    setResult(body.order)
                    if (body.order.status === 'completed' || body.order.status === 'processing' || body.order.status === 'pending') {
                        setStage('done')
                        if (body.order.status === 'completed') return
                    } else {
                        setStage('failed')
                        setError('Your payment was received but the bundle could not be delivered. Please contact the shop with your reference.')
                        return
                    }
                }
            } catch { /* keep polling */ }
            if (pollCount.current < POLL_MAX) setTimeout(tick, POLL_MS)
        }
        const first = setTimeout(tick, POLL_MS)
        return () => { stopped = true; clearTimeout(first) }
    }, [stage, reference, shopSlug])

    const needsMomo = quote?.needsMomoDetails ?? true
    const momoReady = !needsMomo || (/^0\d{9}$/.test(momoDigits) && !!momoNetwork)

    async function gatewayInit(extra: Record<string, unknown>) {
        const res = await fetch('/api/bundles/gateway-init', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ shopSlug, network, bundleKey: selected?.key, phone: phoneDigits, momoPhone: momoDigits, momoNetwork, ...extra }),
        })
        return { res, body: await res.json().catch(() => ({})) }
    }

    async function pay() {
        if (!selected || !phoneValid || !quote || !momoReady || submitting) return
        setSubmitting(true)
        setError(null)
        try {
            const { res, body } = await gatewayInit({})
            if (!res.ok && body?.resumable && body?.reference) {
                setReference(body.reference)
                if (body.otpRequired) setOtpRequired(true)
                else setStage('waiting')
                return
            }
            if (!res.ok || !body?.success) throw new Error(body?.error || 'Payment could not be started')
            if (body.gateway === 'paystack' && body.authorization_url) {
                window.location.href = body.authorization_url
                return
            }
            setReference(body.reference)
            if (body.otpRequired) setOtpRequired(true)
            else setStage('waiting')
        } catch (e: any) {
            setError(e?.message || 'Payment could not be started')
        } finally {
            setSubmitting(false)
        }
    }

    async function submitOtp() {
        if (!otpCode.trim() || !reference) return
        setSubmitting(true)
        setError(null)
        try {
            const { res, body } = await gatewayInit({ otpCode: otpCode.trim(), reference })
            if (!res.ok) throw new Error(body?.error || 'Invalid code. Please try again.')
            setOtpRequired(false)
            setOtpCode('')
            setStage('waiting')
        } catch (e: any) {
            setError(e?.message || 'Invalid code')
        } finally {
            setSubmitting(false)
        }
    }

    function closeDialog() {
        // Closing mid-wait is fine: the order still settles server-side.
        setSelected(null)
        setQuote(null)
        setQuoteError(null)
        setError(null)
        setReference(null)
        setOtpRequired(false)
        setOtpCode('')
        setStage('form')
        setResult(null)
        if (window.location.search.includes('bundle_ref=')) {
            const url = new URL(window.location.href)
            url.searchParams.delete('bundle_ref')
            window.history.replaceState(null, '', url.toString())
        }
    }

    const visible = useMemo(() => bundles.filter(b => !family || b.family === family), [bundles, family])
    const activeFamily = families.find(f => f.key === family)
    const accent = brandColor || '#0f172a'

    return (
        <div className="space-y-4">
            {scope !== 'special' && offered.length > 1 && (
                <div className="grid grid-cols-3 gap-2">
                    {offered.map(id => {
                        const n = NETWORKS.find(x => x.id === id)!
                        return (
                            <button
                                key={id}
                                type="button"
                                onClick={() => setNetwork(id)}
                                className={cn('rounded-xl border-2 px-3 py-2 text-sm font-black', network === id ? 'border-emerald-400 ring-2 ring-emerald-400/30' : 'border-gray-100 dark:border-gray-800')}
                            >
                                {n.label}
                            </button>
                        )
                    })}
                </div>
            )}

            {families.length > 1 && (
                <div className="flex gap-2 overflow-x-auto pb-1">
                    {families.map(f => (
                        <button
                            key={f.key}
                            type="button"
                            onClick={() => setFamily(f.key)}
                            className={cn('shrink-0 rounded-full border px-4 py-1.5 text-sm font-bold', family === f.key ? 'text-white border-transparent' : 'bg-white dark:bg-[#151c2c]')}
                            style={family === f.key ? { backgroundColor: accent } : undefined}
                        >
                            {f.label}
                        </button>
                    ))}
                </div>
            )}
            {activeFamily?.description && <p className="text-xs text-muted-foreground">{activeFamily.description}</p>}

            {loading ? (
                <div className="py-12 flex justify-center"><Loader2 className="w-6 h-6 animate-spin" /></div>
            ) : loadError || !visible.length ? (
                <div className="rounded-2xl border border-dashed p-8 text-center space-y-3">
                    <Wifi className="w-8 h-8 mx-auto text-muted-foreground" />
                    <p className="font-bold">{loadError ? 'Could not load bundles' : 'No bundles available right now'}</p>
                    {loadError && <p className="text-sm text-muted-foreground">{loadError}</p>}
                    <Button variant="outline" size="sm" onClick={() => loadCatalog(network)}><RefreshCw className="w-4 h-4 mr-2" /> Try again</Button>
                </div>
            ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                    {visible.map(b => {
                        const n = NETWORKS.find(x => x.id === network)!
                        return (
                            <div key={b.key} className={cn('rounded-2xl overflow-hidden flex flex-col', n.bg)}>
                                <div className="p-4 text-center flex-1">
                                    <span className="inline-block text-[10px] font-black px-2 py-0.5 rounded-full bg-black/10">{n.label}</span>
                                    <p className="mt-3 text-xl font-black leading-tight break-words">{b.size}</p>
                                    {b.validity && <p className="text-[11px] opacity-80">{b.validity}</p>}
                                    <p className="mt-1 text-lg font-black">GH₵{b.price.toFixed(2)}</p>
                                </div>
                                <button
                                    type="button"
                                    onClick={() => { setSelected(b); setStage('form') }}
                                    className="flex items-center justify-center gap-2 bg-black/10 hover:bg-black/20 py-3 text-sm font-black"
                                >
                                    <ShoppingCart className="w-4 h-4" /> Buy Now
                                </button>
                            </div>
                        )
                    })}
                </div>
            )}

            <Dialog open={!!selected} onOpenChange={o => { if (!o) closeDialog() }}>
                <DialogContent className="max-w-md">
                    <DialogHeader>
                        <DialogTitle>{selected?.size}{selected?.price ? ` · GH₵${selected.price.toFixed(2)}` : ''}</DialogTitle>
                        <DialogDescription>
                            {stage === 'form' ? `${NETWORKS.find(x => x.id === network)?.label} bundle, delivered to the number you enter.` : 'Standard Bundle'}
                        </DialogDescription>
                    </DialogHeader>

                    {stage === 'form' && !otpRequired && (
                        <div className="space-y-3">
                            <div>
                                <label className="text-sm font-medium">Number to receive the bundle</label>
                                <Input inputMode="numeric" placeholder={`e.g. ${NETWORKS.find(x => x.id === network)?.prefixes[0]}1234567`} value={phone} onChange={e => setPhone(e.target.value)} />
                                {phoneDigits.length === 10 && !phoneValid && (
                                    <p className="text-xs text-red-600 mt-1">That is not a {NETWORKS.find(x => x.id === network)?.label} number.</p>
                                )}
                            </div>
                            {needsMomo && (
                                <div>
                                    <label className="text-sm font-medium">Mobile Money number to pay from</label>
                                    <Input inputMode="numeric" placeholder="0XXXXXXXXX" value={momoPhone} onChange={e => setMomoPhone(e.target.value)} />
                                    <div className="mt-2 grid grid-cols-3 gap-2">
                                        {NETWORKS.map(n => (
                                            <button key={n.id} type="button" onClick={() => setMomoNetwork(n.id)}
                                                className={cn('rounded-lg border px-2 py-1.5 text-xs font-bold', momoNetwork === n.id ? 'border-foreground bg-secondary' : 'text-muted-foreground')}>
                                                {n.label}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            )}
                            {quote && (
                                <div className="rounded-xl bg-secondary/60 p-3 text-sm space-y-1">
                                    <div className="flex justify-between"><span>Bundle</span><span>GH₵{quote.price.toFixed(2)}</span></div>
                                    {quote.fee > 0 && <div className="flex justify-between"><span>Payment fee</span><span>GH₵{quote.fee.toFixed(2)}</span></div>}
                                    <div className="flex justify-between font-black"><span>Total</span><span>GH₵{quote.total.toFixed(2)}</span></div>
                                </div>
                            )}
                            {quoteError && <p className="text-sm text-red-600">{quoteError}</p>}
                            {error && <p className="text-sm text-red-600">{error}</p>}
                            <Button className="w-full h-12 font-black" style={{ backgroundColor: accent }} disabled={!phoneValid || !quote || !momoReady || submitting} onClick={pay}>
                                {submitting && <Loader2 className="w-4 h-4 animate-spin mr-2" />} Pay{quote ? ` GH₵${quote.total.toFixed(2)}` : ''}
                            </Button>
                        </div>
                    )}

                    {otpRequired && (
                        <div className="space-y-3">
                            <p className="text-sm">Enter the code sent to your phone to approve the payment.</p>
                            <Input inputMode="numeric" placeholder="Code" value={otpCode} onChange={e => setOtpCode(e.target.value)} />
                            {error && <p className="text-sm text-red-600">{error}</p>}
                            <Button className="w-full h-12 font-black" style={{ backgroundColor: accent }} disabled={!otpCode.trim() || submitting} onClick={submitOtp}>
                                {submitting && <Loader2 className="w-4 h-4 animate-spin mr-2" />} Confirm code
                            </Button>
                        </div>
                    )}

                    {stage === 'waiting' && !otpRequired && (
                        <div className="py-6 text-center space-y-3">
                            <Loader2 className="w-8 h-8 animate-spin mx-auto" />
                            <p className="font-bold">Approve the payment prompt on your phone</p>
                            <p className="text-xs text-muted-foreground">Keep this page open. Ref: {reference}</p>
                        </div>
                    )}

                    {stage === 'done' && (
                        <div className="py-6 text-center space-y-3">
                            <CheckCircle2 className="w-10 h-10 mx-auto text-emerald-500" />
                            <p className="font-bold">
                                {result?.status === 'completed'
                                    ? `${result?.bundle_label} delivered to ${result?.beneficiary_phone}`
                                    : `Payment received. ${result?.bundle_label || 'Your bundle'} is on its way to ${result?.beneficiary_phone || 'the number'}.`}
                            </p>
                            <p className="text-xs text-muted-foreground">Ref: {reference}</p>
                            <Button variant="outline" onClick={closeDialog}>Done</Button>
                        </div>
                    )}

                    {stage === 'failed' && (
                        <div className="py-6 text-center space-y-3">
                            <XCircle className="w-10 h-10 mx-auto text-red-500" />
                            <p className="font-bold">{error}</p>
                            {reference && <p className="text-xs text-muted-foreground">Ref: {reference}</p>}
                            <Button variant="outline" onClick={closeDialog}>Close</Button>
                        </div>
                    )}
                </DialogContent>
            </Dialog>
        </div>
    )
}
