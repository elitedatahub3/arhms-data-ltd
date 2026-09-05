'use client'

import { useEffect, useRef, useState, Suspense } from 'react'
import { useAuth } from '@/contexts/auth-context'
import { useSearchParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import { formatCurrency, formatDate, calculatePaystackFee, cn } from '@/lib/utils'
import { resolveProvider, isMomoPromptProvider, type PaymentProvider } from '@/lib/payment-provider'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Separator } from '@/components/ui/separator'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    DialogFooter
} from '@/components/ui/dialog'
import {
    Wallet,
    Plus,
    ArrowUpRight,
    ArrowDownLeft,
    CreditCard,
    Smartphone,
    Building,
    Loader2,
    TrendingUp,
    TrendingDown
} from 'lucide-react'
import { toast } from 'sonner'
import { WalletTransaction } from '@/types/supabase'


const QUICK_AMOUNTS = [5, 10, 20, 50]
const MIN_AMOUNT = 5

function WalletContent() {
    const { dbUser, isAdmin } = useAuth()
    const router = useRouter()
    const [walletBalance, setWalletBalance] = useState(0)
    const [totalCredited, setTotalCredited] = useState(0)
    const [totalDebited, setTotalDebited] = useState(0)
    const [transactions, setTransactions] = useState<WalletTransaction[]>([])
    const [isLoading, setIsLoading] = useState(true)
    const [topUpAmount, setTopUpAmount] = useState('')
    const [paymentPhone, setPaymentPhone] = useState('')
    const [paymentNetwork, setPaymentNetwork] = useState('')
    const [pollingRef, setPollingRef] = useState<string | null>(null)
    const [isProcessing, setIsProcessing] = useState(false)
    const [paystackFeePercent, setPaystackFeePercent] = useState(1.95)
    const [otpRequired, setOtpRequired] = useState(false)
    const [otpCode, setOtpCode] = useState('')
    // The gateway's own words for the customer. Paystack varies the instruction per
    // charge — a one-time password on some numbers, a PIN prompt on others — so
    // asserting one of them in fixed copy tells roughly a third of customers to do
    // the wrong thing.
    const [otpMessage, setOtpMessage] = useState('')
    const [paymentReference, setPaymentReference] = useState<string | null>(null)
    const [webPaymentProvider, setWebPaymentProvider] = useState<PaymentProvider>('moolre')
    const searchParams = useSearchParams()

    useEffect(() => {
        if (dbUser) {
            fetchWalletData()
        }
    }, [dbUser])

    // Prefill the registered number as a convenience — the field stays editable, so
    // the customer can replace it with whatever number they want to pay from.
    useEffect(() => {
        if (dbUser?.phone_number && !paymentPhone) {
            setPaymentPhone(dbUser.phone_number)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [dbUser?.phone_number])



    useEffect(() => {
        const success = searchParams.get('success')
        const error = searchParams.get('error')
        const paystackRef = searchParams.get('reference')

        if (success === 'true') {
            toast.success('Wallet topped up successfully!')
            fetchWalletData()
            router.replace('/dashboard/wallet')
        } else if (paystackRef && !success && !error) {
            // Returning from Paystack checkout — start polling for webhook completion
            setPollingRef(paystackRef)
            setIsProcessing(true)
            router.replace('/dashboard/wallet')
        } else if (error) {
            let message = 'Failed to process payment'
            if (error === 'payment_failed') message = 'Payment was not successful'
            if (error === 'verification_failed') message = 'Could not verify payment'
            if (error === 'no_reference') message = 'Invalid payment reference'
            toast.error(message)
            router.replace('/dashboard/wallet')
        }
    }, [searchParams, router])

    useEffect(() => {
        let interval: NodeJS.Timeout
        if (pollingRef) {
            // A MoMo prompt expires in a couple of minutes. Polling past that told the
            // customer nothing new and kept the tab hitting the gateway indefinitely, so
            // give up at 3 minutes. Nothing is lost by stopping: the Hubtel webhook
            // credits the wallet whenever it lands, and the reconciliation sweep catches
            // anything the webhook misses — neither needs this tab to stay open.
            const startedAt = Date.now()
            const GIVE_UP_MS = 3 * 60 * 1000

            interval = setInterval(async () => {
                if (Date.now() - startedAt > GIVE_UP_MS) {
                    clearInterval(interval)
                    setPollingRef(null)
                    setIsProcessing(false)
                    toast.info('Still waiting on your approval. If you approve the prompt, your wallet is credited automatically.')
                    return
                }
                try {
                    const res = await fetch(`/api/payments/verify?reference=${pollingRef}`, {
                        headers: { 'Accept': 'application/json' }
                    })
                    const data = await res.json()

                    if (data.status === 'completed') {
                        clearInterval(interval)
                        setPollingRef(null)
                        setIsProcessing(false)
                        toast.success('Payment completed successfully!')
                        fetchWalletData()
                        setTopUpAmount('')
                        router.replace('/dashboard/wallet')
                    } else if (data.status === 'failed') {
                        clearInterval(interval)
                        setPollingRef(null)
                        setIsProcessing(false)
                        toast.error(data.message || 'Payment failed or cancelled.')
                    }
                } catch (e) {
                    console.error('Polling error', e)
                }
            }, 3000)
        }
        return () => clearInterval(interval)
    }, [pollingRef])

    const fetchWalletData = async () => {
        try {
            const [walletRes, txnsRes, feeSettingRes] = await Promise.all([
                // Fetch wallet
                supabase
                    .from('wallets')
                    .select('*')
                    .eq('user_id', dbUser?.id as any)
                    .single(),

                // Fetch top-up transactions
                supabase
                    .from('wallet_transactions')
                    .select('*')
                    .eq('user_id', dbUser?.id as any)
                    .eq('type', 'credit')
                    .or('source.eq.payment,source.eq.admin')
                    .order('created_at', { ascending: false })
                    .limit(50),

                // Fetch settings
                supabase
                    .from('admin_settings')
                    .select('key, value')
                    .in('key', ['paystack_fee_percent', 'agent_paystack_fee_percent', 'active_payment_provider_web'])
            ])

            const wallet = walletRes.data
            const txns = txnsRes.data
            const feeSettings = feeSettingRes.data

            if (wallet) {
                setWalletBalance((wallet as any).balance)
                setTotalCredited((wallet as any).total_credited)
                setTotalDebited((wallet as any).total_spent)
            }

            setTransactions(txns || [])

            if (feeSettings && Array.isArray(feeSettings)) {
                const settings = feeSettings as any[]

                const providerRow = settings.find(s => s.key === 'active_payment_provider_web')
                if (providerRow) {
                    setWebPaymentProvider(resolveProvider(providerRow.value))
                }

                let targetKey = 'paystack_fee_percent'
                if (dbUser?.role === 'agent') {
                    targetKey = 'agent_paystack_fee_percent'
                }
                const feeSetting = settings.find(s => s.key === targetKey) || settings.find(s => s.key === 'paystack_fee_percent')
                if (feeSetting && feeSetting.value) {
                    const val = feeSetting.value
                    const parsed = typeof val === 'string' ? parseFloat(val) : (typeof val === 'number' ? val : 1.95)
                    if (!isNaN(parsed)) setPaystackFeePercent(parsed)
                }
            }
        } catch (error) {
            console.error('Error fetching wallet data:', error)
        } finally {
            setIsLoading(false)
        }
    }

    const handleQuickAmount = (amount: number) => {
        setTopUpAmount(amount.toString())
    }

    const handleTopUp = async () => {
        const amount = parseFloat(topUpAmount)

        if (isNaN(amount) || amount < MIN_AMOUNT) {
            toast.error(`Minimum amount is ${formatCurrency(MIN_AMOUNT)}`)
            return
        }

        if (!dbUser?.email) {
            toast.error('Please update your profile with an email address')
            return
        }

        if (isMomoPromptProvider(webPaymentProvider) && (!paymentPhone || !paymentNetwork)) {
            toast.error('Please provide a valid Mobile Money number and select a network')
            return
        }


        setIsProcessing(true)

        try {
            const response = await fetch('/api/payments/initialize', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ amount, phone: paymentPhone, network: paymentNetwork, provider: webPaymentProvider }),
            })

            const data = await response.json()

            // A charge is already live for this number — hand the customer back to it
            // instead of an error they cannot act on. Starting a new payment would
            // cancel the code the previous one sent.
            if (!response.ok && data.resumable && data.reference) {
                setPaymentReference(data.reference)
                if (data.otpRequired) {
                    setOtpMessage(data.error || '')
                    setOtpRequired(true)
                } else {
                    toast.info(data.error || 'A payment prompt is already waiting on your phone.')
                    setPollingRef(data.reference)
                }
                setIsProcessing(false)
                return
            }

            if (!response.ok) {
                throw new Error(data.error || 'Failed to initialize payment')
            }

            if (data.gateway === 'paystack') {
                window.location.href = data.authorization_url
                return
            }

            // Hubtel / Moolre: prompt sent — start polling for webhook completion
            if (data.gateway === 'hubtel') {
                toast.success(data.message || 'Payment prompt sent! Please approve on your phone.')
                setPollingRef(data.reference)
                setIsProcessing(false)
                return
            }

            // Moolre and Paystack MoMo: an OTP step only when the gateway asked for
            // one. This used to open the modal unconditionally, which was harmless
            // while Moolre always wanted a code — Paystack asks only on Telecel and
            // AirtelTigo, so an unguarded modal would sit there on MTN waiting for a
            // code that is never sent while the prompt goes unanswered on the handset.
            setPaymentReference(data.reference)
            if (data.otpRequired) {
                setOtpMessage(data.message || '')
                setOtpRequired(true)
            } else {
                toast.success(data.message || 'Payment prompt sent! Please approve on your phone.')
                setPollingRef(data.reference)
            }
            setIsProcessing(false)
        } catch (error: any) {
            toast.error(error.message || 'Failed to process payment')
            setIsProcessing(false)
        }
    }

    const handleVerifyOtp = async () => {
        if (!otpCode || otpCode.trim().length < 1) {
            toast.error('Please enter the OTP sent to your phone')
            return
        }

        setIsProcessing(true)
        try {
            const response = await fetch('/api/payments/initialize', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ 
                    amount: parseFloat(topUpAmount), 
                    phone: paymentPhone, 
                    network: paymentNetwork,
                    otpCode: otpCode.trim(),
                    reference: paymentReference,
                    provider: webPaymentProvider
                }),
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
            setIsProcessing(false)
            // Keep modal open so user can retry
        }
    }

    // Auto-submit the OTP as soon as a full 6-digit code is entered, so the
    // user doesn't have to click "Verify". Guarded against double-submission
    // and against re-firing on the same code after a failed attempt.
    const lastSubmittedOtp = useRef<string>('')
    useEffect(() => {
        const code = otpCode.trim()
        if (
            otpRequired &&
            !isProcessing &&
            /^\d{6}$/.test(code) &&
            code !== lastSubmittedOtp.current
        ) {
            lastSubmittedOtp.current = code
            handleVerifyOtp()
        }
    }, [otpCode, otpRequired, isProcessing])

    const HUBTEL_FEE_PERCENT = 1.8
    const fee = topUpAmount
        ? webPaymentProvider === 'hubtel'
            ? parseFloat(((parseFloat(topUpAmount) || 0) * (HUBTEL_FEE_PERCENT / 100)).toFixed(2))
            : calculatePaystackFee(parseFloat(topUpAmount) || 0, paystackFeePercent)
        : 0
    const totalAmount = topUpAmount ? (parseFloat(topUpAmount) || 0) + fee : 0

    if (isLoading) {
        return (
            <div className="space-y-6">
                <Skeleton className="h-48 w-full max-w-md" />
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    {[...Array(3)].map((_, i) => (
                        <Skeleton key={i} className="h-24" />
                    ))}
                </div>
            </div>
        )
    }

    return (
        <div className="space-y-6">
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-bold">Load Wallet</h1>
                    <p className="text-muted-foreground">Top up your wallet to continue shopping</p>
                </div>
            </div>

            {/* Balance Card at top for Agents */}
            {dbUser?.role === 'agent' && (
                <div className="w-full">
                    <Card id="wallet-balance-card" className="overflow-hidden border-2 border-[#1A1A1A] shadow-lg">
                        <div className="bg-[#1A1A1A] p-6 text-white">
                            <div className="flex items-center justify-between mb-6">
                                <div className="flex items-center gap-2">
                                    <Wallet className="w-6 h-6 text-[#FACC15]" />
                                    <span className="font-semibold uppercase tracking-widest text-xs text-[#FACC15]">Wallet Balance</span>
                                </div>
                                <Badge className="bg-[#FACC15] text-black border-0 font-bold">Active</Badge>
                            </div>
                            <div className="flex flex-col sm:flex-row sm:items-baseline justify-between gap-4">
                                <div>
                                    <p className="text-sm text-gray-400 mb-1">Available Balance</p>
                                    <p className="text-4xl font-black">{formatCurrency(walletBalance)}</p>
                                </div>
                                <div className="flex gap-8 pt-4 sm:pt-0 border-t sm:border-t-0 border-gray-800">
                                    <div>
                                        <div className="flex items-center gap-1 text-gray-400 text-xs mb-1">
                                            <TrendingUp className="w-3.5 h-3.5" />
                                            <span>Credited</span>
                                        </div>
                                        <p className="font-bold text-lg">{formatCurrency(totalCredited)}</p>
                                    </div>
                                    <div>
                                        <div className="flex items-center gap-1 text-gray-400 text-xs mb-1">
                                            <TrendingDown className="w-3.5 h-3.5" />
                                            <span>Spent</span>
                                        </div>
                                        <p className="font-bold text-lg">{formatCurrency(totalDebited)}</p>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </Card>
                </div>
            )}





            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                <div className={dbUser?.role === 'agent' ? 'lg:col-span-3' : 'lg:col-span-1'}>
                    <Card className={cn("overflow-hidden", dbUser?.role === 'agent' && "hidden")}>
                        <div className="bg-[#FACC15] p-6 text-[#1A1A1A]">
                            <div className="flex items-center justify-between mb-6">
                                <div className="flex items-center gap-2">
                                    <Wallet className="w-6 h-6" />
                                    <span className="font-medium">Your Wallet</span>
                                </div>
                                <Badge className="bg-[#1A1A1A]/10 text-[#1A1A1A] border-0">Active</Badge>
                            </div>
                            <p className="text-sm text-[#1A1A1A]/70 mb-1">Available Balance</p>
                            <p className="text-4xl font-bold mb-6">{formatCurrency(walletBalance)}</p>

                            <div className="grid grid-cols-2 gap-4 pt-4 border-t border-[#1A1A1A]/10">
                                <div>
                                    <div className="flex items-center gap-1 text-[#1A1A1A]/70 text-sm mb-1">
                                        <TrendingUp className="w-4 h-4" />
                                        <span>Credited</span>
                                    </div>
                                    <p className="font-semibold">{formatCurrency(totalCredited)}</p>
                                </div>
                                <div>
                                    <div className="flex items-center gap-1 text-[#1A1A1A]/70 text-sm mb-1">
                                        <TrendingDown className="w-4 h-4" />
                                        <span>Spent</span>
                                    </div>
                                    <p className="font-semibold">{formatCurrency(totalDebited)}</p>
                                </div>
                            </div>
                        </div>
                    </Card>
                </div>

                {/* Top Up Card */}
                <div id="top-up-form" className={dbUser?.role === 'agent' ? 'lg:col-span-3' : 'lg:col-span-2'}>
                    <Card>
                        <CardHeader>
                            <div className="flex flex-col">
                                <CardTitle className="text-base sm:text-lg flex items-center gap-2 font-semibold text-black">
                                    <Plus className="w-5 h-5 text-blue-600" />
                                    Top Up Wallet
                                </CardTitle>
                                {dbUser?.role === 'agent' && (
                                    <span className="text-xs sm:text-sm font-bold text-[#E60000] ml-7">Paystack Charges Applied</span>
                                )}
                            </div>
                            <CardDescription className="mt-2">
                                Add funds to your wallet using Mobile Money
                            </CardDescription>
                        </CardHeader>
                        {/* Provider is chosen by the admin setting (active_payment_provider_web); users can't switch. */}
                        <form onSubmit={(e) => { e.preventDefault(); handleTopUp(); }}>
                            <CardContent className="space-y-6">
                                {/* Quick Amounts */}
                                <div>
                                    <Label className="text-sm text-muted-foreground mb-3 block">Quick Select</Label>
                                    <div className="flex overflow-x-auto gap-3 pb-2 w-full sm:grid sm:grid-cols-4">
                                        {QUICK_AMOUNTS.map((amount) => (
                                            <Button
                                                key={amount}
                                                type="button"
                                                variant={topUpAmount === amount.toString() ? 'default' : 'outline'}
                                                onClick={() => handleQuickAmount(amount)}
                                                className="h-12 flex-shrink-0 min-w-[80px] sm:min-w-0"
                                            >
                                                {formatCurrency(amount)}
                                            </Button>
                                        ))}
                                    </div>
                                </div>

                                {/* Custom Amount */}
                                <div>
                                    <Label htmlFor="amount">Custom Amount (GHS)</Label>
                                    <div className="relative mt-2">
                                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">GHS</span>
                                        <Input
                                            id="amount"
                                            type="number"
                                            placeholder="Enter amount"
                                            value={topUpAmount}
                                            onChange={(e) => setTopUpAmount(e.target.value)}
                                            className="pl-12 h-12 text-lg"
                                            min={MIN_AMOUNT}
                                        />
                                    </div>
                                    <p className="text-xs text-muted-foreground mt-1">Minimum: {formatCurrency(MIN_AMOUNT)}</p>
                                </div>

                                {/* Summary */}
                                {topUpAmount && parseFloat(topUpAmount) >= MIN_AMOUNT && (
                                    <div className="p-4 rounded-xl bg-muted/50 space-y-2">
                                        <div className="flex justify-between text-sm">
                                            <span className="text-muted-foreground">Top-up amount</span>
                                            <span>{formatCurrency(parseFloat(topUpAmount))}</span>
                                        </div>
                                        <div className="flex justify-between text-sm">
                                            <span className="text-muted-foreground">
                                                Transaction fee ({webPaymentProvider === 'hubtel' ? '1.8' : webPaymentProvider === 'moolre' ? '0' : paystackFeePercent}%)
                                            </span>
                                            <span>{formatCurrency(fee)}</span>
                                        </div>
                                        <Separator />
                                        <div className="flex justify-between font-semibold">
                                            <span>Total to pay</span>
                                            <span className="text-primary">{formatCurrency(totalAmount)}</span>
                                        </div>
                                    </div>
                                )}

                                {/* Payment Details — MoMo fields for Moolre and Hubtel */}
                                {isMomoPromptProvider(webPaymentProvider) && (
                                    <div>
                                        <Label className="text-sm text-muted-foreground mb-3 block">Payment Details</Label>
                                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                            <div>
                                                <Label htmlFor="network" className="text-xs">Network</Label>
                                                <Select value={paymentNetwork} onValueChange={setPaymentNetwork}>
                                                    <SelectTrigger id="network" className="mt-1 h-12">
                                                        <SelectValue placeholder="Select Network" />
                                                    </SelectTrigger>
                                                    <SelectContent>
                                                        <SelectItem value="MTN">MTN MoMo</SelectItem>
                                                        <SelectItem value="Telecel">Telecel Cash</SelectItem>
                                                        <SelectItem value="AT">AT Money</SelectItem>
                                                    </SelectContent>
                                                </Select>
                                            </div>
                                            <div>
                                                <Label htmlFor="phone" className="text-xs flex items-center gap-1">
                                                    Mobile Number
                                                </Label>
                                                <Input
                                                    id="phone"
                                                    type="tel"
                                                    inputMode="tel"
                                                    placeholder="e.g. 0540000000"
                                                    value={paymentPhone}
                                                    onChange={(e) => {
                                                        setPaymentPhone(e.target.value)
                                                    }}
                                                    className="mt-1 h-12"
                                                />

                                            </div>
                                        </div>
                                    </div>
                                )}

                                {/* Payment Methods Icons (Visual Only) */}
                                <div>
                                    <Label className="text-sm text-muted-foreground mb-3 block">Payment Methods</Label>
                                    <div className="grid grid-cols-3 gap-3">
                                        <div className="p-4 rounded-xl border bg-background text-center">
                                            <Smartphone className="w-6 h-6 mx-auto mb-2 text-yellow-500" />
                                            <span className="text-sm">Mobile Money</span>
                                        </div>
                                        <div className="p-4 rounded-xl border bg-background text-center">
                                            <CreditCard className="w-6 h-6 mx-auto mb-2 text-blue-500" />
                                            <span className="text-sm">Card</span>
                                        </div>
                                        <div className="p-4 rounded-xl border bg-background text-center">
                                            <Building className="w-6 h-6 mx-auto mb-2 text-purple-500" />
                                            <span className="text-sm">Bank Transfer</span>
                                        </div>
                                    </div>
                                </div>

                                {/* Pay Button */}
                                <Button
                                    type="submit"
                                    className="w-full h-12 text-lg bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-700 hover:to-purple-700"
                                    disabled={
                                        isProcessing ||
                                        !topUpAmount ||
                                        parseFloat(topUpAmount) < MIN_AMOUNT ||
                                        (isMomoPromptProvider(webPaymentProvider) && (!paymentPhone || !paymentNetwork))
                                    }
                                >
                                    {isProcessing ? (
                                        <>
                                            <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                                            {pollingRef ? 'Waiting for Approval...' : 'Processing...'}
                                        </>
                                    ) : webPaymentProvider === 'paystack' ? (
                                        <>
                                            <CreditCard className="w-5 h-5 mr-2" />
                                            Pay with Paystack
                                        </>
                                    ) : webPaymentProvider === 'hubtel' ? (
                                        <>
                                            <Smartphone className="w-5 h-5 mr-2" />
                                            Pay
                                        </>
                                    ) : (
                                        <>
                                            <Smartphone className="w-5 h-5 mr-2" />
                                            Send Prompt
                                        </>
                                    )}
                                </Button>
                            </CardContent>
                        </form>
                    </Card>
                </div>
            </div>

            {/* Recent Transactions */}
            <Card id="recent-activity">
                <CardHeader>
                    <CardTitle>{dbUser?.role === 'agent' ? 'Recent Activity' : 'Today'}</CardTitle>
                </CardHeader>
                <CardContent>
                    {transactions.length === 0 ? (
                        <div className="text-center py-12">
                            <Wallet className="w-12 h-12 mx-auto text-muted-foreground/50 mb-4" />
                            <p className="text-muted-foreground">No transactions yet</p>
                        </div>
                    ) : (
                        <div className="space-y-4">
                            {transactions.map((txn) => (
                                <div
                                    key={txn.id}
                                    className="flex items-center justify-between p-4 rounded-xl bg-muted/30 hover:bg-muted/50 transition-colors"
                                >
                                    <div className="flex items-center gap-4">
                                        <div className={`w-10 h-10 rounded-full flex items-center justify-center ${txn.type === 'credit'
                                            ? 'bg-green-100 dark:bg-green-900/30'
                                            : 'bg-red-100 dark:bg-red-900/30'
                                            }`}>
                                            {txn.type === 'credit' ? (
                                                <ArrowDownLeft className="w-5 h-5 text-green-600" />
                                            ) : (
                                                <ArrowUpRight className="w-5 h-5 text-red-600" />
                                            )}
                                        </div>
                                        <div>
                                            <p className="font-medium">{txn.description}</p>
                                            <p className="text-sm text-muted-foreground">
                                                {formatDate(txn.created_at)}
                                            </p>
                                        </div>
                                    </div>
                                    <div className="text-right">
                                        <p className={`font-semibold ${txn.type === 'credit' ? 'text-green-600' : 'text-red-600'
                                            }`}>
                                            {txn.type === 'credit' ? '+' : '-'}{formatCurrency(txn.amount)}
                                        </p>
                                        <Badge variant={txn.status === 'completed' ? 'completed' : 'pending'} className="text-xs">
                                            {txn.status}
                                        </Badge>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </CardContent>
            </Card>

            {/* The gateway asked for a one-time code. Every other checkout in the app
                has had this dialog; this page had the state, the handler and the
                auto-submit effect but nothing to type into, so a code that arrived
                could never be entered. Telecel and AirtelTigo take this path far more
                often than MTN, which is why it went unnoticed. */}
            <Dialog
                open={otpRequired}
                onOpenChange={(open) => { if (!open) { setOtpRequired(false); setOtpCode('') } }}
            >
                <DialogContent className="w-[95%] max-w-sm rounded-2xl">
                    <DialogHeader>
                        <DialogTitle>Enter OTP</DialogTitle>
                        <DialogDescription>
                            {/* Paystack's instruction arrives without a full stop, so it
                                has to be punctuated before ours is appended or the two
                                sentences run together on screen. */}
                            {(otpMessage || `Your network sent a one-time code to ${paymentPhone || 'your phone'}`)
                                .trim().replace(/([^.!?])$/, '$1.')}
                            {' '}Enter it below to authorise this top-up. If nothing arrives within a minute, close this and try again.
                        </DialogDescription>
                    </DialogHeader>
                    <Input
                        autoFocus
                        inputMode="numeric"
                        placeholder="Enter OTP"
                        value={otpCode}
                        onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, ''))}
                        className="text-center text-lg tracking-widest"
                    />
                    <DialogFooter>
                        <Button
                            variant="outline"
                            onClick={() => { setOtpRequired(false); setOtpCode('') }}
                        >
                            Cancel
                        </Button>
                        {/* A 6-digit code submits itself via the effect above; the
                            button is for networks that send a shorter one. */}
                        <Button onClick={handleVerifyOtp} disabled={isProcessing || !otpCode.trim()}>
                            {isProcessing ? (
                                <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Verifying...</>
                            ) : 'Verify'}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

        </div>
    )
}

export default function WalletPage() {
    return (
        <Suspense fallback={
            <div className="space-y-6 p-6">
                <Skeleton className="h-48 w-full max-w-md" />
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    {[...Array(3)].map((_, i) => (
                        <Skeleton key={i} className="h-24" />
                    ))}
                </div>
            </div>
        }>
            <WalletContent />
        </Suspense>
    )
}
