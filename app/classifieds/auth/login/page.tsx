'use client'

import { Suspense } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { GoogleSignInButton } from '@/components/google-sign-in-button'
import { SellButton } from '@/components/classifieds/sell-button'
import { ShoppingBag, Phone, AlertCircle } from 'lucide-react'

/**
 * Marketplace login (marketplace.arhmsgh.com).
 *
 * Lives under /classifieds/* so it stays on the subdomain (middleware only
 * bounces bare /auth/* to the main domain). Google-only, sign-in only. On
 * success the OAuth flow returns to /classifieds/auth/callback, which forwards
 * the user to `?redirect=` (the originally-requested tab) or the marketplace home.
 */
function MarketplaceLoginInner() {
    const searchParams = useSearchParams()
    const redirect = searchParams.get('redirect') || '/classifieds'
    const hasError = searchParams.get('error') === 'oauth_failed'

    return (
        <div className="flex min-h-screen flex-col items-center justify-center bg-gray-50 px-4 py-12 dark:bg-[#0a0f1c]">
            <div className="w-full max-w-[420px]">
                {/* Branding */}
                <div className="mb-8 text-center">
                    <Link href="/classifieds" className="inline-flex flex-col items-center">
                        <span className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-600 shadow-lg shadow-emerald-500/30">
                            <ShoppingBag className="h-8 w-8 text-white" />
                        </span>
                        <h1 className="text-2xl font-black tracking-tight text-gray-900 dark:text-white">
                            ARHMS <span className="text-emerald-600 dark:text-emerald-400">MARKETPLACE</span>
                        </h1>
                        <p className="mt-1 text-sm font-medium text-gray-500 dark:text-gray-400">
                            Sign in to save, message &amp; sell
                        </p>
                    </Link>
                </div>

                <div className="rounded-3xl border border-gray-100 bg-white p-8 shadow-xl dark:border-gray-800 dark:bg-[#151c2c]">
                    {hasError && (
                        <div className="mb-6 flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-600 dark:border-red-900/40 dark:bg-red-900/20 dark:text-red-400">
                            <AlertCircle className="h-4 w-4 flex-shrink-0" />
                            Google sign-in failed. Please try again.
                        </div>
                    )}

                    <GoogleSignInButton
                        label="Continue with Google"
                        callbackPath="/classifieds/auth/callback"
                        next={redirect}
                    />

                    <div className="mt-8 space-y-3 border-t border-gray-100 pt-6 dark:border-gray-800">
                        {/* Phone-only seller sign-in / onboarding (no password) via the
                            quick-start flow — enter number → instant seller session. */}
                        <SellButton className="flex h-12 w-full items-center justify-center gap-2 rounded-2xl border border-gray-200 bg-gray-50 text-sm font-bold text-gray-700 shadow-none hover:bg-gray-100 dark:border-gray-700 dark:bg-white/5 dark:text-gray-300 dark:hover:bg-white/10">
                            <Phone className="h-4 w-4" />
                            Are you a seller? Continue with phone
                        </SellButton>

                        <Link
                            href="/classifieds"
                            className="flex h-12 items-center justify-center rounded-2xl text-sm font-semibold text-gray-500 transition-colors hover:text-gray-700 dark:text-gray-500 dark:hover:text-gray-300"
                        >
                            ← Browse marketplace
                        </Link>
                    </div>
                </div>

                <p className="mt-6 text-center text-xs text-gray-400 dark:text-gray-600">
                    By continuing you agree to our{' '}
                    <Link href="/terms" className="underline hover:text-gray-600 dark:hover:text-gray-400">Terms</Link>
                    {' '}&amp;{' '}
                    <Link href="/privacy" className="underline hover:text-gray-600 dark:hover:text-gray-400">Privacy</Link>
                </p>
            </div>
        </div>
    )
}

export default function MarketplaceLoginPage() {
    return (
        <Suspense fallback={<div className="min-h-screen bg-gray-50 dark:bg-[#0a0f1c]" />}>
            <MarketplaceLoginInner />
        </Suspense>
    )
}
