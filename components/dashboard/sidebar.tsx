'use client'

import Link from 'next/link'
import Image from 'next/image'
import { usePathname } from 'next/navigation'
import { useAuth } from '@/contexts/auth-context'
import { useUI } from '@/contexts/ui-context'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { formatCurrency } from '@/lib/utils'
import {
    LayoutDashboard,
    Package,
    ShoppingCart,
    Wallet,
    User,
    MessageSquare,
    Bell,
    Send,
    Users,
    ChevronLeft,
    ChevronRight,
    ChevronDown,
    LogOut,
    Settings,
    Shield,
    Crown,
    Star,
    BadgeCheck,
    UserCircle,
    Plus,
    Activity,
    Banknote,
    Store,
    Tag,
    Phone,
    Zap,
    Download,
    Code2,
    CreditCard,
    Loader2,
} from 'lucide-react'
import { useState, useEffect } from 'react'
import { supabase } from '@/lib/supabase'
import { usePageAccess } from '@/hooks/use-page-access'
import { useAdminCounts } from '@/hooks/use-admin-counts'
import { roleConfig } from '@/lib/roles'
import { BrandLogo } from '@/components/BrandLogo'

const userNavItems = [
    { href: '/dashboard', label: 'Home', icon: LayoutDashboard },
    { href: '/dashboard/upgrade', label: 'Membership', icon: Crown },
    { href: '/dashboard/data-packages', label: 'Data Packages', icon: Package },
    { href: '/dashboard/results-checker', label: 'Results Checker', icon: Tag },
    { href: '/dashboard/afa-orders', label: 'AFA Application', icon: BadgeCheck },
    { href: '/dashboard/airtime', label: 'Buy Airtime', icon: Phone },
    { href: '/dashboard/data-packages?network=Special%20MTN%20Mashup', label: 'Special MTN Mashup', icon: Zap },
    { href: '/dashboard/data-packages?network=EXPRESS%20MTN', label: 'EXPRESS MTN', icon: Zap },
    { href: '/dashboard/my-orders', label: 'Orders', icon: ShoppingCart },
    { href: process.env.NEXT_PUBLIC_MARKETPLACE_URL || 'https://marketplace.arhmsgh.com', label: 'Marketplace', icon: Store, external: true },
    { href: '/dashboard/wallet', label: 'Wallet', icon: Wallet },
    { href: '/dashboard/transactions', label: 'Transactions', icon: Activity },
    { href: '/dashboard/complaints', label: 'Complaints', icon: MessageSquare },
    { href: '/dashboard/profile', label: 'Profile', icon: User },
    { href: '/dashboard/install', label: 'Download App', icon: Download },
    { href: '/dashboard/developer-api', label: 'Developer API', icon: Code2 },
]

const adminNavItems = [
    { href: '/admin', label: 'Dashboard', icon: Shield },
    { href: '/admin/top-up', label: 'Top-Up', icon: Wallet },
    { href: '/admin/orders', label: 'Orders', icon: ShoppingCart },
    { href: '/admin/fulfillment', label: 'Fulfillment', icon: Activity },
    { href: '/admin/datagod', label: 'DataGod Console', icon: Activity },
    { href: '/admin/airtime', label: 'Airtime', icon: Phone },
    { href: '/admin/mashup-orders', label: 'Special MTN Mashup', icon: Zap },
    { href: '/admin/express-orders', label: 'EXPRESS MTN', icon: Zap },
    { href: '/admin/shops', label: 'Shops', icon: Store },
    { href: '/admin/shops/withdrawals', label: 'Shop Withdrawals', icon: Banknote },
    { href: '/admin/afa-management', label: 'AFA Management', icon: BadgeCheck },
    { href: '/admin/memberships', label: 'Agent Members', icon: Crown },
    { href: '/admin/users', label: 'Users', icon: Users },
    { href: '/admin/packages', label: 'Packages', icon: Package },
    { href: '/classifieds/admin/dashboard', label: 'Classifieds', icon: Store },
    { href: '/admin/complaints', label: 'Complaints', icon: MessageSquare },
    { href: '/admin/announcements', label: 'Announce', icon: Bell },
    { href: '/admin/sms-broadcast', label: 'SMS', icon: MessageSquare },
    { href: '/admin/email-broadcast', label: 'Email', icon: Send },
    { href: '/admin/finance', label: 'Finance', icon: Banknote },
    { href: '/admin/profits-history', label: 'Profits', icon: Wallet },
    { href: '/admin/api-keys', label: 'API Keys', icon: Code2 },
    { href: '/admin/settings', label: 'Settings', icon: Settings },
    { href: '/admin/vouchers', label: 'Results Checker', icon: Tag },
]

