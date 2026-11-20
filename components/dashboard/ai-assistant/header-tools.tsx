'use client'

/**
 * ARHMS AI chat header tools:
 *   - UsageMeter: "40% of hourly limit". Shows the window closest to running out;
 *     tap for hour / day / month usage and how to buy more when the month runs out.
 *   - SupportButton: talk to ARHMS support directly (WhatsApp), without asking the AI.
 */
import { useEffect, useRef, useState } from 'react'
import { Gauge, Headset } from 'lucide-react'
import { cn } from '@/lib/utils'
import { usageMeter, type UsageSnapshot } from '@/lib/ai-assistant/helpers'

export function UsageMeter({
    usage,
    reset,
    unlimited = false,
}: {
    usage: UsageSnapshot
    reset: { price: number; questions: number } | null
    /** Admins/sub-admins: usage is shown for information; they are never blocked. */
    unlimited?: boolean
}) {
    const [open, setOpen] = useState(false)
    const ref = useRef<HTMLDivElement>(null)
    const meter = usageMeter(usage)

    useEffect(() => {
        if (!open) return
        const close = (e: MouseEvent | TouchEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
        }
        document.addEventListener('mousedown', close)
        document.addEventListener('touchstart', close)
        return () => {
            document.removeEventListener('mousedown', close)
            document.removeEventListener('touchstart', close)
        }
    }, [open])

    const rows: [string, { used: number; limit: number }][] = [
        ['This hour', usage.hour],
        ['Today', usage.day],
        ['This month', usage.month],
    ]

    return (
        <div ref={ref} className="relative">
            <button
                type="button"
                onClick={() => setOpen(o => !o)}
                aria-expanded={open}
                aria-label={`Usage: ${meter.label}`}
                className={cn(
                    'flex items-center gap-1.5 rounded-full border px-2.5 py-1.5 text-xs font-medium transition hover:bg-muted',
                    unlimited ? 'border-border'
                        : meter.pct >= 100 ? 'border-destructive/50 text-destructive'
                        : meter.pct >= 80 ? 'border-amber-400/60 text-amber-700 dark:text-amber-300'
                        : 'border-border',
                )}
            >
                <Gauge className="h-3.5 w-3.5 shrink-0" />
                <span className="max-w-[7.5rem] text-left leading-tight sm:max-w-none sm:whitespace-nowrap">{meter.label}</span>
            </button>

            {open && (
                <div className="absolute left-1/2 top-full z-10 mt-2 w-64 -translate-x-1/2 rounded-2xl border border-border bg-background p-3 text-sm shadow-xl">
                    <p className="font-semibold">Your ARHMS AI limits</p>
                    <div className="mt-2 space-y-2">
                        {rows.map(([label, w]) => {
                            const pct = Math.min(100, Math.round((w.used / Math.max(w.limit, 1)) * 100))
                            return (
                                <div key={label}>
                                    <div className="flex justify-between text-xs text-muted-foreground">
                                        <span>{label}</span>
                                        <span>{Math.min(w.used, w.limit)} / {w.limit}</span>
                                    </div>
                                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                                        <div className={pct >= 100 ? 'h-full bg-destructive' : 'h-full bg-primary'} style={{ width: `${pct}%` }} />
                                    </div>
                                </div>
                            )
                        })}
                    </div>
                    <p className="mt-3 text-xs text-muted-foreground">
                        {unlimited
                            ? 'As an admin you are not limited. These bars show the limits customers get.'
                            : <>
                                The hourly limit resets every hour and the daily limit at midnight.
                                {reset && ` When your monthly questions run out, you can buy ${reset.questions} more for GHS ${reset.price.toFixed(2)}.`}
                            </>}
                    </p>
                </div>
            )}
        </div>
    )
}

/** wa.me link from the admin's WhatsApp number, else the group link, else the complaints page. */
export function supportHref(support: { whatsappNumber: string | null; whatsappLink: string | null } | null): { href: string; external: boolean } {
    const digits = String(support?.whatsappNumber || '').replace(/\D/g, '')
    if (digits.length >= 9) {
        const intl = digits.startsWith('0') ? `233${digits.slice(1)}` : digits
        return { href: `https://wa.me/${intl}`, external: true }
    }
    const link = support?.whatsappLink || ''
    if (/^https:\/\/(chat\.whatsapp\.com|wa\.me)\//.test(link)) return { href: link, external: true }
    return { href: '/dashboard/complaints', external: false }
}

export function SupportButton({ support, onNavigate }: { support: { whatsappNumber: string | null; whatsappLink: string | null } | null; onNavigate?: () => void }) {
    const { href, external } = supportHref(support)
    return (
        <a
            href={href}
            {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
            onClick={external ? undefined : onNavigate}
            aria-label="Talk to customer support"
            title="Talk to customer support"
            className="rounded-full p-2 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
            <Headset className="h-5 w-5" />
        </a>
    )
}
