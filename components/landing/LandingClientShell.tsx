'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import Image from 'next/image'
import { supabase } from '@/lib/supabase'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { ThemeToggle } from '@/components/ui/theme-toggle'
import { useTheme } from 'next-themes'
import {
    ArrowRight,
    BarChart3,
    Bell,
    CheckCircle2,
    HeadphonesIcon,
    Layers,
    MessageSquare,
    Shield,
    Smartphone,
    Store,
    Wallet,
    WalletCards,
    Zap,
} from 'lucide-react'
import { BrandLogo } from '@/components/BrandLogo'
import { HeroCarousel } from '@/components/landing/HeroCarousel'

interface LandingClientShellProps {
    initialGuestUrl: string
    initialAdminPhone: string
    initialPlanPrices?: Record<TierId, number>
    initialWhatsappGroupLink?: string
    initialWhatsappChannelLink?: string
}

type TierId = '3d' | '14d' | '30d' | 'permanent'

const DEFAULT_PLAN_PRICES: Record<TierId, number> = {
    '3d': 9.99,
    '14d': 49.99,
    '30d': 99.99,
    permanent: 149.99,
}

const BRAND_BLUE = '#2563eb'
const BRAND_GRADIENT = 'linear-gradient(90deg, #7c3aed 0%, #2563eb 52%, #0ea5e9 100%)'

const planCards: Array<{ id: TierId; name: string; duration: string; badge: string; highlight?: boolean }> = [
    { id: '3d', name: '3 Days', duration: '3 Days Access', badge: 'STARTER' },
    { id: '14d', name: '2 weeks', duration: '14 Days Access', badge: 'MOST POPULAR', highlight: true },
    { id: '30d', name: '1 month', duration: '30 Days Access', badge: 'PREMIUM' },
    { id: 'permanent', name: 'Lifetime', duration: 'Permanent Access', badge: 'LIFETIME ELITE' },
]

const featureCards: Array<{ icon: any; title: string; desc: string }> = [
    { icon: Zap, title: 'Instant Delivery', desc: 'Proprietary routing ensures data hits the target number in under 3 seconds.' },
    { icon: BarChart3, title: 'Elite Pricing', desc: 'Wholesale rates optimized for maximum profit margins on every transaction.' },
    { icon: Store, title: 'Branded Stores', desc: 'Launch your own white-label storefront and build your independent brand.' },
    { icon: Wallet, title: 'Unified Wallet', desc: 'Secure, high-speed funding with instant balance settlement across all networks.' },
    { icon: Shield, title: 'Enterprise Security', desc: 'Military-grade encryption and real-time fraud monitoring for every order.' },
    { icon: HeadphonesIcon, title: '24/7 Support', desc: 'Dedicated platform support via WhatsApp and secure internal ticketing.' },
    { icon: Smartphone, title: 'Airtime Top-Up', desc: 'Sell MTN, Telecel, and AT airtime with automatic network detection and fee handling.' },
    { icon: CheckCircle2, title: 'AFA Orders', desc: 'Submit and track AFA registration requests with ID capture and live status updates.' },
    { icon: Bell, title: 'Order Tracking', desc: 'Let buyers track recent orders by phone with live status and direct support options.' },
    { icon: WalletCards, title: 'Wallet Management', desc: 'Top up, monitor balances, and review credits or debits from one dashboard.' },
]

const faqItems = [
    { q: 'How do I start selling on ARHMS?', a: 'Create an account, log in to your dashboard, fund your wallet, and then sell directly or through your own storefront link.' },
    { q: 'Can I sell both data bundles and airtime?', a: 'Yes. ARHMS supports data bundle sales and airtime top-up flows across MTN, Telecel, and AT where enabled.' },
    { q: 'How do I fund my wallet?', a: 'You can top up through Paystack or use the manual top-up process in the Wallet page, with transaction history available in dashboard.' },
    { q: 'Can I create my own shop link?', a: 'Yes. You can set up a branded storefront with your shop name, slug, logo, banner, support contacts, and community link.' },
    { q: 'How do customers track orders or report issues?', a: 'Customers can use the public order tracker, while logged-in users can review orders, notifications, and complaints from dashboard pages.' },
]

