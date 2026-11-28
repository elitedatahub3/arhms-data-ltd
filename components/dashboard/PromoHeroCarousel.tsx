'use client'

import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import Link from 'next/link'
import {
    UserPlus,
    Smartphone,
    Wifi,
    Phone,
    GraduationCap,
    ShieldCheck,
    Search,
    Receipt,
    ChevronLeft,
    ChevronRight,
} from 'lucide-react'
import { cn } from '@/lib/utils'

interface PromoHeroCarouselProps {
    role?: string | null
    phoneVerified?: boolean
}

interface Slide {
    key: string
    badgeIcon: typeof UserPlus
    badgeLabel: string
    title: string
    description: string
    ctaLabel: string
    href: string
    gradientClass: string
    /** Brand logo shown in a white tile on the right instead of the badge icon. */
    logo?: string
}

// Bill slides open the bill page with that biller already picked. Only on the
// main dashboard (role is set): sub-agents' bill link is their pricing page.
const billSlide = (key: string, title: string, logo: string, gradientClass: string) => ({
    key: 'bill-' + key,
    badgeIcon: Receipt,
    badgeLabel: 'Utility Bills',
    title,
    description: 'Pay your ' + title + ' bill straight from your wallet.',
    ctaLabel: 'Pay Now',
    href: '/dashboard/utilities?service=' + key,
    gradientClass,
    logo,
    show: (p: PromoHeroCarouselProps) => !!p.role,
})

const ALL_SLIDES: (Slide & { show: (p: PromoHeroCarouselProps) => boolean })[] = [
    billSlide('ecg', 'ECG Prepaid', '/images/utilities/ecg.png', 'from-[#1e2a78] via-[#7a1a1a] to-[#8a7a12]'),
    billSlide('ghanawater', 'Ghana Water', '/images/utilities/ghanawater.png', 'from-sky-600 to-blue-900'),
    billSlide('dstv', 'DSTV', '/images/utilities/dstv.png', 'from-[#0a4f9e] to-[#06234a]'),
    billSlide('gotv', 'GOtv', '/images/utilities/gotv.png', 'from-[#7a0a0a] to-[#0b4a1c]'),
    billSlide('startimes', 'StarTimes TV', '/images/utilities/startimes.png', 'from-[#0b3a66] via-slate-950 to-[#8a5a0a]'),
    {
        key: 'recruit',
        badgeIcon: UserPlus,
        badgeLabel: 'Network',
        title: 'Recruit Sub-Agents',
        description: 'Recruit sellers under you and earn on every sale they make.',
        ctaLabel: 'Recruit Agents',
        href: '/dashboard/sub',
        gradientClass: 'from-orange-600 to-red-800',
        show: (p) => p.role === 'agent' || p.role === 'dealer',
    },
    {
        key: 'ussd',
        badgeIcon: Smartphone,
        badgeLabel: 'USSD',
        title: 'Buy on USSD — no app, no data',
        description: 'Dial *713*9939# from your registered number and pay your role price instantly.',
        ctaLabel: 'Sell on USSD',
        href: '/dashboard/upgrade',
        gradientClass: 'from-violet-600 to-purple-900',
        show: () => true,
    },
    {
        key: 'data',
        badgeIcon: Wifi,
        badgeLabel: 'Data Bundles',
        title: 'MTN, Telecel & AT data',
        description: 'High-speed data packages at wholesale reseller rates.',
        ctaLabel: 'Buy Data',
        href: '/dashboard/data-packages',
        gradientClass: 'from-emerald-700 to-green-900',
        show: () => true,
    },
    {
        key: 'airtime',
        badgeIcon: Phone,
        badgeLabel: 'Airtime',
        title: 'Instant airtime top-up',
        description: 'VTU airtime recharge for all networks with direct phone delivery.',
        ctaLabel: 'Buy Airtime',
        href: '/dashboard/airtime',
        gradientClass: 'from-blue-700 to-indigo-900',
        show: () => true,
    },
    {
        key: 'results-checker',
        badgeIcon: GraduationCap,
        badgeLabel: 'Results Checker',
        title: 'WAEC, BECE & WASSCE vouchers',
        description: 'Purchase results checker vouchers instantly, delivered as codes.',
        ctaLabel: 'Buy Vouchers',
        href: '/dashboard/results-checker',
        gradientClass: 'from-rose-700 to-red-950',
        show: () => true,
    },
    {
        key: 'mtn-registration',
        badgeIcon: Search,
        badgeLabel: 'MTN Check',
        title: 'Check MTN registration',
        description: 'See which MTN numbers are registered for data before you order — avoid delays.',
        ctaLabel: 'Check Numbers',
        href: '/dashboard/mtn-registration',
        gradientClass: 'from-yellow-600 to-amber-800',
        show: () => true,
    },
    {
        key: 'verify',
        badgeIcon: ShieldCheck,
        badgeLabel: 'Verify',
        title: 'Verify your phone number',
        description: 'Verified numbers get instant delivery on every order — no manual review delays.',
        ctaLabel: 'Verify Now',
        href: '/auth/verify-phone',
        gradientClass: 'from-red-800 to-rose-950',
        show: (p) => !p.phoneVerified,
    },
]

