'use client'

/**
 * "Customer order confirmations are OFF" — the nudge on the shop dashboard.
 *
 * Self-contained: it fetches its own state and renders nothing at all unless
 * the shop could genuinely switch this on today. That keeps the dashboard page
 * free of yet another data dependency, and lets the sub portal mount the same
 * component with a different href.
 *
 * Deliberately quiet about the thing it cannot fix: a shop with no SMS account
 * or no approved sender ID sees nothing here, because telling them to switch on
 * something that is three steps away is nagging, not guidance.
 */

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, ArrowRight, X } from 'lucide-react'
import { smsFetch } from '@/lib/sms/sms-fetch'

const DISMISS_KEY = 'order_sms_banner_dismissed'

export function OrderSmsBanner({ href = '/dashboard/shop/sms?tab=orders' }: { href?: string }) {
    const [show, setShow] = useState(false)

    useEffect(() => {
        let cancelled = false

        ;(async () => {
            try {
                // Per-viewer convenience only; a cleared browser just shows it again.
                if (localStorage.getItem(DISMISS_KEY) === '1') return
            } catch { /* private window — carry on */ }

            try {
                const res = await smsFetch('/api/sms/account', { cache: 'no-store' })
                if (!res.ok) return
                const data = await res.json()
                if (cancelled || !data?.success) return

                const active = data.account?.status === 'active'
                const hasOwnSender = (data.allowedSenders || []).some((s: any) => s.type === 'own')
                const bothOff = !data.orderSms?.data && !data.orderSms?.airtime

                if (data.enabled && active && hasOwnSender && bothOff) setShow(true)
            } catch { /* the dashboard must not care */ }
        })()

        return () => { cancelled = true }
    }, [])

    if (!show) return null

    const dismiss = () => {
        setShow(false)
        try { localStorage.setItem(DISMISS_KEY, '1') } catch { /* nothing to do */ }
    }

    return (
        <div className="relative flex items-start gap-4 p-4 rounded-2xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800">
            <div className="w-9 h-9 rounded-xl bg-amber-100 dark:bg-amber-900/40 flex items-center justify-center flex-shrink-0 mt-0.5">
                <AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-400" />
            </div>
            <div className="flex-1 min-w-0 pr-6">
                <p className="font-bold text-sm text-amber-900 dark:text-amber-200">Customer order confirmations are OFF</p>
                <p className="text-xs text-amber-700 dark:text-amber-400 mt-0.5">
                    Switch them on to text your customers automatically when they buy — from your own sender ID.
                </p>
                <Link href={href} className="inline-flex items-center gap-1 text-xs font-bold text-amber-800 dark:text-amber-300 mt-2 hover:underline">
                    Turn on in Shop SMS <ArrowRight className="w-3.5 h-3.5" />
                </Link>
            </div>
            <button
                type="button"
                onClick={dismiss}
                aria-label="Dismiss"
                className="absolute top-3 right-3 text-amber-500 hover:text-amber-700 dark:hover:text-amber-300"
            >
                <X className="w-4 h-4" />
            </button>
        </div>
    )
}
