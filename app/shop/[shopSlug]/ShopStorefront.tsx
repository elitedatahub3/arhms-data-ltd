'use client'

import { useState, useEffect, useMemo, useRef } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { formatCurrency } from '@/lib/utils'
import { cn } from '@/lib/utils'
import { resolveProvider, SCOPE_PROVIDERS, PROVIDER_LABEL, type PaymentProvider } from '@/lib/payment-provider'
import { NETWORK_ORDER, NetworkLogo, detectPayNetwork, type PayNetwork } from '@/lib/networks'
import {
    Phone, Mail, MessageCircle, ShoppingCart, Loader2,
    CheckCircle2, AlertCircle, X, Search, Zap, Smartphone, ChevronDown, Check, Menu, Bell,
    History, TrendingUp, Coins, Calendar, CalendarRange, RefreshCw, Info, Clock, Copy, ArrowRight, AlertTriangle, Users, Target, Sparkles, Download, Share2, GraduationCap, Store, BadgeCheck
} from 'lucide-react'
import {
    ID_TYPES, REGIONS, AFA_REQUIRED_FIELDS, MIN_AFA_AGE,
    validateId, maskIdNumber, ageFromDob, maxDobInputValue,
} from '@/lib/afa-validation'
import { toast } from 'sonner'
import { ThemeToggle } from '@/components/ui/theme-toggle'
import { CopyrightFooter } from '@/components/CopyrightFooter'
import dynamic from 'next/dynamic'
import { usePwa } from '@/hooks/use-pwa'
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    DialogFooter
} from "@/components/ui/dialog"
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { MtnRegistrationDialog } from '@/components/dashboard/mtn-registration-dialog'
import { AnnouncementModal } from '@/components/announcements/announcement-modal'
import type { AnnouncementTone } from '@/lib/announcement-tones'

const ShopPwaInstallPrompt = dynamic(() => import('@/components/ShopPwaInstallPrompt'), { ssr: false })

// ─── Divider SVG paths (matching setup page) ──────────────────────────────────
const DIVIDER_PATHS: Record<string, string> = {
    'asymmetric-curve': 'M321.39,56.44c58-10.79,114.16-30.13,172-41.86,82.39-16.72,168.19-17.73,250.45-.39C823.78,31,906.67,72,985.66,92.83c70.05,18.48,146.53,26.09,214.34,3V120H0V0C0,0,0,0,0,0c0,0,0,0,0,0Q160.69,78,321.39,56.44Z',
    'angled': 'M0,0 L1200,80 L1200,120 L0,120 Z',
    'zigzag': 'M0,60 L100,0 L200,60 L300,0 L400,60 L500,0 L600,60 L700,0 L800,60 L900,0 L1000,60 L1100,0 L1200,60 L1200,120 L0,120 Z',
    'concave': 'M0,0 Q600,120 1200,0 L1200,120 L0,120 Z',
    'animated-wave': 'M0,64 C150,100 350,0 600,60 C850,120 1050,20 1200,64 L1200,120 L0,120 Z',
    'layered-waves': 'M0,80 C200,20 400,100 600,60 C800,20 1000,100 1200,80 L1200,120 L0,120 Z',
    'tilt': 'M0,40 L1200,0 L1200,120 L0,120 Z',
    'organic-blob': 'M0,80 C100,20 300,100 500,70 C700,40 900,110 1100,60 C1150,45 1180,50 1200,60 L1200,120 L0,120 Z',
    'paper-cut': 'M0,80 L120,40 L240,80 L360,40 L480,80 L600,40 L720,80 L840,40 L960,80 L1080,40 L1200,80 L1200,120 L0,120 Z',
    'torn-edge': 'M0,90 L30,70 L60,95 L90,65 L130,85 L170,60 L210,90 L260,55 L310,80 L370,50 L430,85 L490,58 L560,90 L640,55 L720,85 L800,50 L880,80 L960,45 L1040,75 L1120,50 L1200,70 L1200,120 L0,120 Z',
    'convex': 'M0,120 Q600,0 1200,120 L1200,120 L0,120 Z',
    'slant': 'M0,80 L1200,0 L1200,120 L0,120 Z',
    'skewed': 'M0,0 L900,0 L1200,120 L0,120 Z',
    'glassmorphic': 'M0,100 Q600,60 1200,100 L1200,120 L0,120 Z',
    'multi-step-wave': 'M0,60 C100,40 200,80 300,60 C400,40 500,80 600,60 C700,40 800,80 900,60 C1000,40 1100,80 1200,60 L1200,120 L0,120 Z',
}

function DividerSVG({ style, fillClass }: { style?: string | null; fillClass: string }) {
    const path = DIVIDER_PATHS[style || 'asymmetric-curve'] || DIVIDER_PATHS['asymmetric-curve']
    const isAnimated = style === 'animated-wave'
    return (
        <div className="absolute bottom-0 left-0 w-full overflow-hidden leading-none">
            <svg viewBox="0 0 1200 120" preserveAspectRatio="none" className={cn('relative block w-full h-[40px]', fillClass, isAnimated && 'animate-pulse')} aria-hidden="true">
                <title>Section divider</title>
                <path d={path} />
            </svg>
        </div>
    )
}

interface ShopData {
    id: string
    shop_name: string
    shop_slug: string
    description: string
    owner_phone: string
    owner_email: string | null
    whatsapp_number: string | null
    logo_url: string | null
    banner_url?: string | null
    community_link?: string | null
    divider_style?: string | null
    brand_color: string
    brand_accent: string
    ownerRole: string
    airtime_fee_mtn?: number
    airtime_fee_telecel?: number
    airtime_fee_at?: number
    banner_pos_x?: number
    banner_pos_y?: number
    banner_zoom?: number
    ussd_code?: string | null
    ussd_status?: string | null
}

interface Package {
    id: string
    network: string
    size: string
    description: string | null
    selling_price: number
}

interface Props {
    shop: ShopData
    packages: Package[]
    adminSettings: Record<string, string>
    initialAnnouncement?: StorefrontAnnouncement | null
}

interface StorefrontAnnouncement {
    type: 'admin' | 'shop'
    message: string
    title?: string
    /** Author's chosen colour. Absent on rows written before tones existed. */
    tone?: string
    /** Overrides the tone's default badge copy. */
    badgeLabel?: string
}

// Order, logo marks and MoMo-prefix detection now come from lib/networks.tsx,
// the single source of truth for network identity.
//
// TODO(Phase 3): `networkColors` and `getNetworkCardStyle` below are the last
// two duplicated colour maps. They are left in place deliberately — their call
// sites are spread through this 2,141-line component, which Phase 3 splits into
// CheckoutSheet / PackageGrid / NetworkTabs. Rewriting the markup twice would be
// wasted work, so they move then. Until then check-theme-scope.js keeps
// reporting them, which is the point.
const networkColors: Record<string, { bgClass: string; textClass: string; borderClass: string; gradient: string }> = {
    MTN: { bgClass: 'bg-[#FFCE00]', textClass: 'text-[#000000]', borderClass: 'border-[#e6b800]', gradient: 'from-yellow-400 to-yellow-500' },
    Telecel: { bgClass: 'bg-[#E60000]', textClass: 'text-[#ffffff]', borderClass: 'border-[#cc0000]', gradient: 'from-red-500 to-red-600' },
    'AT-iShare': { bgClass: 'bg-[#0056B3]', textClass: 'text-[#ffffff]', borderClass: 'border-[#004494]', gradient: 'from-blue-600 to-blue-700' },
    'AT-BigTime': { bgClass: 'bg-[#6f42c1]', textClass: 'text-[#ffffff]', borderClass: 'border-[#5a32a3]', gradient: 'from-purple-600 to-purple-700' },
    AT: { bgClass: 'bg-[#F97316]', textClass: 'text-[#ffffff]', borderClass: 'border-[#ea580c]', gradient: 'from-orange-500 to-orange-600' },
    'Special MTN Mashup': { bgClass: 'bg-[#FFCE00]', textClass: 'text-[#000000]', borderClass: 'border-[#e6b800]', gradient: 'from-yellow-300 to-yellow-500' },
    'EXPRESS MTN': { bgClass: 'bg-[#FFCE00]', textClass: 'text-[#000000]', borderClass: 'border-[#e6b800]', gradient: 'from-orange-300 to-yellow-500' },
}

const QUICK_AMOUNTS = [1, 2, 5, 10, 20, 50, 100]

// ─── Checkout field styling ───────────────────────────────────────────────────
// Lifted out of the data checkout sheet so the AFA registration form renders in
// the same clothes. Kept as constants rather than copied strings: the two flows
// drifted apart once already, and a customer meets both under one shop.
const SHEET_FIELD_CLASS = 'w-full px-4 py-3.5 rounded-sm border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-base font-semibold outline-none focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-[var(--brand-color)] focus:border-transparent transition-colors'
const SHEET_LABEL_CLASS = 'text-sm font-black text-gray-900 dark:text-gray-100'

const getNetworkCardStyle = (net: string) => {
    switch (net) {
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
            return { bg: 'bg-[var(--brand-color)]', bottom: 'bg-black/20', pill: 'bg-white/20 text-white', text: 'text-white', iconBg: 'bg-white/20' }
    }
}

