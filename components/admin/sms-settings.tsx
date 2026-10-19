'use client'

/**
 * Customer SMS + SMS Platform settings: master switch, free activation, pool
 * senders, platform limits, unlock prices and both bundle price lists.
 * Shown on /admin/sms-senders and /admin/sms-businesses; both save through
 * /api/admin/sms-config.
 */

import { useCallback, useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Skeleton } from '@/components/ui/skeleton'
import { Loader2, Plus, Trash2, Save, AlertTriangle } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'

interface Bundle {
    id?: string
    name: string
    credits: number | string
    price: number | string
    sort_order: number | string
    is_active: boolean
    /** shop = Customer SMS price list; platform = SMS Platform price list. */
    audience?: 'shop' | 'platform'
}

const BUNDLE_LISTS = [
    { audience: 'shop' as const, title: 'Customer SMS bundles', description: 'Sold to shops and sub-agents in Customer SMS. 1 credit = 1 SMS segment to 1 recipient.' },
    { audience: 'platform' as const, title: 'SMS Platform bundles', description: 'Sold on the SMS Platform (/dashboard/sms), at its own prices.' },
]

const PRICE_FIELDS = [
    { key: 'sms_unlock_price_customer', label: 'Customer' },
    { key: 'sms_unlock_price_agent', label: 'Agent' },
    { key: 'sms_unlock_price_dealer', label: 'Dealer' },
    { key: 'sms_unlock_price_sub', label: 'Sub-agent' },
]

