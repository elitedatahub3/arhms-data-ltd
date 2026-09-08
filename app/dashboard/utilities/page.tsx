'use client'

import React, { useState, useEffect, useCallback, useMemo, useRef, Suspense } from 'react'
import {
    Tv, Zap, Droplets, CheckCircle2, Loader2, Wallet, AlertTriangle,
    ArrowRight, History, Copy, RefreshCw, Info, Phone, ChevronDown,
} from 'lucide-react'
import { useAuth } from '@/contexts/auth-context'
import { useSearchParams } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
    Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
    Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import { format, parseISO } from 'date-fns'
import { resolveProvider, isMomoPromptProvider, type PaymentProvider } from '@/lib/payment-provider'

// ─── Types ────────────────────────────────────────────────────────────────────

interface ServiceConfig {
    id: string
    label: string
    kind: 'tv' | 'meter-by-phone' | 'meter-with-session'
    accountLabel: string
    accountHint: string
    accountPattern: string
    requiresPhone: boolean
    requiresEmail: boolean
    enabled: boolean
    feeRate: number
    minAmount: number
    maxAmount: number
}

interface UtilityOrder {
    id: string
    reference_code: string
    service: string
    account_number: string
    account_name: string | null
    bill_amount: number
    fee_amount: number
    total_paid: number
    status: string
    payment_method: string
    fulfillment_note: string | null
    created_at: string
}

interface LookupResult {
    accountName: string | null
    amountDue: number | null
    meters: { label: string; meterNumber: string; balance: number }[] | null
}

// ─── Presentation ─────────────────────────────────────────────────────────────

// The brand marks live in /public/images/utilities. `gradient` is not dead
// styling: it is what ServiceLogo falls back to when a logo file is missing or
// 404s, so a service still reads as itself rather than as an empty square.
const SERVICE_STYLE: Record<string, {
    icon: React.ElementType
    logo: string
    gradient: string
    badge?: string
}> = {
    dstv:       { icon: Tv,       logo: '/images/utilities/dstv.png',       gradient: 'from-[#0057b8] to-[#0091ea]' },
    gotv:       { icon: Tv,       logo: '/images/utilities/gotv.png',       gradient: 'from-[#43a047] to-[#7cb342]' },
    startimes:  { icon: Tv,       logo: '/images/utilities/startimes.png',  gradient: 'from-[#e65100] to-[#fb8c00]' },
    ecg:        { icon: Zap,      logo: '/images/utilities/ecg.png',        gradient: 'from-[#f9a825] to-[#fdd835]', badge: 'Prepaid' },
    ghanawater: { icon: Droplets, logo: '/images/utilities/ghanawater.png', gradient: 'from-[#0277bd] to-[#4fc3f7]' },
}
function ServiceLogo({ id, size = 'md' }: { id: string; size?: 'sm' | 'md' }) {
    const style = SERVICE_STYLE[id] || SERVICE_STYLE.dstv
    const [failed, setFailed] = useState(false)
    const box = size === 'sm' ? 'w-10 h-10 rounded-xl' : 'w-12 h-12 rounded-2xl'
    const glyph = size === 'sm' ? 'w-5 h-5' : 'w-6 h-6'

    if (failed) {
        return (
            <div className={cn(box, 'shrink-0 bg-gradient-to-br flex items-center justify-center shadow-e1', style.gradient)}>
                <style.icon className={cn(glyph, 'text-white')} />
            </div>
        )
    }

    // object-cover, not contain: most of these marks are wide wordmarks on their
    // own solid background, and filling the square crops the edges rather than
    // letterboxing white bars top and bottom — the source already carries its
    // real colour, so no extra background chip is layered behind it either.
    return (
        <div className={cn(box, 'shrink-0 overflow-hidden ring-1 ring-black/[0.05] dark:ring-white/10 bg-card')}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
                src={style.logo}
                alt=""
                aria-hidden
                className="w-full h-full object-cover"
                onError={() => setFailed(true)}
            />
        </div>
    )
}

const QUICK_AMOUNTS = [10, 20, 50, 100, 200, 500]