const AUTO_ADVANCE_MS = 5000

export function PromoHeroCarousel({ role, phoneVerified }: PromoHeroCarouselProps) {
    const slides = useMemo(
        () => ALL_SLIDES.filter((s) => s.show({ role, phoneVerified })),
        [role, phoneVerified]
    )
    const n = slides.length

    // The track holds [last, ...slides, first]. `pos` indexes the track, so the
    // real slides live at 1..n. Sliding onto a clone at either end and then
    // jumping (without animation) to its twin makes the loop seamless, so the
    // last slide moves on to the first instead of rewinding past every slide.
    const track = useMemo(() => (n > 1 ? [slides[n - 1], ...slides, slides[0]] : slides), [slides, n])
    const [pos, setPos] = useState(n > 1 ? 1 : 0)
    const [animate, setAnimate] = useState(true)
    const [dragDx, setDragDx] = useState(0)
    const moving = useRef(false)
    const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

    const current = n > 1 ? (pos - 1 + n) % n : 0
    const posRef = useRef(pos)
    posRef.current = pos
    const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

    // End of a slide move: unlock, and if we landed on a clone jump to its twin.
    // Runs on transitionend, with a timer as backup because a hidden tab may
    // never fire the event and the carousel would otherwise stay locked.
    const settle = useCallback(() => {
        if (settleTimer.current) { clearTimeout(settleTimer.current); settleTimer.current = null }
        if (!moving.current) return
        moving.current = false
        const p = posRef.current
        if (p >= n + 1) { setAnimate(false); setPos(1) }
        else if (p <= 0) { setAnimate(false); setPos(n) }
    }, [n])
    const armSettle = useCallback(() => {
        if (settleTimer.current) clearTimeout(settleTimer.current)
        settleTimer.current = setTimeout(settle, 700)
    }, [settle])
    useEffect(() => () => { if (settleTimer.current) clearTimeout(settleTimer.current) }, [])

    useEffect(() => {
        setAnimate(false)
        setPos(n > 1 ? 1 : 0)
        moving.current = false
    }, [n])

    // Re-enable the transition a frame after an instant jump.
    useEffect(() => {
        if (animate) return
        let inner = 0
        const outer = requestAnimationFrame(() => {
            inner = requestAnimationFrame(() => setAnimate(true))
        })
        return () => {
            cancelAnimationFrame(outer)
            cancelAnimationFrame(inner)
        }
    }, [animate])

    const go = useCallback((target: number) => {
        if (n <= 1 || moving.current) return
        moving.current = true
        setAnimate(true)
        setPos(target)
        armSettle()
    }, [n, armSettle])

    const startTimer = useCallback(() => {
        if (timerRef.current) clearInterval(timerRef.current)
        if (n <= 1) return
        timerRef.current = setInterval(() => {
            if (moving.current) return
            moving.current = true
            setAnimate(true)
            setPos((p) => p + 1)
            armSettle()
        }, AUTO_ADVANCE_MS)
    }, [n, armSettle])

    useEffect(() => {
        startTimer()
        return () => {
            if (timerRef.current) clearInterval(timerRef.current)
        }
    }, [startTimer])

    const onTransitionEnd = (e: React.TransitionEvent) => {
        if (e.target !== e.currentTarget) return
        settle()
    }

    const handleNav = (i: number) => { go(i + 1); startTimer() }
    const prev = () => { go(pos - 1); startTimer() }
    const next = () => { go(pos + 1); startTimer() }

    // Swipe on touch, drag with a mouse: the track follows the finger, and a
    // move past 40px changes slide on release; anything shorter is a tap.
    const dragStart = useRef<{ x: number; y: number; horizontal: boolean | null } | null>(null)
    const dragged = useRef(false)
    const onPointerDown = (e: React.PointerEvent) => {
        if (n <= 1 || moving.current) return
        if ((e.target as HTMLElement).closest('button')) return
        dragStart.current = { x: e.clientX, y: e.clientY, horizontal: null }
        dragged.current = false
    }
    const onPointerMove = (e: React.PointerEvent) => {
        const s = dragStart.current
        if (!s) return
        const dx = e.clientX - s.x
        const dy = e.clientY - s.y
        if (s.horizontal === null && (Math.abs(dx) > 6 || Math.abs(dy) > 6)) {
            s.horizontal = Math.abs(dx) > Math.abs(dy)
            if (!s.horizontal) { dragStart.current = null; return }
            if (timerRef.current) clearInterval(timerRef.current)
        }
        if (s.horizontal) setDragDx(dx)
    }
    const endDrag = (e?: React.PointerEvent) => {
        const s = dragStart.current
        dragStart.current = null
        if (!s || !s.horizontal) { setDragDx(0); return }
        const dx = e ? e.clientX - s.x : dragDx
        setDragDx(0)
        if (Math.abs(dx) > 40) {
            dragged.current = true
            go(dx < 0 ? pos + 1 : pos - 1)
        }
        startTimer()
    }
    // Swallow the click that ends a drag so it does not open the slide's link.
    const onClickCapture = (e: React.MouseEvent) => {
        if (dragged.current) {
            e.preventDefault()
            e.stopPropagation()
            dragged.current = false
        }
    }

    if (n === 0) return null

    return (
        <div
            className="relative w-full overflow-hidden rounded-3xl shadow-sm select-none touch-pan-y"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerLeave={() => endDrag()}
            onPointerCancel={() => endDrag()}
            onClickCapture={onClickCapture}
            onKeyDown={(e) => {
                if (e.key === 'ArrowLeft') prev()
                else if (e.key === 'ArrowRight') next()
            }}
            role="region"
            aria-roledescription="carousel"
        >
            <div
                className="flex h-52 sm:h-48"
                style={{
                    transform: `translateX(calc(${-pos * 100}% + ${dragDx}px))`,
                    transition: animate && dragDx === 0 ? 'transform 500ms cubic-bezier(0.22, 0.61, 0.36, 1)' : 'none',
                }}
                onTransitionEnd={onTransitionEnd}
            >
                {track.map((slide, ti) => (
                    <div
                        key={`${slide.key}-${ti}`}
                        className="relative h-full w-full shrink-0"
                        aria-hidden={ti !== pos}
                    >
                        <div className={cn('relative h-full w-full bg-gradient-to-br py-4 px-12 sm:py-6 sm:px-14 flex flex-col justify-between', slide.gradientClass)}>
                            <div className="absolute top-0 right-0 w-48 h-48 bg-white/10 rounded-full blur-3xl -mr-20 -mt-20 pointer-events-none" />

                            <div className={cn('relative z-10 flex items-start justify-between', slide.logo && 'pr-14 sm:pr-24')}>
                                <span className="inline-flex items-center gap-1.5 rounded-full bg-white/15 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wider text-white">
                                    <slide.badgeIcon className="w-3 h-3" />
                                    {slide.badgeLabel}
                                </span>
                                {!slide.logo && (
                                    <div className="w-9 h-9 rounded-xl bg-white/15 flex items-center justify-center">
                                        <slide.badgeIcon className="w-4 h-4 text-white" />
                                    </div>
                                )}
                            </div>

                            {slide.logo && (
                                <div className="absolute right-12 sm:right-16 top-1/2 -translate-y-1/2 z-10 w-16 h-16 sm:w-20 sm:h-20 rounded-2xl bg-white p-1.5 shadow-lg overflow-hidden flex items-center justify-center">
                                    {/* eslint-disable-next-line @next/next/no-img-element */}
                                    <img src={slide.logo} alt="" draggable={false} className="w-full h-full object-contain rounded-xl" />
                                </div>
                            )}

                            <div className={cn('relative z-10 pb-7', slide.logo && 'pr-24 sm:pr-36')}>
                                <h3 className="text-base sm:text-xl font-black text-white tracking-tight mb-1">
                                    {slide.title}
                                </h3>
                                <p className="text-xs sm:text-sm text-white/85 font-medium leading-snug mb-2.5 max-w-md line-clamp-2">
                                    {slide.description}
                                </p>
                                <Link href={slide.href} draggable={false} tabIndex={ti === pos ? 0 : -1}>
                                    <span className="inline-flex items-center justify-center rounded-xl bg-white px-4 py-2 text-xs sm:text-sm font-bold text-slate-900 shadow-lg transition-transform hover:scale-[1.02] active:scale-95">
                                        {slide.ctaLabel}
                                    </span>
                                </Link>
                            </div>
                        </div>
                    </div>
                ))}
            </div>

            {slides.length > 1 && (
                <>
                    <button
                        type="button"
                        aria-label="Previous slide"
                        onClick={prev}
                        className="absolute left-2 top-1/2 -translate-y-1/2 z-20 w-8 h-8 rounded-full bg-black/30 hover:bg-black/50 text-white flex items-center justify-center backdrop-blur-sm transition"
                    >
                        <ChevronLeft className="w-4 h-4" />
                    </button>
                    <button
                        type="button"
                        aria-label="Next slide"
                        onClick={next}
                        className="absolute right-2 top-1/2 -translate-y-1/2 z-20 w-8 h-8 rounded-full bg-black/30 hover:bg-black/50 text-white flex items-center justify-center backdrop-blur-sm transition"
                    >
                        <ChevronRight className="w-4 h-4" />
                    </button>
                </>
            )}

            {slides.length > 1 && (
                <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-20 flex items-center gap-2">
                    {slides.map((slide, i) => (
                        <button
                            key={slide.key}
                            type="button"
                            aria-label={`Show ${slide.title}`}
                            onClick={() => handleNav(i)}
                            className={cn(
                                'h-1.5 rounded-full bg-white transition-all duration-300',
                                i === current ? 'w-7 opacity-100' : 'w-1.5 opacity-40 hover:opacity-70'
                            )}
                        />
                    ))}
                </div>
            )}
        </div>
    )
}
