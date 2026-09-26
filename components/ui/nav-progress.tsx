"use client"

import { useEffect, useRef, useState } from "react"
import { usePathname, useSearchParams } from "next/navigation"

/**
 * Thin top progress bar for client navigations.
 *
 * Replaces GlobalLoader, which put a full-screen blurred overlay over the page
 * for 300ms *after* every route change — covering a page that had already
 * rendered, and asking a low-end GPU for a viewport-sized backdrop-filter on
 * every tap. This bar instead starts the moment an internal link is tapped (so
 * the tap is acknowledged on the same frame, before the network answers) and
 * finishes when the new route commits. It animates transform/opacity only and
 * renders nothing while idle.
 */

type Phase = "idle" | "loading" | "done"

// Never leave a bar stuck if a navigation is cancelled or goes nowhere.
const SAFETY_TIMEOUT_MS = 10_000

export function NavProgress() {
    const pathname = usePathname()
    const searchParams = useSearchParams()
    const [phase, setPhase] = useState<Phase>("idle")
    const phaseRef = useRef<Phase>("idle")
    const timers = useRef<ReturnType<typeof setTimeout>[]>([])

    const clearTimers = () => {
        timers.current.forEach(clearTimeout)
        timers.current = []
    }

    const go = (next: Phase) => {
        phaseRef.current = next
        setPhase(next)
    }

    useEffect(() => {
        const onClick = (e: MouseEvent) => {
            if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
            const anchor = (e.target as Element | null)?.closest?.("a")
            if (!anchor || !anchor.href) return
            if (anchor.target && anchor.target !== "_self") return
            if (anchor.hasAttribute("download")) return

            let url: URL
            try {
                url = new URL(anchor.href, window.location.href)
            } catch {
                return
            }
            if (url.origin !== window.location.origin) return
            // Same page (or a hash jump on it) — nothing is going to load.
            if (url.pathname === window.location.pathname && url.search === window.location.search) return

            clearTimers()
            go("loading")
            timers.current.push(setTimeout(() => go("idle"), SAFETY_TIMEOUT_MS))
        }

        document.addEventListener("click", onClick, { capture: true })
        return () => {
            document.removeEventListener("click", onClick, { capture: true })
            clearTimers()
        }
    }, [])

    // Route committed: complete the bar, then fade it away.
    useEffect(() => {
        if (phaseRef.current !== "loading") return
        clearTimers()
        go("done")
        timers.current.push(setTimeout(() => go("idle"), 250))
    }, [pathname, searchParams])

    if (phase === "idle") return null

    return (
        <div
            aria-hidden="true"
            className="pointer-events-none fixed inset-x-0 top-0 z-[10000] h-[3px]"
        >
            <div
                className="h-full w-full origin-left bg-gradient-to-r from-[#7c3aed] via-[#2563eb] to-[#0ea5e9]"
                style={{
                    animation: phase === "loading"
                        ? "nav-progress-grow 8s cubic-bezier(0.1, 0.7, 0.2, 1) forwards"
                        : "nav-progress-done 250ms ease-out forwards",
                }}
            />
            <style>{`
                @keyframes nav-progress-grow { from { transform: scaleX(0.08) } to { transform: scaleX(0.9) } }
                @keyframes nav-progress-done { from { transform: scaleX(1); opacity: 1 } to { transform: scaleX(1); opacity: 0 } }
            `}</style>
        </div>
    )
}