// A native <select> rather than the Radix Select used in the form: the four
// of these sit in a horizontally-scrolling row, and a portal-based listbox
// fights that scroll container in a way a plain select never does.
function FilterPill({ value, onChange, options }: {
    value: string
    onChange: (v: string) => void
    options: { value: string; label: string }[]
}) {
    return (
        <div className="relative shrink-0">
            <select
                value={value}
                onChange={e => onChange(e.target.value)}
                className="appearance-none h-9 pl-3.5 pr-8 rounded-full border border-border bg-surface-2 text-xs font-bold text-foreground cursor-pointer"
            >
                {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <ChevronDown className="w-3.5 h-3.5 absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
        </div>
    )
}

function StatusBadge({ status }: { status: string }) {
    // Alpha fills, not the 100-step solids: on the true-black dark surface a
    // bg-amber-100 pill glows like a highlighter and its 700 ink goes muddy.
    const map: Record<string, string> = {
        pending: 'bg-amber-500/12 text-amber-700 dark:text-amber-300 border-amber-500/25',
        processing: 'bg-blue-500/12 text-blue-700 dark:text-blue-300 border-blue-500/25',
        completed: 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-300 border-emerald-500/25',
        failed: 'bg-red-500/12 text-red-700 dark:text-red-300 border-red-500/25',
        refunded: 'bg-muted text-muted-foreground border-border-strong',
    }
    return (
        <span className={cn('inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold border capitalize', map[status] || 'bg-muted text-muted-foreground border-border')}>
            {status}
        </span>
    )
}

function SuccessModal({ order, label, onClose, onPayAnother }: {
    order: UtilityOrder | null
    label: string
    onClose: () => void
    onPayAnother: () => void
}) {
    if (!order) return null
    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
            <div className="bg-card border border-border rounded-3xl w-full max-w-md p-6 shadow-e4">
                <div className="flex flex-col items-center text-center mb-5">
                    <div className="w-14 h-14 rounded-full bg-emerald-500/12 flex items-center justify-center mb-3">
                        <CheckCircle2 className="w-8 h-8 text-emerald-600 dark:text-emerald-400" />
                    </div>
                    <h3 className="text-xl font-black text-foreground">Payment Submitted</h3>
                    <p className="text-sm text-muted-foreground mt-1">
                        We are paying your {label} bill now. You will be notified the moment it lands.
                    </p>
                </div>

                <div className="space-y-2.5 mb-6">
                    <div className="flex justify-between text-sm"><span className="text-muted-foreground">Service</span><span className="font-semibold">{label}</span></div>
                    <div className="flex justify-between text-sm"><span className="text-muted-foreground">Account</span><span className="font-semibold">{order.account_number}</span></div>
                    {order.account_name && (
                        <div className="flex justify-between text-sm"><span className="text-muted-foreground">Name</span><span className="font-semibold">{order.account_name}</span></div>
                    )}
                    <div className="flex justify-between text-sm"><span className="text-muted-foreground">Bill amount</span><span className="font-semibold text-emerald-600 dark:text-emerald-400">GHS {Number(order.bill_amount).toFixed(2)}</span></div>
                    <div className="flex justify-between text-sm"><span className="text-muted-foreground">Service fee</span><span className="font-semibold">GHS {Number(order.fee_amount).toFixed(2)}</span></div>
                    <div className="flex justify-between text-sm border-t border-border pt-2.5 mt-1">
                        <span className="font-bold text-foreground">Total paid</span>
                        <span className="font-bold text-lg text-foreground">GHS {Number(order.total_paid).toFixed(2)}</span>
                    </div>
                    <button
                        onClick={() => { navigator.clipboard.writeText(order.reference_code); toast.success('Reference copied') }}
                        className="w-full flex items-center justify-between text-xs bg-surface-2 rounded-xl px-3 py-2 mt-2 hover:bg-surface-3"
                    >
                        <span className="text-muted-foreground">Reference</span>
                        <span className="font-mono font-semibold text-foreground flex items-center gap-1.5">
                            {order.reference_code} <Copy className="w-3 h-3" />
                        </span>
                    </button>
                </div>

                <div className="flex gap-3">
                    <Button variant="outline" className="flex-1 rounded-xl h-11" onClick={onClose}>Done</Button>
                    <Button className="flex-1 rounded-xl bg-accent-solid hover:bg-accent-strong text-accent-contrast h-11" onClick={onPayAnother}>
                        Pay Another
                    </Button>
                </div>
            </div>
        </div>
    )
}

// ─── Main page ────────────────────────────────────────────────────────────────

