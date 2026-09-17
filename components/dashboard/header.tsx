'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { useAuth } from '@/contexts/auth-context'
import { useUI } from '@/contexts/ui-context'
import { Button } from '@/components/ui/button'
import { ThemeToggle } from '@/components/ui/theme-toggle'
import { AnnouncementBell } from '@/components/dashboard/AnnouncementBell'
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { roleConfig } from '@/lib/roles'
import { supabase } from '@/lib/supabase'
import { toast } from 'sonner'
import { Menu, X, Bell, User, Settings, LogOut } from 'lucide-react'
import { cn } from '@/lib/utils'

export function DashboardHeader() {
    const { dbUser, signOut, isAdmin, isSubAdmin } = useAuth()
    const { toggleSidebar, isCollapsed, isInternalSidebarOpen } = useUI()
    const [unreadCount, setUnreadCount] = useState(0)

    const fetchUnreadNotifications = async (userId: string) => {
        const { count } = await supabase
            .from('notifications')
            .select('*', { count: 'exact', head: true })
            .eq('user_id', userId as any)
            .eq('is_read', false)
        setUnreadCount(count || 0)
    }

    // Keyed on the id, not the row: a profile refetch must not tear down and
    // re-open the realtime channel and re-count notifications.
    const userId = dbUser?.id
    useEffect(() => {
        if (!userId) return

        fetchUnreadNotifications(userId)

        // Real-time subscription — update count and toast new arrivals
        const channel = supabase
            .channel(`notifications:${userId}`)
            .on(
                'postgres_changes' as any,
                {
                    event: '*',
                    schema: 'public',
                    table: 'notifications',
                    filter: `user_id=eq.${userId}`,
                },
                (payload: any) => {
                    fetchUnreadNotifications(userId)
                    if (payload.eventType === 'INSERT' && payload.new) {
                        const n = payload.new
                        toast(n.title, {
                            description: n.message,
                            duration: 6000,
                            action: n.action_url
                                ? { label: 'View', onClick: () => { window.location.href = n.action_url } }
                                : undefined,
                        })
                    }
                }
            )
            .subscribe()

        return () => { supabase.removeChannel(channel) }
    }, [userId])

    const getInitials = () => {
        if (!dbUser) return 'U'
        return `${dbUser.first_name?.[0] || ''}${dbUser.last_name?.[0] || ''}`.toUpperCase()
    }

    const userRole = isAdmin ? 'admin' : isSubAdmin ? 'sub-admin' : (dbUser?.role || 'customer') as keyof typeof roleConfig
    const currentRole = roleConfig[userRole] || roleConfig['customer']

    return (
        <header className={cn(
            'fixed top-0 left-0 right-0 z-40 h-16 transition-all duration-300 ease-in-out',
            currentRole.headerBg,
            // Desktop only: offset header by sidebar width
            isCollapsed ? 'lg:left-20' : 'lg:left-[260px]',
        )}>
            <div className="h-full px-4 sm:px-6 lg:px-8 flex items-center justify-between">
                <div className="flex items-center gap-3 min-w-0">
                    <Button
                        variant="ghost"
                        size="icon"
                        className={cn(
                            "lg:hidden rounded-xl",
                            currentRole.headerButton
                        )}
                        onClick={toggleSidebar}
                    >
                        {isInternalSidebarOpen
                            ? <X className="w-5 h-5" />
                            : <Menu className="w-5 h-5" />}
                    </Button>

                    <div className="hidden sm:block min-w-0">
                        <h1 className={cn("text-base lg:text-lg font-heading font-black tracking-tight truncate", currentRole.headerText)}>
                            {dbUser?.role === 'dealer' ? (
                                <>Welcome back, <span className="text-white">{dbUser?.first_name || 'User'}! 👋</span></>
                            ) : (
                                <>Welcome, <span className="text-primary">{dbUser?.first_name || 'User'}</span></>
                            )}
                        </h1>
                        <p className={cn("text-xs font-medium tracking-wide uppercase", currentRole.headerSubText)}>
                            {dbUser?.role === 'dealer' 
                                ? "Here's what's happening with your account" 
                                : `Platform Overview • ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}`}
                        </p>
                    </div>

                    <div className="sm:hidden">
                        <p className={cn("text-sm font-black tracking-tight", currentRole.headerText)}>
                            {dbUser?.role === 'dealer' ? 'Dealer Dashboard' : 'Dashboard'}
                        </p>
                    </div>
                </div>

                <div className="flex items-center gap-2 sm:gap-3">
                    {dbUser?.role === 'dealer' && (
                        <Button
                            variant="outline"
                            size="sm"
                            className="hidden sm:inline-flex border-white/30 text-white hover:bg-white/10 hover:text-white rounded-xl h-9 font-bold"
                        >
                            Install App
                        </Button>
                    )}

                    <div>
                        <AnnouncementBell inline />
                    </div>

                    <div className="flex items-center gap-2">
                        <ThemeToggle />
                        <Link href="/dashboard/notifications">
                            <Button
                                variant="ghost"
                                size="icon"
                                className={cn(
                                    "relative rounded-xl",
                                    currentRole.headerButton
                                )}
                            >
                                <Bell className="w-[18px] h-[18px]" />
                                {unreadCount > 0 && (
                                    <span className={cn(
                                        "absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 text-[10px] font-black rounded-full ring-2 flex items-center justify-center leading-none",
                                        dbUser?.role === 'dealer'
                                            ? "bg-white text-purple-950 ring-purple-900"
                                            : "bg-primary text-primary-foreground ring-background"
                                    )}>
                                        {unreadCount > 99 ? '99+' : unreadCount}
                                    </span>
                                )}
                            </Button>
                        </Link>
                    </div>

                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button variant="ghost" className={cn(
                                "flex items-center gap-2 sm:gap-3 px-2 h-10 sm:h-11 rounded-xl transition-all group",
                                currentRole.headerButton
                            )}>
                                <div className="flex flex-col items-end hidden md:flex">
                                    <span
                                        className={cn(
                                            "text-[10px] font-black px-2 py-0.5 rounded-full uppercase tracking-widest mt-0.5",
                                            currentRole.badgeClass
                                        )}
                                    >
                                        {currentRole.label}
                                    </span>
                                </div>
                                <Avatar className="h-8 w-8 sm:h-9 sm:w-9 rounded-lg border-2 border-border/50 group-hover:border-primary/50 transition-all overflow-hidden">
                                    <AvatarFallback className={cn(
                                        'bg-gradient-to-br text-white font-black text-xs flex items-center justify-center',
                                        currentRole.gradient
                                    )}>
                                        <currentRole.icon className="w-4 h-4" />
                                    </AvatarFallback>
                                </Avatar>
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent className="w-64 mt-2 p-2 rounded-2xl border-border/50 shadow-premium" align="end">
                            <DropdownMenuLabel className="p-3">
                                <div className="flex flex-col gap-1">
                                    <p className="text-sm font-bold leading-none">{dbUser?.first_name} {dbUser?.last_name}</p>
                                    <p className="text-xs text-muted-foreground font-medium truncate">{dbUser?.email}</p>
                                </div>
                            </DropdownMenuLabel>
                            <DropdownMenuSeparator className="bg-border/50" />
                            <Link href="/dashboard/profile">
                                <DropdownMenuItem className="p-3 rounded-xl cursor-pointer">
                                    <User className="mr-3 h-4 w-4 text-primary" />
                                    <span className="font-semibold">My Profile</span>
                                </DropdownMenuItem>
                            </Link>
                            {isAdmin && (
                                <Link href="/admin/settings">
                                    <DropdownMenuItem className="p-3 rounded-xl cursor-pointer">
                                        <Settings className="mr-3 h-4 w-4 text-primary" />
                                        <span className="font-semibold">System Settings</span>
                                    </DropdownMenuItem>
                                </Link>
                            )}
                            <DropdownMenuSeparator className="bg-border/50" />
                            <DropdownMenuItem onClick={signOut} className="p-3 rounded-xl cursor-pointer text-red-500 focus:text-red-500 focus:bg-red-500/10">
                                <LogOut className="mr-3 h-4 w-4" />
                                <span className="font-bold">Sign Out</span>
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>
            </div>
        </header>
    )
}

