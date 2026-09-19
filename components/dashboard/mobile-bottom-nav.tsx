'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
    LayoutGrid,
    Wallet,
    Package,
    ClipboardList,
    Store,
    RefreshCw,
    Menu,
    X,
    User,
    Activity,
    Bell,
    Crown,
    Download,
    Phone,
    Zap,
    Tag,
    BadgeCheck,
    MessageSquare,
    Shield,
    ShieldCheck,
    ShoppingCart,
    Banknote,
    Users,
    Send,
    Code2,
    Settings,
    Receipt,
    Gift,
} from 'lucide-react'
import { usePageAccess } from '@/hooks/use-page-access'
import { useUI } from '@/contexts/ui-context'
import { useAuth } from '@/contexts/auth-context'
import { type UserRole } from '@/lib/roles'
import { shopNavItems, subShopNavItems, type NavItem } from '@/lib/dashboard-nav'

/**
 * Floating pill bottom navigation for the mobile dashboard.
 *
 * The pill and the detached hamburger carry the signed-in role's colour, so the
 * bar matches the badge and chrome the user already sees elsewhere.
 *
 * The active tab expands into a white chip carrying a toggle for that section's
 * sub-pages.
 */

interface NavTheme {
    /** Tailwind gradient stops for the pill and hamburger. */
    gradient: string
    /** Active chip's text colour — it sits on white. */
    ink: string
    /** Inactive tab text colour — it sits on the gradient. */
    onSurface: string
    /**
     * False for surfaces light enough to need dark text. Gold is the only one:
     * white on #D4AF37 is about 2.1:1 and unreadable, so the customer bar is
     * the mirror image of the others — dark text, gentler specular bloom.
     */
    darkSurface: boolean
}

/**
 * Nav chrome per role, matching each role's badge colour in lib/roles.ts.
 *
 * Colours are applied inline rather than as text-[#hex] classes, which would
 * each need a tailwind.config.ts safelist entry to survive the production
 * purge. The gradient stops are class names, so they do need to be safelisted
 * when they are arbitrary hexes.
 */
const NAV_THEME: Record<UserRole, NavTheme> = {
    'admin': {
        gradient: 'from-rose-600 via-rose-700 to-red-900',
        ink: '#9F1239', onSurface: 'rgba(255,255,255,0.92)', darkSurface: true,
    },
    'sub-admin': {
        gradient: 'from-emerald-500 via-teal-600 to-teal-800',
        ink: '#0F766E', onSurface: 'rgba(255,255,255,0.92)', darkSurface: true,
    },
    'agent': {
        gradient: 'from-[#123A63] via-[#0E3255] to-[#0A2A4A]',
        ink: '#0A2A4A', onSurface: 'rgba(255,255,255,0.92)', darkSurface: true,
    },
    'dealer': {
        gradient: 'from-purple-600 via-violet-700 to-indigo-800',
        ink: '#5B21B6', onSurface: 'rgba(255,255,255,0.92)', darkSurface: true,
    },
    // Gold, to match the customer badge. #4A3810 on the mid-gold reads ~5:1.
    'customer': {
        gradient: 'from-brand-gold-light via-brand-gold to-brand-gold-dark',
        ink: '#7A5F22', onSurface: '#4A3810', darkSurface: false,
    },
}

/** Depth shared by the pill and the hamburger: rim light plus a cast shadow. */
const SURFACE_DEPTH =
    'ring-1 ring-inset ring-white/30 shadow-[0_18px_38px_-14px_rgba(0,0,0,0.55)]'

