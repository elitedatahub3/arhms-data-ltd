'use client'

/**
 * Sub-Agent AFA registration (de-branded).
 *
 * The sub registers walk-in customers and pays what their Lead charges, debited
 * from their own wallet. Validation helpers are shared with the main dashboard
 * form and the storefront panel via lib/afa-validation, so all three enforce
 * the same ID formats — a shape accepted here that the others reject would put
 * an unprocessable application in the admin queue.
 */

import { useEffect, useState } from 'react'
import {
    ID_TYPES,
    REGIONS,
    validateId,
    maskIdNumber,
    ageFromDob,
    maxDobInputValue,
    MIN_AFA_AGE,
    AFA_REQUIRED_FIELDS,
} from '@/lib/afa-validation'

interface Application {
    id: string
    full_name: string
    phone: string
    id_type: string | null
    id_number: string | null
    region: string
    location: string
    status: string
    payment_amount: number | null
    created_at: string
}

const STATUS_STYLE: Record<string, { label: string; cls: string }> = {
    pending: { label: 'Pending', cls: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400' },
    processing: { label: 'Processing', cls: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400' },
    completed: { label: 'Completed', cls: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' },
    cancelled: { label: 'Cancelled', cls: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' },
}

const EMPTY_FORM = {
    full_name: '', phone: '', id_type: 'Ghana Card', id_number: '',
    date_of_birth: '', location: '', region: 'Greater Accra', notes: '',
}

const FIELD_CLS =
    'w-full px-3 py-2.5 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 outline-none focus:ring-2 focus:ring-blue-500'
const LABEL_CLS = 'block text-sm font-semibold text-gray-700 dark:text-gray-300 mb-1'

export default function SubAfaPage() {
    const [loading, setLoading] = useState(true)
    const [available, setAvailable] = useState(false)
    const [reason, setReason] = useState<string | null>(null)
    const [price, setPrice] = useState(0)
    const [parentShopName, setParentShopName] = useState('')
    const [walletBalance, setWalletBalance] = useState(0)
    const [applications, setApplications] = useState<Application[]>([])

    const [form, setForm] = useState(EMPTY_FORM)
    const [idError, setIdError] = useState<string | null>(null)
    const [showConfirm, setShowConfirm] = useState(false)
    const [submitting, setSubmitting] = useState(false)
    const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null)
    const [lowBalance, setLowBalance] = useState(false)

    const load = async () => {
        try {
            const res = await fetch('/api/dashboard/sub/afa')
            const data = await res.json()
            if (!res.ok) {
                setMsg({ type: 'err', text: data.error || 'Failed to load' })
                setAvailable(false)
            } else {
                setAvailable(!!data.available)
                setReason(data.reason || null)
                setPrice(data.price || 0)
                setParentShopName(data.parentShopName || '')
                setWalletBalance(data.walletBalance || 0)
                setApplications(data.applications || [])
            }
        } catch {
            setMsg({ type: 'err', text: 'Network error. Please try again.' })
        } finally {
            setLoading(false)
        }
    }

    useEffect(() => { load() }, [])

    /** Client-side gate. The server re-validates all of it. */
    const validationError = (): string | null => {
        for (const field of AFA_REQUIRED_FIELDS) {
            if (!String((form as any)[field] || '').trim()) return 'Please fill in all required fields'
        }
        if (!/^(0\d{9}|233\d{9})$/.test(form.phone.replace(/\s+/g, ''))) {
            return 'Enter a valid phone number (0XXXXXXXXX)'
        }
        const idErr = validateId(form.id_type, form.id_number)
        if (idErr) return idErr
        const age = ageFromDob(form.date_of_birth)
        if (age === null) return 'Enter a valid date of birth'
        if (age < MIN_AFA_AGE) return `Applicant must be at least ${MIN_AFA_AGE} years old`
        return null
    }

    const handlePreSubmit = () => {
        setMsg(null)
        setLowBalance(false)
        const err = validationError()
        if (err) { setMsg({ type: 'err', text: err }); return }
        if (walletBalance < price) {
            setLowBalance(true)
            setMsg({ type: 'err', text: 'Your wallet balance is not enough for this registration.' })
            return
        }
        setShowConfirm(true)
    }

    const handleConfirmedSubmit = async () => {
        setSubmitting(true)
        setMsg(null)
        // Generated once per submit and reused on retry, so a double-tap or a
        // dropped response cannot debit the wallet twice.
        const referenceCode = crypto.randomUUID()
        try {
            const res = await fetch('/api/dashboard/sub/afa', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    referenceCode,
                    formData: { ...form, phone: form.phone.replace(/\s+/g, '') },
                }),
            })
            const data = await res.json()

            if (!res.ok) {
                if (data.error === 'INSUFFICIENT_BALANCE') {
                    setLowBalance(true)
                    setMsg({ type: 'err', text: 'Your wallet balance is not enough for this registration.' })
                } else {
                    setMsg({ type: 'err', text: data.error || 'Failed to submit registration' })
                }
                setShowConfirm(false)
                return
            }

            setMsg({
                type: 'ok',
                text: data.isDuplicate
                    ? 'This registration was already submitted.'
                    : 'Registration submitted. It is now being processed.',
            })
            setForm(EMPTY_FORM)
            setIdError(null)
            setShowConfirm(false)
            await load()
        } catch {
            setMsg({ type: 'err', text: 'Network error. Please try again.' })
            setShowConfirm(false)
        } finally {
            setSubmitting(false)
        }
    }

    if (loading) {
        return <div className="max-w-2xl mx-auto p-4 py-16 text-center text-gray-500 dark:text-gray-400">Loading…</div>
    }

    if (!available) {
        return (
            <div className="max-w-2xl mx-auto p-4">
                <div className="bg-white dark:bg-gray-900 rounded-lg shadow p-8 text-center">
                    <p className="text-4xl mb-3">🪪</p>
                    <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">AFA registration unavailable</h1>
                    <p className="text-gray-600 dark:text-gray-400 mt-2">
                        {reason || msg?.text || 'This service is not available to you right now.'}
                    </p>
                </div>

                {applications.length > 0 && <HistoryList applications={applications} />}
            </div>
        )
    }

    return (
        <div className="max-w-2xl mx-auto p-4 space-y-4">
            <div>
                <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">AFA Registration</h1>
                <p className="text-sm text-gray-600 dark:text-gray-400 mt-0.5">
                    Register a customer for AFA membership. The fee is charged to your wallet.
                </p>
            </div>

            {/* Fee + balance */}
            <div className="bg-white dark:bg-gray-900 rounded-lg shadow p-4 flex items-center justify-between gap-4">
                <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Fee</p>
                    <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">₵{price.toFixed(2)}</p>
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">Set by {parentShopName}</p>
                </div>
                <div className="text-right">
                    <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Your wallet</p>
                    <p className={`text-2xl font-bold ${walletBalance < price ? 'text-red-600' : 'text-gray-900 dark:text-gray-100'}`}>
                        ₵{walletBalance.toFixed(2)}
                    </p>
                </div>
            </div>

            {msg && (
                <div className={`rounded-lg px-4 py-3 text-sm ${msg.type === 'ok'
                    ? 'bg-green-50 dark:bg-green-900/20 text-green-800 dark:text-green-300'
                    : 'bg-red-50 dark:bg-red-900/20 text-red-800 dark:text-red-300'}`}>
                    {msg.text}
                    {lowBalance && (
                        <a href="/dashboard/sub" className="ml-2 underline font-semibold">Top up</a>
                    )}
                </div>
            )}

            {/* Form */}
            <div className="bg-white dark:bg-gray-900 rounded-lg shadow p-4 space-y-3">
                <div>
                    <label className={LABEL_CLS}>Full Name</label>
                    <input
                        className={FIELD_CLS}
                        value={form.full_name}
                        onChange={e => setForm(f => ({ ...f, full_name: e.target.value }))}
                        placeholder="As shown on the ID"
                    />
                </div>

                <div>
                    <label className={LABEL_CLS}>Phone Number</label>
                    <input
                        className={FIELD_CLS}
                        type="tel"
                        inputMode="tel"
                        value={form.phone}
                        onChange={e => setForm(f => ({ ...f, phone: e.target.value }))}
                        placeholder="0244123456"
                    />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                        <label className={LABEL_CLS}>ID Type</label>
                        <select
                            className={FIELD_CLS}
                            value={form.id_type}
                            onChange={e => {
                                // Re-mask under the new type so a part-typed number is not
                                // left in the previous type's format.
                                const nextType = e.target.value
                                const remasked = maskIdNumber(nextType, form.id_number)
                                setForm(f => ({ ...f, id_type: nextType, id_number: remasked }))
                                setIdError(remasked ? validateId(nextType, remasked) : null)
                            }}
                        >
                            {ID_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                        </select>
                    </div>
                    <div>
                        <label className={LABEL_CLS}>ID Number</label>
                        <input
                            className={`${FIELD_CLS} ${idError ? 'border-red-500' : ''}`}
                            value={form.id_number}
                            onChange={e => {
                                const masked = maskIdNumber(form.id_type, e.target.value)
                                setForm(f => ({ ...f, id_number: masked }))
                                setIdError(masked ? validateId(form.id_type, masked) : null)
                            }}
                            placeholder={ID_TYPES.find(t => t.value === form.id_type)?.placeholder}
                        />
                        {idError && <p className="text-xs text-red-600 mt-1">{idError}</p>}
                    </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                        <label className={LABEL_CLS}>Date of Birth</label>
                        <input
                            className={FIELD_CLS}
                            type="date"
                            max={maxDobInputValue()}
                            value={form.date_of_birth}
                            onChange={e => setForm(f => ({ ...f, date_of_birth: e.target.value }))}
                        />
                        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">Must be {MIN_AFA_AGE} or older.</p>
                    </div>
                    <div>
                        <label className={LABEL_CLS}>Region</label>
                        <select
                            className={FIELD_CLS}
                            value={form.region}
                            onChange={e => setForm(f => ({ ...f, region: e.target.value }))}
                        >
                            {REGIONS.map(r => <option key={r} value={r}>{r}</option>)}
                        </select>
                    </div>
                </div>

                <div>
                    <label className={LABEL_CLS}>Town / Location</label>
                    <input
                        className={FIELD_CLS}
                        value={form.location}
                        onChange={e => setForm(f => ({ ...f, location: e.target.value }))}
                        placeholder="e.g. Madina"
                    />
                </div>

                <div>
                    <label className={LABEL_CLS}>Notes (optional)</label>
                    <textarea
                        className={`${FIELD_CLS} resize-none`}
                        rows={2}
                        value={form.notes}
                        onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                    />
                </div>

                <button
                    onClick={handlePreSubmit}
                    disabled={submitting}
                    className="w-full py-3 rounded-lg bg-blue-600 text-white font-semibold hover:bg-blue-700 disabled:opacity-60"
                >
                    Review &amp; Pay ₵{price.toFixed(2)}
                </button>
            </div>

            <HistoryList applications={applications} />

            {/* Confirm — this debits real money, so the details get one last look */}
            {showConfirm && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
                    <div className="bg-white dark:bg-gray-900 rounded-lg shadow-xl max-w-md w-full p-5 space-y-4">
                        <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100">Confirm registration</h2>
                        <div className="text-sm space-y-1 text-gray-700 dark:text-gray-300">
                            <p><span className="font-semibold">Name:</span> {form.full_name}</p>
                            <p><span className="font-semibold">Phone:</span> {form.phone}</p>
                            <p><span className="font-semibold">{form.id_type}:</span> {form.id_number}</p>
                            <p><span className="font-semibold">DOB:</span> {form.date_of_birth}</p>
                            <p><span className="font-semibold">Location:</span> {form.location}, {form.region}</p>
                        </div>
                        <div className="rounded-lg bg-gray-50 dark:bg-gray-800 px-4 py-3 flex items-center justify-between">
                            <span className="text-sm font-semibold text-gray-700 dark:text-gray-300">Charged to your wallet</span>
                            <span className="text-lg font-bold text-gray-900 dark:text-gray-100">₵{price.toFixed(2)}</span>
                        </div>
                        <p className="text-xs text-gray-500 dark:text-gray-400">
                            Check the details carefully — this payment may not be refundable once submitted.
                        </p>
                        <div className="flex gap-2">
                            <button
                                onClick={() => setShowConfirm(false)}
                                disabled={submitting}
                                className="flex-1 py-2.5 rounded-lg border border-gray-300 dark:border-gray-700 font-semibold text-gray-700 dark:text-gray-300 disabled:opacity-60"
                            >
                                Back
                            </button>
                            <button
                                onClick={handleConfirmedSubmit}
                                disabled={submitting}
                                className="flex-1 py-2.5 rounded-lg bg-blue-600 text-white font-semibold hover:bg-blue-700 disabled:opacity-60"
                            >
                                {submitting ? 'Submitting…' : 'Confirm & Pay'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    )
}

function HistoryList({ applications }: { applications: Application[] }) {
    if (applications.length === 0) return null
    return (
        <div className="bg-white dark:bg-gray-900 rounded-lg shadow divide-y divide-gray-100 dark:divide-gray-800">
            <div className="px-4 py-3">
                <h2 className="font-bold text-gray-900 dark:text-gray-100">My Registrations</h2>
            </div>
            {applications.map(app => {
                const s = STATUS_STYLE[app.status] || STATUS_STYLE.pending
                return (
                    <div key={app.id} className="px-4 py-3 flex items-center justify-between gap-3">
                        <div className="min-w-0">
                            <p className="font-semibold text-sm text-gray-900 dark:text-gray-100 truncate">{app.full_name}</p>
                            <p className="text-xs text-gray-500 dark:text-gray-400">
                                {app.phone} · {app.location}, {app.region}
                            </p>
                            <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">
                                {new Date(app.created_at).toLocaleDateString()}
                            </p>
                        </div>
                        <div className="text-right shrink-0">
                            <span className={`inline-block text-[10px] font-bold uppercase px-2 py-0.5 rounded-full ${s.cls}`}>
                                {s.label}
                            </span>
                            {app.payment_amount != null && (
                                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                                    ₵{Number(app.payment_amount).toFixed(2)}
                                </p>
                            )}
                        </div>
                    </div>
                )
            })}
        </div>
    )
}
