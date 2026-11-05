'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent } from '@/components/ui/card'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Loader2, AlertCircle, Phone, ArrowRight, CheckCircle2, ShieldCheck, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { BackgroundBubbles } from '@/components/background-bubbles'
import { supabase } from '@/lib/supabase'

const RESEND_COOLDOWN = 60

function maskPhone(phone: string): string {
    if (!phone || phone.length < 6) return phone
    return phone.slice(0, 3) + 'X'.repeat(phone.length - 6) + phone.slice(-3)
}

export default function VerifyPhonePage() {
    const [step, setStep] = useState<'enter-phone' | 'enter-otp'>('enter-phone')
    const [phoneNumber, setPhoneNumber] = useState('')
    const [otp, setOtp] = useState('')
    const [isSubmitting, setIsSubmitting] = useState(false)
    const [isSending, setIsSending] = useState(false)
    const [error, setError] = useState('')
    const [cooldown, setCooldown] = useState(0)
    const [isGoogleUser, setIsGoogleUser] = useState(false)
    const router = useRouter()

    // Detect session on mount — works even before auth context catches up
    useEffect(() => {
        supabase.auth.getSession().then(({ data: { session } }) => {
            if (session?.user) {
                const provider = session.user.app_metadata?.provider
                setIsGoogleUser(provider === 'google')
            }
        }).catch(() => {
            // Fail silently — form still shows, API handles auth
        })
    }, [])

    // Cooldown countdown
    useEffect(() => {
        if (cooldown <= 0) return
        const timer = setTimeout(() => setCooldown(c => c - 1), 1000)
        return () => clearTimeout(timer)
    }, [cooldown])

    const handleSendOtp = async (e: React.FormEvent) => {
        e.preventDefault()
        const clean = phoneNumber.trim()
        if (!clean) {
            setError('Please enter your phone number')
            return
        }
        const digits = clean.replace(/\D/g, '')
        if (digits.length < 9 || digits.length > 12) {
            setError('Please enter a valid Ghana phone number (e.g. 0241234567)')
            return
        }

        setIsSending(true)
        setError('')

        try {
            const res = await fetch('/api/auth/verify-phone/send-otp', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ phone_number: clean }),
            })

            if (res.status === 401) {
                // Session cookie lag — user is authenticated, send them straight to dashboard
                window.location.href = '/dashboard'
                return
            }

            if (res.status === 429) {
                const retryAfter = parseInt(res.headers.get('Retry-After') || '900')
                setError(`Too many requests. Please wait ${Math.ceil(retryAfter / 60)} minutes.`)
                return
            }

            const data = await res.json()

            if (!res.ok) {
                setError(data.error || 'Failed. Please try again.')
                return
            }

            if (data.otpBypassed) {
                window.location.href = '/dashboard'
                return
            }

            toast.success('Verification code sent!')
            setCooldown(RESEND_COOLDOWN)
            setStep('enter-otp')
        } catch {
            setError('Connection error. Please try again.')
        } finally {
            setIsSending(false)
        }
    }

    const handleResend = async () => {
        setIsSending(true)
        setError('')
        try {
            const res = await fetch('/api/auth/verify-phone/send-otp', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ phone_number: phoneNumber }),
            })
            const data = await res.json()
            if (!res.ok) {
                setError(data.error || 'Failed to resend.')
                return
            }
            toast.success('Code resent!')
            setCooldown(RESEND_COOLDOWN)
        } catch {
            setError('Connection error. Please try again.')
        } finally {
            setIsSending(false)
        }
    }

    const handleVerify = async (e: React.FormEvent) => {
        e.preventDefault()
        if (otp.length !== 6) {
            setError('Please enter the 6-digit code')
            return
        }

        setIsSubmitting(true)
        setError('')

        try {
            const res = await fetch('/api/auth/verify-phone/confirm-otp', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ otp }),
            })

            const data = await res.json()

            if (res.status === 410) {
                setError('Code has expired. Please request a new one.')
                setStep('enter-phone')
                return
            }

            if (!res.ok) {
                setError(data.error || 'Incorrect code. Please try again.')
                return
            }

            toast.success('Phone verified! Welcome 🎉')
            window.location.href = '/dashboard'
        } catch {
            setError('An error occurred. Please try again.')
        } finally {
            setIsSubmitting(false)
        }
    }

    return (
        <div className="relative min-h-screen w-full flex flex-col items-center justify-center px-4 py-12 overflow-y-auto">
            <BackgroundBubbles scrollable />

            <div className="w-full max-w-[420px] relative z-10 flex flex-col items-center animate-slow-fade">
                {/* Logo */}
                <div className="text-center mb-10">
                    <Link href="/" className="inline-flex flex-col items-center group">
                        <div className="relative w-20 h-20 mb-6">
                            <div className="relative w-full h-full rounded-3xl overflow-hidden bg-white shadow-[0_10px_40px_-10px_rgba(212,175,55,0.35)]">
                                <Image src="/arhms-logo.png" alt="ARHMS TECHNOLOGIES" fill className="object-contain" priority />
                            </div>
                        </div>
                        <h1 className="text-3xl font-black text-foreground tracking-tighter uppercase">
                            ARHMS <span className="text-blue-600">TECHNOLOGIES</span>
                        </h1>
                        <p className="text-sm font-bold text-muted-foreground tracking-widest uppercase mt-2 opacity-70">
                            Enter Your Phone Number
                        </p>
                    </Link>
                </div>

                <Card className="w-full card-premium border-border/50 bg-card/70 backdrop-blur-xl shadow-premium overflow-hidden">
                    <CardContent className="p-8">

                        {/* Step indicators — only for non-Google (2-step OTP flow) */}
                        {!isGoogleUser && (
                            <div className="flex items-center gap-3 mb-8">
                                <div className={`flex items-center justify-center w-8 h-8 rounded-full text-xs font-black transition-all ${step === 'enter-phone' ? 'bg-primary text-primary-foreground' : 'bg-green-500 text-white'}`}>
                                    {step === 'enter-otp' ? <CheckCircle2 className="w-4 h-4" /> : '1'}
                                </div>
                                <div className="flex-1 h-0.5 bg-border rounded-full overflow-hidden">
                                    <div className={`h-full bg-primary transition-all duration-500 ${step === 'enter-otp' ? 'w-full' : 'w-0'}`} />
                                </div>
                                <div className={`flex items-center justify-center w-8 h-8 rounded-full text-xs font-black transition-all ${step === 'enter-otp' ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`}>
                                    2
                                </div>
                            </div>
                        )}

                        {/* ── STEP 1: Enter Phone ── */}
                        {step === 'enter-phone' && (
                            <>
                                <div className="flex items-center gap-3 mb-6 p-4 bg-blue-500/10 border border-blue-500/20 rounded-2xl">
                                    <Phone className="w-5 h-5 text-blue-500 shrink-0" />
                                    <p className="text-xs font-bold text-blue-600 dark:text-blue-400">
                                        Enter your phone number to continue to your dashboard
                                    </p>
                                </div>

                                <form onSubmit={handleSendOtp} className="space-y-5">
                                    {error && (
                                        <Alert variant="destructive" className="bg-destructive/10 border-destructive/20 text-destructive rounded-xl">
                                            <AlertCircle className="h-4 w-4" />
                                            <AlertDescription className="text-xs font-bold uppercase tracking-tight">{error}</AlertDescription>
                                        </Alert>
                                    )}

                                    <div className="space-y-2">
                                        <Label htmlFor="phoneNumber" className="text-xs font-black uppercase tracking-widest text-muted-foreground ml-1">
                                            Phone Number
                                        </Label>
                                        <div className="relative">
                                            <Phone className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                                            <Input
                                                id="phoneNumber"
                                                type="tel"
                                                placeholder="0241234567"
                                                value={phoneNumber}
                                                onChange={e => { setPhoneNumber(e.target.value); if (error) setError('') }}
                                                required
                                                className="h-14 pl-12 bg-background/50 border-border/50 focus:border-primary/50 focus:ring-primary/20 rounded-2xl text-base font-medium"
                                            />
                                        </div>
                                    </div>

                                    <Button
                                        type="submit"
                                        disabled={isSending}
                                        className="w-full h-14 text-base font-black uppercase tracking-[0.2em] bg-primary hover:bg-primary/90 text-primary-foreground shadow-lg shadow-primary/20 rounded-2xl transition-all hover:scale-[1.02] active:scale-95 disabled:opacity-50"
                                    >
                                        {isSending ? <Loader2 className="w-6 h-6 animate-spin" /> : (
                                            <span className="flex items-center gap-2">
                                                Continue
                                                <ArrowRight className="w-5 h-5" />
                                            </span>
                                        )}
                                    </Button>
                                </form>
                            </>
                        )}

                        {/* ── STEP 2: Enter OTP ── */}
                        {step === 'enter-otp' && (
                            <>
                                <div className="flex items-center gap-3 mb-6 p-4 bg-green-500/10 border border-green-500/20 rounded-2xl">
                                    <ShieldCheck className="w-5 h-5 text-green-500 shrink-0" />
                                    <p className="text-xs font-bold text-green-600 dark:text-green-400">
                                        Code sent to <span className="font-black">{maskPhone(phoneNumber)}</span>
                                    </p>
                                </div>

                                <form onSubmit={handleVerify} className="space-y-5">
                                    {error && (
                                        <Alert variant="destructive" className="bg-destructive/10 border-destructive/20 text-destructive rounded-xl">
                                            <AlertCircle className="h-4 w-4" />
                                            <AlertDescription className="text-xs font-bold uppercase tracking-tight">{error}</AlertDescription>
                                        </Alert>
                                    )}

                                    <div className="space-y-2">
                                        <Label htmlFor="otp" className="text-xs font-black uppercase tracking-widest text-muted-foreground ml-1">
                                            6-Digit Code
                                        </Label>
                                        <Input
                                            id="otp"
                                            type="text"
                                            inputMode="numeric"
                                            maxLength={6}
                                            placeholder="••••••"
                                            value={otp}
                                            onChange={e => { setOtp(e.target.value.replace(/\D/g, '')); if (error) setError('') }}
                                            required
                                            className="h-16 text-center text-2xl font-black tracking-[0.5em] bg-background/50 border-border/50 focus:border-primary/50 focus:ring-primary/20 rounded-2xl"
                                        />
                                    </div>

                                    <Button
                                        type="submit"
                                        disabled={isSubmitting || otp.length !== 6}
                                        className="w-full h-14 text-base font-black uppercase tracking-[0.2em] bg-primary hover:bg-primary/90 text-primary-foreground shadow-lg shadow-primary/20 rounded-2xl transition-all hover:scale-[1.02] active:scale-95 disabled:opacity-50"
                                    >
                                        {isSubmitting ? <Loader2 className="w-6 h-6 animate-spin" /> : 'Verify & Continue'}
                                    </Button>

                                    <div className="flex items-center justify-between pt-2">
                                        <button
                                            type="button"
                                            onClick={() => { setStep('enter-phone'); setOtp(''); setError('') }}
                                            className="text-[10px] font-black uppercase tracking-widest text-muted-foreground hover:text-foreground transition-colors"
                                        >
                                            ← Change Number
                                        </button>
                                        <button
                                            type="button"
                                            disabled={cooldown > 0 || isSending}
                                            onClick={handleResend}
                                            className="flex items-center gap-1 text-[10px] font-black uppercase tracking-widest text-primary hover:text-primary/80 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                                        >
                                            <RefreshCw className="w-3 h-3" />
                                            {cooldown > 0 ? `Resend in ${cooldown}s` : 'Resend Code'}
                                        </button>
                                    </div>
                                </form>
                            </>
                        )}

                        <p className="text-[9px] text-center text-muted-foreground font-bold tracking-widest uppercase mt-8 opacity-40">
                            By proceeding, you agree to our <Link href="/terms" className="text-foreground hover:text-primary transition-colors">Terms</Link> & <Link href="/privacy" className="text-foreground hover:text-primary transition-colors">Policy</Link>
                        </p>
                    </CardContent>
                </Card>
            </div>
        </div>
    )
}
