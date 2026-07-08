'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { supabase } from '@/lib/supabase'
import { cn } from '@/lib/utils'
import { ThemeToggle } from '@/components/ui/theme-toggle'
import { useTheme } from 'next-themes'
import {
    ArrowRight,
    CheckCircle2,
    Clock,
    CreditCard,
    GraduationCap,
    HeadphonesIcon,
    KeyRound,
    School,
    ShieldCheck,
    Smartphone,
    Zap,
} from 'lucide-react'

interface ResultCheckerLandingProps {
    initialAdminPhone?: string
    initialWhatsappGroupLink?: string
    initialWhatsappChannelLink?: string
}

const BRAND_BLUE = '#2563eb'
const BRAND_GRADIENT = 'linear-gradient(90deg, #7c3aed 0%, #2563eb 52%, #0ea5e9 100%)'

// Where every "buy / check" CTA points — the existing wallet-based purchase page.
// Logged-out users are routed through login by the dashboard layout.
const RC_CHECKOUT_HREF = '/dashboard/results-checker'

const examPills = ['WASSCE', 'BECE', 'NECO', 'Any School', 'Instant PIN + Serial']

const steps: Array<{ icon: any; title: string; desc: string }> = [
    { icon: GraduationCap, title: 'Pick your checker', desc: 'Choose WAEC, BECE or NECO and the quantity you need — for yourself or your whole class.' },
    { icon: CreditCard, title: 'Pay securely', desc: 'Pay from your ARHMS wallet in seconds. No queues, no third-party vendors.' },
    { icon: KeyRound, title: 'Get your PIN instantly', desc: 'Your PIN and Serial Number are delivered on-screen immediately — plus a copy by SMS and email.' },
]

const features: Array<{ icon: any; title: string; desc: string }> = [
    { icon: Zap, title: 'Instant Delivery', desc: 'Your checker PIN and serial appear the moment payment clears — no waiting, no manual processing.' },
    { icon: ShieldCheck, title: 'Genuine PINs', desc: 'Every voucher comes straight from verified stock, so it works first time on the official results portal.' },
    { icon: School, title: 'Any School, Anywhere', desc: 'Check results for any candidate from any school across Ghana — all from your phone.' },
    { icon: Clock, title: 'Available 24/7', desc: 'Buy and check the minute results drop — day or night, weekends and holidays included.' },
    { icon: CreditCard, title: 'Best Price', desc: 'Fair, transparent pricing with automatic bulk discounts when you buy several at once.' },
    { icon: HeadphonesIcon, title: 'Real Support', desc: 'Stuck? Our team is one WhatsApp message away and ready to help you check your results.' },
]

const faqItems = [
    { q: 'Which results can I check?', a: 'You can buy checker vouchers for WASSCE, BECE and NECO. Each voucher gives you a PIN and Serial Number to use on the official results portal.' },
    { q: 'How fast do I get my PIN?', a: 'Instantly. As soon as your wallet payment goes through, the PIN and Serial Number are shown on screen and also sent to you by SMS and email.' },
    { q: 'Can I buy for more than one student?', a: 'Yes. Choose any quantity from 1 to 100 and bulk discounts are applied automatically as the quantity increases.' },
    { q: 'What if I lose my PIN?', a: 'Every voucher you buy is saved in your dashboard under "Your Vouchers", so you can always come back and copy the PIN and Serial again.' },
    { q: 'How do I pay?', a: 'Payment is made from your ARHMS wallet. Top up once and buy as many checkers as you need without re-entering any card details.' },
]

// ── Primary / secondary CTA button ────────────────────────────────────────────────
function RcButton({ href, variant = 'primary', isDark = true, children, className }: { href: string; variant?: 'primary' | 'outline'; isDark?: boolean; children: React.ReactNode; className?: string }) {
    const base: React.CSSProperties = {
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8,
        height: 56, borderRadius: 999, padding: '0 28px',
        fontWeight: 800, fontSize: 14, letterSpacing: '0.04em',
        cursor: 'pointer', transition: 'opacity 0.2s, transform 0.2s', textDecoration: 'none',
        border: 'none', outline: 'none',
    }
    const styles: Record<string, React.CSSProperties> = {
        primary: { ...base, backgroundImage: BRAND_GRADIENT, color: '#fff', boxShadow: '0 12px 30px rgba(37,99,235,0.28)' },
        outline: { ...base, backgroundColor: 'transparent', color: isDark ? '#fff' : '#111', border: isDark ? '1.5px solid rgba(255,255,255,0.18)' : '1.5px solid rgba(37,99,235,0.22)' },
    }
    return (
        <Link href={href} style={styles[variant]} className={cn('active:scale-95', className)}>
            {children}
        </Link>
    )
}

