'use client'

import React, { useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useAuth } from '@/contexts/auth-context'
import { getCachedPricing } from '@/lib/pricing-cache'
import { Button } from '@/components/ui/button'
import { Crown, Sparkles, Zap, CheckCircle, Store, Calendar } from 'lucide-react'
import { toast } from 'sonner'
import CongratsModal from '@/components/upgrade/CongratsModal'
import { cn } from '@/lib/utils'
import {
    resolveProvider,
    isMomoPromptProvider,
    SCOPE_PROVIDERS,
    PROVIDER_LABEL,
    type PaymentProvider,
} from '@/lib/payment-provider'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Loader2, Phone, Smartphone, Wallet } from 'lucide-react'
import { supabase } from '@/lib/supabase'
export default function UpgradePage() {
    const { dbUser, refreshUser } = useAuth()
    const router = useRouter()
    const searchParams = useSearchParams()

    // Congrats modal state
    const [showCongrats, setShowCongrats] = useState(false)
    const [initialExpiry, setInitialExpiry] = useState<string | null>(null)

    // Payment State
    const [showPaymentModal, setShowPaymentModal] = useState(false)
    const [selectedPlan, setSelectedPlan] = useState<string | null>(null)
    const [paymentPhone, setPaymentPhone] = useState('')
    const [paymentNetwork, setPaymentNetwork] = useState('MTN')
    const [pollingRef, setPollingRef] = useState<string | null>(null)
    const [otpRequired, setOtpRequired] = useState(false)
    const [otpCode, setOtpCode] = useState('')
    const [paymentReference, setPaymentReference] = useState<string | null>(null)
    const [webPaymentProvider, setWebPaymentProvider] = useState<PaymentProvider>('moolre')

    // Paying from the wallet settles server-side: no handset prompt, no polling,
    // the role is already changed when the request returns.
    const [walletBalance, setWalletBalance] = useState(0)
    const [payWithWallet, setPayWithWallet] = useState(false)

    // Prices for tiers
    const [prices, setPrices] = useState({
        '3d': 9.99,
        '14d': 49.99,
        '30d': 99.99,
        'permanent': 149.99
    })

    const [oldPrices, setOldPrices] = useState({
        '3d': 0,
        '14d': 0,
        '30d': 0,
        'permanent': 0
    })

    const [enabledPlans, setEnabledPlans] = useState({
        '3d': true,
        '14d': true,
        '30d': true,
        'permanent': true
    })

    const [dealerPrice6m, setDealerPrice6m] = useState(0)
    const [dealerPrice3m, setDealerPrice3m] = useState(0)
    const [showStrikethrough, setShowStrikethrough] = useState(false)
    const [isLoading, setIsLoading] = useState(true)
    const [isProcessing, setIsProcessing] = useState<string | null>(null)
    const [isDealerClaiming, setIsDealerClaiming] = useState(false)
    const [isDealerPaymentFlow, setIsDealerPaymentFlow] = useState(false)
    const [dealerPromoEnabled, setDealerPromoEnabled] = useState(false)

    // Store initial expiry date when user data is available
    useEffect(() => {
        if (dbUser?.agent_expires_at && !initialExpiry) {
            setInitialExpiry(dbUser.agent_expires_at)
        }
    }, [dbUser, initialExpiry])

    useEffect(() => {
        if (!dbUser?.id) return
        let cancelled = false
        ;(async () => {
            const { data } = await (supabase.from('wallets').select('balance').eq('user_id', dbUser.id).single() as any)
            if (!cancelled && data) setWalletBalance(Number(data.balance) || 0)
        })()
        return () => { cancelled = true }
    }, [dbUser?.id])

    useEffect(() => {
        const fetchPrices = async () => {
            try {
                // Use cached pricing to reduce API calls
                const data = await getCachedPricing()
                console.log('Fetched prices (from cache or API):', data)

                setPrices(data.prices)
                setOldPrices(data.oldPrices || { '3d': 0, '14d': 0, '30d': 0, 'permanent': 0 })
                setShowStrikethrough(data.showStrikethrough || false)
                if (data.enabledPlans) setEnabledPlans(data.enabledPlans)
                setDealerPrice6m(data.dealerPrice6m ?? 0)
                setDealerPrice3m(data.dealerPrice3m ?? 0)
                setIsLoading(false)
            } catch (err) {
                console.error('Failed to fetch upgrade prices:', err)
                toast.error('Failed to load upgrade prices.')
                setIsLoading(false)
            }
        }

        fetchPrices()

        fetch('/api/admin-settings?key=dealer_promo_enabled')
            .then(r => r.ok ? r.json() : null)
            .then(d => { if (d) setDealerPromoEnabled(d.value === 'true') })
            .catch(() => {})

        fetch('/api/admin-settings?key=active_payment_provider_web')
            .then(r => r.ok ? r.json() : null)
            .then(d => {
                if (d) {
                    setWebPaymentProvider(resolveProvider(d.value))
                }
            })
            .catch(() => {})
    }, [])




    // Handle return from Paystack checkout
    useEffect(() => {
        const paystackRef = searchParams.get('reference')
        if (paystackRef && !pollingRef) {
            setPollingRef(paystackRef)
            router.replace('/dashboard/upgrade')
        }
    }, [searchParams]) // eslint-disable-line react-hooks/exhaustive-deps

    // Poll for payment status when reference is set
    useEffect(() => {
        let interval: NodeJS.Timeout
        if (pollingRef) {
            const isDealerRef = pollingRef.startsWith('dealer_sub_')
            const verifyUrl = isDealerRef
                ? `/api/user/dealer-subscribe?reference=${pollingRef}`
                : `/api/user/upgrade/verify?reference=${pollingRef}`

            interval = setInterval(async () => {
                try {
                    const res = await fetch(verifyUrl, { headers: { 'Accept': 'application/json' } })
                    const data = await res.json()

                    if (data.status === 'completed') {
                        clearInterval(interval)
                        setPollingRef(null)
                        setShowPaymentModal(false)
                        setIsDealerPaymentFlow(false)
                        toast.success(isDealerRef ? 'Dealer subscription activated!' : 'Upgrade payment completed successfully!')
                        await refreshUser()
                        if (!isDealerRef) setShowCongrats(true)
                    } else if (data.status === 'failed') {
                        clearInterval(interval)
                        setPollingRef(null)
                        setShowPaymentModal(false)
                        setIsDealerPaymentFlow(false)
                        toast.error(data.error || 'Payment failed or cancelled.')
                        setIsProcessing(null)
                    }
                } catch (e) {
                    console.error('Polling error', e)
                }
            }, 3000)
        }
        return () => clearInterval(interval)
    }, [pollingRef, refreshUser])

    const selectedPlanPrice = prices[selectedPlan as keyof typeof prices] ?? 0
    const canAffordUpgradeWithWallet = walletBalance >= selectedPlanPrice && selectedPlanPrice > 0

    // Default to the wallet whenever it covers the plan — it is the only path that
    // activates without the customer approving a prompt on their handset. Falls
    // back the moment the balance stops covering the selected plan, so switching
    // to a pricier tier cannot leave a wallet option selected that would 400.
    useEffect(() => {
        if (!canAffordUpgradeWithWallet && payWithWallet) setPayWithWallet(false)
        else if (canAffordUpgradeWithWallet && showPaymentModal && !isDealerPaymentFlow) setPayWithWallet(true)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [canAffordUpgradeWithWallet, showPaymentModal, isDealerPaymentFlow])

    const handleUpgradeSelect = (plan: string) => {
        setSelectedPlan(plan)
        setIsDealerPaymentFlow(false)
        setShowPaymentModal(true)
    }

    const handleDealerSubscribeClick = (plan: 'dealer_3m' | 'dealer_6m' = 'dealer_6m') => {
        setSelectedPlan(plan)
        setIsDealerPaymentFlow(true)
        setShowPaymentModal(true)
    }

    const handleDealerClaim = async () => {
        setIsDealerClaiming(true)
        try {
            const res = await fetch('/api/user/claim-dealer', { method: 'POST' })
            const data = await res.json()
            if (!res.ok) throw new Error(data.error || 'Failed to claim dealership')
            toast.success('Dealership claimed! Enjoy your free 1-month trial.')
            await refreshUser()
        } catch (error: any) {
            toast.error(error.message || 'Failed to claim dealership')
        } finally {
            setIsDealerClaiming(false)
        }
    }

    const handleUpgradeSubmit = async () => {
        setIsProcessing(selectedPlan)

        if (isDealerPaymentFlow) {
            try {
                const response = await fetch('/api/user/dealer-subscribe', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        phone: paymentPhone.replace(/\s/g, ''),
                        network: paymentNetwork,
                        planType: selectedPlan,
                        provider: webPaymentProvider,
                    })
                })
                const data = await response.json()
                if (!response.ok) throw new Error(data.error || 'Failed to initialize dealer subscription')
                if (data.gateway === 'paystack') {
                    window.location.href = data.authorization_url
                    return
                }
                if (data.gateway === 'hubtel') {
                    toast.success(data.message || 'Payment prompt sent! Please approve on your phone.')
                    setPollingRef(data.reference)
                    setIsProcessing(null)
                    setShowPaymentModal(false)
                    return
                }

                setPaymentReference(data.reference)
                if (data.otpRequired) {
                    setOtpRequired(true)
                    setIsProcessing(null)
                    setShowPaymentModal(false)
                    return
                }
                setPollingRef(data.reference)
                setIsProcessing(null)
                setShowPaymentModal(false)
            } catch (error: any) {
                toast.error(error.message || 'Failed to start dealer subscription')
                setIsProcessing(null)
            }
            return
        }

        try {
            const response = await fetch('/api/user/upgrade/initialize', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    plan: selectedPlan,
                    phone: paymentPhone.replace(/\s/g, ''),
                    network: paymentNetwork,
                    provider: webPaymentProvider,
                    ...(payWithWallet && { paymentMethod: 'wallet' }),
                })
            })

            const data = await response.json()

            if (!response.ok) {
                throw new Error(data.error || 'Failed to initialize upgrade')
            }

            // Wallet: already settled and the role is already changed. No prompt to
            // approve and nothing to poll — go straight to the success state.
            if (data.gateway === 'wallet') {
                setShowPaymentModal(false)
                setIsProcessing(null)
                setWalletBalance(b => Math.max(0, b - prices[selectedPlan as keyof typeof prices]))
                await refreshUser()
                setShowCongrats(true)
                toast.success(data.message || 'Upgrade activated!')
                return
            }

            if (data.gateway === 'paystack') {
                window.location.href = data.authorization_url
                return
            }

            // Hubtel and PaySwitch both push a prompt to the handset and confirm by
            // callback — neither has an OTP step, so they must not fall through to
            // the Moolre branch below (PaySwitch previously did, showing an OTP box
            // for a code that never arrives).
            if (data.gateway === 'hubtel' || data.gateway === 'payswitch') {
                toast.success(data.message || 'Payment prompt sent! Please approve on your phone.')
                setPollingRef(data.reference)
                setIsProcessing(null)
                setShowPaymentModal(false)
                return
            }

            // Moolre: show OTP modal
            setPaymentReference(data.reference)
            setOtpRequired(true)
            setIsProcessing(null)
            setShowPaymentModal(false)
        } catch (error: any) {
            toast.error(error.message || 'Failed to start upgrade process')
            setIsProcessing(null)
        }
    }

    const handleVerifyOtp = async () => {
        if (!otpCode || otpCode.trim().length < 1) {
            toast.error('Please enter the OTP sent to your phone')
            return
        }

        setIsProcessing(selectedPlan)
        try {
            const endpoint = isDealerPaymentFlow ? '/api/user/dealer-subscribe' : '/api/user/upgrade/initialize'
            const body = isDealerPaymentFlow
                ? { phone: paymentPhone.replace(/\s/g, ''), network: paymentNetwork, otpCode: otpCode.trim(), reference: paymentReference, planType: selectedPlan, provider: webPaymentProvider }
                : { plan: selectedPlan, phone: paymentPhone.replace(/\s/g, ''), network: paymentNetwork, otpCode: otpCode.trim(), reference: paymentReference, provider: webPaymentProvider }

            const response = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            })

            const data = await response.json()

            if (!response.ok) {
                throw new Error(data.error || 'Invalid OTP. Please try again.')
            }

            if (data.otpRequired) {
                throw new Error('Invalid OTP or OTP expired. Please try again.')
            }

            setOtpRequired(false)
            setOtpCode('')
            toast.success(data.message || 'OTP verified! Please approve the prompt on your phone.')
            setPollingRef(data.reference)
        } catch (error: any) {
            toast.error(error.message || 'Failed to verify OTP')
            setIsProcessing(null)
            // Keep modal open so user can retry
        }
    }

    const getDiscountPercent = (oldPrice: number, newPrice: number): number => {
        if (!oldPrice || oldPrice <= newPrice) return 0
        return Math.round(((oldPrice - newPrice) / oldPrice) * 100)
    }

    const tiers = [
        {
            id: '3d',
            name: '3 Days',
            duration: '3 Days Access',
            price: prices['3d'],
            oldPrice: oldPrices['3d'],
            popular: false,
            tier: 'bronze',
            color: 'border-[#C0C0C0]',
            buttonClass: 'bg-gradient-to-r from-gray-300 to-gray-400 hover:from-gray-400 hover:to-gray-500 text-gray-800 shadow-sm',
            badgeText: 'STARTER',
            badgeColor: 'from-gray-300 to-gray-400',
            priceColor: 'text-gray-600',
            bgClass: 'bg-slate-50'
        },
        {
            id: '14d',
            name: '2 weeks',
            duration: '14 Days Access',
            price: prices['14d'],
            oldPrice: oldPrices['14d'],
            popular: true,
            tier: 'gold',
            color: 'border-primary ring-2 ring-primary/30',
            buttonClass: 'bg-primary hover:bg-primary/90 text-white shadow-lg shadow-primary/20',
            badgeText: 'MOST POPULAR',
            badgeColor: 'from-primary to-blue-700',
            priceColor: 'text-amber-600',
            bgClass: 'bg-amber-50'
        },
        {
            id: '30d',
            name: '1 month',
            duration: '30 Days Access',
            price: prices['30d'],
            oldPrice: oldPrices['30d'],
            popular: false,
            tier: 'diamond',
            color: 'border-purple-400 ring-2 ring-purple-400/30',
            buttonClass: 'bg-gradient-to-r from-purple-600 via-blue-600 to-indigo-700 hover:from-purple-700 hover:via-blue-700 hover:to-indigo-800 shadow-lg shadow-purple-500/30',
            badgeText: 'PREMIUM',
            badgeColor: 'from-purple-600 to-indigo-700',
            priceColor: 'text-purple-600',
            bgClass: 'bg-purple-50'
        },
        {
            id: 'permanent',
            name: 'Lifetime',
            duration: 'Permanent Access',
            price: prices['permanent'],
            oldPrice: oldPrices['permanent'],
            popular: false,
            tier: 'elite',
            color: 'border-slate-800 ring-2 ring-slate-800/30',
            buttonClass: 'bg-gradient-to-r from-slate-900 via-slate-800 to-black hover:from-black hover:to-slate-900 shadow-xl shadow-slate-900/40 text-white',
            badgeText: 'LIFETIME ELITE',
            badgeColor: 'from-slate-800 to-black',
            priceColor: 'text-slate-900',
            bgClass: 'bg-gradient-to-b from-slate-50 to-slate-100'
        }
    ].filter(tier => enabledPlans[tier.id as keyof typeof enabledPlans])

    const hasAgentPlans = tiers.length > 0

    const commonFeatures = [
        'Exclusive Wholesale Pricing',
        'Priority Customer Support',
        '0% Top Up Charges (Admin Manual Top Up)',
        'Faster Order Processing',
        'Bulk Order Import Feature',
        'New Exclusive UI Design Features',
        'Shop Storefront Feature (Live)'
    ]

    if (isLoading) {
        return (
            <div className="fixed inset-0 bg-[#FFCE00] flex items-center justify-center z-50 p-6">
                <div className="flex flex-col items-center gap-6 max-w-sm w-full">
                    <div className="relative">
                        <Crown className="w-16 h-16 text-yellow-600 animate-bounce relative z-10" />
                    </div>
                </div>
            </div>
        )
    }

    // Identify if user is already a permanent agent
    const isPermanentAgent = dbUser?.role === 'agent' && dbUser?.agent_expires_at === null

    // ── DEALER / CUSTOMER VIEW ─────────────────────────────────────────────────
    const isDealer = (dbUser as any)?.role === 'dealer'
    const isCustomer = dbUser?.role === 'customer'
    const viewAgentPlans = searchParams.get('view') === 'agent'
    const viewDealerPlans = searchParams.get('view') === 'dealer'

    // Customer landing — show two-path choice page
    if (isCustomer && !viewAgentPlans && !viewDealerPlans) {
        return (
            <div className="relative -m-4 sm:-m-6 min-h-[calc(100vh+2rem)] lg:min-h-screen bg-gradient-to-br from-yellow-400 via-amber-500 to-yellow-600 overflow-x-hidden px-4 sm:px-6 py-10 sm:py-16 flex flex-col items-center [font-family:'Fira_Sans',sans-serif]">
                <div className="relative z-10 w-full max-w-2xl flex flex-col items-center">
                    <div className="text-center mb-10 space-y-3">
                        <div className="flex justify-center mb-4">
                            <div className="w-20 h-20 sm:w-24 sm:h-24 rounded-full bg-white/20 backdrop-blur flex items-center justify-center shadow-xl">
                                <Crown className="w-10 h-10 sm:w-12 sm:h-12 text-white" />
                            </div>
                        </div>
                        <h1 className="text-4xl sm:text-5xl font-black text-[#b45309] leading-tight">UPGRADE YOUR ACCOUNT</h1>
                        <p className="text-sm sm:text-base text-white font-bold max-w-md mx-auto drop-shadow-sm">
                            Choose the membership that fits your goals.
                        </p>
                    </div>

                    <div className="w-full flex flex-col gap-5">
                        {/* Become an Agent */}
                        {hasAgentPlans && (
                        <div className="w-full rounded-2xl bg-white/90 backdrop-blur border-2 border-amber-300 shadow-xl p-6">
                            <div className="flex items-center gap-4 mb-4">
                                <div className="w-14 h-14 rounded-full bg-amber-100 flex items-center justify-center flex-shrink-0">
                                    <Crown className="w-7 h-7 text-amber-600" />
                                </div>
                                <div>
                                    <p className="font-black text-gray-900 text-lg">Become an Agent</p>
                                    <p className="text-xs text-gray-500 font-bold">Premium reseller membership</p>
                                </div>
                                <span className="ml-auto px-3 py-1 rounded-full bg-amber-100 text-amber-700 text-xs font-black">PREMIUM</span>
                            </div>
                            <div className="space-y-2 mb-5">
                                {['Lowest agent pricing on all bundles', 'Resell packages to earn commissions', 'Priority order processing & support', 'Flexible plans: 3 days to lifetime'].map((f) => (
                                    <div key={f} className="flex items-center gap-2.5">
                                        <CheckCircle className="w-4 h-4 text-green-500 flex-shrink-0" />
                                        <span className="text-xs font-bold text-gray-700">{f}</span>
                                    </div>
                                ))}
                            </div>
                            <Button
                                onClick={() => router.push('/dashboard/upgrade?view=agent')}
                                className="w-full bg-gradient-to-r from-amber-500 to-yellow-500 hover:from-amber-600 hover:to-yellow-600 text-white font-black h-11 rounded-xl shadow-lg"
                            >
                                See Agent Plans
                            </Button>
                        </div>
                        )}

                        {/* Become a Dealer */}
                        <div className="w-full rounded-2xl bg-white/90 backdrop-blur border-2 border-violet-300 shadow-xl p-6">
                            <div className="flex items-center gap-4 mb-4">
                                <div className="w-14 h-14 rounded-full bg-violet-100 flex items-center justify-center flex-shrink-0">
                                    <Store className="w-7 h-7 text-violet-600" />
                                </div>
                                <div>
                                    <p className="font-black text-gray-900 text-lg">Become a Dealer</p>
                                    <p className="text-xs text-gray-500 font-bold">Special dealer pricing access</p>
                                </div>
                                <span className="ml-auto px-3 py-1 rounded-full bg-violet-100 text-violet-700 text-xs font-black">DEALER</span>
                            </div>
                            <div className="space-y-2 mb-5">
                                {['Exclusive dealer pricing on all bundles', 'Priority order processing', '3-month or 6-month plans available', dealerPromoEnabled ? 'Free 1-month trial for new users' : 'Flexible subscription options'].map((f) => (
                                    <div key={f} className="flex items-center gap-2.5">
                                        <CheckCircle className="w-4 h-4 text-green-500 flex-shrink-0" />
                                        <span className="text-xs font-bold text-gray-700">{f}</span>
                                    </div>
                                ))}
                            </div>
                            <Button
                                onClick={() => router.push('/dashboard/upgrade?view=dealer')}
                                className="w-full bg-gradient-to-r from-violet-500 to-purple-500 hover:from-violet-600 hover:to-purple-600 text-white font-black h-11 rounded-xl shadow-lg"
                            >
                                See Dealer Plans
                            </Button>
                        </div>
                    </div>
                </div>
            </div>
        )
    }

    if (isDealer || (isCustomer && viewDealerPlans)) {
        const dealerClaimedAt = (dbUser as any)?.dealer_claimed_at
        const dealerExpiresAt = (dbUser as any)?.dealer_expires_at
        const expiryDate = dealerExpiresAt ? new Date(dealerExpiresAt) : null
        const now = new Date()
        const daysLeft = expiryDate ? Math.ceil((expiryDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)) : 0
        const isExpired = expiryDate ? expiryDate < now : false
        const DEALER_FEATURE_LAUNCH = new Date('2026-05-29T00:00:00Z')
        const isNewUser = dbUser?.created_at ? new Date(dbUser.created_at) >= DEALER_FEATURE_LAUNCH : false

        const paymentModal = (
            <>
                <Dialog open={showPaymentModal && !pollingRef} onOpenChange={setShowPaymentModal}>
                    <DialogContent className="sm:max-w-md">
                        <DialogHeader>
                            <DialogTitle>Complete Payment</DialogTitle>
                            <DialogDescription>
                                Enter your Mobile Money number to receive the payment prompt.
                            </DialogDescription>
                        </DialogHeader>
                        <div className="space-y-4 py-4">
                            <div className="space-y-2">
                                <Label className="text-sm text-muted-foreground block">Pay via</Label>
                                <div className="flex gap-1 p-1 rounded-xl bg-muted w-full">
                                    {SCOPE_PROVIDERS.web.map((id) => (
                                        <button
                                            key={id}
                                            type="button"
                                            onClick={() => setWebPaymentProvider(id)}
                                            className={cn(
                                                'flex-1 py-1.5 px-2 rounded-lg text-sm font-medium transition-all',
                                                webPaymentProvider === id
                                                    ? 'bg-white shadow text-foreground'
                                                    : 'text-muted-foreground hover:text-foreground'
                                            )}
                                        >
                                            {PROVIDER_LABEL[id]}
                                        </button>
                                    ))}
                                </div>
                            </div>
                            
                            {isMomoPromptProvider(webPaymentProvider) && (
                                <>
                                    <div className="space-y-2">
                                        <Label htmlFor="network-d">Network</Label>
                                        <Select value={paymentNetwork} onValueChange={setPaymentNetwork}>
                                            <SelectTrigger id="network-d">
                                                <SelectValue placeholder="Select network" />
                                            </SelectTrigger>
                                            <SelectContent>
                                                <SelectItem value="MTN">MTN</SelectItem>
                                                <SelectItem value="Telecel">Telecel</SelectItem>
                                                <SelectItem value="AT">AT</SelectItem>
                                            </SelectContent>
                                        </Select>
                                    </div>
                                    <div className="space-y-2">
                                        <Label htmlFor="phone-d">Mobile Money Number</Label>
                                        <div className="relative">
                                            <Phone className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                                            <Input
                                                id="phone-d"
                                                type="tel"
                                                placeholder="024XXXXXXX"
                                                className="pl-9"
                                                value={paymentPhone}
                                                onChange={(e) => setPaymentPhone(e.target.value)}
                                            />
                                        </div>
                                    </div>
                                </>
                            )}
                        </div>
                        <div className="flex gap-3 justify-end">
                            <Button variant="outline" onClick={() => setShowPaymentModal(false)}>Cancel</Button>
                            <Button 
                                onClick={handleUpgradeSubmit} 
                                disabled={isProcessing !== null || (isMomoPromptProvider(webPaymentProvider) && !paymentPhone)} 
                                className="bg-violet-700 text-white hover:bg-violet-800"
                            >
                                {isProcessing !== null ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Processing</> : webPaymentProvider === 'paystack' ? 'Pay with Paystack' : 'Send Prompt'}
                            </Button>
                        </div>
                    </DialogContent>
                </Dialog>

                <Dialog open={otpRequired} onOpenChange={(open) => !open && setOtpRequired(false)}>
                    <DialogContent className="sm:max-w-md">
                        <DialogHeader>
                            <DialogTitle>OTP Verification</DialogTitle>
                            <DialogDescription>
                                Please enter the OTP sent to your phone to complete the payment.
                            </DialogDescription>
                        </DialogHeader>
                        <div className="flex flex-col space-y-4 py-4">
                            <div className="space-y-2">
                                <Label htmlFor="otp-d">Enter OTP</Label>
                                <Input id="otp-d" type="text" placeholder="Enter code" value={otpCode} onChange={(e) => setOtpCode(e.target.value)} className="h-12 text-center text-2xl tracking-widest font-bold" />
                            </div>
                        </div>
                        <div className="flex gap-3 justify-end">
                            <Button variant="outline" onClick={() => setOtpRequired(false)}>Cancel</Button>
                            <Button onClick={handleVerifyOtp} disabled={isProcessing !== null || !otpCode} className="bg-violet-700 text-white hover:bg-violet-800">
                                {isProcessing !== null ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Verify & Continue'}
                            </Button>
                        </div>
                    </DialogContent>
                </Dialog>

                {pollingRef && (
                    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-[100] p-6 backdrop-blur-sm">
                        <div className="flex flex-col items-center gap-6 max-w-sm w-full bg-white rounded-2xl p-8 shadow-2xl text-center">
                            <div className="relative w-16 h-16 flex items-center justify-center">
                                <div className="absolute inset-0 border-4 border-violet-100 rounded-full" />
                                <div className="absolute inset-0 border-4 border-violet-500 rounded-full border-t-transparent animate-spin" />
                                <Smartphone className="w-6 h-6 text-violet-500" />
                            </div>
                            <div className="space-y-2">
                                <h2 className="text-xl font-black text-gray-900">Awaiting Approval</h2>
                                <p className="text-sm font-medium text-gray-500">
                                    {paymentPhone ? `Please check your phone (${paymentPhone}) and authorize the transaction.` : 'Confirming your payment...'}
                                </p>
                            </div>
                            <p className="text-xs text-violet-600 bg-violet-50 px-3 py-1.5 rounded-full font-bold">Do not close this page</p>
                        </div>
                    </div>
                )}
            </>
        )

        return (
            <>
                {paymentModal}
                <div className="relative -m-4 sm:-m-6 min-h-[calc(100vh+2rem)] lg:min-h-screen bg-gradient-to-br from-yellow-400 via-amber-500 to-yellow-600 overflow-x-hidden selection:bg-yellow-200 px-4 sm:px-6 py-10 sm:py-16 flex flex-col items-center [font-family:'Fira_Sans',sans-serif]">
                    <div className="relative z-10 w-full max-w-2xl flex flex-col items-center">

                        {/* Header */}
                        <div className="text-center mb-10 space-y-3">
                            <div className="flex justify-center mb-4">
                                <div className="w-20 h-20 sm:w-24 sm:h-24 rounded-full bg-white/20 backdrop-blur flex items-center justify-center shadow-xl">
                                    <Store className="w-10 h-10 sm:w-12 sm:h-12 text-white" />
                                </div>
                            </div>
                            <h1 className="text-4xl sm:text-5xl font-black text-[#b45309] leading-tight">
                                {isDealer ? 'YOUR DEALERSHIP' : 'BECOME A DEALER'}
                            </h1>
                            <p className="text-sm sm:text-base text-white font-bold max-w-md mx-auto drop-shadow-sm">
                                {isDealer
                                    ? 'Manage your dealer subscription and access exclusive pricing.'
                                    : 'Get access to special dealer pricing. Start with a free 1-month trial.'}
                            </p>
                        </div>

                        {/* Dealer status card */}
                        {isDealer && expiryDate && (
                            <div className={cn(
                                'w-full rounded-2xl p-5 mb-6 border-2 flex items-start gap-4',
                                isExpired
                                    ? 'bg-red-50 border-red-300'
                                    : daysLeft <= 7
                                        ? 'bg-amber-50 border-amber-300'
                                        : 'bg-green-50 border-green-300'
                            )}>
                                <Calendar className={cn('w-6 h-6 mt-0.5 flex-shrink-0', isExpired ? 'text-red-500' : daysLeft <= 7 ? 'text-amber-500' : 'text-green-600')} />
                                <div>
                                    <p className={cn('font-black text-sm', isExpired ? 'text-red-700' : daysLeft <= 7 ? 'text-amber-700' : 'text-green-700')}>
                                        {isExpired
                                            ? 'Your dealer subscription has expired'
                                            : daysLeft <= 7
                                                ? `Expires soon — ${daysLeft} day${daysLeft !== 1 ? 's' : ''} left`
                                                : `Active — ${daysLeft} day${daysLeft !== 1 ? 's' : ''} remaining`}
                                    </p>
                                    <p className="text-xs text-gray-500 mt-1">
                                        Expiry: {expiryDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}
                                    </p>
                                </div>
                            </div>
                        )}

                        {/* Claim card — only for new customers (registered after feature launch) when promo is active */}
                        {isCustomer && !dealerClaimedAt && isNewUser && dealerPromoEnabled && (
                            <div className="w-full rounded-2xl bg-white/90 backdrop-blur border-2 border-violet-300 shadow-xl p-6 mb-5">
                                <div className="flex items-center gap-3 mb-3">
                                    <div className="w-10 h-10 rounded-full bg-violet-100 flex items-center justify-center">
                                        <Store className="w-5 h-5 text-violet-600" />
                                    </div>
                                    <div>
                                        <p className="font-black text-gray-900 text-sm">Free 1-Month Trial</p>
                                        <p className="text-xs text-gray-500">No payment required</p>
                                    </div>
                                    <span className="ml-auto px-3 py-1 rounded-full bg-green-100 text-green-700 text-xs font-black">FREE</span>
                                </div>
                                <p className="text-sm text-gray-600 mb-4">
                                    Claim your free dealer role and enjoy special dealer pricing for a full month.
                                </p>
                                <Button
                                    onClick={handleDealerClaim}
                                    disabled={isDealerClaiming}
                                    className="w-full bg-violet-700 hover:bg-violet-800 text-white font-black h-11 rounded-xl"
                                >
                                    {isDealerClaiming ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Claiming...</> : 'Claim Now — Free'}
                                </Button>
                            </div>
                        )}

                        {/* 3-month subscription card */}
                        {dealerPrice3m > 0 && (
                            <div className="w-full rounded-2xl bg-white/90 backdrop-blur border-2 border-violet-300 shadow-xl p-6 relative">
                                <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                                    <span className="px-4 py-1.5 rounded-full bg-gradient-to-r from-violet-500 to-purple-500 text-white text-xs font-black shadow-lg">
                                        {isDealer && !isExpired ? 'EXTEND' : 'SUBSCRIBE'}
                                    </span>
                                </div>
                                <div className="relative pt-2">
                                    <div className="flex items-center gap-3 mb-4">
                                        <div className="w-10 h-10 rounded-full bg-violet-100 flex items-center justify-center">
                                            <Store className="w-5 h-5 text-violet-600" />
                                        </div>
                                        <div>
                                            <p className="font-black text-gray-900 text-sm">3-Month Dealer Subscription</p>
                                            <p className="text-xs text-gray-500">90 days of dealer pricing</p>
                                        </div>
                                    </div>

                                    <div className="text-center py-3 mb-4">
                                        <span className="text-4xl font-black text-violet-700">GHS {dealerPrice3m.toFixed(2)}</span>
                                        <p className="text-xs text-gray-500 mt-1">One-time payment</p>
                                    </div>

                                    <div className="space-y-2 mb-5">
                                        {['Exclusive dealer pricing on all bundles', 'Priority order processing', '90 days of access'].map((f) => (
                                            <div key={f} className="flex items-center gap-2.5">
                                                <CheckCircle className="w-4 h-4 text-green-500 flex-shrink-0" />
                                                <span className="text-xs font-bold text-gray-700">{f}</span>
                                            </div>
                                        ))}
                                    </div>

                                    <Button
                                        onClick={() => handleDealerSubscribeClick('dealer_3m')}
                                        disabled={isProcessing !== null || pollingRef !== null}
                                        className="w-full bg-gradient-to-r from-violet-500 to-purple-500 hover:from-violet-600 hover:to-purple-600 text-white font-black h-11 rounded-xl shadow-lg"
                                    >
                                        {isProcessing === 'dealer_3m' ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Processing...</> : 'Subscribe — 3 Months'}
                                    </Button>
                                </div>
                            </div>
                        )}

                        {/* 6-month subscription card */}
                        <div className="w-full rounded-2xl bg-white/90 backdrop-blur border-2 border-amber-300 shadow-xl p-6">
                            <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                                <span className="px-4 py-1.5 rounded-full bg-gradient-to-r from-amber-500 to-yellow-500 text-white text-xs font-black shadow-lg">
                                    {isDealer && !isExpired ? 'RENEW / EXTEND' : 'SUBSCRIBE'}
                                </span>
                            </div>
                            <div className="relative pt-2">
                                <div className="flex items-center gap-3 mb-4">
                                    <div className="w-10 h-10 rounded-full bg-amber-100 flex items-center justify-center">
                                        <Crown className="w-5 h-5 text-amber-600" />
                                    </div>
                                    <div>
                                        <p className="font-black text-gray-900 text-sm">6-Month Dealer Subscription</p>
                                        <p className="text-xs text-gray-500">180 days of dealer pricing</p>
                                    </div>
                                </div>

                                {dealerPrice6m > 0 ? (
                                    <div className="text-center py-3 mb-4">
                                        <span className="text-4xl font-black text-amber-700">GHS {dealerPrice6m.toFixed(2)}</span>
                                        <p className="text-xs text-gray-500 mt-1">One-time payment</p>
                                    </div>
                                ) : (
                                    <div className="text-center py-3 mb-4 text-gray-400 text-sm font-bold">Price not set — contact admin</div>
                                )}

                                <div className="space-y-2 mb-5">
                                    {['Exclusive dealer pricing on all bundles', 'Priority order processing', '180 days of access'].map((f) => (
                                        <div key={f} className="flex items-center gap-2.5">
                                            <CheckCircle className="w-4 h-4 text-green-500 flex-shrink-0" />
                                            <span className="text-xs font-bold text-gray-700">{f}</span>
                                        </div>
                                    ))}
                                </div>

                                <Button
                                    onClick={() => handleDealerSubscribeClick('dealer_6m')}
                                    disabled={isProcessing !== null || pollingRef !== null || dealerPrice6m <= 0}
                                    className="w-full bg-gradient-to-r from-amber-500 to-yellow-500 hover:from-amber-600 hover:to-yellow-600 text-white font-black h-11 rounded-xl shadow-lg"
                                >
                                    {isProcessing === 'dealer_6m' ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Processing...</> : 'Subscribe — 6 Months'}
                                </Button>
                            </div>
                        </div>

                        <div className="mt-8 flex flex-col items-center gap-2">
                            {isCustomer && (
                                <button
                                    onClick={() => router.push('/dashboard/upgrade')}
                                    className="text-xs text-white/70 underline hover:text-white"
                                >
                                    ← Back to all options
                                </button>
                            )}
                            {hasAgentPlans && (
                                <p className="text-xs text-white/70 text-center">
                                    Want agent-level access instead?{' '}
                                    <button
                                        onClick={() => router.push('/dashboard/upgrade?view=agent')}
                                        className="underline text-white font-bold hover:text-yellow-200"
                                    >
                                        See agent plans
                                    </button>
                                </p>
                            )}
                        </div>
                    </div>
                </div>
            </>
        )
    }

    return (
        <>
            {/* Congrats Modal */}
            {showCongrats && (
                <CongratsModal
                    onClose={() => setShowCongrats(false)}
                    onBrowsePackages={() => router.push('/dashboard/data-packages')}
                />
            )}

            <div className="relative -m-4 sm:-m-6 min-h-[calc(100vh+2rem)] lg:min-h-screen bg-gradient-to-br from-yellow-400 via-amber-500 to-yellow-600 overflow-x-hidden selection:bg-yellow-200 px-4 sm:px-6 py-10 sm:py-16 flex flex-col items-center scroll-smooth [font-family:'Fira_Sans',sans-serif]">

                <div className="relative z-10 w-full max-w-6xl flex flex-col items-center">

                    {/* Header Section */}
                    <div className="text-center mb-8 sm:mb-12 space-y-3 sm:space-y-4 relative w-full">
                        <div className="mb-4 sm:mb-6 flex justify-center">
                            <div className="relative">
                                <Crown className="w-20 h-20 sm:w-28 sm:h-28 text-black animate-[bounce_2s_infinite] drop-shadow-xl" />
                            </div>
                        </div>

                        <h1 className="text-4xl sm:text-6xl lg:text-7xl font-black text-[#b45309] leading-tight">
                            {dbUser?.role === 'agent' ? (
                                <span className="relative inline-block">
                                    <span className="relative">
                                        A
                                        <Crown className="absolute -top-6 -left-3 w-8 h-8 sm:w-12 sm:h-12 text-yellow-500 fill-yellow-500 -rotate-[25deg] drop-shadow-md" />
                                    </span>
                                    LREADY AN AGENT
                                </span>
                            ) : (
                                <span className="relative inline-block">
                                    <span className="relative">
                                        B
                                        <Crown className="absolute -top-6 -left-3 w-8 h-8 sm:w-12 sm:h-12 text-yellow-500 fill-yellow-500 -rotate-[25deg] drop-shadow-md" />
                                    </span>
                                    ECOME AN AGENT
                                </span>
                            )}
                        </h1>

                        {/* Premium Badge - Only visible to agents */}
                        {dbUser?.role === 'agent' && (
                            <div className="inline-block px-4 py-1.5 rounded-full bg-yellow-100/90 border border-yellow-200 backdrop-blur-sm shadow-sm group">
                                <span className="text-[10px] sm:text-xs font-black text-yellow-700 uppercase tracking-[0.2em] flex items-center gap-2">
                                    <Crown className="w-3 h-3 fill-yellow-600 text-yellow-600 group-hover:rotate-180 transition-transform duration-700" />
                                    {isPermanentAgent ? 'PERMANENT ELITE MEMBERSHIP' : 'PREMIUM MEMBERSHIP'}
                                    <Crown className="w-3 h-3 fill-yellow-600 text-yellow-600 group-hover:rotate-180 transition-transform duration-700" />
                                </span>
                            </div>
                        )}

                        <p id="agent-benefits" className="text-sm sm:text-base lg:text-lg text-white font-black max-w-3xl mx-auto px-4 drop-shadow-sm">
                            {isPermanentAgent
                                ? "You have permanent lifetime access to the Agent rank. You never need to renew your subscription again."
                                : dbUser?.role === 'agent'
                                    ? "Renew/Extend Your Subscription to Continue Enjoying Your Existing Features and Benefits"
                                    : "Unlock the New Premium Membership (Agent Role) for Exciting Features to Grow your Business. Choose from the Plans below (Each plan has same features)."}
                        </p>
                    </div>

                    {!isPermanentAgent && (
                        <>
                            {!hasAgentPlans && (
                                <div className="w-full max-w-xl mb-12 rounded-2xl bg-white/90 border-2 border-amber-300 shadow-xl p-6 text-center">
                                    <p className="font-black text-gray-900">Agent plans are currently unavailable</p>
                                    <p className="text-sm text-gray-500 font-bold mt-1">Please check back later.</p>
                                </div>
                            )}

                            {/* Plans Grid */}
                            <div id="pricing-plans" className={cn(
                                "grid grid-cols-1 gap-4 lg:gap-5 mb-12 w-full items-stretch px-2 sm:px-0 mx-auto",
                                !hasAgentPlans && "hidden",
                                tiers.length === 1 && "max-w-sm",
                                tiers.length === 2 && "sm:grid-cols-2 max-w-3xl",
                                tiers.length === 3 && "sm:grid-cols-2 lg:grid-cols-3 max-w-5xl",
                                tiers.length >= 4 && "sm:grid-cols-2 lg:grid-cols-4 max-w-7xl"
                            )}>
                                {tiers.map((tier) => (
                                    <div
                                        key={tier.id}
                                        className={cn(
                                            "relative rounded-2xl p-6 flex flex-col transition-all duration-500 shadow-xl border-2",
                                            tier.bgClass,
                                            tier.color,
                                            tier.popular ? 'md:scale-105 z-10' : 'opacity-95'
                                        )}
                                    >
                                        {/* Badge for all tiers */}
                                        {tier.badgeText && (
                                            <div className={`absolute -top-3 left-1/2 -translate-x-1/2 px-3 sm:px-4 py-1.5 bg-gradient-to-r ${tier.badgeColor} rounded-full shadow-lg z-20 flex items-center gap-1.5 sm:gap-2`}>
                                                {tier.tier === 'bronze' && <Zap className="w-3 h-3 text-white fill-current" />}
                                                {tier.tier === 'gold' && <Sparkles className="w-3 h-3 text-white fill-current" />}
                                                {tier.tier === 'diamond' && <Crown className="w-3 h-3 text-white fill-current" />}
                                                <span className="text-[10px] font-black text-white uppercase tracking-wider sm:tracking-widest">
                                                    {tier.badgeText}
                                                </span>
                                            </div>
                                        )}

                                        <div className="text-center mb-5 space-y-1">
                                            <h3 className="text-xl sm:text-2xl font-black text-gray-900 border-b-2 border-yellow-50/50 pb-2">{tier.name}</h3>
                                            <p className="text-gray-400 text-xs sm:text-sm font-bold pt-1">{tier.duration}</p>
                                        </div>

                                        <div className="text-center mb-6 flex flex-col items-center justify-center gap-1">
                                            {showStrikethrough && tier.oldPrice > 0 && tier.oldPrice !== tier.price && (
                                                <>
                                                    {/* Discount badge */}
                                                    <div className="inline-flex items-center gap-1 bg-red-500 text-white text-xs font-black px-2.5 py-1 rounded-full mb-1 shadow-sm">
                                                        <span>🔥</span>
                                                        <span>SAVE {getDiscountPercent(tier.oldPrice, tier.price)}%</span>
                                                    </div>
                                                    {/* Strikethrough old price */}
                                                    <div className="flex items-baseline gap-1">
                                                        <span className="text-red-400 line-through text-sm font-bold opacity-75">
                                                            GHS {tier.oldPrice.toFixed(2)}
                                                        </span>
                                                    </div>
                                                </>
                                            )}

                                            {/* New price — main display */}
                                            <div className="flex items-baseline justify-center gap-1.5">
                                                <span className={`font-black text-base sm:text-lg ${tier.priceColor}`}>GHS</span>
                                                <span className={`text-4xl sm:text-5xl font-black ${tier.priceColor} tracking-tighter`}>
                                                    {tier.price.toString().split('.')[0]}
                                                    <span className="text-2xl sm:text-3xl font-black">
                                                        {tier.price.toFixed(2).includes('.') ? '.' + tier.price.toFixed(2).split('.')[1] : '.00'}
                                                    </span>
                                                </span>
                                            </div>

                                            {showStrikethrough && tier.oldPrice > 0 && tier.oldPrice !== tier.price && (
                                                <p className="text-green-600 text-xs font-bold mt-1">
                                                    ✅ Limited time offer
                                                </p>
                                            )}
                                        </div>

                                        <div className="space-y-3 mb-8 flex-1">
                                            {commonFeatures.map((feature, i) => {
                                                const isComingSoon = feature.toLowerCase().includes('coming soon')
                                                return (
                                                    <div key={i} className="flex items-start gap-2.5">
                                                        <div className={cn(
                                                            "mt-0.5 flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center",
                                                            isComingSoon ? "bg-yellow-100" : "bg-green-50"
                                                        )}>
                                                            <CheckCircle className={cn(
                                                                "w-3.5 h-3.5",
                                                                isComingSoon ? "text-yellow-500" : "text-green-500"
                                                            )} />
                                                        </div>
                                                        <span className="text-xs sm:text-sm font-bold text-gray-700 leading-snug">{feature}</span>
                                                    </div>
                                                )
                                            })}
                                        </div>

                                        <Button
                                            onClick={() => handleUpgradeSelect(tier.id)}
                                            disabled={isProcessing !== null || pollingRef !== null}
                                            className={`w-full h-11 sm:h-12 rounded-xl text-sm sm:text-base font-black transition-all active:scale-95 text-white ${tier.buttonClass}`}
                                        >
                                            {isProcessing === tier.id ? (
                                                <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white"></div>
                                            ) : (
                                                dbUser?.role === 'agent' ? 'Renew / Extend' : 'Be an Agent Today'
                                            )}
                                        </Button>
                                    </div>
                                ))}
                            </div>

                            {/* Dealer Subscription Section — available to agents */}
                            {dbUser?.role === 'agent' && (
                                <div className="w-full max-w-3xl mb-8">
                                    <div className="w-full rounded-2xl bg-white/90 backdrop-blur border-2 border-violet-300 shadow-xl p-6 relative overflow-hidden">
                                        <div className="absolute -top-3 left-6">
                                            <span className="px-4 py-1.5 rounded-full bg-gradient-to-r from-violet-600 to-purple-500 text-white text-xs font-black shadow-lg">
                                                ALSO AVAILABLE
                                            </span>
                                        </div>
                                        <div className="flex items-center gap-3 mb-4 mt-2">
                                            <div className="w-10 h-10 rounded-full bg-violet-100 flex items-center justify-center flex-shrink-0">
                                                <Store className="w-5 h-5 text-violet-600" />
                                            </div>
                                            <div>
                                                <p className="font-black text-gray-900 text-sm">Dealer Subscription — 6 Months</p>
                                                <p className="text-xs text-gray-500">Unlock exclusive dealer pricing for your shop</p>
                                            </div>
                                            {dealerPrice6m > 0 && (
                                                <span className="ml-auto text-xl font-black text-violet-700">
                                                    GH₵{dealerPrice6m.toFixed(2)}
                                                </span>
                                            )}
                                        </div>
                                        <div className="space-y-2 mb-4 text-sm text-gray-600">
                                            <div className="flex items-center gap-2"><CheckCircle className="w-4 h-4 text-violet-500 flex-shrink-0" /> Access dealer cost prices on all data packages</div>
                                            <div className="flex items-center gap-2"><CheckCircle className="w-4 h-4 text-violet-500 flex-shrink-0" /> Your shop earns from dealer-tier rates for 6 months</div>
                                            <div className="flex items-center gap-2"><Calendar className="w-4 h-4 text-violet-400 flex-shrink-0" /> 180 days of dealer access from payment date</div>
                                        </div>
                                        <Button
                                            onClick={() => handleDealerSubscribeClick('dealer_6m')}
                                            disabled={isLoading || dealerPrice6m <= 0}
                                            className="w-full bg-violet-600 hover:bg-violet-700 text-white font-black h-11 rounded-xl"
                                        >
                                            {dealerPrice6m > 0 ? `Subscribe — GH₵${dealerPrice6m.toFixed(2)}` : 'Loading price...'}
                                        </Button>
                                    </div>
                                </div>
                            )}

                            {/* Secure Badge Section */}
                            <div className="w-full max-w-3xl">
                                <div className="bg-white/60 backdrop-blur-xl rounded-2xl p-6 sm:p-10 border-2 border-[#EEEEEE] shadow-[0_8px_30px_rgba(238,238,238,0.8)] flex flex-col items-center text-center space-y-6">
                                    <div className="inline-flex items-center gap-2 text-amber-600 bg-yellow-100/50 px-4 py-1.5 rounded-full border border-yellow-200/50">
                                        <Zap className="w-5 h-5 fill-current" />
                                        <span className="text-xs font-black uppercase tracking-[0.2em]">FAST & SECURE</span>
                                    </div>
                                    <p className="text-base text-gray-500 font-bold leading-relaxed max-w-xl">
                                        Upgrade your account in seconds using mobile money direct push. Your benefits start immediately upon approval.
                                    </p>
                                    <div className="flex items-center gap-3 pt-2 grayscale opacity-50">
                                        <div className="w-7 h-7 bg-gray-200 rounded-lg flex items-center justify-center text-[10px] font-black text-gray-500 border border-gray-300">?</div>
                                        <span className="text-[11px] font-black text-gray-400 uppercase tracking-widest">SECURE PAYMENTS BY MOOLRE</span>
                                    </div>
                                </div>
                            </div>
                        </>
                    )}
                </div>

                <Dialog open={showPaymentModal && !pollingRef} onOpenChange={setShowPaymentModal}>
                    <DialogContent className="sm:max-w-md">
                        <DialogHeader>
                            <DialogTitle>Complete Payment</DialogTitle>
                            <DialogDescription>
                                Enter your Mobile Money number to receive the payment prompt.
                            </DialogDescription>
                        </DialogHeader>

                        <div className="space-y-4 py-4">
                            {/* Wallet vs gateway. Wallet is instant — no prompt to approve
                                — so it is offered first whenever the balance covers it. */}
                            <div className="space-y-2">
                                <Label className="text-sm text-muted-foreground block">Payment method</Label>
                                <div className="flex gap-1 p-1 rounded-xl bg-muted w-full">
                                    <button
                                        type="button"
                                        onClick={() => setPayWithWallet(true)}
                                        disabled={!canAffordUpgradeWithWallet}
                                        className={cn(
                                            'flex-1 py-2 px-2 rounded-lg text-sm font-medium transition-all',
                                            payWithWallet
                                                ? 'bg-white shadow text-foreground'
                                                : 'text-muted-foreground hover:text-foreground',
                                            !canAffordUpgradeWithWallet && 'opacity-50 cursor-not-allowed'
                                        )}
                                    >
                                        <Wallet className="w-4 h-4 inline mr-1.5 -mt-0.5" />
                                        Wallet
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => setPayWithWallet(false)}
                                        className={cn(
                                            'flex-1 py-2 px-2 rounded-lg text-sm font-medium transition-all',
                                            !payWithWallet
                                                ? 'bg-white shadow text-foreground'
                                                : 'text-muted-foreground hover:text-foreground'
                                        )}
                                    >
                                        <Smartphone className="w-4 h-4 inline mr-1.5 -mt-0.5" />
                                        MoMo / Card
                                    </button>
                                </div>
                                <p className="text-xs text-muted-foreground">
                                    {payWithWallet
                                        ? `Balance GHS ${walletBalance.toFixed(2)} — activates instantly, no phone approval needed.`
                                        : canAffordUpgradeWithWallet
                                            ? `Wallet balance GHS ${walletBalance.toFixed(2)} available.`
                                            : `Wallet balance GHS ${walletBalance.toFixed(2)} — not enough for this plan.`}
                                </p>
                            </div>

                            {!payWithWallet && (
                                <div className="space-y-2">
                                    <Label className="text-sm text-muted-foreground block">Pay via</Label>
                                    <div className="flex gap-1 p-1 rounded-xl bg-muted w-full">
                                        {SCOPE_PROVIDERS.web.map((id) => (
                                            <button
                                                key={id}
                                                type="button"
                                                onClick={() => setWebPaymentProvider(id)}
                                                className={cn(
                                                    'flex-1 py-1.5 px-2 rounded-lg text-sm font-medium transition-all',
                                                    webPaymentProvider === id
                                                        ? 'bg-white shadow text-foreground'
                                                        : 'text-muted-foreground hover:text-foreground'
                                                )}
                                            >
                                                {PROVIDER_LABEL[id]}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {!payWithWallet && isMomoPromptProvider(webPaymentProvider) && (
                                <>
                                    <div className="space-y-2">
                                        <Label htmlFor="network">Network</Label>
                                        <Select value={paymentNetwork} onValueChange={setPaymentNetwork}>
                                            <SelectTrigger>
                                                <SelectValue placeholder="Select network" />
                                            </SelectTrigger>
                                            <SelectContent>
                                                <SelectItem value="MTN">MTN</SelectItem>
                                                <SelectItem value="Telecel">Telecel</SelectItem>
                                                <SelectItem value="AT">AT</SelectItem>
                                            </SelectContent>
                                        </Select>
                                    </div>
                                    <div className="space-y-2">
                                        <Label htmlFor="phone">Mobile Money Number</Label>
                                        <div className="relative">
                                            <Phone className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                                            <Input
                                                id="phone"
                                                type="tel"
                                                placeholder="024XXXXXXX"
                                                className="pl-9"
                                                value={paymentPhone}
                                                onChange={(e) => setPaymentPhone(e.target.value)}
                                            />
                                        </div>
                                    </div>
                                </>
                            )}
                        </div>

                        <div className="flex gap-3 justify-end mt-4">
                            <Button variant="outline" onClick={() => setShowPaymentModal(false)}>
                                Cancel
                            </Button>
                            <Button
                                onClick={handleUpgradeSubmit}
                                disabled={isProcessing !== null || (!payWithWallet && isMomoPromptProvider(webPaymentProvider) && !paymentPhone)}
                                className="bg-black text-[#FFCE00] hover:bg-black/90"
                            >
                                {isProcessing !== null ? (
                                    <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Processing</>
                                ) : payWithWallet ? (
                                    `Pay GHS ${selectedPlanPrice.toFixed(2)} from Wallet`
                                ) : webPaymentProvider === 'paystack' ? (
                                    'Pay with Paystack'
                                ) : (
                                    'Send Prompt'
                                )}
                            </Button>
                        </div>
                    </DialogContent>
                </Dialog>

                {/* Polling Modal (Fullscreen Spinner) */}
                {pollingRef && (
                    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-[100] p-6 backdrop-blur-sm">
                        <div className="flex flex-col items-center gap-6 max-w-sm w-full bg-white rounded-2xl p-8 shadow-2xl text-center">
                            <div className="relative w-16 h-16 flex items-center justify-center">
                                <div className="absolute inset-0 border-4 border-amber-100 rounded-full" />
                                <div className="absolute inset-0 border-4 border-amber-500 rounded-full border-t-transparent animate-spin" />
                                <Smartphone className="w-6 h-6 text-amber-500" />
                            </div>
                            <div className="space-y-2">
                                <h2 className="text-xl font-black text-gray-900">
                                    {paymentPhone ? 'Awaiting Approval' : 'Confirming Payment'}
                                </h2>
                                <p className="text-sm font-medium text-gray-500">
                                    {paymentPhone
                                        ? `Please check your phone (${paymentPhone}) and authorize the transaction to activate your premium membership.`
                                        : 'Please wait while we confirm your payment and activate your membership.'}
                                </p>
                            </div>
                            <p className="text-xs text-amber-600 bg-amber-50 px-3 py-1.5 rounded-full font-bold">
                                Do not close this page
                            </p>
                        </div>
                    </div>
                )}


                {/* OTP Modal */}
                <Dialog open={otpRequired} onOpenChange={(open) => !open && setOtpRequired(false)}>
                    <DialogContent className="sm:max-w-md">
                        <DialogHeader>
                            <DialogTitle>OTP Verification</DialogTitle>
                            <DialogDescription>
                                Please enter the OTP sent to your phone to complete the payment.
                            </DialogDescription>
                        </DialogHeader>
                        <div className="flex flex-col space-y-4 py-4">
                            <div className="space-y-2">
                                <Label htmlFor="otp">Enter OTP</Label>
                                <Input
                                    id="otp"
                                    type="text"
                                    placeholder="Enter code"
                                    value={otpCode}
                                    onChange={(e) => setOtpCode(e.target.value)}
                                    className="h-12 text-center text-2xl tracking-widest font-bold"
                                />
                            </div>
                        </div>
                        <div className="flex gap-3 justify-end">
                            <Button variant="outline" onClick={() => setOtpRequired(false)}>
                                Cancel
                            </Button>
                            <Button
                                onClick={handleVerifyOtp}
                                disabled={isProcessing !== null || !otpCode}
                                className="bg-black text-[#FFCE00] hover:bg-black/90"
                            >
                                {isProcessing !== null ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Verify & Continue'}
                            </Button>
                        </div>
                    </DialogContent>
                </Dialog>
            </div>
        </>
    )
}
