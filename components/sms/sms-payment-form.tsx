'use client'

/**
 * Mobile money checkout for Customer SMS — the unlock and credit bundles.
 *
 * The same prompt → (optional OTP) → poll flow as the USSD activation panel,
 * lifted into one component because two different purchases need it. The
 * gateway confirms on a webhook, so a successful initiate is only the start:
 * `isSettled` is polled until the thing that was bought actually exists.
 */

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'

// Values must match the gateway channel maps, which key AirtelTigo as 'AT'.
const NETWORKS = [
    { value: 'MTN', label: 'MTN' },
    { value: 'Telecel', label: 'Telecel' },
    { value: 'AT', label: 'AirtelTigo' },
]

export interface SmsPaymentFormProps {
    /** POST target: /api/sms/unlock or /api/sms/credits/purchase. */
    endpoint: string
    /** Merged into the initiate body — e.g. { bundleId }. */
    extraBody?: Record<string, any>
    amount: number
    payLabel: string
    /** Resolves true once the purchase has landed; polled every 3 seconds. */
    isSettled: () => Promise<boolean>
    onSettled: () => void
    disabled?: boolean
}

export function SmsPaymentForm({
    endpoint,
    extraBody,
    amount,
    payLabel,
    isSettled,
    onSettled,
    disabled = false,
}: SmsPaymentFormProps) {
    const [phone, setPhone] = useState('')
    const [network, setNetwork] = useState('MTN')
    const [reference, setReference] = useState<string | null>(null)
    const [otpPrompt, setOtpPrompt] = useState<string | null>(null)
    const [otp, setOtp] = useState('')
    const [submitting, setSubmitting] = useState(false)
    const [polling, setPolling] = useState(false)

    useEffect(() => {
        if (!polling) return
        let attempts = 0
        const timer = setInterval(async () => {
            attempts++
            try {
                if (await isSettled()) {
                    setPolling(false)
                    clearInterval(timer)
                    onSettled()
                    return
                }
            } catch { /* keep polling */ }

            if (attempts >= 40) {
                setPolling(false)
                clearInterval(timer)
                toast.error('Still waiting on payment confirmation. Refresh in a moment.')
            }
        }, 3000)
        return () => clearInterval(timer)
    }, [polling, isSettled, onSettled])

    const handleResponse = async (data: any) => {
        if (data.completed) {
            toast.success(data.message || 'Payment complete')
            onSettled()
            return
        }
        if (data.otpRequired) {
            setReference(data.reference)
            setOtp('')
            setOtpPrompt(data.message || 'Enter the one-time code sent to your phone.')
            return
        }
        setOtpPrompt(null)
        setReference(data.reference)
        setPolling(true)
        toast.success(data.message || 'Approve the prompt on your phone')
    }

    const pay = async () => {
        if (!phone.trim()) {
            toast.error('Enter the mobile money number to charge')
            return
        }
        setSubmitting(true)
        try {
            const res = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...extraBody, phone: phone.trim(), network }),
            })
            const data = await res.json()
            if (!res.ok || !data?.success) {
                toast.error(data?.error || 'Payment could not be started')
                return
            }
            await handleResponse(data)
        } catch {
            toast.error('Something went wrong. Please try again.')
        } finally {
            setSubmitting(false)
        }
    }

    const submitOtpCode = async () => {
        if (!otp.trim() || !reference) return
        setSubmitting(true)
        try {
            const res = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ otp: otp.trim(), reference }),
            })
            const data = await res.json()
            if (!res.ok || !data?.success) {
                toast.error(data?.error || 'That code was not accepted')
                return
            }
            await handleResponse(data)
        } catch {
            toast.error('Something went wrong. Please try again.')
        } finally {
            setSubmitting(false)
        }
    }

    return (
        <div className="space-y-4">
            <div className="space-y-2">
                <Label>Network</Label>
                <div className="flex gap-2">
                    {NETWORKS.map((n) => (
                        <button
                            key={n.value}
                            type="button"
                            onClick={() => setNetwork(n.value)}
                            disabled={polling || !!otpPrompt}
                            className={cn(
                                'flex-1 rounded-xl border-2 py-2 text-sm font-bold transition-colors',
                                network === n.value ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-950/30' : 'border-gray-200 dark:border-gray-800'
                            )}
                        >
                            {n.label}
                        </button>
                    ))}
                </div>
            </div>
            <div className="space-y-2">
                <Label>Mobile money number</Label>
                <Input
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="0XXXXXXXXX"
                    inputMode="tel"
                    disabled={polling || !!otpPrompt}
                />
                <p className="text-xs text-muted-foreground">You&apos;ll get a prompt on this number to approve the payment.</p>
            </div>

            {otpPrompt ? (
                // The charge is already open, so this replaces the pay button —
                // pressing pay again here would start a second charge.
                <div className="space-y-3 rounded-2xl border-2 border-emerald-500 bg-emerald-50 dark:bg-emerald-950/30 p-4">
                    <div className="space-y-2">
                        <Label>One-time code</Label>
                        <Input value={otp} onChange={(e) => setOtp(e.target.value)} placeholder="Enter the code" inputMode="numeric" autoFocus />
                    </div>
                    <p className="text-xs text-muted-foreground">{otpPrompt}</p>
                    <Button onClick={submitOtpCode} disabled={submitting || !otp.trim()} className="w-full h-12 rounded-xl bg-emerald-600 hover:bg-emerald-700 font-bold">
                        {submitting ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Confirming…</> : 'Confirm payment'}
                    </Button>
                </div>
            ) : (
                <Button
                    onClick={pay}
                    disabled={disabled || submitting || polling}
                    className="w-full h-12 rounded-xl bg-emerald-600 hover:bg-emerald-700 font-bold text-base"
                >
                    {submitting || polling
                        ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> {polling ? 'Waiting for payment…' : 'Processing…'}</>
                        : <>{payLabel} · GHS {Number(amount).toFixed(2)}</>}
                </Button>
            )}
        </div>
    )
}
