'use client'

/**
 * The Pay Bills tab on a shop storefront.
 *
 * Self-contained rather than inlined into ShopStorefront.tsx, which is already
 * 2,400 lines: the flow here has its own three steps (verify, quote, pay) and
 * folding them into that file would make both harder to follow.
 *
 * The customer is a GUEST — there is no session. Everything that decides money is
 * therefore resolved server-side: the account name comes from the provider, the fee
 * split comes from /api/shop/utilities/lookup, and the charge is re-verified and
 * re-priced by /api/utilities/gateway-init before a pesewa moves. Nothing this
 * component computes is trusted.
 *
 * ECG is the shape that differs. Its lookup runs on the PHONE and answers with every
 * meter on that number, so the customer picks one instead of typing it — one phone
 * can carry several meters and paying the wrong one is unrecoverable.
 */
import { useState } from 'react'
import { Loader2, Receipt, CheckCircle2, AlertTriangle, ChevronRight, Phone, ArrowRight, Tv, Zap, Droplets } from 'lucide-react'
import { cn } from '@/lib/utils'

const BILLERS = [
    { id: 'dstv',       label: 'DSTV',       hint: 'Smartcard / IUC number',    icon: Tv,       gradient: 'from-[#0057b8] to-[#0091ea]' },
    { id: 'gotv',       label: 'GOtv',       hint: 'IUC number',                icon: Tv,       gradient: 'from-[#43a047] to-[#7cb342]' },
    { id: 'startimes',  label: 'StarTimes',  hint: 'Account number',            icon: Tv,       gradient: 'from-[#e65100] to-[#fb8c00]' },
    { id: 'ecg',        label: 'ECG Prepaid', hint: 'Looked up by phone number', icon: Zap,      gradient: 'from-[#f9a825] to-[#fdd835]' },
    { id: 'ghanawater', label: 'Ghana Water', hint: 'Meter number',              icon: Droplets, gradient: 'from-[#0277bd] to-[#4fc3f7]' },
] as const

type BillerId = typeof BILLERS[number]['id']

interface Meter { name: string; meterNumber: string; outstanding: number }

interface LookupResult {
    label: string
    account_label: string
    requires_phone: boolean
    requires_email: boolean
    account_name: string | null
    amount_due: number | null
    meters: Meter[]
    min_amount: number
    max_amount: number
}

interface Quote {
    bill_amount: number
    platform_fee: number
    shop_fee: number
    total_fee: number
    total: number
    total_fee_percent: number
}

