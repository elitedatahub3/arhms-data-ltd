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
import { Loader2, ShoppingCart, CheckCircle2, XCircle, RefreshCw, Wifi, X, AlertCircle, Smartphone } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

// Same field/label styling as the storefront's data checkout sheet (ShopStorefront.tsx).
const SHEET_FIELD_CLASS = 'w-full px-4 py-3.5 rounded-sm border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-base font-semibold outline-none focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-[var(--brand-color)] focus:border-transparent transition-colors'
const SHEET_LABEL_CLASS = 'text-sm font-black text-gray-900 dark:text-gray-100'
const PAY_NETWORKS: { id: 'MTN' | 'Telecel' | 'AT'; label: string; dot: string }[] = [
    { id: 'MTN', label: 'MTN', dot: 'bg-[#ffcc00]' },
    { id: 'Telecel', label: 'Telecel', dot: 'bg-[#da291c]' },
    { id: 'AT', label: 'AirtelTigo', dot: 'bg-[#2463eb]' },
]

type NetworkId = 'MTN' | 'Telecel' | 'AT'
type Scope = 'special' | 'no-special' | 'all'

// Same colours and card parts as /dashboard/standard-bundles, so a storefront
// buyer sees exactly the cards a dashboard buyer sees (only the price differs).
const NETWORKS: { id: NetworkId; label: string; prefixes: string[]; card: string; band: string; chip: string; badge: string }[] = [
    {
        id: 'MTN', label: 'MTN', prefixes: ['024', '025', '053', '054', '055', '059', '098'],
        card: 'bg-[#FFC20E] text-black', band: 'bg-black/10 group-hover:bg-black/15 text-black', chip: 'bg-black/10 text-black', badge: 'bg-[#FFC20E] text-black',
    },
    {
        id: 'Telecel', label: 'Telecel', prefixes: ['020', '050'],
        card: 'bg-[#E3262F] text-white', band: 'bg-black/15 group-hover:bg-black/25 text-white', chip: 'bg-white/20 text-white', badge: 'bg-[#E3262F] text-white',
    },
    {
        id: 'AT', label: 'AirtelTigo', prefixes: ['026', '027', '028', '056', '057', '058'],
        card: 'bg-[#2563EB] text-white', band: 'bg-black/15 group-hover:bg-black/25 text-white', chip: 'bg-white/20 text-white', badge: 'bg-[#2563EB] text-white',
    },
]

/**
 * Provider names pack everything into one string ("1 Hour - 440MB (GHs 1)",
 * "Kokoo 446MB(GHS3-1Day(s))", "Video 1.54GB"). Show them like the shop's own
 * data cards: the data size big, the rest as a small detail line. The price in
 * the name ("GHs 1") is dropped, since the card shows the real price.
 */
export function splitBundleName(name: string): { headline: string; detail: string } {
    const volRe = /(\d+(?:\.\d+)?)\s*(MB|GB|TB)\b/i
    const m = volRe.exec(name)
    if (!m) return { headline: name, detail: '' }
    const headline = `${m[1]}${m[2].toUpperCase()}`
    const detail = name
        .replace(volRe, ' ')
        .replace(/\(s\)/gi, '')
        .replace(/GH[₵S]*\s*[\d.]+\s*-?\s*/gi, '')
        .replace(/[()_]/g, ' ')
        // "1Day" → "1 Day", "3Day" → "3 Days", "26mins" → "26 mins"
        .replace(/(\d+)\s*Days?\b/gi, (_m, n) => `${n} ${Number(n) === 1 ? 'Day' : 'Days'}`)
        .replace(/(\d+)\s*(mins?)\b/gi, '$1 $2')
        .replace(/\s+,/g, ',')
        .replace(/\s+/g, ' ')
        .replace(/^[\s,\-–]+|[\s,\-–]+$/g, '')
        .trim()
    return { headline, detail }
}

