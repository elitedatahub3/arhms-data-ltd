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
}

const ALL_SLIDES: (Slide & { show: (p: PromoHeroCarouselProps) => boolean })[] = [
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

    const [current, setCurrent] = useState(0)
    const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

    useEffect(() => {
        if (current >= slides.length) setCurrent(0)
    }, [slides.length, current])

    const startTimer = useCallback(() => {
        if (timerRef.current) clearInterval(timerRef.current)
        if (slides.length <= 1) return
        timerRef.current = setInterval(() => {
            setCurrent((i) => (i + 1) % slides.length)
        }, AUTO_ADVANCE_MS)
    }, [slides.length])

    useEffect(() => {
        startTimer()
        return () => {
            if (timerRef.current) clearInterval(timerRef.current)
        }
    }, [startTimer])

    const handleNav = (i: number) => {
        setCurrent(i)
        startTimer()
    }

    if (slides.length === 0) return null

    return (
        <div className="relative w-full overflow-hidden rounded-3xl shadow-sm">
            <div className="relative h-52 sm:h-48">
                {slides.map((slide, i) => (
                    <div
                        key={slide.key}
                        className={cn(
                            'absolute inset-0 transition-opacity duration-500 ease-in-out',
                            i === current ? 'opacity-100 z-10' : 'opacity-0 z-0 pointer-events-none'
                        )}
                    >
                        <div className={cn('relative h-full w-full bg-gradient-to-br p-4 sm:p-6 flex flex-col justify-between', slide.gradientClass)}>
                            <div className="absolute top-0 right-0 w-48 h-48 bg-white/10 rounded-full blur-3xl -mr-20 -mt-20 pointer-events-none" />

                            <div className="relative z-10 flex items-start justify-between">
                                <span className="inline-flex items-center gap-1.5 rounded-full bg-white/15 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wider text-white">
                                    <slide.badgeIcon className="w-3 h-3" />
                                    {slide.badgeLabel}
                                </span>
                                <div className="w-9 h-9 rounded-xl bg-white/15 flex items-center justify-center">
                                    <slide.badgeIcon className="w-4 h-4 text-white" />
                                </div>
                            </div>

                            <div className="relative z-10 pb-7">
                                <h3 className="text-base sm:text-xl font-black text-white tracking-tight mb-1">
                                    {slide.title}
                                </h3>
                                <p className="text-xs sm:text-sm text-white/85 font-medium leading-snug mb-2.5 max-w-md line-clamp-2">
                                    {slide.description}
                                </p>
                                <Link href={slide.href}>
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
