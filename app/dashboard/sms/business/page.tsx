'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
    Building2, Hourglass, BadgeCheck, Send, Check, Globe, MessageCircle, FileText, Loader2, ShieldCheck, Sparkles, XCircle, Info, Radio,
} from 'lucide-react'
import { toast } from 'sonner'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { SmsSenderIds } from '@/components/sms/sms-sender-ids'
import { SmsActiveGate, SmsPageHeader, useSmsPlatform, type SmsPlatformAccount } from '@/components/sms/platform/sms-platform-shell'
import {
    businessSubmitErrors,
    normaliseGhanaCard,
    BUSINESS_NAME_MAX,
    BUSINESS_DESCRIPTION_MIN,
    BUSINESS_DESCRIPTION_MAX,
} from '@/lib/sms/sms-rules'

interface Business {
    id: string
    business_name: string
    description: string
    domain: string | null
    whatsapp: string | null
    status: 'draft' | 'pending' | 'approved' | 'rejected'
    rejection_reason: string | null
    submitted_at: string | null
    ghana_card_masked: string | null
    has_ghana_card: boolean
}

export default function SmsBusinessPage() {
    return (
        <>
            <SmsPageHeader
                title="Business & Sender ID"
                description="Register your business to unlock Business Mode and send with your own brand name."
                icon={Building2}
            />
            <SmsActiveGate allowLocked>
                {(info) => <BusinessAndSenders info={info} />}
            </SmsActiveGate>
        </>
    )
}

function BusinessAndSenders({ info }: { info: SmsPlatformAccount }) {
    const { reload } = useSmsPlatform()
    const [business, setBusiness] = useState<Business | null>(null)
    const [docsWhatsApp, setDocsWhatsApp] = useState<string | null>(null)
    const [loading, setLoading] = useState(true)

    const load = useCallback(async () => {
        try {
            const res = await fetch('/api/sms/business', { cache: 'no-store' })
            const data = await res.json()
            if (data?.success) {
                setBusiness(data.business)
                setDocsWhatsApp(data.documentsWhatsApp)
            } else {
                toast.error(data?.error || 'Could not load your business registration')
            }
        } catch {
            toast.error('Could not load your business registration')
        } finally {
            setLoading(false)
        }
    }, [])

    useEffect(() => { load() }, [load])

    const status = business?.status ?? null
    const hasSender = info.allowedSenders.some((s) => s.type === 'own')

    const steps = [
        { label: 'Register', sub: 'Business details', icon: Building2, done: status === 'pending' || status === 'approved' },
        { label: 'In review', sub: 'Admin verifies', icon: Hourglass, done: status === 'approved', active: status === 'pending' },
        { label: 'Approved', sub: 'Business Mode', icon: BadgeCheck, done: status === 'approved' },
        { label: 'Sender ID', sub: 'Your brand name', icon: Send, done: status === 'approved' && hasSender },
    ]

    if (loading) return <Skeleton className="h-96 w-full rounded-3xl" />

    return (
        <div className="space-y-5">
            <Card>
                <CardContent className="p-4">
                    <div className="grid grid-cols-4">
                        {steps.map((s, i) => (
                            <div key={s.label} className="relative flex flex-col items-center text-center">
                                {i > 0 && (
                                    <div className={cn('absolute right-1/2 top-5 h-0.5 w-full -z-0', steps[i - 1].done ? 'bg-emerald-500' : 'bg-muted')} />
                                )}
                                <div className={cn(
                                    'relative z-10 flex h-10 w-10 items-center justify-center rounded-full border-2',
                                    s.done ? 'border-emerald-500 bg-emerald-500 text-white'
                                        : s.active ? 'border-amber-400 bg-amber-50 text-amber-600 dark:bg-amber-950'
                                            : i === 0 && !status ? 'border-emerald-500 bg-emerald-50 text-emerald-600 dark:bg-emerald-950'
                                                : 'border-muted bg-background text-muted-foreground'
                                )}>
                                    {s.done ? <Check className="w-5 h-5" /> : <s.icon className="w-4 h-4" />}
                                </div>
                                <p className="mt-1.5 text-[11px] font-bold leading-tight">{s.label}</p>
                                <p className="text-[10px] text-muted-foreground leading-tight">{s.sub}</p>
                            </div>
                        ))}
                    </div>
                </CardContent>
            </Card>

            {status === 'approved' && business ? (
                <ApprovedBusiness business={business} />
            ) : status === 'pending' && business ? (
                <PendingBusiness business={business} docsWhatsApp={docsWhatsApp} />
            ) : (
                <BusinessForm
                    business={business}
                    docsWhatsApp={docsWhatsApp}
                    onSaved={(b) => { setBusiness(b); reload() }}
                />
            )}

            <SenderIdSection info={info} />
        </div>
    )
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
            <div className="text-sm font-semibold break-words">{children || '—'}</div>
        </div>
    )
}

