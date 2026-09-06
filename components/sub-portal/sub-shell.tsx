'use client'

/**
 * Sub-Agent Portal shell — teal header + sidebar chrome around every
 * /dashboard/sub/* page. De-branded (no ARHMS chrome). Follows the phone's
 * light/dark preference via next-themes `system`.
 */

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useTheme } from 'next-themes'
import { useAuth } from '@/contexts/auth-context'
import type { BrandConfig } from '@/lib/brand-context'
import { usePageAccess } from '@/hooks/use-page-access'
import {
  LayoutDashboard,
  ShoppingCart,
  ShoppingBag,
  Store,
  Smartphone,
  BadgeCheck,
  GraduationCap,
  ClipboardList,
  Crown,
  Tag,
  Receipt,
  User,
  Download,
  ExternalLink,
  LogOut,
  Menu,
  X,
} from 'lucide-react'

// Portal brand colour for the header + sidebar chrome.
const TEAL = '#1a6c78'
const TEAL_DARK = '#155963'

const NAV = [
  { href: '/dashboard/sub', label: 'Dashboard', icon: LayoutDashboard, exact: true },
  { href: '/dashboard/sub/storefront-orders', label: 'Store Orders', icon: ClipboardList },
  { href: '/dashboard/sub/orders', label: 'My Orders', icon: ShoppingCart },
  { href: '/dashboard/sub/shop', label: 'My Shop', icon: Store },
  // Marketplace lives on its own subdomain (middleware.ts rewrites it onto
  // app/classifieds/*), so this entry leaves the portal in a new tab instead of
  // routing inside it — the installed portal PWA stays where the sub-agent left it.
  {
    href: process.env.NEXT_PUBLIC_MARKETPLACE_URL || 'https://marketplace.arhmsgh.com',
    label: 'Marketplace',
    icon: ShoppingBag,
    external: true,
  },
  // Recruiting. Hidden only from a level-2 sub — see recruitBlocked below.
  { href: '/dashboard/sub/sub-agents', label: 'My Sub-Agents', icon: Crown, recruitOnly: true },
  { href: '/dashboard/sub/ussd', label: 'USSD Code', icon: Smartphone },
  { href: '/dashboard/sub/afa', label: 'AFA Registration', icon: BadgeCheck },
  { href: '/dashboard/sub/rc', label: 'Results Checker', icon: GraduationCap },
  { href: '/dashboard/sub/pricing', label: 'Pricing', icon: Tag },
  { href: '/dashboard/sub/utilities', label: 'Bill Payments', icon: Receipt },
  { href: '/dashboard/sub/profile', label: 'Profile', icon: User },
  { href: '/dashboard/sub/install', label: 'Install App', icon: Download },
]