function NetworkMark({ id, className }: { id: NetworkId; className?: string }) {
    const n = NETWORKS.find(x => x.id === id)!
    return (
        <span className={cn('inline-flex shrink-0 items-center justify-center rounded-full font-black text-[10px] tracking-tight', n.badge, className)}>
            {id === 'AT' ? 'at' : id === 'Telecel' ? 't' : 'MTN'}
        </span>
    )
}

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
    const [email, setEmail] = useState('')
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
            body: JSON.stringify({ shopSlug, network, bundleKey: selected?.key, phone: phoneDigits, momoPhone: momoDigits, momoNetwork, email: email.trim() || undefined, ...extra }),
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
                <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1">
                    {families.map(f => (
                        <button
                            key={f.key}
                            type="button"
                            onClick={() => setFamily(f.key)}
                            className={cn(
                                'shrink-0 px-4 py-2 rounded-full text-sm font-bold border transition-colors',
                                family === f.key ? 'bg-foreground text-background border-foreground' : 'bg-card hover:bg-secondary'
                            )}
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
                // Same size as the shop's own data cards: at most three per row.
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                    {visible.map(b => {
                        const theme = NETWORKS.find(x => x.id === network)!
                        const { headline, detail } = splitBundleName(b.size)
                        const extra = [detail, b.validity].filter(Boolean).join(' · ')
                        return (
                            <button
                                key={b.key}
                                type="button"
                                onClick={() => { setSelected(b); setStage('form') }}
                                aria-label={`Buy ${b.size} for GH₵${b.price.toFixed(2)}`}
                                className={cn('group rounded-2xl overflow-hidden flex flex-col text-left shadow-sm cursor-pointer transition-transform hover:-translate-y-0.5 hover:shadow-md active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2', theme.card)}
                            >
                                <div className="w-full flex items-center justify-between p-3">
                                    <NetworkMark id={network} className="w-7 h-7 ring-2 ring-white/40" />
                                    <span className={cn('text-[10px] font-bold px-2 py-0.5 rounded-full', theme.chip)}>{theme.label}</span>
                                </div>
                                <div className="w-full flex-1 flex flex-col items-center justify-center text-center px-3 pb-4 min-h-[96px]">
                                    <p className="text-2xl sm:text-3xl font-black leading-none tracking-tight whitespace-nowrap">{headline}</p>
                                    <p className="text-base font-black mt-1.5">GH₵{b.price.toFixed(2)}</p>
                                    {extra && <p className="text-[11px] font-semibold opacity-85 mt-1 leading-snug">• {extra}</p>}
                                </div>
                                <span className={cn('w-full flex items-center justify-center gap-1.5 py-2.5 text-sm font-bold transition-colors', theme.band)}>
                                    <ShoppingCart className="w-4 h-4" /> Buy Now
                                </span>
                            </button>
                        )
                    })}
                </div>
            )}

            {/* Checkout sheet: the same sheet the storefront's data checkout uses
                (network banner, Beneficiary, Mobile Money number, Network, Email,
                fee line, one brand-coloured Pay button pinned to the bottom). */}
            {selected && (() => {
                const theme = NETWORKS.find(x => x.id === network)!
                const busy = submitting || (stage === 'waiting' && !otpRequired)
                const brandStyle = brandColor ? { backgroundColor: brandColor } : undefined
                return (
                    <div className="fixed inset-0 z-[70] flex items-end justify-center">
                        <div className="absolute inset-0 bg-black/50 backdrop-blur-[2px] animate-in fade-in duration-200" onClick={closeDialog} />
                        <div className="relative w-full sm:max-w-lg bg-white dark:bg-gray-900 rounded-t-xl sm:rounded-b-xl sm:mb-6 shadow-e4 sheet-maxh overflow-y-auto animate-sheet-up">
                            <div className="sticky top-0 z-10 bg-white dark:bg-gray-900 pt-3 pb-1 rounded-t-[28px]">
                                <div className="mx-auto w-10 h-1.5 rounded-full bg-gray-200 dark:bg-gray-700" />
                                <button
                                    onClick={closeDialog}
                                    aria-label="Close checkout"
                                    className="absolute top-2 right-4 w-9 h-9 rounded-full bg-gray-100 dark:bg-gray-800 flex items-center justify-center text-gray-500 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
                                >
                                    <X className="w-5 h-5" />
                                </button>
                            </div>

                            <div className="px-5 pb-8 pt-3 space-y-5">
                                {/* Selected bundle banner */}
                                <div className={cn('rounded-2xl px-4 py-4 flex items-center justify-between gap-3', theme.card)}>
                                    <div className="flex items-center gap-3 min-w-0">
                                        <NetworkMark id={network} className="w-10 h-10 ring-2 ring-white/40" />
                                        <div className="min-w-0">
                                            <p className="text-lg font-black tracking-tight truncate">{theme.label} · {splitBundleName(selected.size).headline}</p>
                                            {splitBundleName(selected.size).detail && (
                                                <p className="text-xs font-semibold opacity-85 truncate">{splitBundleName(selected.size).detail}</p>
                                            )}
                                        </div>
                                    </div>
                                    {selected.price > 0 && <p className="text-lg font-black tracking-tight shrink-0">GH₵{selected.price.toFixed(2)}</p>}
                                </div>

                                {stage === 'form' && !otpRequired && (
                                    <>
                                        <div className="space-y-2">
                                            <label className={SHEET_LABEL_CLASS}>
                                                Beneficiary number <span className="font-semibold text-gray-400">(gets the data)</span>
                                            </label>
                                            <input type="tel" inputMode="numeric" value={phone} onChange={e => setPhone(e.target.value)}
                                                placeholder={`${theme.prefixes[0]}1234567`} className={SHEET_FIELD_CLASS} />
                                            {phoneDigits.length === 10 && !phoneValid && (
                                                <p className="text-xs font-bold text-red-600">That is not a {theme.label} number.</p>
                                            )}
                                        </div>

                                        {needsMomo && (
                                            <>
                                                <div className="space-y-2">
                                                    <label className={SHEET_LABEL_CLASS}>
                                                        Mobile Money number <span className="font-semibold text-gray-400">(to pay)</span>
                                                    </label>
                                                    <input type="tel" inputMode="numeric" value={momoPhone} onChange={e => setMomoPhone(e.target.value)}
                                                        placeholder="0241234567" className={SHEET_FIELD_CLASS} />
                                                </div>
                                                <div className="space-y-2">
                                                    <label className={SHEET_LABEL_CLASS}>Network</label>
                                                    <div className="grid grid-cols-3 gap-2">
                                                        {PAY_NETWORKS.map(({ id, label, dot }) => (
                                                            <button
                                                                key={id}
                                                                type="button"
                                                                onClick={() => setMomoNetwork(id)}
                                                                className={cn(
                                                                    'flex items-center justify-center gap-2 py-3 rounded-2xl border text-sm font-bold transition-all',
                                                                    momoNetwork === id
                                                                        ? 'border-gray-900 dark:border-white bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-white shadow-sm'
                                                                        : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:border-gray-300'
                                                                )}
                                                            >
                                                                <span className={cn('w-2.5 h-2.5 rounded-full shrink-0', dot)} />
                                                                {label}
                                                            </button>
                                                        ))}
                                                    </div>
                                                </div>
                                            </>
                                        )}

                                        <div className="space-y-2">
                                            <label className={SHEET_LABEL_CLASS}>
                                                Email <span className="font-semibold text-gray-400">(for receipt, optional)</span>
                                            </label>
                                            <input type="email" value={email} onChange={e => setEmail(e.target.value)}
                                                placeholder="you@example.com" className={SHEET_FIELD_CLASS} />
                                        </div>
                                    </>
                                )}

                                {otpRequired && (
                                    <div className="space-y-2">
                                        <label className={SHEET_LABEL_CLASS}>Code sent to your phone</label>
                                        <input inputMode="numeric" value={otpCode} onChange={e => setOtpCode(e.target.value)} placeholder="Enter code" className={SHEET_FIELD_CLASS} />
                                    </div>
                                )}

                                {stage === 'done' && (
                                    <div className="py-4 text-center space-y-2">
                                        <CheckCircle2 className="w-10 h-10 mx-auto text-emerald-500" />
                                        <p className="font-black">
                                            {result?.status === 'completed'
                                                ? `${result?.bundle_label} delivered to ${result?.beneficiary_phone}`
                                                : `Payment received. ${result?.bundle_label || 'Your bundle'} is on its way to ${result?.beneficiary_phone || 'the number'}.`}
                                        </p>
                                        <p className="text-xs text-gray-400">Ref: {reference}</p>
                                    </div>
                                )}

                                {stage === 'failed' && (
                                    <div className="py-4 text-center space-y-2">
                                        <XCircle className="w-10 h-10 mx-auto text-red-500" />
                                        <p className="font-black">{error}</p>
                                        {reference && <p className="text-xs text-gray-400">Ref: {reference}</p>}
                                    </div>
                                )}

                                {(error || quoteError) && stage !== 'failed' && (
                                    <div className="flex items-start gap-2 p-3 rounded-md bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800">
                                        <AlertCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
                                        <p className="text-xs font-bold text-red-800 dark:text-red-300">{error || quoteError}</p>
                                    </div>
                                )}
                            </div>

                            {/* Cost summary + action, pinned to the bottom */}
                            <div className="sticky bottom-0 border-t border-gray-100 dark:border-gray-800 bg-white/95 dark:bg-gray-900/95 px-5 pt-3 pb-4 safe-b space-y-3">
                                {(stage === 'form' || stage === 'waiting') && (
                                    <dl className="space-y-1.5">
                                        <div className="flex items-center justify-between text-sm">
                                            <dt className="font-semibold text-gray-500 dark:text-gray-400">Bundle</dt>
                                            <dd className="font-bold tabular text-gray-900 dark:text-gray-100">GH₵{(quote?.price ?? selected.price).toFixed(2)}</dd>
                                        </div>
                                        <div className="flex items-center justify-between text-sm">
                                            <dt className="font-semibold text-gray-500 dark:text-gray-400">Payment fee</dt>
                                            <dd className="font-semibold text-gray-500 dark:text-gray-400">
                                                {quote && quote.fee > 0 ? `GH₵${quote.fee.toFixed(2)}` : needsMomo ? 'added by Mobile Money' : 'shown at checkout'}
                                            </dd>
                                        </div>
                                    </dl>
                                )}

                                {stage === 'done' || stage === 'failed' ? (
                                    <button onClick={closeDialog} style={brandStyle}
                                        className="w-full py-4 rounded-md bg-[var(--brand-color)] text-white font-black text-lg flex items-center justify-center gap-2 active:scale-[0.98] transition-transform">
                                        {stage === 'done' ? 'Done' : 'Close'}
                                    </button>
                                ) : (
                                    <button
                                        onClick={otpRequired ? submitOtp : pay}
                                        disabled={busy || (otpRequired ? !otpCode.trim() : (!phoneValid || !quote || !momoReady))}
                                        style={brandStyle}
                                        className="w-full py-4 rounded-md bg-[var(--brand-color)] text-white font-black text-lg flex items-center justify-center gap-2 active:scale-[0.98] transition-transform disabled:opacity-70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-[var(--brand-color)]"
                                    >
                                        {busy
                                            ? <><Loader2 className="w-5 h-5 animate-spin" /> {stage === 'waiting' ? 'Waiting for approval...' : 'Processing...'}</>
                                            : otpRequired
                                                ? <>Confirm code</>
                                                : needsMomo
                                                    ? <><Smartphone className="w-5 h-5" /> Pay GH₵{(quote?.total ?? selected.price).toFixed(2)}</>
                                                    : <><Smartphone className="w-5 h-5" /> Proceed to payment</>}
                                    </button>
                                )}

                                {stage === 'waiting' && (
                                    <p className="text-[12px] text-center font-semibold text-gray-400 leading-snug">
                                        Approve the prompt on your phone. You can close this; your bundle is sent automatically once the payment lands. Ref: {reference}
                                    </p>
                                )}
                                {stage === 'form' && (
                                    <p className="text-[12px] text-center font-semibold text-gray-400 leading-snug">
                                        {needsMomo ? 'Your phone will show the exact total to approve.' : 'You will choose how to pay and see the exact total on the next page.'}
                                    </p>
                                )}
                            </div>
                        </div>
                    </div>
                )
            })()}
        </div>
    )
}
