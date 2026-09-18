import type { Metadata } from 'next'
import { MarketplaceBottomNav } from '@/components/marketplace/marketplace-bottom-nav'

export const metadata: Metadata = {
    title: 'Classifieds - Buy & Sell Locally',
    description: 'Browse and post classifieds listings in your area',
}

// This subtree renders per request. The root layout used to force that for the
// whole app with a bare noStore(); it no longer does, so the routes that
// genuinely cannot be static now say so themselves. Here that is listing data,
// which changes constantly and must never be baked in at build time, plus
// several pages that read useSearchParams outside a Suspense boundary.
export const dynamic = 'force-dynamic'

export default function ClassifiedsLayout({
    children,
}: {
    children: React.ReactNode
}) {
    return (
        <div className="min-h-screen">
            {children}
            {/* Renders its own in-flow spacer, so clearance matches the real bar
                height (+ iOS safe area) and disappears on the routes where the
                bar hides itself. */}
            <MarketplaceBottomNav />
        </div>
    )
}
