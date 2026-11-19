'use client'

/**
 * Owner card on /dashboard/shop: this month's storefront-assistant usage, an on/off
 * switch, and the GHS 7 reset (wallet or MoMo top-up) when the allowance is used up.
 * Renders nothing until the admin switches storefront assistants on.
 */
import { useCallback, useEffect, useState } from 'react'
import { MessageCircle } from 'lucide-react'
import { toast } from 'sonner'
import { Switch } from '@/components/ui/switch'
import { ResetPanel, usePendingReset } from '@/components/dashboard/ai-assistant/reset-panel'

interface Info {
    hasShop: boolean
    shopId: string
    adminOn: boolean
    enabled: boolean
    used: number
    allowance: number
    baseLimit: number
    price: number
}

export function ShopAiCard() {
    const [info, setInfo] = useState<Info | null>(null)
    const [saving, setSaving] = useState(false)

    const load = useCallback(async () => {
        try {
            const res = await fetch('/api/ai-assistant/shop-settings', { cache: 'no-store' })
            if (res.ok) setInfo(await res.json())
        } catch {
            /* card simply stays hidden */
        }
    }, [])

    useEffect(() => { load() }, [load])

    const exhausted = !!info && info.used >= info.allowance
    const onReset = useCallback(() => { load() }, [load])
    usePendingReset('shop', !!info?.adminOn && exhausted, onReset, info?.shopId)

    const toggle = async (enabled: boolean) => {
        setSaving(true)
        try {
            const res = await fetch('/api/ai-assistant/shop-settings', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled }),
            })
            if (!res.ok) throw new Error()
            setInfo(i => (i ? { ...i, enabled } : i))
            toast.success(enabled ? 'Shop assistant switched on' : 'Shop assistant switched off')
        } catch {
            toast.error('Could not save')
        } finally {
            setSaving(false)
        }
    }

    if (!info?.hasShop || !info.adminOn) return null
    const pct = Math.min(100, Math.round((info.used / Math.max(info.allowance, 1)) * 100))

    return (
        <div className="space-y-3 rounded-2xl border border-border p-4">
            <div className="flex items-start gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                    <MessageCircle className="h-5 w-5" />
                </div>
                <div className="min-w-0 flex-1">
                    <p className="font-bold">Shop AI assistant</p>
                    <p className="text-xs text-muted-foreground">
                        Answers your customers&apos; questions on your shop page: prices, how to buy, tracking orders. It never takes payments.
                    </p>
                </div>
                <Switch checked={info.enabled} disabled={saving} onCheckedChange={toggle} aria-label="Shop assistant on or off" />
            </div>

            {info.enabled && (
                <>
                    <div>
                        <div className="flex justify-between text-xs text-muted-foreground">
                            <span>Questions this month</span>
                            <span>{info.used.toLocaleString()} / {info.allowance.toLocaleString()}</span>
                        </div>
                        <div className="mt-1 h-2 overflow-hidden rounded-full bg-muted">
                            <div className={pct >= 100 ? 'h-full bg-destructive' : 'h-full bg-primary'} style={{ width: `${pct}%` }} />
                        </div>
                    </div>
                    {exhausted && (
                        <ResetPanel
                            scope="shop"
                            shopId={info.shopId}
                            usedLabel="Your shop assistant has used this month's questions, so customers see your WhatsApp instead."
                            onReset={onReset}
                        />
                    )}
                </>
            )}
        </div>
    )
}