const shopNavItems = [
    { href: '/dashboard/shop', label: 'Overview', icon: LayoutDashboard },
    { href: '/dashboard/shop/setup', label: 'Shop Setup', icon: Settings },
    { href: '/dashboard/shop/pricing', label: 'Pricing', icon: Tag },
    { href: '/dashboard/shop/orders', label: 'Orders', icon: ShoppingCart },
    { href: '/dashboard/shop/withdraw', label: 'Withdraw', icon: Banknote },
]

export function DashboardSidebar() {
    const pathname = usePathname()
    const { dbUser, isAdmin, isSubAdmin, signOut } = useAuth()
    const { isInternalSidebarOpen, closeSidebar, isCollapsed, toggleCollapse } = useUI()
    const { isPageAccessible, loading: pageAccessLoading } = usePageAccess()
    const [walletBalance, setWalletBalance] = useState(0)
    const [communityLink, setCommunityLink] = useState('https://chat.whatsapp.com/DY9X9borAmz24IHAWsjI4R')
    const { counts: adminCounts } = useAdminCounts()

    // Payment gateway toggle state (admin only)
    const [webProvider, setWebProvider] = useState<'moolre' | 'paystack'>('moolre')
    const [shopProvider, setShopProvider] = useState<'moolre' | 'paystack'>('moolre')
    const [providerSaving, setProviderSaving] = useState<'web' | 'shop' | null>(null)
    const [hideMashup, setHideMashup] = useState(false)
    const [hideExpressMtn, setHideExpressMtn] = useState(false)
    const [resultsCheckerOnly, setResultsCheckerOnly] = useState(false)

    useEffect(() => {
        fetch('/api/admin-settings?keys=special_mtn_mashup_hidden,express_mtn_hidden,results_checker_only_mode')
            .then(r => r.ok ? r.json() : null)
            .then(data => {
                if (data && String(data.special_mtn_mashup_hidden) === 'true') {
                    setHideMashup(true)
                }
                if (data && String(data.express_mtn_hidden) === 'true') {
                    setHideExpressMtn(true)
                }
                if (data && String(data.results_checker_only_mode) === 'true') {
                    setResultsCheckerOnly(true)
                }
            })
            .catch(() => {})
    }, [])

    useEffect(() => {
        if (!isAdmin) return
        fetch('/api/admin-settings?keys=active_payment_provider_web,active_payment_provider_shop')
            .then(r => r.ok ? r.json() : null)
            .then(data => {
                if (!data) return
                if (String(data.active_payment_provider_web) === 'paystack') setWebProvider('paystack')
                if (String(data.active_payment_provider_shop) === 'paystack') setShopProvider('paystack')
            })
            .catch(() => {})
    }, [isAdmin])

    const toggleProvider = async (context: 'web' | 'shop', value: 'moolre' | 'paystack') => {
        setProviderSaving(context)
        const key = context === 'web' ? 'active_payment_provider_web' : 'active_payment_provider_shop'
        try {
            await fetch('/api/admin-settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ updates: [{ key, value }] }),
            })
            if (context === 'web') setWebProvider(value)
            else setShopProvider(value)
        } catch {}
        setProviderSaving(null)
    }

    // My Shop accordion — auto-expands on any /dashboard/shop route
    const isOnShopRoute = pathname?.startsWith('/dashboard/shop') ?? false
    const [shopGroupOpen, setShopGroupOpen] = useState(isOnShopRoute)
    useEffect(() => {
        if (isOnShopRoute) setShopGroupOpen(true)
    }, [isOnShopRoute])

    // Calculate days remaining for agents or dealers
    const calculateDaysRemaining = () => {
        if (dbUser?.role === 'agent' && dbUser?.agent_expires_at) {
            const now = new Date()
            const expiresAt = new Date(dbUser.agent_expires_at)
            const daysRemaining = Math.ceil((expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
            return daysRemaining > 0 ? daysRemaining : 0
        }
        if (dbUser?.role === 'dealer' && (dbUser as any)?.dealer_expires_at) {
            const now = new Date()
            const expiresAt = new Date((dbUser as any).dealer_expires_at)
            const daysRemaining = Math.ceil((expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
            return daysRemaining > 0 ? daysRemaining : 0
        }
        return null
    }

    const daysRemaining = calculateDaysRemaining()

    // Calculate dealer subscription progress (days active / total days)
    const dealerProgress = (() => {
        const claimedAt = (dbUser as any)?.dealer_claimed_at
        const expiresAt = (dbUser as any)?.dealer_expires_at
        if (!claimedAt || !expiresAt) return null
        const start = new Date(claimedAt).getTime()
        const end = new Date(expiresAt).getTime()
        const now = Date.now()
        const totalDays = Math.max(1, Math.round((end - start) / (1000 * 60 * 60 * 24)))
        const daysActive = Math.max(0, Math.round((now - start) / (1000 * 60 * 60 * 24)))
        const pct = Math.min(100, Math.round((daysActive / totalDays) * 100))
        return { daysActive, totalDays, pct }
    })()

    // Fetch wallet balance + subscribe to real-time updates
    useEffect(() => {
        if (!dbUser?.id) return

        // Initial fetch
        const fetchBalance = async () => {
            const { data } = await (supabase
                .from('wallets')
                .select('balance')
                .eq('user_id', dbUser.id)
                .single() as any)
            if (data) setWalletBalance(data.balance || 0)
        }
        fetchBalance()

        // Real-time subscription — fires instantly on any balance change
        const channel = supabase
            .channel(`sidebar-wallet-${dbUser.id}`)
            .on(
                'postgres_changes' as any,
                {
                    event: 'UPDATE',
                    schema: 'public',
                    table: 'wallets',
                    filter: `user_id=eq.${dbUser.id}`,
                },
                (payload: any) => {
                    if (payload.new?.balance !== undefined) {
                        setWalletBalance(payload.new.balance)
                    }
                }
            )
            .subscribe()

        return () => {
            supabase.removeChannel(channel)
        }
    }, [dbUser?.id])

    // Fetch community link
    useEffect(() => {
        fetch('/api/public/config').then(response => response.ok ? response.json() : null).then(data => {
            if (data?.whatsappCommunityLink) {
                setCommunityLink(data.whatsappCommunityLink)
            }
        }).catch(console.error)
    }, [])

    const isLinkActive = (href: string) => {
        if (href === '/dashboard' || href === '/admin' || href === '/dashboard/shop') {
            return pathname === href
        }
        return pathname?.startsWith(href)
    }

    // Get role config
    const userRole = isAdmin ? 'admin' : isSubAdmin ? 'sub-admin' : (dbUser?.role || 'customer') as keyof typeof roleConfig
    const currentRole = roleConfig[userRole] || roleConfig['customer']
    const RoleIcon = currentRole.icon

    return (
        <>
            {/* Mobile Overlay */}
            {isInternalSidebarOpen && (
                <div
                    className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm lg:hidden"
                    onClick={closeSidebar}
                />
            )}

            {/* Sidebar */}
            <aside
                className={cn(
                    "fixed left-0 top-0 z-50 h-full flex flex-col transition-all duration-300 ease-in-out",
                    currentRole.sidebarBg,
                    isCollapsed ? "w-20" : "w-[260px]",
                    "transform lg:transform-none shadow-premium",
                    isInternalSidebarOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"
                )}
            >
                {/* Logo Header */}
                <div className="h-20 flex items-center justify-between px-6 border-b border-border/50">
                    <Link href="/dashboard">
                        <BrandLogo collapsed={isCollapsed} lightText={dbUser?.role === 'dealer'} />
                    </Link>
                    <Button
                        variant="ghost"
                        size="icon"
                        onClick={toggleCollapse}
                        className={cn(
                            "hidden lg:flex w-8 h-8 rounded-full",
                            dbUser?.role === 'dealer'
                                ? "text-purple-200 hover:text-white hover:bg-white/10"
                                : "text-muted-foreground hover:text-foreground hover:bg-secondary/10"
                        )}
                    >
                        {isCollapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
                    </Button>
                </div>

                {/* Profile Widget - Refined & Professional */}
                {!isCollapsed && dbUser && !resultsCheckerOnly && (
                    dbUser.role === 'dealer' ? (
                        /* Specialized Dealer Profile Widget matching the uploaded image */
                        <div className="mx-4 mt-6 p-4 rounded-2xl bg-black/15 border border-white/10 shadow-lg text-white">
                            {/* Avatar + Name + Badges */}
                            <div className="flex items-center gap-3 mb-4">
                                <div className="relative w-12 h-12 rounded-full border-2 border-white/20 flex items-center justify-center bg-white/10 shrink-0">
                                    <Crown className="w-6 h-6 text-white" />
                                    <span className="absolute bottom-0 right-0 w-3 h-3 bg-emerald-500 border border-purple-950 rounded-full" />
                                </div>
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-1.5 justify-between">
                                        <p className="text-sm font-black text-white truncate leading-none">
                                            {dbUser.first_name} {dbUser.last_name}
                                        </p>
                                        {daysRemaining !== null && (
                                            <span className="text-[10px] font-black bg-white/15 px-2 py-0.5 rounded text-white shrink-0">
                                                {daysRemaining}d
                                            </span>
                                        )}
                                    </div>
                                    <span className="inline-block text-[10px] font-bold bg-white/10 border border-white/20 text-white px-2 py-0.5 rounded-full mt-1.5 uppercase tracking-wider">
                                        Dealer
                                    </span>
                                </div>
                            </div>

                            {/* Dealer Subscription Card */}
                            <div className="p-3 rounded-xl bg-black/20 border border-white/5 mb-3">
                                <p className="text-[9px] uppercase tracking-widest text-purple-200/70 font-bold mb-1">Dealer Subscription</p>
                                <p className="text-xs font-black text-white tracking-tight mb-2">
                                    {daysRemaining !== null ? `${daysRemaining} days remaining` : 'No active subscription'}
                                </p>
                                {dealerProgress && (
                                    <>
                                        <div className="w-full h-1.5 rounded-full bg-white/10 overflow-hidden mb-1.5">
                                            <style>{`.dlr-prog { width: ${dealerProgress.pct}%; }`}</style>
                                            <div
                                                className="h-full rounded-full bg-gradient-to-r from-violet-400 to-purple-300 transition-all dlr-prog"
                                            />
                                        </div>
                                        <div className="flex justify-between text-[9px] text-purple-200/60 font-bold">
                                            <span>Day {dealerProgress.daysActive}</span>
                                            <span>{dealerProgress.totalDays} days total</span>
                                        </div>
                                    </>
                                )}
                            </div>

                            {/* Renew Dealer Access Button */}
                            <Link href="/dashboard/upgrade" className="block mb-4">
                                <Button className="w-full h-9 rounded-xl bg-white hover:bg-white/95 text-purple-900 font-bold text-xs flex items-center justify-center gap-1.5 shadow-md border-0">
                                    <Crown className="w-3.5 h-3.5 stroke-[2.5]" />
                                    Renew Dealer Access
                                </Button>
                            </Link>

                            {/* Balance Card */}
                            <div className="p-3 rounded-xl bg-black/20 border border-white/5 flex items-center justify-between">
                                <div>
                                    <p className="text-[9px] uppercase tracking-widest text-purple-200/70 font-bold mb-0.5">Balance</p>
                                    <p className="text-base font-black text-white tracking-tight leading-none mt-1">
                                        {formatCurrency(walletBalance)}
                                    </p>
                                </div>
                                {isPageAccessible('/dashboard/wallet') && (
                                    <Link href="/dashboard/wallet">
                                        <Button size="sm" className="h-7 px-3 rounded-lg bg-white/15 hover:bg-white/25 text-white font-bold text-[11px] flex items-center gap-1 border border-white/10">
                                            <Plus className="w-3 h-3 stroke-[2.5]" />
                                            Top Up
                                        </Button>
                                    </Link>
                                )}
                            </div>
                        </div>
                    ) : (
                        /* Standard Profile Widget styled with roleConfig */
                        <div className={cn("mx-4 mt-6 p-5 rounded-2xl border shadow-sm", 
                            dbUser.role === 'agent' 
                                ? "bg-blue-500/5 border-blue-200/50 dark:bg-blue-950/10 dark:border-blue-900/40 text-slate-800 dark:text-slate-100" 
                                : dbUser.role === 'customer' 
                                    ? "bg-amber-500/5 border-amber-200/50 dark:bg-amber-950/10 dark:border-amber-900/40 text-slate-800 dark:text-slate-100" 
                                    : "bg-secondary/5 border-border/50 text-foreground"
                        )}>
                            <div className="flex items-center gap-4 mb-4">
                                <div className={cn(
                                    "relative w-12 h-12 rounded-2xl flex items-center justify-center shadow-lg ring-1 ring-white/10 overflow-hidden bg-gradient-to-br",
                                    currentRole.gradient
                                )}>
                                    <RoleIcon className="w-6 h-6 text-white" />
                                    <div className="absolute inset-0 bg-gradient-to-tr from-black/20 to-transparent pointer-events-none" />
                                </div>
                                <div className="flex-1 min-w-0">
                                    <p className="text-sm font-bold text-current truncate">
                                        {dbUser?.first_name} {dbUser?.last_name}
                                    </p>
                                    <div className="flex items-center gap-1.5 mt-0.5">
                                        <span
                                            className={cn(
                                                "text-[10px] font-black px-2 py-0.5 rounded-full uppercase tracking-widest",
                                                currentRole.badgeClass
                                            )}
                                        >
                                            {currentRole.label}
                                        </span>
                                    </div>
                                </div>
                            </div>

                            {/* Wallet Balance - Clean Look */}
                            <div className="p-3 rounded-xl bg-background/50 border border-border/50 flex items-center justify-between">
                                <div>
                                    <p className="text-[9px] uppercase tracking-widest text-muted-foreground font-bold mb-0.5">Balance</p>
                                    <p className="text-lg font-black text-current tracking-tight">{formatCurrency(walletBalance)}</p>
                                </div>
                                {isPageAccessible('/dashboard/wallet') && (
                                    <Link href="/dashboard/wallet">
                                        <Button size="icon" className="w-8 h-8 rounded-lg bg-primary hover:bg-primary/90 text-primary-foreground shadow-lg shadow-primary/20">
                                            <Plus className="w-4 h-4" />
                                        </Button>
                                    </Link>
                                )}
                            </div>

                            {/* Agent Subscription - Subtle Indicator */}
                            {dbUser?.role === 'agent' && daysRemaining !== null && (
                                <div className="mt-3 flex items-center justify-between text-[11px] font-medium px-1">
                                    <span className="text-muted-foreground">Subscription</span>
                                    <span className={cn(
                                        "font-bold",
                                        daysRemaining <= 3 ? "text-red-500" : "text-emerald-500"
                                    )}>{daysRemaining}d left</span>
                                </div>
                            )}
                        </div>
                    )
                )}

                {/* Navigation */}
                <nav className="px-3 py-6 space-y-1 overflow-y-auto flex-1 scrollbar-hide">
                    {!isCollapsed && (
                        <p className="text-[10px] font-black text-muted-foreground/50 uppercase tracking-[0.2em] mb-4 px-3">
                            Main Menu
                        </p>
                    )}

                    {userNavItems
                    .filter(item => !resultsCheckerOnly || item.href === '/dashboard/results-checker')
                    .filter(item => (!hideMashup || item.label !== 'Special MTN Mashup') && (!hideExpressMtn || item.label !== 'EXPRESS MTN'))
                    .filter(item => isPageAccessible('/dashboard/data-packages') || !item.href.startsWith('/dashboard/data-packages'))
                        .map((item) => {
                        const isExternal = 'external' in item && item.external
                        const isActive = isExternal ? false : isLinkActive(item.href)
                        const inner = (
                            <div className={cn(
                                "nav-link",
                                isActive ? currentRole.sidebarNavActive : currentRole.sidebarNavHover,
                                isCollapsed && "justify-center px-0"
                            )}>
                                <item.icon className="w-5 h-5 flex-shrink-0" />
                                {!isCollapsed && <span className="text-sm font-semibold tracking-tight">{item.label}</span>}
                            </div>
                        )
                        const handleClick = () => {
                            if (window.innerWidth < 1024) closeSidebar()
                        }
                        return isExternal ? (
                            <a key={item.href} href={item.href} onClick={handleClick}>
                                {inner}
                            </a>
                        ) : (
                            <Link key={item.href} href={item.href} onClick={handleClick}>
                                {inner}
                            </Link>
                        )
                    })}

                    {/* My Shop Group — only shown when shop access is enabled */}
                    {isPageAccessible('/dashboard/shop') && !resultsCheckerOnly && (
                        <>
                            {!isCollapsed && (
                                <p className={cn(
                                    "text-[10px] font-black uppercase tracking-[0.2em] mt-8 mb-4 px-3",
                                    dbUser?.role === 'dealer' ? "text-purple-200/50" : "text-muted-foreground/50"
                                )}>
                                    My Shop
                                </p>
                            )}

                            {isCollapsed ? (
                                <Link href="/dashboard/shop" onClick={() => {
                                    if (window.innerWidth < 1024) closeSidebar()
                                }}>
                                    <div className={cn(
                                        "nav-link justify-center px-0",
                                        isOnShopRoute ? currentRole.sidebarNavActive : currentRole.sidebarNavHover
                                    )}>
                                        <Store className="w-5 h-5 flex-shrink-0" />
                                    </div>
                                </Link>
                            ) : (
                                <>
                                    <button
                                        onClick={() => setShopGroupOpen(prev => !prev)}
                                        className={cn(
                                            "nav-link w-full",
                                            isOnShopRoute ? currentRole.sidebarNavActive : currentRole.sidebarNavHover
                                        )}
                                    >
                                        <Store className="w-5 h-5 flex-shrink-0" />
                                        <span className="text-sm font-semibold tracking-tight flex-1 text-left">My Shop</span>
                                        <ChevronDown className={cn(
                                            "w-4 h-4 transition-transform duration-200",
                                            shopGroupOpen && "rotate-180"
                                        )} />
                                    </button>

                                    {shopGroupOpen && (
                                        <div className={cn(
                                            "ml-4 pl-4 border-l space-y-0.5 mt-0.5",
                                            dbUser?.role === 'dealer' ? "border-white/10" : "border-border/30"
                                        )}>
                                            {shopNavItems.map((item) => {
                                                const isActive = isLinkActive(item.href)
                                                return (
                                                    <Link key={item.href} href={item.href} onClick={() => {
                                                        if (window.innerWidth < 1024) closeSidebar()
                                                    }}>
                                                        <div className={cn(
                                                            "nav-link",
                                                            isActive ? currentRole.sidebarNavActive : currentRole.sidebarNavHover
                                                        )}>
                                                            <item.icon className="w-4 h-4 flex-shrink-0" />
                                                            <span className="text-sm font-semibold tracking-tight">{item.label}</span>
                                                        </div>
                                                    </Link>
                                                )
                                            })}
                                        </div>
                                    )}
                                </>
                            )}
                        </>
                    )}

                    {/* Join Community — appears below My Shop */}
                    {!isCollapsed && communityLink && !resultsCheckerOnly && (
                        <a
                            href={communityLink}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={() => { if (window.innerWidth < 1024) closeSidebar() }}
                            className={cn(
                                "nav-link mt-1 block",
                                dbUser?.role === 'dealer'
                                    ? "text-emerald-300 hover:bg-emerald-500/10"
                                    : "text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/10"
                            )}
                        >
                            <Users className="w-5 h-5 flex-shrink-0" />
                            <span className="text-sm font-semibold tracking-tight">Join Community</span>
                        </a>
                    )}
                    {isCollapsed && communityLink && !resultsCheckerOnly && (
                        <a
                            href={communityLink}
                            target="_blank"
                            rel="noopener noreferrer"
                            title="Join Community"
                            aria-label="Join Community"
                            onClick={() => { if (window.innerWidth < 1024) closeSidebar() }}
                            className={cn(
                                "nav-link justify-center px-0 mt-1 block",
                                dbUser?.role === 'dealer'
                                    ? "text-emerald-300 hover:bg-emerald-500/10"
                                    : "text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/10"
                            )}
                        >
                            <Users className="w-5 h-5 flex-shrink-0" />
                        </a>
                    )}

                    {(isAdmin || isSubAdmin) && !resultsCheckerOnly && (
                        <>
                            {!isCollapsed && (
                                <p className={cn(
                                    "text-[10px] font-black uppercase tracking-[0.2em] mt-8 mb-4 px-3",
                                    dbUser?.role === 'dealer' ? "text-purple-200/50" : "text-muted-foreground/50"
                                )}>
                                    Administration
                                </p>
                            )}
                            {adminNavItems.filter(item => {
                                if (isAdmin) return true
                                if (isSubAdmin) return item.href === '/admin/orders'
                                return false
                            }).map((item) => {
                                const isActive = isLinkActive(item.href)
                                const badgeCount =
                                    item.href === '/admin/afa-management' ? adminCounts.pendingAfa :
                                    item.href === '/admin/airtime' ? adminCounts.pendingAirtime :
                                    item.href === '/admin/shops/withdrawals' ? adminCounts.pendingWithdrawals :
                                    item.href === '/admin/mashup-orders' ? adminCounts.pendingMashupOrders :
                                    0
                                return (
                                    <Link key={item.href} href={item.href} onClick={() => {
                                        if (window.innerWidth < 1024) closeSidebar()
                                    }}>
                                        <div className={cn(
                                            "nav-link",
                                            isActive ? "text-red-500 bg-red-500/10 font-bold" : currentRole.sidebarNavHover,
                                            isCollapsed && "justify-center px-0"
                                        )}>
                                            <div className="relative flex-shrink-0">
                                                <item.icon className="w-5 h-5" />
                                                {isCollapsed && badgeCount > 0 && (
                                                    <span className="absolute -top-1 -right-1 w-2 h-2 bg-red-500 rounded-full border border-background" />
                                                )}
                                            </div>
                                            {!isCollapsed && <span className="text-sm tracking-tight">{item.label}</span>}
                                            {!isCollapsed && badgeCount > 0 && (
                                                <span className="ml-auto text-[10px] font-bold bg-red-500 text-white rounded-full min-w-[18px] h-[18px] flex items-center justify-center px-1 leading-none">
                                                    {badgeCount > 99 ? '99+' : badgeCount}
                                                </span>
                                            )}
                                        </div>
                                    </Link>
                                )
                            })}
                        </>
                    )}

                    {/* Payment Gateway Widget — admin only */}
                    {isAdmin && !resultsCheckerOnly && (
                        <div className={cn("mt-6", isCollapsed ? "px-0" : "px-1")}>
                            {isCollapsed ? (
                                <div className="flex justify-center py-2" title="Payment Gateway">
                                    <CreditCard className="w-5 h-5 text-muted-foreground" />
                                </div>
                            ) : (
                                <div className="rounded-xl border border-border/50 bg-muted/30 p-3 space-y-2.5">
                                    <p className="text-[9px] font-black text-muted-foreground uppercase tracking-[0.18em] flex items-center gap-1.5">
                                        <CreditCard className="w-3 h-3" />
                                        Payment Gateway
                                    </p>

                                    {/* Web toggle */}
                                    <div className="space-y-1">
                                        <p className="text-[10px] text-muted-foreground font-medium">Web</p>
                                        <div className="flex rounded-lg border border-border/60 overflow-hidden h-7 text-[11px] font-semibold">
                                            <button
                                                onClick={() => webProvider !== 'moolre' && toggleProvider('web', 'moolre')}
                                                disabled={providerSaving === 'web'}
                                                className={cn(
                                                    "flex-1 flex items-center justify-center transition-colors",
                                                    webProvider === 'moolre'
                                                        ? "bg-primary text-primary-foreground"
                                                        : "bg-background text-muted-foreground hover:bg-muted"
                                                )}
                                            >
                                                {providerSaving === 'web' && webProvider !== 'moolre' ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Moolre'}
                                            </button>
                                            <button
                                                onClick={() => webProvider !== 'paystack' && toggleProvider('web', 'paystack')}
                                                disabled={providerSaving === 'web'}
                                                className={cn(
                                                    "flex-1 flex items-center justify-center transition-colors border-l border-border/60",
                                                    webProvider === 'paystack'
                                                        ? "bg-primary text-primary-foreground"
                                                        : "bg-background text-muted-foreground hover:bg-muted"
                                                )}
                                            >
                                                {providerSaving === 'web' && webProvider !== 'paystack' ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Paystack'}
                                            </button>
                                        </div>
                                    </div>

                                    {/* Shop toggle */}
                                    <div className="space-y-1">
                                        <p className="text-[10px] text-muted-foreground font-medium">Shop</p>
                                        <div className="flex rounded-lg border border-border/60 overflow-hidden h-7 text-[11px] font-semibold">
                                            <button
                                                onClick={() => shopProvider !== 'moolre' && toggleProvider('shop', 'moolre')}
                                                disabled={providerSaving === 'shop'}
                                                className={cn(
                                                    "flex-1 flex items-center justify-center transition-colors",
                                                    shopProvider === 'moolre'
                                                        ? "bg-primary text-primary-foreground"
                                                        : "bg-background text-muted-foreground hover:bg-muted"
                                                )}
                                            >
                                                {providerSaving === 'shop' && shopProvider !== 'moolre' ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Moolre'}
                                            </button>
                                            <button
                                                onClick={() => shopProvider !== 'paystack' && toggleProvider('shop', 'paystack')}
                                                disabled={providerSaving === 'shop'}
                                                className={cn(
                                                    "flex-1 flex items-center justify-center transition-colors border-l border-border/60",
                                                    shopProvider === 'paystack'
                                                        ? "bg-primary text-primary-foreground"
                                                        : "bg-background text-muted-foreground hover:bg-muted"
                                                )}
                                            >
                                                {providerSaving === 'shop' && shopProvider !== 'paystack' ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Paystack'}
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            )}
                        </div>
                    )}

                    {/* Bottom Actions */}
                    <div className="mt-8 pt-8 border-t border-border/30 space-y-1">

                        <Button
                            variant="ghost"
                            onClick={signOut}
                            className={cn(
                                "w-full nav-link text-red-500/70 hover:text-red-500 hover:bg-red-500/5",
                                isCollapsed && "justify-center px-0"
                            )}
                        >
                            <LogOut className="w-5 h-5 flex-shrink-0" />
                            {!isCollapsed && <span className="text-sm font-semibold tracking-tight">Sign Out</span>}
                        </Button>
                    </div>
                </nav>
            </aside>
        </>
    )
}
