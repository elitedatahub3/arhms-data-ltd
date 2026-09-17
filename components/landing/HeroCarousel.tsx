'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { cn } from '@/lib/utils'
import {
    CheckCircle2,
    Code2,
    GraduationCap,
    Monitor,
    Smartphone,
    Store,
    Zap,
} from 'lucide-react'

/**
 * The landing hero and its five-slide carousel.
 *
 * Lives in its own component so the slide index, the auto-advance timer and the
 * swipe tracking only ever re-render this subtree. When they sat in
 * LandingClientShell, every touchstart (i.e. the start of every scroll gesture
 * on the hero) and every 10s tick re-rendered the entire landing page — which
 * is what made scrolling on low-end Android stutter and flash.
 *
 * Decorative glows are plain radial gradients. They used to add `filter: blur()`
 * on 500–800px layers, which forces the GPU to allocate and re-rasterize huge
 * textures; Android discards those when they scroll out of view, so scrolling
 * back up showed blank or flickering sections. A radial gradient that already
 * fades to transparent looks the same without the filter.
 */

const BRAND_BLUE = '#2563eb'
const BRAND_PURPLE = '#7c3aed'
const SLIDE_COUNT = 5
const AUTO_ADVANCE_MS = 10000

// ── Dot indicators ───────────────────────────────────────────────────────────────
function SlideDots({ current, total, onDotClick }: { current: number; total: number; onDotClick: (i: number) => void }) {
    return (
        <div className="flex items-center justify-between mt-6 pt-5 border-t border-black/10 dark:border-white/10">
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
                            transition: 'width 0.3s ease, background-color 0.3s ease',
                        }}
                        className={i === current ? 'bg-[#2563eb]' : 'bg-black/10 dark:bg-white/20'}
                        aria-label={`Slide ${i + 1}`}
                    />
                ))}
            </div>
            <Link
                href="/shop/status"
                className="flex items-center gap-1.5 text-[10px] font-bold transition-colors active:opacity-70 text-black/30 dark:text-white/30"
            >
                <CheckCircle2 className="w-3 h-3" /> Track an Order
            </Link>
        </div>
    )
}

