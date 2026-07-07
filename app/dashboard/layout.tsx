'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { AgentExpiryModal } from '@/components/agent-expiry-modal'
import { useAuth } from '@/contexts/auth-context'
import { UIProvider } from '@/contexts/ui-context'
import { DashboardSidebar } from '@/components/dashboard/sidebar'
import { DashboardHeader } from '@/components/dashboard/header'
import { MobileBottomNav } from '@/components/dashboard/mobile-bottom-nav'
import { PageAccessGuard } from '@/components/dashboard/page-access-guard'
import { Skeleton } from '@/components/ui/skeleton'
import { PushNotificationManager } from '@/components/PushNotificationManager'
import { cn } from '@/lib/utils'
import { useUI } from '@/contexts/ui-context'
// import { SupportChatWidget } from '@/components/dashboard/support-chat-widget'
import { SuspendedAccount } from '@/components/dashboard/SuspendedAccount'
import { CopyrightFooter } from '@/components/CopyrightFooter'
import { SystemAnnouncementModal } from '@/components/system-announcement-modal'


export default function DashboardLayout({
    children,
}: {
    children: React.ReactNode
}) {
    const { user, dbUser, isLoading } = useAuth()
    const { isCollapsed } = useUI()
    const router = useRouter()

    useEffect(() => {
        if (!isLoading && !user) {
            router.push('/auth/login')
        }
    }, [user, isLoading, router])

    if (isLoading) {
        return (
            <div className="min-h-screen bg-background flex items-center justify-center">
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

    if (user && !dbUser) {
        return (
            <div className="min-h-screen bg-background flex flex-col items-center justify-center p-4">
                <div className="text-center max-w-md animate-in fade-in zoom-in duration-500">
                    <div className="bg-red-100 dark:bg-red-900/20 p-4 rounded-full inline-flex mb-6">
                        <svg className="w-10 h-10 text-red-600 dark:text-red-500" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>
                    </div>
                    <h2 className="text-2xl font-bold mb-3">Connection Error</h2>
                    <p className="text-muted-foreground mb-6">
                        We securely authenticated you, but couldn't load your dashboard profile. This can happen during network delays or system updates.
                    </p>
                    <button 
                        onClick={() => window.location.reload()}
                        className="inline-flex items-center justify-center rounded-xl bg-primary px-8 py-3 text-sm font-bold text-primary-foreground shadow hover:bg-primary/90 transition-colors w-full sm:w-auto"
                    >
                        Reload Dashboard
                    </button>
                </div>
            </div>
        )
    }

    const isSuspended = dbUser?.status === 'suspended' && (dbUser?.role === 'agent' || dbUser?.role === 'customer')

    if (isSuspended) {
        return (
            <div className="min-h-screen bg-background relative">
                <DashboardSidebar />
                <div className={cn(
                    "relative transition-all duration-300 ease-in-out min-h-screen flex flex-col w-full max-w-[100vw] overflow-x-hidden",
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

    return (
        <div className="min-h-screen bg-background relative">
            <PushNotificationManager />
            <SystemAnnouncementModal userRole={dbUser?.role} />
            <AgentExpiryModal />
            <DashboardSidebar />
            <div className={cn(
                "relative transition-all duration-300 ease-in-out min-h-screen flex flex-col w-full max-w-[100vw] overflow-x-hidden",
                isCollapsed ? "lg:pl-20" : "lg:pl-80"
            )}>
                <DashboardHeader />
                <div className="h-16 flex-shrink-0" />
                <main className="p-4 pb-24 md:pb-4 lg:p-6 flex-1">
                    <PageAccessGuard>
                        {children}
                    </PageAccessGuard>
                </main>
                <CopyrightFooter className="bg-background/60" />
            </div>
            <MobileBottomNav />
            {/* <SupportChatWidget /> */}
        </div>
    )
}