export function SmsSettings() {
    const [settings, setSettings] = useState<Record<string, string>>({})
    const [bundles, setBundles] = useState<Bundle[]>([])
    const [deleteIds, setDeleteIds] = useState<string[]>([])
    const [loading, setLoading] = useState(true)
    const [saving, setSaving] = useState(false)
    const [gateway, setGateway] = useState<{ customer: string; platform: string; kingflexy: boolean } | null>(null)

    const load = useCallback(async () => {
        try {
            const res = await fetch('/api/admin/sms-config', { cache: 'no-store' })
            const data = await res.json()
            if (data?.success) {
                setSettings(data.settings)
                setBundles(data.bundles.filter((b: Bundle) => b.is_active))
                setDeleteIds([])
                setGateway({
                    customer: data.customerSmsGateway,
                    platform: data.platformGateway,
                    kingflexy: !!data.kingflexyConfigured,
                })
            } else {
                toast.error(data?.error || 'Failed to load settings')
            }
        } catch {
            toast.error('Failed to load settings')
        } finally {
            setLoading(false)
        }
    }, [])

    useEffect(() => { load() }, [load])

    const setField = (key: string, value: string) => setSettings((s) => ({ ...s, [key]: value }))
    const setBundle = (i: number, patch: Partial<Bundle>) => setBundles((bs) => bs.map((b, idx) => (idx === i ? { ...b, ...patch } : b)))

    const removeBundle = (i: number) => {
        const b = bundles[i]
        if (b.id) setDeleteIds((ids) => [...ids, b.id!])
        setBundles((bs) => bs.filter((_, idx) => idx !== i))
    }

    const save = async () => {
        setSaving(true)
        try {
            const res = await fetch('/api/admin/sms-config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ settings, bundles, deleteBundleIds: deleteIds }),
            })
            const data = await res.json()
            if (!res.ok || !data?.success) { toast.error(data?.error || 'Save failed'); return }
            toast.success('Customer SMS settings saved')
            load()
        } catch {
            toast.error('Save failed')
        } finally {
            setSaving(false)
        }
    }

    if (loading) return <Skeleton className="h-96 w-full" />

    return (
        <div className="space-y-4">
            {gateway && (
                <Card className={cn(gateway.customer !== 'kingflexy' && 'border-amber-400')}>
                    <CardContent className="py-3 space-y-1 text-sm">
                        <p>
                            Customer SMS sends through <span className="font-bold capitalize">{gateway.customer}</span>
                            <span className="text-muted-foreground"> (platform notifications: {gateway.platform})</span>
                        </p>
                        {gateway.customer !== 'kingflexy' && (
                            <p className="flex items-start gap-1.5 text-amber-700 dark:text-amber-400">
                                <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                                <span>
                                    Shops cannot send under their own sender ID on this gateway — it rejects any sender
                                    not registered on the ARHMS account (&quot;Sender ID is not approved&quot;). Set
                                    KINGFLEXY_SMS_KEY (kf_sms_live_) and redeploy; Customer SMS then uses KingFlexy
                                    automatically, whatever the gateway toggle says.
                                </span>
                            </p>
                        )}
                    </CardContent>
                </Card>
            )}

            <Card>
                <CardHeader>
                    <CardTitle className="text-base">Service</CardTitle>
                    <CardDescription>Switching off blocks unlocks, purchases, sender requests and sends for everyone. Existing credits are kept.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    <div className="flex items-center justify-between">
                        <Label>Customer SMS enabled</Label>
                        <Switch checked={settings.sms_customer_enabled !== 'false'}
                            onCheckedChange={(v) => setField('sms_customer_enabled', v ? 'true' : 'false')} />
                    </div>
                    <div className="flex items-center justify-between gap-4">
                        <div>
                            <Label>Free activation</Label>
                            <p className="text-[11px] text-muted-foreground">Waives the one-time unlock fee: locked accounts activate in one tap. Credits and sender IDs are still paid for and approved as usual.</p>
                        </div>
                        <Switch checked={settings.sms_free_activation === 'true'}
                            onCheckedChange={(v) => setField('sms_free_activation', v ? 'true' : 'false')} />
                    </div>
                    <div className="grid gap-4 sm:grid-cols-2">
                        <div className="space-y-2">
                            <Label>Pool sender IDs</Label>
                            <Input value={settings.sms_pool_senders || ''} onChange={(e) => setField('sms_pool_senders', e.target.value)} placeholder="ARHMSGh" />
                            <p className="text-[11px] text-muted-foreground">Comma-separated. Any unlocked shop may send under these while their own sender ID is pending. Leave empty to require an approved sender ID.</p>
                        </div>
                        <div className="space-y-2">
                            <Label>Send inline up to (recipients)</Label>
                            <Input type="number" min={1} value={settings.sms_inline_send_max || ''} onChange={(e) => setField('sms_inline_send_max', e.target.value)} placeholder="100" />
                            <p className="text-[11px] text-muted-foreground">Larger sends are queued for the process-sms-campaigns cron.</p>
                        </div>
                    </div>
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle className="text-base">SMS Platform limits</CardTitle>
                    <CardDescription>Platform Mode is every account&apos;s default; Business Mode follows an approved business registration.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
                        {[
                            { key: 'sms_daily_limit_platform', label: 'Daily limit · Platform', placeholder: '1000' },
                            { key: 'sms_daily_limit_business', label: 'Daily limit · Business', placeholder: '0' },
                            { key: 'sms_sender_cap_platform', label: 'Sender IDs · Platform', placeholder: '3' },
                            { key: 'sms_sender_cap_business', label: 'Sender IDs · Business', placeholder: '200' },
                        ].map((f) => (
                            <div key={f.key} className="space-y-1.5">
                                <Label className="text-xs">{f.label}</Label>
                                <Input type="number" min={0} value={settings[f.key] || ''} onChange={(e) => setField(f.key, e.target.value)} placeholder={f.placeholder} />
                            </div>
                        ))}
                    </div>
                    <p className="text-[11px] text-muted-foreground">Daily limits count recipients per day; 0 means no limit.</p>
                    <div className="space-y-1.5 max-w-sm">
                        <Label className="text-xs">Documents WhatsApp number</Label>
                        <Input value={settings.sms_business_docs_whatsapp || ''} onChange={(e) => setField('sms_business_docs_whatsapp', e.target.value)} placeholder="233244123456" />
                        <p className="text-[11px] text-muted-foreground">Where business owners send their Ghana Card and registration certificate. Leave empty to hide the box.</p>
                    </div>
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle className="text-base">Unlock price (GHS, one time)</CardTitle>
                </CardHeader>
                <CardContent className="grid gap-3 grid-cols-2 sm:grid-cols-4">
                    {PRICE_FIELDS.map((f) => (
                        <div key={f.key} className="space-y-1.5">
                            <Label className="text-xs">{f.label}</Label>
                            <Input type="number" min={0} step="0.01" value={settings[f.key] || ''} onChange={(e) => setField(f.key, e.target.value)} placeholder="10" />
                        </div>
                    ))}
                </CardContent>
            </Card>

            {BUNDLE_LISTS.map((list) => {
                const rows = bundles.map((b, i) => ({ b, i })).filter(({ b }) => (b.audience ?? 'shop') === list.audience)
                return (
                    <Card key={list.audience}>
                        <CardHeader>
                            <div className="flex items-center justify-between gap-2">
                                <div>
                                    <CardTitle className="text-base">{list.title}</CardTitle>
                                    <CardDescription>{list.description}</CardDescription>
                                </div>
                                <Button size="sm" variant="outline" className="gap-1"
                                    onClick={() => setBundles((bs) => [...bs, { name: '', credits: '', price: '', sort_order: rows.length + 1, is_active: true, audience: list.audience }])}>
                                    <Plus className="w-4 h-4" /> Add
                                </Button>
                            </div>
                        </CardHeader>
                        <CardContent className="space-y-2">
                            <div className="hidden sm:grid grid-cols-[1fr_110px_110px_90px_110px_40px] gap-2 text-xs text-muted-foreground px-1">
                                <span>Name</span><span>Credits</span><span>Price (GHS)</span><span>Order</span><span>GHS / SMS</span><span />
                            </div>
                            {rows.map(({ b, i }) => {
                                const perSms = Number(b.credits) > 0 ? Number(b.price) / Number(b.credits) : 0
                                return (
                                    <div key={b.id ?? `new-${i}`} className="grid grid-cols-2 sm:grid-cols-[1fr_110px_110px_90px_110px_40px] gap-2 items-center rounded-xl border p-2 sm:border-0 sm:p-0">
                                        <Input value={b.name} onChange={(e) => setBundle(i, { name: e.target.value })} placeholder="Starter" className="col-span-2 sm:col-span-1" />
                                        <Input type="number" min={1} value={b.credits} onChange={(e) => setBundle(i, { credits: e.target.value })} placeholder="100" />
                                        <Input type="number" min={0} step="0.01" value={b.price} onChange={(e) => setBundle(i, { price: e.target.value })} placeholder="5.00" />
                                        <Input type="number" value={b.sort_order} onChange={(e) => setBundle(i, { sort_order: e.target.value })} />
                                        <span className="text-sm text-muted-foreground">{perSms ? perSms.toFixed(3) : '—'}</span>
                                        <Button size="icon" variant="ghost" onClick={() => removeBundle(i)} aria-label="Remove bundle"><Trash2 className="w-4 h-4" /></Button>
                                    </div>
                                )
                            })}
                            {!rows.length && <p className="text-sm text-muted-foreground text-center py-4">No bundles on sale{list.audience === 'platform' ? ' — the SMS Platform shows "no bundles" until you add some.' : '.'}</p>}
                            <p className="text-[11px] text-muted-foreground">Removed bundles are hidden, not deleted, so past purchases keep their history.</p>
                        </CardContent>
                    </Card>
                )
            })}

            <Button onClick={save} disabled={saving} className="gap-2 bg-emerald-600 hover:bg-emerald-700">
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save settings
            </Button>
        </div>
    )
}
