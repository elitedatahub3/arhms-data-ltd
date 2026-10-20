'use client'

import { Store, Settings, Clock } from 'lucide-react'
import { ShopGuidanceCard } from './ShopGuidanceCard'
import { ShopGrowthGraph } from './ShopGrowthGraph'
import { ShopAnnouncementBox } from './ShopAnnouncementBox'
import { ShopOrdersOverview } from './ShopOrdersOverview'
import { ShopQuickShare } from './ShopQuickShare'
import { ShopWalletWidget } from './ShopWalletWidget'
import { Skeleton } from '@/components/ui/skeleton'
import { Card, CardContent } from '@/components/ui/card'

interface ShopOrderDataPoint {
    created_at: string
    selling_price: number
    profit: number
}

interface ShopOrderStats {
    total: number
    completed: number
    pending: number
    processing: number
    failed: number
    revenue: number
    profit: number
}

interface ShopDashboardSectionProps {
    isLoading: boolean
    hasShop: boolean
    hasPricingConfigured: boolean
    isApproved: boolean
    shopId?: string
    brandColor?: string
    shopName?: string
    shopSlug?: string
    wallet?: { balance: number; total_earned: number; total_withdrawn: number } | null
    graphData?: ShopOrderDataPoint[]
    orderStats?: ShopOrderStats
}

function ShopSectionSkeleton() {
    return (
        <div className="space-y-4">
            <Card>
                <CardContent className="p-6">
                    <Skeleton className="h-5 w-40 mb-4" />
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                        {[...Array(4)].map((_, i) => (
                            <Skeleton key={i} className="h-20 rounded-xl" />
                        ))}
                    </div>
                </CardContent>
            </Card>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <Skeleton className="h-48 rounded-xl" />
                <Skeleton className="h-48 rounded-xl" />
            </div>
        </div>
    )
}

export function ShopDashboardSection({
    isLoading,
    hasShop,
    hasPricingConfigured,
    isApproved,
    shopId,
    brandColor,
    shopName,
    shopSlug,
    wallet = null,
    graphData = [],
    orderStats = { total: 0, completed: 0, pending: 0, processing: 0, failed: 0, revenue: 0, profit: 0 },
}: ShopDashboardSectionProps) {
    if (isLoading) {
        return <ShopSectionSkeleton />
    }

    // Case 1: No shop created yet
    if (!hasShop) {
        return (
            <ShopGuidanceCard
                icon={Store}
                iconColor="text-violet-600 dark:text-violet-400"
                iconBg="bg-violet-100 dark:bg-violet-900/30"
                title="Unlock Your Shop Dashboard"
                message="Create your shop to access revenue insights, announcements, and order tracking — all in one place."
                ctaText="Create My Shop"
                ctaLink="/dashboard/shop/setup"
            />
        )
    }

    // Case 2: Shop exists but no pricing configured AND shop is not yet approved.
    // NOTE: Skip this check if already approved — old shop owners approved before the
    // pricing system was introduced won't have shop_pricing rows, but they should still
    // see the full dashboard. An approved shop is always fully activated.
    if (!hasPricingConfigured && !isApproved) {
        return (
            <ShopGuidanceCard
                icon={Settings}
                iconColor="text-amber-600 dark:text-amber-400"
                iconBg="bg-amber-100 dark:bg-amber-900/30"
                title="Set Up Your Pricing"
                message="Configure your shop pricing to activate your storefront and start accepting customer orders."
                ctaText="Configure Pricing"
                ctaLink="/dashboard/shop/pricing"
            />
        )
    }

    // Case 3: Pricing configured (or already approved) but awaiting admin approval
    // Note: If an old shop is approved, it skips case 2 and case 3, rendering case 4.
    if (!isApproved) {
        return (
            <ShopGuidanceCard
                icon={Clock}
                iconColor="text-orange-600 dark:text-orange-400"
                iconBg="bg-orange-100 dark:bg-orange-900/30"
                title="Awaiting Admin Approval"
                message="Your shop has been submitted and is currently under review. You'll be notified once it's approved and live."
            />
        )
    }

    // Case 4: Fully set up — show the complete shop dashboard
    return (
        <div className="space-y-4 pt-2">
            {/* Shop Branding Header */}
            {shopName && (
                <div 
                    className="flex items-center gap-3 rounded-2xl p-6 text-white border border-white/10 shadow-lg"
                    style={{ backgroundColor: brandColor || '#1f2937' } as React.CSSProperties}
                >
                    <div className="p-3 bg-white/20 rounded-xl backdrop-blur-md shadow-inner">
                        <Store className="w-6 h-6 text-white" />
                    </div>
                    <div>
                        <p className="text-white/80 text-xs font-bold uppercase tracking-[0.1em] mb-1">Official Shop</p>
                        <h2 className="text-3xl font-black tracking-tight">{shopName}</h2>
                    </div>
                </div>
            )}

            {/* Quick Share Widget for Easy Promotion */}
            {shopSlug && <ShopQuickShare shopSlug={shopSlug} shopName={shopName} variant="compact" />}

            {/* Profit Wallet Action Center */}
            <ShopWalletWidget wallet={wallet} />

            {/* Shop Orders Overview */}
            <ShopOrdersOverview stats={orderStats} />

            {/* Graph + Announcement side by side on large screens */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <ShopGrowthGraph data={graphData} />
                {shopId && (
                    <ShopAnnouncementBox
                        shopId={shopId}
                        currentAnnouncement={null} // Box will manage its own state or fetch if we update it later
                    />
                )}
            </div>
        </div>
    )
}
