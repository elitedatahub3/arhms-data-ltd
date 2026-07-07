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
    Code2,
    GraduationCap,
    HeadphonesIcon,
    Layers,
    MessageSquare,
    Monitor,
    Shield,
    Smartphone,
    Store,
    Wallet,
    WalletCards,
    Zap,
} from 'lucide-react'
import { BrandLogo } from '@/components/BrandLogo'

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
const BRAND_PURPLE = '#7c3aed'
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

// ── Dot indicators ───────────────────────────────────────────────────────────────
function SlideDots({ current, total, onDotClick, dark }: { current: number; total: number; onDotClick: (i: number) => void; dark?: boolean }) {
    return (
        <div className="flex items-center justify-between mt-6 pt-5" style={{ borderTop: dark ? '1px solid rgba(255,255,255,0.08)' : '1px solid rgba(37,99,235,0.10)' }}>
            <div className="flex items-center gap-1.5">
                {Array.from({ length: total }).map((_, i) => (
                    <button
                        key={i}
                        type="button"
                        onClick={() => onDotClick(i)}
                        style={{
                            height: 8,
                            width: i === current ? 28 : 8,
                            borderRadius: 99,
                            transition: 'all 0.3s ease',
                            backgroundColor: i === current ? BRAND_BLUE : dark ? 'rgba(255,255,255,0.18)' : 'rgba(37,99,235,0.16)',
                        }}
                        aria-label={`Slide ${i + 1}`}
                    />
                ))}
            </div>
            <Link
                href="/shop/status"
                className="flex items-center gap-1.5 text-[10px] font-bold transition-colors active:opacity-70"
                style={{ color: dark ? 'rgba(255,255,255,0.3)' : 'rgba(37,99,235,0.32)' }}
            >
                <CheckCircle2 className="w-3 h-3" /> Track an Order
            </Link>
        </div>
    )
}

// ── Hero CTA buttons ──────────────────────────────────────────────────────────────
function HeroBtn({ href, variant = 'primary', isDark = true, children, className }: { href: string; variant?: 'primary' | 'white' | 'dark'; isDark?: boolean; children: React.ReactNode; className?: string }) {
    const base: React.CSSProperties = {
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
        width: '100%', height: 56, borderRadius: 999,
        fontWeight: 800, fontSize: 13, letterSpacing: '0.08em', textTransform: 'uppercase',
        cursor: 'pointer', transition: 'opacity 0.2s, transform 0.2s', textDecoration: 'none',
        border: 'none', outline: 'none',
    }
    const styles: Record<string, React.CSSProperties> = {
        primary: { ...base, backgroundImage: BRAND_GRADIENT, color: '#fff', boxShadow: '0 12px 30px rgba(37,99,235,0.28)' },
        white:   { ...base, backgroundColor: isDark ? '#fff' : 'transparent', color: '#111', border: isDark ? '1.5px solid rgba(37,99,235,0.16)' : '1.5px solid rgba(37,99,235,0.22)' },
        dark:    { ...base, backgroundColor: isDark ? 'rgba(255,255,255,0.07)' : 'rgba(37,99,235,0.06)', color: isDark ? '#fff' : '#111', border: isDark ? '1.5px solid rgba(255,255,255,0.12)' : '1.5px solid rgba(37,99,235,0.14)' },
    }
    return (
        <Link href={href} style={styles[variant]} className={cn('active:scale-95 sm:h-[42px] sm:w-auto sm:px-6', className)}>
            {children}
        </Link>
    )
}

// ── Platform icons for Download App ──────────────────────────────────────────────
function AppleIcon({ className }: { className?: string }) {
    return (
        <svg className={className} fill="currentColor" viewBox="0 0 24 24">
            <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z" />
        </svg>
    )
}

