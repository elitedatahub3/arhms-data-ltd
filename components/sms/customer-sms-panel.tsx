'use client'

/**
 * Customer SMS — shop owners and sub-agents messaging their own customers.
 *
 * One panel for both portals, the way the USSD activation panel already works:
 * every route resolves the caller from the session, so the only differences
 * between the two mounts are links and branding. A sub-agent's account is fully
 * their own — their own unlock, sender ID, credits and customer list.
 */

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
    ArrowLeft, MessageSquare, PowerOff, Store, ShieldAlert, Check, Coins, BadgeCheck, Users, Send, Clock, RefreshCw,
} from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { SmsPaymentForm } from '@/components/sms/sms-payment-form'
import { SmsSenderIds, type SenderIdRow } from '@/components/sms/sms-sender-ids'
import { SmsCredits } from '@/components/sms/sms-credits'
import { SmsContacts, type SmsGroup } from '@/components/sms/sms-contacts'
import { SmsCompose, type AllowedSender } from '@/components/sms/sms-compose'
import { SmsHistory } from '@/components/sms/sms-history'

interface AccountInfo {
    enabled: boolean
    eligible: boolean
    reason: string | null
    hasShop: boolean
    shopName: string | null
    contactCount: number
    isSub: boolean
    unlockPrice: number
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

const TABS = ['send', 'customers', 'senders', 'credits', 'history'] as const
type Tab = typeof TABS[number]

export interface CustomerSmsPanelProps {
    backHref: string
    backLabel?: string
    setupHref: string
    /** Sub portal: no platform naming. */
    deBranded?: boolean
}

export function CustomerSmsPanel({ backHref, backLabel = 'Back to Shop', setupHref, deBranded = false }: CustomerSmsPanelProps) {
    const [info, setInfo] = useState<AccountInfo | null>(null)
    const [groups, setGroups] = useState<SmsGroup[]>([])
    const [loading, setLoading] = useState(true)
    const [tab, setTab] = useState<Tab>('send')
    const [openCampaignId, setOpenCampaignId] = useState<string | null>(null)

    const loadAccount = useCallback(async () => {
        try {
            const res = await fetch('/api/sms/account', { cache: 'no-store' })
            const data = await res.json()
            if (data?.success) setInfo(data)
            else toast.error(data?.error || 'Could not load Customer SMS')
            return data
        } catch {
            toast.error('Could not load Customer SMS')
            return null
        } finally {
            setLoading(false)
        }
    }, [])

    const loadGroups = useCallback(async () => {
        try {
            const res = await fetch('/api/sms/groups', { cache: 'no-store' })
            const data = await res.json()
            if (data?.success) setGroups(data.groups)
        } catch { /* groups are optional to the page */ }
    }, [])

    useEffect(() => {
        loadAccount()
        // Read once from the URL rather than via useSearchParams, which would force
        // a Suspense boundary on both portal pages. Notification links use ?tab=.
        const requested = new URLSearchParams(window.location.search).get('tab') as Tab | null
        if (requested && TABS.includes(requested)) setTab(requested)
    }, [loadAccount])

    useEffect(() => {
        if (info?.account.status === 'active') loadGroups()
    }, [info?.account.status, loadGroups])

    const refreshAll = useCallback(() => { loadAccount(); loadGroups() }, [loadAccount, loadGroups])

    const isUnlocked = useCallback(async () => {
        const res = await fetch('/api/sms/account', { cache: 'no-store' })
        const data = await res.json()
        return data?.account?.status === 'active'
    }, [])

    const onUnlocked = useCallback(async () => {
        toast.success('Customer SMS unlocked! Now request your sender ID.')
        await loadAccount()
        setTab('senders')
    }, [loadAccount])

    const back = (
        <Link href={backHref}><Button variant="ghost" className="gap-2"><ArrowLeft className="w-4 h-4" /> {backLabel}</Button></Link>
    )

    if (loading) {
        return (
            <div className="space-y-6 pb-20 md:pb-6">
                <Skeleton className="h-10 w-40" />
                <Skeleton className="h-64 w-full rounded-3xl" />
            </div>
        )
    }

    if (!info) {
        return (
            <div className="space-y-6 pb-20 md:pb-6">
                {back}
                <Card><CardContent className="py-12 text-center space-y-3">
                    <p className="font-bold">Customer SMS could not be loaded</p>
                    <Button variant="outline" onClick={() => { setLoading(true); loadAccount() }} className="gap-2"><RefreshCw className="w-4 h-4" /> Try again</Button>
                </CardContent></Card>
            </div>
        )
    }

    if (!info.enabled) {
        return (
            <div className="space-y-6 pb-20 md:pb-6">
                {back}
                <Card><CardContent className="py-12 text-center space-y-3">
                    <PowerOff className="w-10 h-10 mx-auto text-muted-foreground" />
                    <p className="font-bold">Customer SMS is currently unavailable</p>
                    <p className="text-sm text-muted-foreground max-w-sm mx-auto">Please check back later. Your credits and customer list are safe.</p>
                </CardContent></Card>
            </div>
        )
    }

    if (!info.hasShop) {
        return (
            <div className="space-y-6 pb-20 md:pb-6">
                {back}
                <Card><CardContent className="py-12 text-center space-y-3">
                    <Store className="w-10 h-10 mx-auto text-muted-foreground" />
                    <p className="font-bold">You need a shop first</p>
                    <p className="text-sm text-muted-foreground">Set up your shop, then come back to message your customers.</p>
                    <Link href={setupHref}><Button className="mt-2">Set Up Shop</Button></Link>
                </CardContent></Card>
            </div>
        )
    }

    const { account } = info

    if (account.status === 'suspended') {
        return (
            <div className="space-y-6 pb-20 md:pb-6">
                {back}
                <Card><CardContent className="py-12 text-center space-y-3">
                    <ShieldAlert className="w-10 h-10 mx-auto text-red-500" />
                    <p className="font-bold">Your Customer SMS access is suspended</p>
                    <p className="text-sm text-muted-foreground max-w-sm mx-auto">Please contact support to find out why and how to restore it.</p>
                </CardContent></Card>
            </div>
        )
    }

    // ── LOCKED: the one-time unlock ──────────────────────────────────────────
    if (account.status === 'locked') {
        return (
            <div className="space-y-6 pb-20 md:pb-6">
                {back}
                <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-emerald-700 to-teal-900 p-8 text-white">
                    <MessageSquare className="w-10 h-10 text-emerald-200 mb-4" />
                    <h1 className="text-2xl sm:text-3xl font-black">Customer SMS</h1>
                    <p className="text-emerald-50/90 mt-2 max-w-lg">
                        Send SMS to your customers under your own business name — new stock, promos, order updates.
                    </p>
                    <div className="mt-6 flex items-baseline gap-2">
                        <span className="text-4xl font-black">GHS {Number(info.unlockPrice).toFixed(2)}</span>
                        <span className="text-emerald-100/80 text-sm">one time</span>
                    </div>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                    {[
                        { icon: BadgeCheck, title: 'Your own sender ID', body: 'Customers see your business name, not a random number.' },
                        { icon: Users, title: 'Your customer list', body: 'Import everyone who ordered from you, or add numbers yourself.' },
                        { icon: Coins, title: 'Pay per SMS', body: 'Buy credit bundles only when you need them.' },
                        { icon: Check, title: 'Delivery reports', body: 'See which customers received each message.' },
                    ].map((f) => (
                        <Card key={f.title}><CardContent className="pt-6 space-y-1.5">
                            <f.icon className="w-5 h-5 text-emerald-600" />
                            <p className="font-bold text-sm">{f.title}</p>
                            <p className="text-xs text-muted-foreground">{f.body}</p>
                        </CardContent></Card>
                    ))}
                </div>

                {!info.eligible ? (
                    <Card><CardContent className="py-8 text-center space-y-2">
                        <p className="font-bold">You can&apos;t unlock Customer SMS yet</p>
                        <p className="text-sm text-muted-foreground">{info.reason}</p>
                    </CardContent></Card>
                ) : (
                    <Card>
                        <CardHeader>
                            <CardTitle className="text-base">Unlock Customer SMS</CardTitle>
                            <CardDescription>
                                After unlocking you&apos;ll request your sender ID, buy SMS credits, and start sending.
                            </CardDescription>
                        </CardHeader>
                        <CardContent>
                            <SmsPaymentForm
                                endpoint="/api/sms/unlock"
                                amount={info.unlockPrice}
                                payLabel="Unlock"
                                isSettled={isUnlocked}
                                onSettled={onUnlocked}
                            />
                        </CardContent>
                    </Card>
                )}
            </div>
        )
    }

    // ── ACTIVE ───────────────────────────────────────────────────────────────
    const hasApproved = info.senderIds.some((s) => s.status === 'approved')
    const hasRequested = info.senderIds.some((s) => s.status !== 'rejected')
    const steps = [
        { label: 'Sender ID', done: hasApproved, waiting: hasRequested && !hasApproved, tab: 'senders' as Tab, icon: BadgeCheck },
        { label: 'Credits', done: account.totalPurchased > 0, waiting: false, tab: 'credits' as Tab, icon: Coins },
        { label: 'Customers', done: info.contactCount > 0, waiting: false, tab: 'customers' as Tab, icon: Users },
        { label: 'Send', done: account.totalUsed > 0, waiting: false, tab: 'send' as Tab, icon: Send },
    ]
    const setupComplete = steps.slice(0, 3).every((s) => s.done)
    const approvedSender = info.senderIds.find((s) => s.is_default && s.status === 'approved') ?? info.senderIds.find((s) => s.status === 'approved')
    const pendingSender = info.senderIds.find((s) => s.status === 'pending' || s.status === 'submitted')

    return (
        <div className="space-y-5 pb-20 md:pb-6">
            <div className="flex items-center justify-between">
                {back}
                <Button variant="outline" size="sm" onClick={refreshAll} className="gap-1"><RefreshCw className="w-3.5 h-3.5" /> Refresh</Button>
            </div>

            <div>
                <h1 className="text-2xl font-black flex items-center gap-2"><MessageSquare className="w-6 h-6 text-emerald-600" /> Customer SMS</h1>
                <p className="text-sm text-muted-foreground">Send SMS to your customers{deBranded ? '' : ' from your ARHMS shop'}.</p>
            </div>

            <div className="grid grid-cols-3 gap-2">
                <Card><CardContent className="p-3">
                    <p className="text-[11px] text-muted-foreground">SMS credits</p>
                    <p className="text-xl font-black">{account.credits.toLocaleString()}</p>
                </CardContent></Card>
                <Card><CardContent className="p-3">
                    <p className="text-[11px] text-muted-foreground">Customers</p>
                    <p className="text-xl font-black">{info.contactCount.toLocaleString()}</p>
                </CardContent></Card>
                <Card><CardContent className="p-3">
                    <p className="text-[11px] text-muted-foreground">Sender ID</p>
                    <p className="text-sm font-black font-mono truncate">
                        {approvedSender?.sender ?? (pendingSender ? <span className="inline-flex items-center gap-1 text-amber-600"><Clock className="w-3 h-3" /> Pending</span> : '—')}
                    </p>
                </CardContent></Card>
            </div>

            {!setupComplete && (
                <Card className="border-emerald-200 dark:border-emerald-900">
                    <CardContent className="p-3">
                        <p className="text-xs font-semibold mb-2">Get started</p>
                        <div className="grid grid-cols-4 gap-1.5">
                            {steps.map((s, i) => (
                                <button key={s.label} type="button" onClick={() => setTab(s.tab)}
                                    className={cn(
                                        'rounded-xl border p-2 text-center transition-colors',
                                        s.done ? 'border-emerald-400 bg-emerald-50 dark:bg-emerald-950/30'
                                            : s.waiting ? 'border-amber-300 bg-amber-50 dark:bg-amber-950/20'
                                                : 'border-gray-200 dark:border-gray-800'
                                    )}>
                                    <div className="mx-auto mb-1 flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-black bg-white dark:bg-black border">
                                        {s.done ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : s.waiting ? <Clock className="w-3.5 h-3.5 text-amber-600" /> : i + 1}
                                    </div>
                                    <p className="text-[11px] font-semibold leading-tight">{s.label}</p>
                                    {s.waiting && <p className="text-[10px] text-amber-700 dark:text-amber-400">awaiting approval</p>}
                                </button>
                            ))}
                        </div>
                    </CardContent>
                </Card>
            )}

            <Tabs value={tab} onValueChange={(v) => { setTab(v as Tab); if (v !== 'history') setOpenCampaignId(null) }}>
                <div className="overflow-x-auto -mx-1 px-1">
                    <TabsList className="w-max">
                        <TabsTrigger value="send">Send</TabsTrigger>
                        <TabsTrigger value="customers">Customers</TabsTrigger>
                        <TabsTrigger value="senders">Sender ID</TabsTrigger>
                        <TabsTrigger value="credits">Credits</TabsTrigger>
                        <TabsTrigger value="history">History</TabsTrigger>
                    </TabsList>
                </div>

                <TabsContent value="send" className="mt-4">
                    <SmsCompose
                        credits={account.credits}
                        allowedSenders={info.allowedSenders}
                        groups={groups}
                        contactCount={info.contactCount}
                        onSent={(campaignId) => { loadAccount(); setOpenCampaignId(campaignId); setTab('history') }}
                        onNeedCredits={() => setTab('credits')}
                        onNeedSender={() => setTab('senders')}
                    />
                </TabsContent>

                <TabsContent value="customers" className="mt-4">
                    <SmsContacts hasShop={info.hasShop} groups={groups} onGroupsChanged={refreshAll} />
                </TabsContent>

                <TabsContent value="senders" className="mt-4">
                    <SmsSenderIds senderIds={info.senderIds} shopName={info.shopName} onChanged={loadAccount} />
                </TabsContent>

                <TabsContent value="credits" className="mt-4">
                    <SmsCredits credits={account.credits} onPurchased={loadAccount} />
                </TabsContent>

                <TabsContent value="history" className="mt-4">
                    <SmsHistory openCampaignId={openCampaignId} onOpen={setOpenCampaignId} />
                </TabsContent>
            </Tabs>
        </div>
    )
}