/**
 * Fluid metrics for the bar.
 *
 * Phones in the wild are 320–430px wide and the bar has to hold a hamburger,
 * an expanded chip and up to four more tabs at every one of them. Fixed sizes
 * fit only the wide end: below roughly 390px the row's min-content exceeds the
 * viewport, flex shrinks each tab box past its icon, and the icons — which have
 * no flex axis to shrink along — spill out and overlap their neighbours.
 *
 * clamp() ties each metric to the viewport instead, so the bar keeps the same
 * proportions on a 320px phone as on a 430px one and can never outgrow it. The
 * upper bounds are the sizes the bar used to have, so nothing here grows past
 * the original design — a small tablet still gets the full-size bar.
 *
 * These have to be viewport-relative rather than responsive variants: every
 * width that matters is below Tailwind's smallest breakpoint (`sm`, 640px), so
 * no variant can tell a 320px phone from a 430px one.
 */
const NAV_METRICS = {
    '--nav-fab': 'clamp(2.75rem, 12.5vw, 4.5rem)',
    '--nav-fab-icon': 'clamp(1.25rem, 5.5vw, 2rem)',
    '--nav-icon': 'clamp(1.15rem, 5.2vw, 1.75rem)',
    '--nav-chip-text': 'clamp(0.8125rem, 3.6vw, 1.125rem)',
    '--nav-tab-text': 'clamp(0.5625rem, 2.6vw, 0.75rem)',
} as React.CSSProperties

/** Icons are sized off the vars above, so they scale with the bar. */
const NAV_ICON = { width: 'var(--nav-icon)', height: 'var(--nav-icon)' }

/**
 * The mirrored finish. A bright specular bloom off the top-left plus a darker
 * pool along the bottom edge reads as a convex, polished surface — the same
 * trick a glass button uses. Both layers are decorative and inert; siblings
 * that should sit above them need their own `relative`, since an absolutely
 * positioned element otherwise paints over static content.
 */
function Sheen({ dark }: { dark: boolean }) {
    return (
        <>
            <span
                aria-hidden="true"
                className={
                    dark
                        ? 'pointer-events-none absolute inset-0 bg-[radial-gradient(125%_170%_at_12%_-45%,rgba(255,255,255,0.42),rgba(255,255,255,0.12)_36%,rgba(255,255,255,0)_62%)]'
                        : 'pointer-events-none absolute inset-0 bg-[radial-gradient(125%_170%_at_12%_-45%,rgba(255,255,255,0.55),rgba(255,255,255,0.16)_34%,rgba(255,255,255,0)_60%)]'
                }
            />
            <span
                aria-hidden="true"
                className="pointer-events-none absolute inset-x-0 bottom-0 h-1/3 bg-[linear-gradient(to_top,rgba(0,0,0,0.20),rgba(0,0,0,0))]"
            />
        </>
    )
}

interface Tab extends NavItem {
    id: string
}

interface NavVariant {
    /**
     * The section this bar belongs to. The `home` tab claims every route under
     * it that no other tab matches, which is what keeps a chip (and with it the
     * sub-menu) on screen for the long tail of pages that have no tab of their
     * own.
     */
    root: string
    tabs: Tab[]
    /** Sub-pages surfaced from the active tab. Mirrors the sidebar's link set. */
    subItems: Record<string, NavItem[]>
}

/**
 * The dashboard and the admin panel run the same bar over different link sets.
 * Both keep `home` as the first tab, since that is the id the fallback match
 * looks for.
 */