function UtilitiesPageInner() {
    const { dbUser } = useAuth()
    const searchParams = useSearchParams()

    const [configLoading, setConfigLoading] = useState(true)
    // Live in production before it is open to customers — the server decides this,
    // not the client, and enforces it again on every route that costs money.
    const [comingSoon, setComingSoon] = useState(false)
    const [services, setServices] = useState<ServiceConfig[]>([])
    const [walletBalance, setWalletBalance] = useState<number | null>(null)
    const [defaultEmail, setDefaultEmail] = useState('')

    // Form
    const [serviceId, setServiceId] = useState<string | null>(null)
    const [accountNumber, setAccountNumber] = useState('')
    const [phone, setPhone] = useState('')
    const [email, setEmail] = useState('')
    const [amount, setAmount] = useState('')

    // Lookup — the gate on the whole form
    const [lookup, setLookup] = useState<LookupResult | null>(null)
    const [lookupLoading, setLookupLoading] = useState(false)
    // Ticked to pay a meter the lookup did not return. ECG links it to the paying
    // number on first payment, so this is a real first-time customer rather than an
    // error — but nothing has verified whose meter it is, hence the explicit tick.
    const [ackUnlinkedMeter, setAckUnlinkedMeter] = useState(false)
    const [lookupError, setLookupError] = useState<string | null>(null)

    // Payment
    const [webPaymentProvider, setWebPaymentProvider] = useState<PaymentProvider>('moolre')
    const [momoPhone, setMomoPhone] = useState('')
    const [momoNetwork, setMomoNetwork] = useState('')
    const [otpRequired, setOtpRequired] = useState(false)
    const [otpCode, setOtpCode] = useState('')
    const [directPaymentRef, setDirectPaymentRef] = useState<string | null>(null)
    const [pollingRef, setPollingRef] = useState<string | null>(null)

    const [isSubmitting, setIsSubmitting] = useState(false)
    const [showConfirm, setShowConfirm] = useState(false)
    const [successOrder, setSuccessOrder] = useState<UtilityOrder | null>(null)

    // Recent payments — the page is one continuous scroll now, not a Pay/History
    // tab split, so this list loads alongside the config rather than on tab switch.
    const [orders, setOrders] = useState<UtilityOrder[]>([])
    const [historyLoading, setHistoryLoading] = useState(false)
    const [billerFilter, setBillerFilter] = useState('all')
    const [statusFilter, setStatusFilter] = useState('all')
    const [sourceFilter, setSourceFilter] = useState('all')
    const [dateFilter, setDateFilter] = useState('all')

    const service = useMemo(() => services.find(s => s.id === serviceId) || null, [services, serviceId])
    const needsMomoDetails = isMomoPromptProvider(webPaymentProvider)

    // ── Load config, wallet and the active gateway ───────────────────────────
    useEffect(() => {
        const load = async () => {
            if (!dbUser) return
            setConfigLoading(true)
            try {
                const [configRes, settingsRes] = await Promise.all([
                    fetch('/api/utilities/config', { cache: 'no-store' }),
                    fetch('/api/admin-settings?keys=active_payment_provider_web'),
                ])

                if (configRes.ok) {
                    const cfg = await configRes.json()
                    setComingSoon(!!cfg.comingSoon)
                    setServices(cfg.services || [])
                    if (cfg.defaultPhone) { setPhone(cfg.defaultPhone); setMomoPhone(cfg.defaultPhone) }
                    if (cfg.defaultEmail) { setDefaultEmail(cfg.defaultEmail); setEmail(cfg.defaultEmail) }
                }

                if (settingsRes.ok) {
                    const s = await settingsRes.json()
                    setWebPaymentProvider(resolveProvider(s.active_payment_provider_web))
                }

                const { data: walletData } = await supabase
                    .from('wallets').select('balance').eq('user_id', dbUser.id).single()
                if (walletData) setWalletBalance((walletData as any).balance || 0)
            } catch (e) {
                console.error('[Utilities] Failed to load config:', e)
            } finally {
                setConfigLoading(false)
            }
        }
        load()
    }, [dbUser])

    // ── History ──────────────────────────────────────────────────────────────
    const fetchHistory = useCallback(async () => {
        setHistoryLoading(true)
        try {
            const res = await fetch('/api/utilities/history?limit=50', { cache: 'no-store' })
            if (res.ok) {
                const data = await res.json()
                setOrders(data.orders || [])
            }
        } catch (e) {
            console.error('[Utilities] History error:', e)
        } finally {
            setHistoryLoading(false)
        }
    }, [])

    useEffect(() => { fetchHistory() }, [fetchHistory])

    // The floating refresh button reloads both live numbers on the page: the
    // wallet strip and the payments list below it.
    const refreshAll = useCallback(async () => {
        fetchHistory()
        if (dbUser) {
            const { data } = await supabase.from('wallets').select('balance').eq('user_id', dbUser.id).single()
            if (data) setWalletBalance((data as any).balance || 0)
        }
    }, [fetchHistory, dbUser])

    // ── Direct-pay polling ───────────────────────────────────────────────────
    useEffect(() => {
        if (!pollingRef) return

        let elapsed = 0
        const POLL_MS = 3000
        const TIMEOUT_MS = 180000

        const interval = setInterval(async () => {
            elapsed += POLL_MS
            if (elapsed >= TIMEOUT_MS) {
                clearInterval(interval)
                setPollingRef(null)
                setIsSubmitting(false)
                toast.error('Still waiting on payment confirmation. Check your history in a moment.')
                return
            }

            try {
                const res = await fetch(`/api/payments/verify?reference=${pollingRef}`, {
                    headers: { Accept: 'application/json' },
                })
                const data = await res.json()

                if (data.status === 'completed') {
                    if (!data.order) return // the settling caller writes it a moment later
                    clearInterval(interval)
                    setPollingRef(null)
                    setIsSubmitting(false)
                    setSuccessOrder(data.order)
                    resetForm()
                } else if (data.status === 'failed') {
                    clearInterval(interval)
                    setPollingRef(null)
                    setIsSubmitting(false)
                    toast.error(data.error || data.message || 'Payment failed')
                }
            } catch {
                // keep polling — a blip must not abandon a live payment
            }
        }, POLL_MS)

        return () => clearInterval(interval)
    }, [pollingRef])

    // Returning from a Paystack redirect.
    useEffect(() => {
        const ref = searchParams.get('reference')
        if (ref && ref.startsWith('UTIL-')) {
            setIsSubmitting(true)
            setPollingRef(ref)
        }
    }, [searchParams])

    // ── Lookup ───────────────────────────────────────────────────────────────
    // A stale name must never sit above a changed account number — the confirmed
    // name is the whole safety mechanism here — so the result is tied to the exact
    // inputs that produced it and dropped the moment they change.
    //
    // ECG is the exception that shapes this: its account number is CHOSEN FROM the
    // lookup result, so treating it as an input would clear the meter list the
    // instant a meter was picked. For ECG the phone number alone identifies the
    // query; the meter is a selection within it.
    const lookupKey = useMemo(() => {
        if (!service) return ''
        const account = service.kind === 'meter-by-phone' ? '' : accountNumber.replace(/\s+/g, '')
        return `${service.id}|${account}|${phone.replace(/\s+/g, '')}`
    }, [service, accountNumber, phone])

    const [lookedUpKey, setLookedUpKey] = useState<string | null>(null)

    // Hubtel cannot verify an ECG meter on its own — the only question it answers is
    // "which meters sit on this phone number" — so a typed meter is confirmed against
    // that answer rather than by another round trip. Once the list is in hand the
    // check is instant and costs nothing, which is why typing a meter does not spend
    // a lookup.
    /** ECG is the only biller looked up by phone rather than by account number. */
    const isEcgService = service?.kind === 'meter-by-phone'

    const meterMismatch = useMemo(() => {
        if (!service || service.kind !== 'meter-by-phone') return false
        const typed = accountNumber.replace(/\s+/g, '')
        if (!typed || !lookup?.meters?.length) return false
        return !lookup.meters.some(m => m.meterNumber === typed)
    }, [service, accountNumber, lookup])

    // Whether the inputs can produce an answer yet. The account patterns are open
    // ranges — a DSTV number is already "valid" at 8 digits on the way to 10 — so
    // this says "worth asking", not "definitely finished". The debounce below
    // supplies the rest of that judgement.
    const autoLookupReady = useMemo(() => {
        if (!service) return false
        if (service.requiresPhone && !/^0\d{9}$/.test(phone.replace(/\s+/g, ''))) return false
        // ECG is asked by phone but the question is about ONE meter, so there is
        // nothing to check until the customer has typed which.
        if (service.kind === 'meter-by-phone') return !!accountNumber.replace(/\s+/g, '')
        const account = accountNumber.replace(/\s+/g, '')
        if (!account) return false
        try {
            return new RegExp(service.accountPattern).test(account)
        } catch {
            return account.length >= 8
        }
    }, [service, accountNumber, phone])

    useEffect(() => {
        if (lookedUpKey !== null && lookedUpKey !== lookupKey) {
            setLookup(null)
            setLookupError(null)
            setLookedUpKey(null)
        }
    }, [lookupKey, lookedUpKey])

    const runLookup = async () => {
        if (!service) return

        // Required for every biller now, ECG included — the check confirms one
        // meter, so there has to be one to confirm.
        if (!accountNumber.trim()) {
            toast.error(service.kind === 'meter-by-phone' ? 'Enter the meter number' : `Enter the ${service.accountLabel}`)
            return
        }
        if (service.requiresPhone && !/^0\d{9}$/.test(phone.replace(/\s+/g, ''))) {
            toast.error('Enter a valid phone number: 0XXXXXXXXX')
            return
        }

        setLookupLoading(true)
        setLookupError(null)
        try {
            const res = await fetch('/api/utilities/query', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({
                    service: service.id,
                    accountNumber: accountNumber.replace(/\s+/g, ''),
                    phone: phone.replace(/\s+/g, ''),
                }),
            })
            const data = await res.json()

            if (!res.ok) {
                setLookupError(data.error || 'Account could not be verified')
                setLookup(null)
                return
            }

            setLookup({
                accountName: data.accountName ?? null,
                amountDue: data.amountDue ?? null,
                meters: data.meters ?? null,
            })
            setLookedUpKey(lookupKey)

            // ECG returns the meter list. A meter the customer already typed wins —
            // they told us which one they meant, and overwriting it with the first
            // in the list would silently pay a different meter. Anything they typed
            // that is NOT on the list is left alone so meterMismatch can say so.
            if (data.meters?.length) {
                const typed = accountNumber.replace(/\s+/g, '')
                const match = data.meters.find((m: any) => m.meterNumber === typed)
                if (match) setAccountNumber(match.meterNumber)
                else if (!typed) setAccountNumber(data.meters[0].meterNumber)
            }
        } catch {
            setLookupError('Could not reach the provider. Please try again.')
        } finally {
            setLookupLoading(false)
        }
    }

    // The lookup gates everything below it — no name, no Pay button — so making the
    // customer press a button for it was ceremony. It runs itself once the inputs
    // can answer, and for ECG that is immediately, since the phone comes from their
    // profile and the meter is picked from the result.
    //
    // Debounced rather than fired on validity: the account number arrives one
    // keystroke at a time and the patterns accept a range of lengths, so verifying
    // the moment a number becomes "valid" would query a stranger's account partway
    // through typing, show their name, and spend a lookup doing it. A pause is what
    // separates a finished number from a passing one.
    //
    // One attempt per distinct set of inputs, recorded before the request rather
    // than after so a failure cannot loop. A wrong number stays wrong until the
    // customer changes it or asks again — otherwise it would retry against the
    // rate limit forever.
    const attemptedKeyRef = useRef<string | null>(null)

    useEffect(() => {
        if (!lookupKey || !autoLookupReady) return
        if (attemptedKeyRef.current === lookupKey) return

        const timer = setTimeout(() => {
            attemptedKeyRef.current = lookupKey
            runLookup()
        }, 700)
        return () => clearTimeout(timer)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [lookupKey, autoLookupReady])

    const retryLookup = () => {
        attemptedKeyRef.current = lookupKey
        runLookup()
    }

    // ── Money ────────────────────────────────────────────────────────────────
    const parsedAmount = parseFloat(amount) || 0
    const feeAmount = service ? parseFloat((parsedAmount * (service.feeRate / 100)).toFixed(2)) : 0
    const totalPayable = parseFloat((parsedAmount + feeAmount).toFixed(2))
    /**
     * ECG meter typed by hand and knowingly accepted, rather than picked off the
     * lookup. There is no account name to show because nothing verified it — ECG
     * links the meter to the paying number on first payment — so this is the one
     * route to checkout that does not require a confirmed holder.
     */
    const payingUnlinkedMeter = !!isEcgService
        && ackUnlinkedMeter
        && !!accountNumber.trim()
        && /^0\d{9}$/.test(phone.replace(/\s+/g, ''))

    const canSubmit = !!service
        && (!!lookup?.accountName || payingUnlinkedMeter)
        && parsedAmount >= (service?.minAmount ?? 1)
        && parsedAmount <= (service?.maxAmount ?? 2000)
        && (!service?.requiresEmail || !!email.trim())
        // A mismatch is only a blocker while it is unacknowledged; ticking the box
        // is the customer saying they meant this meter.
        && (!meterMismatch || payingUnlinkedMeter)
        && (!needsMomoDetails || (!!momoPhone && !!momoNetwork))

    const resetForm = () => {
        setAccountNumber('')
        setAmount('')
        setLookup(null)
        setLookupError(null)
        setLookedUpKey(null)
        setEmail(defaultEmail)
        // Must clear with the rest: an acknowledgement left standing would apply to
        // whatever meter is typed next, which is not what the customer agreed to.
        setAckUnlinkedMeter(false)
    }

    const requestBody = () => ({
        service: service!.id,
        accountNumber: accountNumber.replace(/\s+/g, ''),
        amount: parsedAmount,
        phone: phone.replace(/\s+/g, ''),
        email: email.trim(),
        // Only ever true when the customer typed a meter and ticked the box for it.
        // The server refuses an unlisted meter without this, and never infers it.
        acknowledgeUnlinkedMeter: payingUnlinkedMeter,
    })

    const payFromGateway = async (opts?: { otpCode?: string; reference?: string }) => {
        setIsSubmitting(true)
        try {
            const res = await fetch('/api/utilities/gateway-init', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({
                    ...requestBody(),
                    momoPhone: momoPhone.replace(/\s+/g, ''),
                    momoNetwork,
                    ...(opts?.otpCode ? { otpCode: opts.otpCode } : {}),
                    ...(opts?.reference ? { reference: opts.reference } : {}),
                }),
            })
            const data = await res.json()

            if (!res.ok) {
                toast.error(data.error || 'Payment could not be started')
                setIsSubmitting(false)
                return
            }

            setShowConfirm(false)

            if (data.gateway === 'paystack') {
                window.location.href = data.authorization_url
                return
            }

            if (data.otpRequired) {
                setDirectPaymentRef(data.reference)
                setOtpRequired(true)
                setIsSubmitting(false)
                return
            }

            toast.success(data.message || 'Payment prompt sent! Approve it on your phone.')
            setPollingRef(data.reference)
        } catch {
            toast.error('Failed to start payment')
            setIsSubmitting(false)
        }
    }

    const handleConfirm = () => payFromGateway()

    const filteredOrders = useMemo(() => {
        const now = Date.now()
        const dateCutoff = dateFilter === 'today' ? new Date().setHours(0, 0, 0, 0)
            : dateFilter === '7d' ? now - 7 * 86400000
            : dateFilter === '30d' ? now - 30 * 86400000
            : null
        return orders.filter(o =>
            (billerFilter === 'all' || o.service === billerFilter) &&
            (statusFilter === 'all' || o.status === statusFilter) &&
            (sourceFilter === 'all' || o.payment_method === sourceFilter) &&
            (dateCutoff === null || new Date(o.created_at).getTime() >= dateCutoff)
        )
    }, [orders, billerFilter, statusFilter, sourceFilter, dateFilter])

    const serviceLabelFor = (id: string) => services.find(s => s.id === id)?.label || id

    // ── Render ───────────────────────────────────────────────────────────────
    if (configLoading) {
        return (
            <div className="flex items-center justify-center min-h-[60vh]">
                <div className="w-8 h-8 rounded-full border-4 border-border border-t-accent-solid animate-spin" />
            </div>
        )
    }

    if (comingSoon) {
        return (
            <div className="max-w-lg mx-auto pb-24 pt-10 text-center">
                <div className="flex items-center justify-center gap-3 text-muted-foreground/40 mb-6">
                    <Tv className="w-7 h-7" />
                    <Zap className="w-7 h-7" />
                    <Droplets className="w-7 h-7" />
                </div>
                <h1 className="text-2xl font-black text-foreground">Pay Bills — coming soon</h1>
                <p className="text-sm text-muted-foreground mt-3 leading-relaxed">
                    You will soon be able to pay DSTV, GOtv, StarTimes, ECG and Ghana Water bills
                    straight from here, with Mobile Money. We are putting it through its final
                    checks — it will open shortly.
                </p>
            </div>
        )
    }

    return (
        <div className="max-w-3xl mx-auto pb-24">
            {/* Header */}
            <div className="mb-6">
                <h1 className="text-2xl font-black text-foreground">Pay Bills</h1>
                <p className="text-sm text-muted-foreground mt-1">
                    DSTV, GOtv, StarTimes, ECG and Ghana Water — paid instantly by Mobile Money.
                </p>
            </div>

            <div className="space-y-5">
                {/* Wallet strip */}
                <div className="flex items-center gap-3 rounded-2xl px-5 py-4 bg-surface-1 border border-border shadow-e1">
                    <Wallet className="w-5 h-5 text-muted-foreground" />
                    <div>
                        <p className="text-xs text-muted-foreground">Wallet balance</p>
                        <p className="text-lg font-black text-foreground">
                            GHS {walletBalance !== null ? walletBalance.toFixed(2) : '—'}
                        </p>
                    </div>
                </div>

                {/* Service picker */}
                <div>
                    <p className="text-xs font-black uppercase tracking-[0.15em] text-muted-foreground mb-3">Pay a bill</p>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                            {services.map(s => {
                                const style = SERVICE_STYLE[s.id] || SERVICE_STYLE.dstv
                                const active = serviceId === s.id
                                return (
                                    <button
                                        key={s.id}
                                        disabled={!s.enabled}
                                        onClick={() => { setServiceId(s.id); resetForm() }}
                                        className={cn(
                                            'relative rounded-2xl border p-4 text-left transition-all',
                                            active
                                                ? 'border-accent-solid bg-accent-soft ring-1 ring-accent-solid shadow-e2'
                                                : 'border-border bg-card shadow-e1 hover:border-border-strong hover:shadow-e2',
                                            !s.enabled && 'opacity-40 cursor-not-allowed hover:shadow-e1'
                                        )}
                                    >
                                        <ServiceLogo id={s.id} />
                                        <p className="font-bold text-sm text-foreground mt-3 truncate">{s.label}</p>
                                        <p className="text-[11px] text-muted-foreground mt-0.5 truncate">
                                            {s.enabled ? s.accountLabel : 'Unavailable'}
                                        </p>
                                        {style.badge && (
                                            <span className="absolute top-3 right-3 rounded-full bg-amber-500/15 px-2 py-0.5 text-[9px] font-black uppercase tracking-wider text-amber-600 dark:text-amber-400">
                                                {style.badge}
                                            </span>
                                        )}
                                    </button>
                                )
                            })}
                        </div>
                    </div>

                    {service && (
                        <>
                            {/* Account details */}
                            <div className="bg-card border border-border rounded-2xl p-5 space-y-4">
                                {service.requiresPhone && (
                                    <div>
                                        <Label className="text-sm font-semibold text-foreground">
                                            {isEcgService ? 'ECG phone number' : 'Your phone number'}
                                        </Label>
                                        <div className="relative mt-1.5">
                                            <Phone className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground/70" />
                                            <Input
                                                value={phone}
                                                onChange={e => setPhone(e.target.value)}
                                                placeholder="0XXXXXXXXX"
                                                inputMode="numeric"
                                                maxLength={10}
                                                className="h-12 rounded-xl pl-9"
                                            />
                                        </div>
                                        {isEcgService && (
                                            <p className="text-[11px] text-muted-foreground/70 mt-1">
                                                The number the meter is paid on.
                                            </p>
                                        )}
                                    </div>
                                )}

                                {/* Both fields are inputs for ECG too. The provider is
                                    asked by PHONE and answers with every meter on it,
                                    so confirming the ONE the customer means requires
                                    them to type it — the check then looks for it in
                                    that answer. */}
                                <div>
                                    <Label className="text-sm font-semibold text-foreground">
                                        {isEcgService ? 'Meter number' : service.accountLabel}
                                    </Label>
                                    <Input
                                        value={accountNumber}
                                        onChange={e => { setAccountNumber(e.target.value); setAckUnlinkedMeter(false) }}
                                        placeholder={isEcgService ? 'Meter number' : service.accountLabel}
                                        className="mt-1.5 h-12 rounded-xl"
                                    />
                                    <p className="text-[11px] text-muted-foreground/70 mt-1">{service.accountHint}</p>
                                </div>

                                {/* Offered only once a check has run and come back
                                    without confirming the meter — either it is new to
                                    this phone or the phone has none yet. ECG links it
                                    on the first payment, so this is a real first-time
                                    customer rather than an error. The tick is what makes
                                    paying an unconfirmed meter a choice rather than an
                                    accident, and it clears whenever the meter is edited. */}
                                {isEcgService && lookedUpKey === lookupKey && !lookupLoading
                                    && accountNumber.trim() && !lookup?.accountName && (
                                    <div className="rounded-xl border border-amber-500/25 bg-amber-500/10 p-3 space-y-2">
                                        <p className="text-xs text-amber-800 dark:text-amber-200">
                                            We could not confirm meter{' '}
                                            <span className="font-mono font-bold">{accountNumber.trim()}</span> on{' '}
                                            <span className="font-bold">{phone}</span>. If it is new, ECG links it on
                                            the first payment.
                                        </p>
                                        <label className="flex items-start gap-2 cursor-pointer">
                                            <input
                                                type="checkbox"
                                                checked={ackUnlinkedMeter}
                                                onChange={e => setAckUnlinkedMeter(e.target.checked)}
                                                className="mt-0.5 w-4 h-4 shrink-0"
                                            />
                                            <span className="text-[11px] text-amber-900 dark:text-amber-100">
                                                ECG will link this meter to{' '}
                                                <span className="font-bold">{phone || 'this phone number'}</span>. I understand.
                                            </span>
                                        </label>
                                    </div>
                                )}

                                {lookupLoading && (
                                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                                        <Loader2 className="w-4 h-4 animate-spin" />
                                        <span>Checking account…</span>
                                    </div>
                                )}

                                {/* A failed lookup is not retried on its own, so this
                                    is the way back from a provider blip. */}
                                {lookupError && !lookupLoading && (
                                    <div className="flex items-start gap-2 text-sm text-red-600 dark:text-red-400 bg-red-500/10 border border-red-500/25 rounded-xl p-3">
                                        <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                                        <span className="flex-1">{lookupError}</span>
                                        <button
                                            onClick={retryLookup}
                                            className="font-bold underline underline-offset-2 shrink-0"
                                        >
                                            Try again
                                        </button>
                                    </div>
                                )}

                                {/* ECG meter picker */}
                                {lookup?.meters && lookup.meters.length > 0 && (
                                    <div>
                                        <Label className="text-sm font-semibold text-foreground">Meter</Label>
                                        <Select value={accountNumber} onValueChange={setAccountNumber}>
                                            <SelectTrigger className="mt-1.5 h-12 rounded-xl">
                                                <SelectValue placeholder="Select a meter" />
                                            </SelectTrigger>
                                            <SelectContent>
                                                {lookup.meters.map(m => (
                                                    <SelectItem key={m.meterNumber} value={m.meterNumber}>
                                                        {m.label}
                                                    </SelectItem>
                                                ))}
                                            </SelectContent>
                                        </Select>
                                    </div>
                                )}

                                {/* The confirmation that gates the whole form */}
                                {lookup?.accountName && (
                                    <div className="bg-emerald-500/10 border border-emerald-500/25 rounded-xl p-4">
                                        <div className="flex items-start gap-2.5">
                                            <CheckCircle2 className="w-5 h-5 text-emerald-600 dark:text-emerald-400 mt-0.5 shrink-0" />
                                            <div className="min-w-0">
                                                <p className="text-xs text-emerald-700 dark:text-emerald-300 font-semibold uppercase tracking-wide">Account holder</p>
                                                <p className="font-black text-foreground truncate">{lookup.accountName}</p>
                                                {lookup.amountDue != null && (
                                                    <p className="text-xs text-muted-foreground mt-1">
                                                        {lookup.amountDue < 0
                                                            ? `In credit: GHS ${Math.abs(lookup.amountDue).toFixed(2)}`
                                                            : `Amount due: GHS ${lookup.amountDue.toFixed(2)}`}
                                                    </p>
                                                )}
                                                <p className="text-[11px] text-emerald-700 dark:text-emerald-300 mt-1.5">
                                                    Check this is the right person before you pay — bill payments cannot be reversed.
                                                </p>
                                            </div>
                                        </div>
                                    </div>
                                )}

                                {service.requiresEmail && (
                                    <div>
                                        <Label className="text-sm font-semibold text-foreground">Email for the receipt</Label>
                                        <Input
                                            type="email"
                                            value={email}
                                            onChange={e => setEmail(e.target.value)}
                                            placeholder="you@example.com"
                                            className="mt-1.5 h-12 rounded-xl"
                                        />
                                        <p className="text-[11px] text-muted-foreground/70 mt-1">{service.label} requires an email address.</p>
                                    </div>
                                )}
                            </div>

                            {/* Amount + payment */}
                            <div className={cn('bg-card border border-border rounded-2xl p-5 space-y-4', !lookup?.accountName && 'opacity-50 pointer-events-none')}>
                                <div>
                                    <Label className="text-sm font-semibold text-foreground">Amount to pay (GHS)</Label>
                                    <Input
                                        value={amount}
                                        onChange={e => setAmount(e.target.value.replace(/[^\d.]/g, ''))}
                                        placeholder="0.00"
                                        inputMode="decimal"
                                        className="mt-1.5 h-12 rounded-xl text-lg font-bold"
                                    />
                                    <div className="flex flex-wrap gap-2 mt-2.5">
                                        {QUICK_AMOUNTS.filter(a => a >= service.minAmount && a <= service.maxAmount).map(a => (
                                            <button
                                                key={a}
                                                onClick={() => setAmount(String(a))}
                                                className="px-3 py-1.5 rounded-lg bg-surface-2 hover:bg-surface-3 text-sm font-semibold text-foreground"
                                            >
                                                {a}
                                            </button>
                                        ))}
                                        {lookup?.amountDue != null && lookup.amountDue > 0 && (
                                            <button
                                                onClick={() => setAmount(lookup.amountDue!.toFixed(2))}
                                                className="px-3 py-1.5 rounded-lg bg-accent-solid text-accent-contrast text-sm font-semibold"
                                            >
                                                Pay full bill
                                            </button>
                                        )}
                                    </div>
                                    <p className="text-[11px] text-muted-foreground/70 mt-2">
                                        Min GHS {service.minAmount.toFixed(2)} · Max GHS {service.maxAmount.toFixed(2)}
                                    </p>
                                </div>

                                {needsMomoDetails && (
                                    <div className="grid sm:grid-cols-2 gap-3">
                                        <div>
                                            <Label className="text-sm font-semibold text-foreground">MoMo number</Label>
                                            <Input
                                                value={momoPhone}
                                                onChange={e => setMomoPhone(e.target.value)}
                                                placeholder="0XXXXXXXXX"
                                                inputMode="numeric"
                                                maxLength={10}
                                                className="mt-1.5 h-12 rounded-xl"
                                            />
                                        </div>
                                        <div>
                                            <Label className="text-sm font-semibold text-foreground">Network</Label>
                                            <Select value={momoNetwork} onValueChange={setMomoNetwork}>
                                                <SelectTrigger className="mt-1.5 h-12 rounded-xl">
                                                    <SelectValue placeholder="Select network" />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    <SelectItem value="MTN">MTN</SelectItem>
                                                    <SelectItem value="Telecel">Telecel</SelectItem>
                                                    <SelectItem value="AT">AirtelTigo</SelectItem>
                                                </SelectContent>
                                            </Select>
                                        </div>
                                    </div>
                                )}

                                {/* Breakdown */}
                                {parsedAmount > 0 && (
                                    <div className="bg-surface-2 rounded-xl p-4 space-y-2">
                                        <div className="flex justify-between text-sm">
                                            <span className="text-muted-foreground">Bill amount</span>
                                            <span className="font-semibold">GHS {parsedAmount.toFixed(2)}</span>
                                        </div>
                                        <div className="flex justify-between text-sm">
                                            <span className="text-muted-foreground">Service fee ({service.feeRate}%)</span>
                                            <span className="font-semibold">GHS {feeAmount.toFixed(2)}</span>
                                        </div>
                                        <div className="flex justify-between border-t border-border pt-2">
                                            <span className="font-bold text-foreground">Total</span>
                                            <span className="font-black text-foreground">GHS {totalPayable.toFixed(2)}</span>
                                        </div>
                                        <p className="text-[11px] text-muted-foreground/70 flex items-start gap-1.5 pt-1">
                                            <Info className="w-3 h-3 mt-0.5 shrink-0" />
                                            A gateway charge may be added at checkout, depending on the provider.
                                        </p>
                                    </div>
                                )}

                                <Button
                                    className="w-full h-12 rounded-xl bg-accent-solid hover:bg-accent-strong text-accent-contrast font-bold"
                                    disabled={!canSubmit || isSubmitting}
                                    onClick={() => setShowConfirm(true)}
                                >
                                    {isSubmitting
                                        ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Processing…</>
                                        : <>Pay GHS {totalPayable.toFixed(2)} <ArrowRight className="w-4 h-4 ml-1.5" /></>}
                                </Button>
                            </div>
                        </>
                    )}

                {/* ── Recent payments ─────────────────────────────────────────── */}
                <div className="space-y-3">
                    <div className="flex items-center justify-between">
                        <p className="text-xs font-black uppercase tracking-[0.15em] text-muted-foreground">Recent payments</p>
                        <button
                            onClick={fetchHistory}
                            disabled={historyLoading}
                            className="w-7 h-7 rounded-full bg-surface-2 border border-border flex items-center justify-center hover:bg-surface-3 transition-colors"
                        >
                            <RefreshCw className={cn('w-3.5 h-3.5 text-muted-foreground', historyLoading && 'animate-spin')} />
                        </button>
                    </div>

                    <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1">
                        <FilterPill
                            value={billerFilter}
                            onChange={setBillerFilter}
                            options={[{ value: 'all', label: 'All billers' }, ...services.map(s => ({ value: s.id, label: s.label }))]}
                        />
                        <FilterPill
                            value={statusFilter}
                            onChange={setStatusFilter}
                            options={[
                                { value: 'all', label: 'All statuses' },
                                { value: 'pending', label: 'Pending' },
                                { value: 'processing', label: 'Processing' },
                                { value: 'completed', label: 'Completed' },
                                { value: 'failed', label: 'Failed' },
                                { value: 'refunded', label: 'Refunded' },
                            ]}
                        />
                        <FilterPill
                            value={sourceFilter}
                            onChange={setSourceFilter}
                            options={[
                                { value: 'all', label: 'All sources' },
                                { value: 'wallet', label: 'Wallet' },
                                { value: 'gateway', label: 'Mobile Money' },
                            ]}
                        />
                        <FilterPill
                            value={dateFilter}
                            onChange={setDateFilter}
                            options={[
                                { value: 'all', label: 'All time' },
                                { value: 'today', label: 'Today' },
                                { value: '7d', label: 'Last 7 days' },
                                { value: '30d', label: 'Last 30 days' },
                            ]}
                        />
                    </div>

                    {historyLoading ? (
                        <div className="flex justify-center py-12">
                            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground/70" />
                        </div>
                    ) : filteredOrders.length === 0 ? (
                        <div className="text-center py-12 rounded-2xl border border-dashed border-border">
                            <History className="w-8 h-8 text-muted-foreground/40 mx-auto mb-3" />
                            <p className="text-foreground font-semibold text-sm">
                                {orders.length === 0 ? 'No bills paid yet' : 'No payments match these filters'}
                            </p>
                            <p className="text-xs text-muted-foreground mt-1 max-w-[26rem] mx-auto">
                                {orders.length === 0
                                    ? <>Your ECG, water and TV payments will appear here with <span className="text-accent-solid">live delivery status</span>.</>
                                    : 'Try clearing a filter above.'}
                            </p>
                        </div>
                    ) : (
                        <div className="space-y-2.5">
                            {filteredOrders.map(order => {
                                return (
                                    <div key={order.id} className="bg-card border border-border rounded-2xl p-4 shadow-e1">
                                        <div className="flex items-start gap-3">
                                            <ServiceLogo id={order.service} size="sm" />
                                            <div className="min-w-0 flex-1">
                                                <div className="flex items-start justify-between gap-2">
                                                    <div className="min-w-0">
                                                        <p className="font-bold text-foreground text-sm">
                                                            {serviceLabelFor(order.service)} · {order.account_number}
                                                        </p>
                                                        {order.account_name && (
                                                            <p className="text-xs text-muted-foreground truncate">{order.account_name}</p>
                                                        )}
                                                    </div>
                                                    <StatusBadge status={order.status} />
                                                </div>
                                                <div className="flex items-center justify-between mt-2">
                                                    <span className="text-xs text-muted-foreground/70">
                                                        {format(parseISO(order.created_at), 'dd MMM yyyy, HH:mm')}
                                                    </span>
                                                    <span className="font-black text-foreground text-sm">
                                                        GHS {Number(order.bill_amount).toFixed(2)}
                                                    </span>
                                                </div>
                                                {order.fulfillment_note && (
                                                    <p className="text-[11px] text-muted-foreground bg-surface-2 rounded-lg p-2 mt-2">
                                                        {order.fulfillment_note}
                                                    </p>
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                )
                            })}
                        </div>
                    )}
                </div>
            </div>

            {/* Floating refresh — reloads the wallet strip and the payments list */}
            <button
                onClick={refreshAll}
                className="fixed bottom-24 right-4 z-30 w-12 h-12 rounded-full bg-surface-2 border border-border shadow-e2 flex items-center justify-center hover:bg-surface-3 transition-colors md:bottom-8"
            >
                <RefreshCw className={cn('w-5 h-5 text-foreground', historyLoading && 'animate-spin')} />
            </button>

            {/* Confirm dialog */}
            <Dialog open={showConfirm} onOpenChange={open => { if (!open && !isSubmitting) setShowConfirm(false) }}>
                <DialogContent className="rounded-2xl bg-card border-border shadow-e4">
                    <DialogHeader>
                        <DialogTitle>Confirm this bill payment</DialogTitle>
                        <DialogDescription>
                            Bill payments cannot be reversed once the provider accepts them. Check the name and account below.
                        </DialogDescription>
                    </DialogHeader>

                    <div className="space-y-2.5 py-2">
                        <div className="flex justify-between text-sm"><span className="text-muted-foreground">Service</span><span className="font-semibold">{service?.label}</span></div>
                        <div className="flex justify-between text-sm"><span className="text-muted-foreground">Account</span><span className="font-semibold">{accountNumber}</span></div>
                        <div className="flex justify-between text-sm">
                            <span className="text-muted-foreground">Name</span>
                            <span className="font-black text-foreground">{lookup?.accountName}</span>
                        </div>
                        <div className="flex justify-between text-sm"><span className="text-muted-foreground">Bill amount</span><span className="font-semibold">GHS {parsedAmount.toFixed(2)}</span></div>
                        <div className="flex justify-between text-sm"><span className="text-muted-foreground">Service fee</span><span className="font-semibold">GHS {feeAmount.toFixed(2)}</span></div>
                        <div className="flex justify-between border-t border-border pt-2.5">
                            <span className="font-bold text-foreground">Total</span>
                            <span className="font-black text-lg text-foreground">GHS {totalPayable.toFixed(2)}</span>
                        </div>
                    </div>

                    <DialogFooter className="gap-2">
                        <Button variant="outline" className="rounded-xl flex-1" onClick={() => setShowConfirm(false)} disabled={isSubmitting}>
                            Cancel
                        </Button>
                        <Button className="rounded-xl flex-1 bg-accent-solid hover:bg-accent-strong text-accent-contrast" onClick={handleConfirm} disabled={isSubmitting}>
                            {isSubmitting ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Processing…</> : 'Confirm & Pay'}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Moolre OTP */}
            <Dialog open={otpRequired} onOpenChange={open => { if (!open) { setOtpRequired(false); setOtpCode('') } }}>
                <DialogContent className="rounded-2xl bg-card border-border shadow-e4">
                    <DialogHeader>
                        <DialogTitle>Enter the OTP</DialogTitle>
                        <DialogDescription>Your network sent a one-time code to authorise this payment.</DialogDescription>
                    </DialogHeader>
                    <Input
                        value={otpCode}
                        onChange={e => setOtpCode(e.target.value.replace(/\D/g, ''))}
                        placeholder="000000"
                        inputMode="numeric"
                        className="h-12 rounded-xl text-center text-lg tracking-[0.4em] font-bold"
                    />
                    <DialogFooter>
                        <Button
                            className="w-full rounded-xl bg-accent-solid hover:bg-accent-strong text-accent-contrast h-11"
                            disabled={!otpCode.trim() || isSubmitting}
                            onClick={() => {
                                setOtpRequired(false)
                                payFromGateway({ otpCode: otpCode.trim(), reference: directPaymentRef || undefined })
                                setOtpCode('')
                            }}
                        >
                            Verify & Pay
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <SuccessModal
                order={successOrder}
                label={successOrder ? serviceLabelFor(successOrder.service) : ''}
                onClose={() => setSuccessOrder(null)}
                onPayAnother={() => { setSuccessOrder(null); setServiceId(null) }}
            />
        </div>
    )
}

// ─── Suspense wrapper (required by Next.js 15 for useSearchParams) ────────────
export default function UtilitiesPage() {
    return (
        <Suspense fallback={<div className="flex items-center justify-center min-h-[60vh]"><div className="w-8 h-8 rounded-full border-4 border-border border-t-accent-solid animate-spin" /></div>}>
            <UtilitiesPageInner />
        </Suspense>
    )
}
