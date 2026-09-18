'use client'

import { useEffect } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { useAuth } from '@/contexts/auth-context'
import { ShieldAlert } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useUI } from '@/contexts/ui-context'
import { DashboardSidebar } from '@/components/dashboard/sidebar'
import { DashboardHeader } from '@/components/dashboard/header'
import { MobileBottomNav } from '@/components/dashboard/mobile-bottom-nav'
import { Skeleton } from '@/components/ui/skeleton'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { CopyrightFooter } from '@/components/CopyrightFooter'

export default function AdminShell({
    children,
}: {
    children: React.ReactNode
}) {
    const { user, dbUser, isLoading, isAdmin, isSubAdmin } = useAuth()
    const { isCollapsed } = useUI()
    const router = useRouter()
    const pathname = usePathname()

    useEffect(() => {
        if (!isLoading) {
            if (!user) {
                router.push('/auth/login')
            } else if (!isAdmin && !isSubAdmin) {
                router.push('/dashboard')
            } else if (isSubAdmin && pathname && !pathname.startsWith('/admin/orders')) {
                // Redirect sub-admin to orders if they try to access other admin pages
                router.push('/admin/orders')
            }
        }
    }, [user, isAdmin, isSubAdmin, isLoading, router, pathname])

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

    if (!isAdmin && !isSubAdmin) {
        return (
            <div className="min-h-screen flex items-center justify-center p-4">
                <Alert variant="destructive" className="max-w-md">
                    <ShieldAlert className="h-4 w-4" />
                    <AlertTitle>Access Denied</AlertTitle>
                    <AlertDescription>
                        You do not have permission to access the admin panel. Please contact an administrator if you believe this is an error.
                    </AlertDescription>
                </Alert>
            </div>
        )
    }

    return (
        <div className="min-h-screen bg-[#E5E7EB] dark:bg-[#000000]">
            <DashboardSidebar />
            <div className={cn(
                "relative transition-all duration-300 ease-in-out min-h-screen flex flex-col w-full max-w-[100vw] overflow-x-hidden",
                isCollapsed ? "lg:pl-20" : "lg:pl-80"
            )}>
                <DashboardHeader />
                <div className="h-16 flex-shrink-0" />
                {/* pb clears the fixed bottom bar, which is mobile-only. */}
                <main className="p-4 pb-44 md:pb-4 lg:p-6 flex-1">
                    {children}
                </main>
                <CopyrightFooter className="bg-[#E5E7EB]/50 dark:bg-[#000000]/50" />
            </div>
            <MobileBottomNav variant="admin" />
        </div>
    )
}
