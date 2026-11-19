'use client'

/**
 * Shown when the ARHMS AI monthly allowance is used up: pay the reset (GHS 5 user /
 * GHS 7 shop, admin-set) from the wallet, or top the wallet up with Mobile Money.
 *
 * MoMo path (owner's decision 2026-11-19): "Pay with MoMo" saves a pending reset
 * (idempotency key) and opens the normal wallet top-up for the exact amount. While a
 * pending reset exists, usePendingReset() polls the balance and charges the reset
 * with THAT key once the wallet is credited, so a retry can never charge twice.
 * If the user never comes back, the money simply stays in their wallet.
 */
import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, Smartphone, Sparkles, Wallet } from 'lucide-react'
import { toast } from 'sonner'

type Scope = 'dashboard' | 'shop'

interface Terms {
    price: number
    questions: number
    balance: number
    topUpAmount: number
}

const PENDING_TTL_MS = 30 * 60 * 1000
const pendingKey = (scope: Scope) => `arhms_ai_reset_pending_${scope}`

function readPending(scope: Scope): { key: string; at: number; shopId?: string } | null {
    try {
        const raw = localStorage.getItem(pendingKey(scope))
        if (!raw) return null
        const p = JSON.parse(raw)
        if (!p?.key || Date.now() - Number(p.at) > PENDING_TTL_MS) {
            localStorage.removeItem(pendingKey(scope))
            return null
        }
        return p
    } catch {
        return null
    }
}

function writePending(scope: Scope, value: { key: string; at: number; shopId?: string } | null) {
    try {
        if (value) localStorage.setItem(pendingKey(scope), JSON.stringify(value))
        else localStorage.removeItem(pendingKey(scope))
    } catch {
        /* private mode: the wallet button still works */
    }
}

const newKey = () =>
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`

async function fetchTerms(scope: Scope, shopId?: string): Promise<Terms | null> {
    const qs = new URLSearchParams({ scope, ...(shopId ? { shopId } : {}) })
    const res = await fetch(`/api/ai-assistant/reset?${qs}`, { cache: 'no-store' })
    return res.ok ? res.json() : null
}

async function postReset(scope: Scope, key: string, shopId?: string) {
    const res = await fetch('/api/ai-assistant/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope, shopId, idempotencyKey: key }),
    })
    const data = await res.json().catch(() => ({}))
    return { ok: res.ok && data.ok === true, status: res.status, data }
}

/**
 * Finishes a MoMo-funded reset once the top-up lands. Mount it wherever the
 * allowance is shown (the chat widget is on every dashboard page, including Wallet).
 */
export function usePendingReset(scope: Scope, active: boolean, onDone: (questionsAdded: number) => void, shopId?: string) {
    useEffect(() => {
        if (!active) return
        let stopped = false
        const tick = async () => {
            const pending = readPending(scope)
            if (!pending || stopped) return
            const terms = await fetchTerms(scope, pending.shopId ?? shopId)
            if (!terms || terms.balance < terms.price || stopped) return
            const r = await postReset(scope, pending.key, pending.shopId ?? shopId)
            if (r.ok) {
                writePending(scope, null)
                toast.success(`ARHMS AI: ${r.data.questionsAdded} more questions added`)
                onDone(r.data.questionsAdded)
            } else if (r.status !== 402 && r.status !== 409) {
                writePending(scope, null)
            }
        }
        tick()
        const id = setInterval(tick, 15_000)
        return () => {
            stopped = true
            clearInterval(id)
        }
    }, [scope, active, onDone, shopId])
}

export function ResetPanel({
    scope,
    shopId,
    usedLabel,
    onReset,
    onNavigate,
}: {
    scope: Scope
    shopId?: string
    /** e.g. "You've used your 100 questions this month." */
    usedLabel: string
    onReset: (questionsAdded: number) => void
    onNavigate?: () => void
}) {
    const router = useRouter()
    const [terms, setTerms] = useState<Terms | null>(null)
    const [paying, setPaying] = useState(false)

    const load = useCallback(async () => {
        setTerms(await fetchTerms(scope, shopId))
    }, [scope, shopId])

    useEffect(() => { load() }, [load])

    const payFromWallet = async () => {
        if (!terms) return
        setPaying(true)
        try {
            const key = readPending(scope)?.key || newKey()
            const r = await postReset(scope, key, shopId)
            if (r.ok) {
                writePending(scope, null)
                toast.success(`${r.data.questionsAdded} more questions added`)
                onReset(r.data.questionsAdded)
            } else {
                toast.error(r.data?.error || 'Payment failed. You were not charged.')
                load()
            }
        } finally {
            setPaying(false)
        }
    }

    const payWithMomo = () => {
        if (!terms) return
        writePending(scope, { key: newKey(), at: Date.now(), ...(shopId ? { shopId } : {}) })
        onNavigate?.()
        router.push(`/dashboard/wallet?amount=${terms.topUpAmount.toFixed(2)}&for=ai`)
    }

    if (!terms) {
        return (
            <div className="flex justify-center py-3">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
        )
    }

    const canPayFromWallet = terms.balance >= terms.price
    return (
        <div className="space-y-3 rounded-2xl border border-primary/30 bg-primary/5 p-3">
            <div className="flex gap-2.5">
                <Sparkles className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
                <div className="text-sm">
                    <p className="font-semibold">{usedLabel}</p>
                    <p className="text-muted-foreground">
                        Get {terms.questions} more questions for <span className="font-semibold text-foreground">GHS {terms.price.toFixed(2)}</span>, valid until the end of this month.
                    </p>
                </div>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
                <button
                    type="button"
                    onClick={payFromWallet}
                    disabled={!canPayFromWallet || paying}
                    className="flex items-center justify-center gap-2 rounded-xl bg-primary px-3 py-2.5 text-sm font-semibold text-primary-foreground transition disabled:opacity-40"
                >
                    {paying ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wallet className="h-4 w-4" />}
                    Pay from wallet
                </button>
                <button
                    type="button"
                    onClick={payWithMomo}
                    disabled={paying}
                    className="flex items-center justify-center gap-2 rounded-xl border border-border bg-background px-3 py-2.5 text-sm font-semibold transition hover:border-primary disabled:opacity-40"
                >
                    <Smartphone className="h-4 w-4" /> Pay with MoMo
                </button>
            </div>
            <p className="text-center text-[11px] text-muted-foreground">
                Wallet balance: GHS {terms.balance.toFixed(2)}
                {!canPayFromWallet && ` · MoMo tops up GHS ${terms.topUpAmount.toFixed(2)}, then your questions reset automatically`}
            </p>
        </div>
    )
}
