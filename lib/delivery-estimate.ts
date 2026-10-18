/**
 * Live delivery estimate — pure logic, no database or framework imports, so it
 * runs in the browser, on the server and under `node --test` alike.
 *
 * Inputs come from get_delivery_signals() (migration 20261018000000):
 *   C = the most recently PLACED completed order on a channel
 *   P = the oldest in-flight order placed after C
 *
 * Metric 1 ("last delivery took") = C.delivered_at - C.created_at
 * Metric 2 ("current estimate")   = now - P.created_at, or Metric 1 when no P
 *
 * The strength bar follows Metric 1 only — a finished, known duration — so it
 * doesn't jump about with an order that is still moving.
 */

export const CHANNELS = ['MTN', 'Telecel', 'AT-iShare', 'AT-BigTime', 'Airtime'] as const
export type Channel = (typeof CHANNELS)[number]

/** Confirmation and webhook lag that isn't the customer waiting. */
export const BUFFER_MINUTES = 5
/** A C older than this says nothing about now. */
export const STALE_HOURS = 24

export type EstimateLabel = 'instant' | 'minutes' | 'validation_ongoing'
export type StrengthTier = 'Excellent' | 'Good' | 'Delayed' | 'Critical'
export type ChannelState = 'live' | 'down' | 'no_recent'

/** Raw timestamps for one channel, as the RPC returns them (ISO strings). */
export interface DeliverySignal {
    channel: string
    cCreatedAt: string | null
    cDeliveredAt: string | null
    pCreatedAt: string | null
    isManuallyDown: boolean
    downReason: string | null
    downSince: string | null
}

/** A buffer-adjusted duration: rounded minutes plus the precise seconds behind them. */
export interface Duration {
    minutes: number
    seconds: number
}

export interface ChannelEstimate {
    channel: string
    state: ChannelState
    /** Metric 1. */
    lastTook: Duration | null
    /** Metric 2. */
    current: Duration | null
    /** Null when the channel is down — a cheerful label next to 0% misleads. */
    label: EstimateLabel | null
    headline: string | null
    /** 1–100 when live, 0 when down, null with no recent orders. */
    percent: number | null
    tier: StrengthTier | null
    /** C's placed → delivered times, for the headline card. */
    placedAt: string | null
    deliveredAt: string | null
    downReason: string | null
}

export function adjustMinutes(raw: number): number {
    return raw <= BUFFER_MINUTES ? raw : raw - BUFFER_MINUTES
}

export function estimateLabel(adjustedMinutes: number): EstimateLabel {
    if (adjustedMinutes < 10) return 'instant'
    if (adjustedMinutes < 60) return 'minutes'
    return 'validation_ongoing'
}

const HEADLINES: Record<EstimateLabel, string> = {
    instant: 'Instant Delivery Ongoing',
    minutes: 'Delivery Ongoing',
    // Never "slow": framed as a step the order is going through.
    validation_ongoing: 'Validation Ongoing',
}

/** Linear from `fromPct` at `lo` minutes to `toPct` at `hi` minutes. */
function slide(adj: number, lo: number, hi: number, fromPct: number, toPct: number): number {
    return fromPct - ((adj - lo) / (hi - lo)) * (fromPct - toPct)
}

/** Piecewise-linear, so the bar eases between tiers instead of stepping. */
export function strengthScore(adjustedMinutes: number): { percent: number; tier: StrengthTier } {
    const adj = Math.max(0, adjustedMinutes)
    if (adj <= 10) return { percent: 100, tier: 'Excellent' }
    if (adj <= 30) return { percent: Math.round(slide(adj, 10, 30, 100, 80)), tier: 'Excellent' }
    if (adj <= 60) return { percent: Math.round(slide(adj, 30, 60, 79, 50)), tier: 'Good' }
    if (adj <= 180) return { percent: Math.round(slide(adj, 60, 180, 49, 20)), tier: 'Delayed' }
    // Floor of 1, never 0: an empty bar is reserved for a channel marked down.
    return { percent: Math.max(1, Math.round(slide(adj, 180, 720, 19, 1))), tier: 'Critical' }
}

