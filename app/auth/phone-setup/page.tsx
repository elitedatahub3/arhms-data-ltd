'use client'

import { useState } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent } from '@/components/ui/card'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Loader2, AlertCircle, Phone, ArrowRight } from 'lucide-react'
import { BackgroundBubbles } from '@/components/background-bubbles'

export default function PhoneSetupPage() {
    const [phoneNumber, setPhoneNumber] = useState('')
    const [isSubmitting, setIsSubmitting] = useState(false)
    const [error, setError] = useState('')

    const handleContinue = async (e: React.FormEvent) => {
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

        setIsSubmitting(true)
        setError('')

        try {
            const res = await fetch('/api/auth/verify-phone/send-otp', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ phone_number: clean }),
            })

            if (res.status === 401) {
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
                setError(data.error || 'Failed to save phone number. Please try again.')
                return
            }

            // Google users always get otpBypassed — go straight to dashboard
            window.location.href = '/dashboard'
        } catch {
            setError('Connection error. Please try again.')
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
                            One Last Step
                        </p>
                    </Link>
                </div>

                <Card className="w-full card-premium border-border/50 bg-card/70 backdrop-blur-xl shadow-premium overflow-hidden">
                    <CardContent className="p-8">

                        <div className="flex items-center gap-3 mb-6 p-4 bg-blue-500/10 border border-blue-500/20 rounded-2xl">
                            <Phone className="w-5 h-5 text-blue-500 shrink-0" />
                            <p className="text-xs font-bold text-blue-600 dark:text-blue-400">
                                Your Google account is connected. Add your phone number to complete setup.
                            </p>
                        </div>

                        <form onSubmit={handleContinue} className="space-y-5">
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
                                disabled={isSubmitting}
                                className="w-full h-14 text-base font-black uppercase tracking-[0.2em] bg-primary hover:bg-primary/90 text-primary-foreground shadow-lg shadow-primary/20 rounded-2xl transition-all hover:scale-[1.02] active:scale-95 disabled:opacity-50"
                            >
                                {isSubmitting ? <Loader2 className="w-6 h-6 animate-spin" /> : (
                                    <span className="flex items-center gap-2">
                                        Continue
                                        <ArrowRight className="w-5 h-5" />
                                    </span>
                                )}
                            </Button>
                        </form>

                        <p className="text-[9px] text-center text-muted-foreground font-bold tracking-widest uppercase mt-8 opacity-40">
                            By proceeding, you agree to our <Link href="/terms" className="text-foreground hover:text-primary transition-colors">Terms</Link> & <Link href="/privacy" className="text-foreground hover:text-primary transition-colors">Policy</Link>
                        </p>
                    </CardContent>
                </Card>
            </div>
        </div>
    )
}
