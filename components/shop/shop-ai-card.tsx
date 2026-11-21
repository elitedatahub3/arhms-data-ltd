'use client'

/**
 * Compact Shop AI summary on /dashboard/shop: credits left + a link to the
 * Shop AI page (My Shop -> Shop AI) where owners buy credits and switch it on/off.
 * Renders nothing until the admin switches storefront assistants on.
 */
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowRight, Sparkles } from 'lucide-react'

interface Info {
    hasShop: boolean
    adminOn: boolean
    enabled: boolean
    credits: { total: number }
}

export function ShopAiCard() {
    const [info, setInfo] = useState<Info | null>(null)

    useEffect(() => {
        fetch('/api/ai-assistant/shop-settings', { cache: 'no-store' })
            .then(r => (r.ok ? r.json() : null))
            .then(setInfo)
            .catch(() => {})
    }, [])

    if (!info?.hasShop || !info.adminOn) return null
    const low = info.credits.total <= 10

    return (
        <Link href="/dashboard/shop/ai" className="flex items-center gap-3 rounded-2xl border border-border p-4 transition hover:border-primary/50 hover:bg-muted/30">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                <Sparkles className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
                <p className="font-bold">Shop AI</p>
                <p className={low ? 'text-xs font-semibold text-amber-600' : 'text-xs text-muted-foreground'}>
                    {!info.enabled ? 'Switched off' : `${info.credits.total.toLocaleString()} credits left${low ? ': buy more' : ''}`}
                </p>
            </div>
            <ArrowRight className="h-4 w-4 text-muted-foreground" />
        </Link>
    )
}