// ── Hero CTA buttons ──────────────────────────────────────────────────────────────
function HeroBtn({ href, variant = 'primary', children, className }: { href: string; variant?: 'primary' | 'white' | 'dark'; children: React.ReactNode; className?: string }) {
    const baseClasses = 'flex items-center justify-center gap-1.5 w-full h-14 rounded-full font-extrabold text-[13px] tracking-widest uppercase cursor-pointer transition-transform active:scale-95 sm:h-[42px] sm:w-auto sm:px-6'

    let variantClasses = ''
    if (variant === 'primary') {
        variantClasses = 'bg-gradient-to-r from-[#7c3aed] via-[#2563eb] to-[#0ea5e9] text-white shadow-[0_12px_30px_rgba(37,99,235,0.28)]'
    } else if (variant === 'white') {
        variantClasses = 'bg-transparent dark:bg-white text-[#111] border-[1.5px] border-[#2563eb]/20 dark:border-white/15'
    } else if (variant === 'dark') {
        variantClasses = 'bg-[#2563eb]/5 dark:bg-white/5 text-[#111] dark:text-white border-[1.5px] border-[#2563eb]/10 dark:border-white/10'
    }

    // Warm internal routes (/auth/login, /auth/signup) so the tap lands on an
    // already-cached payload instead of a cold round-trip. External storefront
    // URLs can't be prefetched by the router, so opt them out.
    const isInternal = href.startsWith('/')

    return (
        <Link href={href} prefetch={isInternal ? true : false} className={cn(baseClasses, variantClasses, className)}>
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

export function HeroCarousel({ guestUrl, isValidGuestUrl }: { guestUrl: string; isValidGuestUrl: boolean }) {
    const [slide, setSlide] = useState(0)
    // A ref, not state: recording where a touch began must not re-render anything.
    const touchStartX = useRef<number | null>(null)
    const sectionRef = useRef<HTMLElement>(null)
    const heroVisible = useRef(true)

    // Only follow the hero while it is on screen: no point re-rendering (and
    // repainting) a carousel the user has scrolled past.
    useEffect(() => {
        const el = sectionRef.current
        if (!el || typeof IntersectionObserver === 'undefined') return
        const observer = new IntersectionObserver(([entry]) => {
            heroVisible.current = entry.isIntersecting
        })
        observer.observe(el)
        return () => observer.disconnect()
    }, [])

    useEffect(() => {
        const t = setInterval(() => {
            if (!heroVisible.current || document.hidden) return
            setSlide(s => (s + 1) % SLIDE_COUNT)
        }, AUTO_ADVANCE_MS)
        return () => clearInterval(t)
    }, [])

    const cardBase = 'absolute inset-0 w-full rounded-3xl p-6 sm:p-8 text-left transition-[opacity,transform] duration-500'
    const slideState = (i: number) => slide === i
        ? 'opacity-100 translate-x-0 pointer-events-auto'
        : slide > i
            ? 'opacity-0 -translate-x-5 pointer-events-none'
            : 'opacity-0 translate-x-5 pointer-events-none'

    return (
        <section
            ref={sectionRef}
            className="relative min-h-screen min-h-[100svh] flex flex-col items-center justify-center px-4 sm:px-6 lg:px-10 overflow-hidden pt-16"
            onTouchStart={e => { touchStartX.current = e.touches[0].clientX }}
            onTouchEnd={e => {
                const start = touchStartX.current
                touchStartX.current = null
                if (start === null) return
                const dx = e.changedTouches[0].clientX - start
                if (Math.abs(dx) > 40) setSlide(s => dx < 0 ? (s + 1) % SLIDE_COUNT : (s - 1 + SLIDE_COUNT) % SLIDE_COUNT)
            }}
        >
            {/* Background ambience — light mode only */}
            <div className="pointer-events-none absolute inset-0 overflow-hidden dark:hidden">
                <div className="absolute -top-20 left-1/2 -translate-x-1/2 w-[600px] h-[400px] rounded-full" style={{ background: 'radial-gradient(ellipse, rgba(37,99,235,0.08) 0%, transparent 70%)' }} />
                <div className="absolute top-1/3 left-1/2 -translate-x-1/2 w-[500px] h-[500px] rounded-full" style={{ background: 'radial-gradient(circle, rgba(99,102,241,0.05) 0%, transparent 65%)' }} />
                <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-[560px] h-[200px] rounded-full" style={{ background: 'radial-gradient(ellipse, rgba(37,99,235,0.06) 0%, transparent 70%)' }} />
            </div>

            {/* Background glow orbs — dark mode only */}
            <div className="pointer-events-none absolute inset-0 overflow-hidden hidden dark:block">
                <div className="absolute -top-24 -right-24 w-[700px] h-[700px] rounded-full" style={{ background: 'radial-gradient(circle, rgba(79,70,229,0.45) 0%, rgba(79,70,229,0.12) 38%, transparent 66%)' }} />
                <div className="absolute top-1/4 -left-48 w-[560px] h-[560px] rounded-full" style={{ background: 'radial-gradient(circle, rgba(37,99,235,0.26) 0%, rgba(37,99,235,0.07) 40%, transparent 70%)' }} />
                <div className="absolute bottom-0 right-1/3 w-[500px] h-[500px] rounded-full" style={{ background: 'radial-gradient(circle, rgba(37,99,235,0.14) 0%, transparent 68%)' }} />
                <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[500px] rounded-full" style={{ background: 'radial-gradient(ellipse, rgba(124,58,237,0.2) 0%, rgba(124,58,237,0.06) 36%, transparent 62%)' }} />
            </div>

            <div className="relative z-10 w-full max-w-sm mx-auto flex flex-col items-center gap-4 sm:max-w-lg">

                {/* Logo */}
                <div className="w-[88px] h-[88px] rounded-full overflow-hidden flex items-center justify-center" style={{ backgroundColor: '#fff', boxShadow: '0 0 0 4px rgba(255,255,255,0.15), 0 20px 60px rgba(0,0,0,0.35)' }}>
                    <div className="relative w-16 h-16">
                        <Image src="/arhms-logo.png" alt="ARHMS Logo" fill className="object-contain" priority />
                    </div>
                </div>

                {/* Brand name */}
                <div className="text-center -mt-1">
                    <p className="font-black text-2xl sm:text-3xl tracking-tight text-[#111111] dark:text-white">
                        ARHMS <span style={{ color: BRAND_BLUE }}>TECHNOLOGIES</span>
                    </p>
                    <p className="text-[10px] font-bold uppercase tracking-[0.28em] mt-1 text-black/40 dark:text-white/40">
                        Smart Solutions. Endless Possibilities.
                    </p>
                </div>

                {/* Badge */}
                <div className="flex items-center gap-2 px-4 py-2 rounded-full border bg-[#2563eb]/5 dark:bg-white/5 border-[#2563eb]/30">
                    <Zap className="w-3.5 h-3.5" style={{ color: BRAND_BLUE, fill: BRAND_BLUE }} />
                    <span className="text-[10px] font-black uppercase tracking-[0.2em] text-foreground/80">Ultra Fast Instant Delivery</span>
                </div>

                {/* Radial glow behind card — dark mode only */}
                <div className="pointer-events-none absolute left-1/2 -translate-x-1/2 hidden dark:block" style={{ top: '8%', width: 440, height: 560, borderRadius: '50%', background: 'radial-gradient(ellipse, rgba(37,99,235,0.18) 0%, rgba(79,70,229,0.1) 40%, transparent 70%)', zIndex: 0 }} />

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
                            <HeroBtn href="/auth/login" variant="primary">Sign In</HeroBtn>
                            <HeroBtn href="/auth/signup" variant="white">Create Account</HeroBtn>
                            {isValidGuestUrl && <HeroBtn href={guestUrl} variant="dark"><Store className="w-4 h-4" /> Buy as Guest</HeroBtn>}
                            <HeroBtn href="/dashboard/install" variant="dark">
                                <Smartphone className="w-4 h-4" />
                                Download App
                                <span className="flex items-center gap-1 ml-1" style={{ opacity: 0.5 }}>
                                    <AppleIcon className="w-3.5 h-3.5" />
                                    <AndroidIcon className="w-3.5 h-3.5" />
                                    <Monitor className="w-3.5 h-3.5" />
                                </span>
                            </HeroBtn>
                        </div>
                        <SlideDots current={0} total={SLIDE_COUNT} onDotClick={setSlide} />
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
                        <HeroBtn href="/dashboard/results-checker" variant="primary"><GraduationCap className="w-4 h-4" /> Check Results Now</HeroBtn>
                        <SlideDots current={1} total={SLIDE_COUNT} onDotClick={setSlide} />
                    </div>

                    {/* Slide 3 — Create Your Shop */}
                    <div className={cn(cardBase, slideState(2), 'hero-slide-3 overflow-hidden')}>
                        <div className="hidden dark:block">
                            <div style={{ position: 'absolute', top: '-30%', right: '-15%', width: 320, height: 320, borderRadius: '50%', background: 'radial-gradient(circle, rgba(255,255,255,0.12) 0%, transparent 65%)', pointerEvents: 'none' }} />
                            <div style={{ position: 'absolute', bottom: '-20%', left: '-10%', width: 260, height: 260, borderRadius: '50%', background: 'radial-gradient(circle, rgba(255,255,255,0.1) 0%, transparent 65%)', pointerEvents: 'none' }} />
                            <div style={{ position: 'absolute', top: '40%', right: '10%', width: 160, height: 160, borderRadius: '50%', background: 'radial-gradient(circle, rgba(253,230,138,0.15) 0%, transparent 65%)', pointerEvents: 'none' }} />
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
                            <SlideDots current={2} total={SLIDE_COUNT} onDotClick={setSlide} />
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
                        <SlideDots current={3} total={SLIDE_COUNT} onDotClick={setSlide} />
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
                        <SlideDots current={4} total={SLIDE_COUNT} onDotClick={setSlide} />
                    </div>
                </div>

                {/* Light-mode surface separator */}
                <div className="hero-separator block dark:hidden w-full h-px" />

                {/* Light-mode mirror reflection — tablet and up. On a phone it sits
                    below the fold and was five more animated layers to composite. */}
                <div className="hero-reflect-wrap hidden sm:block sm:dark:hidden w-full relative pointer-events-none">
                    {[0, 1, 2, 3, 4].map(i => (
                        <div key={i} className={cn('hero-reflect', `hero-reflect-${i + 1}`, slideState(i))} />
                    ))}
                </div>
            </div>
        </section>
    )
}