/** Buffer-adjusted duration between two instants (ms). */
export function adjustedDuration(fromMs: number, toMs: number): Duration {
    const rawMinutes = Math.max(0, toMs - fromMs) / 60_000
    const adj = adjustMinutes(rawMinutes)
    return { minutes: Math.round(adj), seconds: Math.round(adj * 60) }
}

function preciseMinutes(d: Duration): number {
    return d.seconds / 60
}

/**
 * Seconds under a minute, so a fast delivery never reads "0 min". Branches on
 * the precise seconds, not the rounded minutes — 31–59s rounds to 1 minute and
 * would otherwise fall through to "1 min".
 */
export function formatDuration(d: Duration | null): string {
    if (!d) return ''
    if (d.seconds < 60) return `${Math.max(1, d.seconds)} sec`
    return `${d.minutes} min`
}

/** Customer-facing tier wording — never "down" or "critical". */
export function tierText(est: ChannelEstimate): string {
    if (est.state === 'down') return 'Experiencing delays'
    if (est.state === 'no_recent') return 'No recent orders'
    if (est.tier === 'Critical') return 'Experiencing delays'
    return est.tier ?? ''
}

function parseMs(iso: string | null): number | null {
    if (!iso) return null
    const ms = Date.parse(iso)
    return Number.isFinite(ms) ? ms : null
}

export function computeChannelEstimate(
    signal: DeliverySignal,
    nowMs: number,
    opts: { staleHours?: number } = {},
): ChannelEstimate {
    const staleHours = opts.staleHours ?? STALE_HOURS
    const cCreated = parseMs(signal.cCreatedAt)
    const cDelivered = parseMs(signal.cDeliveredAt)
    const pCreated = parseMs(signal.pCreatedAt)

    const base: ChannelEstimate = {
        channel: signal.channel,
        state: 'no_recent',
        lastTook: null,
        current: null,
        label: null,
        headline: null,
        percent: null,
        tier: null,
        placedAt: signal.cCreatedAt,
        deliveredAt: signal.cDeliveredAt,
        downReason: null,
    }

    const hasC = cCreated !== null && cDelivered !== null
    const lastTook = hasC ? adjustedDuration(cCreated, cDelivered) : null

    if (signal.isManuallyDown) {
        // Frozen at the moment it was marked down, not ticking against now.
        const frozenAt = parseMs(signal.downSince) ?? nowMs
        const current = pCreated !== null ? adjustedDuration(pCreated, Math.max(pCreated, frozenAt)) : lastTook
        return {
            ...base,
            state: 'down',
            lastTook,
            current,
            percent: 0,
            downReason: signal.downReason,
        }
    }

    if (!hasC || nowMs - cCreated > staleHours * 3_600_000) {
        return { ...base, placedAt: null, deliveredAt: null }
    }

    const current = pCreated !== null ? adjustedDuration(pCreated, nowMs) : lastTook
    const label = estimateLabel(preciseMinutes(current))
    const { percent, tier } = strengthScore(preciseMinutes(lastTook))

    return {
        ...base,
        state: 'live',
        lastTook,
        current,
        label,
        headline: HEADLINES[label],
        percent,
        tier,
    }
}

/**
 * Whether a buy-confirm surface may show the estimate at all. Anything short
 * of a clean, fast, healthy read shows nothing — never a discouraging number
 * right before a purchase.
 */
export function isConfirmWorthy(est: ChannelEstimate | null | undefined): est is ChannelEstimate {
    return !!est
        && est.state === 'live'
        && est.label === 'instant'
        && (est.tier === 'Excellent' || est.tier === 'Good')
        && est.current !== null
}

/** "Usually delivers in ~2 min" — only call after isConfirmWorthy. */
export function confirmText(est: ChannelEstimate): string {
    return `Usually delivers in ~${formatDuration(est.current)}`
}

/** Which channel a data order for this network reads. Mashup/Express aren't shown. */
export function channelForNetwork(network: string | null | undefined): Channel | null {
    return (CHANNELS as readonly string[]).includes(network ?? '') ? (network as Channel) : null
}
