'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/contexts/auth-context'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent } from '@/components/ui/card'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Eye, EyeOff, Loader2, LogIn, Mail, Lock, Store, ExternalLink, AlertCircle, ShoppingBag } from 'lucide-react'
import { toast } from 'sonner'
import { BackgroundBubbles } from '@/components/background-bubbles'
import { GoogleSignInButton } from '@/components/google-sign-in-button'
import { showWelcomeToast } from '@/components/welcome-toast'

export default function LoginPage() {
    const [email, setEmail] = useState('')
    const [password, setPassword] = useState('')
    const [showPassword, setShowPassword] = useState(false)
    const [isLoading, setIsLoading] = useState(false)
    const [error, setError] = useState('')
    const [lockoutMinutes, setLockoutMinutes] = useState<number | null>(null)
    const { signIn } = useAuth()
    const router = useRouter()
    const [guestUrl, setGuestUrl] = useState('https://arhmsgh.com/shop/demo')

    useEffect(() => {
        fetch('/api/public/config').then(response => response.ok ? response.json() : null).then(data => {
            if (data?.guestStorefrontUrl) {
                setGuestUrl(data.guestStorefrontUrl)
            }
        }).catch(console.error)
    }, [])

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault()
        setError('')
        setIsLoading(true)

        try {
            const { error } = await signIn(email, password)

            if (error) {
                if (error.message.startsWith('TOO_MANY_ATTEMPTS:')) {
                    const minutes = parseInt(error.message.split(':')[1])
                    setLockoutMinutes(minutes)
                    setError(`Too many login attempts. Please try again in ${minutes} minute${minutes !== 1 ? 's' : ''}.`)
                } else {
                    setLockoutMinutes(null)
                    setError(error.message)
                }
                setIsLoading(false)
                return
            }

            showWelcomeToast()
            // Keep the spinner up: the browser is still loading /dashboard.
            // Clearing it here would snap the button back to "Login" mid-redirect
            // and make a successful sign-in look like it did nothing.
            window.location.href = '/dashboard'
        } catch (err) {
            setError('An unexpected error occurred')
            setIsLoading(false)
        }
    }

    return (
        <div className="relative min-h-screen w-full flex flex-col items-center justify-center px-4 py-12 overflow-y-auto">
            <BackgroundBubbles scrollable />

            <div className="w-full max-w-[420px] relative z-10 flex flex-col items-center animate-slow-fade">
                {/* Logo & Branding */}
                <div className="text-center mb-10">
                    <Link href="/" className="inline-flex flex-col items-center group">
                        <div className="relative w-20 h-20 mb-6">
                            <div className="relative w-full h-full rounded-3xl overflow-hidden bg-white shadow-[0_10px_40px_-10px_rgba(212,175,55,0.35)]">
                                <Image
                                    src="/arhms-logo.png"
                                    alt="ARHMS TECHNOLOGIES"
                                    fill
                                    className="object-contain"
                                    priority
                                />
                            </div>
                        </div>
                        <h1 className="text-3xl font-black text-foreground tracking-tighter uppercase">
                            ARHMS <span className="text-blue-600">TECHNOLOGIES</span>
                        </h1>
                        <p className="text-sm font-bold text-muted-foreground tracking-widest uppercase mt-2 opacity-70">
                            Login to Continue
                        </p>
                    </Link>
                </div>

                <Card className="w-full card-premium border-border/50 bg-card/70 backdrop-blur-xl shadow-premium overflow-hidden">
                    <CardContent className="p-8">
                        <div className="mb-6 space-y-6">
                            <GoogleSignInButton label="Continue with Google" />
                            
                            <div className="relative">
                                <div className="absolute inset-0 flex items-center">
                                    <div className="w-full border-t border-border/50"></div>
                                </div>
                                <div className="relative flex justify-center text-[10px] uppercase tracking-[0.3em] font-black">
                                    <span className="bg-card px-4 text-muted-foreground/50">Or</span>
                                </div>
                            </div>
                        </div>

                        <form onSubmit={handleSubmit} className="space-y-6">
                            {error && (
                                <Alert variant="destructive" className="bg-destructive/10 border-destructive/20 text-destructive rounded-xl">
                                    <AlertCircle className="h-4 w-4" />
                                    <AlertDescription className="text-xs font-bold uppercase tracking-tight">{error}</AlertDescription>
                                </Alert>
                            )}

                            <div className="space-y-2">
                                <Label htmlFor="email" className="text-xs font-black uppercase tracking-widest text-muted-foreground ml-1">Email Address</Label>
                                <div className="relative">
                                    <Mail className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                                    <Input
                                        id="email"
                                        type="email"
                                        placeholder="you@arhmsgh.com"
                                        value={email}
                                        onChange={(e) => setEmail(e.target.value)}
                                        required
                                        className="h-14 pl-12 bg-background/50 border-border/50 focus:border-primary/50 focus:ring-primary/20 rounded-2xl text-base font-medium"
                                    />
                                </div>
                            </div>

                            <div className="space-y-2">
                                <Label htmlFor="password" className="text-xs font-black uppercase tracking-widest text-muted-foreground ml-1">Password</Label>
                                <div className="relative">
                                    <Lock className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                                    <Input
                                        id="password"
                                        type={showPassword ? 'text' : 'password'}
                                        placeholder="••••••••"
                                        value={password}
                                        onChange={(e) => setPassword(e.target.value)}
                                        required
                                        className="h-14 pl-12 pr-12 bg-background/50 border-border/50 focus:border-primary/50 focus:ring-primary/20 rounded-2xl text-base font-medium tracking-widest"
                                    />
                                    <button
                                        type="button"
                                        onClick={() => setShowPassword(!showPassword)}
                                        className="absolute right-4 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                                    >
                                        {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                                    </button>
                                </div>
                                <div className="flex justify-end px-1">
                                    <Link href="/auth/reset-password" title="reset-password-link" className="text-[10px] font-black uppercase tracking-widest text-primary hover:text-primary/80 transition-colors">
                                        Forgot Password?
                                    </Link>
                                </div>
                            </div>

                            <Button
                                type="submit"
                                disabled={isLoading || lockoutMinutes !== null}
                                className="w-full h-14 text-base font-black uppercase tracking-[0.2em] bg-primary hover:bg-primary/90 text-primary-foreground shadow-lg shadow-primary/20 rounded-2xl transition-all hover:scale-[1.02] active:scale-95 disabled:opacity-50"
                            >
                                {lockoutMinutes !== null ? (
                                    `Locked: ${lockoutMinutes}m`
                                ) : isLoading ? (
                                    <Loader2 className="w-6 h-6 animate-spin" />
                                ) : (
                                    "Login"
                                )}
                            </Button>
                        </form>

                        <div className="grid gap-4 mt-8">

                            <Button
                                asChild
                                variant="outline"
                                className="h-14 rounded-2xl border-border/50 hover:bg-secondary/50 font-bold tracking-tight text-foreground transition-all"
                            >
                                <Link href="/auth/signup">
                                    Create New Account
                                </Link>
                            </Button>

                            <Button
                                asChild
                                variant="outline"
                                className="h-14 rounded-2xl border-primary/20 bg-primary/5 hover:bg-primary/10 text-primary font-black uppercase tracking-widest text-xs transition-all group"
                            >
                                <a href={guestUrl}>
                                    <Store className="w-4 h-4 mr-2" />
                                    Guest Storefront
                                    <ExternalLink className="w-3 h-3 ml-2 opacity-50 group-hover:opacity-100 transition-opacity" />
                                </a>
                            </Button>
                        </div>

                        <p className="text-[9px] text-center text-muted-foreground font-bold tracking-widest uppercase mt-8 opacity-40">
                            By proceeding, you agree to our <Link href="/terms" className="text-foreground hover:text-primary transition-colors">Terms</Link> & <Link href="/privacy" className="text-foreground hover:text-primary transition-colors">Policy</Link>
                        </p>
                    </CardContent>
                </Card>
            </div>
        </div>
    )
}
