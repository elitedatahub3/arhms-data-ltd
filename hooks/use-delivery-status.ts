'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChannelEstimate } from '@/lib/delivery-estimate'

const POLL_MS = 25_000
const REFRESH_COOLDOWN_S = 10

/**
 * Polls /api/delivery-status every 25s while the tab is visible; refetches
 * the moment it becomes visible again. `refresh()` is the manual button: it
 * reports `refreshing` only for the real fetch, then a short cooldown.
 */
export function useDeliveryStatus({ enabled = true }: { enabled?: boolean } = {}) {
    const [channels, setChannels] = useState<ChannelEstimate[] | null>(null)
    const [loading, setLoading] = useState(true)
    const [refreshing, setRefreshing] = useState(false)
    const [cooldown, setCooldown] = useState(0)
    // Shared so a manual refresh during a poll waits on that same fetch and
    // spins for its real duration, rather than returning at once.
    const inFlight = useRef<Promise<void> | null>(null)

    const load = useCallback(() => {
        if (inFlight.current) return inFlight.current
        inFlight.current = (async () => {
            try {
                const res = await fetch('/api/delivery-status')
                if (res.ok) {
                    const json = await res.json()
                    setChannels(Array.isArray(json.channels) ? json.channels : [])
                }
            } catch {
                // Keep the last good read; the next poll retries.
            } finally {
                inFlight.current = null
                setLoading(false)
            }
        })()
        return inFlight.current
    }, [])

    useEffect(() => {
        if (!enabled) return
        let timer: ReturnType<typeof setInterval> | null = null
        const start = () => {
            if (timer) return
            timer = setInterval(load, POLL_MS)
        }
        const stop = () => {
            if (timer) clearInterval(timer)
            timer = null
        }
        const onVisibility = () => {
            if (document.visibilityState === 'visible') {
                load()
                start()
            } else {
                stop()
            }
        }
        load()
        if (document.visibilityState === 'visible') start()
        document.addEventListener('visibilitychange', onVisibility)
        return () => {
            stop()
            document.removeEventListener('visibilitychange', onVisibility)
        }
    }, [enabled, load])

    useEffect(() => {
        if (cooldown <= 0) return
        const t = setTimeout(() => setCooldown((c) => c - 1), 1000)
        return () => clearTimeout(t)
    }, [cooldown])

    const refresh = useCallback(async () => {
        if (refreshing || cooldown > 0) return
        setRefreshing(true)
        await load()
        setRefreshing(false)
        setCooldown(REFRESH_COOLDOWN_S)
    }, [refreshing, cooldown, load])

    return { channels, loading, refreshing, cooldown, refresh }
}