function AndroidIcon({ className }: { className?: string }) {
    return (
        <svg className={className} fill="currentColor" viewBox="0 0 24 24">
            <path d="M17.523 15.341a1 1 0 0 1-1-1V9.659a1 1 0 0 1 2 0v4.682a1 1 0 0 1-1 1zm-11.046 0a1 1 0 0 1-1-1V9.659a1 1 0 0 1 2 0v4.682a1 1 0 0 1-1 1zM8 6.32 6.9 4.42a.344.344 0 0 1 .597-.344L8.6 5.9A6.955 6.955 0 0 1 12 5.16c1.02 0 1.99.22 2.865.618l1.1-1.902a.344.344 0 0 1 .597.345l-1.1 1.878A6.994 6.994 0 0 1 19 12.5H5A6.994 6.994 0 0 1 8 6.32zM9.5 10a.5.5 0 1 0 0-1 .5.5 0 0 0 0 1zm5 0a.5.5 0 1 0 0-1 .5.5 0 0 0 0 1zM5 14h14v5.5a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V14z" />
        </svg>
    )
}

// ─────────────────────────────────────────────────────────────────────────────────
export function LandingClientShell({
    initialGuestUrl,
    initialAdminPhone,
    initialPlanPrices,
}: LandingClientShellProps) {
    const router = useRouter()
    const { resolvedTheme } = useTheme()
    const isDark = resolvedTheme !== 'light'
    const [headerScrolled, setHeaderScrolled] = useState(false)
    const [guestUrl] = useState(initialGuestUrl)
    const [adminPhone] = useState(initialAdminPhone)
    const [planPrices] = useState<Record<TierId, number>>(initialPlanPrices || DEFAULT_PLAN_PRICES)
    const [slide, setSlide] = useState(0)
    const [touchStartX, setTouchStartX] = useState<number | null>(null)
    const [isLoggedIn, setIsLoggedIn] = useState(false)
    const SLIDE_COUNT = 5

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

    useEffect(() => {
        const t = setInterval(() => setSlide(s => (s + 1) % SLIDE_COUNT), 10000)
        return () => clearInterval(t)
    }, [])

    const cardBase = 'absolute inset-0 w-full rounded-3xl p-6 sm:p-8 text-left transition-all duration-500'
    const slideState = (i: number) => slide === i
        ? 'opacity-100 translate-x-0 pointer-events-auto'
        : slide > i
            ? 'opacity-0 -translate-x-5 pointer-events-none'
            : 'opacity-0 translate-x-5 pointer-events-none'

    return (
        <div
            className={cn('min-h-screen text-foreground overflow-x-hidden', !isDark && 'bg-background')}
            style={isDark ? { background: 'linear-gradient(160deg, #020617 0%, #070c1f 40%, #020617 100%)' } : undefined}
        >

            {/* ══ NAV ══════════════════════════════════════════════════════════════ */}
            <nav className={cn(
                'fixed top-0 w-full z-[100] transition-all duration-500 h-16 sm:h-20 flex items-center',
                headerScrolled ? 'backdrop-blur-2xl border-b shadow-sm' : '',
                headerScrolled ? (isDark ? 'border-white/10' : 'border-black/10') : ''
            )} style={{ backgroundColor: headerScrolled ? (isDark ? 'rgba(2,6,23,0.97)' : 'rgba(255,255,255,0.97)') : 'transparent' }}>
                <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-10 w-full flex items-center justify-between">
                    <a href="#" className="flex items-center gap-2 min-w-0">
                        <div className="w-8 h-8 sm:w-9 sm:h-9 rounded-xl overflow-hidden bg-white flex items-center justify-center shadow-md flex-shrink-0">
                            <div className="relative w-7 h-7 sm:w-8 sm:h-8">
                                <Image src="/arhms-logo.png" alt="ARHMS Logo" fill className="object-contain" priority />
                            </div>
                        </div>
                        <span className="font-black text-sm sm:text-base lg:text-lg tracking-tight truncate" style={{ color: isDark ? '#ffffff' : '#111111' }}>
                            ARHMS <span className="hidden sm:inline" style={{ color: BRAND_BLUE }}>TECHNOLOGIES</span>
                        </span>
                    </a>

                    <div className="hidden md:flex items-center gap-7">
                        {[['Products','#features'],['Wallet','#plans'],['Resell','#plans'],['AFA','#support'],['Community','#support']].map(([l,h]) => (
                            <a key={l} href={h} className="text-xs font-semibold transition-colors" style={{ color: isDark ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.5)' }}>{l}</a>
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
                                <Link href="/dashboard/install" className="hidden sm:flex items-center gap-1.5 text-xs font-bold rounded-full px-3 h-8 transition-colors" style={{ color: isDark ? 'rgba(255,255,255,0.7)' : 'rgba(0,0,0,0.6)', border: isDark ? '1px solid rgba(255,255,255,0.2)' : '1px solid rgba(0,0,0,0.15)' }}>
                                    <Smartphone className="w-3 h-3" /> Install App
                                </Link>
                                <Link href="/auth/login" className="text-sm font-bold px-3 h-9 flex items-center transition-colors" style={{ color: isDark ? 'rgba(255,255,255,0.8)' : 'rgba(0,0,0,0.7)' }}>
                                    Login
                                </Link>
                                <Link href="/auth/signup" className="text-sm font-black text-white h-9 px-5 rounded-full flex items-center active:scale-95 transition-transform" style={{ backgroundImage: BRAND_GRADIENT }}>
                                    Get Started
                                </Link>
                            </>
                        )}
                    </div>
                </div>
            </nav>

            {/* ══ HERO ══════════════════════════════════════════════════════════════ */}
            <section
                className="relative min-h-screen flex flex-col items-center justify-center px-4 sm:px-6 lg:px-10 overflow-hidden pt-16"
                onTouchStart={e => setTouchStartX(e.touches[0].clientX)}
                onTouchEnd={e => {
                    if (touchStartX === null) return
                    const dx = e.changedTouches[0].clientX - touchStartX
                    if (Math.abs(dx) > 40) setSlide(s => dx < 0 ? (s + 1) % SLIDE_COUNT : (s - 1 + SLIDE_COUNT) % SLIDE_COUNT)
                    setTouchStartX(null)
                }}
            >
                {/* Background ambience — light mode only */}
                {!isDark && (
                    <div className="pointer-events-none absolute inset-0 overflow-hidden">
                        <div className="absolute -top-20 left-1/2 -translate-x-1/2 w-[600px] h-[400px] rounded-full" style={{ background: 'radial-gradient(ellipse, rgba(37,99,235,0.08) 0%, transparent 70%)', filter: 'blur(40px)' }} />
                        <div className="absolute top-1/3 left-1/2 -translate-x-1/2 w-[500px] h-[500px] rounded-full" style={{ background: 'radial-gradient(circle, rgba(99,102,241,0.05) 0%, transparent 65%)', filter: 'blur(50px)' }} />
                        <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-[560px] h-[200px] rounded-full" style={{ background: 'radial-gradient(ellipse, rgba(37,99,235,0.06) 0%, transparent 70%)', filter: 'blur(30px)' }} />
                    </div>
                )}

                {/* Background glow orbs — dark mode only */}
                {isDark && (
                    <div className="pointer-events-none absolute inset-0 overflow-hidden">
                        <div className="absolute -top-24 -right-24 w-[700px] h-[700px] rounded-full" style={{ background: 'radial-gradient(circle, rgba(79,70,229,0.5) 0%, transparent 62%)', filter: 'blur(44px)' }} />
                        <div className="absolute top-1/4 -left-48 w-[560px] h-[560px] rounded-full" style={{ background: 'radial-gradient(circle, rgba(37,99,235,0.3) 0%, transparent 68%)', filter: 'blur(32px)' }} />
                        <div className="absolute bottom-0 right-1/3 w-[500px] h-[500px] rounded-full" style={{ background: 'radial-gradient(circle, rgba(37,99,235,0.16) 0%, transparent 65%)', filter: 'blur(52px)' }} />
                        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[500px] rounded-full" style={{ background: 'radial-gradient(ellipse, rgba(124,58,237,0.22) 0%, transparent 58%)', filter: 'blur(60px)' }} />
                    </div>
                )}

                <div className="relative z-10 w-full max-w-sm mx-auto flex flex-col items-center gap-4 sm:max-w-lg">

                    {/* Logo */}
                    <div className="w-[88px] h-[88px] rounded-full overflow-hidden flex items-center justify-center" style={{ backgroundColor: '#fff', boxShadow: '0 0 0 4px rgba(255,255,255,0.15), 0 20px 60px rgba(0,0,0,0.35)' }}>
                        <div className="relative w-16 h-16">
                            <Image src="/arhms-logo.png" alt="ARHMS Logo" fill className="object-contain" priority />
                        </div>
                    </div>

                    {/* Brand name */}
                    <div className="text-center -mt-1">
                        <p className="font-black text-2xl sm:text-3xl tracking-tight" style={{ color: isDark ? '#ffffff' : '#111111' }}>
                            ARHMS <span style={{ color: BRAND_BLUE }}>TECHNOLOGIES</span>
                        </p>
                        <p className="text-[10px] font-bold uppercase tracking-[0.28em] mt-1" style={{ color: isDark ? 'rgba(255,255,255,0.4)' : 'rgba(0,0,0,0.4)' }}>
                            Smart Solutions. Endless Possibilities.
                        </p>
                    </div>

                    {/* Badge */}
                    <div className="flex items-center gap-2 px-4 py-2 rounded-full border" style={{ backgroundColor: isDark ? 'rgba(255,255,255,0.07)' : 'rgba(37,99,235,0.05)', borderColor: 'rgba(37,99,235,0.28)' }}>
                        <Zap className="w-3.5 h-3.5" style={{ color: BRAND_BLUE, fill: BRAND_BLUE }} />
                        <span className="text-[10px] font-black uppercase tracking-[0.2em] text-foreground/80">Ultra Fast Instant Delivery</span>
                    </div>

                    {/* Radial glow behind card — dark mode only */}
                    {isDark && <div className="pointer-events-none absolute left-1/2 -translate-x-1/2" style={{ top: '8%', width: 440, height: 560, borderRadius: '50%', background: 'radial-gradient(ellipse, rgba(37,99,235,0.2) 0%, rgba(79,70,229,0.12) 40%, transparent 70%)', filter: 'blur(52px)', zIndex: 0 }} />}

                    {/* ── Carousel ─────────────────────────────── */}
                    <div className="w-full relative z-10" style={{ minHeight: 640 }}>

                        {/* Slide 1 — Welcome */}
                        <div className={cn(cardBase, slideState(0), 'hero-slide-1')}>
                            <p className="text-[10px] font-black uppercase tracking-[0.35em] mb-3" style={{ color: BRAND_BLUE }}>Welcome to</p>
                            <h1 className="font-black text-[2rem] sm:text-4xl leading-tight tracking-tight mb-3 text-[#111111] dark:text-white">
                                ARHMS <span style={{ color: BRAND_BLUE }}>TECHNOLOGIES</span>
                            </h1>
                            <p className="text-sm font-medium leading-relaxed mb-6 text-black/55 dark:text-white/55">
                                Ghana&apos;s all-in-one platform for mobile data, airtime, Results Checkers, and business growth. Instant delivery, always.
                            </p>
                            <div className="flex flex-col gap-2.5">
                                <HeroBtn href="/auth/login" variant="primary" isDark={isDark}>Sign In</HeroBtn>
                                <HeroBtn href="/auth/signup" variant="white" isDark={isDark}>Create Account</HeroBtn>
                                {isValidGuestUrl && <HeroBtn href={guestUrl} variant="dark" isDark={isDark}><Store className="w-4 h-4" /> Buy as Guest</HeroBtn>}
                                <HeroBtn href="/dashboard/install" variant="dark" isDark={isDark}>
                                    <Smartphone className="w-4 h-4" />
                                    Download App
                                    <span className="flex items-center gap-1 ml-1" style={{ opacity: 0.5 }}>
                                        <AppleIcon className="w-3.5 h-3.5" />
                                        <AndroidIcon className="w-3.5 h-3.5" />
                                        <Monitor className="w-3.5 h-3.5" />
                                    </span>
                                </HeroBtn>
                            </div>
                            <SlideDots current={0} total={SLIDE_COUNT} onDotClick={setSlide} dark={isDark} />
                        </div>

                        {/* Slide 2 — Result Checker */}
                        <div className={cn(cardBase, slideState(1), 'hero-slide-2')}>
                            <p className="text-[10px] font-black uppercase tracking-[0.35em] mb-3" style={{ color: BRAND_BLUE }}>WASSCE &amp; BECE</p>
                            <h2 className="font-black text-[2rem] sm:text-4xl leading-tight tracking-tight mb-3 text-[#111111] dark:text-white">
                                Check Your <span style={{ color: BRAND_BLUE }}>Results</span>
                            </h2>
                            <p className="text-sm font-medium leading-relaxed mb-5 text-black/55 dark:text-white/60">
                                Instantly check WAEC, BECE exam results for any student. Fast, reliable, and always available.
                            </p>
                            <div className="flex flex-wrap gap-2 mb-6">
                                {['WAEC Results', 'BECE Results', 'Instant Check', 'Any School', 'Live Updates'].map(f => (
                                    <span key={f} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[10px] font-bold uppercase tracking-wide text-black/70 dark:text-white/85" style={{ background: 'rgba(37,99,235,0.08)', border: '1px solid rgba(37,99,235,0.22)' }}>
                                        <CheckCircle2 className="w-3 h-3" style={{ color: BRAND_BLUE }} />{f}
                                    </span>
                                ))}
                            </div>
                            <HeroBtn href="/dashboard/result-checker" variant="primary"><GraduationCap className="w-4 h-4" /> Check Results Now</HeroBtn>
                            <SlideDots current={1} total={SLIDE_COUNT} onDotClick={setSlide} dark={isDark} />
                        </div>

                        {/* Slide 3 — Create Your Shop */}
                        <div className={cn(cardBase, slideState(2), 'hero-slide-3 overflow-hidden')}>
                            <div className="hidden dark:block">
                                <div style={{ position: 'absolute', top: '-30%', right: '-15%', width: 220, height: 220, borderRadius: '50%', background: 'rgba(255,255,255,0.12)', filter: 'blur(50px)', pointerEvents: 'none' }} />
                                <div style={{ position: 'absolute', bottom: '-20%', left: '-10%', width: 180, height: 180, borderRadius: '50%', background: 'rgba(255,255,255,0.1)', filter: 'blur(40px)', pointerEvents: 'none' }} />
                                <div style={{ position: 'absolute', top: '40%', right: '10%', width: 100, height: 100, borderRadius: '50%', background: 'rgba(253,230,138,0.15)', filter: 'blur(30px)', pointerEvents: 'none' }} />
                            </div>
                            <div className="relative z-10">
                                <p className="text-[10px] font-black uppercase tracking-[0.35em] mb-3 text-[#2563eb] dark:text-white/85">Create Your Shop</p>
                                <h2 className="font-black text-[2rem] sm:text-4xl leading-tight tracking-tight mb-3 text-[#111111] dark:text-white">
                                    Launch Your <span className="text-[#2563eb] dark:text-[#93c5fd]">Shop</span>
                                </h2>
                                <p className="text-sm font-medium leading-relaxed mb-5 text-black/55 dark:text-white/80">
                                    Create a branded storefront with your name, logo, pricing, and checkout link. Share it anywhere and start earning.
                                </p>
                                <div className="flex flex-wrap gap-2 mb-6">
                                    {['Public Shop URL','Custom Pricing','Order Tracking','WhatsApp Support','Brand Logo'].map(f => (
                                        <span key={f} className="hero-pill inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[10px] font-bold uppercase tracking-wide text-black/70 dark:text-white/95">
                                            <CheckCircle2 className="w-3 h-3 text-[#2563eb] dark:text-[#bfdbfe]" />{f}
                                        </span>
                                    ))}
                                </div>
                                <HeroBtn href="/auth/signup" variant="primary"><Store className="w-4 h-4" /> Open Your Shop</HeroBtn>
                                <SlideDots current={2} total={SLIDE_COUNT} onDotClick={setSlide} dark={isDark} />
                            </div>
                        </div>

                        {/* Slide 4 — Developer API */}
                        <div className={cn(cardBase, slideState(3), 'hero-slide-4')}>
                            <p className="text-[10px] font-black uppercase tracking-[0.35em] mb-3" style={{ color: BRAND_PURPLE }}>For Builders</p>
                            <h2 className="font-black text-[2rem] sm:text-4xl leading-tight tracking-tight mb-3 text-[#111111] dark:text-white">
                                Powerful <span style={{ color: BRAND_PURPLE }}>API</span> Access
                            </h2>
                            <p className="text-sm font-medium leading-relaxed mb-5 text-black/55 dark:text-white/55">
                                Integrate ARHMS data, airtime, and result checking into your own apps. RESTful API with instant responses.
                            </p>
                            <div className="flex flex-wrap gap-2 mb-6">
                                {['REST API', 'Webhooks', 'Sandbox Mode', 'Live Dashboard', 'Instant Response'].map(f => (
                                    <span key={f} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[10px] font-bold uppercase tracking-wide text-black/70 dark:text-white/85" style={{ background: 'rgba(167,139,250,0.08)', border: '1px solid rgba(167,139,250,0.2)' }}>
                                        <Code2 className="w-3 h-3" style={{ color: BRAND_PURPLE }} />{f}
                                    </span>
                                ))}
                            </div>
                            <HeroBtn href="/auth/signup" variant="primary"><Code2 className="w-4 h-4" /> Get API Access</HeroBtn>
                            <SlideDots current={3} total={SLIDE_COUNT} onDotClick={setSlide} dark={isDark} />
                        </div>

                        {/* Slide 5 — Marketplace */}
                        <div className={cn(cardBase, slideState(4), 'hero-slide-5')}>
                            <p className="text-[10px] font-black uppercase tracking-[0.35em] mb-3" style={{ color: '#059669' }}>ARHMS Marketplace</p>
                            <h2 className="font-black text-[2rem] sm:text-4xl leading-tight tracking-tight mb-3 text-[#111111] dark:text-white">
                                Buy &amp; Sell <span style={{ color: '#059669' }}>Locally</span>
                            </h2>
                            <p className="text-sm font-medium leading-relaxed mb-5 text-black/55 dark:text-white/60">
                                Discover great deals from verified sellers across Ghana — or list your own items for free in minutes.
                            </p>
                            <div className="flex flex-wrap gap-2 mb-6">
                                {['Verified Sellers', 'Local Deals', 'Post Free Ads', 'Any Category', 'Chat Direct'].map(f => (
                                    <span key={f} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[10px] font-bold uppercase tracking-wide text-black/70 dark:text-white/85" style={{ background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.22)' }}>
                                        <CheckCircle2 className="w-3 h-3" style={{ color: '#059669' }} />{f}
                                    </span>
                                ))}
                            </div>
                            <HeroBtn href={process.env.NEXT_PUBLIC_MARKETPLACE_URL || 'https://marketplace.arhmsgh.com'} variant="primary"><Store className="w-4 h-4" /> Explore Marketplace</HeroBtn>
                            <SlideDots current={4} total={SLIDE_COUNT} onDotClick={setSlide} dark={isDark} />
                        </div>
                    </div>

                    {/* Light-mode surface separator */}
                    <div className="hero-separator block dark:hidden w-full h-px" />

                    {/* Light-mode mirror reflection */}
                    <div className="hero-reflect-wrap block dark:hidden w-full relative pointer-events-none">
                        {[0, 1, 2, 3, 4].map(i => (
                            <div key={i} className={cn('hero-reflect', `hero-reflect-${i + 1}`, slideState(i))} />
                        ))}
                    </div>
                </div>
            </section>

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
                            <div key={`${feature.title}-${i}`} className="card-premium p-7 group hover:border-[#2563eb]/50 transition-all duration-500">
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
                                <div className="absolute -top-10 -right-10 w-40 h-40 rounded-full bg-[#2563eb]/10 blur-2xl" />
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
                            <div className="absolute inset-0 bg-[#2563eb]/20 rounded-3xl blur-[100px] -z-10" />
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
                        <div className="absolute top-0 right-0 w-[500px] h-[500px] bg-[#2563eb]/20 rounded-full blur-[100px] -mr-64 -mt-64" />
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
