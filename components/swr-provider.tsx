'use client'

import { SWRConfig } from 'swr'

/**
 * Client-side data cache for the app.
 *
 * Before this, every page fetched in useEffect on mount, so navigating back to
 * a page you had just visited cleared it to skeletons and downloaded everything
 * again. That re-loading — not the first load — is what users on phones
 * describe as "the site keeps loading".
 *
 * The defaults matter more than the cache itself. SWR's out-of-the-box
 * behaviour is to revalidate whenever the tab regains focus or the connection
 * returns, and on a phone both fire constantly: every app switch, every lock
 * screen, every tower handover. That would recreate the exact symptom this is
 * meant to remove, so both are off. Data still refreshes when the key changes,
 * on an explicit mutate() after a purchase or top-up, and on a remount once the
 * deduping window has passed.
 */
export function SWRProvider({ children }: { children: React.ReactNode }) {
    return (
        <SWRConfig
            value={{
                revalidateOnFocus: false,
                revalidateOnReconnect: false,
                // Show the cached page immediately, refresh underneath.
                keepPreviousData: true,
                // Two mounts inside this window share one request — covers a
                // user bouncing between tabs of the bottom nav.
                dedupingInterval: 30_000,
                // A failed request on a flaky connection retries a couple of
                // times, then stops rather than hammering a dead link.
                errorRetryCount: 2,
                errorRetryInterval: 3_000,
            }}
        >
            {children}
        </SWRConfig>
    )
}