function BusinessDetails({ business }: { business: Business }) {
    return (
        <div className="grid gap-4 sm:grid-cols-2">
            <Detail label="Business name">{business.business_name}</Detail>
            <Detail label="Domain">
                {business.domain && <span className="inline-flex items-center gap-1"><Globe className="w-3.5 h-3.5 text-muted-foreground" /> https://{business.domain}</span>}
            </Detail>
            <div className="sm:col-span-2"><Detail label="Description"><span className="font-normal">{business.description}</span></Detail></div>
            <Detail label="Ghana Card"><span className="font-mono">{business.ghana_card_masked}</span></Detail>
            <Detail label="Your WhatsApp"><span className="font-mono">{business.whatsapp}</span></Detail>
        </div>
    )
}

function ApprovedBusiness({ business }: { business: Business }) {
    return (
        <>
            <div className="rounded-3xl bg-gradient-to-br from-emerald-600 to-teal-800 p-5 text-white">
                <div className="flex items-start gap-3">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-white/15"><Sparkles className="w-5 h-5" /></div>
                    <div>
                        <p className="text-lg font-black flex items-center gap-1.5">Business Mode active <ShieldCheck className="w-4 h-4" /></p>
                        <p className="text-sm text-emerald-50/90">
                            <span className="font-bold">{business.business_name}</span> is verified. You now enjoy higher sending limits,
                            links in your messages and more sender IDs — fraud is still blocked.
                        </p>
                    </div>
                </div>
            </div>
            <Card>
                <CardHeader className="pb-3">
                    <div className="flex items-center justify-between gap-2">
                        <CardTitle className="text-base flex items-center gap-2"><Building2 className="w-4 h-4 text-emerald-600" /> Registered business</CardTitle>
                        <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">APPROVED</span>
                    </div>
                </CardHeader>
                <CardContent className="space-y-4">
                    <BusinessDetails business={business} />
                    <p className="rounded-xl border bg-muted/40 p-2.5 text-xs text-muted-foreground flex items-center gap-1.5">
                        <MessageCircle className="w-3.5 h-3.5" /> Documents are verified over WhatsApp. To change these details, contact support.
                    </p>
                </CardContent>
            </Card>
        </>
    )
}

function DocsBox({ docsWhatsApp }: { docsWhatsApp: string | null }) {
    if (!docsWhatsApp) return null
    return (
        <div className="rounded-2xl border border-dashed border-emerald-300 bg-emerald-50/60 p-3 dark:border-emerald-800 dark:bg-emerald-950/20">
            <p className="text-sm font-bold flex items-center gap-1.5"><MessageCircle className="w-4 h-4 text-emerald-600" /> Send your documents on WhatsApp</p>
            <p className="text-xs text-muted-foreground mt-1">Send a photo of your Ghana Card and your business registration certificate to us on WhatsApp:</p>
            <a href={`https://wa.me/${docsWhatsApp}`} target="_blank" rel="noopener noreferrer"
                className="mt-1.5 inline-flex items-center gap-1 text-sm font-bold text-emerald-700 hover:underline dark:text-emerald-400">
                <MessageCircle className="w-3.5 h-3.5" /> wa.me/{docsWhatsApp}
            </a>
        </div>
    )
}

function PendingBusiness({ business, docsWhatsApp }: { business: Business; docsWhatsApp: string | null }) {
    return (
        <Card className="border-amber-200 dark:border-amber-900">
            <CardHeader className="pb-3">
                <div className="flex items-center justify-between gap-2">
                    <CardTitle className="text-base flex items-center gap-2"><Hourglass className="w-4 h-4 text-amber-600" /> In review</CardTitle>
                    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-700 dark:bg-amber-950 dark:text-amber-300">PENDING</span>
                </div>
                <CardDescription>
                    Submitted {business.submitted_at ? new Date(business.submitted_at).toLocaleDateString() : ''}. We will notify you as soon as it is reviewed.
                </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
                <BusinessDetails business={business} />
                <DocsBox docsWhatsApp={docsWhatsApp} />
            </CardContent>
        </Card>
    )
}

function BusinessForm({ business, docsWhatsApp, onSaved }: {
    business: Business | null
    docsWhatsApp: string | null
    onSaved: (b: Business) => void
}) {
    const [name, setName] = useState(business?.business_name ?? '')
    const [description, setDescription] = useState(business?.description ?? '')
    const [domain, setDomain] = useState(business?.domain ?? '')
    const [card, setCard] = useState('')
    const [whatsapp, setWhatsapp] = useState(business?.whatsapp ?? '')
    const [saving, setSaving] = useState<'draft' | 'submit' | null>(null)

    const storedCard = business?.has_ghana_card ? business.ghana_card_masked : null
    const cardValid = card ? !!normaliseGhanaCard(card) : !!storedCard

    const submitErrors = useMemo(() => businessSubmitErrors({
        businessName: name,
        description,
        domain,
        // A card already on file counts; a valid placeholder stands in for it.
        ghanaCard: card || (storedCard ? 'GHA-000000000-0' : ''),
        whatsapp,
    }), [name, description, domain, card, storedCard, whatsapp])

    const save = async (submit: boolean) => {
        setSaving(submit ? 'submit' : 'draft')
        try {
            const res = await fetch('/api/sms/business', {
                method: submit ? 'POST' : 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ businessName: name, description, domain, ghanaCard: card, whatsapp }),
            })
            const data = await res.json()
            if (!res.ok || !data?.success) {
                toast.error(data?.error || 'Could not save')
                return
            }
            toast.success(data.message)
            setCard('')
            onSaved(data.business)
        } catch {
            toast.error('Could not save — check your connection')
        } finally {
            setSaving(null)
        }
    }

    return (
        <Card>
            <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2"><Building2 className="w-4 h-4 text-emerald-600" /> Register your business</CardTitle>
                <CardDescription>Once approved, Business Mode unlocks higher limits, links in messages and more sender IDs.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
                {business?.status === 'rejected' && (
                    <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
                        <XCircle className="w-4 h-4 mt-0.5 shrink-0" />
                        <div><p className="font-bold">Not approved</p><p className="text-xs">{business.rejection_reason || 'Please review your details and submit again.'}</p></div>
                    </div>
                )}

                <div className="space-y-1.5">
                    <Label htmlFor="biz-name">Business name</Label>
                    <Input id="biz-name" value={name} maxLength={BUSINESS_NAME_MAX} onChange={(e) => setName(e.target.value)} placeholder="e.g. Flexy Data Hub" />
                    <p className="text-[11px] text-muted-foreground">{name.length}/{BUSINESS_NAME_MAX} · min 2 characters</p>
                </div>

                <div className="space-y-1.5">
                    <Label htmlFor="biz-desc">What does your business do?</Label>
                    <Textarea id="biz-desc" rows={4} value={description} maxLength={BUSINESS_DESCRIPTION_MAX} onChange={(e) => setDescription(e.target.value)}
                        placeholder="Describe your business, your customers and the kind of SMS you plan to send…" />
                    <p className="text-[11px] text-muted-foreground">{description.length}/{BUSINESS_DESCRIPTION_MAX} · min {BUSINESS_DESCRIPTION_MIN} characters</p>
                </div>

                <div className="space-y-1.5">
                    <Label htmlFor="biz-domain">Business website / domain</Label>
                    <div className="flex rounded-md border focus-within:ring-2 focus-within:ring-ring">
                        <span className="flex items-center gap-1 border-r bg-muted/50 px-2.5 text-xs font-mono text-muted-foreground"><Globe className="w-3.5 h-3.5" /> https://</span>
                        <input id="biz-domain" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="yourbusiness.com"
                            className="h-10 w-full min-w-0 rounded-r-md bg-transparent px-3 text-sm font-mono outline-none" />
                    </div>
                    <p className="text-[11px] text-muted-foreground">Required to submit for review — where customers can verify your business.</p>
                </div>

                <div className="space-y-1.5">
                    <Label htmlFor="biz-card">Ghana Card number <span className="text-red-500">*</span></Label>
                    <Input id="biz-card" value={card} onChange={(e) => setCard(e.target.value.toUpperCase())} className="font-mono"
                        placeholder={storedCard ? `On file: ${storedCard} — type to replace` : 'GHA-XXXXXXXXX-X'} />
                    <p className={cn('text-[11px] flex items-center gap-1', card && !cardValid ? 'text-red-600' : 'text-muted-foreground')}>
                        <ShieldCheck className="w-3 h-3" />
                        {card && !cardValid ? 'Format: GHA-123456789-0' : 'For your privacy only the last 4 digits are stored.'}
                    </p>
                </div>

                <div className="space-y-1.5">
                    <Label htmlFor="biz-wa">Your WhatsApp number <span className="text-red-500">*</span></Label>
                    <Input id="biz-wa" value={whatsapp} inputMode="tel" onChange={(e) => setWhatsapp(e.target.value)} className="font-mono" placeholder="e.g. 233244123456" />
                    <p className="text-[11px] text-muted-foreground">We may reach out here if we need anything else during review.</p>
                </div>

                <DocsBox docsWhatsApp={docsWhatsApp} />

                <div className="grid grid-cols-2 gap-2">
                    <Button variant="outline" className="gap-2" disabled={!!saving || name.trim().length < 2} onClick={() => save(false)}>
                        {saving === 'draft' ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileText className="w-4 h-4" />} Save draft
                    </Button>
                    <Button className="gap-2 bg-emerald-600 hover:bg-emerald-700" disabled={!!saving || submitErrors.length > 0} onClick={() => save(true)}>
                        {saving === 'submit' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />} Submit for review
                    </Button>
                </div>
                {submitErrors.length > 0 && (
                    <p className="text-[11px] text-muted-foreground flex items-start gap-1">
                        <Info className="w-3 h-3 mt-0.5 shrink-0" />
                        To submit: a business name, a description of at least {BUSINESS_DESCRIPTION_MIN} characters, your website domain, a valid Ghana Card number and your WhatsApp number.
                    </p>
                )}
            </CardContent>
        </Card>
    )
}

function SenderIdSection({ info }: { info: SmsPlatformAccount }) {
    const { reload } = useSmsPlatform()
    const live = info.senderIds.filter((s) => s.status !== 'rejected').length

    return (
        <Card>
            <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2"><Radio className="w-4 h-4 text-emerald-600" /> Your Sender IDs</CardTitle>
                <CardDescription>
                    Register your own brand name to send under. Each one is reviewed by our team, then registered with the networks.
                    {' '}{info.mode === 'business'
                        ? `Business Mode accounts can hold up to ${info.senderCap}.`
                        : `Platform Mode accounts can hold ${info.senderCap} without documents — register your business for more.`}
                    {' '}Once approved, pick it from the sender list in Compose.
                </CardDescription>
            </CardHeader>
            <CardContent>
                {info.account.status !== 'active' ? (
                    <p className="text-sm text-muted-foreground">Activate SMS on the main SMS page to request a sender ID.</p>
                ) : (
                    <>
                        <p className="mb-3 text-xs text-muted-foreground">{live} of {info.senderCap} used</p>
                        <SmsSenderIds senderIds={info.senderIds} shopName={info.shopName} onChanged={() => { reload() }} />
                    </>
                )}
            </CardContent>
        </Card>
    )
}
