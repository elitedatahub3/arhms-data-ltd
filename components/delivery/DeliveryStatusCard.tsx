'use client'

import { RefreshCw, Zap } from 'lucide-react'
import { cn } from '@/lib/utils'
import { NetworkLogo } from '@/lib/networks'
import { Skeleton } from '@/components/ui/skeleton'
import { useDeliveryStatus } from '@/hooks/use-delivery-status'
import {
    CHANNELS,
    formatDuration,
    tierText,
    type ChannelEstimate,
} from '@/lib/delivery-estimate'

const CHANNEL_NAMES: Record<string, string> = {
    MTN: 'MTN',
    Telecel: 'Telecel',
    'AT-iShare': 'AT-iShare',
    'AT-BigTime': 'AT-BigTime',
    Airtime: 'Airtime',
}

function tone(est: ChannelEstimate): { bar: string; text: string } {
    if (est.state === 'down' || est.tier === 'Critical') return { bar: 'bg-rose-500', text: 'text-rose-500' }
    if (est.state === 'no_recent') return { bar: 'bg-muted-foreground/30', text: 'text-muted-foreground' }
    if (est.tier === 'Delayed') return { bar: 'bg-amber-500', text: 'text-amber-600 dark:text-amber-400' }
    return { bar: 'bg-green-500', text: 'text-green-600 dark:text-green-400' }
}

function clock(iso: string | null): string {
    if (!iso) return ''
    return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

function ChannelLogo({ channel }: { channel: string }) {
    if (channel === 'Airtime') {
        return (
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-slate-800 text-[11px] font-bold text-white dark:bg-slate-200 dark:text-slate-900">
                A
            </span>
        )
    }
    return (
        <span className="block h-6 w-6 overflow-hidden rounded-full bg-white">
            <NetworkLogo id={channel} />
        </span>
    )
}

function ChannelRow({ est }: { est: ChannelEstimate }) {
    const t = tone(est)
    const took = est.state !== 'no_recent' && est.lastTook ? formatDuration(est.lastTook) : ''
    return (
        <div className="py-2.5">
            <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2.5">
                    <ChannelLogo channel={est.channel} />
                    <span className="truncate text-sm font-semibold text-foreground">
                        {CHANNEL_NAMES[est.channel] ?? est.channel}
                    </span>
                </div>
                {took && est.state === 'live' && (
                    <span className="shrink-0 text-[11px] text-muted-foreground">Last delivery took {took}</span>
                )}
            </div>
            <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                    className={cn('h-full rounded-full transition-[width] duration-700', t.bar)}
                    style={{ width: `${est.percent ?? 0}%` }}
                />
            </div>
            <p className={cn('mt-1.5 text-[11px] font-semibold', t.text)}>
                {tierText(est)}
                {est.state === 'down' && est.downReason ? (
                    <span className="font-normal text-muted-foreground"> · {est.downReason}</span>
                ) : null}
            </p>
        </div>
    )
}

function Headline({ est }: { est: ChannelEstimate }) {
    if (est.state !== 'live' || !est.headline) return null
    return (
        <div className="mb-3 rounded-xl border border-border/60 bg-muted/40 p-3">
            <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                {CHANNEL_NAMES[est.channel] ?? est.channel} · Delivery Estimation
            </p>
            <p className="mt-1 flex items-center gap-1.5 text-base font-black text-foreground">
                {est.label === 'instant' && <Zap className="h-4 w-4 text-green-500" />}
                {est.headline}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
                Current estimate: <span className="font-semibold text-foreground">{formatDuration(est.current)}</span>
                {' · '}Last delivery took {formatDuration(est.lastTook)}
            </p>
            {est.placedAt && est.deliveredAt && (
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                    Placed {clock(est.placedAt)} → Delivered {clock(est.deliveredAt)}
                </p>
            )}
        </div>
    )
}

function SkeletonRows() {
    return (
        <div aria-hidden>
            {CHANNELS.map((c) => (
                <div key={c} className="py-2.5">
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2.5">
                            <Skeleton className="h-6 w-6 rounded-full" />
                            <Skeleton className="h-3.5 w-20" />
                        </div>
                        <Skeleton className="h-3 w-28" />
                    </div>
                    <Skeleton className="mt-2 h-1.5 w-full rounded-full" />
                    <Skeleton className="mt-1.5 h-3 w-16" />
                </div>
            ))}
        </div>
    )
}

export function DeliveryStatusCard({
    className,
    headlineChannel = 'MTN',
    showTitle = true,
}: {
    className?: string
    /** The channel given the headline card; null hides it. */
    headlineChannel?: string | null
    showTitle?: boolean
}) {
    const { channels, loading, refreshing, cooldown, refresh } = useDeliveryStatus()
    const headline = headlineChannel ? channels?.find((c) => c.channel === headlineChannel) : undefined

    // The endpoint failed outright (e.g. before the migration has run): hide
    // rather than show five empty rows.
    if (!loading && (!channels || channels.length === 0)) return null

    return (
        <div className={cn('relative rounded-2xl border border-border/60 bg-card p-4 pb-6 shadow-sm', className)}>
            {showTitle && (
                <div className="mb-2 flex items-center justify-between">
                    <h3 className="text-sm font-black tracking-tight text-foreground">Delivery Status</h3>
                    <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Live</span>
                </div>
            )}
            {loading ? (
                <SkeletonRows />
            ) : (
                <>
                    {headline && <Headline est={headline} />}
                    <div className="divide-y divide-border/40">
                        {channels!.map((est) => (
                            <ChannelRow key={est.channel} est={est} />
                        ))}
                    </div>
                </>
            )}
            <button
                type="button"
                onClick={refresh}
                disabled={loading || refreshing || cooldown > 0}
                aria-label={cooldown > 0 ? `Refresh available in ${cooldown} seconds` : 'Refresh delivery status'}
                className={cn(
                    'absolute -bottom-4 left-1/2 flex h-9 min-w-9 -translate-x-1/2 items-center justify-center gap-1 rounded-full border border-border/60 bg-background px-2 shadow-md transition-opacity',
                    cooldown > 0 && 'opacity-50',
                )}
            >
                <RefreshCw className={cn('h-4 w-4 text-foreground', refreshing && 'animate-spin')} />
                {cooldown > 0 && <span className="text-[10px] font-semibold tabular-nums text-muted-foreground">{cooldown}s</span>}
            </button>
        </div>
    )
}
