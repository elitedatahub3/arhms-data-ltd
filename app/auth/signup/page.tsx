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
import { Eye, EyeOff, Loader2, UserPlus, Mail, Lock, User, Phone, Store, ExternalLink, AlertCircle } from 'lucide-react'
import { toast } from 'sonner'
import { validateGhanaianPhone } from '@/lib/phone-validation'
import { BackgroundBubbles } from '@/components/background-bubbles'
import { GoogleSignInButton } from '@/components/google-sign-in-button'

export default function SignupPage() {
    const [formData, setFormData] = useState({
        firstName: '',
        lastName: '',
        email: '',
        phoneNumber: '',
        password: '',
        confirmPassword: '',
    })
    const [showPassword, setShowPassword] = useState(false)
    const [isLoading, setIsLoading] = useState(false)
    const [error, setError] = useState('')
    const [success, setSuccess] = useState(false)
    const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
    const [lockoutMinutes, setLockoutMinutes] = useState<number | null>(null)
    const { signUp } = useAuth()
    const router = useRouter()
    const [guestUrl, setGuestUrl] = useState('https://arhmsgh.com/shop/demo')

    useEffect(() => {
        fetch('/api/public/config').then(response => response.ok ? response.json() : null).then(data => {
            if (data?.guestStorefrontUrl) {
                setGuestUrl(data.guestStorefrontUrl)
            }
        }).catch(console.error)
    }, [])

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setFormData(prev => ({
            ...prev,
            [e.target.name]: e.target.value
        }))
        if (fieldErrors[e.target.name]) {
            setFieldErrors(prev => {
                const { [e.target.name]: _, ...rest } = prev
                return rest
            })
        }
    }

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault()
        setError('')

        const phoneValidation = validateGhanaianPhone(formData.phoneNumber)
        if (!phoneValidation.isValid) {
            setError(phoneValidation.error || 'Invalid phone number')
            return
        }

        if (formData.password.length < 8) {
            setError('Password must be at least 8 characters')
            return
        }

        if (formData.password !== formData.confirmPassword) {
            setError('Passwords do not match')
            return
        }

        setIsLoading(true)
        setFieldErrors({})

        try {
            const { error, data } = await signUp({
                email: formData.email,
                password: formData.password,
                firstName: formData.firstName,
                lastName: formData.lastName,
                phoneNumber: phoneValidation.normalizedNumber,
            })

            if (error) {
                if (error.details) {
                    const newErrors: Record<string, string> = {}
                    error.details.forEach((err: string) => {
                        const [field, ...msgParts] = err.split(': ')
                        if (field) newErrors[field] = msgParts.join(': ')
                    })
                    setFieldErrors(newErrors)
                    setError('Please fix the errors below.')
                } else if (error.message?.startsWith('TOO_MANY_ATTEMPTS:')) {
                    const minutes = parseInt(error.message.split(':')[1])
                    setLockoutMinutes(minutes)
                    setError(`Too many attempts. Please try again in ${minutes} minute${minutes !== 1 ? 's' : ''}.`)
                } else {
                    setLockoutMinutes(null)
                    setError(error.message)
                }
                setIsLoading(false)
                return
            }

            if (data?.session) {
                toast.success('Account created! logging in...')
                // Keep the spinner up while /dashboard loads — clearing it here
                // makes a successful sign-up look like the button did nothing.
                router.push('/dashboard')
                return
            }

            setSuccess(true)
            toast.success('Account created successfully!')
            setIsLoading(false)
        } catch (err) {
            setError('An unexpected error occurred')
            setIsLoading(false)
        }
    }

    if (success) {
        return (
            <div className="relative min-h-screen w-full flex flex-col items-center justify-center px-4 py-8 sm:py-10 overflow-y-auto">
                <BackgroundBubbles scrollable />
                <Card className="w-full max-w-[380px] sm:max-w-md border-0 bg-[#E5E7EB]/70 backdrop-blur-md relative z-10 shadow-2xl rounded-2xl">
                    <CardContent className="pt-8 text-center p-6">
                        <div className="w-16 h-16 rounded-full bg-gradient-to-br from-green-500 to-emerald-600 flex items-center justify-center mx-auto mb-4">
                            <Mail className="w-8 h-8 text-white" />
                        </div>
                        <h2 className="text-xl font-bold text-slate-900 mb-2">Check Your Email</h2>
                        <p className="text-slate-600 text-sm mb-5">
                            We&apos;ve sent a verification link to <strong className="text-slate-900">{formData.email}</strong>.
                        </p>
                        <Link href="/auth/login">
                            <Button className="w-full h-12 text-base font-bold bg-indigo-600 hover:bg-indigo-700 text-white shadow-lg rounded-xl">
                                Go to Login
                            </Button>
                        </Link>
                    </CardContent>
                </Card>
            </div>
        )
    }

    return (
        <div className="relative min-h-screen w-full flex flex-col items-center justify-center px-4 py-12 overflow-y-auto">
            <BackgroundBubbles scrollable />

            <div className="w-full max-w-[480px] relative z-10 flex flex-col items-center animate-slow-fade">
                {/* Logo & Branding */}
                <div className="text-center mb-8">
                    <Link href="/" className="inline-flex flex-col items-center group">
                        <div className="relative w-16 h-16 mb-4">
                            <div className="relative w-full h-full rounded-2xl overflow-hidden bg-white shadow-[0_10px_40px_-10px_rgba(212,175,55,0.35)]">
                                <Image
                                    src="/arhms-logo.png"
                                    alt="ARHMS TECHNOLOGIES"
                                    fill
                                    className="object-contain"
                                    priority
                                />
                            </div>
                        </div>
                        <h1 className="text-2xl font-black text-foreground tracking-tighter uppercase">
                            ARHMS <span className="text-blue-600">TECHNOLOGIES</span>
                        </h1>
                        <p className="text-[10px] font-black text-muted-foreground tracking-[0.3em] uppercase mt-1 opacity-60">
                            Create Your Account
                        </p>
                    </Link>
                </div>

                <Card className="w-full card-premium border-border/50 bg-card/70 backdrop-blur-xl shadow-premium overflow-hidden">
                    <CardContent className="p-8">
                        <div className="mb-6 space-y-6">
                            <GoogleSignInButton label="Sign up with Google" />
                            
                            <div className="relative">
                                <div className="absolute inset-0 flex items-center">
                                    <div className="w-full border-t border-border/50"></div>
                                </div>
                                <div className="relative flex justify-center text-[10px] uppercase tracking-[0.3em] font-black">
                                    <span className="bg-card px-4 text-muted-foreground/50">Or</span>
                                </div>
                            </div>
                        </div>

                        <form onSubmit={handleSubmit} className="space-y-5">
                            {error && (
                                <Alert variant="destructive" className="bg-destructive/10 border-destructive/20 text-destructive rounded-xl">
                                    <AlertCircle className="h-4 w-4" />
                                    <AlertDescription className="text-xs font-bold uppercase tracking-tight">{error}</AlertDescription>
                                </Alert>
                            )}

                            <div className="grid grid-cols-2 gap-4">
                                <div className="space-y-2">
                                    <Label htmlFor="firstName" className="text-[10px] font-black uppercase tracking-widest text-muted-foreground ml-1">First Name</Label>
                                    <div className="relative">
                                        <User className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                                        <Input
                                            id="firstName"
                                            name="firstName"
                                            placeholder="John"
                                            value={formData.firstName}
                                            onChange={handleChange}
                                            required
                                            className="h-12 pl-12 bg-background/50 border-border/50 focus:border-primary/50 rounded-2xl text-sm font-medium"
                                        />
                                    </div>
                                </div>
                                <div className="space-y-2">
                                    <Label htmlFor="lastName" className="text-[10px] font-black uppercase tracking-widest text-muted-foreground ml-1">Last Name</Label>
                                    <div className="relative">
                                        <User className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                                        <Input
                                            id="lastName"
                                            name="lastName"
                                            placeholder="Doe"
                                            value={formData.lastName}
                                            onChange={handleChange}
                                            required
                                            className="h-12 pl-12 bg-background/50 border-border/50 focus:border-primary/50 rounded-2xl text-sm font-medium"
                                        />
                                    </div>
                                </div>
                            </div>

                            <div className="space-y-2">
                                <Label htmlFor="email" className="text-[10px] font-black uppercase tracking-widest text-muted-foreground ml-1">Email Address</Label>
                                <div className="relative">
                                    <Mail className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                                    <Input
                                        id="email"
                                        name="email"
                                        type="email"
                                        placeholder="you@arhmsgh.com"
                                        value={formData.email}
                                        onChange={handleChange}
                                        required
                                        className="h-12 pl-12 bg-background/50 border-border/50 focus:border-primary/50 rounded-2xl text-sm font-medium"
                                    />
                                </div>
                            </div>

                            <div className="space-y-2">
                                <Label htmlFor="phoneNumber" className="text-[10px] font-black uppercase tracking-widest text-muted-foreground ml-1">Phone Line</Label>
                                <div className="relative">
                                    <Phone className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                                    <Input
                                        id="phoneNumber"
                                        name="phoneNumber"
                                        type="tel"
                                        placeholder="024XXXXXXX"
                                        value={formData.phoneNumber}
                                        onChange={handleChange}
                                        required
                                        className="h-12 pl-12 bg-background/50 border-border/50 focus:border-primary/50 rounded-2xl text-sm font-medium"
                                    />
                                </div>
                            </div>

                            <div className="grid grid-cols-2 gap-4">
                                <div className="space-y-2">
                                    <Label htmlFor="password" className="text-[10px] font-black uppercase tracking-widest text-muted-foreground ml-1">Password</Label>
                                    <div className="relative">
                                        <Lock className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                                        <Input
                                            id="password"
                                            name="password"
                                            type={showPassword ? 'text' : 'password'}
                                            placeholder="••••••••"
                                            value={formData.password}
                                            onChange={handleChange}
                                            required
                                            className="h-12 pl-12 pr-10 bg-background/50 border-border/50 focus:border-primary/50 rounded-2xl text-sm font-medium tracking-tighter"
                                        />
                                        <button
                                            type="button"
                                            onClick={() => setShowPassword(!showPassword)}
                                            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                                        >
                                            {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                                        </button>
                                    </div>
                                </div>
                                <div className="space-y-2">
                                    <Label htmlFor="confirmPassword" className="text-[10px] font-black uppercase tracking-widest text-muted-foreground ml-1">Confirm Password</Label>
                                    <div className="relative">
                                        <Lock className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                                        <Input
                                            id="confirmPassword"
                                            name="confirmPassword"
                                            type={showPassword ? 'text' : 'password'}
                                            placeholder="••••••••"
                                            value={formData.confirmPassword}
                                            onChange={handleChange}
                                            required
                                            className="h-12 pl-12 bg-background/50 border-border/50 focus:border-primary/50 rounded-2xl text-sm font-medium tracking-tighter"
                                        />
                                    </div>
                                </div>
                            </div>

                            <Button
                                type="submit"
                                disabled={isLoading || lockoutMinutes !== null}
                                className="w-full h-14 text-sm font-black uppercase tracking-[0.25em] bg-primary hover:bg-primary/90 text-primary-foreground shadow-lg shadow-primary/20 rounded-2xl mt-4 transition-all hover:scale-[1.02] active:scale-95 disabled:opacity-50"
                            >
                                {isLoading ? (
                                    <Loader2 className="w-6 h-6 animate-spin" />
                                ) : (
                                    "Create Account"
                                )}
                            </Button>
                        </form>

                        <div className="grid gap-4 mt-6">
                            <Button
                                asChild
                                variant="outline"
                                className="w-full h-14 rounded-2xl border-border/50 hover:bg-secondary/50 font-black uppercase tracking-widest text-xs transition-all"
                            >
                                <Link href="/auth/login">
                                    Back to Login
                                </Link>
                            </Button>
                        </div>

                        <p className="text-[9px] text-center text-muted-foreground font-bold tracking-widest uppercase mt-8 opacity-40">
                            By registering, you agree to our <Link href="/terms" className="text-foreground hover:text-primary transition-colors">Terms</Link> & <Link href="/privacy" className="text-foreground hover:text-primary transition-colors">Policy</Link>
                        </p>
                    </CardContent>
                </Card>
            </div>
        </div>
    )
}
