'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { ShieldCheck, ArrowRight, Loader2, CheckCircle2, AlertCircle, XCircle, Info } from 'lucide-react'

type CheckStatus = 'registered' | 'submitted' | 'invalid' | 'not_mtn'

interface VerifyResult {
    number: string
    status: CheckStatus
    reason?: string
}

const RESULT_META: Record<CheckStatus, { title: string; detail: string; className: string; icon: typeof CheckCircle2 }> = {
    registered: {
        title: 'Registered',
        detail: 'This number can receive MTN data.',
        className: 'bg-green-50 text-green-800 border-green-200 dark:bg-green-900/20 dark:text-green-300 dark:border-green-900/40',
        icon: CheckCircle2,
    },
    submitted: {
        title: 'Not registered yet',
        detail: 'We sent it to MTN. Registration can take up to 2 weeks. Orders for it are held and delivered once it completes.',
        className: 'bg-amber-50 text-amber-900 border-amber-200 dark:bg-amber-900/20 dark:text-amber-200 dark:border-amber-900/40',
        icon: AlertCircle,
    },
    invalid: {
        title: 'Invalid number',
        detail: 'Check the number and try again.',
        className: 'bg-red-50 text-red-800 border-red-200 dark:bg-red-900/20 dark:text-red-300 dark:border-red-900/40',
        icon: XCircle,
    },
    not_mtn: {
        title: 'Not an MTN number',
        detail: 'Only MTN numbers need to be verified.',
        className: 'bg-gray-50 text-gray-700 border-gray-200 dark:bg-gray-800/60 dark:text-gray-300 dark:border-gray-700',
        icon: Info,
    },
}

/**
 * Inline single-number MTN registration check for the data page. Uses Server 1
 * (Agent Portal), the same default as /dashboard/mtn-registration, so an
 * unregistered number is submitted to MTN by the check itself.
 */
export function MtnVerifyPanel({ className }: { className?: string }) {
    const [phone, setPhone] = useState('')
    const [isChecking, setIsChecking] = useState(false)
    const [result, setResult] = useState<VerifyResult | null>(null)
    const [error, setError] = useState<string | null>(null)

    const verify = async () => {
        const number = phone.trim()
        if (!number || isChecking) return

        setIsChecking(true)
        setResult(null)
        setError(null)
        try {
            const res = await fetch('/api/mtn/check-registration', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ numbers: [number], server: 1 }),
            })
            const data = await res.json().catch(() => null)
            const first = data?.results?.[0]
            if (!res.ok || !first) {
                setError(data?.error || 'Could not check this number. Please try again.')
                return
            }
            setResult({ number: first.normalized || first.input || number, status: first.status, reason: first.reason })
        } catch {
            setError('Network error. Please try again.')
        } finally {
            setIsChecking(false)
        }
    }

    const meta = result ? RESULT_META[result.status] : null
    const ResultIcon = meta?.icon

    return (
        <div
            className={cn(
                'w-full max-w-3xl mx-auto rounded-3xl border border-amber-200 dark:border-amber-900/40 bg-gradient-to-br from-amber-50 to-orange-50/60 dark:from-amber-950/30 dark:to-[#1A1A1A] p-4 sm:p-5 shadow-sm',
                className
            )}
        >
            <div className="flex items-start gap-3">
                <div className="bg-amber-100 dark:bg-amber-900/40 p-2 rounded-xl shrink-0">
                    <ShieldCheck className="w-5 h-5 text-amber-600 dark:text-amber-500" />
                </div>
                <div className="min-w-0">
                    <h2 className="text-base font-bold leading-tight">Verify your number first</h2>
                    <p className="text-sm text-muted-foreground mt-0.5">
                        Only verified MTN numbers can receive data. Check yours before you pay.
                    </p>
                </div>
            </div>

            <form
                className="flex gap-2 mt-4"
                onSubmit={(e) => {
                    e.preventDefault()
                    verify()
                }}
            >
                <Input
                    type="tel"
                    inputMode="tel"
                    value={phone}
                    onChange={(e) => {
                        setPhone(e.target.value)
                        if (result || error) {
                            setResult(null)
                            setError(null)
                        }
                    }}
                    placeholder="e.g. 0241000001"
                    className="h-12 flex-1 min-w-0 rounded-xl bg-white dark:bg-zinc-900 border-amber-200 dark:border-amber-900/40 text-base"
                    disabled={isChecking}
                />
                <button
                    type="submit"
                    disabled={isChecking || !phone.trim()}
                    className="h-12 px-5 rounded-xl bg-amber-500 hover:bg-amber-600 text-white font-bold flex items-center gap-1.5 shrink-0 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                >
                    {isChecking ? (
                        <><Loader2 className="w-4 h-4 animate-spin" />Checking</>
                    ) : (
                        <>Verify<ArrowRight className="w-4 h-4" /></>
                    )}
                </button>
            </form>

            {meta && ResultIcon && result && (
                <div className={cn('mt-3 flex items-start gap-2 rounded-xl border p-3', meta.className)}>
                    <ResultIcon className="w-5 h-5 shrink-0 mt-0.5" />
                    <div className="min-w-0 text-sm">
                        <p className="font-bold">
                            <span className="font-mono">{result.number}</span> · {meta.title}
                        </p>
                        <p className="mt-0.5 opacity-90">{result.reason || meta.detail}</p>
                    </div>
                </div>
            )}

            {error && (
                <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>
            )}

            <Link
                href="/dashboard/mtn-registration"
                className="inline-block mt-3 text-sm font-semibold text-amber-700 dark:text-amber-500 hover:underline"
            >
                Have several numbers? Paste many or upload a file
            </Link>
        </div>
    )
}
