'use client'

/**
 * SMS credit bundles. One credit sends one 160-character SMS to one number.
 *
 * Settlement is detected by the balance going up rather than by a purchase
 * status, because the credits endpoint does not echo references back — and a
 * higher balance is the thing the owner actually cares about anyway.
 */

import { useCallback, useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Coins, Check } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { SmsPaymentForm } from '@/components/sms/sms-payment-form'

interface Bundle {
    id: string
    name: string
    credits: number
    price: number
    pricePerSms: number
}

export function SmsCredits({ credits, onPurchased, deBranded = false }: { credits: number; onPurchased: () => void; deBranded?: boolean }) {
    const [bundles, setBundles] = useState<Bundle[]>([])
    const [loading, setLoading] = useState(true)
    const [selected, setSelected] = useState<Bundle | null>(null)

    useEffect(() => {
        (async () => {
            try {
                const res = await fetch('/api/sms/credits', { cache: 'no-store' })
                const data = await res.json()
                if (data?.success) setBundles(data.bundles || [])
                else toast.error(data?.error || 'Could not load bundles')
            } catch {
                toast.error('Could not load bundles')
            } finally {
                setLoading(false)
            }
        })()
    }, [])

    // Captured when the purchase starts, so a balance that was already above
    // zero does not read as "settled" on the first poll.
    const isSettled = useCallback(async () => {
        const res = await fetch('/api/sms/credits', { cache: 'no-store' })
        const data = await res.json()
        return Number(data?.credits) > credits
    }, [credits])

    const handleSettled = useCallback(() => {
        toast.success(`${selected?.credits?.toLocaleString() ?? ''} SMS credits added`)
        setSelected(null)
        onPurchased()
    }, [selected, onPurchased])

    if (loading) return <Skeleton className="h-64 w-full rounded-2xl" />

    return (
        <div className="space-y-4">
            <Card>
                <CardHeader>
                    <CardTitle className="text-base flex items-center gap-2"><Coins className="w-4 h-4 text-emerald-600" /> Buy SMS credits</CardTitle>
                    <CardDescription>
                        1 credit = 1 SMS (160 characters) to 1 customer. Longer messages or emoji use more credits.
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    {bundles.length === 0 ? (
                        <p className="text-sm text-muted-foreground text-center py-6">No bundles are on sale right now. Please check back soon.</p>
                    ) : (
                        <div className="grid gap-3 grid-cols-2 sm:grid-cols-3">
                            {bundles.map((b) => (
                                <button
                                    key={b.id}
                                    type="button"
                                    onClick={() => setSelected(b)}
                                    className={cn(
                                        'relative rounded-2xl border-2 p-4 text-left transition-colors',
                                        selected?.id === b.id ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-950/30' : 'border-gray-200 dark:border-gray-800 hover:border-emerald-300'
                                    )}
                                >
                                    {selected?.id === b.id && <Check className="absolute top-2 right-2 w-4 h-4 text-emerald-600" />}
                                    <p className="text-xs text-muted-foreground">{b.name}</p>
                                    <p className="text-2xl font-black">{b.credits.toLocaleString()}</p>
                                    <p className="text-xs text-muted-foreground">SMS</p>
                                    <p className="mt-2 font-bold text-emerald-700 dark:text-emerald-400">GHS {b.price.toFixed(2)}</p>
                                    <p className="text-[11px] text-muted-foreground">GHS {b.pricePerSms.toFixed(3)} per SMS</p>
                                </button>
                            ))}
                        </div>
                    )}
                </CardContent>
            </Card>

            {selected && (
                <Card>
                    <CardHeader>
                        <CardTitle className="text-base">Pay for {selected.credits.toLocaleString()} credits</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <SmsPaymentForm
                            key={selected.id}
                            endpoint="/api/sms/credits/purchase"
                            extraBody={{ bundleId: selected.id }}
                            amount={selected.price}
                            payLabel="Buy credits"
                            deBranded={deBranded}
                            isSettled={isSettled}
                            onSettled={handleSettled}
                        />
                    </CardContent>
                </Card>
            )}
        </div>
    )
}
