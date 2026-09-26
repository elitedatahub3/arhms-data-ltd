'use client'

import { useEffect, useState, useCallback, Suspense } from 'react'
import { useAuth } from '@/contexts/auth-context'
import { useSearchParams, useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { formatCurrency, cn, calculatePaystackFee } from '@/lib/utils'
import { resolveProvider, isMomoPromptProvider, type PaymentProvider } from '@/lib/payment-provider'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { Loader2, Package, CheckCircle2, ShoppingCart, CreditCard, Wallet, AlertCircle, Copy, Clock, FileText, Zap, Smartphone } from 'lucide-react'
import { toast } from 'sonner'

interface BulkTier { min_qty: number; max_qty: number; unit_price: number }
interface RCType {
    id: string; name: string; customer_price: number; agent_price: number; dealer_price?: number; is_active: boolean
    bulk_pricing?: BulkTier[]
    stock?: { available: number; reserved: number; sold: number }
}

interface PurchaseSuccess {
    reference: string
    type_name: string
    vouchers: Array<{ id: string; pin: string; serial_number: string }>
}

function ResultsCheckerContent() {
    const { dbUser, refreshUser } = useAuth()
    const router = useRouter()
    const searchParams = useSearchParams()

    const [types, setTypes] = useState<RCType[]>([])
    const [loading, setLoading] = useState(true)
    
    // Purchase form state
    const [selectedTypeId, setSelectedTypeId] = useState<string>('')
    const [quantity, setQuantity] = useState<number>(1)
    
    // Settings state
    const [rcWalletPaymentEnabled, setRcWalletPaymentEnabled] = useState(false)
    const [webPaymentProvider, setWebPaymentProvider] = useState<PaymentProvider>('moolre')
    const [paystackFeePercent, setPaystackFeePercent] = useState(1.95)
    const [paymentMethod, setPaymentMethod] = useState<'wallet' | 'direct'>('direct')
    const [paymentNetwork, setPaymentNetwork] = useState('')
    
    // Customer info form (pre-filled if possible)
    const [customerName, setCustomerName] = useState(dbUser ? `${dbUser.first_name || ''} ${dbUser.last_name || ''}`.trim() : '')
    const [customerEmail, setCustomerEmail] = useState(dbUser?.email || '')
    const [customerPhone, setCustomerPhone] = useState(dbUser?.phone_number || '')
    
    // Direct Payment Flow State
    const [pollingRef, setPollingRef] = useState<string | null>(null)
    const [otpRequired, setOtpRequired] = useState(false)
    const [otpCode, setOtpCode] = useState('')
    const [paymentReference, setPaymentReference] = useState<string | null>(null)

    const [isPurchasing, setIsPurchasing] = useState(false)
    const [successData, setSuccessData] = useState<PurchaseSuccess | null>(null)
    const [orders, setOrders] = useState<any[]>([])
    const [loadingOrders, setLoadingOrders] = useState(true)
    const [ordersError, setOrdersError] = useState<string | null>(null)

    const isAgent = dbUser?.role === 'agent'
    const [walletBalance, setWalletBalance] = useState(0)

    const fetchSettings = useCallback(async () => {
        try {
            const res = await fetch('/api/admin-settings?keys=rc_wallet_payment_enabled,active_payment_provider_web,paystack_fee_percent,agent_paystack_fee_percent,results_checker_only_mode')
            if (!res.ok) return
            const settings = await res.json()

            // In Results Checker Only mode, force direct payments and hide the wallet
            // option. Otherwise, honor the admin's wallet-payment setting.
            const rcOnlyMode = String(settings.results_checker_only_mode) === 'true'
            if (rcOnlyMode) {
                setRcWalletPaymentEnabled(false)
                setPaymentMethod('direct')
            } else {
                const walletEnabled = String(settings.rc_wallet_payment_enabled) !== 'false'
                setRcWalletPaymentEnabled(walletEnabled)
                setPaymentMethod(walletEnabled ? 'wallet' : 'direct')
            }

            setWebPaymentProvider(resolveProvider(settings.active_payment_provider_web))

            const feeKey = dbUser?.role === 'agent' ? 'agent_paystack_fee_percent' : 'paystack_fee_percent'
            const feeVal = parseFloat(settings[feeKey] || settings.paystack_fee_percent || '1.95')
            if (!isNaN(feeVal)) setPaystackFeePercent(feeVal)
        } catch (error) {
            console.error('Error fetching settings:', error)
        }
    }, [dbUser])

    const fetchTypes = useCallback(async () => {
        setLoading(true)
        try {
            const res = await fetch('/api/vouchers/types')
            const json = await res.json()
            if (res.ok) {
                const active = (json.data || []).filter((t: RCType) => t.is_active && (t.stock?.available || 0) > 0)
                setTypes(active)
                if (active.length > 0 && !selectedTypeId) setSelectedTypeId(active[0].id)
            }
        } finally { setLoading(false) }
    }, [selectedTypeId])

    useEffect(() => { 
        fetchTypes()
        fetchSettings()
    }, [fetchTypes, fetchSettings])

    const fetchWalletBalance = useCallback(async () => {
        if (!dbUser?.id) return
        const { data } = await (supabase.from('wallets').select('balance').eq('user_id', dbUser.id).single() as any)
        if (data) setWalletBalance(data.balance || 0)
    }, [dbUser?.id])

    const fetchOrders = useCallback(async () => {
        setLoadingOrders(true)
        setOrdersError(null)
        try {
            const res = await fetch('/api/vouchers/history')
            const json = await res.json()
            if (res.ok && json.success) {
                setOrders(json.data || [])
            } else {
                const msg = json.error || `Error ${res.status}`
                setOrdersError(msg)
            }
        } catch (error: any) {
            setOrdersError('Network error — could not load history.')
        } finally {
            setLoadingOrders(false)
        }
    }, [])

    useEffect(() => { fetchWalletBalance() }, [fetchWalletBalance])
    useEffect(() => { fetchOrders() }, [fetchOrders])

    // Handle Paystack callback
    useEffect(() => {
        const paystackRef = searchParams.get('reference')
        const trxref = searchParams.get('trxref')
        if (paystackRef && trxref) {
            setPollingRef(paystackRef)
            setIsPurchasing(true)
            router.replace('/dashboard/results-checker')
        }
    }, [searchParams, router])

    // Poll for order completion
    useEffect(() => {
        let interval: NodeJS.Timeout
        if (pollingRef) {
            interval = setInterval(async () => {
                try {
                    const { data: order } = await (supabase
                        .from('results_checker_orders')
                        .select('id, status, payment_status, inventory_ids, type_name')
                        .eq('reference_code', pollingRef)
                        .single() as any)
                    
                    if (order && order.status === 'completed') {
                        clearInterval(interval)
                        setPollingRef(null)
                        setIsPurchasing(false)
                        toast.success('Payment completed successfully!')
                        
                        // Fetch vouchers
                        const { data: inventory } = await supabase
                            .from('results_checker_inventory')
                            .select('id, pin, serial_number')
                            .in('id', order.inventory_ids || [])
                            
                        setSuccessData({
                            reference: pollingRef,
                            type_name: order.type_name,
                            vouchers: inventory || []
                        })
                        
                        fetchOrders()
                    } else if (order && order.status === 'failed') {
                        clearInterval(interval)
                        setPollingRef(null)
                        setIsPurchasing(false)
                        toast.error('Payment failed or cancelled.')
                    }
                } catch (e) {
                    console.error('Polling error', e)
                }
            }, 3000)
        }
        return () => clearInterval(interval)
    }, [pollingRef, fetchOrders])

    const selectedType = types.find(t => t.id === selectedTypeId)
    const role = dbUser?.role || 'customer'
    const isDealer = role === 'dealer'

    // 1. Base role price
    const baseUnitPrice = selectedType
        ? isAgent ? selectedType.agent_price
        : isDealer && (selectedType as any).dealer_price > 0 ? (selectedType as any).dealer_price
        : selectedType.customer_price
        : 0

    // 2. JSONB bulk tier match
    const tiers: BulkTier[] = Array.isArray(selectedType?.bulk_pricing) ? selectedType!.bulk_pricing : []
    const matchedTier = tiers.find(t => quantity >= t.min_qty && quantity <= t.max_qty) ?? null
    const isBulk = matchedTier !== null

    // 3. Effective unit price
    const unitPrice = isBulk ? matchedTier!.unit_price : baseUnitPrice
    const subtotal = parseFloat((unitPrice * quantity).toFixed(2))
    
    // Gateway fee for Direct Payment
    const HUBTEL_FEE_PERCENT = 1.8
    const gatewayFee = paymentMethod === 'direct' 
        ? webPaymentProvider === 'hubtel' 
            ? parseFloat((subtotal * (HUBTEL_FEE_PERCENT / 100)).toFixed(2))
            : (webPaymentProvider === 'paystack' || webPaymentProvider === 'payswitch')
                ? calculatePaystackFee(subtotal, paystackFeePercent)
                : 0
        : 0

    const totalToPay = subtotal + gatewayFee
    const canAffordWallet = walletBalance >= subtotal

    const handlePurchase = async (e: React.FormEvent) => {
        e.preventDefault()
        if (!selectedType) { toast.error('Please select a voucher type'); return }
        if (!customerName || !customerPhone) { toast.error('Name and phone are required'); return }
        
        if (paymentMethod === 'wallet') {
            if (!canAffordWallet) { toast.error('Insufficient wallet balance'); return }

            setIsPurchasing(true)
            try {
                const res = await fetch('/api/vouchers/wallet-purchase', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        typeId: selectedType.id,
                        quantity,
                        customerName,
                        customerEmail,
                        customerPhone
                    })
                })
                const data = await res.json()
                if (!res.ok) { throw new Error(data.error || 'Purchase failed') }

                toast.success('Purchase successful!')
                await refreshUser()
                await fetchWalletBalance()
                setSuccessData({
                    reference: data.data?.order?.reference_code || '',
                    type_name: selectedType.name,
                    vouchers: data.data?.vouchers || []
                })
                fetchTypes()
                fetchOrders()
            } catch (err: any) {
                console.error('[Purchase Error]', err)
                toast.error(err.message || 'An error occurred during purchase')
            } finally {
                setIsPurchasing(false)
            }
        } else {
            // DIRECT PAYMENT
            if (isMomoPromptProvider(webPaymentProvider) && !paymentNetwork) {
                toast.error('Please select a Mobile Money network')
                return
            }

            setIsPurchasing(true)
            try {
                const res = await fetch('/api/vouchers/gateway-init', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        typeId: selectedType.id,
                        quantity,
                        customerName,
                        customerEmail,
                        customerPhone,
                        momoPhone: customerPhone,
                        momoNetwork: paymentNetwork
                    })
                })
                const data = await res.json()


                if (!res.ok) { throw new Error(data.error || 'Purchase failed') }

                if (data.gateway === 'paystack') {
                    window.location.href = data.authorization_url
                    return
                }

                if (data.gateway === 'hubtel') {
                    toast.success(data.message || 'Payment prompt sent! Please approve on your phone.')
                    setPollingRef(data.reference)
                    setIsPurchasing(false)
                    return
                }

                // Moolre
                setPaymentReference(data.reference)
                if (data.otpRequired) {
                    setOtpRequired(true)
                } else {
                    toast.success(data.message || 'Payment prompt sent! Please approve on your phone.')
                    setPollingRef(data.reference)
                }
                setIsPurchasing(false)
            } catch (err: any) {
                console.error('[Purchase Error]', err)
                toast.error(err.message || 'An error occurred during purchase')
                setIsPurchasing(false)
            }
        }
    }

    const handleVerifyOtp = async () => {
        if (!otpCode || otpCode.trim().length < 1) {
            toast.error('Please enter the OTP sent to your phone')
            return
        }

        setIsPurchasing(true)
        try {
            const res = await fetch('/api/vouchers/gateway-init', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    typeId: selectedType?.id,
                    quantity,
                    customerName,
                    customerEmail,
                    customerPhone,
                    momoPhone: customerPhone,
                    momoNetwork: paymentNetwork,
                    otpCode: otpCode.trim(),
                    // The reference of the charge the code belongs to. Without it the
                    // route has no way to know this is a retry and mints a fresh order
                    // on every attempt — already an orphan-row bug under Moolre, and
                    // fatal for Paystack, whose submit_otp needs the original
                    // reference to identify the charge at all.
                    reference: paymentReference,
                })
            })
            const data = await res.json()
            if (!res.ok) { throw new Error(data.error || 'Invalid OTP. Please try again.') }

            setOtpRequired(false)
            setOtpCode('')
            toast.success(data.message || 'OTP verified! Please approve the prompt on your phone.')
            setPollingRef(data.reference)
        } catch (error: any) {
            toast.error(error.message || 'Failed to verify OTP')
        } finally {
            setIsPurchasing(false)
        }
    }

    const copyToClipboard = (text: string) => {
        navigator.clipboard.writeText(text)
        toast.success('Copied to clipboard')
    }

    if (loading) {
        return <div className="flex-1 flex items-center justify-center min-h-[400px]"><Loader2 className="w-8 h-8 animate-spin text-muted-foreground" /></div>
    }

    if (types.length === 0) {
        return (
            <div className="flex-1 space-y-6 p-4 md:p-8 pt-6 max-w-5xl mx-auto w-full">
                <Card className="border-border/50 text-center py-12">
                    <CardContent>
                        <Package className="w-12 h-12 text-muted-foreground mx-auto mb-4 opacity-50" />
                        <h2 className="text-xl font-semibold mb-2">Check back soon!</h2>
                        <p className="text-muted-foreground">Results checker vouchers are currently out of stock. We are restocking soon.</p>
                    </CardContent>
                </Card>
            </div>
        )
    }

    return (
        <div className="flex-1 space-y-6 p-4 md:p-8 pt-6 max-w-5xl mx-auto w-full">
            <div className="flex flex-col gap-2">
                <h1 className="text-3xl font-bold tracking-tight">Buy Results Checker Vouchers</h1>
                <p className="text-muted-foreground text-sm">Purchase WAEC, NECO, and other examination result checking pins instantly.</p>
            </div>

            <div className="grid md:grid-cols-2 gap-6 items-start">
                {/* Left Col: Purchase Form */}
                <Card className="border-border/50">
                    <CardHeader>
                        <CardTitle>Voucher Details</CardTitle>
                        <CardDescription>Select type and quantity</CardDescription>
                    </CardHeader>
                    <CardContent>
                        <form onSubmit={handlePurchase} className="space-y-5">
                            
                            <div className="space-y-3">
                                <Label>Voucher Type</Label>
                                <div className="grid grid-cols-2 gap-3">
                                    {types.map((t) => {
                                        const isSelected = selectedTypeId === t.id
                                        const outOfStock = !t.stock || t.stock.available === 0
                                        const displayPrice = isAgent ? t.agent_price : (isDealer && (t as any).dealer_price > 0 ? (t as any).dealer_price : t.customer_price)
                                        return (
                                            <button
                                                key={t.id}
                                                type="button"
                                                disabled={outOfStock}
                                                onClick={() => !outOfStock && setSelectedTypeId(isSelected ? '' : t.id)}
                                                className={`relative p-4 rounded-2xl border-2 text-left transition-all duration-200 flex flex-col gap-1.5 ${
                                                    outOfStock ? 'bg-gray-50 dark:bg-gray-800/50 border-gray-200 dark:border-gray-700 opacity-70 cursor-not-allowed' :
                                                    isSelected ? 'bg-primary border-primary shadow-lg scale-[1.02] active:scale-95' : 'bg-card border-border/50 hover:border-primary/30 hover:bg-muted/30 hover:shadow-md active:scale-95'
                                                }`}
                                            >
                                                {isSelected && <div className="absolute top-2 right-2"><CheckCircle2 className="w-4 h-4 text-primary-foreground" /></div>}
                                                
                                                <div className={`inline-block text-[10px] font-black px-2 py-0.5 rounded-full self-start ${outOfStock ? "bg-muted text-muted-foreground" : "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400"}`}>
                                                    PIN + SERIAL
                                                </div>
                                                
                                                <p className={`text-base font-black leading-tight ${isSelected ? 'text-primary-foreground' : 'text-foreground'}`}>
                                                    {t.name}
                                                </p>
                                                <p className={`text-sm font-bold ${isSelected ? 'text-primary-foreground/90' : 'text-muted-foreground'}`}>
                                                    {formatCurrency(displayPrice)}
                                                </p>
                                                
                                                {outOfStock ? (
                                                    <div className="inline-flex items-center gap-1 text-[9px] font-bold px-2 py-0.5 rounded-full mt-0.5 self-start bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400">
                                                        Out of Stock
                                                    </div>
                                                ) : (
                                                    <div className={`inline-flex items-center gap-1 text-[9px] font-bold px-2 py-0.5 rounded-full mt-0.5 self-start ${isSelected ? 'bg-primary-foreground/20 text-primary-foreground' : 'bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400'}`}>
                                                        <Zap className="w-2.5 h-2.5" /> Instant Delivery
                                                    </div>
                                                )}
                                            </button>
                                        )
                                    })}
                                </div>
                            </div>

                            <div className="space-y-1.5">
                                <div className="flex items-center justify-between">
                                    <Label>Quantity</Label>
                                    {tiers.length > 0 && (
                                        <span className="text-[10px] font-bold text-amber-600 dark:text-amber-400 uppercase tracking-widest">Bulk Pricing Available</span>
                                    )}
                                </div>
                                <div className="flex items-center gap-3">
                                    <Button type="button" variant="outline" size="icon" onClick={() => setQuantity(Math.max(1, quantity - 1))} disabled={quantity <= 1}>−</Button>
                                    <Input
                                        type="number" min="1" max="100" value={quantity}
                                        onChange={e => setQuantity(Math.max(1, Math.min(100, parseInt(e.target.value) || 1)))}
                                        className="text-center w-20 font-bold [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                                    />
                                    <Button type="button" variant="outline" size="icon" onClick={() => setQuantity(Math.min(100, quantity + 1))}>+</Button>
                                </div>
                                <p className="text-xs text-muted-foreground">Bulk discounts apply automatically · Max 100</p>
                            </div>

                            <div className="space-y-3 pt-2">
                                <Label>Customer Details (For Delivery)</Label>
                                <Input placeholder="Full Name" value={customerName} onChange={e => setCustomerName(e.target.value)} required />
                                <Input placeholder="Phone Number (WhatsApp / MoMo)" value={customerPhone} onChange={e => setCustomerPhone(e.target.value)} required />
                                <Input type="email" placeholder="Email Address (Optional)" value={customerEmail} onChange={e => setCustomerEmail(e.target.value)} />
                            </div>

                            {/* Payment Method Selector */}
                            {rcWalletPaymentEnabled && (
                                <div className="space-y-3 pt-2 border-t mt-4">
                                    <Label>Payment Method</Label>
                                    <div className="grid grid-cols-2 gap-3">
                                        <button
                                            type="button"
                                            onClick={() => setPaymentMethod('wallet')}
                                            className={cn(
                                                "p-3 rounded-xl border flex items-center gap-3 transition-colors text-left",
                                                paymentMethod === 'wallet' ? "border-primary bg-primary/5 ring-1 ring-primary" : "hover:bg-muted/50"
                                            )}
                                        >
                                            <Wallet className="w-5 h-5 text-primary" />
                                            <div>
                                                <div className="font-semibold text-sm">Wallet</div>
                                                <div className="text-xs text-muted-foreground">{formatCurrency(walletBalance)} available</div>
                                            </div>
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => setPaymentMethod('direct')}
                                            className={cn(
                                                "p-3 rounded-xl border flex items-center gap-3 transition-colors text-left",
                                                paymentMethod === 'direct' ? "border-primary bg-primary/5 ring-1 ring-primary" : "hover:bg-muted/50"
                                            )}
                                        >
                                            <CreditCard className="w-5 h-5 text-blue-500" />
                                            <div>
                                                <div className="font-semibold text-sm">Direct Pay</div>
                                                <div className="text-xs text-muted-foreground">MoMo or Card</div>
                                            </div>
                                        </button>
                                    </div>
                                </div>
                            )}

                            {/* MoMo Network Selector (if Direct and Moolre/Hubtel) */}
                            {paymentMethod === 'direct' && isMomoPromptProvider(webPaymentProvider) && (
                                <div className="space-y-2 pt-2 animate-in fade-in slide-in-from-top-2">
                                    <Label>Mobile Money Network</Label>
                                    <Select value={paymentNetwork} onValueChange={setPaymentNetwork} required>
                                        <SelectTrigger className="h-12">
                                            <SelectValue placeholder="Select Network" />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="MTN">MTN MoMo</SelectItem>
                                            <SelectItem value="Telecel">Telecel Cash</SelectItem>
                                            <SelectItem value="AT">AT Money</SelectItem>
                                        </SelectContent>
                                    </Select>
                                    <p className="text-xs text-muted-foreground">A payment prompt will be sent to {customerPhone || 'your phone'}.</p>
                                </div>
                            )}

                            {paymentMethod === 'wallet' && !canAffordWallet && (
                                <div className="bg-red-50 dark:bg-red-900/10 border border-red-200 dark:border-red-900/30 rounded-md p-3 flex gap-2">
                                    <AlertCircle className="w-5 h-5 text-red-600 mt-0.5" />
                                    <div>
                                        <p className="text-sm font-semibold text-red-800 dark:text-red-400">Insufficient Funds</p>
                                        <p className="text-xs text-red-600 dark:text-red-300">Your wallet balance is {formatCurrency(walletBalance)}. You need {formatCurrency(subtotal)}.</p>
                                    </div>
                                </div>
                            )}

                            <Button 
                                type="submit" 
                                size="lg" 
                                className="w-full h-12 text-base font-bold shadow-lg mt-4"
                                disabled={isPurchasing || !!pollingRef || (paymentMethod === 'wallet' && !canAffordWallet)}
                            >
                                {isPurchasing || pollingRef ? (
                                    <><Loader2 className="w-5 h-5 mr-2 animate-spin" /> {pollingRef ? 'Waiting for Approval...' : 'Processing...'}</>
                                ) : (
                                    <><ShoppingCart className="w-5 h-5 mr-2" /> Pay {formatCurrency(totalToPay)}</>
                                )}
                            </Button>
                        </form>
                    </CardContent>
                </Card>

                {/* Right Col: Summary Panel */}
                <div className="space-y-6">
                    <Card className="border-border/50 bg-primary/5 border-primary/20">
                        <CardHeader className="pb-3">
                            <CardTitle className="text-lg">Order Summary</CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-4">
                            <div className="flex justify-between items-center text-sm">
                                <span className="text-muted-foreground">Item:</span>
                                <span className="font-semibold">{selectedType?.name || '—'}</span>
                            </div>
                            <div className="flex justify-between items-center text-sm">
                                <span className="text-muted-foreground">Unit Price:</span>
                                <div className="flex items-center gap-2">
                                    <span>{formatCurrency(unitPrice)}</span>
                                    {isBulk && (
                                        <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">bulk</span>
                                    )}
                                </div>
                            </div>
                            <div className="flex justify-between items-center text-sm">
                                <span className="text-muted-foreground">Quantity:</span>
                                <span>{quantity}x</span>
                            </div>

                            {gatewayFee > 0 && (
                                <div className="flex justify-between items-center text-sm">
                                    <span className="text-muted-foreground">Processing Fee:</span>
                                    <span>{formatCurrency(gatewayFee)}</span>
                                </div>
                            )}

                            <div className="pt-3 border-t border-primary/20 flex justify-between items-center">
                                <span className="font-semibold">Total to Pay:</span>
                                <span className="text-2xl font-bold text-primary">{formatCurrency(totalToPay)}</span>
                            </div>
                            {isAgent && (
                                <Badge variant="secondary" className="w-full justify-center mt-2 bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400">
                                    Agent discount applied
                                </Badge>
                            )}
                        </CardContent>
                    </Card>
                </div>
            </div>

            {/* Order History Section */}
            <div className="mt-12 space-y-4">
                <div className="flex items-center gap-2">
                    <Clock className="w-5 h-5 text-muted-foreground" />
                    <h2 className="text-xl font-semibold">Your Vouchers</h2>
                </div>
                
                {loadingOrders ? (
                    <div className="flex justify-center p-8"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
                ) : ordersError ? (
                    <Card className="border-red-200 dark:border-red-900/30 text-center py-8 bg-red-50 dark:bg-red-900/10">
                        <CardContent>
                            <AlertCircle className="w-8 h-8 text-red-500 mx-auto mb-2" />
                            <p className="text-sm font-semibold text-red-700 dark:text-red-400">Could not load your vouchers</p>
                            <p className="text-xs text-red-600 dark:text-red-300 mt-1">{ordersError}</p>
                            <Button variant="outline" size="sm" className="mt-4" onClick={fetchOrders}>Try Again</Button>
                        </CardContent>
                    </Card>
                ) : orders.length === 0 ? (
                    <Card className="border-border/50 text-center py-12 bg-muted/20">
                        <CardContent>
                            <FileText className="w-10 h-10 text-muted-foreground/30 mx-auto mb-3" />
                            <p className="text-muted-foreground">You haven't purchased any vouchers yet.</p>
                        </CardContent>
                    </Card>
                ) : (
                    <div className="grid gap-4 md:grid-cols-2">
                        {orders.map(order => (
                            <Card key={order.id} className="border-border/50 shadow-sm overflow-hidden flex flex-col">
                                <div className="bg-muted/40 px-4 py-3 border-b border-border/50 flex justify-between items-center">
                                    <div>
                                        <div className="font-semibold">{order.type_name}</div>
                                        <div className="text-xs text-muted-foreground">{new Date(order.created_at).toLocaleDateString()} &bull; {order.quantity}x</div>
                                    </div>
                                    <Badge variant={order.status === 'completed' ? 'completed' : order.status === 'failed' ? 'failed' : 'pending'} className="capitalize">
                                        {order.status}
                                    </Badge>
                                </div>
                                <CardContent className="p-0 flex-1 bg-card">
                                    {order.vouchers && order.vouchers.length > 0 ? (
                                        <div className="divide-y divide-border/50">
                                            {order.vouchers.map((voucher: any, idx: number) => (
                                                <div key={idx} className="p-3 hover:bg-muted/20 transition-colors flex flex-col sm:flex-row gap-2 sm:items-center justify-between">
                                                    <div className="space-y-1">
                                                        <div className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">PIN</div>
                                                        <div className="font-mono font-bold text-primary tracking-widest flex items-center gap-2">
                                                            {voucher.pin}
                                                            <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => copyToClipboard(voucher.pin)}><Copy className="w-3 h-3" /></Button>
                                                        </div>
                                                    </div>
                                                    <div className="space-y-1 sm:text-right flex flex-col items-start sm:items-end">
                                                        <div className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">Serial</div>
                                                        <div className="font-mono text-sm flex items-center gap-2">
                                                            {voucher.serial_number}
                                                            <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => copyToClipboard(voucher.serial_number)}><Copy className="w-3 h-3 text-muted-foreground" /></Button>
                                                        </div>
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    ) : (
                                        <div className="p-6 text-center text-sm text-muted-foreground">
                                            {order.status === 'completed' ? 'Vouchers not found.' : 'Waiting for payment/processing...'}
                                        </div>
                                    )}
                                </CardContent>
                            </Card>
                        ))}
                    </div>
                )}
            </div>


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
                    <DialogFooter className="sm:justify-end">
                        <Button type="button" variant="secondary" onClick={() => setOtpRequired(false)}>Cancel</Button>
                        <Button type="button" onClick={handleVerifyOtp} disabled={isPurchasing || !otpCode} className="bg-blue-600 hover:bg-blue-700">
                            {isPurchasing ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Verify & Continue'}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Success Modal */}
            <Dialog open={!!successData} onOpenChange={v => !v && setSuccessData(null)}>
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <div className="mx-auto w-12 h-12 bg-emerald-100 dark:bg-emerald-900/30 rounded-full flex items-center justify-center mb-3">
                            <CheckCircle2 className="w-6 h-6 text-emerald-600" />
                        </div>
                        <DialogTitle className="text-center text-xl">Purchase Successful!</DialogTitle>
                        <DialogDescription className="text-center">
                            Your payment was successful. Here are your voucher details. They have also been sent to {customerPhone}.
                        </DialogDescription>
                    </DialogHeader>
                    
                    {successData && (
                        <div className="mt-4 space-y-4">
                            <div className="bg-muted/40 p-3 rounded-lg text-sm flex justify-between items-center">
                                <span className="text-muted-foreground">Order Ref:</span>
                                <span className="font-mono font-semibold">{successData.reference}</span>
                            </div>

                            <div className="space-y-3 max-h-[40vh] overflow-y-auto pr-2">
                                {successData.vouchers.map((v, i) => (
                                    <div key={v.id} className="border border-border/60 rounded-xl p-4 bg-card relative">
                                        <div className="absolute top-2 right-3 text-xs font-semibold text-muted-foreground/50">#{i+1}</div>
                                        <div className="space-y-2 pt-2">
                                            <div className="flex flex-col gap-1">
                                                <Label className="text-xs text-muted-foreground uppercase tracking-wide">PIN</Label>
                                                <div className="flex gap-2">
                                                    <code className="flex-1 bg-muted px-3 py-2 rounded-md text-lg font-bold tracking-widest text-primary text-center">
                                                        {v.pin}
                                                    </code>
                                                    <Button variant="outline" size="icon" className="h-auto w-12 shrink-0" onClick={() => copyToClipboard(v.pin)} title="Copy PIN">
                                                        <Copy className="w-4 h-4" />
                                                    </Button>
                                                </div>
                                            </div>
                                            <div className="flex flex-col gap-1">
                                                <Label className="text-xs text-muted-foreground uppercase tracking-wide">Serial Number</Label>
                                                <div className="flex gap-2">
                                                    <code className="flex-1 bg-muted/50 px-3 py-1.5 rounded-md text-sm font-mono text-center">
                                                        {v.serial_number}
                                                    </code>
                                                    <Button variant="outline" size="icon" className="h-auto w-12 shrink-0" onClick={() => copyToClipboard(v.serial_number)} title="Copy Serial">
                                                        <Copy className="w-3 h-3 text-muted-foreground" />
                                                    </Button>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    <DialogFooter className="mt-6">
                        <Button className="w-full" onClick={() => setSuccessData(null)}>Done</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    )
}

export default function ResultsCheckerPage() {
    return (
        <Suspense fallback={
            <div className="flex-1 space-y-6 p-4 md:p-8 pt-6 max-w-5xl mx-auto w-full">
                <Skeleton className="h-[400px] w-full" />
            </div>
        }>
            <ResultsCheckerContent />
        </Suspense>
    )
}
