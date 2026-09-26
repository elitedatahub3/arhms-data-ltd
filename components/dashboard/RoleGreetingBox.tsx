'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { useAuth } from '@/contexts/auth-context'
import { formatCurrency } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { roleConfig } from '@/lib/roles'
import { toast } from 'sonner'
import {
    Sparkles,
    Shield,
    Clock,
    Star,
    Crown,
    Settings,
    ShoppingCart,
    Wallet
} from 'lucide-react'

interface RoleGreetingBoxProps {
    stats?: {
        totalOrders: number
        walletBalance: number
    }
}

export function RoleGreetingBox({ stats }: RoleGreetingBoxProps) {
    const { dbUser, isAdmin, isSubAdmin, isSubAgent } = useAuth()
    const [currentTime, setCurrentTime] = useState(new Date())
    const [autoUpgrade, setAutoUpgrade] = useState(false)

    useEffect(() => {
        const timer = setInterval(() => {
            setCurrentTime(new Date())
        }, 1000)
        return () => clearInterval(timer)
    }, [])

    if (!dbUser) return null

    const getGreeting = () => {
        const hour = currentTime.getHours()
        if (hour >= 5 && hour < 12) return 'Good Morning'
        if (hour >= 12 && hour < 17) return 'Good Afternoon'
        if (hour >= 17 && hour < 21) return 'Good Evening'
        return 'Good Night'
    }

    const formatDateTime = () => {
        const dateStr = currentTime.toLocaleDateString('en-US', {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric'
        })
        const timeStr = currentTime.toLocaleTimeString('en-US', {
            hour: 'numeric',
            minute: '2-digit',
            second: '2-digit',
            hour12: true
        })
        return { dateStr, timeStr }
    }

    const { dateStr, timeStr } = formatDateTime()

    const calculateDaysRemaining = () => {
        if (dbUser?.role === 'agent' && dbUser?.agent_expires_at) {
            const now = new Date()
            const expires = new Date(dbUser.agent_expires_at)
            const days = Math.ceil((expires.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
            return days > 0 ? days : 0
        }
        if (dbUser?.role === 'dealer' && (dbUser as any)?.dealer_expires_at) {
            const now = new Date()
            const expires = new Date((dbUser as any).dealer_expires_at)
            const days = Math.ceil((expires.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
            return days > 0 ? days : 0
        }
        return null
    }

    const daysRemaining = calculateDaysRemaining()

    const getTimeSinceJoined = () => {
        if (!dbUser?.created_at) return 'Recently'
        const now = new Date()
        const joined = new Date(dbUser.created_at)
        const diffMs = now.getTime() - joined.getTime()
        const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))

        if (diffDays < 30) return `${diffDays} ${diffDays === 1 ? 'day' : 'days'} ago`
        if (diffDays < 365) {
            const months = Math.floor(diffDays / 30)
            return `${months} ${months === 1 ? 'month' : 'months'} ago`
        }
        const years = Math.floor(diffDays / 365)
        return `${years} ${years === 1 ? 'year' : 'years'} ago`
    }

    const userRole = isAdmin ? 'admin' : isSubAdmin ? 'sub-admin' : (dbUser?.role || 'customer') as keyof typeof roleConfig
    const currentRole = roleConfig[userRole] || roleConfig['customer']

    const roleLabel = 
        isAdmin ? 'System Administrator' :
        isSubAdmin ? 'Sub-Administrator' :
        isSubAgent ? 'Sub-Agent' :
        dbUser.role === 'dealer' ? 'Authorized Dealer' :
        dbUser.role === 'agent' ? 'Authorized Agent' :
        'Valued Customer'

    const Icon = currentRole.icon
    const accentClass = currentRole.accentText
    const pillClass = currentRole.greetingPill
    // Dealer and agent greeting cards are saturated gradients; everyone else
    // (customer included, now that it is white) sits on a light surface.
    const onDarkCard = dbUser.role === 'dealer' || dbUser.role === 'agent'

    return (
        <div className={cn("transition-all overflow-hidden relative", currentRole.greetingCard)}>
            <div className={cn(
                "absolute inset-0 pointer-events-none",
                dbUser.role === 'dealer'
                    ? "bg-[radial-gradient(circle_at_top_right,rgba(255,255,255,0.15),transparent_45%)]"
                    : dbUser.role === 'customer'
                        // The shared glow is --primary, which is blue; a blue wash
                        // on a gold-accented white card fights the theme.
                        ? "bg-[radial-gradient(circle_at_top_right,rgba(212,175,55,0.16),transparent_55%)]"
                        : "bg-[radial-gradient(circle_at_top_right,hsl(var(--primary)/0.12),transparent_45%)]"
            )} />
            <div className="absolute top-0 right-0 -mt-10 -mr-10 opacity-10 pointer-events-none">
                <Icon className={cn('w-40 h-40', accentClass)} />
            </div>

            <div className="relative z-10 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-5">
                <div className="flex flex-col gap-2 min-w-0">
                    <div className="flex items-center gap-2 min-w-0">
                        <Icon className={cn('w-5 h-5 sm:w-6 sm:h-6 shrink-0', accentClass)} />
                        <h2 className={cn("text-xl sm:text-2xl font-black truncate", onDarkCard ? "text-white" : "text-foreground")}>
                            {getGreeting()}, {dbUser.first_name}!
                        </h2>
                    </div>
                    <p className={cn("text-xs sm:text-sm pl-0.5", onDarkCard ? "text-white/80" : "text-muted-foreground")}>
                        Here is an overview of your transactions, shop performance, and recent activity.
                    </p>
                </div>
                <div className={cn("flex flex-row sm:flex-col items-start sm:items-end gap-2 sm:gap-0", onDarkCard ? "text-white" : "text-foreground")}>
                    <p className={cn("text-xs sm:text-sm font-semibold", onDarkCard ? "text-white/80" : "text-muted-foreground")}>{dateStr}</p>
                    <p className="text-sm sm:text-lg font-black">{timeStr}</p>
                </div>
            </div>

            <div className="relative z-10 flex flex-col gap-3">
                <div className={cn("rounded-xl p-3 sm:p-4 flex items-center justify-between", currentRole.greetingRow)}>
                    <div className="flex items-center gap-3">
                        <Shield className={cn("w-5 h-5 sm:w-6 sm:h-6", currentRole.greetingText)} />
                        <p className={cn("text-xs sm:text-sm font-semibold", currentRole.greetingText)}>Your Role</p>
                    </div>
                    <p className={cn('text-sm sm:text-base font-black px-3 py-1 rounded-full', pillClass)}>
                        {roleLabel}
                    </p>
                </div>

                {dbUser.role === 'dealer' ? (
                    <div className={cn("rounded-xl p-3 sm:p-4 flex items-center justify-between", currentRole.greetingRow)}>
                        <div className="flex items-center gap-3">
                            <Clock className={cn("w-5 h-5 sm:w-6 sm:h-6", currentRole.greetingText)} />
                            <div className="flex flex-col">
                                <p className={cn("text-xs sm:text-sm font-semibold", currentRole.greetingText)}>Dealer Membership</p>
                                <div className="inline-block px-2.5 py-0.5 rounded-full text-[10px] sm:text-xs font-bold w-fit mt-0.5 bg-emerald-500 text-white border-0">
                                    Active
                                </div>
                            </div>
                        </div>
                        <div className="flex flex-col items-end gap-1">
                            {daysRemaining !== null && (
                                <p className="text-sm sm:text-lg font-black text-white">
                                    {daysRemaining} {daysRemaining === 1 ? 'day' : 'days'} left
                                </p>
                            )}
                        </div>
                    </div>
                ) : dbUser.role === 'agent' ? (
                    <div className={cn("rounded-xl p-3 sm:p-4 flex items-center justify-between", currentRole.greetingRow)}>
                        <div className="flex items-center gap-3">
                            <Clock className={cn("w-5 h-5 sm:w-6 sm:h-6", currentRole.greetingText)} />
                            <div className="flex flex-col">
                                <p className={cn("text-xs sm:text-sm font-semibold", currentRole.greetingText)}>Membership</p>
                                <div className={cn(
                                    'inline-block px-2 py-0.5 rounded-full text-[10px] sm:text-xs font-bold w-fit mt-0.5',
                                    daysRemaining !== null && daysRemaining <= 3
                                        ? 'bg-red-500/20 text-red-500'
                                        : daysRemaining !== null && daysRemaining <= 7
                                            ? 'bg-amber-500/20 text-amber-600 dark:text-amber-400'
                                            : 'bg-emerald-500/20 text-emerald-600 dark:text-emerald-400'
                                )}>
                                    Active
                                </div>
                            </div>
                        </div>
                        <div className="flex flex-col items-end gap-1">
                            {daysRemaining !== null && (
                                <p className="text-sm sm:text-lg font-black text-white">
                                    {daysRemaining} {daysRemaining === 1 ? 'day' : 'days'} left
                                </p>
                            )}
                            {daysRemaining !== null && daysRemaining <= 7 && (
                                <Link href="/dashboard/upgrade">
                                    <Button size="sm" className="h-7 px-3 text-[10px] sm:text-xs bg-red-600 hover:bg-red-700 text-white border-0 shadow-md">
                                        Renew Now
                                    </Button>
                                </Link>
                            )}
                        </div>
                    </div>
                ) : isAdmin || isSubAdmin ? (
                    <div className={cn("rounded-xl p-3 sm:p-4 flex items-center justify-between", currentRole.greetingRow)}>
                        <div className="flex items-center gap-3">
                            <Settings className={cn("w-5 h-5 sm:w-6 sm:h-6", currentRole.greetingText)} />
                            <p className={cn("text-xs sm:text-sm font-semibold", currentRole.greetingText)}>System Access</p>
                        </div>
                        <Link href="/admin">
                            <Button size="sm" className="h-8 px-4 text-xs font-bold bg-primary text-primary-foreground hover:bg-primary/90 shadow-md transition-transform hover:scale-105">
                                Go to Admin Panel
                            </Button>
                        </Link>
                    </div>
                ) : (
                    <div className={cn("rounded-xl p-3 sm:p-4 flex items-center justify-between gap-2", currentRole.greetingRow)}>
                        <div className="flex items-center gap-3 min-w-0">
                            <ShoppingCart className={cn("w-5 h-5 sm:w-6 sm:h-6 shrink-0", currentRole.greetingText)} />
                            <p className={cn("text-xs sm:text-sm font-semibold", currentRole.greetingText)}>Total Orders</p>
                        </div>
                        <p className={cn("text-sm sm:text-lg font-black shrink-0", onDarkCard ? "text-white" : "text-foreground")}>
                            {stats?.totalOrders || 0}
                        </p>
                    </div>
                )}

                {dbUser.role === 'dealer' && (
                    <div className={cn("rounded-xl p-3 sm:p-4 flex items-center justify-between", currentRole.greetingRow)}>
                        <div className="flex items-center gap-3">
                            <Settings className={cn("w-5 h-5 sm:w-6 sm:h-6", currentRole.greetingText)} />
                            <p className={cn("text-xs sm:text-sm font-semibold", currentRole.greetingText)}>Auto-Upgrade</p>
                        </div>
                        <div className="flex items-center gap-2">
                            <span className={cn(
                                "text-xs font-black px-2 py-0.5 rounded-md uppercase tracking-wider",
                                autoUpgrade ? "bg-emerald-500 text-white" : "bg-white/10 text-white"
                            )}>
                                {autoUpgrade ? "ON" : "OFF"}
                            </span>
                            <Button 
                                size="sm" 
                                onClick={() => {
                                    setAutoUpgrade(prev => !prev)
                                    toast.success(autoUpgrade ? "Auto-upgrade disabled" : "Auto-upgrade enabled")
                                }}
                                className="h-7 px-3 text-[10px] sm:text-xs bg-white hover:bg-white/95 text-purple-950 font-bold border-0 shadow-md"
                            >
                                {autoUpgrade ? "Disable" : "Enable"}
                            </Button>
                        </div>
                    </div>
                )}

                <div className={cn("rounded-xl p-3 sm:p-4 flex items-center justify-between gap-2", currentRole.greetingRow)}>
                    <div className="flex items-center gap-3 min-w-0">
                        {dbUser.role === 'customer' ? (
                            <Wallet className={cn("w-5 h-5 sm:w-6 sm:h-6 shrink-0", currentRole.greetingText)} />
                        ) : (
                            <Star className={cn("w-5 h-5 sm:w-6 sm:h-6 shrink-0", currentRole.greetingText)} />
                        )}
                        <p className={cn("text-xs sm:text-sm font-semibold", currentRole.greetingText)}>
                            {dbUser.role === 'customer' ? 'Wallet Balance' : 'Member Since'}
                        </p>
                    </div>
                    <p className={cn("text-xs sm:text-sm md:text-lg font-black shrink-0 text-right max-w-[50%] break-all", onDarkCard ? "text-white" : "text-foreground")}>
                        {dbUser.role === 'customer'
                            ? formatCurrency(stats?.walletBalance || 0)
                            : getTimeSinceJoined()
                        }
                    </p>
                </div>
            </div>
        </div>
    )
}

