import { Metadata } from 'next'
import Link from 'next/link'
import { ShieldCheck, Truck, MessagesSquare } from 'lucide-react'
import { ThemeProvider } from '@/components/theme-provider'
import { MarketplaceHeader } from '@/components/marketplace/marketplace-header'

export const metadata: Metadata = {
    title: 'Arhms Marketplace',
    description: 'Buy and sell locally on Ghana\'s trusted P2P marketplace',
    icons: {
        icon: '/icon.png',
    },
}

// Per-request, for the same reason as the classifieds subtree: these pages read
// live listing and conversation data that must not be baked in at build time.
// The root layout no longer forces this globally.
export const dynamic = 'force-dynamic'

export default function MarketplaceLayout({
    children,
}: {
    children: React.ReactNode
}) {
    const year = new Date().getFullYear()

    return (
        <div className="theme-marketplace min-h-screen text-foreground flex flex-col">
            <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
                <MarketplaceHeader />
                <main className="flex-1">
                    {children}
                </main>
                <footer className="border-t bg-muted/40 mt-12">
                    {/* Trust strip */}
                    <div className="border-b">
                        <div className="container grid grid-cols-1 sm:grid-cols-3 gap-4 py-6">
                            {[
                                { icon: ShieldCheck, title: 'Trade safely', desc: 'Meet in public, inspect before you pay' },
                                { icon: MessagesSquare, title: 'Chat directly', desc: 'Message sellers in-app before buying' },
                                { icon: Truck, title: 'Local delivery', desc: 'Buy and sell across Ghana' },
                            ].map(({ icon: Icon, title, desc }) => (
                                <div key={title} className="flex items-center gap-3">
                                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                                        <Icon className="h-5 w-5" />
                                    </div>
                                    <div>
                                        <p className="text-sm font-semibold">{title}</p>
                                        <p className="text-xs text-muted-foreground">{desc}</p>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>

                    <div className="container py-10">
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-6 mb-8">
                            <div>
                                <h3 className="font-semibold mb-3 text-sm">Browse</h3>
                                <nav className="flex flex-col gap-2 text-sm text-muted-foreground">
                                    <Link href="/marketplace-domain/browse" className="hover:text-primary transition-colors">
                                        All Listings
                                    </Link>
                                    <Link href="/marketplace-domain/categories" className="hover:text-primary transition-colors">
                                        Categories
                                    </Link>
                                </nav>
                            </div>
                            <div>
                                <h3 className="font-semibold mb-3 text-sm">Selling</h3>
                                <nav className="flex flex-col gap-2 text-sm text-muted-foreground">
                                    <Link href="/marketplace-domain/sell" className="hover:text-primary transition-colors">
                                        Create Listing
                                    </Link>
                                    <Link href="/marketplace-domain/my-listings" className="hover:text-primary transition-colors">
                                        My Listings
                                    </Link>
                                    <Link href="/marketplace-domain/promotions" className="hover:text-primary transition-colors">
                                        Promotions
                                    </Link>
                                </nav>
                            </div>
                            <div>
                                <h3 className="font-semibold mb-3 text-sm">Account</h3>
                                <nav className="flex flex-col gap-2 text-sm text-muted-foreground">
                                    <Link href="/marketplace-domain/orders" className="hover:text-primary transition-colors">
                                        My Orders
                                    </Link>
                                    <Link href="/marketplace-domain/favorites" className="hover:text-primary transition-colors">
                                        Favorites
                                    </Link>
                                    <Link href="/marketplace-domain/messages" className="hover:text-primary transition-colors">
                                        Messages
                                    </Link>
                                </nav>
                            </div>
                            <div>
                                <h3 className="font-semibold mb-3 text-sm">Help</h3>
                                <nav className="flex flex-col gap-2 text-sm text-muted-foreground">
                                    <Link href="/marketplace-domain" className="hover:text-primary transition-colors">
                                        How it works
                                    </Link>
                                    <a href="mailto:support@arhmsgh.com" className="hover:text-primary transition-colors">
                                        Contact Us
                                    </a>
                                </nav>
                            </div>
                        </div>
                        <div className="border-t pt-6 flex flex-col sm:flex-row items-center justify-between gap-2 text-sm text-muted-foreground">
                            <p className="font-heading font-bold text-foreground">
                                Arhms<span className="text-primary">Market</span>
                            </p>
                            <p>&copy; {year} Arhms Marketplace. All rights reserved.</p>
                        </div>
                    </div>
                </footer>
            </ThemeProvider>
        </div>
    )
}
