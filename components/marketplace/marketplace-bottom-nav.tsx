'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Home, Bookmark, PlusSquare, MessageSquare, User } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Fixed bottom navigation for the marketplace (marketplace.arhmsgh.com).
 *
 * Mobile-only (md:hidden) — desktop uses the header nav. Shown on the public
 * browsing surface (home, categories, listing detail) and hidden on the
 * admin / seller / buyer dashboards, which carry their own navigation.
 */

// Brand green kept as a literal so the active colour matches the design spec
// regardless of the Tailwind theme.
const BRAND_GREEN = '#00A652'

const NAV_ITEMS = [
    { id: 'home', label: 'Home', icon: Home, href: '/classifieds' },
    { id: 'saved', label: 'Saved', icon: Bookmark, href: '/classifieds/buyer/favorites' },
    { id: 'sell', label: 'Sell', icon: PlusSquare, href: '/classifieds/seller/dashboard' },
    { id: 'messages', label: 'Messages', icon: MessageSquare, href: '/classifieds/buyer/messages' },
    { id: 'profile', label: 'Profile', icon: User, href: '/classifieds/buyer/profile' },
] as const

// Routes that own their own chrome (sidebars) — the bottom bar stays out of
// their way. The Saved / Messages tabs live under /buyer but are standalone
// mobile pages, so they intentionally keep the bar.
const HIDDEN_PREFIXES = [
    '/classifieds/admin',
    '/classifieds/seller',
    '/classifieds/buyer/dashboard',
]

export function MarketplaceBottomNav() {
    const pathname = usePathname() ?? ''
    const unread = useUnreadMessageCount()

    if (HIDDEN_PREFIXES.some((p) => pathname.startsWith(p))) return null

    // Home is active only on the exact root; others match by path prefix.
    const isActive = (href: string) =>
        href === '/classifieds' ? pathname === '/classifieds' : pathname.startsWith(href)

    return (
        <nav
            className="fixed inset-x-0 bottom-0 z-40 mx-auto max-w-[480px] border-t border-gray-200 bg-white shadow-[0_-2px_12px_rgba(0,0,0,0.05)] dark:border-white/10 dark:bg-[#0f1628] md:hidden"
            style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
        >
            <ul className="flex items-stretch justify-around px-1 py-2">
                {NAV_ITEMS.map((item) => {
                    const active = isActive(item.href)
                    const Icon = item.icon
                    return (
                        <li key={item.id} className="flex-1">
                            <Link
                                href={item.href}
                                aria-current={active ? 'page' : undefined}
                                className="flex flex-col items-center gap-1 py-1"
                            >
                                <span className="relative">
                                    <Icon
                                        className="h-6 w-6"
                                        strokeWidth={active ? 2.4 : 2}
                                        style={{ color: active ? BRAND_GREEN : '#1A1A1A' }}
                                    />
                                    {item.id === 'messages' && unread > 0 && (
                                        <span
                                            className="absolute -right-2 -top-1.5 flex h-4 min-w-[16px] items-center justify-center rounded-full px-1 text-[10px] font-bold text-white ring-2 ring-white dark:ring-[#0f1628]"
                                            style={{ backgroundColor: BRAND_GREEN }}
                                            aria-label={`${unread} unread messages`}
                                        >
                                            {unread > 9 ? '9+' : unread}
                                        </span>
                                    )}
                                </span>
                                <span
                                    className={cn(
                                        'text-xs leading-none',
                                        active ? 'font-semibold' : 'font-medium'
                                    )}
                                    style={{ color: active ? BRAND_GREEN : '#333' }}
                                >
                                    {item.label}
                                </span>
                            </Link>
                        </li>
                    )
                })}
            </ul>
        </nav>
    )
}

/**
 * Polls the conversations list for the total unread count (every 20s). Silent on
 * 401/errors so it's a no-op for logged-out visitors. Reuses the list endpoint to
 * avoid a dedicated count route.
 */
function useUnreadMessageCount(): number {
    const [count, setCount] = useState(0)

    useEffect(() => {
        let active = true
        const load = async () => {
            try {
                const res = await fetch('/api/marketplace/conversations/list?limit=50')
                if (!res.ok) {
                    if (active) setCount(0)
                    return
                }
                const data = await res.json()
                const total = (data.conversations || []).reduce(
                    (sum: number, c: any) => sum + (c.unread_count || 0),
                    0
                )
                if (active) setCount(total)
            } catch {
                /* ignore transient errors */
            }
        }
        load()
        const interval = setInterval(load, 20000)
        return () => {
            active = false
            clearInterval(interval)
        }
    }, [])

    return count
}

export default MarketplaceBottomNav