export default function ShopStorefront({ shop, packages, adminSettings, initialAnnouncement = null }: Props) {
    const searchParams = useSearchParams()
    
    // Data State
    const [selectedPackage, setSelectedPackage] = useState<Package | null>(null)
    const [phone, setPhone] = useState('')
    const [email, setEmail] = useState('')
    // The bundle goes to `phone`; the MoMo prompt goes to `payPhone`. The two are typed
    // separately — a "use the same number" tick used to mirror one into the other, but
    // it echoed every keystroke from the beneficiary box and read as the form typing
    // for the buyer.
    const [payPhone, setPayPhone] = useState('')
    const [payNetwork, setPayNetwork] = useState<PayNetwork | null>(null)
    const [payNetworkManual, setPayNetworkManual] = useState(false)

    // Airtime State
    const [isAirtimeOpen, setIsAirtimeOpen] = useState(false)
    const [airtimePhone, setAirtimePhone] = useState('')
    const [airtimeEmail, setAirtimeEmail] = useState('')
    const [airtimeAmount, setAirtimeAmount] = useState('')
    const [detectedNetwork, setDetectedNetwork] = useState<'MTN' | 'Telecel' | 'AT' | null>(null)
    const [isManualSelection, setIsManualSelection] = useState(false)
    const [useExact, setUseExact] = useState(false)
    const airtimeRef = useRef<HTMLDivElement>(null)
    const heroRef = useRef<HTMLDivElement>(null)
    
    // Global State
    const [isSidebarOpen, setIsSidebarOpen] = useState(false)
    const [activeTab, setActiveTab] = useState<'data' | 'airtime' | 'mashup' | 'results_checker' | 'afa'>('data')
    const [showAnnouncementModal, setShowAnnouncementModal] = useState(false)
    const [loading, setLoading] = useState(false)
    const [pageLoading, setPageLoading] = useState(true)
    const [errorMsg, setErrorMsg] = useState<string | null>(null)
    const [pollingRef, setPollingRef] = useState<string | null>(null)
    const [contactInfo, setContactInfo] = useState<{ phone?: string; whatsapp?: string; email?: string } | null>(null)
    const [announcement] = useState<StorefrontAnnouncement | null>(initialAnnouncement)
    const [announcementDismissed, setAnnouncementDismissed] = useState(false)
    const [scrolled, setScrolled] = useState(false)
    // Moolre per-transaction OTP. Hubtel checkouts never ask for a code on the storefront.
    const [otpRequired, setOtpRequired] = useState(false)

    // Set when the beneficiary's MTN number isn't registered yet. Nothing has been
    // charged at this point — the guest either accepts the wait or backs out.
    const [registrationPrompt, setRegistrationPrompt] = useState<{ numbers: string[] } | null>(null)
    const [isConfirmingRegistration, setIsConfirmingRegistration] = useState(false)
    const [otpCode, setOtpCode] = useState('')
    const [otpReference, setOtpReference] = useState<string | null>(null)
    const [otpOrderType, setOtpOrderType] = useState<'data' | 'airtime' | 'mashup' | 'results_checker' | 'afa'>('data')

    // Results Checker State
    const [rcTypes, setRcTypes] = useState<any[]>([])
    const [rcPhone, setRcPhone] = useState('')
    const [rcEmail, setRcEmail] = useState('')
    const [selectedRc, setSelectedRc] = useState<any | null>(null)
    const [rcQuantity, setRcQuantity] = useState(1)

    // AFA Registration State
    const [afaConfig, setAfaConfig] = useState<{ enabled: boolean; selling_price: number } | null>(null)
    const [afaForm, setAfaForm] = useState({
        full_name: '', phone: '', id_type: 'Ghana Card', id_number: '',
        date_of_birth: '', location: '', region: 'Greater Accra', notes: '',
    })
    const [afaEmail, setAfaEmail] = useState('')
    const [afaIdError, setAfaIdError] = useState<string | null>(null)

    const { isInstallable, isInstalled, isIOS, installPwa } = usePwa()

    const handleInstallShop = async () => {
        setIsSidebarOpen(false)
        if (isIOS) {
            toast('Install on iOS', {
                description: `Tap the Share button in Safari, then "Add to Home Screen" to install ${shop.shop_name}.`,
                duration: 6000,
            })
            return
        }
        if (!isInstallable) {
            toast('Install the Shop App', {
                description: 'In your browser menu, tap "Add to Home Screen" or "Install App" to install this shop.',
                duration: 6000,
            })
            return
        }
        await installPwa()
    }

    // Mashup State
    const [mashupPhone, setMashupPhone] = useState('')
    const [mashupEmail, setMashupEmail] = useState('')
    const [mashupAmount, setMashupAmount] = useState('')
    const [bundlePreference, setBundlePreference] = useState<'balanced' | 'data' | 'voice'>('balanced')
    const [mashupUseExact, setMashupUseExact] = useState(false)

    // Derived flags for Airtime & Mashup
    const isGlobalAirtimeEnabled = adminSettings['storefront_airtime_enabled'] === 'true'
    const isGlobalMashupEnabled = adminSettings['storefront_mashup_enabled'] === 'true'
    const isGlobalRcEnabled = adminSettings['storefront_rc_enabled'] === 'true'
    const isGlobalAfaEnabled = adminSettings['storefront_afa_enabled'] === 'true'

    // USSD short code — shown only once this shop has actually bought one, and
    // only while the admin leaves the card switched on globally.
    const ussdDialCode = adminSettings['ussd_dial_code'] || ''
    const isUssdCardEnabled =
        adminSettings['storefront_ussd_card_enabled'] !== 'false' &&
        shop.ussd_status === 'active' &&
        !!shop.ussd_code &&
        !!ussdDialCode

    // Marketplace ad — defaults ON unless an admin explicitly disables it
    const isMarketplaceAdEnabled = adminSettings['storefront_marketplace_ad_enabled'] !== 'false'
    const marketplaceUrl = process.env.NEXT_PUBLIC_MARKETPLACE_URL || 'https://marketplace.arhmsgh.com'
    
    const airtimeNetworks = [
        { id: 'MTN', fee: shop.airtime_fee_mtn || 0, enabled: adminSettings['airtime_enabled_mtn'] !== 'false' },
        { id: 'Telecel', fee: shop.airtime_fee_telecel || 0, enabled: adminSettings['airtime_enabled_telecel'] !== 'false' },
        { id: 'AT', fee: shop.airtime_fee_at || 0, enabled: adminSettings['airtime_enabled_at'] !== 'false' }
    ].filter(n => n.enabled)

    const isShopAirtimeEnabled = isGlobalAirtimeEnabled && airtimeNetworks.length > 0
    const isShopRcEnabled = isGlobalRcEnabled && rcTypes.length > 0
    // The owner must have priced AFA; /api/shop/afa/config returns enabled:false otherwise.
    const isShopAfaEnabled = isGlobalAfaEnabled && !!afaConfig?.selling_price

    const [ussdCopied, setUssdCopied] = useState(false)

    const [isSpecialMtnMashupHidden, setIsSpecialMtnMashupHidden] = useState(adminSettings['special_mtn_mashup_hidden'] === 'true')
    const [isExpressMtnHidden, setIsExpressMtnHidden] = useState(adminSettings['express_mtn_hidden'] === 'true')
    const [isStandardMtnHidden, setIsStandardMtnHidden] = useState(adminSettings['standard_mtn_hidden'] === 'true')

    const [webPaymentProvider, setWebPaymentProvider] = useState<PaymentProvider>('moolre')

    useEffect(() => {
        // Bypass ISR cache to get the very latest toggle status
        fetch('/api/admin-settings?keys=special_mtn_mashup_hidden,express_mtn_hidden,standard_mtn_hidden,active_payment_provider_web', { cache: 'no-store' })
            .then(res => res.json())
            .then(data => {
                if (data && typeof data.special_mtn_mashup_hidden !== 'undefined') {
                    setIsSpecialMtnMashupHidden(String(data.special_mtn_mashup_hidden) === 'true')
                }
                if (data && typeof data.express_mtn_hidden !== 'undefined') {
                    setIsExpressMtnHidden(String(data.express_mtn_hidden) === 'true')
                }
                if (data && typeof data.standard_mtn_hidden !== 'undefined') {
                    setIsStandardMtnHidden(String(data.standard_mtn_hidden) === 'true')
                }
                if (data && data.active_payment_provider_web) {
                    setWebPaymentProvider(resolveProvider(data.active_payment_provider_web))
                }
            })
            .catch(() => {})
    }, [])

    const networks = useMemo(() => {
        const available = NETWORK_ORDER.filter(n => {
            if (n === 'Special MTN Mashup' && isSpecialMtnMashupHidden) return false
            if (n === 'EXPRESS MTN' && isExpressMtnHidden) return false
            if (n === 'MTN' && isStandardMtnHidden) return false
            return packages.some(p => p.network === n)
        })
        const extra = [...new Set(packages.map(p => p.network))].filter(n => !(NETWORK_ORDER as string[]).includes(n))
        return [...available, ...extra]
    }, [packages, isSpecialMtnMashupHidden, isExpressMtnHidden, isStandardMtnHidden])

    const [activeNetwork, setActiveNetwork] = useState<string>(networks[0] || '')

    useEffect(() => {
        if (activeNetwork && !networks.includes(activeNetwork)) {
            setActiveNetwork(networks[0] || '')
        }
    }, [networks, activeNetwork])

    useEffect(() => {
        setPageLoading(false)
        try { sessionStorage.setItem('shop_sticky_slug', shop.shop_slug) } catch (_) { }
    }, [shop.shop_slug])

    // Sticky header scroll listener
    useEffect(() => {
        const handleScroll = () => {
            const heroHeight = heroRef.current?.offsetHeight || 200
            setScrolled(window.scrollY > heroHeight - 60)
        }
        window.addEventListener('scroll', handleScroll, { passive: true })
        return () => window.removeEventListener('scroll', handleScroll)
    }, [])

    useEffect(() => {
        if (isGlobalRcEnabled) {
            fetch(`/api/shop/rc/types?shopSlug=${shop.shop_slug}`)
                .then(r => r.json())
                .then(data => { if (data.types) setRcTypes(data.types) })
                .catch(() => {})
        }
    }, [shop.shop_slug, isGlobalRcEnabled])

    useEffect(() => {
        if (isGlobalAfaEnabled) {
            fetch(`/api/shop/afa/config?shopSlug=${shop.shop_slug}`)
                .then(r => r.json())
                .then(data => { if (data.enabled && data.selling_price > 0) setAfaConfig(data) })
                .catch(() => {})
        }
    }, [shop.shop_slug, isGlobalAfaEnabled])

    useEffect(() => {
        if (!announcement) return

        const seenKey = `announcement_seen_${shop.id}`
        if (!sessionStorage.getItem(seenKey)) {
            setShowAnnouncementModal(true)
            setAnnouncementDismissed(true)
            sessionStorage.setItem(seenKey, 'true')
        }
    }, [announcement, shop.id])

    useEffect(() => {
        const error = searchParams.get('error')
        if (error) {
            const messages: Record<string, string> = {
                payment_failed: 'Payment was not completed. Please try again.',
                order_not_found: 'Order not found. Please try again.',
                server_error: 'Something went wrong. Please try again.',
                invalid_ref: 'Invalid payment reference.',
            }
            setErrorMsg(messages[error] || 'An error occurred. Please try again.')
        }
    }, [searchParams])

    // RC voucher delivery state
    const [rcVouchers, setRcVouchers] = useState<{ pin: string; serial_number: string }[]>([])
    const [showRcDelivery, setShowRcDelivery] = useState(false)

    // Poll for payment status when reference is set
    useEffect(() => {
        let interval: NodeJS.Timeout
        if (pollingRef) {
            interval = setInterval(async () => {
                try {
                    const isRcOrder = pollingRef.startsWith('RC-SHOP-')
                    const isAfaOrder = pollingRef.startsWith('AFA-SHOP-')
                    const endpoint = isRcOrder
                        ? `/api/shop/rc/verify?ref=${pollingRef}&slug=${shop.shop_slug}`
                        : isAfaOrder
                            ? `/api/shop/afa/verify?ref=${pollingRef}&slug=${shop.shop_slug}`
                            : `/api/shop/verify?ref=${pollingRef}&slug=${shop.shop_slug}`
                    const res = await fetch(endpoint, { headers: { 'Accept': 'application/json' } })
                    const data = await res.json()

                    if (data.status === 'completed') {
                        clearInterval(interval)
                        setPollingRef(null)
                        setLoading(false)
                        if (isRcOrder && data.vouchers?.length > 0) {
                            // Show vouchers instantly on-screen
                            setRcVouchers(data.vouchers)
                            setShowRcDelivery(true)
                        } else {
                            toast.success('Payment completed successfully!')
                            window.location.href = `/shop/${shop.shop_slug}/success?ref=${pollingRef}`
                        }
                    } else if (data.status === 'failed') {
                        clearInterval(interval)
                        setPollingRef(null)
                        setLoading(false)
                        setErrorMsg(data.message || 'Payment failed or cancelled.')
                    }
                } catch (e) {
                    console.error('Polling error', e)
                }
            }, 3000)
        }
        return () => clearInterval(interval)
    }, [pollingRef, shop.shop_slug])

    // Auto-detect network for airtime
    useEffect(() => {
        const clean = airtimePhone.replace(/\s+/g, '')
        
        // Reset network selection and manual flag if phone is deleted or < 3 chars
        if (clean.length < 3) {
            setDetectedNetwork(null)
            setIsManualSelection(false)
            return
        }

        if (isManualSelection) return
        
        const prefix = clean.substring(0, 3)
        let detected: 'MTN' | 'Telecel' | 'AT' | null = null
        
        const prefixes = {
            MTN: ['024', '054', '055', '059', '025', '053', '098'],
            Telecel: ['020', '050'],
            AT: ['026', '027', '056', '028', '058', '057'] // Includes 057 and 028 from main site
        }

        for (const [net, prfxs] of Object.entries(prefixes)) {
            if (prfxs.includes(prefix)) {
                detected = net as 'MTN' | 'Telecel' | 'AT'
                break
            }
        }
        
        if (detected && airtimeNetworks.some(n => n.id === detected)) {
            setDetectedNetwork(detected)
        } else {
            setDetectedNetwork(null)
        }
    }, [airtimePhone, airtimeNetworks, isManualSelection])

    // Generate Network Soft Warning
    const airtimeNetworkWarning = useMemo(() => {
        const clean = airtimePhone.replace(/\s+/g, '')
        if (clean.length < 3) return null

        const prefix = clean.substring(0, 3)
        const prefixes = {
            MTN: ['024', '054', '055', '059', '025', '053', '098'],
            Telecel: ['020', '050'],
            AT: ['026', '027', '056', '028', '058', '057']
        }
        
        let actualNet = null
        for (const [net, prfxs] of Object.entries(prefixes)) {
            if (prfxs.includes(prefix)) {
                actualNet = net
                break
            }
        }

        if (!actualNet) return 'Unrecognized prefix — please confirm your network.'
        if (detectedNetwork && actualNet !== detectedNetwork) {
            return `This number looks like it belongs to ${actualNet}. Please verify before proceeding.`
        }
        return null
    }, [airtimePhone, detectedNetwork])

    const calculateAirtimeFees = () => {
        if (!detectedNetwork || !airtimeAmount) return { feeAmount: 0, totalPay: 0, airtimeToReceive: 0 }
        const numAmount = parseFloat(airtimeAmount)
        if (isNaN(numAmount) || numAmount <= 0) return { feeAmount: 0, totalPay: 0, airtimeToReceive: 0 }

        const shopFeeConfig = airtimeNetworks.find(n => n.id === detectedNetwork)
        const shopFeeMultiplier = shopFeeConfig ? shopFeeConfig.fee : 0
        const adminFeeMultiplier = parseFloat(adminSettings[`airtime_fee_${detectedNetwork.toLowerCase()}_${shop.ownerRole}`] || '0')
        
        const totalMultiplier = (adminFeeMultiplier + shopFeeMultiplier) / 100
        const round2 = (n: number) => Math.round(n * 100) / 100

        if (useExact) {
            const feeAmount = round2(numAmount * totalMultiplier)
            return { feeAmount, totalPay: round2(numAmount + feeAmount), airtimeToReceive: numAmount }
        } else {
            const feeAmount = round2(numAmount * totalMultiplier)
            return { feeAmount, totalPay: numAmount, airtimeToReceive: round2(numAmount - feeAmount) }
        }
    }

    // The number that actually gets charged
    const effectivePayPhone = payPhone.replace(/\s+/g, '')

    // Follow the paying number until the customer picks a network themselves
    useEffect(() => {
        if (payNetworkManual) return
        setPayNetwork(detectPayNetwork(effectivePayPhone))
    }, [effectivePayPhone, payNetworkManual])

    const closeDataCheckout = () => {
        setSelectedPackage(null)
        setErrorMsg(null)
    }

    // The middleware's 429 body says nothing about how long to wait, and the limit is
    // per IP — on mobile data a buyer can trip it without having done anything wrong.
    // Give them a time to come back to instead of a dead end.
    const rateLimitMessage = (res: Response): string | null => {
        if (res.status !== 429) return null
        const retryAfter = parseInt(res.headers.get('Retry-After') || '', 10)
        return retryAfter > 0
            ? `Too many payment attempts right now. Please try again in ${retryAfter} second${retryAfter === 1 ? '' : 's'}.`
            : 'Too many payment attempts right now. Please wait a moment and try again.'
    }

    const handleBuyData = async (opts?: { acknowledgeRegistration?: boolean }) => {
        if (!selectedPackage) { toast.error('Select a package first'); return }
        if (!phone.trim()) { toast.error('Enter the beneficiary number'); return }

        const cleanPhone = phone.replace(/\s+/g, '')
        if (!/^(0\d{9}|233\d{9})$/.test(cleanPhone)) {
            toast.error('Invalid beneficiary number. Use format: 0XXXXXXXXX')
            return
        }

        const cleanPayPhone = effectivePayPhone
        if (!cleanPayPhone) { toast.error('Enter the Mobile Money number to charge'); return }
        if (!/^(0\d{9}|233\d{9})$/.test(cleanPayPhone)) {
            toast.error('Invalid Mobile Money number. Use format: 0XXXXXXXXX')
            return
        }
        if (!payNetwork) { toast.error('Select the Mobile Money network to pay from'); return }

        setLoading(true)
        try {
            const res = await fetch('/api/shop/initialize', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    shopSlug: shop.shop_slug,
                    packageId: selectedPackage.id,
                    guestPhone: cleanPhone,
                    payerPhone: cleanPayPhone,
                    payerNetwork: payNetwork,
                    guestEmail: email.trim() || undefined,
                    provider: webPaymentProvider,
                    ...(opts?.acknowledgeRegistration ? { acknowledgeRegistration: true } : {}),
                }),
            })
            const data = await res.json()

            // The beneficiary's MTN number isn't registered. Caught before the payment
            // prompt was sent, so the guest has not been charged anything.
            if (res.status === 409 && data?.code === 'MTN_NOT_REGISTERED') {
                setLoading(false)
                setRegistrationPrompt({
                    numbers: data?.registration?.phoneNumbers
                        || (data?.registration?.phoneNumber ? [data.registration.phoneNumber] : []),
                })
                return
            }

            if (!res.ok || !data.reference) {
                setErrorMsg(rateLimitMessage(res) || data.error || 'Failed to initialize payment')
                if (data.contact) setContactInfo(data.contact)
                setLoading(false)
                return
            }

            if (data.gateway === 'paystack') {
                window.location.href = data.authorization_url
                return
            }

            if (data.gateway === 'hubtel') {
                toast.success(data.message || 'Payment prompt sent! Please approve on your phone.')
                setPollingRef(data.reference)
                setLoading(false)
                return
            }

            // Moolre: show OTP modal
            try { localStorage.setItem('shop_last_phone', cleanPhone) } catch (_) { }
            setOtpReference(data.reference)
            setOtpOrderType('data')
            setOtpRequired(true)
            setLoading(false)
        } catch (err) {
            toast.error('Network error. Please try again.')
            setLoading(false)
        }
    }

    const handleBuyAirtime = async () => {
        if (!detectedNetwork) { toast.error('Enter a valid registered network number'); return }
        if (!airtimeAmount) { toast.error('Enter airtime amount'); return }
        
        const numAmount = parseFloat(airtimeAmount)
        const minAmount = parseFloat(adminSettings['airtime_min_amount'] || '1')
        const maxAmount = parseFloat(adminSettings['airtime_max_amount'] || '500')

        if (numAmount < minAmount) { toast.error(`Minimum airtime purchase is GHS ${minAmount.toFixed(2)}`); return }
        if (numAmount > maxAmount) { toast.error(`Maximum airtime purchase is GHS ${maxAmount.toFixed(2)}`); return }

        const cleanPhone = airtimePhone.replace(/\s+/g, '')
        
        setLoading(true)
        try {
            const res = await fetch('/api/shop/initialize', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    shopSlug: shop.shop_slug,
                    orderType: 'airtime',
                    network: detectedNetwork,
                    amount: numAmount,
                    useExactAmount: useExact,
                    guestPhone: cleanPhone,
                    guestEmail: airtimeEmail.trim() || undefined,
                    provider: webPaymentProvider,
                }),
            })
            const data = await res.json()

            if (!res.ok || !data.reference) {
                setErrorMsg(rateLimitMessage(res) || data.error || 'Failed to initialize airtime payment')
                if (data.contact) setContactInfo(data.contact)
                setLoading(false)
                return
            }

            if (data.gateway === 'paystack') {
                window.location.href = data.authorization_url
                return
            }

            if (data.gateway === 'hubtel') {
                toast.success(data.message || 'Payment prompt sent! Please approve on your phone.')
                setPollingRef(data.reference)
                setLoading(false)
                return
            }

            // Moolre: show OTP modal
            try { localStorage.setItem('shop_last_phone', cleanPhone) } catch (_) { }
            setOtpReference(data.reference)
            setOtpOrderType('airtime')
            setOtpRequired(true)
            setLoading(false)
        } catch (err) {
            toast.error('Network error. Please try again.')
            setLoading(false)
        }
    }

    // ─── MTN Mashup Bundle Estimator ──────────────────────────────────────────
    const MASHUP_SKEW = {
        balanced: { data: 1.00, voice: 1.00 },
        data:     { data: 1.25, voice: 0.60 },
        voice:    { data: 0.60, voice: 1.40 },
    }
    const MASHUP_TIERS = [
        { amount: 1,  dataMB: 10,  voiceMin: 9  },
        { amount: 2,  dataMB: 20,  voiceMin: 18 },
        { amount: 5,  dataMB: 75,  voiceMin: 72 },
    ]
    type BundleEst = { mode: 'exact'; dataMB: number; voiceMin: number } | { mode: 'estimate'; dataLowMB: number; dataHighMB: number; voiceLowMin: number; voiceHighMin: number }
    const estimateMashupBundle = (amount: number, pref: 'balanced' | 'data' | 'voice'): BundleEst => {
        const skew = MASHUP_SKEW[pref]
        if (amount >= 10) {
            return { mode: 'exact', dataMB: Math.round(amount * 18 * skew.data), voiceMin: Math.round(amount * 17.3 * skew.voice) }
        }
        const lower = [...MASHUP_TIERS].reverse().find(t => t.amount <= amount) || MASHUP_TIERS[0]
        const upper = MASHUP_TIERS.find(t => t.amount >= amount) || MASHUP_TIERS[MASHUP_TIERS.length - 1]
        return { mode: 'estimate', dataLowMB: lower.dataMB, dataHighMB: upper.dataMB, voiceLowMin: lower.voiceMin, voiceHighMin: upper.voiceMin }
    }

    const calculateMashupFees = () => {
        const numAmount = parseFloat(mashupAmount)
        if (isNaN(numAmount) || numAmount <= 0) return { feeAmount: 0, totalPay: 0, bundleValue: 0 }
        const mtnNetConfig = airtimeNetworks.find(n => n.id === 'MTN')
        const shopFeeMultiplier = mtnNetConfig ? mtnNetConfig.fee : 0
        const adminFeeMultiplier = parseFloat(adminSettings[`airtime_fee_mtn_${shop.ownerRole}`] || '0')
        const totalMultiplier = (adminFeeMultiplier + shopFeeMultiplier) / 100
        const round2 = (n: number) => Math.round(n * 100) / 100
        if (mashupUseExact) {
            const feeAmount = round2(numAmount * totalMultiplier)
            return { feeAmount, totalPay: round2(numAmount + feeAmount), bundleValue: numAmount }
        } else {
            const feeAmount = round2(numAmount * totalMultiplier)
            return { feeAmount, totalPay: numAmount, bundleValue: round2(numAmount - feeAmount) }
        }
    }

    const handleBuyMashup = async () => {
        const numAmount = parseFloat(mashupAmount)
        const cleanPhone = mashupPhone.replace(/\s+/g, '')
        if (!mashupPhone.trim() || !/^(0\d{9}|233\d{9})$/.test(cleanPhone)) {
            toast.error('Enter a valid 10-digit phone number')
            return
        }
        if (isNaN(numAmount) || numAmount <= 0) {
            toast.error('Enter a valid amount')
            return
        }
        setLoading(true)
        try {
            const res = await fetch('/api/shop/initialize', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    shopSlug: shop.shop_slug,
                    orderType: 'airtime',
                    network: 'MTN',
                    amount: numAmount,
                    useExactAmount: mashupUseExact,
                    isMashup: true,
                    bundlePreference,
                    guestPhone: cleanPhone,
                    guestEmail: mashupEmail.trim() || undefined,
                    provider: webPaymentProvider,
                }),
            })
            const data = await res.json()
            if (!res.ok || !data.reference) {
                setErrorMsg(rateLimitMessage(res) || data.error || 'Failed to initialize mashup payment')
                if (data.contact) setContactInfo(data.contact)
                setLoading(false)
                return
            }
            if (data.gateway === 'hubtel') {
                toast.success(data.message || 'Payment prompt sent! Please approve on your phone.')
                setPollingRef(data.reference)
                setLoading(false)
                return
            }

            try { localStorage.setItem('shop_last_phone', cleanPhone) } catch (_) { }
            setOtpReference(data.reference)
            setOtpOrderType('mashup')
            setOtpRequired(true)
            setLoading(false)
        } catch (err) {
            toast.error('Network error. Please try again.')
            setLoading(false)
        }
    }

    const handleBuyRc = async () => {
        if (!selectedRc) { toast.error('Select a voucher type'); return }
        const cleanPhone = rcPhone.replace(/\s+/g, '')
        if (!/^(0\d{9}|233\d{9})$/.test(cleanPhone)) { toast.error('Enter valid phone'); return }
        
        setLoading(true)
        try {
            const res = await fetch('/api/shop/rc/initialize', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    shopSlug: shop.shop_slug,
                    rcTypeId: selectedRc.id,
                    quantity: rcQuantity,
                    customerPhone: cleanPhone,
                    customerEmail: rcEmail.trim() || undefined,
                    provider: webPaymentProvider,
                })
            })
            const data = await res.json()
            if (!res.ok || !data.success) {
                setErrorMsg(rateLimitMessage(res) || data.error || 'Failed to initialize payment')
                setLoading(false)
                return
            }

            if (data.gateway === 'paystack') {
                window.location.href = data.authorization_url
                return
            }

            if (data.gateway === 'hubtel') {
                toast.success(data.message || 'Payment prompt sent! Please approve on your phone.')
                setPollingRef(data.reference)
                setLoading(false)
                return
            }

            try { localStorage.setItem('shop_last_phone', cleanPhone) } catch (_) { }
            if (data.otpRequired) {
                // AT network requires OTP — show OTP modal
                setOtpReference(data.reference)
                setOtpOrderType('results_checker')
                setOtpRequired(true)
                setLoading(false)
            } else {
                // MTN/Telecel: MoMo prompt sent — start polling
                toast.success(data.message || 'Payment prompt sent! Please approve on your phone.')
                setPollingRef(data.reference)
            }
        } catch (err) {
            toast.error('Network error. Please try again.')
            setLoading(false)
        }
    }

    /** Client-side gate before paying — the server re-validates all of this. */
    const afaValidationError = (): string | null => {
        if (!afaConfig?.selling_price) return 'AFA registration is not available right now'
        for (const field of AFA_REQUIRED_FIELDS) {
            if (!String((afaForm as any)[field] || '').trim()) {
                return 'Please fill in all required fields'
            }
        }
        if (!/^(0\d{9}|233\d{9})$/.test(afaForm.phone.replace(/\s+/g, ''))) {
            return 'Enter a valid phone number (0XXXXXXXXX)'
        }
        const idErr = validateId(afaForm.id_type, afaForm.id_number)
        if (idErr) return idErr
        const age = ageFromDob(afaForm.date_of_birth)
        if (age === null) return 'Enter a valid date of birth'
        if (age < MIN_AFA_AGE) return `Applicant must be at least ${MIN_AFA_AGE} years old`
        return null
    }

    const handleBuyAfa = async () => {
        const validationError = afaValidationError()
        if (validationError) { toast.error(validationError); return }

        const cleanPhone = afaForm.phone.replace(/\s+/g, '')

        setLoading(true)
        try {
            const res = await fetch('/api/shop/afa/initialize', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    shopSlug: shop.shop_slug,
                    formData: { ...afaForm, phone: cleanPhone },
                    customerEmail: afaEmail.trim() || undefined,
                    provider: webPaymentProvider,
                })
            })
            const data = await res.json()
            if (!res.ok || !data.success) {
                setErrorMsg(rateLimitMessage(res) || data.error || 'Failed to initialize payment')
                setLoading(false)
                return
            }

            if (data.gateway === 'paystack') {
                window.location.href = data.authorization_url
                return
            }

            if (data.gateway === 'hubtel') {
                toast.success(data.message || 'Payment prompt sent! Please approve on your phone.')
                setPollingRef(data.reference)
                setLoading(false)
                return
            }

            try { localStorage.setItem('shop_last_phone', cleanPhone) } catch (_) { }
            if (data.otpRequired) {
                setOtpReference(data.reference)
                setOtpOrderType('afa')
                setOtpRequired(true)
                setLoading(false)
            } else {
                toast.success(data.message || 'Payment prompt sent! Please approve on your phone.')
                setPollingRef(data.reference)
            }
        } catch (err) {
            toast.error('Network error. Please try again.')
            setLoading(false)
        }
    }

    const handleVerifyOtp = async () => {
        if (!otpCode || otpCode.trim().length < 1) {
            toast.error('Please enter the OTP sent to your phone')
            return
        }

        setLoading(true)
        try {
            const body = (otpOrderType === 'airtime' || otpOrderType === 'mashup') ? {
                shopSlug: shop.shop_slug,
                orderType: 'airtime',
                network: otpOrderType === 'mashup' ? 'MTN' : detectedNetwork,
                amount: parseFloat(otpOrderType === 'mashup' ? mashupAmount : airtimeAmount),
                useExactAmount: otpOrderType === 'mashup' ? mashupUseExact : useExact,
                isMashup: otpOrderType === 'mashup',
                bundlePreference: otpOrderType === 'mashup' ? bundlePreference : undefined,
                guestPhone: (otpOrderType === 'mashup' ? mashupPhone : airtimePhone).replace(/\s+/g, ''),
                guestEmail: (otpOrderType === 'mashup' ? mashupEmail : airtimeEmail).trim() || undefined,
                otpCode: otpCode.trim(),
                reference: otpReference,
                provider: webPaymentProvider
            } : otpOrderType === 'results_checker' ? {
                shopSlug: shop.shop_slug,
                rcTypeId: selectedRc?.id,
                quantity: rcQuantity,
                customerPhone: rcPhone.replace(/\s+/g, ''),
                customerEmail: rcEmail.trim() || undefined,
                otpCode: otpCode.trim(),
                reference: otpReference,
                provider: webPaymentProvider
            } : otpOrderType === 'afa' ? {
                shopSlug: shop.shop_slug,
                formData: { ...afaForm, phone: afaForm.phone.replace(/\s+/g, '') },
                customerEmail: afaEmail.trim() || undefined,
                otpCode: otpCode.trim(),
                reference: otpReference,
                provider: webPaymentProvider
            } : {
                shopSlug: shop.shop_slug,
                packageId: selectedPackage?.id,
                guestPhone: phone.replace(/\s+/g, ''),
                payerPhone: effectivePayPhone,
                payerNetwork: payNetwork,
                guestEmail: email.trim() || undefined,
                otpCode: otpCode.trim(),
                reference: otpReference,
                provider: webPaymentProvider
            }

            const endpoint = otpOrderType === 'results_checker'
                ? '/api/shop/rc/initialize'
                : otpOrderType === 'afa'
                    ? '/api/shop/afa/initialize'
                    : '/api/shop/initialize'
            const res = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            })
            const data = await res.json()

            if (!res.ok) {
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
            setLoading(false)
            // Keep modal open so user can retry
        }
    }

    // Scroll to airtime when opened
    useEffect(() => {
        if (isAirtimeOpen && airtimeRef.current) {
            setTimeout(() => {
                airtimeRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
            }, 100)
        }
    }, [isAirtimeOpen])

    // Contrast utility
    const isLightColor = (hex: string) => {
        const r = parseInt(hex.slice(1, 3), 16)
        const g = parseInt(hex.slice(3, 5), 16)
        const b = parseInt(hex.slice(5, 7), 16)
        const yiq = ((r * 299) + (g * 587) + (b * 114)) / 1000
        return yiq >= 128
    }

    const brandColor = shop.brand_color || '#2563eb'
    const isValidHex = (color: string) => /^#([A-Fa-f0-9]{3}){1,4}$/.test(color)
    const safeBrandColor = isValidHex(brandColor) ? brandColor : '#2563eb'
    
    const brandContrastText = isLightColor(safeBrandColor) ? '#030712' : '#ffffff'
    const filteredPackages = packages.filter(p => p.network === (activeTab === 'mashup' ? 'Special MTN Mashup' : activeNetwork))
    const { feeAmount: airFee, totalPay: airTotal, airtimeToReceive } = calculateAirtimeFees()

    if (pageLoading) {
        return (
            <div className="min-h-screen flex items-center justify-center bg-[var(--brand-color)] theme-shop">
                <style dangerouslySetInnerHTML={{ __html: `.theme-shop { --brand-color: ${safeBrandColor}; }` }} />
                <div className="flex flex-col items-center gap-4">
                    {shop.logo_url ? (
                        <div className="relative w-16 h-16 rounded-2xl overflow-hidden bg-white/20">
                            <Image src={shop.logo_url} alt={shop.shop_name} fill className="object-contain" />
                        </div>
                    ) : (
                        <div className="w-16 h-16 rounded-2xl bg-white/20 flex items-center justify-center">
                            <ShoppingCart className="w-8 h-8 text-white" />
                        </div>
                    )}
                    <div className="flex gap-1.5">
                        {[0, 1, 2].map(i => (
                            <div key={i} className={cn("w-2 h-2 rounded-full bg-white animate-bounce", ['[animation-delay:0s]', '[animation-delay:0.15s]', '[animation-delay:0.3s]'][i])} />
                        ))}
                    </div>
                </div>
            </div>
        )
    }

    return (
        <div className="min-h-screen text-gray-900 dark:text-white theme-shop">
            <style dangerouslySetInnerHTML={{ __html: `.theme-shop { --brand-color: ${safeBrandColor}; }` }} />
            
            {/* Header / Nav */}
            <header className="sticky top-0 z-50 flex items-center justify-between p-3.5 bg-[#06080f] text-white shadow-md">
                <div className="flex items-center gap-3">
                    <button
                        aria-label="Open Menu"
                        onClick={() => setIsSidebarOpen(true)}
                        className="bg-[#FFB800] text-black p-1.5 rounded-lg hover:bg-yellow-500 transition-colors"
                    >
                        <Menu className="w-5 h-5" />
                    </button>
                    <span className="font-extrabold text-[15px] tracking-wide uppercase">{shop.shop_name}</span>
                </div>
                <div className="flex items-center gap-3">
                    <ThemeToggle />
                </div>
            </header>

            {/* Sidebar Overlay */}
            {isSidebarOpen && (
                <div
                    className="fixed inset-0 z-[60] bg-black/60 backdrop-blur-sm"
                    onClick={() => setIsSidebarOpen(false)}
                />
            )}

            {/* Sidebar Drawer */}
            <div className={cn(
                "fixed top-0 left-0 h-full w-72 z-[70] bg-[#06080f] text-white flex flex-col shadow-2xl transition-transform duration-300 ease-in-out",
                isSidebarOpen ? "translate-x-0" : "-translate-x-full"
            )}>
                {/* Sidebar Header */}
                <div className="flex items-center justify-between p-4 border-b border-white/10">
                    <span className="font-extrabold text-sm tracking-widest uppercase text-white/80">{shop.shop_name}</span>
                    <button
                        aria-label="Close Menu"
                        onClick={() => setIsSidebarOpen(false)}
                        className="w-8 h-8 rounded-lg bg-white/10 flex items-center justify-center hover:bg-white/20 transition-colors"
                    >
                        <X className="w-4 h-4" />
                    </button>
                </div>

                {/* Shop Logo */}
                <div className="flex flex-col items-center gap-2 py-6 border-b border-white/10">
                    {shop.logo_url ? (
                        <div className="w-20 h-20 rounded-2xl overflow-hidden border-2 border-white/20">
                            <Image src={shop.logo_url} alt={shop.shop_name} width={80} height={80} className="object-cover w-full h-full" />
                        </div>
                    ) : (
                        <div className="w-20 h-20 rounded-2xl bg-[var(--brand-color)] flex items-center justify-center text-2xl font-black">
                            {shop.shop_name[0]}
                        </div>
                    )}
                    <p className="text-sm font-bold text-white/90">{shop.shop_name}</p>
                    {shop.description && <p className="text-xs text-white/50 text-center px-4 leading-relaxed">{shop.description}</p>}
                </div>

                {/* Nav Links */}
                <nav className="flex-1 flex flex-col gap-1 p-4 overflow-y-auto">
                    <a
                        href={`/shop/${shop.shop_slug}/about`}
                        className="flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-bold text-white/80 hover:bg-white/10 hover:text-white transition-colors"
                    >
                        <Info className="w-4 h-4" /> About Shop
                    </a>
                    {isMarketplaceAdEnabled && (
                        <a
                            href={marketplaceUrl}
                            target="_blank" rel="noopener noreferrer"
                            className="flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-bold text-white/80 hover:bg-white/10 hover:text-white transition-colors"
                        >
                            <Store className="w-4 h-4 text-[#FFB800]" /> Buy &amp; Sell Marketplace
                        </a>
                    )}
                    {shop.whatsapp_number && (
                        <a
                            href={`https://wa.me/${shop.whatsapp_number}?text=Hello, I need help with ${shop.shop_name}`}
                            target="_blank" rel="noopener noreferrer"
                            className="flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-bold text-white/80 hover:bg-white/10 hover:text-white transition-colors"
                        >
                            <MessageCircle className="w-4 h-4 text-[#25D366]" /> WhatsApp Support
                        </a>
                    )}
                    {shop.community_link && (
                        <a
                            href={shop.community_link}
                            target="_blank" rel="noopener noreferrer"
                            className="flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-bold text-white/80 hover:bg-white/10 hover:text-white transition-colors"
                        >
                            <Users className="w-4 h-4 text-emerald-400" /> Join Community
                        </a>
                    )}
                    {(shop.owner_phone || shop.whatsapp_number) && (
                        <a
                            href={`tel:${shop.owner_phone || shop.whatsapp_number}`}
                            className="flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-bold text-white/80 hover:bg-white/10 hover:text-white transition-colors"
                        >
                            <Phone className="w-4 h-4 text-blue-400" /> {shop.owner_phone || shop.whatsapp_number}
                        </a>
                    )}
                </nav>

                {/* Install Button */}
                {(isInstallable || isIOS) && !isInstalled && (
                    <div className="p-4 border-t border-white/10">
                        <button
                            onClick={handleInstallShop}
                            className="w-full flex items-center justify-center gap-2 bg-[#FFB800] text-black font-black text-sm py-3 rounded-xl hover:bg-yellow-400 transition-colors"
                        >
                            Install App
                        </button>
                    </div>
                )}
            </div>

            {/* Hero Section */}
            <div ref={heroRef} className="relative pt-6 pb-20 overflow-hidden bg-[var(--brand-color)]">
                {shop.banner_url && (
                    <div className="absolute inset-0 opacity-20">
                        <Image src={shop.banner_url} alt="Shop Banner" fill className="object-cover" />
                        <div className="absolute inset-0 bg-gradient-to-b from-[#06080f]/50 via-transparent to-[#0a0f1c]/50" />
                    </div>
                )}
                
                {/* Top Navigation inside Hero (Notification Bell) */}
                <div className="relative z-20 flex items-center justify-end px-6 max-w-2xl mx-auto mb-2">
                    <button 
                        aria-label="View announcements"
                        onClick={() => { setShowAnnouncementModal(true); setAnnouncementDismissed(true); }}
                        className="relative w-8 h-8 rounded-full bg-black/30 hover:bg-black/50 backdrop-blur-sm border border-white/10 flex items-center justify-center text-white shadow-lg transition-colors"
                    >
                        <Bell className="w-4 h-4" />
                        {!announcementDismissed && announcement && (
                            <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-red-500 border-[1.5px] border-[#0a0f1c]" />
                        )}
                    </button>
                </div>

                <div className="relative z-10 max-w-2xl mx-auto px-6 text-center mt-0">
                    {shop.logo_url ? (
                        <div className="relative w-20 h-20 mx-auto rounded-[1.2rem] overflow-hidden bg-black/20 shadow-2xl mb-3 border border-white/10 backdrop-blur-sm">
                            <Image src={shop.logo_url} alt="Logo" fill className="object-contain" />
                        </div>
                    ) : (
                        <div className="w-20 h-20 mx-auto rounded-[1.2rem] bg-black/20 flex items-center justify-center shadow-2xl mb-3 border border-white/10 backdrop-blur-sm">
                            <ShoppingCart className="w-8 h-8 text-white" />
                        </div>
                    )}
                    <h1 className="text-2xl sm:text-3xl font-black text-white drop-shadow-md mb-1.5 tracking-tight uppercase">{shop.shop_name}</h1>
                    <p className="text-white/90 text-[11px] sm:text-[13px] font-medium max-w-md mx-auto leading-tight">{shop.description}</p>
                </div>
                <DividerSVG style={shop.divider_style} fillClass="fill-gray-50 dark:fill-[#0a0f1c]" />
            </div>

            <div className="max-w-2xl mx-auto px-6 pb-40 -mt-6 relative z-20">
                {/* Marketplace Ad */}
                {isMarketplaceAdEnabled && (
                    <a
                        href={marketplaceUrl}
                        target="_blank" rel="noopener noreferrer"
                        className="group relative flex items-center gap-4 mb-6 w-full rounded-2xl border border-amber-300/40 dark:border-amber-500/20 bg-gradient-to-r from-amber-500 via-orange-500 to-rose-500 p-4 shadow-sm overflow-hidden transition-transform hover:scale-[1.01] active:scale-[0.99]"
                    >
                        <div className="absolute -right-6 -top-6 w-24 h-24 rounded-full bg-white/10 blur-xl" aria-hidden="true" />
                        <div className="shrink-0 w-12 h-12 rounded-xl bg-white/20 backdrop-blur-sm flex items-center justify-center border border-white/20">
                            <Store className="w-6 h-6 text-white" />
                        </div>
                        <div className="flex-1 min-w-0 text-left">
                            <p className="text-[10px] font-black uppercase tracking-widest text-white/80">Marketplace</p>
                            <p className="text-sm sm:text-base font-black text-white leading-tight">Visit our Marketplace to Buy &amp; Sell</p>
                            <p className="text-[11px] text-white/85 leading-tight mt-0.5">Phones, fashion, electronics &amp; more</p>
                        </div>
                        <div className="shrink-0 flex items-center gap-1 rounded-full bg-white/95 text-gray-900 text-xs font-black px-3 py-2 shadow-sm">
                            Explore <ArrowRight className="w-3.5 h-3.5 transition-transform group-hover:translate-x-0.5" />
                        </div>
                    </a>
                )}

                {/* Need Help Section */}
                <div className={cn(
                    "grid gap-3 mb-8 w-full",
                    (shop.owner_phone || shop.whatsapp_number) && shop.community_link ? "grid-cols-2" : "grid-cols-1"
                )}>
                    {/* Need Help Card */}
                    {(shop.owner_phone || shop.whatsapp_number) && (
                        <div className="bg-white dark:bg-[#151c2c] rounded-2xl border border-gray-100 dark:border-gray-800 p-4 mb-0 text-center shadow-sm w-full flex flex-col justify-center items-center">
                            <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest mb-1.5">NEED HELP?</p>
                            <div className="flex items-center justify-center gap-1.5 text-sm font-bold text-gray-600 dark:text-gray-300">
                                <Phone className="w-4 h-4 text-gray-400" />
                                <a href={`tel:${shop.owner_phone || shop.whatsapp_number}`} className="hover:text-[var(--brand-color)] transition-colors">
                                    {shop.owner_phone || shop.whatsapp_number}
                                </a>
                            </div>
                        </div>
                    )}
                    
                    {/* Community Card */}
                    {shop.community_link && (
                        <a 
                            href={shop.community_link} 
                            target="_blank" 
                            rel="noopener noreferrer"
                            className="bg-white dark:bg-[#151c2c] rounded-2xl border border-gray-100 dark:border-gray-800 p-4 mb-0 text-center shadow-sm w-full flex flex-col justify-center items-center hover:border-emerald-500/50 dark:hover:border-emerald-500/50 transition-colors group"
                        >
                            <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest mb-1.5">COMMUNITY</p>
                            <div className="flex items-center justify-center gap-1.5 text-sm font-bold text-gray-600 dark:text-gray-300 group-hover:text-emerald-500 dark:group-hover:text-emerald-400 transition-colors">
                                <Users className="w-4 h-4 text-gray-400 group-hover:text-emerald-500 dark:group-hover:text-emerald-400 transition-colors" />
                                <span>Join Community</span>
                            </div>
                        </a>
                    )}
                </div>

                {/* USSD Short Code — buying without internet */}
                {isUssdCardEnabled && (
                    <div className="bg-white dark:bg-[#151c2c] rounded-2xl border border-gray-100 dark:border-gray-800 p-5 mb-8 shadow-sm w-full">
                        <div className="flex items-start gap-3">
                            <div className="shrink-0 w-9 h-9 rounded-xl border border-gray-200 dark:border-gray-700 flex items-center justify-center">
                                <Smartphone className="w-4 h-4 text-[var(--brand-color)]" />
                            </div>
                            <div className="min-w-0">
                                <p className="text-base font-black text-gray-900 dark:text-white leading-tight">No internet? Shop on USSD</p>
                                <p className="text-sm text-gray-500 dark:text-gray-400 leading-snug mt-0.5">
                                    Buy from {shop.shop_name} on any phone — no app, no data.
                                </p>
                            </div>
                        </div>

                        <ol className="mt-4 space-y-3">
                            {[
                                <>Dial <span className="font-black text-gray-900 dark:text-white">{ussdDialCode}</span> on any phone</>,
                                <>Enter short code <span className="font-black tracking-widest text-[var(--brand-color)]">{shop.ussd_code}</span></>,
                                <>Choose <span className="font-bold text-gray-900 dark:text-white">Data Bundles</span> or <span className="font-bold text-gray-900 dark:text-white">Result Checker</span></>,
                                <>Pay with <span className="font-bold text-gray-900 dark:text-white">Mobile Money</span> — instant delivery</>,
                            ].map((step, i) => (
                                <li key={i} className="flex items-center gap-3">
                                    <span className="shrink-0 w-6 h-6 rounded-full bg-[var(--brand-color)] text-white text-xs font-black flex items-center justify-center">
                                        {i + 1}
                                    </span>
                                    <span className="text-sm text-gray-700 dark:text-gray-300 leading-snug">{step}</span>
                                </li>
                            ))}
                        </ol>

                        <button
                            type="button"
                            onClick={() => {
                                navigator.clipboard.writeText(`Dial ${ussdDialCode} and enter short code ${shop.ussd_code}`)
                                setUssdCopied(true)
                                setTimeout(() => setUssdCopied(false), 2000)
                            }}
                            className="mt-4 w-full flex items-center justify-center gap-3 rounded-xl bg-gray-50 dark:bg-[#0a0f1c] border border-gray-100 dark:border-gray-800 px-4 py-3 transition-colors hover:border-[var(--brand-color)]"
                        >
                            <span className="font-black text-gray-900 dark:text-white">{ussdDialCode}</span>
                            <ArrowRight className="w-4 h-4 text-gray-400" />
                            <span className="font-black tracking-widest text-[var(--brand-color)]">{shop.ussd_code}</span>
                            {ussdCopied
                                ? <Check className="w-4 h-4 text-emerald-500" />
                                : <Copy className="w-4 h-4 text-gray-400" />}
                        </button>
                    </div>
                )}

                <div className="flex items-center justify-center mb-6">
                    <h2 className="text-xs font-black tracking-[0.2em] text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-[#0a0f1c] px-4 uppercase">CHOOSE A SERVICE</h2>
                </div>
                {/* Services Grid */}
                <div className={cn(
                    "grid gap-3 mb-8 w-full",
                    // Four services wrap to a 2x2 rather than squeezing into one row —
                    // the tiles get unreadably narrow on a phone otherwise.
                    (() => {
                        const count = [true, isShopAirtimeEnabled, isShopRcEnabled, isShopAfaEnabled].filter(Boolean).length
                        if (count >= 4) return "grid-cols-2"
                        if (count === 3) return "grid-cols-3"
                        if (count === 2) return "grid-cols-2"
                        return "grid-cols-1"
                    })()
                )}>
                    {/* DATA Button */}
                    <button 
                        onClick={() => { setActiveTab('data'); setIsAirtimeOpen(false) }}
                        className={cn(
                            "relative flex flex-col items-center justify-center gap-3 py-6 px-2 rounded-xl border-2 transition-all",
                            activeTab === 'data' 
                                ? "bg-emerald-50/50 dark:bg-emerald-950/20 border-emerald-400 text-emerald-700 dark:text-emerald-400" 
                                : "bg-white dark:bg-[#151c2c] border-gray-100 dark:border-gray-800 hover:border-gray-200 text-gray-500"
                        )}
                    >
                        <div className={cn("w-12 h-12 rounded-xl flex items-center justify-center transition-colors", activeTab === 'data' ? "bg-emerald-500 shadow-sm" : "bg-gray-100 dark:bg-gray-800")}>
                            <Zap className={cn("w-6 h-6", activeTab === 'data' ? "text-white fill-white" : "text-gray-400")} />
                        </div>
                        <span className="text-[10px] sm:text-[11px] font-black tracking-widest uppercase">DATA</span>
                    </button>

                    {/* AIRTIME Button */}
                    {isShopAirtimeEnabled && (
                        <button 
                            onClick={() => { setActiveTab('airtime'); setIsAirtimeOpen(true) }}
                            className={cn(
                                "relative flex flex-col items-center justify-center gap-3 py-6 px-2 rounded-xl border-2 transition-all",
                                activeTab === 'airtime' 
                                    ? "bg-emerald-50/50 dark:bg-emerald-950/20 border-emerald-400 text-emerald-700 dark:text-emerald-400" 
                                    : "bg-white dark:bg-[#151c2c] border-gray-100 dark:border-gray-800 hover:border-gray-200 text-gray-500"
                            )}
                        >
                            <div className={cn("w-12 h-12 rounded-xl flex items-center justify-center transition-colors", activeTab === 'airtime' ? "bg-emerald-500 shadow-sm" : "bg-gray-100 dark:bg-gray-800")}>
                                <Smartphone className={cn("w-6 h-6", activeTab === 'airtime' ? "text-white" : "text-gray-400")} />
                            </div>
                            <span className="text-[10px] sm:text-[11px] font-black tracking-widest uppercase">AIRTIME</span>
                        </button>
                    )}

                    {/* RESULTS CHECKER Button */}
                    {isShopRcEnabled && (
                        <button 
                            onClick={() => { setActiveTab('results_checker'); setIsAirtimeOpen(false) }}
                            className={cn(
                                "relative flex flex-col items-center justify-center gap-3 py-6 px-2 rounded-xl border-2 transition-all",
                                activeTab === 'results_checker' 
                                    ? "bg-emerald-50/50 dark:bg-emerald-950/20 border-emerald-400 text-emerald-700 dark:text-emerald-400" 
                                    : "bg-white dark:bg-[#151c2c] border-gray-100 dark:border-gray-800 hover:border-gray-200 text-gray-500"
                            )}
                        >
                            <div className={cn("w-12 h-12 rounded-xl flex items-center justify-center transition-colors", activeTab === 'results_checker' ? "bg-emerald-500 shadow-sm" : "bg-gray-100 dark:bg-gray-800")}>
                                <GraduationCap className={cn("w-6 h-6", activeTab === 'results_checker' ? "text-white" : "text-gray-400")} />
                            </div>
                            <span className="text-[10px] sm:text-[11px] font-black tracking-widest uppercase text-center">RESULTS CHECKER</span>
                        </button>
                    )}

                    {/* AFA REGISTRATION Button */}
                    {isShopAfaEnabled && (
                        <button
                            onClick={() => { setActiveTab('afa'); setIsAirtimeOpen(false) }}
                            className={cn(
                                "relative flex flex-col items-center justify-center gap-3 py-6 px-2 rounded-xl border-2 transition-all",
                                activeTab === 'afa'
                                    ? "bg-emerald-50/50 dark:bg-emerald-950/20 border-emerald-400 text-emerald-700 dark:text-emerald-400"
                                    : "bg-white dark:bg-[#151c2c] border-gray-100 dark:border-gray-800 hover:border-gray-200 text-gray-500"
                            )}
                        >
                            <div className={cn("w-12 h-12 rounded-xl flex items-center justify-center transition-colors", activeTab === 'afa' ? "bg-emerald-500 shadow-sm" : "bg-gray-100 dark:bg-gray-800")}>
                                <BadgeCheck className={cn("w-6 h-6", activeTab === 'afa' ? "text-white" : "text-gray-400")} />
                            </div>
                            <span className="text-[10px] sm:text-[11px] font-black tracking-widest uppercase text-center">AFA REGISTRATION</span>
                        </button>
                    )}
                </div>

                {/* Error banner */}
                {errorMsg && (
                    <div className="mb-4 p-4 rounded-xl bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 space-y-3">
                        <div className="flex items-start gap-2">
                            <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
                            <div className="flex-1">
                                <p className="text-sm font-bold text-red-800 dark:text-red-300">{errorMsg}</p>
                                {contactInfo ? (
                                    <p className="text-xs text-red-700 dark:text-red-400 mt-1">This shop is temporarily offline. Please contact the owner directly to complete your purchase:</p>
                                ) : (
                                    <p className="text-xs text-red-700 dark:text-red-400 mt-1">Please try again or contact support if the issue persists.</p>
                                )}
                            </div>
                            <button 
                                onClick={() => { setErrorMsg(null); setContactInfo(null); }} 
                                title="Dismiss error"
                                aria-label="Dismiss error"
                                className="p-1 hover:bg-red-100 dark:hover:bg-red-800/40 rounded-full transition-colors"
                            >
                                <X className="w-4 h-4 text-red-400" />
                            </button>
                        </div>

                        {contactInfo && (
                            <div className="flex flex-wrap gap-2 pt-1">
                                {contactInfo.phone && <a href={`tel:${contactInfo.phone}`} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white border border-red-100 text-xs font-bold shadow-sm"><Phone className="w-3.5 h-3.5" /> Call {contactInfo.phone}</a>}
                                {contactInfo.whatsapp && <a href={`https://wa.me/${contactInfo.whatsapp}`} target="_blank" className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#25D366] text-xs font-bold text-white shadow-sm"><MessageCircle className="w-3.5 h-3.5" /> WhatsApp</a>}
                            </div>
                        )}
                    </div>
                )}

                {/* ── Airtime Tab Content ── */}
                {isShopAirtimeEnabled && activeTab === 'airtime' && (
                    <div ref={airtimeRef} className="mb-6 bg-white dark:bg-gray-900 rounded-[2rem] border border-gray-200 dark:border-gray-800 shadow-sm overflow-hidden p-5 animate-in fade-in slide-in-from-bottom-2 duration-300">
                        <div className="flex items-center gap-3 mb-5 border-b border-gray-100 dark:border-gray-800 pb-5">
                            <div className="w-12 h-12 rounded-xl flex items-center justify-center text-white bg-indigo-600 shadow-sm">
                                <Smartphone className="w-6 h-6" />
                            </div>
                            <div className="text-left">
                                <h3 className="text-lg font-black text-gray-900 dark:text-white uppercase tracking-tighter">Buy Direct Airtime</h3>
                                <p className="text-[10px] font-bold text-gray-500 uppercase tracking-widest leading-tight">Instant Credit to Any Network</p>
                            </div>
                        </div>

                        <div className="space-y-5">
                                    {/* Network Selection Grid */}
                                    <div>
                                        <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest mb-3 ml-1">Select Network</p>
                                        <div className="grid grid-cols-3 gap-2">
                                            {['MTN', 'Telecel', 'AT'].map(netId => {
                                                const netConfig = airtimeNetworks.find(n => n.id === netId)
                                                const isEnabled = !!netConfig
                                                const isSelected = detectedNetwork === netId
                                                const colors = networkColors[netId]
                                                
                                                return (
                                                    <button
                                                        key={netId}
                                                        disabled={!isEnabled}
                                                        onClick={() => { setDetectedNetwork(netId as any); setIsManualSelection(true) }}
                                                        className={cn(
                                                            "relative flex flex-col items-center gap-2 p-3 rounded-2xl border-2 transition-all duration-300",
                                                            isSelected 
                                                                ? `bg-gradient-to-br ${colors.gradient} border-transparent shadow-lg scale-[1.03]` 
                                                                : "bg-gray-50 dark:bg-gray-800 border-gray-100 dark:border-gray-700 hover:border-gray-200",
                                                            !isEnabled && "opacity-40 grayscale cursor-not-allowed"
                                                        )}
                                                    >
                                                        <NetworkLogo id={netId} />
                                                        <span className={cn("text-[10px] font-black uppercase tracking-tight", isSelected ? "text-white" : "text-gray-500")}>
                                                            {netId}
                                                        </span>
                                                        {!isEnabled && <span className="absolute top-1 right-1 px-1 py-0.5 bg-gray-200 dark:bg-gray-700 text-[8px] font-black rounded-md">OFF</span>}
                                                    </button>
                                                )
                                            })}
                                        </div>
                                    </div>

                                    <div className="space-y-4">
                                        <div className="relative">
                                            <Phone className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                                            <input
                                                type="tel" value={airtimePhone} onChange={(e) => setAirtimePhone(e.target.value)}
                                                placeholder="Receiver Phone (e.g. 024XXXXXXX)"
                                                className="w-full pl-12 pr-12 py-4 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-base font-bold transition-all focus:outline-none focus:ring-2 focus:ring-indigo-500"
                                            />
                                            {detectedNetwork && (
                                                <div className="absolute right-3 top-1/2 -translate-y-1/2">
                                                    <div 
                                                        className={cn("px-2 py-1 tracking-widest text-[10px] uppercase font-black rounded-lg shadow-sm", networkColors[detectedNetwork].bgClass, networkColors[detectedNetwork].textClass)}
                                                    >
                                                        {detectedNetwork}
                                                    </div>
                                                </div>
                                            )}
                                        </div>

                                        {airtimeNetworkWarning && (
                                            <div className="flex gap-2 items-start bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400 p-3 rounded-lg border border-amber-200 dark:border-amber-800">
                                                <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                                                <p className="text-xs font-medium leading-relaxed">{airtimeNetworkWarning}</p>
                                            </div>
                                        )}

                                    <div className="space-y-3">
                                        <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest ml-1">Recharge Amount</p>
                                        
                                        {/* Quick Amount Chips */}
                                        <div className="flex gap-2 flex-wrap mb-1">
                                            {QUICK_AMOUNTS.map(q => (
                                                <button
                                                    key={q}
                                                    onClick={() => setAirtimeAmount(String(q))}
                                                    className={cn(
                                                        "px-4 py-2 rounded-xl text-xs font-black border-2 transition-all",
                                                        airtimeAmount === String(q)
                                                            ? "bg-gray-900 dark:bg-white text-white dark:text-gray-900 border-gray-900 dark:border-white shadow-md scale-105"
                                                            : "bg-gray-50 dark:bg-gray-800 text-gray-500 border-gray-100 dark:border-gray-700 hover:border-gray-300"
                                                    )}
                                                >
                                                    {q}
                                                </button>
                                            ))}
                                        </div>

                                        <div className="relative">
                                            <span className="absolute left-5 top-1/2 -translate-y-1/2 font-black text-gray-400 text-sm">GHS</span>
                                            <input
                                                type="number" min="1" step="0.5" value={airtimeAmount} onChange={(e) => setAirtimeAmount(e.target.value)}
                                                placeholder={`Custom Amount`}
                                                className="w-full pl-14 pr-4 py-4 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-lg font-black transition-all focus:outline-none focus:ring-2 focus:ring-indigo-500"
                                            />
                                        </div>
                                    </div>

                                    <div className="relative">
                                        <Mail className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                                        <input
                                            type="email" value={airtimeEmail} onChange={(e) => setAirtimeEmail(e.target.value)}
                                            placeholder="Email for receipt (Optional)"
                                            className="w-full pl-12 pr-4 py-4 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-sm font-bold transition-all focus:outline-none focus:ring-2 focus:ring-indigo-500"
                                        />
                                    </div>

                                    {/* Pay Separately Toggle */}
                                    <div 
                                        onClick={() => setUseExact(!useExact)}
                                        className={cn(
                                            "flex items-start gap-3 p-4 rounded-2xl border transition-all cursor-pointer group",
                                            useExact 
                                                ? "bg-emerald-50 dark:bg-emerald-900/10 border-emerald-400 shadow-sm" 
                                                : "bg-gray-50 dark:bg-gray-800/40 border-gray-100 dark:border-gray-700 hover:border-gray-200"
                                        )}
                                    >
                                        <div className={cn(
                                            "mt-0.5 w-5 h-5 rounded-md border-2 flex items-center justify-center transition-all",
                                            useExact ? "bg-emerald-500 border-emerald-500 text-white" : "border-gray-300 dark:border-gray-600 group-hover:border-gray-400"
                                        )}>
                                            {useExact && <Check className="w-3.5 h-3.5 stroke-[3px]" />}
                                        </div>
                                        <div className="flex-1">
                                            <p className={cn("text-xs font-black uppercase tracking-tight mb-0.5", useExact ? "text-emerald-700 dark:text-emerald-400" : "text-gray-700 dark:text-gray-300")}>
                                                Pay processing fee separately
                                            </p>
                                            <p className="text-[10px] font-bold text-gray-500 leading-tight">
                                                {useExact ? "You'll pay a bit more, but recipient gets exactly the amount typed." : "Standard: Fee is deducted from the amount you recharge."}
                                            </p>
                                        </div>
                                    </div>

                                    {detectedNetwork && airtimeAmount !== '' && parseFloat(airtimeAmount) > 0 && (
                                        <div className="bg-indigo-50 dark:bg-indigo-900/20 rounded-2xl p-5 border border-indigo-100 dark:border-indigo-800 shadow-inner">
                                            <div className="space-y-3">
                                                <div className="flex justify-between items-center text-xs font-bold text-gray-500 uppercase tracking-widest">
                                                    <span>Recharge Value</span>
                                                    <span className="text-gray-900 dark:text-gray-200 font-black">{formatCurrency(parseFloat(airtimeAmount))}</span>
                                                </div>
                                                
                                                <div className="flex justify-between items-center text-xs font-bold">
                                                    <span className="text-gray-500 uppercase tracking-widest flex items-center gap-1">Processing Fee ({(((airFee) / (useExact ? parseFloat(airtimeAmount) : parseFloat(airtimeAmount) - airFee)) * 100).toFixed(0)}%)</span>
                                                    <span className="text-gray-600 dark:text-gray-400">{useExact ? '+' : '–'} {formatCurrency(airFee)}</span>
                                                </div>

                                                <div className="flex justify-between items-center py-2 px-3 rounded-xl bg-indigo-100/50 dark:bg-indigo-950/50 border border-indigo-200/50 dark:border-indigo-900/50">
                                                    <span className="text-[10px] font-black text-indigo-600 dark:text-indigo-400 uppercase tracking-tighter flex items-center gap-1.5">
                                                        <Info className="w-3.5 h-3.5" /> Recipient Gets
                                                    </span>
                                                    <span className="text-sm font-black text-indigo-700 dark:text-indigo-300">{formatCurrency(airtimeToReceive)}</span>
                                                </div>

                                                <div className="pt-2 border-t border-indigo-200/30">
                                                    <div className="flex justify-between items-center">
                                                        <span className="text-sm font-black text-indigo-900 dark:text-indigo-100 uppercase tracking-tighter">You Pay Total</span>
                                                        <span className="text-2xl font-black text-indigo-600 dark:text-indigo-400">{formatCurrency(airTotal)}</span>
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                    )}

                                    <div className="space-y-2 pb-2">
                                        <Label className="text-[10px] font-black text-gray-400 uppercase tracking-widest ml-1 block">Pay via</Label>
                                        <div className="flex gap-1 p-1 rounded-xl bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 w-full">
                                            {SCOPE_PROVIDERS.web.map((id) => (
                                                <button
                                                    key={id}
                                                    type="button"
                                                    onClick={() => setWebPaymentProvider(id)}
                                                    className={cn(
                                                        'flex-1 py-1.5 px-2 rounded-lg text-xs font-bold transition-all',
                                                        webPaymentProvider === id
                                                            ? 'bg-white shadow text-gray-900'
                                                            : 'text-gray-500 hover:text-gray-700'
                                                    )}
                                                >
                                                    {PROVIDER_LABEL[id]}
                                                </button>
                                            ))}
                                        </div>
                                    </div>

                                    <button
                                        onClick={handleBuyAirtime} disabled={loading || !detectedNetwork || parseFloat(airtimeAmount || '0') <= 0}
                                        className="w-full py-4 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-black text-base uppercase tracking-widest shadow-lg flex justify-center items-center gap-3 transition-transform active:scale-95 disabled:opacity-50 disabled:active:scale-100"
                                    >
                                        {loading ? <><Loader2 className="w-5 h-5 animate-spin" /> {pollingRef ? 'Waiting for Approval...' : 'Processing...'}</> : <><Smartphone className="w-5 h-5"/> Recharge Airtime</>}
                                    </button>
                                </div>
                            </div>
                        </div>
                )}

                {/* ── MTN Mashup Tab Content ── */}
                {/* Custom Mashup Form Removed - Now using predefined packages in Data Packages tab */}

                {/* ── Results Checker Tab Content ── */}
                {isShopRcEnabled && activeTab === 'results_checker' && (
                    <div className="animate-in fade-in slide-in-from-bottom-2 duration-300 space-y-4">
                        <div className="grid grid-cols-2 gap-3 mb-6">
                            {rcTypes.map((type) => {
                                const isSelected = selectedRc?.id === type.id
                                return (
                                    <button
                                        key={type.id} 
                                        disabled={type.stock_count === 0}
                                        onClick={() => type.stock_count > 0 && setSelectedRc(isSelected ? null : type)}
                                        className={cn(
                                            'relative p-4 rounded-2xl border-2 text-left transition-all duration-200 flex flex-col gap-1.5',
                                            type.stock_count === 0 ? 'bg-gray-50 dark:bg-gray-800/50 border-gray-200 dark:border-gray-700 opacity-70 cursor-not-allowed' :
                                            isSelected ? 'bg-[var(--brand-color)] border-[var(--brand-color)] shadow-lg scale-[1.02] active:scale-95' : 'bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600 hover:shadow-md active:scale-95'
                                        )}
                                    >
                                        {isSelected && <div className="absolute top-2 right-2"><CheckCircle2 className="w-4 h-4 text-white" /></div>}
                                        
                                        <div className={cn("inline-block text-[10px] font-black px-2 py-0.5 rounded-full self-start", type.stock_count === 0 ? "bg-gray-200 text-gray-600 dark:bg-gray-700 dark:text-gray-300" : "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400")}>
                                            PIN + SERIAL
                                        </div>
                                        
                                        <p className={cn('text-base font-black leading-tight', isSelected ? 'text-white' : 'text-gray-900 dark:text-white')}>
                                            {type.name}
                                        </p>
                                        <p className={cn('text-sm font-bold', isSelected ? 'text-white/90' : 'text-gray-600 dark:text-gray-300')}>
                                            {formatCurrency(type.selling_price)}
                                        </p>
                                        
                                        {type.stock_count === 0 ? (
                                            <div className="inline-flex items-center gap-1 text-[9px] font-bold px-2 py-0.5 rounded-full mt-0.5 self-start bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400">
                                                Out of Stock
                                            </div>
                                        ) : (
                                            <div className={cn('inline-flex items-center gap-1 text-[9px] font-bold px-2 py-0.5 rounded-full mt-0.5 self-start', isSelected ? 'bg-white/20 text-white' : 'bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400')}>
                                                <Zap className="w-2.5 h-2.5" /> Instant Delivery
                                            </div>
                                        )}
                                    </button>
                                )
                            })}
                        </div>
                        
                        {selectedRc && (
                            <div className="sticky bottom-4 bg-white dark:bg-gray-900 rounded-2xl shadow-2xl border border-gray-200 dark:border-gray-700 p-4 space-y-3">
                                <div className="flex items-center justify-between">
                                    <div>
                                        <p className="text-xs text-muted-foreground">Selected</p>
                                        <p className="font-bold text-sm">{selectedRc.name}</p>
                                    </div>
                                    <div className="text-right">
                                        <p className="text-xs text-muted-foreground">Total</p>
                                        <p className="font-black text-lg text-[var(--brand-color)]">
                                            {formatCurrency(selectedRc.selling_price * rcQuantity)}
                                        </p>
                                    </div>
                                </div>

                                <div className="flex items-center justify-between bg-gray-50 dark:bg-gray-800 p-3 rounded-xl border border-gray-200 dark:border-gray-700">
                                    <p className="text-sm font-bold text-gray-700 dark:text-gray-300">Quantity</p>
                                    <div className="flex items-center gap-3">
                                        <button onClick={() => setRcQuantity(Math.max(1, rcQuantity - 1))} className="w-8 h-8 rounded-full bg-white dark:bg-gray-700 border border-gray-200 dark:border-gray-600 flex items-center justify-center font-bold shadow-sm active:scale-95 text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-600 transition-colors">-</button>
                                        <span className="font-black text-lg w-4 text-center">{rcQuantity}</span>
                                        <button onClick={() => setRcQuantity(Math.min(10, rcQuantity + 1))} className="w-8 h-8 rounded-full bg-white dark:bg-gray-700 border border-gray-200 dark:border-gray-600 flex items-center justify-center font-bold shadow-sm active:scale-95 text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-600 transition-colors">+</button>
                                    </div>
                                </div>

                                <div className="relative">
                                    <Phone className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                                    <input
                                        type="tel" value={rcPhone} onChange={(e) => setRcPhone(e.target.value)} placeholder="Recipient MoMo phone: 0244123456"
                                        className="w-full pl-9 pr-4 py-3 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-sm focus:outline-none focus:ring-2 transition-all ring-[var(--brand-color)]"
                                    />
                                </div>

                                <div className="relative">
                                    <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                                    <input
                                        type="email" value={rcEmail} onChange={(e) => setRcEmail(e.target.value)} placeholder="Email to receive PIN (Optional)"
                                        className="w-full pl-9 pr-4 py-3 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-sm focus:outline-none focus:ring-2 transition-all ring-[var(--brand-color)]"
                                    />
                                </div>

                                <div className="space-y-2 pb-2">
                                    <Label className="text-[10px] font-black text-gray-400 uppercase tracking-widest ml-1 block">Pay via</Label>
                                    <div className="flex gap-1 p-1 rounded-xl bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 w-full">
                                        {([
                                            { id: 'moolre', label: 'Moolre' },
                                            { id: 'hubtel', label: 'Hubtel' },
                                            { id: 'paystack', label: 'Paystack' },
                                        ] as const).map(({ id, label }) => (
                                            <button
                                                key={id}
                                                type="button"
                                                onClick={() => setWebPaymentProvider(id)}
                                                className={cn(
                                                    'flex-1 py-1.5 px-2 rounded-lg text-xs font-bold transition-all',
                                                    webPaymentProvider === id
                                                        ? 'bg-white shadow text-gray-900'
                                                        : 'text-gray-500 hover:text-gray-700'
                                                )}
                                            >
                                                {label}
                                            </button>
                                        ))}
                                    </div>
                                </div>

                                <button
                                    onClick={handleBuyRc} disabled={loading}
                                    className="w-full py-3.5 rounded-xl text-white font-bold text-base flex items-center justify-center gap-2 transition-all active:scale-95 disabled:opacity-70 bg-[var(--brand-color)]"
                                >
                                    {loading ? <><Loader2 className="w-5 h-5 animate-spin" /> {pollingRef ? 'Waiting for Approval...' : 'Processing...'}</> : <><ShoppingCart className="w-5 h-5" /> Pay {formatCurrency(selectedRc.selling_price * rcQuantity)}</>}
                                </button>
                                <p className="text-[10px] text-center text-muted-foreground">Direct MoMo Prompt</p>
                            </div>
                        )}
                    </div>
                )}

                {/* ── AFA Registration Tab Content ── */}
                {/* Dressed as the data checkout sheet below: a coloured banner naming what
                    is being bought and its price, black label + grey hint over full-width
                    fields, and one large action pinned above the fold. To a customer this
                    is the same purchase as a bundle, so it must not look like a different
                    app — the old micro-caps labels and squeezed fee card did. */}
                {isShopAfaEnabled && activeTab === 'afa' && (
                    <div className="animate-in fade-in slide-in-from-bottom-2 duration-300 space-y-5">
                        <div className="rounded-2xl px-4 py-4 flex items-center justify-between gap-3 bg-[var(--brand-color)] text-white">
                            <div className="flex items-center gap-3 min-w-0">
                                <div className="w-10 h-10 rounded-full bg-white/20 flex items-center justify-center shrink-0">
                                    <BadgeCheck className="w-6 h-6" />
                                </div>
                                <p className="text-lg font-black tracking-tight truncate">AFA Membership</p>
                            </div>
                            <p className="text-lg font-black tracking-tight shrink-0">{formatCurrency(afaConfig!.selling_price)}</p>
                        </div>

                        <p className="text-[13px] font-semibold text-gray-500 dark:text-gray-400 leading-snug">
                            Enter the applicant&apos;s details exactly as they appear on their ID.
                            Registration is processed manually — you will be contacted once it is complete.
                        </p>

                        <div className="space-y-5">
                            <div className="space-y-2">
                                <Label className={SHEET_LABEL_CLASS}>
                                    Full name <span className="font-semibold text-gray-400">(as shown on the ID)</span>
                                </Label>
                                <input
                                    value={afaForm.full_name}
                                    onChange={(e) => setAfaForm(prev => ({ ...prev, full_name: e.target.value }))}
                                    placeholder="Kwame Mensah"
                                    className={SHEET_FIELD_CLASS}
                                />
                            </div>

                            <div className="space-y-2">
                                <Label className={SHEET_LABEL_CLASS}>
                                    Phone number <span className="font-semibold text-gray-400">(gets the payment prompt)</span>
                                </Label>
                                <input
                                    type="tel" inputMode="tel"
                                    value={afaForm.phone}
                                    onChange={(e) => setAfaForm(prev => ({ ...prev, phone: e.target.value }))}
                                    placeholder="0244123456"
                                    className={SHEET_FIELD_CLASS}
                                />
                            </div>

                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                <div className="space-y-2">
                                    <Label className={SHEET_LABEL_CLASS}>ID type</Label>
                                    <select
                                        value={afaForm.id_type}
                                        onChange={(e) => {
                                            // Re-mask under the new type so a part-typed number is not left
                                            // in the previous type's format.
                                            const nextType = e.target.value
                                            const remasked = maskIdNumber(nextType, afaForm.id_number)
                                            setAfaForm(prev => ({ ...prev, id_type: nextType, id_number: remasked }))
                                            setAfaIdError(remasked ? validateId(nextType, remasked) : null)
                                        }}
                                        className={SHEET_FIELD_CLASS}
                                    >
                                        {ID_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                                    </select>
                                </div>

                                <div className="space-y-2">
                                    <Label className={SHEET_LABEL_CLASS}>ID number</Label>
                                    <input
                                        value={afaForm.id_number}
                                        onChange={(e) => {
                                            const masked = maskIdNumber(afaForm.id_type, e.target.value)
                                            setAfaForm(prev => ({ ...prev, id_number: masked }))
                                            setAfaIdError(masked ? validateId(afaForm.id_type, masked) : null)
                                        }}
                                        placeholder={ID_TYPES.find(t => t.value === afaForm.id_type)?.placeholder}
                                        className={cn(SHEET_FIELD_CLASS, afaIdError && 'border-red-500')}
                                    />
                                    {afaIdError && <p className="text-xs font-bold text-red-600">{afaIdError}</p>}
                                </div>
                            </div>

                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                <div className="space-y-2">
                                    <Label className={SHEET_LABEL_CLASS}>
                                        Date of birth <span className="font-semibold text-gray-400">({MIN_AFA_AGE}+ only)</span>
                                    </Label>
                                    <input
                                        type="date"
                                        value={afaForm.date_of_birth}
                                        max={maxDobInputValue()}
                                        onChange={(e) => setAfaForm(prev => ({ ...prev, date_of_birth: e.target.value }))}
                                        className={SHEET_FIELD_CLASS}
                                    />
                                </div>

                                <div className="space-y-2">
                                    <Label className={SHEET_LABEL_CLASS}>Region</Label>
                                    <select
                                        value={afaForm.region}
                                        onChange={(e) => setAfaForm(prev => ({ ...prev, region: e.target.value }))}
                                        className={SHEET_FIELD_CLASS}
                                    >
                                        {REGIONS.map(r => <option key={r} value={r}>{r}</option>)}
                                    </select>
                                </div>
                            </div>

                            <div className="space-y-2">
                                <Label className={SHEET_LABEL_CLASS}>Town / location</Label>
                                <input
                                    value={afaForm.location}
                                    onChange={(e) => setAfaForm(prev => ({ ...prev, location: e.target.value }))}
                                    placeholder="e.g. Madina"
                                    className={SHEET_FIELD_CLASS}
                                />
                            </div>

                            <div className="space-y-2">
                                <Label className={SHEET_LABEL_CLASS}>
                                    Email <span className="font-semibold text-gray-400">(for receipt — optional)</span>
                                </Label>
                                <input
                                    type="email"
                                    value={afaEmail}
                                    onChange={(e) => setAfaEmail(e.target.value)}
                                    placeholder="you@example.com"
                                    className={SHEET_FIELD_CLASS}
                                />
                            </div>
                        </div>

                        {/* Cost + action, pinned like the sheet's action bar. Unlike a bundle
                            there is no gateway fee to disclose here — afa/initialize charges
                            the selling price and nothing more — so the line states the fee as
                            the whole of it rather than hinting at an extra that never lands. */}
                        <div className="sticky bottom-4 rounded-2xl border border-gray-100 dark:border-gray-800 bg-white/95 dark:bg-gray-900/95 backdrop-blur-sm shadow-e3 px-4 pt-3 pb-4 space-y-3">
                            <dl className="space-y-1.5">
                                <div className="flex items-center justify-between text-sm">
                                    <dt className="font-semibold text-gray-500 dark:text-gray-400">Registration fee</dt>
                                    <dd className="font-bold tabular text-gray-900 dark:text-gray-100">
                                        {formatCurrency(afaConfig!.selling_price)}
                                    </dd>
                                </div>
                            </dl>

                            <button
                                onClick={handleBuyAfa} disabled={loading}
                                className="w-full py-4 rounded-md bg-[var(--brand-color)] text-white font-black text-lg flex items-center justify-center gap-2 active:scale-[0.98] transition-transform disabled:opacity-70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-[var(--brand-color)]"
                            >
                                {loading
                                    ? <><Loader2 className="w-5 h-5 animate-spin" /> {pollingRef ? 'Waiting for approval...' : 'Processing...'}</>
                                    : <><BadgeCheck className="w-5 h-5" /> Pay {formatCurrency(afaConfig!.selling_price)}</>}
                            </button>

                            <p className="text-[12px] text-center font-semibold text-gray-400 leading-snug">
                                {webPaymentProvider === 'paystack'
                                    ? 'You will be taken to a secure checkout page.'
                                    : 'Approve the prompt on your phone to complete registration.'}
                            </p>
                        </div>
                    </div>
                )}


                {/* ── Data Packages Tab Content ── */}
                {(activeTab === 'data' || activeTab === 'mashup') && (
                    <div className="animate-in fade-in slide-in-from-bottom-2 duration-300 space-y-4">

                {/* ── Network Filter Tabs ── */}
                {activeTab === 'data' && networks.length > 1 && (
                    <div className="grid grid-cols-4 gap-2 sm:gap-3 mb-6">
                        {networks.map(net => {
                            const isActive = activeNetwork === net
                            
                            return (
                                <button
                                    key={net} onClick={() => { setActiveNetwork(net); setSelectedPackage(null); setIsAirtimeOpen(false) }}
                                    className={cn(
                                        "relative flex flex-col items-center justify-center gap-2 sm:gap-3 py-3 px-1 sm:py-4 sm:px-2 rounded-[14px] border transition-all bg-white dark:bg-zinc-900 shadow-sm",
                                        isActive
                                            ? "border-[#8a2be2] shadow-sm scale-[1.01]"
                                            : "border-gray-100 dark:border-zinc-800 hover:border-gray-200 dark:hover:border-zinc-700",
                                        isActive && "bg-white dark:bg-zinc-900 text-gray-900 dark:text-white"
                                    )}
                                >
                                    {isActive && (
                                        <div className="absolute top-1 right-1 sm:top-2 sm:right-2 z-10 bg-white rounded-full">
                                            <CheckCircle2 className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-[#20d880]" strokeWidth={2.5} />
                                        </div>
                                    )}
                                    <div className="w-8 h-8 sm:w-10 sm:h-10 rounded-full flex items-center justify-center mt-1">
                                        <NetworkLogo id={net} />
                                    </div>
                                    <span className="text-[10px] sm:text-[13px] font-bold text-gray-700 dark:text-gray-200 text-center leading-tight">
                                        {net === 'Special MTN Mashup' ? 'Special Mashup' : net === 'EXPRESS MTN' ? 'Express MTN' : net === 'AT-iShare' ? 'AT iShare' : net === 'AT-BigTime' ? 'AT BigTime' : net}
                                    </span>
                                    <div className="flex items-center justify-center gap-1 sm:gap-1.5 text-[9px] sm:text-[11px] font-bold text-[#20d880] mb-0.5 sm:mb-1">
                                        <div className="w-1.5 h-1.5 rounded-full bg-[#20d880]" /> Live
                                    </div>
                                </button>
                            )
                        })}
                    </div>
                )}

                {/* Search Bar matching screenshot */}
                {activeTab === 'data' && (
                    <div className="flex gap-3 mb-8">
                        <div className="relative flex-1">
                            <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                            <input 
                                type="text" 
                                placeholder="Search packages..." 
                                className="w-full pl-11 pr-4 py-3.5 bg-white dark:bg-[#0e1423] border border-gray-200 dark:border-gray-800/60 rounded-xl text-sm font-medium text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:border-gray-300 dark:focus:border-gray-600 shadow-sm dark:shadow-none transition-colors"
                            />
                        </div>
                        <div className="flex rounded-xl overflow-hidden border border-gray-200 dark:border-gray-800/60 bg-white dark:bg-[#0e1423] shrink-0 shadow-sm dark:shadow-none">
                            <button aria-label="Grid View" className="w-12 h-full flex items-center justify-center bg-gray-100 dark:bg-white text-gray-900"><Menu className="w-5 h-5" /></button>
                            <button aria-label="List View" className="w-12 h-full flex items-center justify-center text-gray-400 dark:text-gray-500 hover:bg-gray-50 dark:hover:bg-transparent transition-colors"><Menu className="w-5 h-5 opacity-50" /></button>
                        </div>
                    </div>
                )}

                {/* Package grid */}
                {filteredPackages.length === 0 ? (
                    <div className="text-center py-24 text-gray-400 flex flex-col items-center">
                        <div className="w-16 h-16 rounded-full bg-gray-100 dark:bg-gray-900 flex items-center justify-center mb-6">
                            <AlertCircle className="w-8 h-8 opacity-40" />
                        </div>
                        <p className="text-[15px] font-bold text-gray-600 dark:text-gray-300">{activeNetwork} is Out of Stock at the Moment</p>
                    </div>
                ) : (
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-6">
                        {filteredPackages.map((pkg) => {
                            const netStyle = networkColors[pkg.network]
                            const isSelected = selectedPackage?.id === pkg.id
                            const cardStyle = getNetworkCardStyle(pkg.network)
                            const pillText = pkg.network === 'AT-iShare' ? 'AT-IS' : pkg.network === 'AT-BigTime' ? 'AT-BT' : pkg.network === 'Special MTN Mashup' ? 'MASHUP' : pkg.network === 'EXPRESS MTN' ? 'EXPRESS' : pkg.network
                            
                            return (
                                <button
                                    key={pkg.id} onClick={() => { setErrorMsg(null); setSelectedPackage(pkg) }}
                                    className={cn(
                                        'relative rounded-[24px] overflow-hidden transition-all duration-200 active:scale-95 text-left flex flex-col',
                                        cardStyle.bg,
                                        isSelected ? 'ring-4 ring-offset-2 ring-[var(--brand-color)] scale-[1.02] shadow-xl' : 'shadow-md hover:shadow-lg hover:-translate-y-1 opacity-95 hover:opacity-100'
                                    )}
                                >
                                    {/* Top Section */}
                                    <div className="p-4 relative flex-1 flex flex-col items-center justify-center min-h-[140px]">
                                        {/* Top Left Logo Circle */}
                                        <div className={cn("absolute top-3 left-3 w-10 h-10 rounded-full flex items-center justify-center backdrop-blur-sm", cardStyle.iconBg)}>
                                            <div className="w-6 h-6 rounded-full flex items-center justify-center bg-transparent">
                                                <NetworkLogo id={pkg.network} />
                                            </div>
                                        </div>
                                        
                                        {/* Top Right Pill */}
                                        <div className={cn("absolute top-3 right-3 px-3 py-1 rounded-full text-[11px] font-black tracking-tight", cardStyle.pill)}>
                                            {pillText}
                                        </div>

                                        {/* Center Content */}
                                        <div className={cn("text-center mt-8 mb-2 space-y-1 w-full", cardStyle.text)}>
                                            <h3 className="text-[32px] leading-none font-black tracking-tighter">{pkg.size}</h3>
                                            <p className="text-lg font-bold">{formatCurrency(pkg.selling_price)}</p>
                                            
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
                )}
                </div>
            )}

            </div>

            {/* Checkout sheet for DATA packages.
                Steps aside while an OTP dialog is up — the sheet outranks the Radix
                overlay, so leaving it up would bury the code input. The typed values
                live in this component, so they survive and the sheet returns intact. */}
            {selectedPackage && !otpRequired && (() => {
                const sheetStyle = getNetworkCardStyle(selectedPackage.network)
                const payNetworks: { id: PayNetwork; label: string; dot: string }[] = [
                    { id: 'MTN', label: 'MTN', dot: 'bg-[#FFCC00]' },
                    { id: 'Telecel', label: 'Telecel', dot: 'bg-[#da291c]' },
                    { id: 'AT', label: 'AirtelTigo', dot: 'bg-[#2463eb]' },
                ]
                return (
                    // Hidden — not unmounted — while the registration prompt is up. This
                    // sheet sits at z-[70], above the Radix dialog's z-50 overlay, so
                    // leaving it visible buries the prompt. Keeping it mounted preserves
                    // the entered numbers and payment choice for a Cancel.
                    <div
                        className={cn(
                            "fixed inset-0 z-[70] flex items-end justify-center",
                            registrationPrompt && "hidden"
                        )}
                        aria-hidden={!!registrationPrompt}
                    >
                        <div
                            className="absolute inset-0 bg-black/50 backdrop-blur-[2px] animate-in fade-in duration-200"
                            onClick={() => !loading && closeDataCheckout()}
                        />
                        {/* max-h uses dvh so the sheet shrinks to the *visible* viewport when
                            the Android keyboard opens; with vh the sticky action bar was pushed
                            under the IME. The vh value stays as a fallback for older WebViews. */}
                        <div className="relative w-full sm:max-w-lg bg-white dark:bg-gray-900 rounded-t-xl sm:rounded-b-xl sm:mb-6 shadow-e4 sheet-maxh overflow-y-auto animate-sheet-up">
                            <div className="sticky top-0 z-10 bg-white dark:bg-gray-900 pt-3 pb-1 rounded-t-[28px]">
                                <div className="mx-auto w-10 h-1.5 rounded-full bg-gray-200 dark:bg-gray-700" />
                                <button
                                    onClick={() => !loading && closeDataCheckout()}
                                    aria-label="Close checkout"
                                    className="absolute top-2 right-4 w-9 h-9 rounded-full bg-gray-100 dark:bg-gray-800 flex items-center justify-center text-gray-500 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
                                >
                                    <X className="w-5 h-5" />
                                </button>
                            </div>

                            <div className="px-5 pb-8 pt-3 space-y-5">
                                {/* Selected package banner */}
                                <div className={cn('rounded-2xl px-4 py-4 flex items-center justify-between gap-3', sheetStyle.bg, sheetStyle.text)}>
                                    <div className="flex items-center gap-3 min-w-0">
                                        <div className={cn('w-10 h-10 rounded-full flex items-center justify-center shrink-0', sheetStyle.iconBg)}>
                                            <div className="w-6 h-6">
                                                <NetworkLogo id={selectedPackage.network} />
                                            </div>
                                        </div>
                                        <p className="text-lg font-black tracking-tight truncate">
                                            {selectedPackage.network} · {selectedPackage.size}
                                        </p>
                                    </div>
                                    <p className="text-lg font-black tracking-tight shrink-0">{formatCurrency(selectedPackage.selling_price)}</p>
                                </div>

                                {/* Beneficiary */}
                                <div className="space-y-2">
                                    <Label className={SHEET_LABEL_CLASS}>
                                        Beneficiary number <span className="font-semibold text-gray-400">(gets the data)</span>
                                    </Label>
                                    <input
                                        type="tel" inputMode="numeric" value={phone}
                                        onChange={(e) => setPhone(e.target.value)}
                                        placeholder="0241234567"
                                        className={SHEET_FIELD_CLASS}
                                    />
                                </div>

                                {/* Payer — typed on its own. Any number on any network may pay, so this
                                    is never locked to the beneficiary's number. */}
                                <div className="space-y-2">
                                    <Label className={SHEET_LABEL_CLASS}>
                                        Mobile Money number <span className="font-semibold text-gray-400">(to pay)</span>
                                    </Label>
                                    <input
                                        type="tel" inputMode="numeric"
                                        value={payPhone}
                                        onChange={(e) => setPayPhone(e.target.value)}
                                        placeholder="0241234567"
                                        className={SHEET_FIELD_CLASS}
                                    />
                                </div>


                                {/* Payment network */}
                                <div className="space-y-2">
                                    <Label className={SHEET_LABEL_CLASS}>Network</Label>
                                    <div className="grid grid-cols-3 gap-2">
                                        {payNetworks.map(({ id, label, dot }) => (
                                            <button
                                                key={id}
                                                type="button"
                                                onClick={() => { setPayNetwork(id); setPayNetworkManual(true) }}
                                                className={cn(
                                                    'flex items-center justify-center gap-2 py-3 rounded-2xl border text-sm font-bold transition-all',
                                                    payNetwork === id
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

                                {/* Email */}
                                <div className="space-y-2">
                                    <Label className={SHEET_LABEL_CLASS}>
                                        Email <span className="font-semibold text-gray-400">(for receipt — optional)</span>
                                    </Label>
                                    <input
                                        type="email" value={email}
                                        onChange={(e) => setEmail(e.target.value)}
                                        placeholder="you@example.com"
                                        className={SHEET_FIELD_CLASS}
                                    />
                                </div>

                                {/* The page-level banner sits behind this sheet, so repeat it here */}
                                {errorMsg && (
                                    <div className="flex items-start gap-2 p-3 rounded-md bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800">
                                        <AlertCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
                                        <p className="text-xs font-bold text-red-800 dark:text-red-300">{errorMsg}</p>
                                    </div>
                                )}
                            </div>

                            {/* Cost summary + action, pinned to the bottom of the sheet.
                                The fee disclosure used to be grey fine print BELOW the button,
                                which is the worst place for it in a mobile-money flow: the
                                payer commits, then discovers the amount differs on their
                                handset. It now sits above the CTA as a labelled line.

                                We deliberately do NOT show a computed total. The fee percent
                                lives in HUBTEL_FEE_PERCENT on the server and is never sent to
                                the browser, so any total rendered here would be a guess — and
                                a wrong number on a payment screen is worse than no number. */}
                            <div className="sticky bottom-0 border-t border-gray-100 dark:border-gray-800 bg-white/95 dark:bg-gray-900/95 backdrop-blur-sm px-5 pt-3 pb-4 safe-b space-y-3">
                                <dl className="space-y-1.5">
                                    <div className="flex items-center justify-between text-sm">
                                        <dt className="font-semibold text-gray-500 dark:text-gray-400">Bundle</dt>
                                        <dd className="font-bold tabular text-gray-900 dark:text-gray-100">
                                            {formatCurrency(selectedPackage.selling_price)}
                                        </dd>
                                    </div>
                                    <div className="flex items-center justify-between text-sm">
                                        <dt className="font-semibold text-gray-500 dark:text-gray-400">Payment fee</dt>
                                        <dd className="font-semibold text-gray-500 dark:text-gray-400">
                                            added by Mobile Money
                                        </dd>
                                    </div>
                                </dl>

                                <button
                                    onClick={() => handleBuyData()} disabled={loading}
                                    className="w-full py-4 rounded-md bg-[var(--brand-color)] text-white font-black text-lg flex items-center justify-center gap-2 active:scale-[0.98] transition-transform disabled:opacity-70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-[var(--brand-color)]"
                                >
                                    {loading
                                        ? <><Loader2 className="w-5 h-5 animate-spin" /> {pollingRef ? 'Waiting for approval...' : 'Processing...'}</>
                                        : <><Smartphone className="w-5 h-5" /> Pay {formatCurrency(selectedPackage.selling_price)}</>}
                                </button>

                                <p className="text-[12px] text-center font-semibold text-gray-400 leading-snug">
                                    Your phone will show the exact total to approve.
                                </p>
                            </div>
                        </div>
                    </div>
                )
            })()}

            {/* WhatsApp floating button */}
            {shop.whatsapp_number && (
                <div className="fixed bottom-6 right-4 z-50 flex items-center gap-3 group animate-in slide-in-from-bottom-6 duration-700">
                    <style dangerouslySetInnerHTML={{ __html: `
                        @keyframes promptPeek {
                            0%, 100% { transform: translateX(5px); opacity: 0; }
                            10%, 90% { transform: translateX(0); opacity: 1; }
                        }
                        .animate-prompt-peek { animation: promptPeek 4s ease-in-out infinite; }
                    ` }} />
                    <div className="absolute right-[4.5rem] hidden sm:block bg-white dark:bg-gray-800 text-gray-800 dark:text-white px-3 py-1.5 rounded-xl shadow-lg border border-gray-100 dark:border-gray-700 pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity animate-prompt-peek whitespace-nowrap">
                        <span className="font-bold text-xs sm:text-sm tracking-tight text-gray-700 dark:text-gray-200">Need Help?</span>
                        <div className="absolute top-1/2 -mt-1 -right-1.5 w-3 h-3 bg-white dark:bg-gray-800 border-r border-t border-gray-100 dark:border-gray-700 rotate-45" />
                    </div>
                    <a
                        href={`https://wa.me/${shop.whatsapp_number}`} target="_blank" rel="noopener noreferrer"
                        className="w-14 h-14 rounded-full bg-[#25D366] shadow-xl flex items-center justify-center hover:scale-110 transition-transform relative"
                        aria-label="Chat on WhatsApp"
                    >
                        <div className="absolute inset-0 rounded-full bg-[#25D366] animate-ping opacity-20" />
                        <svg viewBox="0 0 24 24" className="w-7 h-7 fill-white relative z-10" xmlns="http://www.w3.org/2000/svg">
                            <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.008-.57-.008-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.88 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
                        </svg>
                    </a>
                </div>
            )}

            {/* ── Sidebar Navigation Overlay ── */}
            <div className={cn("fixed inset-0 z-[100] transition-opacity duration-200", isSidebarOpen ? "opacity-100" : "opacity-0 pointer-events-none")}>
                <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setIsSidebarOpen(false)} />
                <div className={cn("absolute top-0 left-0 w-[min(300px,88vw)] h-full bg-gray-50 dark:bg-gray-950 shadow-2xl transition-transform duration-200 transform flex flex-col will-change-transform", isSidebarOpen ? "translate-x-0" : "-translate-x-full")}>
                    <div className="p-5 relative flex flex-col items-center justify-center bg-[var(--brand-color)] h-32 overflow-hidden shadow-inner border-b border-black/10">
                        <div className="absolute inset-0 opacity-10 bg-[url('https://www.transparenttextures.com/patterns/carbon-fibre.png')]" />
                        {shop.logo_url ? (
                            <div className="relative w-14 h-14 rounded-2xl overflow-hidden bg-white/20 shadow-md mb-2">
                                <Image src={shop.logo_url} alt="Logo" fill className="object-contain" />
                            </div>
                        ) : (
                            <div className="w-12 h-12 rounded-xl bg-white/20 flex items-center justify-center shadow-md mb-2">
                                <ShoppingCart className="w-6 h-6 text-white" />
                            </div>
                        )}
                        <p className="font-black text-white text-lg truncate w-full text-center relative z-10 drop-shadow-md">{shop.shop_name}</p>
                        <button 
                            onClick={() => setIsSidebarOpen(false)} 
                            className="absolute top-3 right-3 p-1.5 bg-black/20 hover:bg-black/40 rounded-full text-white transition-colors backdrop-blur-sm shadow-sm border border-white/10"
                            aria-label="Close menu"
                            title="Close menu"
                        >
                            <X className="w-4 h-4" />
                        </button>
                    </div>
                    <div className="flex-1 overflow-y-auto py-5 px-3 space-y-1.5">
                        <button onClick={() => { setIsSidebarOpen(false); setActiveTab('data'); }} className={cn("w-full flex items-center gap-3 px-3 py-3 rounded-xl transition-all shadow-sm border", activeTab === 'data' ? "bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 border-gray-200 dark:border-gray-700" : "hover:bg-gray-100 dark:hover:bg-gray-900 text-gray-600 dark:text-gray-400 border-transparent")}>
                            <Zap className={cn("w-5 h-5", activeTab === 'data' ? "text-[var(--brand-color)]" : "text-gray-400")} /> <span className="font-bold flex-1 text-left">Data Packages</span> 
                            {activeTab === 'data' && <Check className="w-4 h-4 text-[var(--brand-color)]" />}
                        </button>
                        {networks.map(net => (
                            <button key={net} onClick={() => { setIsSidebarOpen(false); setActiveTab('data'); setActiveNetwork(net); }} className="w-full flex items-center gap-3 px-3 py-2 pl-11 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-900 text-left text-sm font-semibold text-gray-500 transition-colors">
                                {net} Bundles
                            </button>
                        ))}

                        {isShopAirtimeEnabled && (
                            <button onClick={() => { setIsSidebarOpen(false); setActiveTab('airtime'); }} className={cn("mt-2 w-full flex items-center gap-3 px-3 py-3 rounded-xl transition-all shadow-sm border", activeTab === 'airtime' ? "bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 border-gray-200 dark:border-gray-700" : "hover:bg-gray-100 dark:hover:bg-gray-900 text-gray-600 dark:text-gray-400 border-transparent")}>
                                <Smartphone className={cn("w-5 h-5", activeTab === 'airtime' ? "text-[var(--brand-color)]" : "text-gray-400")} /> <span className="font-bold flex-1 text-left">Airtime Recharge</span>
                                {activeTab === 'airtime' && <Check className="w-4 h-4 text-[var(--brand-color)]" />}
                            </button>
                        )}
                        {isGlobalMashupEnabled && (
                            <button onClick={() => { setIsSidebarOpen(false); setActiveTab('mashup'); }} className={cn("mt-2 w-full flex items-center gap-3 px-3 py-3 rounded-xl transition-all shadow-sm border", activeTab === 'mashup' ? "bg-amber-500 text-white border-amber-600" : "hover:bg-gray-100 dark:hover:bg-gray-900 text-gray-600 dark:text-gray-400 border-transparent")}>
                                <Target className={cn("w-5 h-5", activeTab === 'mashup' ? "text-white" : "text-gray-400")} /> <span className="font-bold flex-1 text-left">MTN Mashup</span>
                                {activeTab === 'mashup' && <Check className="w-4 h-4 text-white" />}
                            </button>
                        )}
                        {isShopRcEnabled && (
                            <button onClick={() => { setIsSidebarOpen(false); setActiveTab('results_checker'); }} className={cn("mt-2 w-full flex items-center gap-3 px-3 py-3 rounded-xl transition-all shadow-sm border", activeTab === 'results_checker' ? "bg-blue-600 text-white border-blue-700" : "hover:bg-gray-100 dark:hover:bg-gray-900 text-gray-600 dark:text-gray-400 border-transparent")}>
                                <GraduationCap className={cn("w-5 h-5", activeTab === 'results_checker' ? "text-white" : "text-blue-500")} /> <span className="font-bold flex-1 text-left">Result Checker</span>
                                {activeTab === 'results_checker' && <Check className="w-4 h-4 text-white" />}
                            </button>
                        )}
                        {isShopAfaEnabled && (
                            <button onClick={() => { setIsSidebarOpen(false); setActiveTab('afa'); }} className={cn("mt-2 w-full flex items-center gap-3 px-3 py-3 rounded-xl transition-all shadow-sm border", activeTab === 'afa' ? "bg-sky-600 text-white border-sky-700" : "hover:bg-gray-100 dark:hover:bg-gray-900 text-gray-600 dark:text-gray-400 border-transparent")}>
                                <BadgeCheck className={cn("w-5 h-5", activeTab === 'afa' ? "text-white" : "text-sky-500")} /> <span className="font-bold flex-1 text-left">AFA Registration</span>
                                {activeTab === 'afa' && <Check className="w-4 h-4 text-white" />}
                            </button>
                        )}
                        <div className="my-4 border-t border-gray-200 dark:border-gray-800" />
                        <Link href={`/shop/status?shop=${shop.shop_slug}&name=${encodeURIComponent(shop.shop_name)}`} onClick={() => setIsSidebarOpen(false)} className="w-full flex items-center gap-3 px-3 py-3 rounded-xl hover:bg-gray-100 dark:hover:bg-gray-900 text-left font-bold text-gray-600 dark:text-gray-400 transition-colors">
                            <History className="w-5 h-5 text-gray-400" /> Track My Orders
                        </Link>
                        <Link href={`/shop/${shop.shop_slug}/about`} onClick={() => setIsSidebarOpen(false)} className="w-full flex items-center gap-3 px-3 py-3 rounded-xl hover:bg-gray-100 dark:hover:bg-gray-900 text-left font-bold text-gray-600 dark:text-gray-400 transition-colors">
                            <Info className="w-5 h-5 text-gray-400" /> About Shop & Terms
                        </Link>

                        {/* Install Shop Button — always visible unless already installed in standalone mode */}
                        {!isInstalled && (
                            <>
                                <div className="my-2 border-t border-gray-200 dark:border-gray-800" />
                                <button
                                    onClick={handleInstallShop}
                                    className="w-full flex items-center gap-3 px-3 py-3 rounded-xl text-left font-bold transition-colors text-emerald-600 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-900/20"
                                    aria-label={isIOS ? 'Add to Home Screen' : 'Install Shop App'}
                                >
                                    {isIOS
                                        ? <Share2 className="w-5 h-5" />
                                        : <Download className="w-5 h-5" />
                                    }
                                    {isIOS ? 'Add to Home Screen' : 'Install Shop App'}
                                </button>
                            </>
                        )}
                    </div>
                </div>
            </div>

            {/* ── Announcement Modal — the author picks the tone; type is only the
                 fallback for rows written before tones existed ── */}
            {announcement && (
                <AnnouncementModal
                    open={showAnnouncementModal}
                    onOpenChange={setShowAnnouncementModal}
                    tone={(announcement.tone as AnnouncementTone | undefined)
                        ?? (announcement.type === 'admin' ? 'official' : 'shop')}
                    badgeLabel={announcement.badgeLabel}
                    title={announcement.title}
                    message={announcement.message}
                    communityLink={shop.community_link}
                />
            )}

            <CopyrightFooter 
                variant="shop" 
                shopName={shop.shop_name} 
                adminSettings={adminSettings}
                className="pb-20 pt-10" // Extra padding to stay clear of floating buttons
            />

            {/* Per-shop PWA install prompt — lazy loaded, no SSR impact */}
            <ShopPwaInstallPrompt
                shopName={shop.shop_name}
                shopSlug={shop.shop_slug}
                logoUrl={shop.logo_url}
                brandColor={shop.brand_color}
            />

            {/* Moolre per-transaction OTP */}
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
                        <Button
                            type="button"
                            variant="secondary"
                            onClick={() => setOtpRequired(false)}
                        >
                            Cancel
                        </Button>
                        <Button
                            type="button"
                            onClick={handleVerifyOtp}
                            disabled={loading || !otpCode}
                            className="bg-blue-600 hover:bg-blue-700"
                        >
                            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Verify & Continue'}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* ── RC Voucher Delivery Modal ── */}
            <Dialog open={showRcDelivery} onOpenChange={setShowRcDelivery}>
                <DialogContent className="max-w-sm mx-auto">
                    <DialogHeader>
                        <div className="flex justify-center mb-2">
                            <div className="w-14 h-14 rounded-full bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center">
                                <GraduationCap className="w-7 h-7 text-emerald-600 dark:text-emerald-400" />
                            </div>
                        </div>
                        <DialogTitle className="text-center text-lg font-black">
                            🎉 Payment Successful!
                        </DialogTitle>
                        <DialogDescription className="text-center text-sm">
                            Your Result Checker {rcVouchers.length > 1 ? 'vouchers are' : 'voucher is'} ready. Copy and save your PIN and Serial Number.
                        </DialogDescription>
                    </DialogHeader>

                    <div className="space-y-3 my-2">
                        {rcVouchers.map((v, i) => (
                            <div key={i} className="bg-gray-50 dark:bg-gray-800 rounded-xl p-4 border border-gray-200 dark:border-gray-700 space-y-3">
                                {rcVouchers.length > 1 && (
                                    <p className="text-xs font-black text-gray-500 uppercase tracking-wider">Voucher {i + 1}</p>
                                )}
                                <div className="space-y-2">
                                    <div>
                                        <p className="text-[10px] font-black text-gray-400 uppercase tracking-wider mb-0.5">PIN</p>
                                        <div className="flex items-center justify-between bg-white dark:bg-gray-900 rounded-lg px-3 py-2 border border-gray-200 dark:border-gray-700">
                                            <span className="font-mono text-base font-black text-gray-900 dark:text-white tracking-widest">{v.pin}</span>
                                            <button
                                                onClick={() => { navigator.clipboard.writeText(v.pin); toast.success('PIN copied!') }}
                                                title="Copy PIN"
                                                className="ml-2 p-1.5 rounded-md hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-400 hover:text-gray-600 transition-colors"
                                            >
                                                <Copy className="w-3.5 h-3.5" />
                                            </button>
                                        </div>
                                    </div>
                                    <div>
                                        <p className="text-[10px] font-black text-gray-400 uppercase tracking-wider mb-0.5">Serial Number</p>
                                        <div className="flex items-center justify-between bg-white dark:bg-gray-900 rounded-lg px-3 py-2 border border-gray-200 dark:border-gray-700">
                                            <span className="font-mono text-base font-black text-gray-900 dark:text-white tracking-widest">{v.serial_number}</span>
                                            <button
                                                onClick={() => { navigator.clipboard.writeText(v.serial_number); toast.success('Serial copied!') }}
                                                title="Copy Serial Number"
                                                className="ml-2 p-1.5 rounded-md hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-400 hover:text-gray-600 transition-colors"
                                            >
                                                <Copy className="w-3.5 h-3.5" />
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>

                    <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-xl p-3">
                        <p className="text-xs text-amber-700 dark:text-amber-400 font-medium text-center">
                            ⚠️ Save your PIN and Serial Number now. This screen will not appear again.
                        </p>
                    </div>

                    <DialogFooter>
                        <Button
                            className="w-full"
                            onClick={() => { setShowRcDelivery(false); setSelectedRc(null); setRcPhone(''); setRcEmail('') }}
                        >
                            Done — Close
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
            {/* Floating Bottom Action Bar */}
            <div className="fixed bottom-0 left-0 w-full z-[45] pb-8 pt-4 pointer-events-none">
                <div className="max-w-2xl mx-auto px-6 flex justify-between items-end">
                    <button className="pointer-events-auto bg-white dark:bg-[#1c2333] border border-gray-200 dark:border-gray-800/60 text-gray-700 dark:text-gray-300 rounded-[1.5rem] px-5 py-3.5 flex items-center gap-3 shadow-xl transition-transform hover:scale-105">
                        <Bell className="w-5 h-5 text-amber-500" />
                        <span className="text-sm font-bold tracking-wide">Get Notified</span>
                    </button>
                </div>
            </div>

            {/* Beneficiary's MTN number is not registered — asked before any charge. */}
            <MtnRegistrationDialog
                open={!!registrationPrompt}
                numbers={registrationPrompt?.numbers}
                isSubmitting={isConfirmingRegistration}
                onConfirm={async () => {
                    setIsConfirmingRegistration(true)
                    try {
                        setRegistrationPrompt(null)
                        await handleBuyData({ acknowledgeRegistration: true })
                    } finally {
                        setIsConfirmingRegistration(false)
                    }
                }}
                onCancel={() => setRegistrationPrompt(null)}
            />
        </div>
    )
}