const NAV_VARIANTS = {
    dashboard: {
        root: '/dashboard',
        tabs: [
            { id: 'home', label: 'Home', href: '/dashboard', icon: LayoutGrid },
            { id: 'wallet', label: 'Wallet', href: '/dashboard/wallet', icon: Wallet },
            { id: 'data', label: 'Data', href: '/dashboard/data-packages', icon: Package },
            { id: 'orders', label: 'Orders', href: '/dashboard/my-orders', icon: ClipboardList },
            { id: 'shop', label: 'Shop', href: '/dashboard/shop', icon: Store },
        ],
        subItems: {
            home: [
                { href: '/dashboard/profile', label: 'Profile', icon: User },
                { href: '/dashboard/refer', label: 'Refer & Earn', icon: Gift },
                { href: '/dashboard/transactions', label: 'Transactions', icon: Activity },
                { href: '/dashboard/notifications', label: 'Notifications', icon: Bell },
                { href: '/dashboard/upgrade', label: 'Role Upgrade', icon: Crown },
                { href: '/dashboard/install', label: 'Download App', icon: Download },
            ],
            wallet: [
                { href: '/dashboard/wallet', label: 'Top Up', icon: Wallet },
                { href: '/dashboard/transactions', label: 'Transactions', icon: Activity },
            ],
            data: [
                { href: '/dashboard/data-packages', label: 'Data Packages', icon: Package },
                { href: '/dashboard/airtime', label: 'Buy Airtime', icon: Phone },
                { href: '/dashboard/utilities', label: 'Pay Bills', icon: Receipt },
                { href: '/dashboard/data-packages?network=Special%20MTN%20Mashup', label: 'Special MTN Mashup', icon: Zap },
                { href: '/dashboard/data-packages?network=EXPRESS%20MTN', label: 'EXPRESS MTN', icon: Zap },
                { href: '/dashboard/results-checker', label: 'Results Checker', icon: Tag },
                { href: '/dashboard/afa-orders', label: 'AFA Registration', icon: BadgeCheck },
            ],
            orders: [
                { href: '/dashboard/my-orders', label: 'My Orders', icon: ClipboardList },
                { href: '/dashboard/complaints', label: 'Complaints', icon: MessageSquare },
            ],
            shop: shopNavItems,
        },
    },
    // A sub-agent's own dashboard/orders/AFA/Results-Checker/Bill-Payments pages
    // live under /dashboard/sub/* — separate implementations (own wallet debit,
    // upline-resolved pricing floor, owner-approved withdrawals) from the
    // customer pages the `dashboard` variant above points at. Everything not
    // remapped here (Data Packages, Buy Airtime, Wallet, Marketplace, Refer &
    // Earn, Transactions, Complaints, Profile, Download App, Developer API,
    // Commission Wallet) is genuinely shared with the customer nav.
    'dashboard-sub': {
        root: '/dashboard/sub',
        tabs: [
            { id: 'home', label: 'Home', href: '/dashboard/sub', icon: LayoutGrid },
            { id: 'wallet', label: 'Wallet', href: '/dashboard/wallet', icon: Wallet },
            { id: 'data', label: 'Data', href: '/dashboard/data-packages', icon: Package },
            { id: 'orders', label: 'Orders', href: '/dashboard/sub/orders', icon: ClipboardList },
            { id: 'shop', label: 'Shop', href: '/dashboard/sub/shop', icon: Store },
        ],
        subItems: {
            home: [
                { href: '/dashboard/profile', label: 'Profile', icon: User },
                { href: '/dashboard/refer', label: 'Refer & Earn', icon: Gift },
                { href: '/dashboard/transactions', label: 'Transactions', icon: Activity },
                { href: '/dashboard/notifications', label: 'Notifications', icon: Bell },
                { href: '/dashboard/install', label: 'Download App', icon: Download },
            ],
            wallet: [
                { href: '/dashboard/wallet', label: 'Top Up', icon: Wallet },
                { href: '/dashboard/transactions', label: 'Transactions', icon: Activity },
            ],
            data: [
                { href: '/dashboard/data-packages', label: 'Data Packages', icon: Package },
                { href: '/dashboard/airtime', label: 'Buy Airtime', icon: Phone },
                { href: '/dashboard/sub/utilities', label: 'Pay Bills', icon: Receipt },
                { href: '/dashboard/data-packages?network=Special%20MTN%20Mashup', label: 'Special MTN Mashup', icon: Zap },
                { href: '/dashboard/data-packages?network=EXPRESS%20MTN', label: 'EXPRESS MTN', icon: Zap },
                { href: '/dashboard/sub/rc', label: 'Results Checker', icon: Tag },
                { href: '/dashboard/sub/afa', label: 'AFA Registration', icon: BadgeCheck },
            ],
            orders: [
                { href: '/dashboard/sub/orders', label: 'My Orders', icon: ClipboardList },
                { href: '/dashboard/complaints', label: 'Complaints', icon: MessageSquare },
            ],
            shop: subShopNavItems,
        },
    },
    // Five tabs for twenty-five admin pages, so the sub-menus carry the rest —
    // between them they cover every link in the sidebar's admin list. Tab hrefs
    // are matched by prefix, so /admin/shops also owns /admin/shops/withdrawals.
    admin: {
        root: '/admin',
        tabs: [
            { id: 'home', label: 'Home', href: '/admin', icon: Shield },
            { id: 'orders', label: 'Orders', href: '/admin/orders', icon: ShoppingCart },
            { id: 'finance', label: 'Finance', href: '/admin/finance', icon: Banknote },
            { id: 'shops', label: 'Shops', href: '/admin/shops', icon: Store },
            { id: 'users', label: 'Users', href: '/admin/users', icon: Users },
        ],
        subItems: {
            home: [
                { href: '/admin', label: 'Overview', icon: Shield },
                { href: '/admin/packages', label: 'Packages', icon: Package },
                { href: '/admin/announcements', label: 'Announce', icon: Bell },
                { href: '/admin/sms-broadcast', label: 'SMS', icon: MessageSquare },
                { href: '/admin/email-broadcast', label: 'Email', icon: Send },
                { href: '/admin/api-keys', label: 'API Keys', icon: Code2 },
                { href: '/admin/referrals', label: 'Referrals', icon: Gift },
                { href: '/admin/settings', label: 'Settings', icon: Settings },
            ],
            orders: [
                { href: '/admin/orders', label: 'Orders', icon: ShoppingCart },
                { href: '/admin/fulfillment', label: 'Fulfillment', icon: Activity },
                { href: '/admin/up2u-checker', label: 'UP2U Checker', icon: ShieldCheck },
                { href: '/admin/datagod', label: 'DataGod Console', icon: Activity },
                { href: '/admin/airtime', label: 'Airtime', icon: Phone },
                { href: '/admin/utilities', label: 'Utility Bills', icon: Receipt },
                { href: '/admin/mashup-orders', label: 'Special MTN Mashup', icon: Zap },
                { href: '/admin/express-orders', label: 'EXPRESS MTN', icon: Zap },
                { href: '/admin/afa-management', label: 'AFA Management', icon: BadgeCheck },
                { href: '/admin/vouchers', label: 'Results Checker', icon: Tag },
                { href: '/admin/complaints', label: 'Complaints', icon: MessageSquare },
            ],
            finance: [
                { href: '/admin/finance', label: 'Finance', icon: Banknote },
                { href: '/admin/top-up', label: 'Top-Up', icon: Wallet },
                { href: '/admin/hubtel-payments', label: 'Hubtel Payments', icon: Banknote },
                { href: '/admin/profits-history', label: 'Profits', icon: Wallet },
                { href: '/admin/shops/withdrawals', label: 'Shop Withdrawals', icon: Banknote },
            ],
            shops: [
                { href: '/admin/shops', label: 'Shops', icon: Store },
                { href: '/admin/shops/withdrawals', label: 'Shop Withdrawals', icon: Banknote },
                { href: '/classifieds/admin/dashboard', label: 'Classifieds', icon: Store },
            ],
            users: [
                { href: '/admin/users', label: 'Users', icon: Users },
                { href: '/admin/memberships', label: 'Agent Members', icon: Crown },
            ],
        },
    },
} satisfies Record<string, NavVariant>

