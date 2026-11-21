'use client'

/**
 * Admin -> ARHMS AI -> Shop assistants: every storefront-assistant setting in one place.
 *   - on/off for all shops (owners can still switch theirs off)
 *   - free answers per customer per day (after that, shop credits pay)
 *   - hourly cap per customer (anti-abuse; always applies)
 *   - free credits each shop gets every month (used before bought credits)
 *   - credit packs owners buy from their wallet (name, credits, price, on/off)
 */
import { useState } from 'react'
import { Loader2, Plus, Save, Store, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'

interface Pack {
    id: string
    name: string
    credits: number | string
    price: number | string
    enabled: boolean
}

export interface ShopAiSettingsValue {
    on: boolean
    perVisitorDaily: number
    perVisitorHourly: number
    freeMonthly: number
    packs: { id: string; name: string; credits: number; price: number; enabled: boolean }[]
}

const MAX_PACKS = 6
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24)

export function ShopAiSettings({ initial, canEdit, onSaved }: { initial: ShopAiSettingsValue; canEdit: boolean; onSaved: () => void }) {
    const [on, setOn] = useState(initial.on)
    const [perDay, setPerDay] = useState(String(initial.perVisitorDaily))
    const [perHour, setPerHour] = useState(String(initial.perVisitorHourly))
    const [freeMonthly, setFreeMonthly] = useState(String(initial.freeMonthly))
    const [packs, setPacks] = useState<Pack[]>(initial.packs)
    const [saving, setSaving] = useState(false)

    const updatePack = (i: number, patch: Partial<Pack>) => setPacks(ps => ps.map((p, j) => (j === i ? { ...p, ...patch } : p)))

    const save = async () => {
        const d = parseInt(perDay, 10)
        const h = parseInt(perHour, 10)
        const f = parseInt(freeMonthly, 10)
        if (!Number.isFinite(d) || d < 1 || d > 1000 || !Number.isFinite(h) || h < 1 || h > 1000) {
            toast.error('Free answers per day and the hourly cap must be between 1 and 1000')
            return
        }
        if (!Number.isFinite(f) || f < 0 || f > 100000) {
            toast.error('Free monthly credits must be between 0 and 100000')
            return
        }
        const cleaned = []
        for (const p of packs) {
            const name = p.name.trim()
            const credits = parseInt(String(p.credits), 10)
            const price = parseFloat(String(p.price))
            if (!name) { toast.error('Every pack needs a name'); return }
            if (!Number.isFinite(credits) || credits < 1) { toast.error(`"${name}": credits must be at least 1`); return }
            if (!Number.isFinite(price) || price < 0) { toast.error(`"${name}": price must be GHS 0 or more`); return }
            const id = p.id || slug(name) || `pack-${cleaned.length + 1}`
            if (cleaned.some(c => c.id === id)) { toast.error(`Two packs have the same name "${name}"`); return }
            cleaned.push({ id, name, credits, price: Math.round(price * 100) / 100, enabled: p.enabled })
        }
        if (!cleaned.length) { toast.error('Add at least one pack'); return }
        if (h > d) toast.warning('The hourly cap is higher than the free daily answers, which is fine: credits pay after the free answers.')

        setSaving(true)
        try {
            const res = await fetch('/api/admin-settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    updates: [
                        { key: 'ai_storefront_mode', value: on ? 'on' : 'off' },
                        { key: 'ai_storefront_daily_limit_per_ip', value: String(d) },
                        { key: 'ai_storefront_hourly_limit_per_visitor', value: String(h) },
                        { key: 'ai_shop_free_monthly_credits', value: String(f) },
                        { key: 'ai_shop_credit_packs', value: JSON.stringify(cleaned) },
                    ],
                }),
            })
            if (res.status === 403) throw new Error('Only admins can change this')
            if (!res.ok) throw new Error('Save failed')
            toast.success('Shop assistant settings saved')
            onSaved()
        } catch (e: any) {
            toast.error(e?.message || 'Save failed')
        } finally {
            setSaving(false)
        }
    }

    return (
        <div className="space-y-5 rounded-xl border border-border p-4">
            <div className="flex items-start justify-between gap-3">
                <div>
                    <h2 className="flex items-center gap-2 text-lg font-bold"><Store className="h-5 w-5 text-primary" /> Shop assistants</h2>
                    <p className="text-xs text-muted-foreground">
                        A chat bubble on every approved storefront, named after the shop. Customers get free answers each day; after that each answer
                        uses 1 shop credit (free monthly credits first, then bought ones). No credits: the customer waits until tomorrow.
                        Owners manage theirs under My Shop → Shop AI.
                    </p>
                </div>
                <Switch checked={on} onCheckedChange={setOn} disabled={!canEdit} aria-label="Shop assistants on or off" />
            </div>

            <div className="grid gap-4 sm:grid-cols-3">
                <div className="space-y-1.5">
                    <Label htmlFor="shop-free-day">Free answers per customer per day</Label>
                    <Input id="shop-free-day" type="number" min={1} max={1000} value={perDay} onChange={e => setPerDay(e.target.value)} disabled={!canEdit} />
                </div>
                <div className="space-y-1.5">
                    <Label htmlFor="shop-hour-cap">Max answers per customer per hour</Label>
                    <Input id="shop-hour-cap" type="number" min={1} max={1000} value={perHour} onChange={e => setPerHour(e.target.value)} disabled={!canEdit} />
                    <p className="text-[11px] text-muted-foreground">Anti-abuse: always applies, even with credits.</p>
                </div>
                <div className="space-y-1.5">
                    <Label htmlFor="shop-free-month">Free credits per shop each month</Label>
                    <Input id="shop-free-month" type="number" min={0} max={100000} value={freeMonthly} onChange={e => setFreeMonthly(e.target.value)} disabled={!canEdit} />
                    <p className="text-[11px] text-muted-foreground">Reset on the 1st; used before bought credits. 0 = none.</p>
                </div>
            </div>

            <div className="space-y-2">
                <div className="flex items-center justify-between">
                    <Label>Credit packs (paid from the owner&apos;s wallet; bought credits last until used up)</Label>
                    {canEdit && packs.length < MAX_PACKS && (
                        <Button type="button" size="sm" variant="outline" onClick={() => setPacks(ps => [...ps, { id: '', name: '', credits: '', price: '', enabled: true }])}>
                            <Plus className="mr-1 h-4 w-4" /> Add pack
                        </Button>
                    )}
                </div>
                <div className="space-y-2">
                    {packs.map((p, i) => (
                        <div key={i} className="grid grid-cols-[1fr_5.5rem_6rem_auto_auto] items-center gap-2 rounded-xl border border-border p-2">
                            <Input aria-label="Pack name" placeholder="Name" value={p.name} maxLength={30} onChange={e => updatePack(i, { name: e.target.value })} disabled={!canEdit} />
                            <Input aria-label="Credits" type="number" min={1} placeholder="Credits" value={p.credits} onChange={e => updatePack(i, { credits: e.target.value })} disabled={!canEdit} />
                            <Input aria-label="Price in GHS" type="number" min={0} step="0.5" placeholder="GHS" value={p.price} onChange={e => updatePack(i, { price: e.target.value })} disabled={!canEdit} />
                            <Switch checked={p.enabled} onCheckedChange={v => updatePack(i, { enabled: v })} disabled={!canEdit} aria-label={`${p.name || 'Pack'} on or off`} />
                            {canEdit ? (
                                <Button type="button" size="icon" variant="ghost" className="h-8 w-8 text-destructive" onClick={() => setPacks(ps => ps.filter((_, j) => j !== i))} aria-label="Remove pack">
                                    <Trash2 className="h-4 w-4" />
                                </Button>
                            ) : <span />}
                        </div>
                    ))}
                </div>
                <p className="text-[11px] text-muted-foreground">Columns: name, credits, price (GHS), on/off. Changing a price never affects credits already bought.</p>
            </div>

            {canEdit && (
                <Button onClick={save} disabled={saving}>
                    {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />} Save shop settings
                </Button>
            )}
        </div>
    )
}
