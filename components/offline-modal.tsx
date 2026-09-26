'use client'

import { useEffect, useState, useCallback } from 'react'

// Mobile networks report a momentary `offline` on every tower handover or
// signal dip. Only a connection that stays down this long gets the modal —
// otherwise it flashes over the page and back for blips nobody would notice.
const OFFLINE_GRACE_MS = 3000

export function OfflineModal() {
    const [isOffline, setIsOffline] = useState(false)
    const [isRetrying, setIsRetrying] = useState(false)

    useEffect(() => {
        let timer: ReturnType<typeof setTimeout> | undefined

        const goOffline = () => {
            clearTimeout(timer)
            timer = setTimeout(() => {
                if (!navigator.onLine) setIsOffline(true)
            }, OFFLINE_GRACE_MS)
        }
        const goOnline = () => {
            clearTimeout(timer)
            setIsOffline(false)
        }

        // Handles the page loading while already offline.
        if (!navigator.onLine) goOffline()

        window.addEventListener('offline', goOffline)
        window.addEventListener('online', goOnline)

        return () => {
            clearTimeout(timer)
            window.removeEventListener('offline', goOffline)
            window.removeEventListener('online', goOnline)
        }
    }, [])

    const handleRetry = useCallback(async () => {
        setIsRetrying(true)
        try {
            // Ping a reliable endpoint to confirm actual connectivity
            const response = await fetch('/api/health', {
                method: 'HEAD',
                cache: 'no-store',
                signal: AbortSignal.timeout(5000),
            })
            if (response.ok) {
                setIsOffline(false)
            }
        } catch {
            // Still offline — keep the modal visible
        } finally {
            setIsRetrying(false)
        }
    }, [])

    if (!isOffline) return null

    return (
        <div
            role="alertdialog"
            aria-modal="true"
            aria-label="You are offline"
            className="fixed inset-0 z-[9999] flex items-center justify-center p-4"
            // No backdrop-filter: at 0.92 alpha the blur is invisible, but it is a
            // full-viewport GPU pass on phones that can least afford one.
            style={{ background: 'rgba(5, 5, 10, 0.94)' }}
        >
            <div
                className="relative w-full max-w-sm rounded-3xl p-8 flex flex-col items-center text-center gap-4"
                style={{
                    background: 'linear-gradient(145deg, rgba(255,255,255,0.07) 0%, rgba(255,255,255,0.02) 100%)',
                    border: '1px solid rgba(255,255,255,0.1)',
                    boxShadow: '0 32px 80px rgba(0,0,0,0.8), inset 0 1px 0 rgba(255,255,255,0.08)',
                    animation: 'offlineModalIn 0.35s cubic-bezier(0.34, 1.56, 0.64, 1) forwards',
                }}
            >
                {/* Pulsing wifi-off icon */}
                <div
                    className="w-16 h-16 rounded-full flex items-center justify-center mb-1"
                    style={{
                        background: 'rgba(139, 92, 246, 0.15)',
                        border: '1.5px solid rgba(139, 92, 246, 0.35)',
                        animation: 'offlinePulse 2.5s ease-in-out infinite',
                    }}
                >
                    <svg
                        width="30"
                        height="30"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="rgba(139, 92, 246, 0.9)"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                    >
                        {/* Wifi signal arcs */}
                        <path d="M5 12.55a11 11 0 0 1 14.08 0" opacity="0.35" />
                        <path d="M1.42 9a16 16 0 0 1 21.16 0" opacity="0.2" />
                        <path d="M8.53 16.11a6 6 0 0 1 6.95 0" opacity="0.6" />
                        {/* Center dot */}
                        <circle cx="12" cy="20" r="1" fill="rgba(139, 92, 246, 0.9)" stroke="none" />
                        {/* Strike-through slash */}
                        <line x1="2" y1="2" x2="22" y2="22" stroke="rgba(239, 68, 68, 0.85)" strokeWidth="1.8" />
                    </svg>
                </div>

                {/* Brand label */}
                <p
                    className="text-xs font-bold tracking-[0.2em] uppercase"
                    style={{ color: 'rgba(139, 92, 246, 0.85)' }}
                >
                    ARHMS TECHNOLOGIES
                </p>

                {/* Main heading */}
                <h1
                    className="text-3xl font-bold"
                    style={{
                        color: '#ffffff',
                        fontFamily: 'var(--font-heading)',
                        letterSpacing: '-0.02em',
                    }}
                >
                    You&apos;re Offline
                </h1>

                {/* Description */}
                <p
                    className="text-sm leading-relaxed"
                    style={{ color: 'rgba(255,255,255,0.45)', maxWidth: '260px' }}
                >
                    No internet connection detected. Check your data or Wi-Fi and try again — your session is still safe.
                </p>

                {/* Try Again button */}
                <button
                    id="offline-modal-retry-btn"
                    onClick={handleRetry}
                    disabled={isRetrying}
                    className="w-full mt-2 py-3.5 rounded-2xl font-semibold text-white text-sm tracking-wide transition-all duration-200 active:scale-95 disabled:opacity-70 disabled:cursor-not-allowed"
                    style={{
                        background: isRetrying
                            ? 'rgba(139, 92, 246, 0.6)'
                            : 'linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%)',
                        boxShadow: isRetrying
                            ? 'none'
                            : '0 8px 24px rgba(139, 92, 246, 0.45)',
                    }}
                >
                    {isRetrying ? (
                        <span className="flex items-center justify-center gap-2">
                            <svg
                                className="animate-spin"
                                width="16"
                                height="16"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2.5"
                                strokeLinecap="round"
                                aria-hidden="true"
                            >
                                <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                            </svg>
                            Checking connection…
                        </span>
                    ) : (
                        'Try Again'
                    )}
                </button>

                {/* Footer note */}
                <p
                    className="text-xs"
                    style={{ color: 'rgba(255,255,255,0.3)', maxWidth: '240px', lineHeight: '1.5' }}
                >
                    Your wallet balance and order history will load once you&apos;re back online.
                </p>
            </div>

            {/* Keyframe styles injected inline so no extra CSS file is needed */}
            <style>{`
                @keyframes offlineModalIn {
                    from { opacity: 0; transform: scale(0.92) translateY(16px); }
                    to   { opacity: 1; transform: scale(1)    translateY(0); }
                }
                @keyframes offlinePulse {
                    0%, 100% { box-shadow: 0 0 0 0 rgba(139,92,246,0.25); }
                    50%       { box-shadow: 0 0 0 10px rgba(139,92,246,0); }
                }
            `}</style>
        </div>
    )
}
