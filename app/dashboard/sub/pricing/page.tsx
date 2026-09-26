'use client'

/**
 * Sub-Agent pricing engine (de-branded).
 *
 * The sub sets what their OWN storefront charges for each product, bounded by
 * the level directly above them: floor = that parent's retail price, cap =
 * parent price + the sub's markup ceiling.
 *
 * Data carries one extra rule. What a sub PAYS for a bundle is their parent's
 * wholesale sub_price, which the parent may set above their own retail price —
 * so the data floor is whichever is higher, the parent's shelf price or this
 * sub's cost plus the minimum margin. The server sends that as `minPrice`
 * rather than having this screen re-derive it.
 *
 * All three products live here — data, Results Checker and AFA — because all
 * three tiles only render on a storefront that has priced them. Saving marks
 * the shop's pricing approved server-side, so the storefront goes live at once
 * rather than showing "Under Review".
 *
 * Nothing here is level-specific: the parent is resolved from the caller's own
 * membership row, so a level-2 sub prices against their level-1 recruiter
 * exactly as a level-1 sub prices against their Lead.
 */

import { useEffect, useState } from 'react'

interface DataItem {
  packageId: string
  network: string
  size: string
  parentPrice: number
  /** What this sub is charged per order — their parent's wholesale price. */
  myCost: number
  /** Lowest price they may set: above the parent's shelf AND above their cost. */
  minPrice: number
  maxPrice: number
  currentPrice: number | null
}

interface RcItem {
  rcTypeId: string
  name: string
  parentPrice: number
  maxPrice: number
  currentPrice: number | null
}

interface AfaPricing {
  parentPrice: number
  maxPrice: number
  currentPrice: number | null
  noParentPricing?: boolean
}

type Tab = 'data' | 'rc' | 'afa'
type Message = { type: 'ok' | 'err'; text: string } | null

const round2 = (value: number) => Math.round(value * 100) / 100

/** Why a price is out of bounds, or null when it is fine. */
function priceRejection(value: string, myCost: number, minPrice: number, maxPrice: number) {
  const val = parseFloat(value || '')
  if (!Number.isFinite(val)) return 'Enter a price.'
  if (val < minPrice) {
    return val < myCost
      ? `You pay ₵${myCost.toFixed(2)} for this — selling at ₵${val.toFixed(2)} loses money. Minimum ₵${minPrice.toFixed(2)}.`
      : `Minimum ₵${minPrice.toFixed(2)}.`
  }
  if (val > maxPrice) return `Maximum ₵${maxPrice.toFixed(2)}.`
  return null
}

/** Shared row: a product, its bounds, a price input and the resulting profit. */
function PriceRow({
  title,
  myCost,
  minPrice,
  maxPrice,
  value,
  onChange,
}: {
  title: string
  myCost: number
  minPrice: number
  maxPrice: number
  value: string
  onChange: (next: string) => void
}) {
  const val = parseFloat(value || '0')
  // Profit is measured from what this sub actually pays, which is not always
  // the parent's shelf price once the parent sets a wholesale price.
  const profit = Number.isFinite(val) ? val - myCost : 0
  const why = priceRejection(value, myCost, minPrice, maxPrice)

  return (
    <div className="bg-white dark:bg-gray-900 rounded-lg shadow p-4">
      <div className="flex items-center gap-4">
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-gray-900 dark:text-gray-100">{title}</p>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            You pay ₵{myCost.toFixed(2)} · sell ₵{minPrice.toFixed(2)}–₵{maxPrice.toFixed(2)}
          </p>
        </div>
        <div className="w-28 shrink-0">
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">₵</span>
            <input
              type="number"
              step="0.01"
              min={minPrice}
              max={maxPrice}
              value={value ?? ''}
              onChange={(e) => onChange(e.target.value)}
              className={`w-full pl-6 pr-2 py-2 rounded-lg border text-right focus:ring-2 focus:outline-none dark:bg-gray-800 dark:text-gray-100 ${
                why
                  ? 'border-red-400 focus:ring-red-400'
                  : 'border-gray-300 dark:border-gray-700 focus:ring-blue-500'
              }`}
            />
          </div>
        </div>
        <div className="w-20 shrink-0 text-right">
          <p className="text-xs text-gray-500 dark:text-gray-400">Profit</p>
          <p
            className={`font-bold ${
              profit > 0 ? 'text-green-600 dark:text-green-400' : 'text-gray-500 dark:text-gray-400'
            }`}
          >
            ₵{(profit > 0 ? profit : 0).toFixed(2)}
          </p>
        </div>
      </div>
      {why && <p className="text-xs text-red-600 dark:text-red-400 mt-2">{why}</p>}
    </div>
  )
}

function EmptyState({ icon, title, body }: { icon: string; title: string; body: string }) {
  return (
    <div className="bg-white dark:bg-gray-900 rounded-lg shadow p-8 text-center">
      <p className="text-4xl mb-3">{icon}</p>
      <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100">{title}</h2>
      <p className="text-gray-600 dark:text-gray-400 mt-1">{body}</p>
    </div>
  )
}

