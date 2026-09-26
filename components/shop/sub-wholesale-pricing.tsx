'use client'

/**
 * Wholesale pricing — what your sub-agents PAY you.
 *
 * Distinct from retail pricing, which is what your own customers pay. They are
 * two different numbers on the same shop_pricing row:
 *
 *   selling_price  what a customer buying from YOUR storefront pays
 *   sub_price      what a sub-agent below you pays   ← this screen
 *
 * Your sub keeps whatever they add on top of sub_price, so the gap between your
 * cost and the price set here is what you earn per downline sale.
 *
 * There is a floor and no ceiling. The old ceiling was your own retail price,
 * which quietly bricked the screen for anyone selling on a thin retail margin:
 * retail at cost + ₵0.50 against a ₵0.50 minimum wholesale margin puts the
 * floor and the ceiling on the same pesewa, so every value but one was rejected
 * — and because Save merely greyed itself out, it looked like the price simply
 * would not save. You may now charge a downline more than your shelf price;
 * selling to someone who resells is not the same trade as selling to a walk-in.
 *
 * Whatever is set here becomes the sub's cost, and their own pricing screen
 * floors them at that cost plus the minimum margin, so they can never be pushed
 * into selling underwater — that is what `theirRoom` reports.
 *
 * Mounted by both portals — a Lead pricing their subs, and a level-1 sub
 * pricing their own recruits. /api/shop/sub-pricing resolves the caller's cost
 * through the chain, so a sub is floored at what they pay their own Lead rather
 * than at the platform price.
 */

import { useEffect, useState } from 'react'
// Same floor the level below is held to, so "their room" is the real number
// rather than this screen's guess at it.
import { subFloorFor } from '@/lib/sub-pricing-context'

interface Item {
    packageId: string
    network: string
    size: string
    /** What the caller pays for this package. */
    myCost: number
    /** The caller's own retail price. Context for the sub's margin, not a cap. */
    myPrice: number
    /** myCost plus the platform minimum margin. */
    minPrice: number
    currentSubPrice: number | null
}