export default function StorefrontUtilities({
    shopSlug,
    brandColor,
}: {
    shopSlug: string
    brandColor?: string
}) {
    const [biller, setBiller] = useState<BillerId>('dstv')
    const [account, setAccount] = useState('')
    const [phone, setPhone] = useState('')
    const [email, setEmail] = useState('')
    const [amount, setAmount] = useState('')

    const [lookup, setLookup] = useState<LookupResult | null>(null)
    const [chosenMeter, setChosenMeter] = useState<string>('')
    // ECG only. Ticked by the customer to pay a meter the lookup does not know,
    // which ECG links to the paying number on first payment. Cleared on every input
    // change so it can never carry over to a meter it was not shown for.
    const [ackUnlinked, setAckUnlinked] = useState(false)
    // True once a check has actually run for the values now in the fields. The
    // acknowledgement is only offered after one, so a customer cannot wave through a
    // meter nobody has tried to confirm.
    const [checked, setChecked] = useState(false)
    const [quote, setQuote] = useState<Quote | null>(null)

    const [verifying, setVerifying] = useState(false)
    const [quoting, setQuoting] = useState(false)
    const [paying, setPaying] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const [momoPhone, setMomoPhone] = useState('')
    const [momoNetwork, setMomoNetwork] = useState('MTN')

    const def = BILLERS.find(b => b.id === biller)!
    const isEcg = biller === 'ecg'

    const reset = () => {
        setLookup(null); setQuote(null); setChosenMeter(''); setError(null)
        setAckUnlinked(false); setChecked(false)
    }

    const verify = async () => {
        setError(null); setVerifying(true); setQuote(null)
        try {
            const res = await fetch('/api/shop/utilities/lookup', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ shopSlug, service: biller, accountNumber: account, phone }),
            })
            const json = await res.json()
            if (!res.ok) {
                // For ECG a failed check is not the end of the road — the meter may
                // simply be new to this phone — so keep the typed number and let the
                // acknowledgement below carry it.
                setError(json.error || 'Could not verify that account')
                setLookup(null)
                if (isEcg) setChecked(true)
                return
            }
            setLookup(json)
            setChecked(true)

            // ECG answers by phone with every meter on it, so confirming the ONE the
            // customer typed means finding it in that answer. A meter that is not
            // there is left unchosen rather than swapped for another — paying a
            // different meter than the one typed is unrecoverable.
            if (isEcg) {
                const typed = account.replace(/\s+/g, '').toLowerCase()
                const match = (json.meters || []).find(
                    (m: Meter) => m.meterNumber.replace(/\s+/g, '').toLowerCase() === typed
                )
                setChosenMeter(match ? match.meterNumber : '')
            }
        } catch {
            setError('Something went wrong. Please try again.')
        } finally {
            setVerifying(false)
        }
    }

    // Re-quoted server-side on every amount change rather than multiplied here: the
    // split depends on the shop's margin and its upline's, neither of which the
    // browser should know or be able to alter.
    const requote = async (value: string) => {
        setAmount(value)
        const n = Number(value)
        if (!Number.isFinite(n) || n <= 0) { setQuote(null); return }
        setQuoting(true)
        try {
            const res = await fetch('/api/shop/utilities/lookup', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    shopSlug, service: biller,
                    accountNumber: isEcg ? chosenMeter || account : account,
                    phone, amount: n,
                }),
            })
            const json = await res.json()
            if (res.ok && json.quote) setQuote(json.quote)
            else setQuote(null)
        } catch {
            setQuote(null)
        } finally {
            setQuoting(false)
        }
    }

    const pay = async () => {
        setError(null); setPaying(true)
        try {
            const res = await fetch('/api/utilities/gateway-init', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    shopSlug,
                    service: biller,
                    // With no listed meter chosen, the typed one is what ECG is asked
                    // to credit — and the flag below is what lets the server accept a
                    // meter its lookup did not return.
                    accountNumber: isEcg ? (chosenMeter || account) : account,
                    acknowledgeUnlinkedMeter: isEcg && !chosenMeter && ackUnlinked,
                    amount: Number(amount),
                    phone,
                    email,
                    momoPhone: momoPhone || phone,
                    momoNetwork,
                }),
            })
            const json = await res.json()
            if (!res.ok) { setError(json.error || 'Could not start the payment'); return }

            // Hosted checkout hands back a URL; the MoMo rails prompt the phone and
            // return a reference to poll. Both shapes are possible depending on which
            // provider the platform has active.
            if (json.authorization_url) { window.location.href = json.authorization_url; return }
            setError(null)
            alert('Check your phone and approve the payment prompt.')
        } catch {
            setError('Something went wrong. Please try again.')
        } finally {
            setPaying(false)
        }
    }

    const accent = brandColor || 'var(--brand-color)'
    const amountNum = Number(amount)
    const belowMin = lookup && Number.isFinite(amountNum) && amountNum > 0 && amountNum < lookup.min_amount
    const aboveMax = lookup && Number.isFinite(amountNum) && amountNum > lookup.max_amount
    /**
     * An ECG meter the lookup never returned is still payable, because ECG links it
     * to the paying number on first payment — but only once the customer has ticked
     * the acknowledgement, since nothing has verified whose meter it is.
     */
    const payingUnlinkedMeter = isEcg && checked && !chosenMeter && !!account.trim() && ackUnlinked

    // Everything except ECG still requires a successful lookup: for those billers the
    // provider confirms the exact account asked about, so a failed check means the
    // number is wrong.
    const accountReady = payingUnlinkedMeter || (!!lookup && (!isEcg || !!chosenMeter))

    const canPay = accountReady && !!quote && !belowMin && !aboveMax
        && (!lookup.requires_email || !!email) && !paying

    return (
        <div className="space-y-4">
            {/* Biller */}
            <div>
                <label className="block text-sm font-bold mb-2 text-foreground">Choose a service</label>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                    {BILLERS.map(b => {
                        const Icon = b.icon
                        const active = biller === b.id
                        return (
                            <button
                                key={b.id}
                                type="button"
                                onClick={() => { setBiller(b.id); setAccount(''); reset() }}
                                className={cn(
                                    'relative rounded-2xl border-2 p-4 text-left transition',
                                    active
                                        ? 'bg-muted'
                                        : 'border-border hover:border-border-strong'
                                )}
                                // The shop's own brand colour marks the selection, so the
                                // card still belongs to the storefront it is sitting on.
                                style={active ? { borderColor: accent } : undefined}
                            >
                                <div className={cn('w-10 h-10 rounded-xl bg-gradient-to-br flex items-center justify-center mb-2', b.gradient)}>
                                    <Icon className="w-5 h-5 text-white" />
                                </div>
                                <p className="font-bold text-sm text-foreground">{b.label}</p>
                                <p className="text-[11px] text-muted-foreground mt-0.5">{b.hint}</p>
                                {active && (
                                    <CheckCircle2 className="absolute top-3 right-3 w-4 h-4" style={{ color: accent }} />
                                )}
                            </button>
                        )
                    })}
                </div>
            </div>

            {/* Account / phone */}
            <div className="space-y-3">
                {(isEcg || def.id === 'ghanawater') && (
                    <div>
                        <label className="block text-sm font-medium mb-1">
                            {isEcg ? 'ECG phone number' : 'Phone number linked to the account'}
                        </label>
                        <div className="relative">
                            <Phone className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                            <input
                                value={phone}
                                onChange={e => { setPhone(e.target.value); reset() }}
                                placeholder="0XXXXXXXXX"
                                inputMode="numeric"
                                className="w-full rounded-xl border border-border bg-card pl-9 pr-3 py-2.5 text-sm"
                            />
                        </div>
                        {isEcg && (
                            <p className="text-[11px] text-muted-foreground mt-1">
                                The number the meter is paid on.
                            </p>
                        )}
                    </div>
                )}

                {/* Non-ECG billers confirm the exact account asked about, so the
                    number is the primary input and there is nothing to disclose. */}
                {!isEcg && (
                    <div>
                        <label className="block text-sm font-medium mb-1">{def.hint}</label>
                        <input
                            value={account}
                            onChange={e => { setAccount(e.target.value); reset() }}
                            placeholder={def.hint}
                            inputMode="numeric"
                            className="w-full rounded-xl border border-border bg-card px-3 py-2.5 text-sm"
                        />
                    </div>
                )}

                {/* ECG asks the provider by PHONE and gets back every meter on it, so
                    a specific meter can only be confirmed by looking for it in that
                    answer. Both fields are therefore inputs, and the check below is
                    what tells the customer whose meter they are about to pay. */}
                {isEcg && (
                    <div>
                        <label className="block text-sm font-medium mb-1">Meter number</label>
                        <input
                            value={account}
                            onChange={e => { setAccount(e.target.value); reset() }}
                            placeholder="Meter number"
                            inputMode="numeric"
                            className="w-full rounded-xl border border-border bg-card px-3 py-2.5 text-sm"
                        />
                    </div>
                )}

                <button
                    type="button"
                    onClick={verify}
                    disabled={verifying || (isEcg ? (!phone.trim() || !account.trim()) : !account.trim())}
                    className="w-full rounded-xl py-2.5 text-sm font-bold text-white disabled:opacity-50 flex items-center justify-center gap-2"
                    style={{ backgroundColor: accent }}
                >
                    {verifying ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                    Check meter
                    {!verifying && <ArrowRight className="w-4 h-4" />}
                </button>

                {/* Shown only after a check that could not confirm the meter — either
                    it is new to this phone or the phone has none yet. ECG links it on
                    first payment, so this is a real first-time customer rather than an
                    error; the tick is what makes paying an unconfirmed meter a choice
                    instead of an accident, and it clears on every edit. */}
                {isEcg && checked && !chosenMeter && account.trim() && (
                    <div className="rounded-xl border border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-900/20 p-3 space-y-2">
                        <p className="text-xs text-amber-800 dark:text-amber-300">
                            We could not confirm meter{' '}
                            <span className="font-mono font-bold">{account.trim()}</span> on{' '}
                            <span className="font-bold">{phone}</span>. If it is new, ECG links it on
                            the first payment.
                        </p>
                        <label className="flex items-start gap-2 cursor-pointer">
                            <input
                                type="checkbox"
                                checked={ackUnlinked}
                                onChange={e => setAckUnlinked(e.target.checked)}
                                className="mt-0.5 w-4 h-4 shrink-0"
                            />
                            <span className="text-[11px] text-amber-900 dark:text-amber-200">
                                ECG will link this meter to{' '}
                                <span className="font-bold">{phone || 'this phone number'}</span>. I understand.
                            </span>
                        </label>
                    </div>
                )}

            </div>

            {error && (
                <div className="rounded-xl border border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-900/20 p-3 text-sm text-red-700 dark:text-red-300 flex gap-2">
                    <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                    <span>{error}</span>
                </div>
            )}

            {/* Verified, OR an acknowledged meter the lookup never returned. The
                second case is a first-time ECG customer: the phone has no meters yet,
                so there is nothing to verify against and the tick is what carries it. */}
            {(lookup || payingUnlinkedMeter) && (
                <div className="space-y-4">
                    {lookup.meters.length > 0 ? (
                        <div>
                            {/* Only when they typed a meter that is not on this phone
                                AND have not knowingly accepted that. Says which meter,
                                rather than quietly selecting a different one. */}
                            {account.trim() && !chosenMeter && !ackUnlinked && (
                                <div className="mb-2 rounded-xl border border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-900/20 p-3 text-xs text-amber-800 dark:text-amber-300 flex gap-2">
                                    <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                                    <span>
                                        Meter <span className="font-mono font-bold">{account.trim()}</span> is not
                                        registered to {phone || 'that phone number'}. Check the number, or pick one below.
                                    </span>
                                </div>
                            )}
                            <label className="block text-sm font-semibold mb-2">
                                Choose the meter
                            </label>
                            <div className="space-y-2">
                                {lookup.meters.map(m => (
                                    <button
                                        key={m.meterNumber}
                                        type="button"
                                        onClick={() => { setChosenMeter(m.meterNumber); if (amount) requote(amount) }}
                                        className={cn(
                                            'w-full rounded-xl border px-3 py-2.5 text-left flex items-center gap-2',
                                            chosenMeter === m.meterNumber
                                                ? 'border-emerald-400 bg-emerald-50 dark:bg-emerald-900/20'
                                                : 'border-border'
                                        )}
                                    >
                                        <div className="flex-1 min-w-0">
                                            <p className="text-sm font-bold truncate">{m.name}</p>
                                            <p className="text-xs text-muted-foreground font-mono">{m.meterNumber}</p>
                                        </div>
                                        {chosenMeter === m.meterNumber && <CheckCircle2 className="w-4 h-4 text-emerald-500" />}
                                    </button>
                                ))}
                            </div>
                            <p className="text-[11px] text-muted-foreground mt-2">
                                One phone number can have several meters. Check this is the right one — a bill
                                payment cannot be reversed.
                            </p>
                        </div>
                    ) : (
                        <div className="rounded-xl border border-emerald-200 dark:border-emerald-900/50 bg-emerald-50 dark:bg-emerald-900/20 p-3">
                            <p className="text-[11px] uppercase font-bold text-emerald-700 dark:text-emerald-400">Account holder</p>
                            <p className="text-base font-bold">{lookup.account_name}</p>
                            {lookup.amount_due != null && (
                                <p className="text-xs text-muted-foreground mt-0.5">
                                    {lookup.amount_due < 0
                                        ? `In credit: GHS ${Math.abs(lookup.amount_due).toFixed(2)}`
                                        : `Amount due: GHS ${lookup.amount_due.toFixed(2)}`}
                                </p>
                            )}
                            <p className="text-[11px] text-emerald-700 dark:text-emerald-400 mt-1">
                                Check this is the right person before you pay — bill payments cannot be reversed.
                            </p>
                        </div>
                    )}

                    {lookup.requires_email && (
                        <div>
                            <label className="block text-sm font-medium mb-1">Email for the receipt</label>
                            <input
                                value={email}
                                onChange={e => setEmail(e.target.value)}
                                placeholder="you@example.com"
                                type="email"
                                className="w-full rounded-xl border border-border bg-card px-3 py-2.5 text-sm"
                            />
                        </div>
                    )}

                    <div>
                        <label className="block text-sm font-medium mb-1">Amount to pay (GHS)</label>
                        <input
                            value={amount}
                            onChange={e => requote(e.target.value)}
                            placeholder="0.00"
                            inputMode="decimal"
                            className="w-full rounded-xl border border-border bg-card px-3 py-2.5 text-sm"
                        />
                        <div className="flex gap-1.5 mt-2 flex-wrap">
                            {[10, 20, 50, 100, 200].filter(v => v >= lookup.min_amount && v <= lookup.max_amount).map(v => (
                                <button
                                    key={v}
                                    type="button"
                                    onClick={() => requote(String(v))}
                                    className="rounded-full border border-border px-3 py-1 text-xs font-semibold"
                                >{v}</button>
                            ))}
                        </div>
                        <p className="text-[11px] text-muted-foreground mt-1.5">
                            Min GHS {lookup.min_amount.toFixed(2)} · Max GHS {lookup.max_amount.toFixed(2)}
                        </p>
                        {belowMin && <p className="text-xs text-red-600 dark:text-red-400 mt-1">Minimum is GHS {lookup.min_amount.toFixed(2)}.</p>}
                        {aboveMax && <p className="text-xs text-red-600 dark:text-red-400 mt-1">Maximum is GHS {lookup.max_amount.toFixed(2)}.</p>}
                    </div>

                    {/* Quote. Server-computed, so the customer sees exactly what the
                        charge will be rather than a browser-side estimate. */}
                    {quoting && <p className="text-xs text-muted-foreground flex items-center gap-1.5"><Loader2 className="w-3 h-3 animate-spin" /> Working out the total…</p>}
                    {quote && !quoting && (
                        <div className="rounded-xl bg-muted bg-card/60 p-3 text-sm space-y-1">
                            <div className="flex justify-between"><span className="text-muted-foreground">Bill amount</span><span className="font-semibold">GHS {quote.bill_amount.toFixed(2)}</span></div>
                            <div className="flex justify-between"><span className="text-muted-foreground">Service fee ({quote.total_fee_percent.toFixed(2)}%)</span><span className="font-semibold">GHS {quote.total_fee.toFixed(2)}</span></div>
                            <div className="flex justify-between border-t border-border pt-1 mt-1"><span className="font-bold">Total</span><span className="font-bold">GHS {quote.total.toFixed(2)}</span></div>
                            <p className="text-[11px] text-muted-foreground pt-1">A gateway charge may be added at checkout, depending on the provider.</p>
                        </div>
                    )}

                    {/* Payment */}
                    <div className="grid grid-cols-2 gap-2">
                        <div>
                            <label className="block text-sm font-medium mb-1">MoMo number</label>
                            <input
                                value={momoPhone}
                                onChange={e => setMomoPhone(e.target.value)}
                                placeholder={phone || '0XXXXXXXXX'}
                                inputMode="numeric"
                                className="w-full rounded-xl border border-border bg-card px-3 py-2.5 text-sm"
                            />
                        </div>
                        <div>
                            <label className="block text-sm font-medium mb-1">Network</label>
                            <select
                                value={momoNetwork}
                                onChange={e => setMomoNetwork(e.target.value)}
                                className="w-full rounded-xl border border-border bg-card px-3 py-2.5 text-sm"
                            >
                                <option value="MTN">MTN</option>
                                <option value="Telecel">Telecel</option>
                                <option value="AT">AT</option>
                            </select>
                        </div>
                    </div>

                    <button
                        type="button"
                        onClick={pay}
                        disabled={!canPay}
                        className="w-full rounded-xl py-3 text-sm font-bold text-white disabled:opacity-50 flex items-center justify-center gap-2"
                        style={{ backgroundColor: accent }}
                    >
                        {paying ? <Loader2 className="w-4 h-4 animate-spin" /> : <ChevronRight className="w-4 h-4" />}
                        {quote ? `Pay GHS ${quote.total.toFixed(2)}` : 'Pay'}
                    </button>
                </div>
            )}
        </div>
    )
}
