'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
    Home,
    Bookmark,
    PlusSquare,
    MessageSquare,
    User,
    Plus,
    Flame,
} from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Mobile-first marketplace shell (Jiji-style) for marketplace.arhmsgh.com.
 *
 * Three self-contained pieces, all driven by the dummy data arrays below so
 * real content can be swapped in later:
 *   1. Top category scroll row  — horizontal, snap-scroll, hidden scrollbar
 *   2. Quick-action shortcuts   — 4 rounded cards (Sell / Hot / Cars / Homes)
 *   3. Fixed bottom navigation  — Home · Saved · Sell · Messages · Profile
 *
 * The page body scrolls above the fixed bottom bar; content is capped at
 * ~480px and centered on desktop.
 */

// ── Brand ────────────────────────────────────────────────────────────────
// Marketplace brand green. Kept as a literal so the active nav/CTA colour
// exactly matches the design spec regardless of the Tailwind theme.
const BRAND_GREEN = '#00A652'

// ── Dummy data (swap for real content later) ───────────────────────────────
type Category = { id: string; name: string; image: string; href: string }

const CATEGORIES: Category[] = [
    {
        id: 'hyundai',
        name: 'Hyundai Cars',
        image: 'https://images.unsplash.com/photo-1619767886558-efdc259cde1a?auto=format&fit=crop&w=400&q=60',
        href: '/classifieds/category/vehicles',
    },
    {
        id: 'toyota',
        name: 'Toyota Cars',
        image: 'https://images.unsplash.com/photo-1621007947382-bb3c3994e3fb?auto=format&fit=crop&w=400&q=60',
        href: '/classifieds/category/vehicles',
    },
    {
        id: 'phones',
        name: 'Mobile Phones',
        image: 'https://images.unsplash.com/photo-1511707171634-5f897ff02aa9?auto=format&fit=crop&w=400&q=60',
        href: '/classifieds/category/phones',
    },
    {
        id: 'kia',
        name: 'Kia Cars',
        image: 'https://images.unsplash.com/photo-1550355291-bbee04a92027?auto=format&fit=crop&w=400&q=60',
        href: '/classifieds/category/vehicles',
    },
    {
        id: 'property',
        name: 'Houses & Land',
        image: 'https://images.unsplash.com/photo-1568605114967-8130f3a36994?auto=format&fit=crop&w=400&q=60',
        href: '/classifieds/category/property',
    },
    {
        id: 'fashion',
        name: 'Fashion',
        image: 'https://images.unsplash.com/photo-1445205170230-053b83016050?auto=format&fit=crop&w=400&q=60',
        href: '/classifieds/category/fashion',
    },
]

type QuickAction = {
    id: string
    label: string
    href: string
} & (
    | { kind: 'icon'; render: React.ReactNode; bg: string }
    | { kind: 'image'; image: string }
)

const QUICK_ACTIONS: QuickAction[] = [
    {
        id: 'sell',
        kind: 'icon',
        label: 'Post ad',
        href: '/classifieds/seller/dashboard',
        bg: '#F9A825',
        render: (
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-white shadow-sm">
                <Plus className="h-5 w-5" style={{ color: '#F9A825' }} strokeWidth={2.5} />
            </span>
        ),
    },
    {
        id: 'hot',
        kind: 'icon',
        label: 'Hot deals',
        href: '/classifieds?sort=trending',
        bg: '#F5F7FA',
        render: <Flame className="h-8 w-8 text-orange-500" fill="#fb923c" />,
    },
    {
        id: 'cars',
        kind: 'image',
        label: 'Vehicles',
        href: '/classifieds/category/vehicles',
        image: 'https://images.unsplash.com/photo-1583121274602-3e2820c69888?auto=format&fit=crop&w=300&q=60',
    },
    {
        id: 'homes',
        kind: 'image',
        label: 'Property',
        href: '/classifieds/category/property',
        image: 'https://images.unsplash.com/photo-1570129477492-45c003edd2be?auto=format&fit=crop&w=300&q=60',
    },
]

