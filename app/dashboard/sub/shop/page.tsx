'use client'

/**
 * Sub-Agent "My Shop" — self-service storefront creation & management.
 * If the sub has no shop, shows a create form (name, storefront link, phone)
 * that POSTs to /api/shop/profile (auto-approved). Once created, shows the
 * same shop Overview an owner gets (app/dashboard/shop/page.tsx).
 */

import { useEffect, useState } from 'react'
import { useAuth } from '@/contexts/auth-context'
import ShopOverviewPage from '@/app/dashboard/shop/page'

interface Shop {
  shop_name: string
  shop_slug: string
  approval_status: string
  is_active: boolean
}

const slugify = (s: string) =>
  s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)

export default function SubShopPage() {
  const { dbUser } = useAuth()
  const [shop, setShop] = useState<Shop | null>(null)
  const [loading, setLoading] = useState(true)
  // Is the caller actually a sub-agent? A Lead who lands here (e.g. still signed
  // in on a recruit's phone) would otherwise see their OWN main shop rendered as
  // "your storefront" — which reads as "a shop already exists for me".
  const [isSubAgent, setIsSubAgent] = useState<boolean | null>(null)
  // Set only when we could NOT determine whether a shop exists. Kept separate
  // from `shop === null` so a failed check never masquerades as "no shop yet"
  // and offers to create a second one.
  const [loadError, setLoadError] = useState<string | null>(null)

  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [slugEdited, setSlugEdited] = useState(false)
  const [phone, setPhone] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const origin = typeof window !== 'undefined' ? window.location.origin : 'https://arhmsgh.com'

  // Reads through /api/shop/profile (service role) rather than the browser
  // Supabase client, so an expired token or RLS hiccup surfaces as an error to
  // retry instead of an empty create form.
  const loadShop = async () => {
    setLoadError(null)
    try {
      const res = await fetch('/api/shop/profile', { cache: 'no-store' })
      const data = await res.json().catch(() => null)
      if (!res.ok) {
        setShop(null)
        setLoadError(data?.error || 'Could not load your shop. Please try again.')
        return null
      }
      setShop((data?.shop as Shop) || null)
      return (data?.shop as Shop) || null
    } catch {
      setShop(null)
      setLoadError('Could not load your shop. Check your connection and try again.')
      return null
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadShop()
  }, [])

  useEffect(() => {
    // 403 is the only answer that means "not a sub-agent". Anything else fails
    // open so a blip never hides a real sub-agent's own shop.
    fetch('/api/dashboard/sub/data', { cache: 'no-store' })
      .then((r) => setIsSubAgent(r.status !== 403))
      .catch(() => setIsSubAgent(true))
  }, [])

  // Prefilling the contact phone is a convenience — the shop check above no
  // longer waits on the auth profile to resolve.
  useEffect(() => {
    const p = (dbUser as any)?.phone_number
    if (p) setPhone(String(p))
  }, [dbUser])

  const onName = (v: string) => {
    setName(v)
    if (!slugEdited) setSlug(slugify(v))
  }

  const create = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    if (!name.trim()) return setError('Enter a shop name')
    if (slug.length < 3) return setError('Storefront link must be at least 3 characters')
    if (!/^0\d{9}$/.test(phone)) return setError('Enter a valid phone (0XXXXXXXXX)')

    setSaving(true)
    try {
      const res = await fetch('/api/shop/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shop_name: name.trim(), shop_slug: slug, owner_phone: phone }),
      })
      const data = await res.json().catch(() => null)

      // The shop already exists (this form was shown after a failed check, or the
      // submit was double-tapped). That's not an error for the user — show it.
      if (res.status === 409 && data?.alreadyExists) {
        await loadShop()
        setSaving(false)
        return
      }

      if (!res.ok) {
        setError(data?.details?.[0] || data?.error || 'Could not create shop')
        setSaving(false)
        return
      }

      // Shop created — stay in the de-branded portal and show the manage view.
      // If the read-back fails we still have everything needed to render it, so
      // a flaky follow-up request can't make the new shop look like it vanished.
      const reloaded = await loadShop()
      if (!reloaded) {
        setShop({
          shop_name: name.trim(),
          shop_slug: data?.shopSlug || slug,
          approval_status: 'approved',
          is_active: true,
        })
        setLoadError(null)
      }
    } catch {
      setError('Something went wrong')
    } finally {
      setSaving(false)
    }
  }

  const inputCls =
    'w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none dark:bg-gray-800 dark:border-gray-700 dark:text-gray-100'
  const labelCls = 'block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2'
  const btnOutline =
    'px-5 py-2 rounded-lg border border-gray-300 dark:border-gray-700 font-semibold text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800'

  if (loading || isSubAgent === null) {
    return <div className="max-w-2xl mx-auto p-4 text-center text-gray-500 dark:text-gray-400 py-16">Loading…</div>
  }

  // ── Not a sub-agent ───────────────────────────────────────────────────
  if (isSubAgent === false) {
    return (
      <div className="max-w-2xl mx-auto p-4 space-y-4">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">My Shop</h1>
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 text-yellow-900 text-sm">
          This page belongs to the sub-agent portal, and this account is not a sub-agent.
          If you are setting up a new sub-agent on this phone, sign out first and log in as them.
        </div>
        <a
          href="/dashboard/shop"
          className="inline-block px-5 py-2 rounded-lg bg-blue-600 text-white font-semibold hover:bg-blue-700"
        >
          Go to my shop
        </a>
      </div>
    )
  }

  // ── Couldn't check ────────────────────────────────────────────────────
  // Never fall through to the create form here: if the sub already has a shop,
  // offering to create one again loses their storefront in the UI and dead-ends
  // on a conflict when they submit.
  if (loadError) {
    return (
      <div className="max-w-2xl mx-auto p-4 space-y-4">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">My Shop</h1>
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 text-yellow-900 text-sm">
          {loadError}
        </div>
        <button
          onClick={() => { setLoading(true); loadShop() }}
          className="px-5 py-2 rounded-lg bg-blue-600 text-white font-semibold hover:bg-blue-700"
        >
          Try again
        </button>
      </div>
    )
  }

  // ── Manage existing shop ──────────────────────────────────────────────
  // Same overview a shop owner gets; its pricing / USSD / withdraw / recruit
  // links switch to the sub-agent versions for a sub-agent.
  if (shop) {
    return <ShopOverviewPage />
  }

  // ── Create shop ───────────────────────────────────────────────────────
  return (
    <div className="max-w-2xl mx-auto p-4 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Create your shop</h1>
        <p className="text-gray-600 dark:text-gray-400 mt-1">
          Start with the basics — next you'll add your logo, colours, description
          and contacts. You can sell data & airtime to your own customers.
        </p>
      </div>

      <form onSubmit={create} className="bg-white dark:bg-gray-900 rounded-lg shadow p-6 space-y-4">
        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-red-800 text-sm">{error}</div>
        )}

        <div>
          <label className={labelCls}>Shop name</label>
          <input value={name} onChange={(e) => onName(e.target.value)} placeholder="e.g. Derrick Data Hub" className={inputCls} />
        </div>

        <div>
          <label className={labelCls}>Storefront link</label>
          <div className="flex items-center gap-1">
            <span className="text-sm text-gray-500 dark:text-gray-400 whitespace-nowrap">{origin}/shop/</span>
            <input
              value={slug}
              onChange={(e) => {
                setSlugEdited(true)
                setSlug(slugify(e.target.value))
              }}
              placeholder="derrick-data"
              className={inputCls}
            />
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">Lowercase letters, numbers and hyphens only.</p>
        </div>

        <div>
          <label className={labelCls}>Contact phone</label>
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value.replace(/\D/g, ''))}
            placeholder="0XXXXXXXXX"
            className={inputCls}
          />
        </div>

        <button
          type="submit"
          disabled={saving}
          className="w-full px-5 py-2.5 rounded-lg bg-blue-600 text-white font-semibold hover:bg-blue-700 disabled:opacity-50"
        >
          {saving ? 'Creating…' : 'Create my storefront'}
        </button>
      </form>
    </div>
  )
}
