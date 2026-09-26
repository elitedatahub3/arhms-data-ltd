'use client'

/**
 * Sub-Agent Results Checker (de-branded).
 *
 * The sub buys vouchers at their Lead's price, charged to their own wallet.
 * Unlike AFA there is no admin queue — the PINs come back in the response, so
 * the reveal panel is the delivery. It stays open until dismissed, and the
 * codes remain recoverable from the order history afterwards.
 */

import { useEffect, useState } from 'react'

interface VoucherType {
    id: string
    name: string
    price: number
    stock: number
}

interface Voucher {
    pin: string
    serial_number: string
}

interface OrderRow {
    id: string
    type_name: string
    quantity: number
    total_paid: number
    status: string
    created_at: string
}

const STATUS_STYLE: Record<string, string> = {
    completed: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
    pending: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400',
    failed: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
    refunded: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
}

export default function SubRcPage() {
    const [loading, setLoading] = useState(true)
    const [available, setAvailable] = useState(false)
    const [reason, setReason] = useState<string | null>(null)
    const [types, setTypes] = useState<VoucherType[]>([])
    const [parentShopName, setParentShopName] = useState('')
    const [walletBalance, setWalletBalance] = useState(0)
    const [orders, setOrders] = useState<OrderRow[]>([])

    const [selected, setSelected] = useState<VoucherType | null>(null)
    const [qty, setQty] = useState(1)
    const [showConfirm, setShowConfirm] = useState(false)
    const [buying, setBuying] = useState(false)
    const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null)
    const [lowBalance, setLowBalance] = useState(false)
    const [delivered, setDelivered] = useState<Voucher[] | null>(null)
    const [copied, setCopied] = useState<string | null>(null)

    const load = async () => {
        try {
            const res = await fetch('/api/dashboard/sub/rc')
            const data = await res.json()
            if (!res.ok) {
                setMsg({ type: 'err', text: data.error || 'Failed to load' })
                setAvailable(false)
            } else {
                setAvailable(!!data.available)
                setReason(data.reason || null)
                setTypes(data.types || [])
                setParentShopName(data.parentShopName || '')
                setWalletBalance(data.walletBalance || 0)
                setOrders(data.orders || [])
            }
        } catch {
            setMsg({ type: 'err', text: 'Network error. Please try again.' })
        } finally {
            setLoading(false)
        }
    }

    useEffect(() => { load() }, [])

    const total = selected ? selected.price * qty : 0

    const handlePreBuy = () => {
        setMsg(null)
        setLowBalance(false)
        if (!selected) { setMsg({ type: 'err', text: 'Select a voucher type' }); return }
        if (qty > selected.stock) {
            setMsg({ type: 'err', text: `Only ${selected.stock} in stock.` })
            return
        }
        if (walletBalance < total) {
            setLowBalance(true)
            setMsg({ type: 'err', text: 'Your wallet balance is not enough for this purchase.' })
            return
        }
        setShowConfirm(true)
    }

    const handleConfirmedBuy = async () => {
        if (!selected) return
        setBuying(true)
        setMsg(null)
        try {
            const res = await fetch('/api/dashboard/sub/rc', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ typeId: selected.id, quantity: qty }),
            })
            const data = await res.json()

            if (!res.ok) {
                if (data.error === 'INSUFFICIENT_BALANCE') {
                    setLowBalance(true)
                    setMsg({ type: 'err', text: 'Your wallet balance is not enough for this purchase.' })
                } else {
                    setMsg({ type: 'err', text: data.error || 'Purchase failed' })
                }
                setShowConfirm(false)
                return
            }

            setDelivered(data.vouchers || [])
            setShowConfirm(false)
            setSelected(null)
            setQty(1)
            await load()
        } catch {
            setMsg({ type: 'err', text: 'Network error. Please try again.' })
            setShowConfirm(false)
        } finally {
            setBuying(false)
        }
    }

    const copy = async (text: string, key: string) => {
        try {
            await navigator.clipboard.writeText(text)
            setCopied(key)
            setTimeout(() => setCopied(null), 1500)
        } catch { /* clipboard unavailable — the code is still on screen */ }
    }

    if (loading) {
        return <div className="max-w-2xl mx-auto p-4 py-16 text-center text-gray-500 dark:text-gray-400">Loading…</div>
    }

    return (
        <div className="max-w-2xl mx-auto p-4 space-y-4">
            <div>
                <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">Results Checker</h1>
                <p className="text-sm text-gray-600 dark:text-gray-400 mt-0.5">
                    Buy WAEC and BECE voucher PINs. Charged to your wallet, delivered instantly.
                </p>
            </div>

            {/* Voucher reveal — this IS the delivery, so it is the first thing shown */}
            {delivered && (
                <div className="bg-white dark:bg-gray-900 rounded-lg shadow border-2 border-green-500 p-4 space-y-3">
                    <div className="flex items-center justify-between">
                        <h2 className="font-bold text-green-700 dark:text-green-400">
                            {delivered.length} voucher{delivered.length > 1 ? 's' : ''} purchased
                        </h2>
                        <button
                            onClick={() => setDelivered(null)}
                            className="text-sm font-semibold text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
                        >
                            Done
                        </button>
                    </div>
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                        Also sent to your email. You can find these again under My Purchases below.
                    </p>
                    {delivered.map((v, i) => (
                        <div key={i} className="rounded-lg bg-gray-50 dark:bg-gray-800 p-3 space-y-1.5">
                            <div className="flex items-center justify-between gap-2">
                                <div className="min-w-0">
                                    <p className="text-[10px] font-bold uppercase text-gray-500 dark:text-gray-400">PIN</p>
                                    <p className="font-mono font-bold text-gray-900 dark:text-gray-100 break-all">{v.pin}</p>
                                </div>
                                <button
                                    onClick={() => copy(v.pin, `pin-${i}`)}
                                    className="shrink-0 px-3 py-1.5 rounded-md bg-blue-600 text-white text-xs font-semibold"
                                >
                                    {copied === `pin-${i}` ? 'Copied' : 'Copy'}
                                </button>
                            </div>
                            <div>
                                <p className="text-[10px] font-bold uppercase text-gray-500 dark:text-gray-400">Serial</p>
                                <p className="font-mono text-sm text-gray-700 dark:text-gray-300 break-all">{v.serial_number}</p>
                            </div>
                        </div>
                    ))}
                </div>
            )}

            {msg && (
                <div className={`rounded-lg px-4 py-3 text-sm ${msg.type === 'ok'
                    ? 'bg-green-50 dark:bg-green-900/20 text-green-800 dark:text-green-300'
                    : 'bg-red-50 dark:bg-red-900/20 text-red-800 dark:text-red-300'}`}>
                    {msg.text}
                    {lowBalance && <a href="/dashboard/sub" className="ml-2 underline font-semibold">Top up</a>}
                </div>
            )}

            {!available ? (
                <div className="bg-white dark:bg-gray-900 rounded-lg shadow p-8 text-center">
                    <p className="text-4xl mb-3">🎓</p>
                    <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100">Not available yet</h2>
                    <p className="text-gray-600 dark:text-gray-400 mt-2">
                        {reason || 'This service is not available to you right now.'}
                    </p>
                </div>
            ) : (
                <>
                    <div className="bg-white dark:bg-gray-900 rounded-lg shadow p-4">
                        <div className="flex items-center justify-between mb-3">
                            <h2 className="font-bold text-gray-900 dark:text-gray-100">Choose a voucher</h2>
                            <div className="text-right">
                                <p className="text-[10px] font-semibold uppercase text-gray-500 dark:text-gray-400">Wallet</p>
                                <p className="font-bold text-gray-900 dark:text-gray-100">₵{walletBalance.toFixed(2)}</p>
                            </div>
                        </div>
                        <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">Prices set by {parentShopName}</p>

                        <div className="grid grid-cols-2 gap-2">
                            {types.map(t => {
                                const out = t.stock === 0
                                const active = selected?.id === t.id
                                return (
                                    <button
                                        key={t.id}
                                        disabled={out}
                                        onClick={() => { setSelected(active ? null : t); setQty(1) }}
                                        className={`text-left p-3 rounded-lg border-2 transition-colors ${out
                                            ? 'border-gray-200 dark:border-gray-800 opacity-60 cursor-not-allowed'
                                            : active
                                                ? 'border-blue-600 bg-blue-50 dark:bg-blue-900/20'
                                                : 'border-gray-200 dark:border-gray-700 hover:border-gray-300'}`}
                                    >
                                        <p className="font-bold text-sm text-gray-900 dark:text-gray-100">{t.name}</p>
                                        <p className="text-sm font-semibold text-gray-700 dark:text-gray-300 mt-0.5">
                                            ₵{t.price.toFixed(2)}
                                        </p>
                                        <p className={`text-[10px] font-bold mt-1 ${out ? 'text-red-600' : 'text-green-600'}`}>
                                            {out ? 'Out of stock' : `${t.stock} in stock`}
                                        </p>
                                    </button>
                                )
                            })}
                        </div>
                    </div>

                    {selected && (
                        <div className="bg-white dark:bg-gray-900 rounded-lg shadow p-4 space-y-3">
                            <div className="flex items-center justify-between">
                                <span className="text-sm font-semibold text-gray-700 dark:text-gray-300">Quantity</span>
                                <div className="flex items-center gap-3">
                                    <button
                                        onClick={() => setQty(q => Math.max(1, q - 1))}
                                        className="w-9 h-9 rounded-full border border-gray-300 dark:border-gray-700 font-bold text-gray-700 dark:text-gray-300"
                                    >−</button>
                                    <span className="w-6 text-center font-bold text-lg text-gray-900 dark:text-gray-100">{qty}</span>
                                    <button
                                        onClick={() => setQty(q => Math.min(10, Math.min(selected.stock, q + 1)))}
                                        className="w-9 h-9 rounded-full border border-gray-300 dark:border-gray-700 font-bold text-gray-700 dark:text-gray-300"
                                    >+</button>
                                </div>
                            </div>
                            <div className="flex items-center justify-between border-t border-gray-100 dark:border-gray-800 pt-3">
                                <span className="text-sm font-semibold text-gray-700 dark:text-gray-300">Total</span>
                                <span className="text-2xl font-bold text-gray-900 dark:text-gray-100">₵{total.toFixed(2)}</span>
                            </div>
                            <button
                                onClick={handlePreBuy}
                                disabled={buying}
                                className="w-full py-3 rounded-lg bg-blue-600 text-white font-semibold hover:bg-blue-700 disabled:opacity-60"
                            >
                                Buy {qty} × {selected.name}
                            </button>
                        </div>
                    )}
                </>
            )}

            {orders.length > 0 && (
                <div className="bg-white dark:bg-gray-900 rounded-lg shadow divide-y divide-gray-100 dark:divide-gray-800">
                    <div className="px-4 py-3">
                        <h2 className="font-bold text-gray-900 dark:text-gray-100">My Purchases</h2>
                    </div>
                    {orders.map(o => (
                        <div key={o.id} className="px-4 py-3 flex items-center justify-between gap-3">
                            <div className="min-w-0">
                                <p className="font-semibold text-sm text-gray-900 dark:text-gray-100 truncate">
                                    {o.quantity} × {o.type_name}
                                </p>
                                <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">
                                    {new Date(o.created_at).toLocaleDateString()}
                                </p>
                            </div>
                            <div className="text-right shrink-0">
                                <span className={`inline-block text-[10px] font-bold uppercase px-2 py-0.5 rounded-full ${STATUS_STYLE[o.status] || STATUS_STYLE.pending}`}>
                                    {o.status}
                                </span>
                                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                                    ₵{Number(o.total_paid).toFixed(2)}
                                </p>
                            </div>
                        </div>
                    ))}
                </div>
            )}

            {showConfirm && selected && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
                    <div className="bg-white dark:bg-gray-900 rounded-lg shadow-xl max-w-sm w-full p-5 space-y-4">
                        <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100">Confirm purchase</h2>
                        <div className="rounded-lg bg-gray-50 dark:bg-gray-800 px-4 py-3 space-y-1.5">
                            <div className="flex justify-between text-sm">
                                <span className="text-gray-600 dark:text-gray-400">{selected.name}</span>
                                <span className="font-semibold text-gray-900 dark:text-gray-100">× {qty}</span>
                            </div>
                            <div className="flex justify-between border-t border-gray-200 dark:border-gray-700 pt-1.5">
                                <span className="text-sm font-semibold text-gray-700 dark:text-gray-300">Charged to wallet</span>
                                <span className="font-bold text-gray-900 dark:text-gray-100">₵{total.toFixed(2)}</span>
                            </div>
                        </div>
                        <p className="text-xs text-gray-500 dark:text-gray-400">
                            Voucher PINs are delivered immediately and cannot be returned once issued.
                        </p>
                        <div className="flex gap-2">
                            <button
                                onClick={() => setShowConfirm(false)}
                                disabled={buying}
                                className="flex-1 py-2.5 rounded-lg border border-gray-300 dark:border-gray-700 font-semibold text-gray-700 dark:text-gray-300 disabled:opacity-60"
                            >
                                Back
                            </button>
                            <button
                                onClick={handleConfirmedBuy}
                                disabled={buying}
                                className="flex-1 py-2.5 rounded-lg bg-blue-600 text-white font-semibold hover:bg-blue-700 disabled:opacity-60"
                            >
                                {buying ? 'Buying…' : 'Confirm & Pay'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    )
}
