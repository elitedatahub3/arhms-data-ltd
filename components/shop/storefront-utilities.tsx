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
import { Loader2, Receipt, CheckCircle2, AlertTriangle, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'

const BILLERS = [
    { id: 'dstv',       label: 'DSTV',       hint: 'Smartcard / IUC number' },
    { id: 'gotv',       label: 'GOtv',       hint: 'IUC number' },
    { id: 'startimes',  label: 'StarTimes',  hint: 'Account number' },
    { id: 'ecg',        label: 'ECG Prepaid', hint: 'Looked up by phone number' },
    { id: 'ghanawater', label: 'Ghana Water', hint: 'Meter number' },
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
    const [quote, setQuote] = useState<Quote | null>(null)

    const [verifying, setVerifying] = useState(false)
    const [quoting, setQuoting] = useState(false)
    const [paying, setPaying] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const [momoPhone, setMomoPhone] = useState('')
    const [momoNetwork, setMomoNetwork] = useState('MTN')

    const def = BILLERS.find(b => b.id === biller)!
    const isEcg = biller === 'ecg'

    const reset = () => { setLookup(null); setQuote(null); setChosenMeter(''); setError(null) }

    const verify = async () => {
        setError(null); setVerifying(true); setQuote(null)
        try {
            const res = await fetch('/api/shop/utilities/lookup', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ shopSlug, service: biller, accountNumber: account, phone }),
            })
            const json = await res.json()
            if (!res.ok) { setError(json.error || 'Could not verify that account'); setLookup(null); return }
            setLookup(json)
            // ECG returns every meter on the phone. Honour one the customer typed
            // themselves when it is genuinely on that phone, and only fall back to
            // preselecting the first — overwriting a typed meter would silently pay
            // a different one, and a bill payment cannot be reversed.
            if (json.meters?.length) {
                const typed = account.replace(/\s+/g, '').toLowerCase()
                const match = json.meters.find(
                    (m: Meter) => m.meterNumber.replace(/\s+/g, '').toLowerCase() === typed
                )
                if (match) setChosenMeter(match.meterNumber)
                else if (!typed) setChosenMeter(json.meters[0].meterNumber)
                // Typed a meter that is not on this phone: select nothing and make
                // them choose. Falling back to the first meter here would pay a
                // DIFFERENT customer's bill than the one they typed, and there is no
                // way to reverse it.
                else setChosenMeter('')
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
                    accountNumber: isEcg ? chosenMeter : account,
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
    const canPay = !!lookup && !!quote && !belowMin && !aboveMax && (!isEcg || !!chosenMeter)
        && (!lookup.requires_email || !!email) && !paying

    return (
        <div className="space-y-4">
            {/* Biller */}
            <div>
                <label className="block text-sm font-semibold mb-2">Choose a biller</label>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                    {BILLERS.map(b => (
                        <button
                            key={b.id}
                            type="button"
                            onClick={() => { setBiller(b.id); setAccount(''); reset() }}
                            className={cn(
                                'rounded-xl border px-3 py-2.5 text-left transition-colors',
                                biller === b.id
                                    ? 'border-transparent text-white'
                                    : 'border-gray-200 dark:border-gray-700 hover:border-gray-300'
                            )}
                            style={biller === b.id ? { backgroundColor: accent } : undefined}
                        >
                            <span className="block text-sm font-bold">{b.label}</span>
                            <span className={cn('block text-[11px]', biller === b.id ? 'text-white/80' : 'text-gray-500')}>
                                {b.hint}
                            </span>
                        </button>
                    ))}
                </div>
            </div>

            {/* Account / phone */}
            <div className="space-y-3">
                {(isEcg || def.id === 'ghanawater') && (
                    <div>
                        <label className="block text-sm font-medium mb-1">Phone number linked to the account</label>
                        <input
                            value={phone}
                            onChange={e => { setPhone(e.target.value); reset() }}
                            placeholder="0XXXXXXXXX"
                            inputMode="numeric"
                            className="w-full rounded-xl border border-gray-200 dark:border-gray-700 dark:bg-gray-800 px-3 py-2.5 text-sm"
                        />
                    </div>
                )}

                {/* Shown for ECG too, matching the dashboard. Hiding it forced a
                    customer who already knows their meter number through a phone
                    lookup they did not need — and a phone with no meters registered
                    then looks like a broken shop rather than the wrong number. */}
                <div>
                    <label className="block text-sm font-medium mb-1">
                        {isEcg ? 'Meter Number' : def.hint}
                    </label>
                    <input
                        value={account}
                        onChange={e => { setAccount(e.target.value); reset() }}
                        placeholder={isEcg ? 'Meter Number' : def.hint}
                        inputMode="numeric"
                        className="w-full rounded-xl border border-gray-200 dark:border-gray-700 dark:bg-gray-800 px-3 py-2.5 text-sm"
                    />
                    {isEcg && (
                        <p className="text-[11px] text-gray-400 mt-1">
                            Type it, or pick one of the meters on your ECG Power App number.
                        </p>
                    )}
                </div>

                <button
                    type="button"
                    onClick={verify}
                    disabled={verifying || (isEcg ? !phone : !account)}
                    className="w-full rounded-xl py-2.5 text-sm font-bold text-white disabled:opacity-50 flex items-center justify-center gap-2"
                    style={{ backgroundColor: accent }}
                >
                    {verifying ? <Loader2 className="w-4 h-4 animate-spin" /> : <Receipt className="w-4 h-4" />}
                    Verify account
                </button>
            </div>

            {error && (
                <div className="rounded-xl border border-red-200 bg-red-50 dark:bg-red-900/20 p-3 text-sm text-red-700 dark:text-red-300 flex gap-2">
                    <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                    <span>{error}</span>
                </div>
            )}

            {/* Verified */}
            {lookup && (
                <div className="space-y-4">
                    {lookup.meters.length > 0 ? (
                        <div>
                            {/* Only when they typed a meter that is not on this phone.
                                Says which, rather than quietly selecting another one. */}
                            {account.trim() && !chosenMeter && (
                                <div className="mb-2 rounded-xl border border-amber-200 bg-amber-50 dark:bg-amber-900/20 p-3 text-xs text-amber-800 dark:text-amber-300 flex gap-2">
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
                                                : 'border-gray-200 dark:border-gray-700'
                                        )}
                                    >
                                        <div className="flex-1 min-w-0">
                                            <p className="text-sm font-bold truncate">{m.name}</p>
                                            <p className="text-xs text-gray-500 font-mono">{m.meterNumber}</p>
                                        </div>
                                        {chosenMeter === m.meterNumber && <CheckCircle2 className="w-4 h-4 text-emerald-500" />}
                                    </button>
                                ))}
                            </div>
                            <p className="text-[11px] text-gray-500 mt-2">
                                One phone number can have several meters. Check this is the right one — a bill
                                payment cannot be reversed.
                            </p>
                        </div>
                    ) : (
                        <div className="rounded-xl border border-emerald-200 bg-emerald-50 dark:bg-emerald-900/20 p-3">
                            <p className="text-[11px] uppercase font-bold text-emerald-700 dark:text-emerald-400">Account holder</p>
                            <p className="text-base font-bold">{lookup.account_name}</p>
                            {lookup.amount_due != null && (
                                <p className="text-xs text-gray-600 dark:text-gray-400 mt-0.5">
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
                                className="w-full rounded-xl border border-gray-200 dark:border-gray-700 dark:bg-gray-800 px-3 py-2.5 text-sm"
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
                            className="w-full rounded-xl border border-gray-200 dark:border-gray-700 dark:bg-gray-800 px-3 py-2.5 text-sm"
                        />
                        <div className="flex gap-1.5 mt-2 flex-wrap">
                            {[10, 20, 50, 100, 200].filter(v => v >= lookup.min_amount && v <= lookup.max_amount).map(v => (
                                <button
                                    key={v}
                                    type="button"
                                    onClick={() => requote(String(v))}
                                    className="rounded-full border border-gray-200 dark:border-gray-700 px-3 py-1 text-xs font-semibold"
                                >{v}</button>
                            ))}
                        </div>
                        <p className="text-[11px] text-gray-500 mt-1.5">
                            Min GHS {lookup.min_amount.toFixed(2)} · Max GHS {lookup.max_amount.toFixed(2)}
                        </p>
                        {belowMin && <p className="text-xs text-red-600 mt-1">Minimum is GHS {lookup.min_amount.toFixed(2)}.</p>}
                        {aboveMax && <p className="text-xs text-red-600 mt-1">Maximum is GHS {lookup.max_amount.toFixed(2)}.</p>}
                    </div>

                    {/* Quote. Server-computed, so the customer sees exactly what the
                        charge will be rather than a browser-side estimate. */}
                    {quoting && <p className="text-xs text-gray-500 flex items-center gap-1.5"><Loader2 className="w-3 h-3 animate-spin" /> Working out the total…</p>}
                    {quote && !quoting && (
                        <div className="rounded-xl bg-gray-50 dark:bg-gray-800/60 p-3 text-sm space-y-1">
                            <div className="flex justify-between"><span className="text-gray-600 dark:text-gray-400">Bill amount</span><span className="font-semibold">GHS {quote.bill_amount.toFixed(2)}</span></div>
                            <div className="flex justify-between"><span className="text-gray-600 dark:text-gray-400">Service fee ({quote.total_fee_percent.toFixed(2)}%)</span><span className="font-semibold">GHS {quote.total_fee.toFixed(2)}</span></div>
                            <div className="flex justify-between border-t border-gray-200 dark:border-gray-700 pt-1 mt-1"><span className="font-bold">Total</span><span className="font-bold">GHS {quote.total.toFixed(2)}</span></div>
                            <p className="text-[11px] text-gray-500 pt-1">A gateway charge may be added at checkout, depending on the provider.</p>
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
                                className="w-full rounded-xl border border-gray-200 dark:border-gray-700 dark:bg-gray-800 px-3 py-2.5 text-sm"
                            />
                        </div>
                        <div>
                            <label className="block text-sm font-medium mb-1">Network</label>
                            <select
                                value={momoNetwork}
                                onChange={e => setMomoNetwork(e.target.value)}
                                className="w-full rounded-xl border border-gray-200 dark:border-gray-700 dark:bg-gray-800 px-3 py-2.5 text-sm"
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