// ─────────────────────────────────────────────────────────────────────────────────
export function LandingClientShell({
    initialGuestUrl,
    initialAdminPhone,
    initialPlanPrices,
}: LandingClientShellProps) {
    const router = useRouter()
    const [headerScrolled, setHeaderScrolled] = useState(false)
    const [guestUrl] = useState(initialGuestUrl)
    const [adminPhone] = useState(initialAdminPhone)
    const [planPrices] = useState<Record<TierId, number>>(initialPlanPrices || DEFAULT_PLAN_PRICES)
    const [isLoggedIn, setIsLoggedIn] = useState(false)

    const isValidGuestUrl = Boolean(guestUrl && !guestUrl.endsWith('/shop/demo') && guestUrl.includes('/shop/'))

    useEffect(() => {
        const handleScroll = () => setHeaderScrolled(window.scrollY > 50)
        window.addEventListener('scroll', handleScroll, { passive: true })
        return () => window.removeEventListener('scroll', handleScroll)
    }, [])

    useEffect(() => {
        supabase.auth.getSession().then(({ data }) => {
            setIsLoggedIn(!!data.session)
        })
    }, [])

    useEffect(() => {
        try {
            const slug = sessionStorage.getItem('shop_sticky_slug')
            if (slug) router.replace(`/shop/${slug}`)
        } catch (_) {}
    }, [router])

    return (
        // No background of its own in light mode: the bubble field comes from
        // <body>, where it is painted once on a fixed layer (see .bg-bubbles in
        // globals.css) instead of being tiled down this whole page. In dark mode
        // this wrapper paints its gradient over it, as before — the discs belong
        // to the light surface.
        // overflow-x-clip, not hidden: `hidden` turns the wrapper into a scroll
        // container, which Android Chrome handles badly as the URL bar collapses.
        <div className="min-h-screen text-foreground overflow-x-clip dark:bg-[linear-gradient(160deg,#020617_0%,#070c1f_40%,#020617_100%)]">

            {/* ══ NAV ══════════════════════════════════════════════════════════════ */}
            {/* No backdrop-blur: the scrolled bar is 95% opaque, so the blur was
                invisible while costing a full-width GPU pass on every scroll frame. */}
            <nav className={cn(
                'fixed top-0 w-full z-[100] transition-[background-color,border-color,box-shadow] duration-200 h-16 sm:h-20 flex items-center',
                headerScrolled ? 'border-b shadow-sm border-black/10 dark:border-white/10 bg-white/95 dark:bg-[#020617]/95' : 'bg-transparent'
            )}>
                <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-10 w-full flex items-center justify-between">
                    <a href="#" className="flex items-center gap-2 min-w-0">
                        <div className="w-8 h-8 sm:w-9 sm:h-9 rounded-xl overflow-hidden bg-white flex items-center justify-center shadow-md flex-shrink-0">
                            <div className="relative w-7 h-7 sm:w-8 sm:h-8">
                                <Image src="/arhms-logo.png" alt="ARHMS Logo" fill className="object-contain" priority />
                            </div>
                        </div>
                        <span className="font-black text-sm sm:text-base lg:text-lg tracking-tight truncate text-[#111111] dark:text-white">
                            ARHMS <span className="hidden sm:inline" style={{ color: BRAND_BLUE }}>TECHNOLOGIES</span>
                        </span>
                    </a>

                    <div className="hidden md:flex items-center gap-7">
                        {[['Products','#features'],['Wallet','#plans'],['Resell','#plans'],['AFA','#support']].map(([l,h]) => (
                            <a key={l} href={h} className="text-xs font-semibold transition-colors text-black/50 dark:text-white/60">{l}</a>
                        ))}
                    </div>

                    <div className="flex items-center gap-1.5 sm:gap-3 flex-shrink-0">
                        <div className="hidden sm:block"><ThemeToggle /></div>
                        {isLoggedIn ? (
                            <Link href="/dashboard" className="text-sm font-black text-white h-9 px-4 sm:px-5 rounded-full flex items-center active:scale-95 transition-transform whitespace-nowrap" style={{ backgroundImage: BRAND_GRADIENT }}>
                                <span className="hidden sm:inline">Go to </span>Dashboard
                            </Link>
                        ) : (
                            <>
                                <Link href="/dashboard/install" className="hidden sm:flex items-center gap-1.5 text-xs font-bold rounded-full px-3 h-8 transition-colors text-black/60 dark:text-white/70 border border-black/15 dark:border-white/20">
                                    <Smartphone className="w-3 h-3" /> Install App
                                </Link>
                                <Link href="/auth/login" prefetch className="text-sm font-bold px-3 h-9 flex items-center transition-colors text-black/70 dark:text-white/80">
                                    Login
                                </Link>
                                <Link href="/auth/signup" prefetch className="text-sm font-black text-white h-9 px-5 rounded-full flex items-center active:scale-95 transition-transform" style={{ backgroundImage: BRAND_GRADIENT }}>
                                    Get Started
                                </Link>
                            </>
                        )}
                    </div>
                </div>
            </nav>

            {/* ══ HERO ══════════════════════════════════════════════════════════════ */}
            <HeroCarousel guestUrl={guestUrl} isValidGuestUrl={isValidGuestUrl} />

            {/* ══ HOW IT WORKS ══════════════════════════════════════════════════════ */}
            <section className="dark-mirror-section py-28 px-6 lg:px-10">
                <div className="max-w-7xl mx-auto">
                    <div className="text-center mb-16 space-y-4">
                        <h2 className="text-xs font-black uppercase tracking-[0.5em] text-[#2563eb]">How It Works</h2>
                        <h3 className="text-4xl md:text-6xl font-black tracking-tighter text-foreground">Start Reselling in <span className="text-[#2563eb]">3 Simple Steps</span></h3>
                        <p className="max-w-3xl mx-auto text-muted-foreground font-medium">
                            ARHMS takes you from signup to first sale with wallet funding, agent upgrade options, and a ready-to-share storefront.
                        </p>
                    </div>
                    <div className="grid md:grid-cols-3 gap-8">
                        {[
                            { step: '01', title: 'Create account', desc: 'Create your account and unlock the dashboard.' },
                            { step: '02', title: 'Fund wallet', desc: 'Fund your wallet using Paystack or manual top-up.' },
                            { step: '03', title: 'Start selling', desc: 'Sell data or airtime and share your storefront link.' },
                        ].map((item) => (
                            <div key={item.step} className="card-premium p-8 relative">
                                <span className="text-[10px] font-black uppercase tracking-[0.3em] text-[#2563eb]">{item.step}</span>
                                <h4 className="text-2xl font-black mt-4 mb-3">{item.title}</h4>
                                <p className="text-muted-foreground font-medium">{item.desc}</p>
                            </div>
                        ))}
                    </div>
                    <div className="flex flex-col sm:flex-row gap-4 justify-center mt-10">
                        <Link href="/auth/signup"><Button className="h-12 px-8 rounded-2xl font-black uppercase tracking-widest">Create Account</Button></Link>
                        <a href="#plans"><Button variant="outline" className="h-12 px-8 rounded-2xl font-black uppercase tracking-widest">See Agent Plans</Button></a>
                    </div>
                </div>
            </section>

            {/* ══ FEATURES ══════════════════════════════════════════════════════════ */}
            <section id="features" className="landing-section py-32 px-6 lg:px-10">
                <div className="max-w-7xl mx-auto">
                    <div className="text-center mb-20 space-y-4">
                        <h2 className="text-xs font-black uppercase tracking-[0.5em] text-[#2563eb]">Capabilities</h2>
                        <h3 className="text-4xl md:text-6xl font-black tracking-tighter text-foreground">
                            Everything You Need to <span className="text-[#2563eb]">Sell and Support Customers</span>
                        </h3>
                        <p className="max-w-3xl mx-auto text-muted-foreground font-medium">
                            Keep the speed of instant delivery while adding the operational tools resellers use every day.
                        </p>
                    </div>
                    <div className="grid md:grid-cols-2 xl:grid-cols-5 gap-6">
                        {featureCards.map((feature, i) => (
                            <div key={`${feature.title}-${i}`} className="card-premium p-7 group hover:border-[#2563eb]/50 transition-colors duration-300">
                                <div className="w-12 h-12 rounded-2xl bg-[#2563eb]/10 flex items-center justify-center mb-6 group-hover:bg-[#2563eb] transition-colors">
                                    <feature.icon className="w-5 h-5 text-[#2563eb] group-hover:text-white transition-colors" />
                                </div>
                                <h4 className="text-xl font-black text-foreground mb-3 tracking-tight">{feature.title}</h4>
                                <p className="text-sm text-muted-foreground font-medium leading-relaxed">{feature.desc}</p>
                            </div>
                        ))}
                    </div>
                    <div className="flex flex-col sm:flex-row gap-4 justify-center mt-12">
                        <Link href="/auth/signup"><Button className="h-12 px-8 rounded-2xl font-black uppercase tracking-widest">Open Account</Button></Link>
                        {isValidGuestUrl && <a href={guestUrl}><Button variant="outline" className="h-12 px-8 rounded-2xl font-black uppercase tracking-widest">View Guest Store</Button></a>}
                    </div>
                </div>
            </section>

            {/* ══ PLANS ═══════════════════════════════════════════════════════════ */}
            <section id="plans" className="dark-mirror-section py-32 px-6 lg:px-10">
                <div className="max-w-7xl mx-auto">
                    <div className="text-center mb-16 space-y-4">
                        <h2 className="text-xs font-black uppercase tracking-[0.5em] text-[#2563eb]">Reseller Plans</h2>
                        <h3 className="text-4xl md:text-6xl font-black tracking-tighter text-foreground">Choose Your <span className="text-[#2563eb]">Agent Plan</span></h3>
                        <p className="max-w-3xl mx-auto text-muted-foreground font-medium">
                            Every plan unlocks the same reseller toolkit. Pick the access length that matches how you want to grow.
                        </p>
                    </div>
                    <div className="grid sm:grid-cols-2 xl:grid-cols-4 gap-6">
                        {planCards.map((plan) => (
                            <Card key={plan.id} className={cn('card-premium p-8 relative overflow-hidden', plan.highlight && 'border-[#2563eb]/50 shadow-[0_10px_40px_-10px_rgba(37,99,235,0.3)]')}>
                                <div className="absolute -top-16 -right-16 w-56 h-56 rounded-full bg-[radial-gradient(circle,rgba(37,99,235,0.14)_0%,transparent_65%)]" />
                                <div className="relative z-10 space-y-4">
                                    <p className="inline-flex text-[10px] font-black uppercase tracking-[0.18em] px-3 py-1 rounded-full bg-[#2563eb] text-white">{plan.badge}</p>
                                    <h4 className="text-3xl font-black tracking-tight">{plan.name}</h4>
                                    <p className="text-xs font-black uppercase tracking-widest text-muted-foreground">{plan.duration}</p>
                                    <p className="text-4xl font-black text-[#2563eb]">GHS {planPrices[plan.id].toFixed(2)}</p>
                                    <Link href="/auth/signup"><Button className="w-full h-12 rounded-2xl font-black uppercase tracking-widest">Become an Agent</Button></Link>
                                </div>
                            </Card>
                        ))}
                    </div>
                    <div className="mt-10 card-premium p-8">
                        <p className="text-xs font-black uppercase tracking-[0.3em] text-[#2563eb] mb-4">Included in all plans</p>
                        <div className="grid md:grid-cols-2 xl:grid-cols-4 gap-3 text-sm font-bold text-muted-foreground">
                            {['Exclusive Wholesale Pricing','Priority Customer Support','0% Top Up Charges (Admin Manual Top Up)','Faster Order Processing','Bulk Order Import Feature','New Exclusive UI Design Features','Shop Storefront Feature (Live)'].map((item) => (
                                <div key={item} className="flex items-start gap-2">
                                    <CheckCircle2 className="w-4 h-4 mt-0.5 text-[#2563eb]" /><span>{item}</span>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            </section>

            {/* ══ NETWORKS ════════════════════════════════════════════════════════ */}
            <section id="networks" className="landing-section py-32 px-6 lg:px-10">
                <div className="max-w-7xl mx-auto">
                    <div className="grid lg:grid-cols-2 gap-20 items-center">
                        <div className="space-y-10">
                            <div className="space-y-6">
                                <h2 className="text-5xl md:text-7xl font-black tracking-tighter leading-none">
                                    Universal <br /><span className="text-[#2563eb]">Connectivity.</span>
                                </h2>
                                <p className="text-xl text-muted-foreground font-medium max-w-lg">
                                    One platform, every network. We provide deep integration with all major Ghanaian carriers.
                                </p>
                            </div>
                            <div className="space-y-4">
                                {[
                                    { name: 'MTN Ghana', status: 'Optimal', color: 'bg-yellow-400' },
                                    { name: 'Telecel Ghana', status: 'Stable', color: 'bg-red-500' },
                                    { name: 'AT (AirtelTigo)', status: 'Stable', color: 'bg-orange-500' },
                                ].map((net, i) => (
                                    <div key={i} className="flex items-center justify-between p-6 rounded-2xl dark:bg-[#1a1a1a] bg-gray-100 border border-border/50">
                                        <div className="flex items-center gap-4">
                                            <div className={cn('w-3 h-3 rounded-full animate-pulse', net.color)} />
                                            <span className="font-bold text-lg">{net.name}</span>
                                        </div>
                                        <span className="text-[10px] font-black uppercase tracking-widest text-[#2563eb]">{net.status}</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                        <div className="relative">
                            <div className="absolute -inset-16 -z-10 bg-[radial-gradient(ellipse_at_center,rgba(37,99,235,0.18)_0%,transparent_70%)]" />
                            <Card className="card-premium p-10 overflow-hidden relative">
                                <div className="absolute top-0 right-0 p-8 opacity-10"><Layers className="w-40 h-40" /></div>
                                <div className="relative z-10 space-y-8">
                                    <div className="space-y-2">
                                        <p className="text-[10px] font-black uppercase tracking-[0.4em] text-[#2563eb]">System Status</p>
                                        <p className="text-4xl font-black">99.9% Uptime</p>
                                    </div>
                                    <div className="grid grid-cols-2 gap-8">
                                        <div>
                                            <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground mb-1">Response Time</p>
                                            <p className="text-2xl font-black">1.2s</p>
                                        </div>
                                        <div>
                                            <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground mb-1">Success Rate</p>
                                            <p className="text-2xl font-black">99.98%</p>
                                        </div>
                                    </div>
                                    <div className="h-2 w-full dark:bg-[#2a2a2a] bg-gray-200 rounded-full overflow-hidden">
                                        <div className="h-full w-[99%] bg-[#2563eb]" />
                                    </div>
                                </div>
                            </Card>
                        </div>
                    </div>
                </div>
            </section>

            {/* ══ STOREFRONT ══════════════════════════════════════════════════════ */}
            <section className="dark-mirror-section py-32 px-6 lg:px-10">
                <div className="max-w-7xl mx-auto">
                    <div className="grid lg:grid-cols-2 gap-12 items-center">
                        <div className="space-y-6">
                            <h2 className="text-4xl md:text-6xl font-black tracking-tighter">
                                Your Own <span className="text-[#2563eb]">Branded Storefront</span>
                            </h2>
                            <p className="text-lg text-muted-foreground font-medium">
                                Create a public shop link with your name, logo, banner, colors, community link, data packages, airtime checkout, order tracking, and a dedicated about page.
                            </p>
                            <div className="grid sm:grid-cols-2 gap-3 text-sm">
                                {['Public shop URL','Brand colors and logo','Banner image','Data package tabs by network','Airtime recharge','About Shop & Terms page','WhatsApp support','Community invite link','Track My Orders'].map((item) => (
                                    <div key={item} className="flex items-center gap-2 font-bold text-muted-foreground">
                                        <CheckCircle2 className="w-4 h-4 text-[#2563eb]" /><span>{item}</span>
                                    </div>
                                ))}
                            </div>
                            <div className="flex flex-col sm:flex-row gap-4 pt-2">
                                {isValidGuestUrl && <a href={guestUrl}><Button className="h-12 px-8 rounded-2xl font-black uppercase tracking-widest">View Guest Store Demo</Button></a>}
                                <Link href="/shop/status"><Button variant="outline" className="h-12 px-8 rounded-2xl font-black uppercase tracking-widest">Track Demo Order</Button></Link>
                            </div>
                        </div>
                        <Card className="card-premium p-8">
                            <div className="rounded-3xl border border-border/40 bg-background/80 overflow-hidden">
                                <div className="h-10 px-4 flex items-center gap-2 border-b border-border/40">
                                    <div className="w-2.5 h-2.5 rounded-full bg-red-400" />
                                    <div className="w-2.5 h-2.5 rounded-full bg-yellow-400" />
                                    <div className="w-2.5 h-2.5 rounded-full bg-green-400" />
                                    <span className="ml-2 text-[10px] font-black uppercase tracking-widest text-muted-foreground">Storefront Preview</span>
                                </div>
                                <div className="p-6 space-y-5">
                                    <div className="rounded-2xl bg-primary p-5 text-primary-foreground">
                                        <p className="text-[10px] font-black uppercase tracking-widest opacity-70">Shop Header</p>
                                        <p className="text-2xl font-black mt-1">Your Shop Name</p>
                                        <p className="text-sm opacity-80">Branded checkout for data and airtime sales.</p>
                                    </div>
                                    <div className="grid grid-cols-2 gap-3">
                                        {['MTN Bundles','Telecel Bundles','AT Bundles','Airtime Top-Up'].map((block) => (
                                            <div key={block} className="rounded-xl border border-border/40 p-3">
                                                <p className="text-xs font-black uppercase tracking-wider text-muted-foreground">{block}</p>
                                            </div>
                                        ))}
                                    </div>
                                    <div className="rounded-xl border border-border/40 p-3 flex items-center justify-between">
                                        <span className="text-xs font-black uppercase tracking-wider text-muted-foreground">Track My Orders</span>
                                        <ArrowRight className="w-4 h-4 text-[#2563eb]" />
                                    </div>
                                </div>
                            </div>
                        </Card>
                    </div>
                </div>
            </section>

            {/* ══ TESTIMONIALS ════════════════════════════════════════════════════ */}
            <section className="landing-section py-32 px-6 lg:px-10">
                <div className="max-w-7xl mx-auto">
                    <div className="text-center mb-16 space-y-4">
                        <h2 className="text-xs font-black uppercase tracking-[0.5em] text-[#2563eb]">Testimonials</h2>
                        <h3 className="text-4xl md:text-6xl font-black tracking-tighter">Built for Real <span className="text-[#2563eb]">Ghanaian Resellers</span></h3>
                    </div>
                    <div className="grid md:grid-cols-3 gap-6">
                        {[
                            { quote: 'I started with data bundles, then added airtime sales and my own shop link. Customers can order and track status without calling me every time.', name: 'Akosua M.', role: 'Reseller, Accra' },
                            { quote: 'The wallet flow and storefront saved me from taking orders manually in WhatsApp all day. I can fund once and keep selling.', name: 'Kwame B.', role: 'Campus Vendor, Kumasi' },
                            { quote: 'What I like most is the visibility: shop branding, order history, and complaints support all live in one place.', name: 'Efua N.', role: 'Small Business Owner, Takoradi' },
                        ].map((item) => (
                            <Card key={item.name} className="card-premium p-8">
                                <MessageSquare className="w-6 h-6 text-[#2563eb] mb-4" />
                                <p className="text-muted-foreground font-medium leading-relaxed mb-6">&ldquo;{item.quote}&rdquo;</p>
                                <div>
                                    <p className="font-black text-foreground">{item.name}</p>
                                    <p className="text-xs font-black uppercase tracking-widest text-[#2563eb]">{item.role}</p>
                                </div>
                            </Card>
                        ))}
                    </div>
                    <div className="flex flex-col sm:flex-row gap-4 justify-center mt-10">
                        <Link href="/auth/signup"><Button className="h-12 px-8 rounded-2xl font-black uppercase tracking-widest">Create Free Account</Button></Link>
                        {isValidGuestUrl && <a href={guestUrl}><Button variant="outline" className="h-12 px-8 rounded-2xl font-black uppercase tracking-widest">Open Guest Store</Button></a>}
                    </div>
                </div>
            </section>

            {/* ══ FAQ ═════════════════════════════════════════════════════════════ */}
            <section id="support" className="dark-mirror-section py-32 px-6 lg:px-10">
                <div className="max-w-7xl mx-auto">
                    <div className="text-center mb-16 space-y-4">
                        <h2 className="text-xs font-black uppercase tracking-[0.5em] text-[#2563eb]">FAQ</h2>
                        <h3 className="text-4xl md:text-6xl font-black tracking-tighter">Questions New Resellers <span className="text-[#2563eb]">Ask First</span></h3>
                    </div>
                    <div className="grid lg:grid-cols-2 gap-5">
                        {faqItems.map((item) => (
                            <details key={item.q} className="card-premium p-6 group open:border-[#2563eb]/50">
                                <summary className="list-none cursor-pointer flex items-start justify-between gap-4">
                                    <span className="text-lg font-black">{item.q}</span>
                                    <ArrowRight className="w-4 h-4 mt-1 text-[#2563eb] transition-transform group-open:rotate-90" />
                                </summary>
                                <p className="mt-4 text-muted-foreground font-medium leading-relaxed">{item.a}</p>
                            </details>
                        ))}
                    </div>
                    <div className="flex flex-col sm:flex-row gap-4 justify-center mt-10">
                        <Link href="/auth/signup"><Button className="h-12 px-8 rounded-2xl font-black uppercase tracking-widest">Create Free Account</Button></Link>
                        <Link href="/shop/status"><Button variant="outline" className="h-12 px-8 rounded-2xl font-black uppercase tracking-widest">Track an Order</Button></Link>
                    </div>
                </div>
            </section>

            {/* ══ CTA BANNER ══════════════════════════════════════════════════════ */}
            <section className="landing-section py-32 px-6 lg:px-10">
                <div className="max-w-7xl mx-auto">
                    <Card className="relative overflow-hidden rounded-[40px] border-0 bg-foreground p-12 md:p-24 text-background text-center shadow-2xl">
                        <div className="absolute top-0 right-0 w-[700px] h-[700px] rounded-full bg-[radial-gradient(circle,rgba(37,99,235,0.22)_0%,transparent_65%)] -mr-80 -mt-80" />
                        <div className="relative z-10 space-y-12">
                            <h2 className="text-5xl md:text-8xl font-black tracking-tighter leading-[0.9]">
                                Ready to Upgrade <br /><span className="text-[#2563eb]">Your Business?</span>
                            </h2>
                            <p className="max-w-2xl mx-auto text-xl font-medium opacity-70">
                                Stop struggling with slow deliveries and poor rates. Step into the future of data and airtime reselling with ARHMS TECHNOLOGIES.
                            </p>
                            <div className="flex flex-col sm:flex-row gap-6 justify-center">
                                <Link href="/auth/signup" className="w-full sm:w-auto">
                                    <Button className="w-full sm:w-auto h-20 px-16 rounded-3xl bg-primary text-primary-foreground font-black text-xl uppercase tracking-widest shadow-blue-premium hover:scale-105 active:scale-95 transition-all">
                                        Create Account
                                    </Button>
                                </Link>
                                <Link href="/auth/login" className="w-full sm:w-auto">
                                    <Button variant="outline" className="w-full sm:w-auto h-20 px-16 rounded-3xl border-background/20 bg-background/5 text-background font-black text-xl uppercase tracking-widest hover:bg-background/10 transition-all">
                                        Sign In
                                    </Button>
                                </Link>
                            </div>
                        </div>
                    </Card>
                </div>
            </section>

            {/* ══ FOOTER ══════════════════════════════════════════════════════════ */}
            <footer className="py-20 px-6 lg:px-10 border-t border-border/40">
                <div className="max-w-7xl mx-auto">
                    <div className="grid md:grid-cols-4 gap-16 mb-20">
                        <div className="md:col-span-2 space-y-8">
                            <div className="flex items-center gap-3">
                                <BrandLogo hideText className="scale-75 origin-left" />
                                <span className="font-black text-xl tracking-tighter">ARHMS <span style={{ color: BRAND_BLUE }}>TECHNOLOGIES</span></span>
                            </div>
                            <p className="text-muted-foreground font-medium max-w-sm">
                                Smart Solutions. Endless Possibilities. Ghana&apos;s trusted data and airtime reselling platform built for speed, security, and reliability.
                            </p>
                            <div className="flex flex-wrap gap-3">
                                <Link href="/auth/signup"><Button className="h-10 px-6 rounded-xl text-[10px] font-black uppercase tracking-widest">Create Free Account</Button></Link>
                                <Link href="/auth/login"><Button variant="outline" className="h-10 px-6 rounded-xl text-[10px] font-black uppercase tracking-widest">Login</Button></Link>
                                {isValidGuestUrl && <a href={guestUrl}><Button variant="outline" className="h-10 px-6 rounded-xl text-[10px] font-black uppercase tracking-widest">Open Guest Store</Button></a>}
                                <Link href="/shop/status"><Button variant="outline" className="h-10 px-6 rounded-xl text-[10px] font-black uppercase tracking-widest">Track Order</Button></Link>
                            </div>
                        </div>
                        <div className="space-y-6">
                            <p className="text-[10px] font-black uppercase tracking-[0.4em] text-[#2563eb]">Platform</p>
                            <ul className="space-y-4 text-sm font-bold text-muted-foreground">
                                <li><a href="#features" className="hover:text-[#2563eb] transition-colors">Features</a></li>
                                <li><a href="#plans" className="hover:text-[#2563eb] transition-colors">Reseller Plans</a></li>
                                <li><Link href="/shop/status" className="hover:text-[#2563eb] transition-colors">Order Tracking</Link></li>
                            </ul>
                        </div>
                        <div className="space-y-6">
                            <p className="text-[10px] font-black uppercase tracking-[0.4em] text-[#2563eb]">Legal</p>
                            <ul className="space-y-4 text-sm font-bold text-muted-foreground">
                                <li><Link href="/terms" className="hover:text-[#2563eb] transition-colors">Terms of Service</Link></li>
                                <li><Link href="/privacy" className="hover:text-[#2563eb] transition-colors">Privacy Protocol</Link></li>
                                <li><Link href="/contact" className="hover:text-[#2563eb] transition-colors">Secure Contact</Link></li>
                            </ul>
                        </div>
                    </div>
                    <div className="flex flex-col md:flex-row justify-between items-center gap-8 pt-10 border-t border-border/40 opacity-60">
                        <p className="text-[10px] font-black uppercase tracking-widest">© 2026 ARHMS TECHNOLOGIES LTD • ALL RIGHTS RESERVED</p>
                        <div className="flex gap-8 text-[10px] font-black uppercase tracking-widest">
                            <span>WEST AFRICA</span>
                            <span>HQ: ACCRA, GHANA</span>
                            {adminPhone ? <span>SUPPORT: {adminPhone}</span> : null}
                        </div>
                    </div>
                </div>
            </footer>
        </div>
    )
}