// ─────────────────────────────────────────────────────────────────────────────────
export function ResultCheckerLanding({
    initialAdminPhone,
    initialWhatsappGroupLink,
    initialWhatsappChannelLink,
}: ResultCheckerLandingProps) {
    const { resolvedTheme } = useTheme()
    const isDark = resolvedTheme !== 'light'
    const [headerScrolled, setHeaderScrolled] = useState(false)
    const [isLoggedIn, setIsLoggedIn] = useState(false)

    const adminPhone = (initialAdminPhone || '').replace(/[^0-9]/g, '')
    const whatsappSupportLink = adminPhone ? `https://wa.me/${adminPhone}` : (initialWhatsappGroupLink || initialWhatsappChannelLink || '')

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
                            ARHMS <span className="hidden sm:inline" style={{ color: BRAND_BLUE }}>RESULTS CHECKER</span>
                        </span>
                    </a>

                    <div className="hidden md:flex items-center gap-7">
                        {[['How it works', '#how'], ['Why us', '#why'], ['FAQ', '#faq'], ['Support', '#support']].map(([l, h]) => (
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
                                <Link href="/auth/login" className="text-sm font-bold px-3 h-9 flex items-center transition-colors" style={{ color: isDark ? 'rgba(255,255,255,0.8)' : 'rgba(0,0,0,0.7)' }}>
                                    Login
                                </Link>
                                <Link href={RC_CHECKOUT_HREF} className="text-sm font-black text-white h-9 px-5 rounded-full flex items-center active:scale-95 transition-transform whitespace-nowrap" style={{ backgroundImage: BRAND_GRADIENT }}>
                                    Check Results
                                </Link>
                            </>
                        )}
                    </div>
                </div>
            </nav>

            {/* ══ HERO ══════════════════════════════════════════════════════════════ */}
            <section className="relative min-h-screen flex flex-col items-center justify-center px-4 sm:px-6 lg:px-10 overflow-hidden pt-24 pb-16">
                {/* Background ambience — light mode */}
                {!isDark && (
                    <div className="pointer-events-none absolute inset-0 overflow-hidden">
                        <div className="absolute -top-20 left-1/2 -translate-x-1/2 w-[600px] h-[400px] rounded-full" style={{ background: 'radial-gradient(ellipse, rgba(37,99,235,0.08) 0%, transparent 70%)', filter: 'blur(40px)' }} />
                        <div className="absolute top-1/3 left-1/2 -translate-x-1/2 w-[500px] h-[500px] rounded-full" style={{ background: 'radial-gradient(circle, rgba(99,102,241,0.05) 0%, transparent 65%)', filter: 'blur(50px)' }} />
                    </div>
                )}
                {/* Background glow orbs — dark mode */}
                {isDark && (
                    <div className="pointer-events-none absolute inset-0 overflow-hidden">
                        <div className="absolute -top-24 -right-24 w-[700px] h-[700px] rounded-full" style={{ background: 'radial-gradient(circle, rgba(79,70,229,0.5) 0%, transparent 62%)', filter: 'blur(44px)' }} />
                        <div className="absolute top-1/4 -left-48 w-[560px] h-[560px] rounded-full" style={{ background: 'radial-gradient(circle, rgba(37,99,235,0.3) 0%, transparent 68%)', filter: 'blur(32px)' }} />
                        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[500px] rounded-full" style={{ background: 'radial-gradient(ellipse, rgba(124,58,237,0.22) 0%, transparent 58%)', filter: 'blur(60px)' }} />
                    </div>
                )}

                <div className="relative z-10 w-full max-w-2xl mx-auto flex flex-col items-center gap-5 text-center">
                    {/* Logo */}
                    <div className="w-[88px] h-[88px] rounded-full overflow-hidden flex items-center justify-center" style={{ backgroundColor: '#fff', boxShadow: '0 0 0 4px rgba(255,255,255,0.15), 0 20px 60px rgba(0,0,0,0.35)' }}>
                        <div className="relative w-16 h-16">
                            <Image src="/arhms-logo.png" alt="ARHMS Logo" fill className="object-contain" priority />
                        </div>
                    </div>

                    {/* Badge */}
                    <div className="flex items-center gap-2 px-4 py-2 rounded-full border" style={{ backgroundColor: isDark ? 'rgba(255,255,255,0.07)' : 'rgba(37,99,235,0.05)', borderColor: 'rgba(37,99,235,0.28)' }}>
                        <GraduationCap className="w-3.5 h-3.5" style={{ color: BRAND_BLUE }} />
                        <span className="text-[10px] font-black uppercase tracking-[0.2em] text-foreground/80">Instant Results Checker</span>
                    </div>

                    <h1 className="font-black text-[2.25rem] sm:text-5xl leading-[1.1] tracking-tight text-[#111111] dark:text-white">
                        Check Your WASSCE &amp; BECE Results <span style={{ color: BRAND_BLUE }}>Instantly</span>
                    </h1>
                    <p className="text-sm sm:text-base font-medium leading-relaxed max-w-xl text-black/55 dark:text-white/60">
                        Buy a genuine WAEC, BECE or NECO checker and get your PIN and Serial Number the moment you pay — delivered on screen, by SMS and email. No queues. No stress.
                    </p>

                    {/* Exam pills */}
                    <div className="flex flex-wrap items-center justify-center gap-2">
                        {examPills.map(pill => (
                            <span key={pill} className="text-[11px] font-bold px-3 py-1.5 rounded-full border" style={{ color: isDark ? 'rgba(255,255,255,0.75)' : 'rgba(0,0,0,0.6)', borderColor: isDark ? 'rgba(255,255,255,0.14)' : 'rgba(37,99,235,0.18)', backgroundColor: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(37,99,235,0.04)' }}>
                                {pill}
                            </span>
                        ))}
                    </div>

                    {/* CTAs */}
                    <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-center gap-3 w-full sm:w-auto mt-2">
                        <RcButton href={RC_CHECKOUT_HREF} variant="primary" isDark={isDark}>
                            Check / Buy Results <ArrowRight className="w-4 h-4" />
                        </RcButton>
                        <RcButton href="/dashboard/install" variant="outline" isDark={isDark}>
                            <Smartphone className="w-4 h-4" /> Download App
                        </RcButton>
                    </div>
                    <Link href="/shop/status" className="mt-1 inline-flex items-center gap-1.5 text-xs font-bold transition-colors" style={{ color: isDark ? 'rgba(255,255,255,0.4)' : 'rgba(37,99,235,0.55)' }}>
                        <CheckCircle2 className="w-3.5 h-3.5" /> Track an existing order
                    </Link>
                </div>
            </section>

            {/* ══ HOW IT WORKS ══════════════════════════════════════════════════════ */}
            <section id="how" className="relative py-20 px-4 sm:px-6 lg:px-10">
                <div className="max-w-5xl mx-auto">
                    <div className="text-center mb-12">
                        <p className="text-[10px] font-black uppercase tracking-[0.3em] mb-2" style={{ color: BRAND_BLUE }}>How it works</p>
                        <h2 className="font-black text-2xl sm:text-4xl tracking-tight text-[#111111] dark:text-white">Your results in 3 simple steps</h2>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
                        {steps.map((step, i) => (
                            <div key={step.title} className="rounded-2xl p-6 border" style={{ borderColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)', backgroundColor: isDark ? 'rgba(255,255,255,0.03)' : 'rgba(255,255,255,0.7)' }}>
                                <div className="flex items-center gap-3 mb-4">
                                    <div className="w-10 h-10 rounded-xl flex items-center justify-center text-white flex-shrink-0" style={{ backgroundImage: BRAND_GRADIENT }}>
                                        <step.icon className="w-5 h-5" />
                                    </div>
                                    <span className="text-3xl font-black text-black/10 dark:text-white/10">{i + 1}</span>
                                </div>
                                <h3 className="font-bold text-base mb-1.5 text-[#111111] dark:text-white">{step.title}</h3>
                                <p className="text-sm leading-relaxed text-black/55 dark:text-white/55">{step.desc}</p>
                            </div>
                        ))}
                    </div>
                </div>
            </section>

            {/* ══ WHY US ════════════════════════════════════════════════════════════ */}
            <section id="why" className="relative py-20 px-4 sm:px-6 lg:px-10">
                <div className="max-w-6xl mx-auto">
                    <div className="text-center mb-12">
                        <p className="text-[10px] font-black uppercase tracking-[0.3em] mb-2" style={{ color: BRAND_BLUE }}>Why ARHMS</p>
                        <h2 className="font-black text-2xl sm:text-4xl tracking-tight text-[#111111] dark:text-white">The fastest way to check results</h2>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
                        {features.map(feature => (
                            <div key={feature.title} className="rounded-2xl p-6 border" style={{ borderColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)', backgroundColor: isDark ? 'rgba(255,255,255,0.03)' : 'rgba(255,255,255,0.7)' }}>
                                <div className="w-11 h-11 rounded-xl flex items-center justify-center text-white mb-4" style={{ backgroundImage: BRAND_GRADIENT }}>
                                    <feature.icon className="w-5 h-5" />
                                </div>
                                <h3 className="font-bold text-base mb-1.5 text-[#111111] dark:text-white">{feature.title}</h3>
                                <p className="text-sm leading-relaxed text-black/55 dark:text-white/55">{feature.desc}</p>
                            </div>
                        ))}
                    </div>
                </div>
            </section>

            {/* ══ CTA BANNER ════════════════════════════════════════════════════════ */}
            <section className="relative py-16 px-4 sm:px-6 lg:px-10">
                <div className="max-w-4xl mx-auto rounded-3xl p-8 sm:p-12 text-center" style={{ backgroundImage: BRAND_GRADIENT, boxShadow: '0 20px 60px rgba(37,99,235,0.3)' }}>
                    <h2 className="font-black text-2xl sm:text-4xl tracking-tight text-white mb-3">Results are out. Check yours now.</h2>
                    <p className="text-sm sm:text-base text-white/85 max-w-lg mx-auto mb-7">Get a genuine checker PIN in seconds and see your WASSCE, BECE or NECO results right away.</p>
                    <Link href={RC_CHECKOUT_HREF} className="inline-flex items-center justify-center gap-2 h-14 px-9 rounded-full bg-white text-[#111] font-black text-sm active:scale-95 transition-transform">
                        Check / Buy Results <ArrowRight className="w-4 h-4" />
                    </Link>
                </div>
            </section>

            {/* ══ FAQ ═══════════════════════════════════════════════════════════════ */}
            <section id="faq" className="relative py-20 px-4 sm:px-6 lg:px-10">
                <div className="max-w-3xl mx-auto">
                    <div className="text-center mb-12">
                        <p className="text-[10px] font-black uppercase tracking-[0.3em] mb-2" style={{ color: BRAND_BLUE }}>FAQ</p>
                        <h2 className="font-black text-2xl sm:text-4xl tracking-tight text-[#111111] dark:text-white">Questions, answered</h2>
                    </div>
                    <div className="space-y-3">
                        {faqItems.map(item => (
                            <details key={item.q} className="group rounded-2xl border p-5" style={{ borderColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)', backgroundColor: isDark ? 'rgba(255,255,255,0.03)' : 'rgba(255,255,255,0.7)' }}>
                                <summary className="flex items-center justify-between cursor-pointer list-none font-bold text-sm text-[#111111] dark:text-white">
                                    {item.q}
                                    <ArrowRight className="w-4 h-4 transition-transform group-open:rotate-90" style={{ color: BRAND_BLUE }} />
                                </summary>
                                <p className="mt-3 text-sm leading-relaxed text-black/55 dark:text-white/55">{item.a}</p>
                            </details>
                        ))}
                    </div>
                </div>
            </section>

            {/* ══ FOOTER ════════════════════════════════════════════════════════════ */}
            <footer id="support" className="relative border-t px-4 sm:px-6 lg:px-10 py-12" style={{ borderColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)' }}>
                <div className="max-w-6xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-6">
                    <div className="flex items-center gap-2">
                        <div className="w-8 h-8 rounded-xl overflow-hidden bg-white flex items-center justify-center shadow-md">
                            <div className="relative w-7 h-7">
                                <Image src="/arhms-logo.png" alt="ARHMS Logo" fill className="object-contain" />
                            </div>
                        </div>
                        <span className="font-black text-sm tracking-tight text-[#111111] dark:text-white">ARHMS <span style={{ color: BRAND_BLUE }}>TECHNOLOGIES</span></span>
                    </div>

                    <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-xs font-semibold" style={{ color: isDark ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.5)' }}>
                        {whatsappSupportLink && (
                            <a href={whatsappSupportLink} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 transition-colors">
                                <HeadphonesIcon className="w-3.5 h-3.5" /> WhatsApp Support
                            </a>
                        )}
                        <Link href="/contact" className="transition-colors">Contact</Link>
                        <Link href="/terms" className="transition-colors">Terms</Link>
                        <Link href="/privacy" className="transition-colors">Privacy</Link>
                    </div>
                </div>
                <p className="text-center text-[11px] mt-8" style={{ color: isDark ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.35)' }}>
                    © {' '}ARHMS TECHNOLOGIES. All rights reserved.
                </p>
            </footer>
        </div>
    )
}
