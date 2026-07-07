'use client'

import { useEffect, useState } from 'react'

const MESSAGES = [
    'Welcome to Arhms Marketplace',
    'We have verified sellers',
    'Buy more, sell more',
]

const ROTATE_MS = 10_000

/**
 * Rotating hero tagline — shows each message for 10s, then fades in the next.
 * Re-keying the span on each change re-triggers the fade-in animation.
 */
export function HeroTagline({ className }: { className?: string }) {
    const [index, setIndex] = useState(0)

    useEffect(() => {
        const id = setInterval(() => {
            setIndex((prev) => (prev + 1) % MESSAGES.length)
        }, ROTATE_MS)
        return () => clearInterval(id)
    }, [])

    return (
        <p className={className} aria-live="polite">
            <span key={index} className="inline-block animate-slow-fade">
                {MESSAGES[index]}
            </span>
        </p>
    )
}
