'use client'

import { useEffect, useState } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { AgentExpiryModal } from '@/components/agent-expiry-modal'
import { useAuth } from '@/contexts/auth-context'
import { UIProvider } from '@/contexts/ui-context'
import { DashboardSidebar } from '@/components/dashboard/sidebar'
import { DashboardHeader } from '@/components/dashboard/header'
import { MobileBottomNav } from '@/components/dashboard/mobile-bottom-nav'
import { PageAccessGuard } from '@/components/dashboard/page-access-guard'
import { Skeleton } from '@/components/ui/skeleton'
import { PushNotificationManager } from '@/components/PushNotificationManager'
import { ReferralClaimOnMount } from '@/components/dashboard/ReferralClaimOnMount'
import { cn } from '@/lib/utils'
import { useUI } from '@/contexts/ui-context'
// import { SupportChatWidget } from '@/components/dashboard/support-chat-widget'
import { SuspendedAccount } from '@/components/dashboard/SuspendedAccount'
import { CopyrightFooter } from '@/components/CopyrightFooter'
import { SubPortalShell } from '@/components/sub-portal/sub-shell'


export default function DashboardLayout({
    children,
}: {
    children: React.ReactNode
}) {
    const { user, dbUser, isLoading, isAdmin, isSubAdmin, refreshUser } = useAuth()
    const { isCollapsed } = useUI()
    const router = useRouter()
    const pathname = usePathname()

    useEffect(() => {
        if (!isLoading && !user) {
            router.push('/auth/login')
        }
    }, [user, isLoading, router])

    // If auth succeeded but the profile row didn't load (e.g. the initial fetch
    // timed out on a slow mobile network), try once more automatically before
    // showing the hard "Connection Error" screen. `refreshUser` refreshes the JWT
    // and re-runs the resilient, self-retrying fetch in the auth context.
    const [profileRetryDone, setProfileRetryDone] = useState(false)
    useEffect(() => {
        if (isLoading || !user || dbUser || profileRetryDone) return
        let active = true
        refreshUser().finally(() => { if (active) setProfileRetryDone(true) })
        return () => { active = false }
    }, [isLoading, user, dbUser, profileRetryDone, refreshUser])

    // Results Checker Only mode: regular users are restricted to the Results Checker
    // and Wallet pages (wallet is kept so they can top up to buy vouchers). Admins and
    // sub-admins are exempt. Any other dashboard route redirects to the Results Checker.
    // Seed from the last-known value cached in localStorage so the correct chrome
    // renders on the very first client paint (no flash of the full dashboard before
    // the async fetch resolves). The fetch below reconciles it with the live value.
    const [resultsCheckerOnly, setResultsCheckerOnly] = useState(() => {
        if (typeof window === 'undefined') return false
        return window.localStorage.getItem('rc_only_mode') === 'true'
    })
    const [rcSettingLoaded, setRcSettingLoaded] = useState(false)

    useEffect(() => {
        fetch('/api/admin-settings?keys=results_checker_only_mode')
            .then(r => r.ok ? r.json() : null)
            .then(data => {
                if (data) {
                    const rcOn = String(data.results_checker_only_mode) === 'true'
                    setResultsCheckerOnly(rcOn)
                    try { window.localStorage.setItem('rc_only_mode', rcOn ? 'true' : 'false') } catch {}
                }
            })
            .catch(() => {})
            .finally(() => setRcSettingLoaded(true))
    }, [])

    const rcRestricted = resultsCheckerOnly && !isAdmin && !isSubAdmin
    const rcPathAllowed =
        (pathname?.startsWith('/dashboard/results-checker') ||
            pathname?.startsWith('/dashboard/wallet') ||
            pathname?.startsWith('/dashboard/sub')) ?? false

    // Sub-agents use a de-branded portal, so the main ARHMS chrome (sidebar,
    // header, mobile nav, modals) must not apply. This holds for EVERY dashboard
    // route a sub-agent visits — not just /dashboard/sub — so tapping any link
    // (e.g. Shop Setup) never bounces them into the main-branded site.
    const [isSubAgent, setIsSubAgent] = useState(false)
    const [notSubAgent, setNotSubAgent] = useState(false)
    useEffect(() => {
        let active = true
        // 200 → the caller is a sub-agent; 403 → not one. Fail-open (both false)
        // so a hiccup never wrongly de-brands a regular user's dashboard, nor
        // bounces a real sub-agent out of their portal.
        fetch('/api/dashboard/sub/data')
            .then((r) => {
                if (!active) return
                if (r.ok) setIsSubAgent(true)
                else if (r.status === 403) setNotSubAgent(true)
            })
            .catch(() => {})
        return () => { active = false }
    }, [])

    // Anyone who is not a sub-agent has no business on a /dashboard/sub page —
    // most often a Lead still signed in on a recruit's phone, who would
    // otherwise see their own storefront presented as the recruit's.
    useEffect(() => {
        if (notSubAgent && pathname?.startsWith('/dashboard/sub')) {
            router.replace('/dashboard')
        }
    }, [notSubAgent, pathname, router])

    const isSubPortal = (pathname?.startsWith('/dashboard/sub') ?? false) || isSubAgent

    useEffect(() => {
        if (rcRestricted && rcSettingLoaded && pathname && !rcPathAllowed) {
            router.replace('/dashboard/results-checker')
        }
    }, [rcRestricted, rcSettingLoaded, pathname, rcPathAllowed, router])

    if (isLoading) {
        return (
            <div className="min-h-screen flex items-center justify-center">
                <div className="space-y-4 w-full max-w-md p-8">
                    <Skeleton className="h-12 w-full" />
                    <Skeleton className="h-8 w-3/4" />
                    <Skeleton className="h-8 w-1/2" />
                </div>
            </div>
        )
    }

    if (!user) {
        return null
    }

    // Auto-retry still in flight — keep the loading chrome rather than flashing
    // the error screen, which the retry may clear on its own.
    if (user && !dbUser && !profileRetryDone) {
        return (
            <div className="min-h-screen flex items-center justify-center">
                <div className="space-y-4 w-full max-w-md p-8">
                    <Skeleton className="h-12 w-full" />
                    <Skeleton className="h-8 w-3/4" />
                    <Skeleton className="h-8 w-1/2" />
                </div>
            </div>
        )
    }

    if (user && !dbUser) {
        return (
            <div className="min-h-screen flex flex-col items-center justify-center p-4">
                <div className="text-center max-w-md animate-in fade-in zoom-in duration-500">
                    <div className="bg-red-100 dark:bg-red-900/20 p-4 rounded-full inline-flex mb-6">
                        <svg className="w-10 h-10 text-red-600 dark:text-red-500" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>
                    </div>
                    <h2 className="text-2xl font-bold mb-3">Connection Error</h2>
                    <p className="text-muted-foreground mb-6">
                        We securely authenticated you, but couldn't load your dashboard profile. This can happen during network delays or system updates.
                    </p>
                    <button
                        onClick={() => setProfileRetryDone(false)}
                        className="inline-flex items-center justify-center rounded-xl bg-primary px-8 py-3 text-sm font-bold text-primary-foreground shadow hover:bg-primary/90 transition-colors w-full sm:w-auto"
                    >
                        Reload Dashboard
                    </button>
                </div>
            </div>
        )
    }

    // De-branded sub-agent portal: its own shop-branded sidebar, none of the
    // main ARHMS chrome. Auth + profile guards above still apply.
    if (isSubPortal) {
        return <SubPortalShell>{children}</SubPortalShell>
    }

    const isSuspended = dbUser?.status === 'suspended' && (dbUser?.role === 'agent' || dbUser?.role === 'customer')

    if (isSuspended) {
        return (
            <div className="min-h-screen relative">
                <DashboardSidebar />
                <div className={cn(
                    "relative lg:transition-[padding] lg:duration-300 ease-in-out min-h-screen flex flex-col w-full max-w-[100vw] overflow-x-hidden",
                    isCollapsed ? "lg:pl-20" : "lg:pl-80"
                )}>
                    <DashboardHeader />
                    <div className="h-16 flex-shrink-0" />
                    <main className="p-4 lg:p-6 flex-1">
                        <SuspendedAccount />
                    </main>
                    <CopyrightFooter className="bg-background/60" />
                </div>
                {/* <SupportChatWidget /> */}
            </div>
        )
    }

    // In Results Checker Only mode, hold the render on a blocked route until the
    // redirect above lands, so no restricted page content flashes.
    if (rcRestricted && !rcPathAllowed) {
        return (
            <div className="min-h-screen flex items-center justify-center">
                <Skeleton className="h-10 w-40" />
            </div>
        )
    }

    return (
        <div className="min-h-screen relative">
            <PushNotificationManager />
            <ReferralClaimOnMount />
            <AgentExpiryModal />
            <DashboardSidebar />
            <div className={cn(
                "relative lg:transition-[padding] lg:duration-300 ease-in-out min-h-screen flex flex-col w-full max-w-[100vw] overflow-x-hidden",
                isCollapsed ? "lg:pl-20" : "lg:pl-80"
            )}>
                <DashboardHeader />
                <div className="h-16 flex-shrink-0" />
                <main className="p-4 pb-44 md:pb-4 lg:p-6 flex-1">
                    <PageAccessGuard>
                        {children}
                    </PageAccessGuard>
                </main>
                <CopyrightFooter className="bg-background/60" />
            </div>
            {!rcRestricted && <MobileBottomNav />}
            {/* <SupportChatWidget /> */}
        </div>
    )
}