// NOTE: `Saved` and `Messages` point at the buyer dashboard for now — swap in
// dedicated /favorites and /messages routes once they exist.
const NAV_ITEMS = [
    { id: 'home', label: 'Home', icon: Home, href: '/classifieds' },
    { id: 'saved', label: 'Saved', icon: Bookmark, href: '/classifieds/buyer/dashboard' },
    { id: 'sell', label: 'Sell', icon: PlusSquare, href: '/classifieds/seller/dashboard' },
    { id: 'messages', label: 'Messages', icon: MessageSquare, href: '/classifieds/buyer/dashboard' },
    { id: 'profile', label: 'Profile', icon: User, href: '/classifieds/buyer/dashboard' },
] as const

// ── Component ──────────────────────────────────────────────────────────────
export function MarketplaceMobileHome() {
    const pathname = usePathname()

    // Home is active by default (exact match); others match by path prefix.
    const isActive = (href: string) =>
        href === '/classifieds' ? pathname === '/classifieds' : pathname?.startsWith(href)

    return (
        <div className="mx-auto min-h-screen max-w-[480px] bg-white dark:bg-[#0a0f1c]">
            {/* pb leaves room for the fixed bottom nav + iOS safe area */}
            <div className="px-4 pb-28 pt-4">
                {/* ── 1. TOP CATEGORY SCROLL ROW ─────────────────────────── */}
                <section className="mb-6">
                    <div className="scrollbar-hide -mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-1">
                        {CATEGORIES.map((cat) => (
                            <Link
                                key={cat.id}
                                href={cat.href}
                                className="w-[150px] flex-shrink-0 snap-start"
                            >
                                <div className="overflow-hidden rounded-2xl bg-gray-100 dark:bg-white/5">
                                    {/* plain <img> avoids next/image remote-domain config */}
                                    {/* eslint-disable-next-line @next/next/no-img-element */}
                                    <img
                                        src={cat.image}
                                        alt={cat.name}
                                        loading="lazy"
                                        className="aspect-[4/3] w-full object-cover"
                                    />
                                </div>
                                <p className="mt-1.5 px-0.5 text-sm font-medium text-gray-800 dark:text-gray-200">
                                    {cat.name}
                                </p>
                            </Link>
                        ))}
                    </div>
                </section>

                {/* ── 2. QUICK ACTION / CATEGORY SHORTCUTS ROW ───────────── */}
                <section className="mb-6">
                    <div className="grid grid-cols-4 gap-2.5">
                        {QUICK_ACTIONS.map((action) => (
                            <Link
                                key={action.id}
                                href={action.href}
                                className="group flex flex-col items-center gap-1.5"
                            >
                                <span
                                    className="flex aspect-square w-full items-center justify-center overflow-hidden rounded-2xl transition-transform active:scale-95"
                                    style={{
                                        backgroundColor:
                                            action.kind === 'icon' ? action.bg : '#F5F7FA',
                                    }}
                                >
                                    {action.kind === 'image' ? (
                                        // eslint-disable-next-line @next/next/no-img-element
                                        <img
                                            src={action.image}
                                            alt={action.label}
                                            loading="lazy"
                                            className="h-full w-full object-cover"
                                        />
                                    ) : (
                                        action.render
                                    )}
                                </span>
                                <span className="text-[11px] font-medium text-gray-600 dark:text-gray-400">
                                    {action.label}
                                </span>
                            </Link>
                        ))}
                    </div>
                </section>

                {/* Room for the real feed to render below. */}
                <section>
                    <h3 className="mb-3 text-base font-bold text-gray-900 dark:text-white">
                        Trending near you
                    </h3>
                    <div className="grid grid-cols-2 gap-3">
                        {Array.from({ length: 4 }).map((_, i) => (
                            <div
                                key={i}
                                className="aspect-[4/5] animate-pulse rounded-2xl bg-gray-100 dark:bg-white/5"
                            />
                        ))}
                    </div>
                </section>
            </div>

            {/* ── 3. FIXED BOTTOM NAVIGATION BAR ─────────────────────────── */}
            <nav
                className="fixed inset-x-0 bottom-0 z-40 mx-auto max-w-[480px] border-t border-gray-200 bg-white shadow-[0_-2px_12px_rgba(0,0,0,0.05)] dark:border-white/10 dark:bg-[#0f1628]"
                // iOS home-indicator safe-area padding
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
                                    <Icon
                                        className="h-6 w-6"
                                        strokeWidth={active ? 2.4 : 2}
                                        style={{ color: active ? BRAND_GREEN : '#1A1A1A' }}
                                    />
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
        </div>
    )
}

export default MarketplaceMobileHome