export default function SubPricingPage() {
  const [tab, setTab] = useState<Tab>('data')
  const [ceiling, setCeiling] = useState(0)
  const [needsShop, setNeedsShop] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<Message>(null)

  const [items, setItems] = useState<DataItem[]>([])
  const [prices, setPrices] = useState<Record<string, string>>({})

  const [rcItems, setRcItems] = useState<RcItem[]>([])
  const [rcPrices, setRcPrices] = useState<Record<string, string>>({})

  const [afa, setAfa] = useState<AfaPricing | null>(null)
  const [afaPrice, setAfaPrice] = useState('')

  useEffect(() => {
    ;(async () => {
      try {
        // One trip per product. A missing Results Checker or AFA price on the
        // parent is normal, so a failure in either must not blank the page.
        const [dataRes, rcRes, afaRes] = await Promise.all([
          fetch('/api/dashboard/sub/pricing').then((r) => r.json().then((d) => ({ ok: r.ok, d }))),
          fetch('/api/dashboard/sub/rc-pricing').then((r) => r.json().then((d) => ({ ok: r.ok, d }))).catch(() => null),
          fetch('/api/dashboard/sub/afa-pricing').then((r) => r.json().then((d) => ({ ok: r.ok, d }))).catch(() => null),
        ])

        if (!dataRes.ok) {
          setMsg({ type: 'err', text: dataRes.d.error || 'Failed to load pricing' })
        } else {
          setNeedsShop(!!dataRes.d.needsShop)
          setCeiling(dataRes.d.ceiling || 0)
          const list: DataItem[] = dataRes.d.items || []
          setItems(list)
          // Seed at the floor, not at the parent's price: the parent's price is
          // itself out of bounds, so seeding there left every row red and the
          // Save button disabled before the sub had touched anything.
          setPrices(
            Object.fromEntries(list.map((it) => [it.packageId, String(it.currentPrice ?? it.minPrice)]))
          )
        }

        if (rcRes?.ok) {
          const list: RcItem[] = rcRes.d.items || []
          setRcItems(list)
          setRcPrices(
            Object.fromEntries(
              list.map((it) => [it.rcTypeId, String(it.currentPrice ?? round2(it.parentPrice + 0.01))])
            )
          )
        }

        if (afaRes?.ok && afaRes.d.parentPrice != null) {
          setAfa(afaRes.d)
          setAfaPrice(String(afaRes.d.currentPrice ?? round2(afaRes.d.parentPrice + 0.01)))
        }
      } catch {
        setMsg({ type: 'err', text: 'Something went wrong' })
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  const post = async (url: string, body: unknown, okText: string) => {
    setSaving(true)
    setMsg(null)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) setMsg({ type: 'err', text: data.error || 'Could not save' })
      else setMsg({ type: 'ok', text: okText })
    } catch {
      setMsg({ type: 'err', text: 'Something went wrong' })
    } finally {
      setSaving(false)
    }
  }

  const saveData = () =>
    post(
      '/api/dashboard/sub/pricing',
      {
        items: items.map((it) => ({
          packageId: it.packageId,
          sellingPrice: parseFloat(prices[it.packageId] || '0'),
        })),
      },
      'Prices saved — your storefront is live at these prices.'
    )

  const saveRc = () =>
    post(
      '/api/dashboard/sub/rc-pricing',
      {
        items: rcItems.map((it) => ({
          rcTypeId: it.rcTypeId,
          sellingPrice: parseFloat(rcPrices[it.rcTypeId] || '0'),
        })),
      },
      'Results Checker prices saved.'
    )

  const saveAfa = () =>
    post('/api/dashboard/sub/afa-pricing', { sellingPrice: parseFloat(afaPrice || '0') }, 'AFA price saved.')

  if (loading) {
    return <div className="max-w-3xl mx-auto p-4 py-16 text-center text-gray-500 dark:text-gray-400">Loading pricing…</div>
  }

  if (needsShop) {
    return (
      <div className="max-w-2xl mx-auto p-4">
        <div className="bg-white dark:bg-gray-900 rounded-lg shadow p-8 text-center">
          <p className="text-4xl mb-3">🏪</p>
          <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">Create your shop first</h1>
          <p className="text-gray-600 dark:text-gray-400 mt-1 mb-5">
            You need a storefront before you can set prices.
          </p>
          <a href="/dashboard/sub/shop" className="inline-block px-5 py-2.5 rounded-lg bg-blue-600 text-white font-semibold hover:bg-blue-700">
            Create my shop
          </a>
        </div>
      </div>
    )
  }

  const tabs: { id: Tab; label: string; count: number }[] = [
    { id: 'data', label: 'Data', count: items.length },
    { id: 'rc', label: 'Results Checker', count: rcItems.length },
    { id: 'afa', label: 'AFA', count: afa ? 1 : 0 },
  ]

  // Report the first bad row rather than disabling Save into silence — a greyed
  // button with no reason reads as "my price won't save".
  const firstRejection = (
    rows: { label: string; why: string | null }[]
  ): string | null => {
    const bad = rows.find((r) => r.why)
    return bad ? `${bad.label}: ${bad.why}` : null
  }

  const dataProblem = firstRejection(
    items.map((it) => ({
      label: `${it.network} · ${it.size}`,
      why: priceRejection(prices[it.packageId] ?? '', it.myCost, it.minPrice, it.maxPrice),
    }))
  )
  const rcProblem = firstRejection(
    rcItems.map((it) => ({
      label: it.name,
      why: priceRejection(
        rcPrices[it.rcTypeId] ?? '',
        it.parentPrice,
        round2(it.parentPrice + 0.01),
        it.maxPrice
      ),
    }))
  )
  const afaProblem = afa
    ? priceRejection(afaPrice, afa.parentPrice, round2(afa.parentPrice + 0.01), afa.maxPrice)
    : 'AFA is not available to price yet.'

  return (
    <div className="max-w-3xl mx-auto p-4 space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Set your prices</h1>
        <p className="text-gray-600 dark:text-gray-400 mt-1">
          Each item shows what you pay and the range you may sell it in — up to
          ₵{ceiling.toFixed(2)} of markup. Your profit is the difference.
        </p>
      </div>

      <div className="flex gap-1 bg-gray-100 dark:bg-gray-900 rounded-lg p-1">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex-1 px-3 py-2 rounded-md text-sm font-semibold transition-colors ${
              tab === t.id
                ? 'bg-white dark:bg-gray-800 text-blue-600 dark:text-blue-400 shadow-sm'
                : 'text-gray-600 dark:text-gray-400'
            }`}
          >
            {t.label}
            {t.count > 0 && <span className="ml-1.5 text-xs opacity-60">{t.count}</span>}
          </button>
        ))}
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

      {tab === 'data' && (
        items.length === 0 ? (
          <EmptyState
            icon="⏳"
            title="No packages to price yet"
            body="Your Lead hasn't published prices you can resell yet. Check back soon."
          />
        ) : (
          <>
            <div className="space-y-2">
              {items.map((it) => (
                <PriceRow
                  key={it.packageId}
                  title={`${it.network} · ${it.size}`}
                  myCost={it.myCost}
                  minPrice={it.minPrice}
                  maxPrice={it.maxPrice}
                  value={prices[it.packageId] ?? ''}
                  onChange={(next) => setPrices((p) => ({ ...p, [it.packageId]: next }))}
                />
              ))}
            </div>
            <div className="sticky bottom-0 py-3 bg-gray-50 dark:bg-gray-950">
              <button
                onClick={() => (dataProblem ? setMsg({ type: 'err', text: dataProblem }) : saveData())}
                disabled={saving}
                className="w-full px-5 py-3 rounded-lg bg-blue-600 text-white font-semibold hover:bg-blue-700 disabled:opacity-50"
              >
                {saving ? 'Saving…' : 'Save prices'}
              </button>
            </div>
          </>
        )
      )}

      {tab === 'rc' && (
        rcItems.length === 0 ? (
          <EmptyState
            icon="🎓"
            title="No result checkers to price"
            body="Your Lead hasn't priced any Results Checker vouchers yet, so there's nothing to resell."
          />
        ) : (
          <>
            <div className="space-y-2">
              {rcItems.map((it) => (
                <PriceRow
                  key={it.rcTypeId}
                  title={it.name}
                  myCost={it.parentPrice}
                  minPrice={round2(it.parentPrice + 0.01)}
                  maxPrice={it.maxPrice}
                  value={rcPrices[it.rcTypeId] ?? ''}
                  onChange={(next) => setRcPrices((p) => ({ ...p, [it.rcTypeId]: next }))}
                />
              ))}
            </div>
            <div className="sticky bottom-0 py-3 bg-gray-50 dark:bg-gray-950">
              <button
                onClick={() => (rcProblem ? setMsg({ type: 'err', text: rcProblem }) : saveRc())}
                disabled={saving}
                className="w-full px-5 py-3 rounded-lg bg-blue-600 text-white font-semibold hover:bg-blue-700 disabled:opacity-50"
              >
                {saving ? 'Saving…' : 'Save Results Checker prices'}
              </button>
            </div>
          </>
        )
      )}

      {tab === 'afa' && (
        !afa ? (
          <EmptyState
            icon="🪪"
            title="AFA registration not available"
            body="Your Lead hasn't priced AFA registration yet, so there's nothing to resell."
          />
        ) : (
          <>
            <div className="space-y-2">
              <PriceRow
                title="AFA Registration"
                myCost={afa.parentPrice}
                minPrice={round2(afa.parentPrice + 0.01)}
                maxPrice={afa.maxPrice}
                value={afaPrice}
                onChange={setAfaPrice}
              />
            </div>
            <div className="sticky bottom-0 py-3 bg-gray-50 dark:bg-gray-950">
              <button
                onClick={() => (afaProblem ? setMsg({ type: 'err', text: afaProblem }) : saveAfa())}
                disabled={saving}
                className="w-full px-5 py-3 rounded-lg bg-blue-600 text-white font-semibold hover:bg-blue-700 disabled:opacity-50"
              >
                {saving ? 'Saving…' : 'Save AFA price'}
              </button>
            </div>
          </>
        )
      )}
    </div>
  )
}