export default function SubWholesalePricing({ backHref }: { backHref?: string }) {
    const [items, setItems] = useState<Item[]>([])
    const [prices, setPrices] = useState<Record<string, string>>({})
    const [minMargin, setMinMargin] = useState(0.5)
    const [loading, setLoading] = useState(true)
    const [saving, setSaving] = useState(false)
    const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null)
    const [blocked, setBlocked] = useState<string | null>(null)

    useEffect(() => {
        ;(async () => {
            try {
                const res = await fetch('/api/shop/sub-pricing')
                const data = await res.json()
                if (!res.ok) {
                    // 403/404 here means "you may not price a downline" — not a
                    // crash. Say which, rather than showing an empty table.
                    setBlocked(data.error || 'Could not load wholesale pricing')
                    return
                }
                const list: Item[] = data.items || []
                setItems(list)
                setMinMargin(data.minMargin ?? 0.5)
                setPrices(
                    Object.fromEntries(
                        list.map((it) => [
                            it.packageId,
                            it.currentSubPrice != null ? String(it.currentSubPrice) : '',
                        ])
                    )
                )
            } catch {
                setBlocked('Something went wrong')
            } finally {
                setLoading(false)
            }
        })()
    }, [])

    /**
     * Why a row cannot be saved, or null when it can.
     *
     * Blank is valid and meaningful: readers fall back to the retail price.
     * The only rule left is the floor — the platform's minimum margin over what
     * this package costs you.
     */
    const rejection = (it: Item): string | null => {
        const raw = prices[it.packageId]
        if (raw === '' || raw == null) return null
        const v = parseFloat(raw)
        if (!Number.isFinite(v)) return 'Enter an amount, or leave it blank.'
        if (v < it.minPrice) {
            return `At least ₵${it.minPrice.toFixed(2)} — you pay ₵${it.myCost.toFixed(
                2
            )} plus the ₵${minMargin.toFixed(2)} minimum margin.`
        }
        return null
    }

    const save = async () => {
        // Never fail silently. The button used to disable itself the moment any
        // row was out of bounds, so a rejected price looked like a dead Save.
        const rejected = items
            .map((it) => ({ it, why: rejection(it) }))
            .filter((row): row is { it: Item; why: string } => row.why !== null)

        if (rejected.length > 0) {
            const { it, why } = rejected[0]
            setMsg({
                type: 'err',
                text:
                    rejected.length === 1
                        ? `${it.network} · ${it.size}: ${why}`
                        : `${rejected.length} prices are too low, starting with ${it.network} · ${it.size}: ${why}`,
            })
            return
        }

        setSaving(true)
        setMsg(null)
        try {
            const res = await fetch('/api/shop/sub-pricing', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    items: items.map((it) => {
                        const raw = prices[it.packageId]
                        return {
                            packageId: it.packageId,
                            subPrice: raw === '' || raw == null ? null : parseFloat(raw),
                        }
                    }),
                }),
            })
            const data = await res.json()
            if (!res.ok) setMsg({ type: 'err', text: data.error || 'Could not save' })
            else setMsg({ type: 'ok', text: 'Sub-agent prices saved.' })
        } catch {
            setMsg({ type: 'err', text: 'Something went wrong' })
        } finally {
            setSaving(false)
        }
    }

    if (loading) {
        return (
            <div className="max-w-3xl mx-auto p-4 py-16 text-center text-gray-500 dark:text-gray-400">
                Loading…
            </div>
        )
    }

    if (blocked) {
        return (
            <div className="max-w-2xl mx-auto p-4">
                <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-6 text-center">
                    <p className="text-4xl mb-3">🔒</p>
                    <h1 className="text-lg font-bold text-yellow-900">Sub-agent pricing unavailable</h1>
                    <p className="text-yellow-800 text-sm mt-1">{blocked}</p>
                </div>
            </div>
        )
    }

    if (items.length === 0) {
        return (
            <div className="max-w-2xl mx-auto p-4">
                <div className="bg-white dark:bg-gray-900 rounded-lg shadow p-8 text-center">
                    <p className="text-4xl mb-3">🏷️</p>
                    <h1 className="text-lg font-bold text-gray-900 dark:text-gray-100">
                        Set your own prices first
                    </h1>
                    <p className="text-gray-600 dark:text-gray-400 mt-1">
                        You need retail prices on your shop before you can decide what your
                        sub-agents pay for the same packages.
                    </p>
                </div>
            </div>
        )
    }

    return (
        <div className="max-w-3xl mx-auto p-4 space-y-4">
            <div>
                <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Sub-agent prices</h1>
                <p className="text-gray-600 dark:text-gray-400 mt-1">
                    What your sub-agents pay you for each bundle. You keep the difference
                    between your own cost and this price; they keep whatever they add on top
                    when they resell.
                </p>
                <p className="text-gray-500 dark:text-gray-500 text-sm mt-2">
                    At least ₵{minMargin.toFixed(2)} above your cost. You may go above your own
                    selling price — your sub then prices from what they pay you, not from your
                    shelf. Leave blank to charge them your retail price.
                </p>
            </div>

            {msg && (
                <div
                    className={`rounded-lg p-3 text-sm ${
                        msg.type === 'ok'
                            ? 'bg-green-50 border border-green-200 text-green-800 dark:bg-green-900/20 dark:border-green-900 dark:text-green-300'
                            : 'bg-red-50 border border-red-200 text-red-800 dark:bg-red-900/20 dark:border-red-900 dark:text-red-300'
                    }`}
                >
                    {msg.text}
                </div>
            )}

            <div className="space-y-2">
                {items.map((it) => {
                    const raw = prices[it.packageId]
                    const v = parseFloat(raw || '')
                    const myProfit = Number.isFinite(v) ? v - it.myCost : 0
                    // The margin your sub is guaranteed: their own screen floors
                    // them at subFloorFor(), so the gap between that floor and
                    // what they pay you is the least they can make per sale.
                    const theirRoom = Number.isFinite(v)
                        ? subFloorFor(it.myPrice, v, minMargin) - v
                        : 0
                    const why = rejection(it)
                    const aboveRetail = Number.isFinite(v) && !why && v > it.myPrice

                    return (
                        <div
                            key={it.packageId}
                            className="bg-white dark:bg-gray-900 rounded-lg shadow p-4"
                        >
                            <div className="flex items-center gap-4">
                                <div className="min-w-0 flex-1">
                                    <p className="font-semibold text-gray-900 dark:text-gray-100">
                                        {it.network} · {it.size}
                                    </p>
                                    <p className="text-xs text-gray-500 dark:text-gray-400">
                                        You pay ₵{it.myCost.toFixed(2)} · you sell at ₵{it.myPrice.toFixed(2)}
                                    </p>
                                </div>
                                <div className="w-28 shrink-0">
                                    <div className="relative">
                                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">
                                            ₵
                                        </span>
                                        <input
                                            type="number"
                                            step="0.01"
                                            min={it.minPrice}
                                            placeholder={it.myPrice.toFixed(2)}
                                            value={raw ?? ''}
                                            onChange={(e) =>
                                                setPrices((p) => ({ ...p, [it.packageId]: e.target.value }))
                                            }
                                            className={`w-full pl-6 pr-2 py-2 rounded-lg border text-right focus:ring-2 focus:outline-none dark:bg-gray-800 dark:text-gray-100 ${
                                                why
                                                    ? 'border-red-400 focus:ring-red-400'
                                                    : 'border-gray-300 dark:border-gray-700 focus:ring-blue-500'
                                            }`}
                                        />
                                    </div>
                                </div>
                                <div className="w-24 shrink-0 text-right">
                                    <p className="text-xs text-gray-500 dark:text-gray-400">You earn</p>
                                    <p
                                        className={`font-bold ${
                                            myProfit > 0
                                                ? 'text-green-600 dark:text-green-400'
                                                : 'text-gray-500 dark:text-gray-400'
                                        }`}
                                    >
                                        ₵{(myProfit > 0 ? myProfit : 0).toFixed(2)}
                                    </p>
                                    <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-0.5">
                                        their room ₵{(theirRoom > 0 ? theirRoom : 0).toFixed(2)}
                                    </p>
                                </div>
                            </div>

                            {/* Say it on the row itself. A red outline alone never
                                explained which bound was missed. */}
                            {why && (
                                <p className="text-xs text-red-600 dark:text-red-400 mt-2">{why}</p>
                            )}
                            {aboveRetail && (
                                <p className="text-xs text-amber-600 dark:text-amber-400 mt-2">
                                    Above your own ₵{it.myPrice.toFixed(2)} — your sub-agents pay more
                                    for this bundle than your storefront customers do, and will sell it
                                    from ₵{subFloorFor(it.myPrice, v, minMargin).toFixed(2)} up.
                                </p>
                            )}
                        </div>
                    )
                })}
            </div>

            <div className="sticky bottom-0 py-3 bg-gray-50 dark:bg-gray-950 flex gap-3">
                {backHref && (
                    <a
                        href={backHref}
                        className="px-5 py-3 rounded-lg border border-gray-300 dark:border-gray-700 font-semibold text-gray-700 dark:text-gray-200 text-center"
                    >
                        Back
                    </a>
                )}
                <button
                    onClick={save}
                    disabled={saving}
                    className="flex-1 px-5 py-3 rounded-lg bg-blue-600 text-white font-semibold hover:bg-blue-700 disabled:opacity-50"
                >
                    {saving ? 'Saving…' : 'Save sub-agent prices'}
                </button>
            </div>
        </div>
    )
}