export type NavVariantName = keyof typeof NAV_VARIANTS

export function MobileBottomNav({ variant = 'dashboard' }: { variant?: NavVariantName } = {}) {
    const pathname = usePathname() ?? ''
    const { isPageAccessible } = usePageAccess()
    const { toggleSidebar } = useUI()
    const { dbUser, isAdmin, isSubAdmin } = useAuth()
    const [openSection, setOpenSection] = useState<string | null>(null)

    // Same precedence the header uses: the admin flags outrank the stored role.
    const role: UserRole = isAdmin
        ? 'admin'
        : isSubAdmin
            ? 'sub-admin'
            : ((dbUser?.role as UserRole) || 'customer')
    const theme = NAV_THEME[role] ?? NAV_THEME['customer']
    const surface = `relative overflow-hidden bg-gradient-to-br ${theme.gradient} ${SURFACE_DEPTH}`

    // The sub-menu is anchored to the active chip, so a route change always
    // invalidates it.
    useEffect(() => {
        setOpenSection(null)
    }, [pathname])

    useEffect(() => {
        if (!openSection) return
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setOpenSection(null)
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [openSection])

    const nav: NavVariant = NAV_VARIANTS[variant]

    /**
     * Sub-admins are bounced back to /admin/orders by the admin layout the
     * moment they land anywhere else, so every other admin link would be a
     * round trip to nowhere. Their own dashboard is unrestricted.
     */
    const permitted = (href: string) =>
        !(variant === 'admin' && isSubAdmin) || href.startsWith('/admin/orders')

    const tabs = nav.tabs.filter((tab) => permitted(tab.href) && isPageAccessible(tab.href))

    // Home owns every route in the section that no other tab claims — without
    // the fallback the chip (and with it the sub-menu) would vanish on pages
    // like /dashboard/profile, stranding the user on a route they reached
    // from it.
    const activeId =
        tabs.find((tab) => tab.id !== 'home' && pathname.startsWith(tab.href))?.id ??
        (pathname.startsWith(nav.root) ? 'home' : null)

    // Query-string entries share a base route, so gate on the path only.
    const visibleSubItems = (id: string) =>
        (nav.subItems[id] ?? []).filter(
            (item) => permitted(item.href) && isPageAccessible(item.href.split('?')[0])
        )

    const openItems = openSection ? visibleSubItems(openSection) : []

    return (
        <>
        <RefreshFab />
        <div
            style={NAV_METRICS}
            className="fixed inset-x-0 bottom-0 z-40 md:hidden px-[clamp(0.5rem,2.5vw,0.75rem)] pb-[calc(0.75rem+env(safe-area-inset-bottom))]"
        >
            {/* Backdrop — a tap anywhere outside dismisses the sub-menu. */}
            {openSection && (
                <button
                    type="button"
                    aria-label="Close menu"
                    onClick={() => setOpenSection(null)}
                    className="fixed inset-0 z-0 cursor-default"
                />
            )}

            <div className="relative mx-auto max-w-lg">
                {/* Sub-menu for the active section */}
                {openSection && openItems.length > 0 && (
                    <div
                        id={`nav-submenu-${openSection}`}
                        className="absolute bottom-full left-0 right-0 mb-3 grid grid-cols-2 gap-1 rounded-2xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-2 shadow-nav animate-in fade-in slide-in-from-bottom-2"
                    >
                        {openItems.map((item) => {
                            const Icon = item.icon
                            return (
                                <Link
                                    key={item.href}
                                    href={item.href}
                                    onClick={() => setOpenSection(null)}
                                    className="flex items-center gap-2 rounded-xl px-3 py-2.5 text-xs font-semibold text-slate-700 dark:text-zinc-200 active:bg-slate-100 dark:active:bg-zinc-800"
                                >
                                    <Icon className="h-4 w-4 shrink-0" style={{ color: theme.ink }} />
                                    <span className="truncate">{item.label}</span>
                                </Link>
                            )
                        })}
                    </div>
                )}

                <div className="relative flex items-center gap-[clamp(0.375rem,2vw,0.75rem)]">
                    {/* Sidebar drawer trigger — the same panel the header button opens */}
                    <button
                        type="button"
                        onClick={toggleSidebar}
                        aria-label="Open menu"
                        className={`flex shrink-0 items-center justify-center rounded-full transition-transform active:scale-95 ${surface}`}
                        style={{
                            color: theme.onSurface,
                            width: 'var(--nav-fab)',
                            height: 'var(--nav-fab)',
                        }}
                    >
                        <Sheen dark={theme.darkSurface} />
                        <Menu
                            className="relative"
                            style={{ width: 'var(--nav-fab-icon)', height: 'var(--nav-fab-icon)' }}
                        />
                    </button>

                    <nav
                        className={`flex min-w-0 flex-1 items-center gap-[clamp(0.125rem,1.2vw,0.5rem)] rounded-full p-[clamp(0.375rem,2vw,0.75rem)] ${surface}`}
                    >
                        <Sheen dark={theme.darkSurface} />
                        {tabs.map((tab) => {
                            const Icon = tab.icon

                            if (tab.id === activeId) {
                                // A menu whose only entry is the page you are
                                // already on is noise. It happens whenever the
                                // access filters strip a section back to its
                                // own landing page.
                                const subItems = visibleSubItems(tab.id)
                                const goesElsewhere = subItems.some((item) => item.href !== tab.href)
                                const expanded = openSection === tab.id
                                return (
                                    <div
                                        key={tab.id}
                                        className="relative flex min-w-0 items-center gap-[clamp(0.25rem,1.8vw,0.625rem)] rounded-full bg-white px-[clamp(0.625rem,3.5vw,1.25rem)] py-[clamp(0.5rem,2.5vw,0.875rem)] shadow-[0_2px_6px_rgba(0,0,0,0.18)]"
                                        style={{ color: theme.ink }}
                                    >
                                        <Link
                                            href={tab.href}
                                            aria-current={pathname === tab.href ? 'page' : undefined}
                                            className="flex min-w-0 items-center gap-[clamp(0.25rem,1.8vw,0.625rem)]"
                                        >
                                            <Icon className="shrink-0" style={NAV_ICON} />
                                            <span
                                                className="truncate font-bold"
                                                style={{ fontSize: 'var(--nav-chip-text)' }}
                                            >
                                                {tab.label}
                                            </span>
                                        </Link>
                                        {goesElsewhere && (
                                            <button
                                                type="button"
                                                onClick={() => setOpenSection(expanded ? null : tab.id)}
                                                aria-expanded={expanded}
                                                aria-controls={`nav-submenu-${tab.id}`}
                                                aria-label={`${tab.label} sub-menu`}
                                                className="-mr-1 shrink-0 rounded-full p-0.5 active:scale-95"
                                            >
                                                {expanded
                                                    ? <X style={NAV_ICON} />
                                                    : <Menu style={NAV_ICON} />}
                                            </button>
                                        )}
                                    </div>
                                )
                            }

                            return (
                                // basis-0 keeps the four inactive tabs equal
                                // regardless of label width, and overflow-hidden
                                // is the backstop: if a tab is ever squeezed
                                // below its icon, it clips instead of painting
                                // over its neighbour.
                                <Link
                                    key={tab.id}
                                    href={tab.href}
                                    className={`relative flex min-w-0 flex-1 basis-0 flex-col items-center gap-[clamp(0.25rem,1.5vw,0.5rem)] overflow-hidden py-1.5 transition-transform active:scale-95 ${
                                        theme.darkSurface ? 'drop-shadow-[0_1px_1px_rgba(0,0,0,0.25)]' : ''
                                    }`}
                                    style={{ color: theme.onSurface }}
                                >
                                    <Icon className="shrink-0" style={NAV_ICON} />
                                    <span
                                        className="max-w-full truncate font-semibold leading-none"
                                        style={{ fontSize: 'var(--nav-tab-text)' }}
                                    >
                                        {tab.label}
                                    </span>
                                </Link>
                            )
                        })}
                    </nav>
                </div>
            </div>
        </div>
        </>
    )
}

/**
 * Size drives layout as well as looks: the drag clamp, the edge snap and the
 * saved resting position are all expressed against it, so changing this number
 * moves the button correctly everywhere. A stored position from an older size
 * is re-clamped on mount, so it can't be left hanging off-screen.
 */
const FAB_SIZE = 60
const FAB_MARGIN = 12
const FAB_STORAGE_KEY = 'arhms:refresh-fab'
/** Below this much travel the gesture is a tap, not a drag. */
const DRAG_THRESHOLD = 6

/**
 * Draggable refresh button.
 *
 * Position is viewport-relative and therefore client-only — the button renders
 * nothing until the first effect resolves it, which also keeps it out of the
 * SSR markup and away from a hydration mismatch. On release it snaps to
 * whichever side it is nearest so it can never be abandoned mid-screen, and the
 * resting place is remembered across loads.
 */
function RefreshFab() {
    const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
    const [dragging, setDragging] = useState(false)
    const drag = useRef<{ dx: number; dy: number; startX: number; startY: number; moved: boolean } | null>(null)

    const clamp = (p: { x: number; y: number }) => ({
        x: Math.min(Math.max(p.x, FAB_MARGIN), window.innerWidth - FAB_SIZE - FAB_MARGIN),
        y: Math.min(Math.max(p.y, FAB_MARGIN), window.innerHeight - FAB_SIZE - FAB_MARGIN),
    })

    useEffect(() => {
        // Default rest position: right-hand side, clear of the nav pill.
        const fallback = {
            x: window.innerWidth - FAB_SIZE - FAB_MARGIN,
            y: window.innerHeight - FAB_SIZE - 150,
        }
        let start = fallback
        try {
            const raw = window.localStorage.getItem(FAB_STORAGE_KEY)
            const saved = raw ? JSON.parse(raw) : null
            if (saved && typeof saved.x === 'number' && typeof saved.y === 'number') start = saved
        } catch {
            /* unreadable or disabled storage — fall back */
        }
        setPos(clamp(start))

        // A rotate or keyboard can shrink the viewport out from under a saved
        // position, stranding the button off-screen.
        const onResize = () => setPos((p) => (p ? clamp(p) : p))
        window.addEventListener('resize', onResize)
        return () => window.removeEventListener('resize', onResize)
    }, [])

    if (!pos) return null

    const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        drag.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y, startX: e.clientX, startY: e.clientY, moved: false }
        setDragging(true)
    }

    const onPointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
        const d = drag.current
        if (!d) return
        if (!d.moved && Math.hypot(e.clientX - d.startX, e.clientY - d.startY) > DRAG_THRESHOLD) {
            d.moved = true
        }
        setPos(clamp({ x: e.clientX - d.dx, y: e.clientY - d.dy }))
    }

    const onPointerUp = () => {
        const d = drag.current
        drag.current = null
        setDragging(false)
        if (!d) return
        if (!d.moved) {
            window.location.reload()
            return
        }
        setPos((prev) => {
            if (!prev) return prev
            const toLeft = prev.x + FAB_SIZE / 2 < window.innerWidth / 2
            const snapped = {
                x: toLeft ? FAB_MARGIN : window.innerWidth - FAB_SIZE - FAB_MARGIN,
                y: prev.y,
            }
            try {
                window.localStorage.setItem(FAB_STORAGE_KEY, JSON.stringify(snapped))
            } catch {
                /* storage disabled — position simply will not persist */
            }
            return snapped
        })
    }

    return (
        <button
            type="button"
            aria-label="Refresh page"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            style={{ left: pos.x, top: pos.y, width: FAB_SIZE, height: FAB_SIZE, touchAction: 'none' }}
            className={`fixed z-50 flex items-center justify-center rounded-full border border-slate-200 bg-white text-slate-600 shadow-soft dark:border-zinc-700 dark:bg-zinc-800 dark:text-white md:hidden ${
                dragging ? 'scale-110 cursor-grabbing shadow-nav' : 'transition-[left,top,transform] duration-200 active:scale-95'
            }`}
        >
            <RefreshCw className="h-7 w-7" />
        </button>
    )
}