export function SubPortalShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const { dbUser, signOut } = useAuth()
  const { isPageAccessible } = usePageAccess()
  const { setTheme } = useTheme()
  const [open, setOpen] = useState(false)
  const [brand, setBrand] = useState<BrandConfig | null>(null)
  const [ownShopSlug, setOwnShopSlug] = useState<string | null>(null)
  // Hidden ONLY for a level-2 sub, who is the bottom of the network and can
  // never recruit. Everyone else sees the entry.
  //
  // This deliberately does not hide on membership status. A pending sub is
  // exactly the person exploring the portal, and hiding the feature from them
  // makes it undiscoverable rather than merely unavailable — they cannot tell
  // "not yet" from "not a thing". The page and /api/shop/invites both refuse a
  // sub who is not active, with a message that says why. Default false so a
  // slow or failed lookup shows the entry rather than swallowing it.
  const [recruitBlocked, setRecruitBlocked] = useState(false)

  // Follow the phone's light/dark setting inside the portal.
  useEffect(() => {
    setTheme('system')
  }, [setTheme])

  // Point the PWA manifest at the portal's own (shop-branded) manifest while in
  // the portal, so "install" produces a de-branded app scoped to /dashboard/sub.
  // Restore the app's default manifest on unmount.
  useEffect(() => {
    let link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]')
    const previous = link?.getAttribute('href') ?? null
    let created = false
    if (!link) {
      link = document.createElement('link')
      link.rel = 'manifest'
      document.head.appendChild(link)
      created = true
    }
    link.setAttribute('href', '/dashboard/sub/manifest.webmanifest')
    return () => {
      const el = document.querySelector<HTMLLinkElement>('link[rel="manifest"]')
      if (!el) return
      if (created) el.remove()
      else if (previous) el.setAttribute('href', previous)
    }
  }, [])

  useEffect(() => {
    fetch('/api/dashboard/sub/data')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.brandConfig) setBrand(d.brandConfig)
        if (d?.ownShopSlug) setOwnShopSlug(d.ownShopSlug)
        // Only a confirmed depth of 2+ hides it. An older payload with no
        // depth field leaves the entry visible.
        if (typeof d?.depth === 'number' && d.depth >= 2) setRecruitBlocked(true)
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    setOpen(false)
  }, [pathname])

  const shopName = brand?.shopName || brand?.appName || 'My Portal'
  const initial = shopName.charAt(0).toUpperCase()
  const current = NAV.find((n) => (n.exact ? pathname === n.href : pathname?.startsWith(n.href)))
  const title = current?.label || 'Dashboard'

  const isActive = (item: (typeof NAV)[number]) =>
    item.exact ? pathname === item.href : pathname?.startsWith(item.href)

  return (
    <div className="min-h-screen">
      {/* ── Sidebar ─────────────────────────────────────────────── */}
      {open && (
        <div className="lg:hidden fixed inset-0 z-40 bg-black/50" onClick={() => setOpen(false)} />
      )}
      <aside
        className={`fixed left-0 top-0 z-50 h-full w-64 flex flex-col text-white transition-transform duration-300 lg:translate-x-0 ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
        style={{ backgroundColor: TEAL }}
      >
        {/* Brand */}
        <div className="h-16 flex items-center gap-3 px-5" style={{ backgroundColor: TEAL_DARK }}>
          {brand?.logo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={brand.logo} alt={shopName} className="h-9 w-9 rounded-lg object-contain bg-white/90 p-0.5" />
          ) : (
            <div className="h-9 w-9 rounded-lg flex items-center justify-center bg-white/15 font-bold">
              {initial}
            </div>
          )}
          <span className="font-bold truncate">{shopName}</span>
          <button
            onClick={() => setOpen(false)}
            className="lg:hidden ml-auto text-white/80"
            aria-label="Close menu"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
          {NAV.filter((item) => isPageAccessible(item.href))
            .filter((item) => !('recruitOnly' in item && item.recruitOnly) || !recruitBlocked)
            .map((item) => {
            const external = 'external' in item && item.external
            const active = !external && isActive(item)
            const className = `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-semibold transition-colors ${
              active ? 'bg-white/20 text-white' : 'text-white/80 hover:bg-white/10 hover:text-white'
            }`
            const inner = (
              <>
                <item.icon className="w-5 h-5 flex-shrink-0" />
                {item.label}
              </>
            )
            return external ? (
              <a
                key={item.href}
                href={item.href}
                target="_blank"
                rel="noopener noreferrer"
                className={className}
              >
                {inner}
              </a>
            ) : (
              <Link key={item.href} href={item.href} className={className}>
                {inner}
              </Link>
            )
          })}
          {ownShopSlug && (
            <a
              href={`/shop/${ownShopSlug}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-semibold text-white/80 hover:bg-white/10 hover:text-white transition-colors"
            >
              <ExternalLink className="w-5 h-5 flex-shrink-0" />
              Visit My Store
            </a>
          )}
        </nav>

        {/* Footer */}
        <div className="p-3 border-t border-white/15">
          {dbUser && (
            <div className="px-3 py-2 mb-1">
              <p className="text-sm font-semibold truncate">
                {dbUser.first_name} {dbUser.last_name}
              </p>
              <p className="text-xs text-white/60">Sub-Agent</p>
            </div>
          )}
          <button
            onClick={signOut}
            className="flex w-full items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-semibold text-white/90 hover:bg-white/10 transition-colors"
          >
            <LogOut className="w-5 h-5 flex-shrink-0" />
            Sign Out
          </button>
        </div>
      </aside>

      {/* ── Header ──────────────────────────────────────────────── */}
      <header
        className="fixed top-0 right-0 left-0 lg:left-64 z-30 h-14 flex items-center gap-3 px-4 text-white shadow-sm"
        style={{ backgroundColor: TEAL }}
      >
        <button
          onClick={() => setOpen(true)}
          className="lg:hidden text-white"
          aria-label="Open menu"
        >
          <Menu className="w-6 h-6" />
        </button>
        <span className="font-semibold truncate">{title}</span>
        <span className="ml-auto text-sm text-white/80 truncate max-w-[45%]">
          {dbUser ? `${dbUser.first_name} ${dbUser.last_name}` : ''}
        </span>
      </header>

      {/* ── Content ─────────────────────────────────────────────── */}
      <div className="lg:pl-64 pt-14">
        <main className="min-h-[calc(100vh-3.5rem)]">{children}</main>
      </div>
    </div>
  )
}
