'use client'

/**
 * Shared frame for the SMS Platform pages under /dashboard/sms: the account
 * fetch, the back link and title, and the gate that keeps a locked or
 * suspended account on the hub.
 *
 * Every page reads the same /api/sms/account the shop panel does, so the
 * platform and the shop's Customer SMS are one account seen two ways.
 */

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { ArrowLeft, RefreshCw, PowerOff, ShieldAlert, Lock } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import type { SenderIdRow } from '@/components/sms/sms-sender-ids'
import type { AllowedSender } from '@/components/sms/sms-compose'
import type { SmsGroup } from '@/components/sms/sms-contacts'

export interface SmsPlatformAccount {
    enabled: boolean
    eligible: boolean
    reason: string | null
    hasShop: boolean
    shopName: string | null
    contactCount: number
    isSub: boolean
    unlockPrice: number
    mode: 'platform' | 'business'
    businessStatus: 'draft' | 'pending' | 'approved' | 'rejected' | null
    dailyLimit: number
    sentToday: number
    senderCap: number
    stats30d?: { campaigns: number; recipients: number; creditsUsed: number }
    account: {
        status: 'locked' | 'active' | 'suspended'
        credits: number
        totalPurchased: number
        totalUsed: number
        defaultSender: string | null
    }
    senderIds: SenderIdRow[]
    allowedSenders: AllowedSender[]
}

interface SmsPlatformState {
    info: SmsPlatformAccount | null
    loading: boolean
    reload: () => Promise<SmsPlatformAccount | null>
    groups: SmsGroup[]
    reloadGroups: () => Promise<void>
}

const SmsPlatformContext = createContext<SmsPlatformState | null>(null)

export function useSmsPlatform(): SmsPlatformState {
    const ctx = useContext(SmsPlatformContext)
    if (!ctx) throw new Error('useSmsPlatform must be used inside <SmsPlatformProvider>')
    return ctx
}

export function SmsPlatformProvider({ children }: { children: ReactNode }) {
    const [info, setInfo] = useState<SmsPlatformAccount | null>(null)
    const [loading, setLoading] = useState(true)
    const [groups, setGroups] = useState<SmsGroup[]>([])

    const reload = useCallback(async () => {
        try {
            const res = await fetch('/api/sms/account', { cache: 'no-store' })
            const data = await res.json()
            if (data?.success) {
                setInfo(data)
                return data as SmsPlatformAccount
            }
            toast.error(data?.error || 'Could not load your SMS account')
            return null
        } catch {
            toast.error('Could not load your SMS account')
            return null
        } finally {
            setLoading(false)
        }
    }, [])

    const reloadGroups = useCallback(async () => {
        try {
            const res = await fetch('/api/sms/groups', { cache: 'no-store' })
            const data = await res.json()
            if (data?.success) setGroups(data.groups)
        } catch { /* groups are optional to every page */ }
    }, [])

    useEffect(() => { reload() }, [reload])
    useEffect(() => { if (info?.account.status === 'active') reloadGroups() }, [info?.account.status, reloadGroups])

    return (
        <SmsPlatformContext.Provider value={{ info, loading, reload, groups, reloadGroups }}>
            {children}
        </SmsPlatformContext.Provider>
    )
}

export function SmsPageHeader({ title, description, icon: Icon, backHref = '/dashboard/sms', backLabel = 'SMS Platform', action, badge }: {
    title: string
    /** Small pill after the title, e.g. the account mode. */
    badge?: ReactNode
    description: string
    icon: any
    backHref?: string
    backLabel?: string
    action?: ReactNode
}) {
    const { reload, reloadGroups } = useSmsPlatform()
    return (
        <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
                <Link href={backHref} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
                    <ArrowLeft className="w-4 h-4" /> {backLabel}
                </Link>
                {action ?? (
                    <Button variant="outline" size="sm" className="gap-1" onClick={() => { reload(); reloadGroups() }}>
                        <RefreshCw className="w-3.5 h-3.5" /> Refresh
                    </Button>
                )}
            </div>
            <div>
                <h1 className="text-2xl font-black flex flex-wrap items-center gap-2"><Icon className="w-6 h-6 text-emerald-600" /> {title}{badge}</h1>
                <p className="text-sm text-muted-foreground">{description}</p>
            </div>
        </div>
    )
}

/**
 * Renders children only for an account that can use the feature. Anything
 * else — loading, switched off, locked, suspended — gets the real reason and
 * a way back to the hub, where unlocking happens.
 */
export function SmsActiveGate({ children, allowLocked = false }: { children: (info: SmsPlatformAccount) => ReactNode; allowLocked?: boolean }) {
    const { info, loading, reload } = useSmsPlatform()

    if (loading) return <Skeleton className="h-64 w-full rounded-3xl" />

    if (!info) {
        return (
            <Card><CardContent className="py-12 text-center space-y-3">
                <p className="font-bold">Your SMS account could not be loaded</p>
                <Button variant="outline" onClick={() => reload()} className="gap-2"><RefreshCw className="w-4 h-4" /> Try again</Button>
            </CardContent></Card>
        )
    }

    if (!info.enabled) {
        return (
            <Card><CardContent className="py-12 text-center space-y-3">
                <PowerOff className="w-10 h-10 mx-auto text-muted-foreground" />
                <p className="font-bold">SMS is currently unavailable</p>
                <p className="text-sm text-muted-foreground max-w-sm mx-auto">Please check back later. Your credits and contacts are safe.</p>
            </CardContent></Card>
        )
    }

    if (info.account.status === 'suspended' || !info.eligible) {
        return (
            <Card><CardContent className="py-12 text-center space-y-3">
                <ShieldAlert className="w-10 h-10 mx-auto text-red-500" />
                <p className="font-bold">You can&apos;t use SMS right now</p>
                <p className="text-sm text-muted-foreground max-w-sm mx-auto">{info.reason || 'Your SMS access is suspended. Please contact support.'}</p>
            </CardContent></Card>
        )
    }

    if (info.account.status === 'locked' && !allowLocked) {
        return (
            <Card><CardContent className="py-12 text-center space-y-3">
                <Lock className="w-10 h-10 mx-auto text-muted-foreground" />
                <p className="font-bold">Activate SMS first</p>
                <p className="text-sm text-muted-foreground max-w-sm mx-auto">Activate your SMS account to buy credits, request a sender ID and start sending.</p>
                <Link href="/dashboard/sms"><Button className="mt-2">Go to SMS Platform</Button></Link>
            </CardContent></Card>
        )
    }

    return <>{children(info)}</>
}
