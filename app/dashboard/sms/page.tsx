'use client'

import Link from 'next/link'
import {
    Send, History, Users, Coins, Building2, Code2, ChevronRight, MessageSquare, BadgeCheck, Gauge, Check,
} from 'lucide-react'
import { toast } from 'sonner'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { SmsPaymentForm } from '@/components/sms/sms-payment-form'
import { SmsActiveGate, SmsPageHeader, useSmsPlatform, type SmsPlatformAccount } from '@/components/sms/platform/sms-platform-shell'

const BUSINESS_BADGE: Record<string, { label: string; className: string }> = {
    approved: { label: 'Approved', className: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300' },
    pending: { label: 'In review', className: 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300' },
    rejected: { label: 'Action needed', className: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300' },
    draft: { label: 'Draft', className: 'bg-muted text-muted-foreground' },
}

export default function SmsPlatformHome() {
    return (
        <>
            <SmsPageHeader
                title="SMS Platform"
                description="Send bulk SMS under your own sender name — to customers, members or anyone."
                icon={MessageSquare}
                backHref="/dashboard"
                backLabel="Dashboard"
            />
            <SmsActiveGate allowLocked>
                {(info) => info.account.status === 'locked' ? <Activate info={info} /> : <Hub info={info} />}
            </SmsActiveGate>
        </>
    )
}

function Activate({ info }: { info: SmsPlatformAccount }) {
    const { reload } = useSmsPlatform()
    const isActive = async () => (await reload())?.account.status === 'active'

    return (
        <div className="space-y-5">
            <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-emerald-700 to-teal-900 p-8 text-white">
                <MessageSquare className="w-10 h-10 text-emerald-200 mb-4" />
                <h2 className="text-2xl sm:text-3xl font-black">Bulk SMS for your business</h2>
                <p className="text-emerald-50/90 mt-2 max-w-lg">
                    Your own sender name, contact groups, delivery reports and an API for your website or app.
                </p>
                <div className="mt-6 flex items-baseline gap-2">
                    <span className="text-4xl font-black">GHS {Number(info.unlockPrice).toFixed(2)}</span>
                    <span className="text-emerald-100/80 text-sm">one-time activation</span>
                </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
                {[
                    { icon: BadgeCheck, title: 'Your own sender ID', body: 'Recipients see your brand name, not a random number.' },
                    { icon: Users, title: 'Contact groups', body: 'Save lists once and message them in one tap.' },
                    { icon: Coins, title: 'Pay per SMS', body: 'Buy credit bundles only when you need them.' },
                    { icon: Code2, title: 'SMS API', body: 'Send OTPs and alerts from your own website or app.' },
                ].map((f) => (
                    <Card key={f.title}><CardContent className="pt-6 space-y-1.5">
                        <f.icon className="w-5 h-5 text-emerald-600" />
                        <p className="font-bold text-sm">{f.title}</p>
                        <p className="text-xs text-muted-foreground">{f.body}</p>
                    </CardContent></Card>
                ))}
            </div>

            <Card>
                <CardHeader>
                    <CardTitle className="text-base">Activate SMS</CardTitle>
                    <CardDescription>After activating you&apos;ll request a sender ID, buy credits and start sending.</CardDescription>
                </CardHeader>
                <CardContent>
                    <SmsPaymentForm
                        endpoint="/api/sms/unlock"
                        extraBody={{ portal: 'platform' }}
                        amount={info.unlockPrice}
                        payLabel="Activate"
                        isSettled={isActive}
                        onSettled={() => { toast.success('SMS activated! Request your sender ID next.') }}
                    />
                </CardContent>
            </Card>
        </div>
    )
}

function Hub({ info }: { info: SmsPlatformAccount }) {
    const { account } = info
    const business = info.businessStatus ? BUSINESS_BADGE[info.businessStatus] : null
    const hasSender = info.allowedSenders.length > 0
    const limitText = info.dailyLimit > 0
        ? `${info.sentToday.toLocaleString()} / ${info.dailyLimit.toLocaleString()}`
        : info.sentToday.toLocaleString()

    const steps = [
        { label: 'Sender ID', done: hasSender, href: '/dashboard/sms/business' },
        { label: 'Credits', done: account.totalPurchased > 0, href: '/dashboard/sms/credits' },
        { label: 'Contacts', done: info.contactCount > 0, href: '/dashboard/sms/contacts' },
        { label: 'Send', done: account.totalUsed > 0, href: '/dashboard/sms/compose' },
    ]
    const setupComplete = steps.every((s) => s.done)

    const cards = [
        { href: '/dashboard/sms/records', icon: History, title: 'Records', body: 'Campaign history & delivery reports', badge: null },
        { href: '/dashboard/sms/contacts', icon: Users, title: 'Contacts', body: 'Manage your recipients and groups', badge: null },
        { href: '/dashboard/sms/credits', icon: Coins, title: 'Credits', body: 'Buy bundles & check your balance', badge: null },
        { href: '/dashboard/sms/business', icon: Building2, title: 'Business & Sender ID', body: 'Own sender name & business verification', badge: business },
        { href: '/dashboard/sms/api', icon: Code2, title: 'API & Docs', body: 'Generate your SMS API key & view docs', badge: null },
    ]

    return (
        <div className="space-y-5">
            <div className="grid grid-cols-3 gap-2">
                <Card><CardContent className="p-3">
                    <p className="text-[11px] text-muted-foreground">SMS credits</p>
                    <p className="text-xl font-black">{account.credits.toLocaleString()}</p>
                </CardContent></Card>
                <Card><CardContent className="p-3">
                    <p className="text-[11px] text-muted-foreground">Mode</p>
                    <p className={cn('text-sm font-black', info.mode === 'business' && 'text-emerald-600')}>
                        {info.mode === 'business' ? 'Business' : 'Platform'}
                    </p>
                </CardContent></Card>
                <Card><CardContent className="p-3">
                    <p className="text-[11px] text-muted-foreground flex items-center gap-1"><Gauge className="w-3 h-3" /> Sent today</p>
                    <p className="text-sm font-black">{limitText}</p>
                </CardContent></Card>
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

            <Link href="/dashboard/sms/compose" className="block">
                <Button className="w-full h-12 gap-2 rounded-2xl bg-emerald-600 hover:bg-emerald-700 text-base font-bold">
                    <Send className="w-4 h-4" /> Compose SMS
                </Button>
            </Link>

            <div className="grid gap-3 sm:grid-cols-2">
                {cards.map((c) => (
                    <Link key={c.href} href={c.href}>
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
        </div>
    )
}
