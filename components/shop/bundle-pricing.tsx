'use client'

/**
 * A shop's Standard Bundles settings (My Shop > Pricing).
 *
 * One percentage covers every Standard Bundle: it is added on top of the owner's
 * own Standard Bundles price, and that difference is the shop's profit, paid into
 * the shop wallet once the bundle is delivered.
 */
import { useCallback, useEffect, useState } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Wifi, Loader2, Info } from 'lucide-react'
import { toast } from 'sonner'

interface Payload { available: boolean; enabled: boolean; percent: number; max_percent: number }

const SAMPLE = 10

/** standalone: on its own page (My Shop > Standard Bundles), so say why it is empty instead of hiding. */
export default function ShopBundlePricing({ standalone = false }: { standalone?: boolean }) {
    const [data, setData] = useState<Payload | null>(null)
    const [percent, setPercent] = useState('')
    const [enabled, setEnabled] = useState(false)
    const [saving, setSaving] = useState(false)

    const load = useCallback(async () => {
        try {
            const res = await fetch('/api/shop/bundle-pricing', { cache: 'no-store' })
            const json = await res.json()
            if (!res.ok) return
            setData(json)
            setPercent(String(json.percent ?? 0))
            setEnabled(json.enabled === true)
        } catch { /* hidden on error */ }
    }, [])

    useEffect(() => { load() }, [load])

    // Admin has not opened Standard Bundles to shops: say nothing on the Pricing
    // page; on its own page, explain.
    if (!data || (!data.available && !data.enabled)) {
        if (!standalone || !data) return null
        return (
            <Card>
                <CardContent className="p-6 text-sm text-muted-foreground">
                    Standard Bundles are not open for shops yet. Once they are, you can switch them on here and set your own percentage.
                </CardContent>
            </Card>
        )
    }

    const p = Number(percent)
    const valid = Number.isFinite(p) && p >= 0 && p <= data.max_percent
    const example = valid ? Math.ceil(SAMPLE * p) / 100 : 0

    async function save() {
        if (!valid) return toast.error(`Use a percentage between 0 and ${data!.max_percent}.`)
        setSaving(true)
        try {
            const res = await fetch('/api/shop/bundle-pricing', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled, percent: p }),
            })
            const json = await res.json()
            if (!res.ok) throw new Error(json?.error || 'Save failed')
            toast.success('Standard Bundles settings saved')
            load()
        } catch (e: any) {
            toast.error(e.message)
        } finally {
            setSaving(false)
        }
    }

    return (
        <Card>
            <CardHeader>
                <CardTitle className="flex items-center gap-2"><Wifi className="w-5 h-5 text-sky-500" /> Standard Bundles</CardTitle>
                <CardDescription>
                    Sell Standard Bundles (MTN Special Bundles, Telecel and AirtelTigo bundles) on your storefront. Your percentage is added on top of your own price.
                </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
                {!data.available && (
                    <p className="text-sm text-amber-700">Standard Bundles are paused for shops right now. Your storefront will not show them until they reopen.</p>
                )}
                <div className="flex items-center justify-between gap-4">
                    <div>
                        <p className="font-medium text-sm">Show on my storefront</p>
                        <p className="text-xs text-muted-foreground">Adds a Standard Bundles tile for your customers.</p>
                    </div>
                    <Switch checked={enabled} onCheckedChange={setEnabled} />
                </div>
                <div className="flex items-center justify-between gap-4">
                    <label htmlFor="bundle-pct" className="font-medium text-sm">Your profit</label>
                    <div className="flex items-center gap-1">
                        <Input
                            id="bundle-pct" type="number" min={0} max={data.max_percent} step="0.5" className="w-24 text-right"
                            value={percent} onChange={e => setPercent(e.target.value)}
                        />
                        <span className="text-sm text-muted-foreground">%</span>
                    </div>
                </div>
                <p className="flex items-start gap-2 text-xs text-muted-foreground">
                    <Info className="w-4 h-4 shrink-0 mt-0.5" />
                    Up to {data.max_percent}%. On a GHS {SAMPLE} bundle you earn GHS {example.toFixed(2)}, paid to your shop wallet when the bundle is delivered.
                    If a bundle cannot be delivered, what the customer paid comes back to your wallet so you can refund them.
                </p>
                <div className="flex justify-end">
                    <Button onClick={save} disabled={saving || !valid}>
                        {saving && <Loader2 className="w-4 h-4 animate-spin mr-2" />} Save
                    </Button>
                </div>
            </CardContent>
        </Card>
    )
}
