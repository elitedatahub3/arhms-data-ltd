'use client'

import { useState } from 'react'
import Link from 'next/link'
import {
    Send, History, Users, Coins, Building2, Code2, ChevronRight, MessageSquare, BadgeCheck, Gauge, Check, Lock, Wallet, Radio,
} from 'lucide-react'
import { toast } from 'sonner'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { SmsActiveGate, SmsPageHeader, useSmsPlatform, smsPlatformName, type SmsPlatformAccount } from '@/components/sms/platform/sms-platform-shell'

const BUSINESS_BADGE: Record<string, { label: string; className: string }> = {
    approved: { label: 'Approved', className: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300' },
    pending: { label: 'In review', className: 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300' },
    rejected: { label: 'Action needed', className: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300' },
    draft: { label: 'Draft', className: 'bg-muted text-muted-foreground' },
}

const API_LOCKED_BADGE = { label: 'Needs approved business', className: 'bg-muted text-muted-foreground' }

export default function SmsPlatformHome() {
    // Lives in the shop overview, so that is where "back" goes — the sub-agent
    // portal has its own copy of it.
    const { info } = useSmsPlatform()
    const shopHref = info?.isSub ? '/dashboard/sub/shop' : '/dashboard/shop'

    return (
        <>
            <SmsPageHeader
                title={smsPlatformName(info?.isSub)}
                description="Send bulk SMS to any Ghana number — pay per message."
                icon={MessageSquare}
                badge={info && (
                    <span className={cn('inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-bold',
                        info.mode === 'business'
                            ? 'bg-violet-600 text-white'
                            : 'bg-muted text-muted-foreground')}>
                        {info.mode === 'business' && <BadgeCheck className="w-3 h-3" />}
                        {info.mode === 'business' ? 'Business' : 'Platform'}
                    </span>
                )}
                backHref={shopHref}
                backLabel="Shop overview"
            />
            <SmsActiveGate>
                {(info) => <Hub info={info} />}
            </SmsActiveGate>
        </>
    )
}

function Hub({ info }: { info: SmsPlatformAccount }) {
    const { account } = info
    const business = info.businessStatus ? BUSINESS_BADGE[info.businessStatus] : null
    // The API is for approved businesses only; the server refuses keys otherwise.
    const apiUnlocked = info.businessStatus === 'approved'
    const hasSender = info.allowedSenders.length > 0
    // What a send goes out as when the sender list is left alone — the same
    // default the send path picks.
    const defaultSender = info.allowedSenders.find((x) => x.isDefault)
        ?? info.allowedSenders.find((x) => x.type === 'own')
        ?? info.allowedSenders[0]
    const stats = info.stats30d ?? { campaigns: 0, recipients: 0, creditsUsed: 0 }

    const steps = [
        { label: 'Sender ID', done: hasSender, href: '/dashboard/sms/business' },
        { label: 'Credits', done: account.totalPurchased > 0, href: '/dashboard/sms/credits' },
        { label: 'Contacts', done: info.contactCount > 0, href: '/dashboard/sms/contacts' },
        { label: 'Send', done: account.totalUsed > 0, href: '/dashboard/sms/compose' },
    ]
    const setupComplete = steps.every((s) => s.done)

    const cards = [
        { href: '/dashboard/sms/records', icon: History, title: 'Records', body: 'Campaign history & delivery reports', badge: null },
        { href: '/dashboard/sms/contacts', icon: Users, title: 'Contacts', body: 'Manage your recipient groups', badge: null },
        { href: '/dashboard/sms/credits', icon: Coins, title: 'Credits', body: 'Buy bundles & view credit history', badge: null },
        { href: '/dashboard/sms/business', icon: Building2, title: 'Business & Sender ID', body: 'Own sender name & business verification', badge: business },
        apiUnlocked
            ? { href: '/dashboard/sms/api', icon: Code2, title: 'API & Docs', body: 'Generate your SMS API key & view docs', badge: null }
            : { href: '/dashboard/sms/business', icon: Lock, title: 'API & Docs', body: 'Unlocks once your business is approved', badge: API_LOCKED_BADGE },
    ]

    return (
        <div className="space-y-4">
            <div className="rounded-3xl border border-emerald-200 bg-gradient-to-br from-emerald-50 to-teal-50/60 p-5 shadow-sm dark:border-emerald-900 dark:from-emerald-950/40 dark:to-teal-950/20">
                <div className="flex items-start justify-between gap-3">
                    <div>
                        <p className="text-[11px] font-bold uppercase tracking-wide text-emerald-700 dark:text-emerald-400 flex items-center gap-1.5">
                            <Wallet className="w-3.5 h-3.5" /> Credit balance
                        </p>
                        <p className="mt-1 flex items-baseline gap-2">
                            <span className="text-4xl font-black">{account.credits.toLocaleString()}</span>
                            <span className="text-sm text-muted-foreground">credits</span>
                        </p>
                    </div>
                    <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-emerald-100 dark:bg-emerald-900/60">
                        <Coins className="w-5 h-5 text-emerald-700 dark:text-emerald-300" />
                    </div>
                </div>

                <div className="mt-4 grid grid-cols-2 gap-2">
                    <Link href="/dashboard/sms/compose">
                        <Button className="w-full h-11 gap-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 font-bold">
                            <Send className="w-4 h-4" /> Send SMS
                        </Button>
                    </Link>
                    <Link href="/dashboard/sms/credits">
                        <Button variant="outline" className="w-full h-11 gap-2 rounded-xl border-emerald-300 bg-white text-emerald-700 hover:bg-emerald-50 font-bold dark:bg-transparent dark:text-emerald-300">
                            <Coins className="w-4 h-4" /> Buy Credits
                        </Button>
                    </Link>
                </div>

                <div className="mt-3 flex items-center gap-2 rounded-xl border border-emerald-200 bg-white/70 px-3 py-2 text-xs text-muted-foreground dark:border-emerald-900 dark:bg-black/20">
                    <Radio className="w-3.5 h-3.5 shrink-0 text-emerald-600" />
                    {defaultSender ? (
                        <span>
                            Sending as <span className="font-mono font-bold text-foreground">{defaultSender.sender}</span>
                            {' · '}{defaultSender.type === 'pool' ? 'platform default' : 'your sender ID'}
                        </span>
                    ) : (
                        <span>
                            No sender yet — <Link href="/dashboard/sms/business" className="font-semibold text-emerald-700 hover:underline dark:text-emerald-400">request a sender ID</Link>
                        </span>
                    )}
                </div>
            </div>

            <OrderConfirmationToggle info={info} />

            <div className="grid grid-cols-3 gap-2">
                {[
                    { label: 'Campaigns (30d)', value: stats.campaigns },
                    { label: 'Recipients (30d)', value: stats.recipients },
                    { label: 'Credits used (30d)', value: stats.creditsUsed },
                ].map((x) => (
                    <Card key={x.label}><CardContent className="p-3">
                        <p className="text-[11px] text-muted-foreground">{x.label}</p>
                        <p className="text-xl font-black">{x.value.toLocaleString()}</p>
                    </CardContent></Card>
                ))}
            </div>

            {!setupComplete && (
                <Card className="border-emerald-200 dark:border-emerald-900">
                    <CardContent className="p-3">
                        <p className="text-xs font-semibold mb-2">Get started</p>
                        <div className="grid grid-cols-4 gap-1.5">
                            {steps.map((s, i) => (
                                <Link key={s.label} href={s.href}
                                    className={cn('rounded-xl border p-2 text-center transition-colors',
                                        s.done ? 'border-emerald-400 bg-emerald-50 dark:bg-emerald-950/30' : 'border-gray-200 dark:border-gray-800')}>
                                    <div className="mx-auto mb-1 flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-black bg-white dark:bg-black border">
                                        {s.done ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : i + 1}
                                    </div>
                                    <p className="text-[11px] font-semibold leading-tight">{s.label}</p>
                                </Link>
                            ))}
                        </div>
                    </CardContent>
                </Card>
            )}

            <div className="grid gap-3 sm:grid-cols-2">
                {cards.map((c) => (
                    <Link key={c.title} href={c.href}>
                        <Card className="h-full transition-colors hover:border-emerald-300">
                            <CardContent className="p-4">
                                <div className="flex items-start justify-between">
                                    <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-100 dark:bg-emerald-950">
                                        <c.icon className="w-5 h-5 text-emerald-700 dark:text-emerald-300" />
                                    </div>
                                    <ChevronRight className="w-4 h-4 text-muted-foreground" />
                                </div>
                                <p className="mt-3 font-bold flex flex-wrap items-center gap-2">
                                    {c.title}
                                    {c.badge && <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-bold', c.badge.className)}>{c.badge.label}</span>}
                                </p>
                                <p className="text-xs text-muted-foreground">{c.body}</p>
                            </CardContent>
                        </Card>
                    </Link>
                ))}
            </div>

            <p className="flex flex-wrap items-center gap-1.5 px-1 text-[11px] text-muted-foreground">
                <Gauge className="w-3 h-3" /> Limits:
                <span className="font-semibold text-foreground">{(info.limits?.perSend ?? 10000).toLocaleString()}</span> recipients/send ·
                {info.dailyLimit > 0
                    ? <><span className="font-semibold text-foreground">{info.dailyLimit.toLocaleString()}</span> recipients/day · {info.sentToday.toLocaleString()} sent today</>
                    : <span className="font-semibold text-foreground">no daily limit</span>}
                {info.mode !== 'business' && info.dailyLimit > 0 && (
                    <span>· <Link href="/dashboard/sms/business" className="text-emerald-700 hover:underline dark:text-emerald-400">register your business</Link> for more</span>
                )}
            </p>

            <RecentActivity items={info.recentActivity ?? []} />
        </div>
    )
}

/**
 * SMS Platform order confirmations: the data and airtime this user buys on the
 * platform are confirmed to the recipient under their own sender ID. Separate
 * from the shop's storefront confirmations, which live in Customer SMS.
 */
function OrderConfirmationToggle({ info }: { info: SmsPlatformAccount }) {
    const { reload } = useSmsPlatform()
    const [saving, setSaving] = useState(false)
    const on = !!info.platformOrderSms?.enabled
    const hasOwnSender = info.allowedSenders.some((x) => x.type === 'own')

    const toggle = async (next: boolean) => {
        if (next && !hasOwnSender) {
            toast.error('Get a sender ID approved first')
            return
        }
        setSaving(true)
        try {
            const res = await fetch('/api/sms/account', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ platform: next }),
            })
            const data = await res.json()
            if (!res.ok || !data?.success) { toast.error(data?.error || 'Could not save'); return }
            toast.success(next ? 'Your purchases will be confirmed under your sender ID' : 'Confirmations go back to the default sender')
            reload()
        } finally {
            setSaving(false)
        }
    }

    return (
        <Card>
            <CardContent className="flex items-start gap-3 p-4">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-50 dark:bg-emerald-950/40">
                    <BadgeCheck className="w-5 h-5 text-emerald-600" />
                </div>
                <div className="min-w-0 flex-1">
                    <p className="text-sm font-bold">Use my sender ID for order confirmations</p>
                    <p className="text-xs text-muted-foreground">
                        {hasOwnSender
                            ? "When you buy data or airtime here, the recipient's confirmation SMS comes from your approved sender ID instead of the default sender, paid from these credits."
                            : 'Once your sender ID is approved, the confirmation SMS for data and airtime you buy here can come from it.'}
                    </p>
                    {on && info.platformOrderSms?.lastSkip && (
                        <p className="mt-1 text-[11px] text-amber-600">Last confirmation: {info.platformOrderSms.lastSkip}</p>
                    )}
                </div>
                <Switch checked={on} disabled={saving || (!on && !hasOwnSender)} onCheckedChange={toggle} aria-label="Use my sender ID for order confirmations" />
            </CardContent>
        </Card>
    )
}

function RecentActivity({ items }: { items: NonNullable<SmsPlatformAccount['recentActivity']> }) {
    return (
        <Card>
            <CardHeader className="pb-2">
                <div className="flex items-center justify-between gap-2">
                    <CardTitle className="text-base flex items-center gap-2"><History className="w-4 h-4 text-emerald-600" /> Recent Credit Activity</CardTitle>
                    <Link href="/dashboard/sms/records" className="text-xs font-semibold text-emerald-700 hover:underline dark:text-emerald-400">View all →</Link>
                </div>
            </CardHeader>
            <CardContent>
                {items.length === 0 ? (
                    <p className="py-6 text-center text-sm text-muted-foreground">No credit activity yet.</p>
                ) : (
                    <div className="divide-y">
                        {items.map((x, i) => (
                            <div key={`${x.at}-${i}`} className="flex items-center justify-between gap-3 py-2.5">
                                <div className="min-w-0">
                                    <p className="truncate text-sm font-semibold">{x.label}</p>
                                    <p className="text-[11px] text-muted-foreground">
                                        {new Date(x.at).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}
                                    </p>
                                </div>
                                <p className={cn('shrink-0 text-sm font-black', x.credits < 0 ? 'text-red-600' : 'text-emerald-600')}>
                                    {x.credits > 0 ? '+' : ''}{x.credits.toLocaleString()}
                                </p>
                            </div>
                        ))}
                    </div>
                )}
            </CardContent>
        </Card>
    )
}
