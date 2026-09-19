'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useAuth } from '@/contexts/auth-context'
import { useDashboardSummary } from '@/hooks/use-dashboard-summary'
import { cn, formatCurrency } from '@/lib/utils'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import {
    ShoppingCart,
    CheckCircle2,
    Clock,
    XCircle,
    Wallet,
    Package,
    AlertCircle,
    Plus,
    Star,
    Store,
    Phone,
    Zap,
    Receipt,
} from 'lucide-react'
import { RoleGreetingBox } from '@/components/dashboard/RoleGreetingBox'
import { RecentOrdersWidget } from '@/components/dashboard/RecentOrdersWidget'
import { BusinessPerformanceWidget } from '@/components/dashboard/BusinessPerformanceWidget'
import { ShopDashboardSection } from '@/components/dashboard/ShopDashboardSection'
import { TodaysOrdersSummary } from '@/components/dashboard/TodaysOrdersSummary'
import { DealerWelcomeModal } from '@/components/dashboard/DealerWelcomeModal'
import { DealerExpiryBanner } from '@/components/dashboard/DealerExpiryBanner'

interface DashboardStats {
    totalOrders: number
    completedOrders: number
    processingOrders: number
    failedOrders: number
    pendingOrders: number
    walletBalance: number
}

interface ShopStatus {
    isLoading: boolean
    hasShop: boolean
    hasPricingConfigured: boolean
    isApproved: boolean
    shopId?: string
    shopName?: string
    brandColor?: string
    wallet?: { balance: number; total_earned: number; total_withdrawn: number } | null
    graphData?: { created_at: string; selling_price: number; profit: number }[]
    orderStats?: {
        total: number
        completed: number
        pending: number
        processing: number
        failed: number
        revenue: number
        profit: number
    }
}


