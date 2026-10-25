'use client'

import { useState } from 'react'
import { ShieldCheck, ChevronDown, Loader2, CheckCircle2, AlertCircle } from 'lucide-react'
import { cn } from '@/lib/utils'

type Server = 1 | 2

type Result = { server: Server; number: string; registered: boolean }

/**
 * "Check your MTN number" panel on the storefront data tab. Lets a guest confirm the
 * number they are buying for can receive data BEFORE they pay, instead of being
 * refused at checkout. Backed by /api/shop/mtn-check.
 */
export default function StorefrontMtnCheck({ shopSlug, className }: { shopSlug: string; className?: string }) {
    const [open, setOpen] = useState(false)
    const [server, setServer] = useState<Server>(1)
    const [number, setNumber] = useState('')
    const [loading, setLoading] = useState(false)
    const [result, setResult] = useState<Result | null>(null)
    const [error, setError] = useState<string | null>(null)

    const check = async () => {
        if (!number.trim() || loading) return
        setLoading(true)
        setResult(null)
        setError(null)
        try {
            const res = await fetch('/api/shop/mtn-check', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ shopSlug, number: number.trim(), server }),
            })
            const data = await res.json().catch(() => ({}))
            if (!res.ok) {
                setError(data.error || 'Could not check right now. Please try again.')
            } else {
                setResult(data)
            }
        } catch {
            setError('Network error. Please try again.')
        } finally {
            setLoading(false)
        }
    }

    return (
        <div className={cn(
            "rounded-2xl border border-gray-200 dark:border-gray-800/60 bg-white dark:bg-[#0e1423] shadow-sm dark:shadow-none overflow-hidden",
            className
        )}>
            <button
                type="button"
                onClick={() => setOpen(o => !o)}
                aria-expanded={open}
                className="w-full flex items-center gap-3 p-4 text-left"
            >
                <div className="w-11 h-11 rounded-xl bg-amber-100 dark:bg-amber-500/15 flex items-center justify-center shrink-0">
                    <ShieldCheck className="w-5 h-5 text-amber-600 dark:text-amber-500" />
                </div>
                <div className="flex-1 min-w-0">
                    <p className="text-[15px] font-bold text-gray-900 dark:text-white leading-tight">Check your MTN number</p>
                    <p className="text-[13px] text-gray-500 dark:text-gray-400 mt-0.5">Make sure it can receive data before you pay</p>
                </div>
                <ChevronDown className={cn("w-5 h-5 text-gray-400 shrink-0 transition-transform", open && "rotate-180")} />
            </button>

            {open && (
                <div className="px-4 pb-4 space-y-3">
                    <div className="grid grid-cols-2 gap-1 p-1 rounded-xl bg-gray-100 dark:bg-gray-800/50">
                        {([1, 2] as Server[]).map(s => (
                            <button
                                key={s}
                                type="button"
                                onClick={() => { setServer(s); setResult(null); setError(null) }}
                                className={cn(
                                    "py-2.5 rounded-lg text-sm font-bold transition-colors",
                                    server === s
                                        ? "bg-white dark:bg-[#05080f] text-gray-900 dark:text-white shadow-sm"
                                        : "text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
                                )}
                            >
                                Server {s}
                            </button>
                        ))}
                    </div>

                    <form
                        onSubmit={(e) => { e.preventDefault(); check() }}
                        className="flex gap-2"
                    >
                        <input
                            type="tel"
                            inputMode="tel"
                            value={number}
                            onChange={(e) => { setNumber(e.target.value); setResult(null); setError(null) }}
                            placeholder="e.g. 0241000001"
                            className="flex-1 min-w-0 px-4 py-3 rounded-xl bg-gray-50 dark:bg-[#05080f] border border-gray-200 dark:border-gray-800 text-sm font-medium text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:border-gray-400 dark:focus:border-gray-600"
                        />
                        <button
                            type="submit"
                            disabled={loading || !number.trim()}
                            className="px-5 rounded-xl bg-blue-500 hover:bg-blue-600 text-white text-sm font-bold disabled:opacity-60 flex items-center justify-center min-w-[84px]"
                        >
                            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Check'}
                        </button>
                    </form>

                    {result && (
                        result.registered ? (
                            <div className="flex items-start gap-2 p-3 rounded-xl bg-emerald-50 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 text-sm">
                                <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
                                <span><strong>{result.number}</strong> is registered and can receive data.</span>
                            </div>
                        ) : (
                            <div className="flex items-start gap-2 p-3 rounded-xl bg-amber-50 dark:bg-amber-500/10 text-amber-700 dark:text-amber-400 text-sm">
                                <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                                <span>
                                    <strong>{result.number}</strong> is not registered for data yet.{' '}
                                    {result.server === 1
                                        ? 'We have sent it to MTN for registration — this can take up to 2 weeks. Please don\'t buy data for it until then.'
                                        : 'Server 2 only checks. Try Server 1 to send it to MTN for registration.'}
                                </span>
                            </div>
                        )
                    )}

                    {error && (
                        <div className="flex items-start gap-2 p-3 rounded-xl bg-red-50 dark:bg-red-500/10 text-red-600 dark:text-red-400 text-sm">
                            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                            <span>{error}</span>
                        </div>
                    )}
                </div>
            )}
        </div>
    )
}
