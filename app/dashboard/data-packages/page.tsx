'use client'

import { useEffect, useState, useRef } from 'react'
import { useSearchParams } from 'next/navigation'
import { useAuth } from '@/contexts/auth-context'
import { refreshDashboardSummary } from '@/hooks/use-dashboard-summary'
import { supabase } from '@/lib/supabase'
import Link from 'next/link'
import { formatCurrency, getNetworkGradient, cn } from '@/lib/utils'
import { generateReferenceCode, calculatePaystackFee } from '@/lib/utils'
import { resolveProvider, isMomoPromptProvider, type PaymentProvider } from '@/lib/payment-provider'
import { validateGhanaianPhone, detectNetwork } from '@/lib/phone-validation'
import { NetworkIcon } from '@/components/network-icon'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { MtnRegistrationDialog } from '@/components/dashboard/mtn-registration-dialog'
import {
    Search,
    LayoutGrid,
    List,
    Wifi,
    Loader2,
    CheckCircle2,
    Check,
    AlertCircle,
    ShoppingCart,
    Plus,
    DollarSign,
    X,
    FileSpreadsheet,
    FileText,
    CloudUpload,
    ExternalLink,
    ShieldCheck,
    Smartphone,
    Receipt,
    Wallet,
    CreditCard
} from 'lucide-react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { DataPackage } from '@/types/supabase'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Trash2, Upload } from 'lucide-react'

/**
 * Numbers out of a MTN_NOT_REGISTERED 409 body (see registrationRequiredBody in
 * lib/mtn-registration-gate.ts). Single-number routes send only phoneNumber.
 */
function registrationNumbers(data: any): string[] {
    return data?.registration?.phoneNumbers
        || (data?.registration?.phoneNumber ? [data.registration.phoneNumber] : [])
}

// Colours for the checkout sheet's package banner, matching the storefront sheet.
const getNetworkSheetStyle = (net: string) => {
    switch (net) {
        case 'Telecel':
            return { bg: 'bg-[#da291c]', text: 'text-white', iconBg: 'bg-white/20' }
        case 'AT-iShare':
            return { bg: 'bg-[#2463eb]', text: 'text-white', iconBg: 'bg-white/20' }
        case 'AT-BigTime':
            return { bg: 'bg-[#8b5cf6]', text: 'text-white', iconBg: 'bg-white/20' }
        case 'MTN':
        case 'Special MTN Mashup':
        case 'EXPRESS MTN':
            return { bg: 'bg-[#FFCC00]', text: 'text-black', iconBg: 'bg-white/30' }
        default:
            return { bg: 'bg-primary', text: 'text-primary-foreground', iconBg: 'bg-white/20' }
    }
}

// MoMo wallets that can be charged — not the bundle's network
const PAY_NETWORKS: { id: string; label: string; dot: string }[] = [
    { id: 'MTN', label: 'MTN', dot: 'bg-[#FFCC00]' },
    { id: 'Telecel', label: 'Telecel', dot: 'bg-[#da291c]' },
    { id: 'AT', label: 'AirtelTigo', dot: 'bg-[#2463eb]' },
]

interface ValidationResult {
    lineNumber: number
    phoneNumber: string
    volume: number
    packagePrice: number
    isValid: boolean
    errorMessage?: string
    packageId?: string
    packageName?: string
    /**
     * MTN whitelist status, filled in by the Validate step so the buyer can see which
     * numbers will be delayed BEFORE paying. 'unknown' means the check could not be
     * completed (or the gate is off) — those lines are treated as fine.
     */
    registrationStatus?: 'registered' | 'unregistered' | 'unknown'
}


const ALL_NETWORKS = ['MTN', 'Telecel', 'AT-iShare', 'AT-BigTime', 'Special MTN Mashup', 'EXPRESS MTN'] as const

/** '1GB' → 1, '500MB' → 0.5 — used to summarise settled direct-pay bulk orders. */
function sizeToGb(size: string): number {
    const value = parseFloat(String(size).replace(/[^\d.]/g, '')) || 0
    return /mb/i.test(String(size)) ? value / 1000 : value
}