export default function DashboardPage() {
    const { dbUser } = useAuth()

    // One request for the whole screen (see app/api/dashboard/summary/route.ts),
    // cached by SWR — so coming back to the dashboard paints from cache instead
    // of re-running twenty queries and flashing skeletons.
    const { data: summary, isLoading } = useDashboardSummary()
    const stats: DashboardStats | null = summary?.stats ?? null
    const shopStatus: ShopStatus = summary
        ? { isLoading: false, ...summary.shop }
        : { isLoading: true, hasShop: false, hasPricingConfigured: false, isApproved: false }

    const DEALER_FEATURE_LAUNCH = new Date('2026-05-29T00:00:00Z')
    const isNewUser = dbUser?.created_at ? new Date(dbUser.created_at) >= DEALER_FEATURE_LAUNCH : false
    const [dealerPromoEnabled, setDealerPromoEnabled] = useState(false)
    const showDealerModal = dbUser?.role === 'customer' && !(dbUser as any)?.dealer_claimed_at && isNewUser && dealerPromoEnabled
    const dealerExpiresAt = (dbUser as any)?.dealer_expires_at as string | null


    useEffect(() => {
        fetch('/api/admin-settings?keys=dealer_promo_enabled')
            .then(r => r.ok ? r.json() : null)
            .then(d => { if (d) setDealerPromoEnabled(d.dealer_promo_enabled === 'true') })
            .catch(() => {})
    }, [])

    if (isLoading) {
        return (
            <div className="space-y-6">
                <div className="grid grid-cols-2 gap-3 sm:gap-4">
                    {[...Array(4)].map((_, i) => (
                        <Card key={i}>
                            <CardContent className="p-4 sm:p-6">
                                <Skeleton className="h-4 w-24 mb-2" />
                                <Skeleton className="h-8 w-16" />
                            </CardContent>
                        </Card>
                    ))}
                </div>
            </div>
        )
    }



    return (
        <div className="space-y-8 animate-slow-fade">
            {/* Dealer Welcome Modal — shown once to eligible customers */}
            {showDealerModal && (
                <DealerWelcomeModal onClaimed={() => window.location.reload()} />
            )}

            {/* Dealer Expiry Banner — shown when expiry is within 7 days or past */}
            {dbUser?.role === 'dealer' && dealerExpiresAt && (
                <DealerExpiryBanner dealerExpiresAt={dealerExpiresAt} />
            )}

            {/* Header Section with Tutorial Button */}
            <div className="flex items-center justify-between gap-4">
                <div>
                    <h2 className="text-2xl sm:text-3xl font-black tracking-tight text-foreground">Dashboard</h2>
                    <p className="text-sm font-medium text-muted-foreground mt-1">Manage your business and track your performance</p>
                </div>
            </div>

            {/* Dynamic Role Greeting Box */}
            <RoleGreetingBox stats={stats!} />

            {/* Premium Wallet & Business Card */}
            <div className="grid lg:grid-cols-3 gap-6">
                <Card id="wallet-card" className="lg:col-span-2 overflow-hidden border border-border/70 shadow-sm bg-gradient-to-br from-primary to-blue-700 dark:to-blue-800 group">
                    <CardContent className="p-8 relative">
                        {/* Decorative pattern */}
                        <div className="absolute top-0 right-0 w-64 h-64 bg-white/10 rounded-full blur-3xl -mr-32 -mt-32 pointer-events-none" />
                        <div className="absolute bottom-0 left-0 w-32 h-32 bg-black/20 rounded-full blur-2xl -ml-16 -mb-16 pointer-events-none" />
                        
                        <div className="relative z-10 flex flex-col md:flex-row md:items-center justify-between gap-8">
                            <div>
                                <div className="flex items-center gap-2 mb-3 opacity-90">
                                    <div className="w-8 h-8 rounded-lg bg-white/20 flex items-center justify-center">
                                        <Wallet className="w-4 h-4 text-primary-foreground" />
                                    </div>
                                    <p className="text-primary-foreground font-bold tracking-widest text-xs uppercase">Available Balance</p>
                                </div>
                                <p className="text-5xl md:text-6xl font-black text-primary-foreground tracking-tighter">
                                    {formatCurrency(stats?.walletBalance || 0)}
                                </p>
                            </div>
                            
                            <Link href="/dashboard/wallet" className="w-full md:w-auto">
                                <Button variant="outline" className="w-full md:w-auto bg-white text-primary hover:bg-white/90 border-0 font-black h-14 px-10 rounded-2xl shadow-xl shadow-black/15 text-lg transition-all hover:scale-[1.02] active:scale-95">
                                    <Plus className="w-6 h-6 mr-2 stroke-[3]" />
                                    Refill Wallet
                                </Button>
                            </Link>
                        </div>
                    </CardContent>
                </Card>

                <Card className="card-premium p-8 flex flex-col justify-between group overflow-hidden relative bg-card">
                    <div className="absolute top-0 right-0 p-4 opacity-5 group-hover:opacity-10 transition-opacity">
                        <Store className="w-24 h-24" />
                    </div>
                    <div className="relative z-10">
                        <p className="text-[10px] font-black uppercase tracking-[0.2em] text-muted-foreground mb-4">Quick Stats</p>
                        <h3 className="text-2xl font-black text-foreground mb-2">My Shop</h3>
                        <p className="text-sm text-muted-foreground font-medium leading-relaxed">
                            {shopStatus.hasShop ? `Managing "${shopStatus.shopName}"` : "You haven't set up your shop yet."}
                        </p>
                    </div>
                    <Link href="/dashboard/shop" className="relative z-10 mt-6">
                        <Button variant="secondary" className="w-full font-bold rounded-xl h-12">
                            {shopStatus.hasShop ? "Go to Shop Profile" : "Create My Shop"}
                        </Button>
                    </Link>
                </Card>
            </div>

            {/* Core Stats Section */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 sm:gap-6">
                {[
                    { label: 'Total Orders', value: stats?.totalOrders, icon: ShoppingCart, color: 'bg-blue-500', text: 'text-blue-500' },
                    { label: 'Completed', value: stats?.completedOrders, icon: CheckCircle2, color: 'bg-emerald-500', text: 'text-emerald-500' },
                    { label: 'Processing', value: stats?.processingOrders, icon: Clock, color: 'bg-amber-500', text: 'text-amber-500' },
                    { label: 'Failed', value: stats?.failedOrders, icon: XCircle, color: 'bg-red-500', text: 'text-red-500' },
                ].map((stat, idx) => (
                    <Card key={idx} className="card-premium group hover:border-primary/30">
                        <CardContent className="p-6">
                            <div className="flex flex-col gap-4">
                                <div className={cn("w-12 h-12 rounded-2xl flex items-center justify-center text-white shadow-lg", stat.color)}>
                                    <stat.icon className="w-6 h-6" />
                                </div>
                                <div>
                                    <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">{stat.label}</p>
                                    <p className="text-3xl font-black text-foreground mt-1 tracking-tight">{stat.value}</p>
                                </div>
                            </div>
                        </CardContent>
                    </Card>
                ))}
            </div>

            {/* Business Performance & Recent Activity */}
            <div className="grid lg:grid-cols-3 gap-8">
                <div className="lg:col-span-2 space-y-8">
                    <BusinessPerformanceWidget data={summary?.performance} />
                    <RecentOrdersWidget orders={summary?.recentOrders} />
                </div>
                <div className="space-y-8">
                    <TodaysOrdersSummary data={summary?.today} />
                    
                    {/* Simplified Quick Actions */}
                    <Card className="card-premium">
                        <CardHeader className="pb-4">
                            <CardTitle className="text-lg font-black tracking-tight">Quick Links</CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-2">
                            {[
                                { href: '/dashboard/airtime', label: 'Buy Airtime', icon: Phone },
                                { href: '/dashboard/utilities', label: 'Pay Bills', icon: Receipt },
                                { href: '/dashboard/data-packages', label: 'Buy Data Bundles', icon: Package },
                                { href: '/dashboard/wallet', label: 'Wallet History', icon: Wallet },
                                { href: '/dashboard/complaints', label: 'Help & Support', icon: AlertCircle },
                                { href: '/dashboard/shop', label: 'Store Settings', icon: Store },
                            ].map((link, i) => (
                                <Link key={i} href={link.href}>
                                    <div className="flex items-center gap-3 p-3 rounded-xl hover:bg-secondary/50 transition-colors group cursor-pointer">
                                        <div className="w-9 h-9 rounded-lg bg-secondary flex items-center justify-center group-hover:bg-primary/10 group-hover:text-primary transition-colors">
                                            <link.icon className="w-4 h-4" />
                                        </div>
                                        <span className="text-sm font-bold text-foreground/80 group-hover:text-foreground transition-colors">{link.label}</span>
                                    </div>
                                </Link>
                            ))}
                        </CardContent>
                    </Card>
                </div>
            </div>

            {/* Shop Management (If applicable) */}
            <ShopDashboardSection
                isLoading={shopStatus.isLoading}
                hasShop={shopStatus.hasShop}
                hasPricingConfigured={shopStatus.hasPricingConfigured}
                isApproved={shopStatus.isApproved}
                shopId={shopStatus.shopId}
                shopName={shopStatus.shopName}
                brandColor={shopStatus.brandColor}
                shopSlug={(shopStatus as any).shopSlug}
                wallet={shopStatus.wallet}
                graphData={shopStatus.graphData}
                orderStats={shopStatus.orderStats}
            />
        </div>
    )
}
