import { unstable_cache } from 'next/cache'
import { createServerClient } from '@/lib/supabase'
import {
    computeChannelEstimate,
    type Channel,
    type ChannelEstimate,
    type DeliverySignal,
} from '@/lib/delivery-estimate'

export const DELIVERY_STATUS_CACHE_TAG = 'delivery-status'

/**
 * Raw signals are what get cached, not the estimates: the estimate ticks
 * against the clock, so it is recomputed on every read from ~20s-old rows.
 * One RPC call per 20s however many dashboards and storefronts poll.
 */
const getCachedSignals = unstable_cache(
    async (): Promise<DeliverySignal[]> => {
        const { data, error } = await (createServerClient() as any).rpc('get_delivery_signals')
        if (error) throw new Error(`get_delivery_signals: ${error.message}`)
        return (data ?? []).map((r: any): DeliverySignal => ({
            channel: r.channel,
            cCreatedAt: r.c_created_at,
            cDeliveredAt: r.c_delivered_at,
            pCreatedAt: r.p_created_at,
            isManuallyDown: !!r.is_manually_down,
            downReason: r.down_reason,
            downSince: r.down_since,
        }))
    },
    ['delivery-signals'],
    { revalidate: 20, tags: [DELIVERY_STATUS_CACHE_TAG] },
)

/** For admins: the raw C/P timestamps behind each row. */
export async function getDeliverySignals(): Promise<DeliverySignal[]> {
    return getCachedSignals()
}

export async function getDeliveryStatus(): Promise<ChannelEstimate[]> {
    const now = Date.now()
    return (await getCachedSignals()).map((s) => computeChannelEstimate(s, now))
}

// Hot path (USSD confirm, hit on every session): a few minutes of in-process
// cache on top, so a busy purchase flow never queries for this.
const CONFIRM_CACHE_MS = 3 * 60_000
let confirmCache: { at: number; signals: DeliverySignal[] } | null = null

/**
 * The estimate for one channel, or null on ANY failure. Must never throw or
 * block a purchase — callers show nothing when this is null.
 */
export async function getDeliveryStatusForConfirm(channel: Channel, timeoutMs = 300): Promise<ChannelEstimate | null> {
    try {
        const now = Date.now()
        if (!confirmCache || now - confirmCache.at > CONFIRM_CACHE_MS) {
            const signals = await Promise.race([
                getCachedSignals(),
                new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
            ])
            if (!signals) return null
            confirmCache = { at: now, signals }
        }
        const signal = confirmCache.signals.find((s) => s.channel === channel)
        return signal ? computeChannelEstimate(signal, now) : null
    } catch {
        return null
    }
}