export default function DataPackagesPage() {
    const { dbUser, session, isSubAgent, subAgentCheckDone } = useAuth()
    const router = useRouter()
    const searchParams = useSearchParams()

    const [packages, setPackages] = useState<DataPackage[]>([])
    const [filteredPackages, setFilteredPackages] = useState<DataPackage[]>([])
    const [selectedNetwork, setSelectedNetwork] = useState<string>(
        searchParams.get('network') || 'MTN'
    )
    const [searchQuery, setSearchQuery] = useState('')
    const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid')
    const [isLoading, setIsLoading] = useState(true)
    // A sub-agent pays their upline's sub_price, not the platform price. null
    // until the fetch lands (or for non-subs, who never need it).
    const [subPrices, setSubPrices] = useState<Record<string, number> | null>(null)
    const pricingReady = subAgentCheckDone && (!isSubAgent || subPrices !== null)
    const [walletBalance, setWalletBalance] = useState(0)
    const [hideMashup, setHideMashup] = useState(false)
    const [hideExpressMtn, setHideExpressMtn] = useState(false)
    const [hideStandardMtn, setHideStandardMtn] = useState(false)

    const [ordersToday, setOrdersToday] = useState(0)

    // Purchase dialog state
    const [selectedPackage, setSelectedPackage] = useState<DataPackage | null>(null)
    const [phoneNumber, setPhoneNumber] = useState('')
    const [phoneError, setPhoneError] = useState('')
    const [isPurchasing, setIsPurchasing] = useState(false)
    // Set when a purchase is refused because the recipient's MTN number is not
    // registered yet. Nothing was charged — the dialog is the whole outcome.
    const [registrationPrompt, setRegistrationPrompt] = useState<{ numbers: string[]; total?: number } | null>(null)
    const [purchaseSuccess, setPurchaseSuccess] = useState(false)
    const [purchaseDetails, setPurchaseDetails] = useState<{
        referenceCode: string
        network: string
        size: string
        phoneNumber: string
        price: number
        newBalance: number
    } | null>(null)
    // Idempotency: Generate a new referenceCode each time the modal opens
    const [currentReferenceCode, setCurrentReferenceCode] = useState('')

    // Payment method: wallet (instant debit) or direct (MoMo / card via gateway)
    const [paymentMethod, setPaymentMethod] = useState<'wallet' | 'direct'>('wallet')
    const [bulkPaymentMethod, setBulkPaymentMethod] = useState<'wallet' | 'direct'>('wallet')
    const [webPaymentProvider, setWebPaymentProvider] = useState<PaymentProvider>('moolre')
    const [paystackFeePercent, setPaystackFeePercent] = useState(1.95)
    const [momoPhone, setMomoPhone] = useState('')
    const [momoNetwork, setMomoNetwork] = useState('')
    // Single checkout: the bundle goes to `phoneNumber`, the MoMo prompt goes to
    // `momoPhone`, and the two are typed separately. A "use the same number" tick used
    // to mirror one into the other, but it echoed every keystroke from the beneficiary
    // box and read as the form typing for the buyer. The bulk checkout has always used
    // `momoPhone` on its own.
    const [singleMomoNetwork, setSingleMomoNetwork] = useState('')
    const [momoNetworkManual, setMomoNetworkManual] = useState(false)

    // Direct payment flow state
    const [pollingRef, setPollingRef] = useState<string | null>(null)
    const [pollingKind, setPollingKind] = useState<'single' | 'bulk'>('single')
    const [otpRequired, setOtpRequired] = useState(false)
    // Paystack's own instruction for this charge. It differs per number — a one-time
    // password on some, a PIN prompt on others — so fixed copy misinforms whichever
    // group it does not describe.
    const [otpMessage, setOtpMessage] = useState('')
    const [otpCode, setOtpCode] = useState('')
    const [isVerifyingOtp, setIsVerifyingOtp] = useState(false)
    // Gateway reference kept separate from currentReferenceCode, which is the
    // wallet path's order idempotency key.
    const [directPaymentRef, setDirectPaymentRef] = useState<string | null>(null)

    // Bulk success modal state
    const [bulkSuccess, setBulkSuccess] = useState(false)
    const [bulkSuccessDetails, setBulkSuccessDetails] = useState<{
        ordersPlaced: number
        totalCost: number
        newBalance: number
        orders: { phoneNumber: string; volume: number; packagePrice: number }[]
    } | null>(null)

    // Bulk Order State
    const [bulkInputType, setBulkInputType] = useState<'text' | 'excel' | null>(null)
    const [bulkText, setBulkText] = useState('')
    const [bulkNetwork, setBulkNetwork] = useState<string>('')
    const [validationResults, setValidationResults] = useState<ValidationResult[]>([])

    const [isValidating, setIsValidating] = useState(false)
    const [isSubmittingBulk, setIsSubmittingBulk] = useState(false)
    const [bulkFile, setBulkFile] = useState<File | null>(null)
    const textareaRef = useRef<HTMLTextAreaElement>(null)

    const totalBulkData = validationResults.reduce((sum, r) => sum + (r.isValid ? r.volume : 0), 0)
    const totalBulkCost = validationResults.reduce((sum, r) => sum + (r.isValid ? r.packagePrice : 0), 0)


    useEffect(() => {
        fetchPackages()
        fetchWalletBalance()
        fetchOrdersToday()
        fetchMashupSetting()
    }, [dbUser])

    useEffect(() => {
        if (!isSubAgent) return
        let active = true
        fetch('/api/dashboard/sub/package-prices')
            .then(r => (r.ok ? r.json() : null))
            .then(d => { if (active) setSubPrices(d?.prices ?? {}) })
            .catch(() => { if (active) setSubPrices({}) })
        return () => { active = false }
    }, [isSubAgent])

    // Prefill the MoMo number from the account profile
    useEffect(() => {
        if (dbUser?.phone_number && !momoPhone) setMomoPhone(dbUser.phone_number)
    }, [dbUser])

    // Paystack return leg — resume polling for the reference in the URL
    useEffect(() => {
        const ref = searchParams.get('reference')
        if (ref && ref.startsWith('DATA-')) {
            setPollingRef(ref)
            router.replace('/dashboard/data-packages')
        }
    }, [searchParams, router])

    // Poll the gateway until the direct payment settles
    useEffect(() => {
        if (!pollingRef) return

        let elapsed = 0
        const POLL_MS = 3000
        const TIMEOUT_MS = 180000 // 3 minutes

        const interval = setInterval(async () => {
            elapsed += POLL_MS

            if (elapsed >= TIMEOUT_MS) {
                clearInterval(interval)
                setPollingRef(null)
                setIsPurchasing(false)
                setIsSubmittingBulk(false)
                toast.error('Still waiting on payment confirmation. Check My Orders in a moment.')
                return
            }

            try {
                const res = await fetch(`/api/payments/verify?reference=${pollingRef}`, {
                    headers: { 'Accept': 'application/json' },
                })
                const data = await res.json()

                if (data.status === 'completed') {
                    const placedOrders = data.orders || []

                    // The settling caller writes the order references a moment
                    // after creating them — keep polling until they show up.
                    if (placedOrders.length === 0) return

                    clearInterval(interval)
                    setPollingRef(null)
                    setIsPurchasing(false)
                    setIsSubmittingBulk(false)

                    if (pollingKind === 'bulk') {
                        setBulkSuccess(true)
                        setBulkSuccessDetails({
                            ordersPlaced: placedOrders.length,
                            totalCost: placedOrders.reduce((sum: number, o: any) => sum + Number(o.price || 0), 0),
                            newBalance: walletBalance,
                            orders: placedOrders.map((o: any) => ({
                                phoneNumber: o.phone_number,
                                volume: sizeToGb(o.size),
                                packagePrice: Number(o.price || 0),
                            })),
                        })
                        setValidationResults([])
                        setBulkText('')
                        setBulkFile(null)
                    } else {
                        const order = placedOrders[0]
                        setPurchaseSuccess(true)
                        setPurchaseDetails({
                            referenceCode: order.reference_code,
                            network: order.network,
                            size: order.size,
                            phoneNumber: order.phone_number,
                            price: Number(order.price || 0),
                            newBalance: walletBalance,
                        })
                    }

                    setOrdersToday(prev => prev + placedOrders.length)
                    refreshDashboardSummary()
                    toast.success('Payment received — your order is being processed!')
                } else if (data.status === 'failed') {
                    clearInterval(interval)
                    setPollingRef(null)
                    setIsPurchasing(false)
                    setIsSubmittingBulk(false)
                    toast.error(data.message || data.error || 'Payment failed or was cancelled.')
                }
            } catch (e) {
                console.error('Polling error', e)
            }
        }, POLL_MS)

        return () => clearInterval(interval)
    }, [pollingRef, pollingKind, walletBalance])

    useEffect(() => {
        filterPackages()
    }, [packages, selectedNetwork, searchQuery, isSubAgent, subPrices])

    useEffect(() => {
        if (textareaRef.current) {
            textareaRef.current.style.height = 'auto'
            textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`
        }
    }, [bulkText])

    // One request for both groups of settings. They were two calls to the same
    // endpoint, fired together on mount — and on a phone each one is a round
    // trip before the page can price anything.
    const fetchMashupSetting = async () => {
        try {
            const res = await fetch('/api/admin-settings?keys=special_mtn_mashup_hidden,express_mtn_hidden,standard_mtn_hidden,active_payment_provider_web,paystack_fee_percent,agent_paystack_fee_percent')
            if (!res.ok) return
            const settings = await res.json()

            setHideMashup(String(settings.special_mtn_mashup_hidden) === 'true')
            setHideExpressMtn(String(settings.express_mtn_hidden) === 'true')
            setHideStandardMtn(String(settings.standard_mtn_hidden) === 'true')

            setWebPaymentProvider(resolveProvider(settings.active_payment_provider_web))

            const feeKey = dbUser?.role === 'agent' ? 'agent_paystack_fee_percent' : 'paystack_fee_percent'
            const feeVal = parseFloat(settings[feeKey] || settings.paystack_fee_percent || '1.95')
            if (!isNaN(feeVal)) setPaystackFeePercent(feeVal)
        } catch (_) {
            // keep defaults
        }
    }

    const fetchPackages = async () => {
        try {
            const { data, error } = await supabase
                .from('data_packages')
                .select('*')
                .eq('is_available', true)
                .order('sort_order', { ascending: true })

            if (error) throw error
            setPackages(data || [])
        } catch (error) {
            console.error('Error fetching packages:', error)
            toast.error('Failed to load packages')
        } finally {
            setIsLoading(false)
        }
    }

    const fetchWalletBalance = async () => {
        if (!dbUser) return

        const { data } = await supabase
            .from('wallets')
            .select('balance')
            .eq('user_id', dbUser.id)
            .single()

        setWalletBalance((data as any)?.balance || 0)
    }

    const fetchOrdersToday = async () => {
        if (!dbUser) return

        const today = new Date()
        today.setHours(0, 0, 0, 0)

        const { count, error } = await supabase
            .from('orders')
            .select('*', { count: 'exact', head: true })
            .eq('user_id', dbUser.id)
            .gte('created_at', today.toISOString())
            .neq('status', 'failed')

        if (!error) {
            setOrdersToday(count || 0)
        }
    }

    const filterPackages = () => {
        let filtered = packages

        // Sub-agents only see packages their upline has priced; the server
        // refuses the rest, so listing them would just be a dead Buy button.
        if (isSubAgent) {
            filtered = filtered.filter(p => !!subPrices?.[p.id])
        }

        // Filter by network
        filtered = filtered.filter(p => p.network === selectedNetwork)

        if (searchQuery) {
            const query = searchQuery.toLowerCase()
            filtered = filtered.filter(p =>
                p.size.toLowerCase().includes(query) ||
                p.network.toLowerCase().includes(query) ||
                p.description?.toLowerCase().includes(query)
            )
        }

        setFilteredPackages(filtered)
    }

    // Helper function to get effective price based on user role
    const getEffectivePrice = (pkg: DataPackage) => {
        if (isSubAgent && subPrices?.[pkg.id]) {
            return subPrices[pkg.id]
        }
        if (dbUser?.role === 'dealer' && (pkg as any).dealer_price > 0) {
            return (pkg as any).dealer_price
        }
        if (dbUser?.role === 'agent' && (pkg as any).agent_price > 0) {
            return (pkg as any).agent_price
        }
        return pkg.price
    }

    // Gateway fee for Direct Pay — the server recomputes this authoritatively,
    // this is for display only.
    const HUBTEL_FEE_PERCENT = 1.8
    const computeGatewayFee = (subtotal: number) => {
        if (webPaymentProvider === 'hubtel') {
            return parseFloat((subtotal * (HUBTEL_FEE_PERCENT / 100)).toFixed(2))
        }
        // PaySwitch bills us, not the payer, so it carries the same percentage
        // Paystack does — matching the server's fee block in /api/orders/gateway-init.
        if (webPaymentProvider === 'paystack' || webPaymentProvider === 'payswitch') {
            return calculatePaystackFee(subtotal, paystackFeePercent)
        }
        return 0
    }

    const needsMomoDetails = isMomoPromptProvider(webPaymentProvider)

    const selectedPrice = selectedPackage ? getEffectivePrice(selectedPackage) : 0
    const selectedFee = paymentMethod === 'direct' ? computeGatewayFee(selectedPrice) : 0
    const selectedTotal = selectedPrice + selectedFee

    // The number that actually gets charged in the single checkout
    const effectiveMomoPhone = momoPhone.replace(/\s+/g, '')

    // Follow the paying number until the buyer picks a network themselves.
    // detectNetwork returns the bundle-style name; the gateway wants 'AT' for AirtelTigo.
    useEffect(() => {
        if (momoNetworkManual) return
        const detected = detectNetwork(effectiveMomoPhone)
        setSingleMomoNetwork(detected === 'AirtelTigo' ? 'AT' : detected || '')
    }, [effectiveMomoPhone, momoNetworkManual])

    const handlePurchaseClick = (pkg: DataPackage) => {
        setSelectedPackage(pkg)
        setPhoneNumber('')
        setPhoneError('')
        setPurchaseSuccess(false)
        setPurchaseDetails(null)
        setOtpRequired(false)
        setOtpCode('')
        setDirectPaymentRef(null)
        // Fresh sheet: blank paying number, network re-detected from whatever gets typed
        setMomoPhone('')
        setMomoNetworkManual(false)
        // Default to whichever method can actually complete right now
        setPaymentMethod(walletBalance >= getEffectivePrice(pkg) ? 'wallet' : 'direct')
        // Generate a fresh idempotency key each time the modal opens
        setCurrentReferenceCode(generateReferenceCode())
    }

    const handlePhoneChange = (value: string) => {
        setPhoneNumber(value)
        setPhoneError('')

        if (value.length >= 10) {
            const validation = validateGhanaianPhone(value)
            if (!validation.isValid) {
                setPhoneError(validation.error || 'Invalid phone number')
            } else if (selectedPackage) {
                // Check if network matches
                // 'Special MTN Mashup' uses MTN numbers, so treat it as MTN for validation
                const detectedNet = detectNetwork(value)
                const packageNetwork = (selectedPackage.network === 'Special MTN Mashup' || selectedPackage.network === 'EXPRESS MTN')
                    ? 'MTN'
                    : selectedPackage.network.includes('AT') ? 'AirtelTigo' : selectedPackage.network
                if (detectedNet !== packageNetwork && selectedPackage.network !== 'AT-BigTime') {
                    setPhoneError(`This number is for ${detectedNet}, not ${selectedPackage.network}`)
                }
            }
        }
    }

    const handlePurchase = async () => {
        if (!selectedPackage || !dbUser) return

        // The recipient field sits at the top of a scrollable dialog, so on a short
        // screen it is often out of view while Pay is not. Rather than leaving the
        // button dead — which reads as "the button doesn't work" — bring the field
        // back into view and say what is missing.
        if (!phoneNumber.trim()) {
            setPhoneError('Enter the recipient phone number')
            const el = document.getElementById('phone')
            el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
            el?.focus()
            return
        }

        const validation = validateGhanaianPhone(phoneNumber)
        if (!validation.isValid) {
            setPhoneError(validation.error || 'Invalid phone number')
            document.getElementById('phone')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
            return
        }

        const effectivePrice = getEffectivePrice(selectedPackage)

        if (paymentMethod === 'direct') {
            await handleDirectPurchase(validation.normalizedNumber!)
            return
        }

        if (walletBalance < effectivePrice) {
            setPhoneError('Insufficient wallet balance')
            return
        }

        setIsPurchasing(true)

        try {
            const response = await fetch('/api/orders/purchase', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${session?.access_token}`
                },
                body: JSON.stringify({
                    packageId: selectedPackage.id,
                    phoneNumber: validation.normalizedNumber,
                    referenceCode: currentReferenceCode, // idempotency key
                }),
            })

            const data = await response.json()

            if (response.status === 409 && data?.code === 'MTN_NOT_REGISTERED') {
                setRegistrationPrompt({ numbers: registrationNumbers(data) })
                return
            }

            if (!response.ok) {
                throw new Error(data.error || 'Purchase failed')
            }

            setPurchaseSuccess(true)
            setPurchaseDetails({
                referenceCode: data.order.reference_code,
                network: data.order.network,
                size: data.order.size,
                phoneNumber: data.order.phone_number,
                price: data.order.price,
                newBalance: data.order.new_balance,
            })
            setWalletBalance(typeof data.order?.new_balance === 'number' ? data.order.new_balance : (prev: number) => prev - effectivePrice)
            setOrdersToday(prev => prev + 1)
            refreshDashboardSummary()
            toast.success('Order placed successfully!')
        } catch (error: any) {
            toast.error(error.message || 'Failed to place order')
        } finally {
            setIsPurchasing(false)
        }
    }


    // creates and fulfils the order on confirmation.
    const handleDirectPurchase = async (recipientNumber: string) => {
        if (!selectedPackage) return

        if (needsMomoDetails && !singleMomoNetwork) {
            toast.error('Please select the Mobile Money network to pay from')
            return
        }
        if (needsMomoDetails && !effectiveMomoPhone) {
            toast.error('Please enter the Mobile Money number to charge')
            return
        }

        setIsPurchasing(true)

        try {
            const res = await fetch('/api/orders/gateway-init', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({
                    packageId: selectedPackage.id,
                    phoneNumber: recipientNumber,
                    momoPhone: effectiveMomoPhone,
                    momoNetwork: singleMomoNetwork,
                }),
            })

            const data = await res.json()

            // Refused before the payment prompt was sent, so nothing has been charged.
            if (res.status === 409 && data?.code === 'MTN_NOT_REGISTERED') {
                setIsPurchasing(false)
                setRegistrationPrompt({ numbers: registrationNumbers(data) })
                return
            }

            // A charge is already live for this number. Rather than a dead-end error,
            // hand the customer back to it: if it is waiting on a code, reopen the
            // dialog for that reference, because starting a new payment would cancel
            // the code they were sent.
            if (!res.ok && data.resumable && data.reference) {
                setDirectPaymentRef(data.reference)
                setPollingKind('single')
                if (data.otpRequired) {
                    setOtpMessage(data.error || '')
                    setOtpRequired(true)
                } else {
                    toast.info(data.error || 'A payment prompt is already waiting on your phone.')
                    setPollingRef(data.reference)
                }
                setIsPurchasing(false)
                return
            }

            if (!res.ok) throw new Error(data.error || 'Payment could not be started')

            setPollingKind('single')

            if (data.gateway === 'paystack') {
                window.location.href = data.authorization_url
                return
            }

            if (data.otpRequired) {
                setOtpMessage(data.message || '')
                setDirectPaymentRef(data.reference)
                setOtpRequired(true)
                setIsPurchasing(false)
                return
            }

            toast.success(data.message || 'Payment prompt sent! Approve it on your phone.')
            setPollingRef(data.reference)
        } catch (error: any) {
            toast.error(error.message || 'Failed to start payment')
            setIsPurchasing(false)
        }
    }

    // Moolre asks for an OTP before it will send the debit prompt
    const handleVerifyOtp = async () => {
        if (!otpCode.trim()) {
            toast.error('Please enter the OTP sent to your phone')
            return
        }
        if (!selectedPackage) return

        setIsVerifyingOtp(true)
        try {
            const validation = validateGhanaianPhone(phoneNumber)
            const res = await fetch('/api/orders/gateway-init', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({
                    packageId: selectedPackage.id,
                    phoneNumber: validation.normalizedNumber,
                    momoPhone: effectiveMomoPhone,
                    momoNetwork: singleMomoNetwork,
                    otpCode: otpCode.trim(),
                    reference: directPaymentRef,
                }),
            })

            const data = await res.json()
            if (!res.ok) throw new Error(data.error || 'Invalid OTP. Please try again.')

            setOtpRequired(false)
            setOtpCode('')
            toast.success(data.message || 'OTP verified! Approve the prompt on your phone.')
            setIsPurchasing(true)
            setPollingRef(data.reference)
        } catch (error: any) {
            toast.error(error.message || 'Failed to verify OTP')
        } finally {
            setIsVerifyingOtp(false)
        }
    }

    // Bulk Order Functions
    const parseTextInput = (text: string) => {
        const lines = text.trim().split('\n')
        return lines
            .map((line, index) => {
                const trimmed = line.trim()
                if (!trimmed) return null

                // Split by spaces or tabs
                const parts = trimmed.split(/\s+/)
                if (parts.length < 2) return null

                // Assuming format: phone volume (e.g., "0551234567 1")
                // Handle 1GB, 1gb, 1 etc.
                const phone = parts[0]
                const volStr = parts[1].toLowerCase().replace('gb', '')
                const volume = parseFloat(volStr)

                return {
                    lineNumber: index + 1,
                    phoneNumber: phone,
                    volume: volume,
                    rawLine: trimmed
                }
            })
            .filter(Boolean)
    }

    const validateLines = (parsedLines: any[]) => {
        if (!bulkNetwork) {
            toast.error('Please select a network first')
            return []
        }

        return parsedLines.map((line: any) => {
            // Validate phone
            const phoneValidation = validateGhanaianPhone(line.phoneNumber)
            if (!phoneValidation.isValid) {
                return {
                    ...line,
                    packagePrice: 0,
                    isValid: false,
                    errorMessage: 'Invalid phone number'
                }
            }

            // Check network match
            const detectedNet = detectNetwork(line.phoneNumber)
            const targetNet = bulkNetwork === 'AT-BigTime' || bulkNetwork === 'AT-iShare' ? 'AirtelTigo' : bulkNetwork
            if (detectedNet !== targetNet) {
                return {
                    ...line,
                    packagePrice: 0,
                    isValid: false,
                    errorMessage: `Wrong network (${detectedNet})`
                }
            }

            const pkg = packages.find(p => {
                if (p.network !== bulkNetwork) return false
                const pkgSize = p.size.toLowerCase()

                if (pkgSize.includes('gb')) {
                    const sizeVal = parseFloat(pkgSize.replace('gb', '').trim())
                    return sizeVal === line.volume
                } else if (pkgSize.includes('mb')) {
                    const sizeVal = parseFloat(pkgSize.replace('mb', '').trim())
                    return sizeVal / 1000 === line.volume
                }
                return false
            })

            if (!pkg) {
                return {
                    ...line,
                    packagePrice: 0,
                    isValid: false,
                    errorMessage: `No ${line.volume}GB package found`
                }
            }

            return {
                ...line,
                packagePrice: getEffectivePrice(pkg),
                packageId: pkg.id,
                packageName: pkg.network + ' ' + pkg.size,
                isValid: true
            }
        })
    }

    /**
     * Annotate validated lines with MTN registration status — one batched call for the
     * whole paste, not one per line.
     *
     * Advisory only — the submit path enforces. While the admin gate is ON an
     * "unregistered" badge is a warning that the whole batch will be refused, so the
     * agent can drop those lines before paying; while it is OFF no badge appears at all.
     * Either way the same call submits those numbers to MTN for enabling, which is what
     * starts the clock on the wait.
     *
     * On any failure the lines are returned untouched, so a supplier outage never
     * blocks the Validate button.
     */
    const annotateRegistration = async (results: ValidationResult[]): Promise<ValidationResult[]> => {
        const numbers = results.filter(r => r.isValid).map(r => r.phoneNumber)
        if (numbers.length === 0) return results

        try {
            const res = await fetch('/api/mtn/verify-batch', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${session?.access_token}`,
                },
                body: JSON.stringify({ numbers, network: bulkNetwork }),
            })
            if (!res.ok) return results

            const data = await res.json()
            if (!data?.gateActive) return results

            return results.map(r => ({
                ...r,
                registrationStatus: data.statuses?.[r.phoneNumber] || undefined,
            }))
        } catch {
            return results
        }
    }

    const handleValidateBulk = async () => {
        if (!bulkNetwork) {
            toast.error('Please select a network first')
            return
        }
        if (!bulkText.trim()) {
            toast.error('Please enter phone numbers')
            return
        }

        setIsValidating(true)
        const parsedLines = parseTextInput(bulkText)
        const results = await annotateRegistration(validateLines(parsedLines))

        setValidationResults(results)
        setIsValidating(false)
        if (results.length > 0) {
            const unregistered = results.filter(r => r.registrationStatus === 'unregistered').length
            toast.success(`Validated ${results.length} entries`)
            if (unregistered > 0) {
                toast.warning(`${unregistered} number${unregistered === 1 ? ' is' : 's are'} not registered on MTN yet — delivery can take up to 2 weeks`)
            }
        } else {
            toast.error('No valid lines found')
        }
    }

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0]
        if (file) {
            setBulkFile(file)
            toast.success(`File ${file.name} selected`)
        }
    }

    const handleValidateExcel = async () => {
        if (!bulkNetwork) {
            toast.error('Please select a network first')
            return
        }
        if (!bulkFile) {
            toast.error('Please select an Excel file')
            return
        }

        setIsValidating(true)
        const reader = new FileReader()
        reader.onload = async (e) => {
            const data = e.target?.result
            if (!data) {
                setIsValidating(false)
                return
            }

            try {
                const XLSX = await import('xlsx')
                const workbook = XLSX.read(data, { type: 'binary' })
                const sheetName = workbook.SheetNames[0]
                const worksheet = workbook.Sheets[sheetName]
                const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 }) as any[][]

                // Assuming columns: Phone, Volume
                const parsedLines = jsonData.map((row, index) => {
                    if (index === 0 && (row[0]?.toString().toLowerCase().includes('phone') || row[0]?.toString().length > 10)) {
                        // Skip header if it looks like one
                        if (row[0]?.toString().toLowerCase().includes('phone')) return null
                    }

                    const phone = row[0]?.toString().trim()
                    const volumeStr = row[1]?.toString().toLowerCase().replace('gb', '').trim()
                    const volume = parseFloat(volumeStr)

                    if (!phone || isNaN(volume)) return null

                    return {
                        lineNumber: index + 1,
                        phoneNumber: phone,
                        volume: volume,
                        rawLine: row.join(' ')
                    }
                }).filter(Boolean)

                const results = await annotateRegistration(validateLines(parsedLines))
                setValidationResults(results)
                toast.success(`Validated ${results.length} entries from Excel`)
                const unregistered = results.filter(r => r.registrationStatus === 'unregistered').length
                if (unregistered > 0) {
                    toast.warning(`${unregistered} number${unregistered === 1 ? ' is' : 's are'} not registered on MTN yet — delivery can take up to 2 weeks`)
                }
            } catch (error) {
                toast.error('Error parsing Excel file')
            } finally {
                setIsValidating(false)
            }
        }
        reader.readAsBinaryString(bulkFile)
    }

    const clearInvalid = () => {
        setValidationResults(prev => prev.filter(r => r.isValid))
    }

    const clearAllResults = () => {
        setValidationResults([])
        setBulkText('')
        setBulkFile(null)
    }

    const deleteResult = (index: number) => {
        setValidationResults(prev => prev.filter((_, i) => i !== index))
    }

    // Direct Pay for a whole basket — one payment settles into N orders
    const handleBulkDirectPurchase = async (validOrders: ValidationResult[]) => {
        if (needsMomoDetails && (!momoNetwork || !momoPhone)) {
            toast.error('Enter the Mobile Money number and network to pay from')
            return
        }

        setIsSubmittingBulk(true)

        try {
            const res = await fetch('/api/orders/gateway-init', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({
                    orders: validOrders.map(order => ({
                        packageId: order.packageId,
                        phoneNumber: validateGhanaianPhone(order.phoneNumber).normalizedNumber,
                    })),
                    momoPhone,
                    momoNetwork,
                }),
            })

            const data = await res.json()

            if (res.status === 409 && data?.code === 'MTN_NOT_REGISTERED') {
                setIsSubmittingBulk(false)
                setRegistrationPrompt({ numbers: registrationNumbers(data), total: data?.registration?.total })
                return
            }

            if (!res.ok) throw new Error(data.error || 'Payment could not be started')

            setPollingKind('bulk')

            if (data.gateway === 'paystack') {
                window.location.href = data.authorization_url
                return
            }

            if (data.otpRequired) {
                // No dialog on this path — bulk deliberately refuses the OTP round
                // trip, so there is no instruction to display.
                toast.error('This basket needs OTP approval. Please pay from your wallet or try a single purchase.')
                setIsSubmittingBulk(false)
                return
            }

            toast.success(data.message || 'Payment prompt sent! Approve it on your phone.')
            setPollingRef(data.reference)
        } catch (error: any) {
            toast.error(error.message || 'Failed to start payment')
            setIsSubmittingBulk(false)
        }
    }

    const handleSubmitBulkOrder = async () => {
        const validOrders = validationResults.filter(r => r.isValid)
        if (validOrders.length === 0) return

        const totalCost = validOrders.reduce((sum, order) => sum + order.packagePrice, 0)

        if (bulkPaymentMethod === 'direct') {
            await handleBulkDirectPurchase(validOrders)
            return
        }

        if (walletBalance < totalCost) {
            toast.error(`Insufficient balance. Need GHS ${formatCurrency(totalCost)}`)
            return
        }

        setIsSubmittingBulk(true)

        try {
            const response = await fetch('/api/orders/bulk-purchase', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${session?.access_token}`
                },
                body: JSON.stringify({
                    orders: validOrders.map(order => ({
                        packageId: order.packageId,
                        phoneNumber: validateGhanaianPhone(order.phoneNumber).normalizedNumber,
                        packagePrice: order.packagePrice,
                    })),
                }),
            })

            const data = await response.json()

            if (response.status === 409 && data?.code === 'MTN_NOT_REGISTERED') {
                setRegistrationPrompt({ numbers: registrationNumbers(data), total: data?.registration?.total })
                return
            }

            if (!response.ok) {
                throw new Error(data.error || 'Bulk order failed')
            }

            setBulkSuccessDetails({
                ordersPlaced: data.ordersPlaced,
                totalCost: data.totalCost,
                newBalance: data.newBalance,
                orders: validOrders.map(o => ({
                    phoneNumber: o.phoneNumber,
                    volume: o.volume,
                    packagePrice: o.packagePrice,
                })),
            })
            setBulkSuccess(true)
            setValidationResults([])
            setBulkText('')
            fetchWalletBalance()
            fetchOrdersToday()
            refreshDashboardSummary()

        } catch (error: any) {
            toast.error(error.message || 'Error submitting bulk orders')
        } finally {
            setIsSubmittingBulk(false)
        }
    }
    if (isLoading || !pricingReady) {
        return (
            <div className="space-y-6">
                <Skeleton className="h-12 w-full max-w-md" />
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                    {[...Array(8)].map((_, i) => (
                        <Skeleton key={i} className="h-48" />
                    ))}
                </div>
            </div>
        )
    }

    return (
        <div className="space-y-6">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div className="flex-1 text-center">
                    <h1 className="text-2xl font-bold">Data Packages</h1>
                </div>
            </div>

            <div className="flex flex-col items-center gap-4 text-center">

                {/* Stats Dashboard */}
                <div id="stats-dashboard" className="grid grid-cols-2 gap-4 w-full max-w-md mx-auto mb-2">
                    <div className="bg-[#1A1A1A] dark:bg-[#E5E7EB] rounded-2xl p-4 text-center shadow-md lg:shadow-lg transition-colors flex flex-col items-center justify-between gap-3">
                        <div>
                            <p className="text-[#FACC15] font-medium text-xs mb-1">
                                Wallet Balance
                            </p>
                            <p className="text-[#FACC15] text-xl font-black tracking-tight leading-none">
                                {formatCurrency(walletBalance)}
                            </p>
                        </div>
                        <Button
                            size="sm"
                            className="h-7 text-[10px] uppercase font-bold tracking-wider bg-[#FACC15] text-black hover:bg-[#FACC15]/90 border-0 w-full"
                            onClick={() => router.push('/dashboard/wallet')}
                        >
                            <Plus className="w-3 h-3 mr-1" />
                            Top Up
                        </Button>
                    </div>

                    <div className="bg-[#1A1A1A] dark:bg-[#E5E7EB] rounded-2xl p-4 text-center shadow-md lg:shadow-lg transition-colors flex flex-col items-center justify-center">
                        <p className="text-[#FACC15] font-medium text-xs mb-1">
                            Orders Today
                        </p>
                        <p className="text-[#FACC15] text-xl font-black tracking-tight leading-none">
                            {ordersToday}
                        </p>
                    </div>
                </div>

                {/* MTN Registration Check - all users */}
                <button
                    type="button"
                    onClick={() => router.push('/dashboard/mtn-registration')}
                    className="w-full max-w-3xl mx-auto bg-white dark:bg-[#1A1A1A] rounded-3xl p-6 shadow-md lg:shadow-lg flex items-center gap-4 text-left hover:shadow-xl transition-shadow"
                >
                    <div className="bg-amber-100 dark:bg-amber-900/30 p-4 rounded-2xl shrink-0">
                        <ShieldCheck className="w-8 h-8 text-amber-600 dark:text-amber-500" />
                    </div>
                    <div className="flex-1 min-w-0">
                        <h2 className="text-lg sm:text-xl font-bold leading-tight">Check MTN Number Registration</h2>
                        <p className="text-sm sm:text-base text-muted-foreground mt-0.5">
                            Not-registered numbers are sent to MTN automatically · up to 1,000 at once
                        </p>
                    </div>
                    <ExternalLink className="w-6 h-6 text-muted-foreground shrink-0" />
                </button>

                {/* Bulk Order Section - Agents, Admins, and Sub-Admins */}
                {(dbUser?.role === 'agent' || dbUser?.role === 'admin' || dbUser?.role === 'sub-admin') && (
                    <div id="bulk-order-section" className="w-full max-w-3xl mx-auto space-y-4">
                        {/* New Yellow Header Box */}
                        <div className="bg-[#FFCE00] rounded-3xl p-6 shadow-md lg:shadow-xl relative overflow-hidden">
                            <div className="flex items-start gap-4 relative z-10">
                                <div className="bg-[#1A1A1A] p-3 rounded-2xl shadow-lg">
                                    <CloudUpload className="w-6 h-6 text-[#FFCE00]" />
                                </div>
                                <div className="text-left">
                                    <h2 className="text-xl font-black text-black leading-tight">Bulk Orders Import</h2>
                                    <p className="text-sm font-bold text-black opacity-70">Import multiple orders at once via Excel or Text</p>
                                </div>
                            </div>

                            {/* Toggles */}
                            <div className="flex gap-3 mt-6 relative z-10">
                                <Button
                                    onClick={() => setBulkInputType(bulkInputType === 'text' ? null : 'text')}
                                    className={cn(
                                        "flex-1 h-12 rounded-xl font-bold transition-all duration-300",
                                        bulkInputType === 'text'
                                            ? "bg-[#1A1A1A] text-[#FFCE00] shadow-lg scale-105"
                                            : "bg-white text-black hover:bg-white/90"
                                    )}
                                >
                                    <FileText className="w-4 h-4 mr-2" />
                                    Text Input
                                </Button>
                                <Button
                                    onClick={() => setBulkInputType(bulkInputType === 'excel' ? null : 'excel')}
                                    className={cn(
                                        "flex-1 h-12 rounded-xl font-bold transition-all duration-300",
                                        bulkInputType === 'excel'
                                            ? "bg-[#1A1A1A] text-[#FFCE00] shadow-lg scale-105"
                                            : "bg-white text-black hover:bg-white/90"
                                    )}
                                >
                                    <FileSpreadsheet className="w-4 h-4 mr-2" />
                                    Excel Import
                                </Button>
                            </div>
                        </div>

                        {/* Conditional Forms */}
                        {bulkInputType && (
                            <Card className="border-0 bg-transparent shadow-none animate-in fade-in slide-in-from-top-4 duration-500">
                                <CardContent className="p-0 space-y-4">
                                    <div className="bg-white dark:bg-zinc-900 rounded-3xl p-6 shadow-md lg:shadow-lg border border-gray-100 dark:border-zinc-800">
                                        <div className="space-y-4">
                                            <div className="space-y-1">
                                                <Label className="text-[#E60000] font-black text-xs uppercase tracking-widest">Select Network</Label>
                                                <div className="flex gap-2 flex-wrap">
                                                    {ALL_NETWORKS.filter(net => (!hideMashup || net !== 'Special MTN Mashup') && (!hideExpressMtn || net !== 'EXPRESS MTN') && (!hideStandardMtn || net !== 'MTN')).map(net => (
                                                        <Button
                                                            key={net}
                                                            variant={bulkNetwork === net ? "default" : "outline"}
                                                            className={cn(
                                                                "h-8 text-[10px] font-bold px-3 rounded-full transition-all",
                                                                bulkNetwork === net ?
                                                                    (net === 'MTN' ? 'bg-[#FFCC00] text-black hover:bg-[#FFCC00]/90 border-0' :
                                                                        net === 'Telecel' ? 'bg-[#E60000] text-white hover:bg-[#E60000]/90 border-0' :
                                                                            'bg-[#0056B3] text-white hover:bg-[#0056B3]/90 border-0')
                                                                    : 'bg-transparent border-gray-200 dark:border-zinc-700'
                                                            )}
                                                            onClick={() => setBulkNetwork(net)}
                                                            size="sm"
                                                        >
                                                            {net}
                                                        </Button>
                                                    ))}
                                                </div>
                                            </div>

                                            {bulkInputType === 'text' ? (
                                                <div className="space-y-4">
                                                    <div className="text-center space-y-1 py-2">
                                                        <h3 className="text-lg font-black text-black dark:text-white">Enter Your Orders</h3>
                                                        <p className="text-xs font-bold text-gray-400">One order per line (e.g below)</p>
                                                    </div>

                                                    <div className="relative group">
                                                        <textarea
                                                            ref={textareaRef}
                                                            wrap="off"
                                                            className="w-full rounded-2xl border-2 border-gray-50 dark:border-zinc-800 bg-gray-50/50 dark:bg-zinc-800/50 px-4 py-3 text-[11px] leading-[1.6] text-black dark:text-white placeholder:text-gray-300 dark:placeholder:text-zinc-600 focus:outline-none focus:border-[#FFCE00] transition-colors font-mono font-bold overflow-x-auto whitespace-pre"
                                                            placeholder={`0246677889 2\n0546627266 3`}
                                                            value={bulkText}
                                                            onChange={(e) => setBulkText(e.target.value)}
                                                        />
                                                    </div>

                                                    <Button
                                                        className="w-full bg-[#FFCE00] hover:bg-[#FFCE00]/90 text-black font-black py-6 rounded-2xl shadow-lg shadow-[#FFCE00]/20 text-sm"
                                                        onClick={handleValidateBulk}
                                                        disabled={isValidating}
                                                    >
                                                        {isValidating ? (
                                                            <>
                                                                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                                                                Validating...
                                                            </>
                                                        ) : (
                                                            <div className="flex items-center gap-2">
                                                                <Check className="w-4 h-4" />
                                                                Validate Orders
                                                            </div>
                                                        )}
                                                    </Button>
                                                </div>
                                            ) : (
                                                <div className="space-y-4">
                                                    <div className="text-center space-y-1 py-2">
                                                        <h3 className="text-lg font-black text-black dark:text-white">Excel Import</h3>
                                                        <p className="text-xs font-bold text-gray-400">Upload your sheet with Phone and Volume columns</p>
                                                    </div>

                                                    <div
                                                        className="border-2 border-dashed border-gray-200 dark:border-zinc-800 rounded-2xl p-8 text-center bg-gray-50/30 dark:bg-zinc-800/30 hover:bg-gray-50/50 dark:hover:bg-zinc-800/50 transition-colors cursor-pointer relative"
                                                        onClick={() => document.getElementById('excel-upload')?.click()}
                                                    >
                                                        <input
                                                            id="excel-upload"
                                                            type="file"
                                                            accept=".xlsx, .xls, .csv"
                                                            className="hidden"
                                                            onChange={handleFileChange}
                                                            title="Upload Excel File"
                                                        />
                                                        <div className="flex flex-col items-center gap-2">
                                                            <div className="p-3 bg-white dark:bg-zinc-900 rounded-xl shadow-sm border border-gray-100 dark:border-zinc-800">
                                                                <Upload className="w-5 h-5 text-[#FFCE00]" />
                                                            </div>
                                                            <p className="text-xs font-bold text-black dark:text-white">
                                                                {bulkFile ? bulkFile.name : 'Click to upload Excel file'}
                                                            </p>
                                                            <p className="text-[10px] text-gray-400">or drag and drop here</p>
                                                        </div>
                                                    </div>

                                                    {bulkFile && (
                                                        <Button
                                                            className="w-full bg-[#FFCE00] hover:bg-[#FFCE00]/90 text-black font-black py-6 rounded-2xl shadow-lg shadow-[#FFCE00]/20 text-sm"
                                                            onClick={handleValidateExcel}
                                                            disabled={isValidating}
                                                        >
                                                            {isValidating ? (
                                                                <>
                                                                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                                                                    Validating...
                                                                </>
                                                            ) : (
                                                                <div className="flex items-center gap-2">
                                                                    <Check className="w-4 h-4" />
                                                                    Validate Excel
                                                                </div>
                                                            )}
                                                        </Button>
                                                    )}
                                                </div>
                                            )}
                                        </div>
                                    </div>

                                    {/* Validation Results */}
                                    {validationResults.length > 0 && (
                                        <div className="space-y-4 animate-in fade-in slide-in-from-bottom-4 duration-500">
                                            <div className="bg-white dark:bg-zinc-900 rounded-3xl overflow-hidden shadow-lg border border-gray-100 dark:border-zinc-800">
                                                <div className="bg-[#FFCE00] px-6 py-4 flex items-center justify-between">
                                                    <div className="flex items-center gap-2">
                                                        <div className="bg-white/20 p-1 rounded-lg">
                                                            <CheckCircle2 className="w-4 h-4 text-black" />
                                                        </div>
                                                        <h3 className="font-black text-black">Order List ({validationResults.length})</h3>
                                                    </div>
                                                    <div className="flex gap-2">
                                                        <Button
                                                            variant="ghost"
                                                            size="sm"
                                                            className="h-7 text-[10px] font-bold text-black hover:bg-black/10 px-2"
                                                            onClick={clearInvalid}
                                                        >
                                                            Clear All Invalid
                                                        </Button>
                                                        <Button
                                                            variant="ghost"
                                                            size="sm"
                                                            className="h-7 text-[10px] font-bold text-red-600 hover:bg-red-50 px-2"
                                                            onClick={clearAllResults}
                                                        >
                                                            Clear All
                                                        </Button>
                                                    </div>
                                                </div>

                                                <div className="max-h-[300px] overflow-y-auto">
                                                    <table className="w-full text-xs">
                                                        <thead className="bg-gray-50/50 dark:bg-zinc-800/50 border-b border-gray-100 dark:border-zinc-800">
                                                            <tr>
                                                                <th className="px-6 py-3 text-left font-black text-gray-400">STATUS</th>
                                                                <th className="px-6 py-3 text-left font-black text-gray-400">RECIPIENT</th>
                                                                <th className="px-6 py-3 text-left font-black text-gray-400">DATA</th>
                                                                <th className="px-6 py-3 text-left font-black text-gray-400">PRICE</th>
                                                                <th className="px-0 py-3 text-center"></th>
                                                            </tr>
                                                        </thead>
                                                        <tbody className="divide-y divide-gray-50 dark:divide-zinc-800">
                                                            {validationResults.map((res, i) => (
                                                                <tr key={i} className="group hover:bg-gray-50/50 dark:hover:bg-zinc-800/50 transition-colors">
                                                                    <td className="px-6 py-4">
                                                                        <div className={cn(
                                                                            "w-2 h-2 rounded-full",
                                                                            res.isValid ? "bg-[#25D366]" : "bg-[#E60000]"
                                                                        )} />
                                                                    </td>
                                                                    <td className="px-6 py-4 font-bold text-black dark:text-white">
                                                                        {res.phoneNumber}
                                                                        {res.registrationStatus === 'unregistered' && (
                                                                            <span
                                                                                className="ml-2 inline-block rounded-md bg-amber-100 px-1.5 py-0.5 text-[9px] font-black uppercase tracking-wide text-amber-700 dark:bg-amber-900/40 dark:text-amber-400"
                                                                                title="Not registered on MTN yet — delivery can take up to 2 weeks"
                                                                            >
                                                                                Not registered
                                                                            </span>
                                                                        )}
                                                                    </td>
                                                                    <td className="px-6 py-4 font-bold text-gray-500">{res.volume} GB</td>
                                                                    <td className="px-6 py-4 font-black text-black dark:text-white">
                                                                        {res.packagePrice > 0 ? formatCurrency(res.packagePrice) : '-'}
                                                                    </td>
                                                                    <td className="px-2 py-4">
                                                                        <button
                                                                            onClick={() => deleteResult(i)}
                                                                            className="p-1.5 opacity-0 group-hover:opacity-100 hover:bg-red-50 hover:text-red-600 rounded-lg transition-all"
                                                                            title="Delete result"
                                                                            aria-label="Delete result"
                                                                        >
                                                                            <X className="w-3.5 h-3.5" />
                                                                        </button>
                                                                    </td>
                                                                </tr>
                                                            ))}
                                                        </tbody>
                                                    </table>
                                                </div>
                                            </div>

                                            {/* Summary Container */}
                                            <div className="bg-[#FFCE00] rounded-3xl p-4 shadow-xl relative overflow-hidden max-w-md mx-auto w-full">
                                                <div className="grid grid-cols-2 gap-4 relative z-10 items-center">
                                                    <div className="text-center space-y-0.5 border-r border-black/10">
                                                        <p className="text-[9px] font-black text-black uppercase tracking-widest opacity-60">Total Cost</p>
                                                        <h2 className="text-2xl font-black text-black leading-tight">{formatCurrency(totalBulkCost)}</h2>
                                                        <p className="text-[9px] font-bold text-black opacity-60 uppercase tracking-tighter">Order value</p>
                                                    </div>
                                                    <div className="text-center space-y-0.5">
                                                        <p className="text-[9px] font-black text-black uppercase tracking-widest opacity-60">Total Data</p>
                                                        <h2 className="text-2xl font-black text-black leading-tight">{totalBulkData} <span className="text-sm">GB</span></h2>
                                                        <p className="text-[9px] font-bold text-black opacity-60 uppercase tracking-tighter">Data Volume</p>
                                                    </div>
                                                </div>
                                            </div>

                                            {/* Submit Section */}
                                            <div className="flex flex-col items-center justify-center gap-4 py-4 max-w-md mx-auto w-full">
                                                {/* Payment Method — Wallet or Direct Pay */}
                                                <div className="w-full space-y-2">
                                                    <Label>Payment Method</Label>
                                                    <div className="grid grid-cols-2 gap-3">
                                                        <button
                                                            type="button"
                                                            onClick={() => setBulkPaymentMethod('wallet')}
                                                            className={cn(
                                                                'p-3 rounded-xl border flex items-center gap-2 transition-colors text-left',
                                                                bulkPaymentMethod === 'wallet' ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'hover:bg-muted/50'
                                                            )}
                                                        >
                                                            <Wallet className="w-5 h-5 text-primary shrink-0" />
                                                            <div className="min-w-0">
                                                                <div className="font-semibold text-sm">Wallet</div>
                                                                <div className="text-xs text-muted-foreground truncate">{formatCurrency(walletBalance)} available</div>
                                                            </div>
                                                        </button>
                                                        <button
                                                            type="button"
                                                            onClick={() => setBulkPaymentMethod('direct')}
                                                            className={cn(
                                                                'p-3 rounded-xl border flex items-center gap-2 transition-colors text-left',
                                                                bulkPaymentMethod === 'direct' ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'hover:bg-muted/50'
                                                            )}
                                                        >
                                                            <CreditCard className="w-5 h-5 text-blue-500 shrink-0" />
                                                            <div className="min-w-0">
                                                                <div className="font-semibold text-sm">Direct Pay</div>
                                                                <div className="text-xs text-muted-foreground truncate">MoMo or Card</div>
                                                            </div>
                                                        </button>
                                                    </div>
                                                </div>

                                                {bulkPaymentMethod === 'direct' && needsMomoDetails && (
                                                    <div className="w-full space-y-3 animate-in fade-in slide-in-from-top-2">
                                                        <div className="space-y-2">
                                                            <Label htmlFor="bulk-momo-phone">Mobile Money Number</Label>
                                                            <Input
                                                                id="bulk-momo-phone"
                                                                type="tel"
                                                                placeholder="0241234567"
                                                                value={momoPhone}
                                                                onChange={(e) => setMomoPhone(e.target.value)}
                                                            />
                                                        </div>
                                                        <div className="space-y-2">
                                                            <Label>Mobile Money Network</Label>
                                                            <Select value={momoNetwork} onValueChange={setMomoNetwork}>
                                                                <SelectTrigger>
                                                                    <SelectValue placeholder="Select Network" />
                                                                </SelectTrigger>
                                                                <SelectContent>
                                                                    <SelectItem value="MTN">MTN MoMo</SelectItem>
                                                                    <SelectItem value="Telecel">Telecel Cash</SelectItem>
                                                                    <SelectItem value="AT">AT Money</SelectItem>
                                                                </SelectContent>
                                                            </Select>
                                                        </div>
                                                    </div>
                                                )}

                                                {bulkPaymentMethod === 'direct' && computeGatewayFee(totalBulkCost) > 0 && (
                                                    <div className="w-full rounded-xl bg-muted/50 p-3 space-y-1 text-sm">
                                                        <div className="flex justify-between">
                                                            <span className="text-muted-foreground">Orders</span>
                                                            <span>{formatCurrency(totalBulkCost)}</span>
                                                        </div>
                                                        <div className="flex justify-between">
                                                            <span className="text-muted-foreground">Transaction fee</span>
                                                            <span>{formatCurrency(computeGatewayFee(totalBulkCost))}</span>
                                                        </div>
                                                        <div className="flex justify-between border-t border-border/50 pt-1 font-bold">
                                                            <span>Total</span>
                                                            <span className="text-primary">{formatCurrency(totalBulkCost + computeGatewayFee(totalBulkCost))}</span>
                                                        </div>
                                                    </div>
                                                )}

                                                {bulkPaymentMethod === 'wallet' && walletBalance < totalBulkCost ? (
                                                    <div className="w-full space-y-2">
                                                        <Link href="/dashboard/wallet" className="w-full block">
                                                            <Button
                                                                className="w-full bg-[#FFCE00] text-black hover:bg-[#FFCE00]/90 font-black py-6 rounded-2xl shadow-xl shadow-yellow-500/20 text-sm h-auto uppercase tracking-widest"
                                                            >
                                                                <DollarSign className="w-5 h-5 mr-2" />
                                                                Recharge Wallet
                                                            </Button>
                                                        </Link>
                                                        <button
                                                            type="button"
                                                            className="w-full text-xs text-muted-foreground underline"
                                                            onClick={() => setBulkPaymentMethod('direct')}
                                                        >
                                                            Or pay directly with MoMo / card
                                                        </button>
                                                    </div>
                                                ) : (
                                                    <Button
                                                        className="w-full bg-black text-[#FFCE00] hover:bg-black/90 font-black py-5 rounded-2xl shadow-xl shadow-black/10 text-sm h-auto flex flex-col items-center gap-1"
                                                        onClick={() => handleSubmitBulkOrder()}
                                                        disabled={isSubmittingBulk || !!pollingRef || validationResults.filter(r => r.isValid).length === 0}
                                                    >
                                                        {isSubmittingBulk || pollingRef ? (
                                                            <div className="flex items-center">
                                                                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                                                                {pollingRef ? 'Waiting for approval...' : 'Processing...'}
                                                            </div>
                                                        ) : (
                                                            <>
                                                                <div className="text-[10px] font-bold opacity-60 flex items-center gap-1 mb-1 bg-white/10 px-3 py-0.5 rounded-full">
                                                                    <DollarSign className="w-2.5 h-2.5" />
                                                                    {bulkPaymentMethod === 'wallet'
                                                                        ? `Wallet Balance: ${formatCurrency(walletBalance)}`
                                                                        : `Pay ${formatCurrency(totalBulkCost + computeGatewayFee(totalBulkCost))}`}
                                                                </div>
                                                                <div className="flex items-center gap-2 text-base tracking-widest">
                                                                    <CheckCircle2 className="w-5 h-5" />
                                                                    SUBMIT ORDERS
                                                                </div>
                                                            </>
                                                        )}
                                                    </Button>
                                                )}
                                            </div>
                                        </div>
                                    )}
                                </CardContent>
                            </Card>
                        )}
                    </div>
                )}

                <div className="flex items-center gap-2">
                    <Button
                        variant={viewMode === 'grid' ? 'default' : 'outline'}
                        size="icon"
                        onClick={() => setViewMode('grid')}
                    >
                        <LayoutGrid className="w-4 h-4" />
                    </Button>
                    <Button
                        variant={viewMode === 'list' ? 'default' : 'outline'}
                        size="icon"
                        onClick={() => setViewMode('list')}
                    >
                        <List className="w-4 h-4" />
                    </Button>
                </div>
            </div>

            {/* Search */}
            <div id="package-filters" className="relative max-w-md mx-auto w-full">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                    placeholder="Search packages..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="pl-9"
                />
            </div>

            {/* Network Tabs */}
            <Tabs value={selectedNetwork} onValueChange={setSelectedNetwork}>
                <TabsList className="h-auto p-0 bg-transparent grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3 w-full mb-2">
                    {ALL_NETWORKS.filter(network => (!hideMashup || network !== 'Special MTN Mashup') && (!hideExpressMtn || network !== 'EXPRESS MTN') && (!hideStandardMtn || network !== 'MTN')).map((network) => {
                        const isSelected = selectedNetwork === network;
                        return (
                            <TabsTrigger
                                key={network}
                                value={network}
                                className={cn(
                                    "relative flex flex-col items-center justify-center gap-3 py-4 px-2 rounded-[14px] border transition-all bg-white dark:bg-zinc-900 shadow-sm",
                                    "data-[state=active]:border-[#8a2be2] data-[state=active]:shadow-sm data-[state=active]:scale-[1.01]",
                                    "border-gray-100 dark:border-zinc-800 hover:border-gray-200 dark:hover:border-zinc-700",
                                    "data-[state=active]:bg-white dark:data-[state=active]:bg-zinc-900 data-[state=active]:text-gray-900 dark:data-[state=active]:text-white"
                                )}
                            >
                                {isSelected && (
                                    <div className="absolute top-2 right-2 z-10 bg-white rounded-full">
                                        <CheckCircle2 className="w-4 h-4 text-[#20d880]" strokeWidth={2.5} />
                                    </div>
                                )}
                                <div className="w-10 h-10 rounded-full flex items-center justify-center mt-1">
                                    <NetworkIcon network={network} size={36} />
                                </div>
                                <span className="text-[13px] font-bold text-gray-700 dark:text-gray-200 text-center leading-tight">
                                    {network === 'Special MTN Mashup' ? 'Special Mashup' : network === 'EXPRESS MTN' ? 'Express MTN' : network === 'AT-iShare' ? 'AT iShare' : network === 'AT-BigTime' ? 'AT BigTime' : network}
                                </span>
                                <div className="flex items-center justify-center gap-1.5 text-[11px] font-bold text-[#20d880] mb-1">
                                    <div className="w-1.5 h-1.5 rounded-full bg-[#20d880]" /> Live
                                </div>
                            </TabsTrigger>
                        )
                    })}
                </TabsList>

                <TabsContent id="packages-grid" value={selectedNetwork} className="mt-6">
                    {filteredPackages.length === 0 ? (
                        <Card className="p-12 text-center">
                            <Wifi className="w-12 h-12 mx-auto text-muted-foreground/50 mb-4" />
                            <p className="text-muted-foreground">No packages found</p>
                        </Card>
                    ) : viewMode === 'grid' ? (
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                            {filteredPackages.map((pkg) => {
                                const getCardStyle = (net: string) => {
                                    switch(net) {
                                        case 'Telecel':
                                            return { bg: 'bg-[#da291c]', bottom: 'bg-[#b01e14]', pill: 'bg-white/20 text-white', text: 'text-white', iconBg: 'bg-white/20' }
                                        case 'AT-iShare':
                                            return { bg: 'bg-[#2463eb]', bottom: 'bg-[#1d4ed8]', pill: 'bg-white/20 text-white', text: 'text-white', iconBg: 'bg-white/20' }
                                        case 'AT-BigTime':
                                            return { bg: 'bg-[#8b5cf6]', bottom: 'bg-[#6d28d9]', pill: 'bg-white/20 text-white', text: 'text-white', iconBg: 'bg-white/20' }
                                        case 'MTN':
                                        case 'Special MTN Mashup':
                                        case 'EXPRESS MTN':
                                            return { bg: 'bg-[#FFCC00]', bottom: 'bg-[#eab308]', pill: 'bg-black/10 text-black', text: 'text-black', iconBg: 'bg-white/30' }
                                        default:
                                            return { bg: 'bg-blue-600', bottom: 'bg-blue-700', pill: 'bg-white/20 text-white', text: 'text-white', iconBg: 'bg-white/20' }
                                    }
                                }
                                const cardStyle = getCardStyle(pkg.network)
                                const pillText = pkg.network === 'AT-iShare' ? 'AT-IS' : pkg.network === 'AT-BigTime' ? 'AT-BT' : pkg.network === 'Special MTN Mashup' ? 'MASHUP' : pkg.network === 'EXPRESS MTN' ? 'EXPRESS' : pkg.network

                                return (
                                    <button
                                        key={pkg.id} onClick={() => handlePurchaseClick(pkg)}
                                        className={cn(
                                            'relative rounded-[24px] overflow-hidden transition-all duration-200 active:scale-95 text-left flex flex-col shadow-md hover:shadow-lg hover:-translate-y-1 opacity-95 hover:opacity-100',
                                            cardStyle.bg
                                        )}
                                    >
                                        {/* Top Section */}
                                        <div className="p-4 relative flex-1 flex flex-col items-center justify-center min-h-[140px]">
                                            {/* Top Left Logo Circle */}
                                            <div className={cn("absolute top-3 left-3 w-10 h-10 rounded-full flex items-center justify-center backdrop-blur-sm", cardStyle.iconBg)}>
                                                <div className="w-6 h-6 rounded-full flex items-center justify-center bg-transparent">
                                                    <NetworkIcon network={pkg.network} size={28} />
                                                </div>
                                            </div>
                                            
                                            {/* Top Right Pill */}
                                            <div className={cn("absolute top-3 right-3 px-3 py-1 rounded-full text-[11px] font-black tracking-tight", cardStyle.pill)}>
                                                {pillText}
                                            </div>

                                            {/* Center Content */}
                                            <div className={cn("text-center mt-8 mb-2 space-y-1 w-full", cardStyle.text)}>
                                                <h3 className="text-[32px] leading-none font-black tracking-tighter">{pkg.size}</h3>
                                                <p className="text-lg font-bold">{formatCurrency(getEffectivePrice(pkg))}</p>
                                                
                                                <p className="text-[11px] font-semibold opacity-90 mt-1.5 flex items-center justify-center gap-1">
                                                    <span className="w-1 h-1 rounded-full bg-current opacity-70"></span> {pkg.description && pkg.description !== 'Instant Delivery' ? pkg.description : 'Bundle Valid for 90 Days'}
                                                </p>
                                            </div>
                                        </div>

                                        {/* Bottom Buy Bar */}
                                        <div className={cn("w-full py-3 flex items-center justify-center gap-2 transition-colors", cardStyle.bottom, cardStyle.text)}>
                                            <ShoppingCart className="w-4 h-4" />
                                            <span className="text-sm font-bold tracking-tight">Buy Now</span>
                                        </div>
                                    </button>
                                )
                            })}
                        </div>
                    ) : (
                        <div className="space-y-2">
                            {filteredPackages.map((pkg) => {
                                const isMtn = pkg.network === 'MTN' || pkg.network === 'Special MTN Mashup' || pkg.network === 'EXPRESS MTN'
                                const isTelecel = pkg.network === 'Telecel'
                                const isAT = pkg.network.includes('AT')

                                const getBuyButtonStyle = () => {
                                    if (isTelecel) return 'bg-white text-[#E60000] hover:bg-gray-100 border-0 shadow font-bold px-4 h-8 text-xs'
                                    if (isAT) return 'bg-white text-[#0056B3] hover:bg-gray-100 border-0 shadow font-bold px-4 h-8 text-xs'
                                    return 'bg-black text-white hover:bg-black/90 border-0 shadow font-bold px-4 h-8 text-xs'
                                }

                                return (
                                    <div
                                        key={pkg.id}
                                        className={`cursor-pointer rounded-xl border border-white/10 overflow-hidden flex items-center gap-3 px-3 py-2.5 transition-opacity hover:opacity-90 ${
                                            isMtn ? 'bg-[#FFCC00] text-black' :
                                            isTelecel ? 'bg-[#E60000] text-white' :
                                            'bg-[#0056B3] text-white'
                                        }`}
                                        onClick={() => handlePurchaseClick(pkg)}
                                    >
                                        {/* Icon */}
                                        <div className="shrink-0 w-9 h-9 rounded-lg bg-white/20 flex items-center justify-center">
                                            <NetworkIcon network={pkg.network} size={28} />
                                        </div>
                                        {/* Info */}
                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-center gap-2">
                                                <span className="font-black text-base leading-tight">{pkg.size}</span>
                                                <span className={`text-[9px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded-full ${isMtn ? 'bg-black/10 text-black' : 'bg-white/20 text-white'}`}>
                                                    {pkg.network === 'Special MTN Mashup' ? 'MASHUP' : pkg.network === 'EXPRESS MTN' ? 'EXPRESS' : pkg.network}
                                                </span>
                                            </div>
                                            <p className={`text-[10px] font-medium truncate ${isMtn ? 'text-black/60' : 'text-white/70'}`}>
                                                {pkg.description || 'Data Bundle'}
                                            </p>
                                        </div>
                                        {/* Price + Buy */}
                                        <div className="flex items-center gap-3 shrink-0">
                                            <span className="text-sm font-black">{formatCurrency(getEffectivePrice(pkg))}</span>
                                            <Button
                                                variant="outline"
                                                size="sm"
                                                className={getBuyButtonStyle()}
                                                onClick={(e) => { e.stopPropagation(); handlePurchaseClick(pkg) }}
                                            >
                                                Buy
                                            </Button>
                                        </div>
                                    </div>
                                )
                            })}
                        </div>
                    )}
                </TabsContent>
            </Tabs>

            {/* Purchase sheet.
                Unmounted, not merely hidden, while the OTP dialog is up. Hiding it with
                a class left it in the DOM at z-[70] with its own backdrop and Radix's
                focus trap fighting over it, and the dialog ended up unreachable behind
                a black screen. Nothing is lost by unmounting: every field reads from
                component state (recipientNumber, momoPhone, singleMomoNetwork), which
                survives, so a Cancel returns the form exactly as it was. */}
            {selectedPackage && !otpRequired && (() => {
                const sheetStyle = getNetworkSheetStyle(selectedPackage.network)
                const closeSheet = () => { if (!pollingRef) setSelectedPackage(null) }
                return (
                <div className="fixed inset-0 z-[70] flex items-end justify-center">
                    <div
                        className="absolute inset-0 bg-black/50 backdrop-blur-[2px] animate-in fade-in duration-200"
                        onClick={closeSheet}
                    />
                    <div
                        role="dialog"
                        aria-modal="true"
                        className="relative w-full sm:max-w-lg bg-white dark:bg-gray-900 rounded-t-[28px] sm:rounded-b-[28px] sm:mb-6 shadow-2xl max-h-[92vh] overflow-y-auto animate-in slide-in-from-bottom duration-300"
                    >
                        <div className="sticky top-0 z-10 bg-white dark:bg-gray-900 pt-3 pb-1 rounded-t-[28px]">
                            <div className="mx-auto w-10 h-1.5 rounded-full bg-gray-200 dark:bg-gray-700" />
                            <button
                                onClick={closeSheet}
                                aria-label="Close checkout"
                                disabled={!!pollingRef}
                                className="absolute top-2 right-4 w-9 h-9 rounded-full bg-gray-100 dark:bg-gray-800 flex items-center justify-center text-gray-500 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors disabled:opacity-40"
                            >
                                <X className="w-5 h-5" />
                            </button>
                        </div>

                    {purchaseSuccess ? (
                        <div className="px-5 pb-8 pt-3 space-y-5">
                            {/* Success Icon */}
                            <div className="flex flex-col items-center gap-2">
                                <div className="w-14 h-14 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center">
                                    <CheckCircle2 className="w-7 h-7 text-green-600" />
                                </div>
                                <h2 className="text-lg font-black">Order Placed!</h2>
                                <p className="text-xs text-muted-foreground text-center">Your data bundle is being processed</p>
                            </div>

                            {/* Order Summary */}
                            {purchaseDetails && (
                                <div className="bg-muted/50 rounded-2xl p-4 space-y-3">
                                    <div className="flex items-center justify-between text-sm">
                                        <span className="text-muted-foreground">Recipient</span>
                                        <span className="font-bold">{purchaseDetails.phoneNumber}</span>
                                    </div>
                                    <div className="flex items-center justify-between text-sm">
                                        <span className="text-muted-foreground">Package</span>
                                        <span className="font-bold">{purchaseDetails.network} {purchaseDetails.size}</span>
                                    </div>
                                    <div className="flex items-center justify-between text-sm">
                                        <span className="text-muted-foreground">Amount Paid</span>
                                        <span className="font-black text-primary">{formatCurrency(purchaseDetails.price)}</span>
                                    </div>
                                    <div className="border-t border-border/50 pt-2 flex items-center justify-between text-sm">
                                        <span className="text-muted-foreground">Ref</span>
                                        <span className="font-mono text-xs text-muted-foreground">{purchaseDetails.referenceCode}</span>
                                    </div>
                                </div>
                            )}

                            {/* Actions */}
                            <div className="flex gap-3">
                                <Button
                                    variant="outline"
                                    className="flex-1"
                                    onClick={() => setSelectedPackage(null)}
                                >
                                    Done
                                </Button>
                                <Button
                                    className="flex-1 bg-primary text-primary-foreground"
                                    onClick={() => { setSelectedPackage(null); router.push('/dashboard/my-orders') }}
                                >
                                    <ExternalLink className="w-4 h-4 mr-2" />
                                    View Orders
                                </Button>
                            </div>
                        </div>
                    ) : (
                        <div className="px-5 pb-8 pt-3 space-y-5">
                            {/* Selected package banner */}
                            <div className={cn('rounded-2xl px-4 py-4 flex items-center justify-between gap-3', sheetStyle.bg, sheetStyle.text)}>
                                <div className="flex items-center gap-3 min-w-0">
                                    <div className={cn('w-10 h-10 rounded-full flex items-center justify-center shrink-0', sheetStyle.iconBg)}>
                                        <NetworkIcon network={selectedPackage.network} size={24} />
                                    </div>
                                    <p className="text-lg font-black tracking-tight truncate">
                                        {selectedPackage.network} · {selectedPackage.size}
                                    </p>
                                </div>
                                <p className="text-lg font-black tracking-tight shrink-0">{formatCurrency(selectedTotal)}</p>
                            </div>

                            {/* How to pay */}
                            <div className="grid grid-cols-2 gap-3">
                                <button
                                    type="button"
                                    onClick={() => setPaymentMethod('wallet')}
                                    className={cn(
                                        'p-3 rounded-2xl border flex items-center gap-2 transition-colors text-left',
                                        paymentMethod === 'wallet' ? 'border-gray-900 dark:border-white bg-gray-50 dark:bg-gray-800 shadow-sm' : 'border-gray-200 dark:border-gray-700 hover:border-gray-300'
                                    )}
                                >
                                    <Wallet className="w-5 h-5 text-primary shrink-0" />
                                    <div className="min-w-0">
                                        <div className="font-bold text-sm">Wallet</div>
                                        <div className="text-xs text-muted-foreground truncate">{formatCurrency(walletBalance)} available</div>
                                    </div>
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setPaymentMethod('direct')}
                                    className={cn(
                                        'p-3 rounded-2xl border flex items-center gap-2 transition-colors text-left',
                                        paymentMethod === 'direct' ? 'border-gray-900 dark:border-white bg-gray-50 dark:bg-gray-800 shadow-sm' : 'border-gray-200 dark:border-gray-700 hover:border-gray-300'
                                    )}
                                >
                                    <CreditCard className="w-5 h-5 text-blue-500 shrink-0" />
                                    <div className="min-w-0">
                                        <div className="font-bold text-sm">Direct Pay</div>
                                        <div className="text-xs text-muted-foreground truncate">MoMo or Card</div>
                                    </div>
                                </button>
                            </div>

                            {/* Beneficiary */}
                            <div className="space-y-2">
                                <Label htmlFor="phone" className="text-sm font-black text-gray-900 dark:text-gray-100">
                                    Beneficiary number <span className="font-semibold text-gray-400">(gets the data)</span>
                                </Label>
                                <input
                                    id="phone"
                                    type="tel"
                                    inputMode="numeric"
                                    placeholder="0241234567"
                                    value={phoneNumber}
                                    onChange={(e) => handlePhoneChange(e.target.value)}
                                    className={cn(
                                        'w-full px-4 py-3.5 rounded-full border bg-white dark:bg-gray-800 text-base font-semibold focus:outline-none focus:ring-2 ring-primary transition-all',
                                        phoneError ? 'border-red-500' : 'border-gray-200 dark:border-gray-700'
                                    )}
                                />
                                {phoneError && (
                                    <p className="text-sm text-red-500 flex items-center gap-1">
                                        <AlertCircle className="w-4 h-4" />
                                        {phoneError}
                                    </p>
                                )}
                            </div>

                            {/* MoMo details — direct payment only */}
                            {paymentMethod === 'direct' && needsMomoDetails && (
                                <>
                                    {/* Typed on its own. Any number on any network is allowed to pay —
                                        the gateway does not require the two to match. */}
                                    <div className="space-y-2">
                                        <Label htmlFor="momo-phone" className="text-sm font-black text-gray-900 dark:text-gray-100">
                                            Mobile Money number <span className="font-semibold text-gray-400">(to pay)</span>
                                        </Label>
                                        <input
                                            id="momo-phone"
                                            type="tel"
                                            inputMode="numeric"
                                            placeholder="0241234567"
                                            value={momoPhone}
                                            onChange={(e) => setMomoPhone(e.target.value)}
                                            className="w-full px-4 py-3.5 rounded-full border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-base font-semibold focus:outline-none focus:ring-2 ring-primary transition-all"
                                        />
                                    </div>

                                    <div className="space-y-2">
                                        <Label className="text-sm font-black text-gray-900 dark:text-gray-100">Network</Label>
                                        <div className="grid grid-cols-3 gap-2">
                                            {PAY_NETWORKS.map(({ id, label, dot }) => (
                                                <button
                                                    key={id}
                                                    type="button"
                                                    onClick={() => { setSingleMomoNetwork(id); setMomoNetworkManual(true) }}
                                                    className={cn(
                                                        'flex items-center justify-center gap-2 py-3 rounded-2xl border text-sm font-bold transition-all',
                                                        singleMomoNetwork === id
                                                            ? 'border-gray-900 dark:border-white bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-white shadow-sm'
                                                            : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:border-gray-300'
                                                    )}
                                                >
                                                    <span className={cn('w-2.5 h-2.5 rounded-full shrink-0', dot)} />
                                                    {label}
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                </>
                            )}

                            {/* Fee breakdown for Direct Pay */}
                            {paymentMethod === 'direct' && selectedFee > 0 && (
                                <div className="rounded-2xl bg-muted/50 p-3 space-y-1 text-sm">
                                    <div className="flex justify-between">
                                        <span className="text-muted-foreground">Package</span>
                                        <span>{formatCurrency(selectedPrice)}</span>
                                    </div>
                                    <div className="flex justify-between">
                                        <span className="text-muted-foreground">Transaction fee</span>
                                        <span>{formatCurrency(selectedFee)}</span>
                                    </div>
                                    <div className="flex justify-between border-t border-border/50 pt-1 font-bold">
                                        <span>Total</span>
                                        <span className="text-primary">{formatCurrency(selectedTotal)}</span>
                                    </div>
                                </div>
                            )}

                            {paymentMethod === 'wallet' && walletBalance < selectedPrice && (
                                <Alert variant="destructive">
                                    <AlertCircle className="w-4 h-4" />
                                    <AlertDescription className="flex flex-wrap items-center gap-x-1">
                                        Insufficient balance.
                                        <button
                                            type="button"
                                            className="underline font-semibold"
                                            onClick={() => setPaymentMethod('direct')}
                                        >
                                            Pay directly instead
                                        </button>
                                        or top up your wallet.
                                    </AlertDescription>
                                </Alert>
                            )}

                            {/* Say WHY Pay is disabled. A greyed-out button with no
                                explanation reads as a broken page — most often the
                                beneficiary number is simply still empty, and the field's
                                placeholder is a realistic Ghana number that looks like
                                a filled-in value. */}
                            {!isPurchasing && !pollingRef && (() => {
                                let reason: string | null = null
                                if (!phoneNumber) reason = 'Enter the beneficiary number to continue.'
                                else if (phoneError) reason = null // already shown in red under the field
                                else if (paymentMethod === 'wallet' && walletBalance < selectedPrice)
                                    reason = 'Your wallet balance is too low for this package.'
                                else if (paymentMethod === 'direct' && needsMomoDetails && !effectiveMomoPhone)
                                    reason = 'Enter the Mobile Money number to charge.'
                                else if (paymentMethod === 'direct' && needsMomoDetails && !singleMomoNetwork)
                                    reason = 'Select the Mobile Money network.'
                                return reason ? (
                                    <p className="text-sm text-muted-foreground text-center">{reason}</p>
                                ) : null
                            })()}

                            <button
                                onClick={() => handlePurchase()}
                                // Deliberately NOT disabled on a missing beneficiary
                                // number — handlePurchase scrolls to the field and
                                // explains instead, so the click always does something.
                                disabled={
                                    isPurchasing ||
                                    !!pollingRef ||
                                    !!phoneError ||
                                    (paymentMethod === 'wallet' && walletBalance < selectedPrice)
                                }
                                className="w-full py-4 rounded-full bg-green-600 hover:bg-green-700 disabled:opacity-50 disabled:hover:bg-green-600 text-white text-base font-black flex items-center justify-center gap-2 transition-colors"
                            >
                                {isPurchasing || pollingRef ? (
                                    <>
                                        <Loader2 className="w-5 h-5 animate-spin" />
                                        {pollingRef ? 'Waiting for approval...' : 'Processing...'}
                                    </>
                                ) : paymentMethod === 'wallet' ? (
                                    <>
                                        <Wallet className="w-5 h-5" />
                                        Pay {formatCurrency(selectedTotal)} from wallet
                                    </>
                                ) : (
                                    <>
                                        <Smartphone className="w-5 h-5" />
                                        Proceed to payment
                                    </>
                                )}
                            </button>

                            {paymentMethod === 'direct' ? (
                                <p className="text-xs text-center text-muted-foreground">
                                    A small payment fee applies. Confirm the exact total on your phone.
                                </p>
                            ) : (
                                <p className="text-xs text-center text-muted-foreground">
                                    Wallet Balance: <span className="font-semibold text-foreground">{formatCurrency(walletBalance)}</span>
                                </p>
                            )}
                        </div>
                    )}
                    </div>
                </div>
                )
            })()}


            {/* Moolre OTP Dialog */}
            <Dialog open={otpRequired} onOpenChange={(open) => { if (!open) { setOtpRequired(false); setOtpCode('') } }}>
                {/* z-[90] because this page carries overlays at z-[70]; the Radix
                    default of z-50 puts the code entry underneath them. */}
                <DialogContent className="w-[95%] max-w-sm rounded-2xl z-[90]">
                    <DialogHeader>
                        <DialogTitle>Enter OTP</DialogTitle>
                        <DialogDescription>
                            {/* Paystack's instruction arrives without a full stop, so it
                                has to be punctuated before ours is appended or the two
                                sentences run together on screen. */}
                            {(otpMessage || `Your network sent a one-time code to ${effectiveMomoPhone || 'your phone'}`)
                                .trim().replace(/([^.!?])$/, '$1.')}
                            {' '}Enter it below to authorise this payment. If nothing arrives within a minute, close this and try again.
                        </DialogDescription>
                    </DialogHeader>
                    <Input
                        autoFocus
                        inputMode="numeric"
                        placeholder="Enter OTP"
                        value={otpCode}
                        onChange={(e) => setOtpCode(e.target.value)}
                        className="text-center text-lg tracking-widest"
                    />
                    <DialogFooter>
                        <Button variant="outline" onClick={() => { setOtpRequired(false); setOtpCode('') }}>
                            Cancel
                        </Button>
                        <Button onClick={handleVerifyOtp} disabled={isVerifyingOtp || !otpCode.trim()}>
                            {isVerifyingOtp ? (
                                <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Verifying...</>
                            ) : 'Verify'}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Bulk Order Success Modal */}
            <Dialog open={bulkSuccess} onOpenChange={() => setBulkSuccess(false)}>
                <DialogContent className="w-[95%] max-w-sm sm:max-w-md rounded-2xl p-4 sm:p-6">
                    <div className="space-y-5">
                        {/* Success header */}
                        <div className="flex flex-col items-center gap-2 pt-2">
                            <div className="w-14 h-14 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center">
                                <CheckCircle2 className="w-7 h-7 text-green-600" />
                            </div>
                            <DialogTitle className="text-lg font-black text-center">
                                {bulkSuccessDetails?.ordersPlaced} Orders Placed!
                            </DialogTitle>
                            <p className="text-xs text-muted-foreground text-center">All your data bundles are being processed</p>
                        </div>

                        {/* Summary stats */}
                        {bulkSuccessDetails && (
                            <div className="grid grid-cols-2 gap-3">
                                <div className="bg-muted/50 rounded-xl p-3 text-center">
                                    <p className="text-xs text-muted-foreground mb-1">Total Cost</p>
                                    <p className="font-black text-base">{formatCurrency(bulkSuccessDetails.totalCost)}</p>
                                </div>
                                <div className="bg-muted/50 rounded-xl p-3 text-center">
                                    <p className="text-xs text-muted-foreground mb-1">New Balance</p>
                                    <p className="font-black text-base">{formatCurrency(bulkSuccessDetails.newBalance)}</p>
                                </div>
                            </div>
                        )}

                        {/* Scrollable order list */}
                        {bulkSuccessDetails && bulkSuccessDetails.orders.length > 0 && (
                            <div className="rounded-xl border border-border/50 overflow-hidden">
                                <div className="bg-muted/30 px-4 py-2 border-b border-border/50">
                                    <p className="text-xs font-bold text-muted-foreground uppercase tracking-wide">Order Summary</p>
                                </div>
                                <div className="overflow-y-auto max-h-[40vh]">
                                    {bulkSuccessDetails.orders.map((o, i) => (
                                        <div key={i} className="flex items-center justify-between px-4 py-2.5 border-b border-border/30 last:border-0 hover:bg-muted/20 transition-colors">
                                            <div className="flex items-center gap-2">
                                                <div className="w-1.5 h-1.5 rounded-full bg-green-500 flex-shrink-0" />
                                                <span className="text-sm font-medium">{o.phoneNumber}</span>
                                            </div>
                                            <div className="flex items-center gap-3 text-xs text-muted-foreground">
                                                <span className="font-semibold">{o.volume}GB</span>
                                                <span className="font-black text-foreground">{formatCurrency(o.packagePrice)}</span>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}

                        {/* Actions */}
                        <div className="flex gap-3">
                            <Button
                                variant="outline"
                                className="flex-1"
                                onClick={() => setBulkSuccess(false)}
                            >
                                Done
                            </Button>
                            <Button
                                className="flex-1 bg-primary text-primary-foreground"
                                onClick={() => { setBulkSuccess(false); router.push('/dashboard/my-orders') }}
                            >
                                <ExternalLink className="w-4 h-4 mr-2" />
                                View Orders
                            </Button>
                        </div>
                    </div>
                </DialogContent>
            </Dialog>

            <MtnRegistrationDialog
                open={!!registrationPrompt}
                numbers={registrationPrompt?.numbers}
                total={registrationPrompt?.total}
                onCancel={() => setRegistrationPrompt(null)}
            />
        </div>
    )
}
