'use client'

import { useState, useEffect } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import {
    Search, Loader2, CheckCircle2, XCircle, Clock,
    Package, CalendarDays, History, Info, ShoppingCart, Phone,
    Mail, MessageCircle
} from 'lucide-react'
import { formatCurrency, cn } from '@/lib/utils'
import { getOrderDisplayStatus, getOrderStatusLabel, getOrderStatusBadgeClass } from '@/lib/order-status-display'
import { toast } from 'sonner'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import Image from 'next/image'
import { supabase } from '@/lib/supabase'
import { ThemeToggle } from '@/components/ui/theme-toggle'

interface Order {
    id: string
    network: string
    package_size: string
    selling_price: number
    status: 'pending' | 'processing' | 'completed' | 'failed' | 'refunded'
    // Carried through by get_shop_order_by_phone_reference so a supplier hold is
    // visible to the customer waiting on the bundle, not just to admins.
    supplier_status?: string | null
    created_at: string
    shop_name: string // Flattened from RPC
    shop_slug: string // Flattened from RPC
}

// Labels and colours come from lib/order-status-display so this tracker words a
// status exactly as every other surface does; only the icon is chosen here.
const statusIcons: Record<string, any> = {
    pending: Clock,
    processing: Loader2,
    verifying: Clock,
    completed: CheckCircle2,
    failed: XCircle,
    refunded: XCircle,
}

function OrderCard({ order }: { order: Order }) {
    const displayStatus = getOrderDisplayStatus(order)
    const badgeClass = getOrderStatusBadgeClass(displayStatus)
    const label = getOrderStatusLabel(displayStatus)
    const Icon = statusIcons[displayStatus] || Clock

    return (
        <Card className="overflow-hidden border border-gray-100 dark:border-gray-800 shadow-sm hover:shadow-md transition-shadow">
            <div className="p-4 flex items-center gap-4">
                <div className={cn('w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0', badgeClass)}>
                    <Icon className="w-5 h-5" />
                </div>
                <div className="flex-1 min-w-0">
                    <div className="flex justify-between items-start">
                        <div>
                            <p className="font-bold text-sm text-gray-900 dark:text-gray-100">{order.network} {order.package_size}</p>
                            <Link href={`/shop/${order.shop_slug}`} className="text-xs text-blue-600 dark:text-blue-400 hover:underline flex items-center gap-1">
                                {order.shop_name}
                            </Link>
                        </div>
                        <p className="font-black text-sm text-gray-800 dark:text-gray-200">{formatCurrency(order.selling_price)}</p>
                    </div>
                    <div className="flex justify-between items-center mt-2">
                        <p className="text-[10px] text-muted-foreground flex items-center gap-1">
                            <Clock className="w-3 h-3" />
                            {new Date(order.created_at).toLocaleDateString()} {new Date(order.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </p>
                        <span className={cn('text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full', badgeClass)}>
                            {label}
                        </span>
                    </div>
                </div>
            </div>
        </Card>
    )
}

interface ShopProfile {
    shop_name: string
    logo_url: string | null
    owner_phone: string
    owner_email: string | null
    whatsapp_number: string | null
    brand_color: string
}

export default function ShopStatusTracker() {
    const searchParams = useSearchParams()
    const shopParam = searchParams.get('shop')
    const nameParam = searchParams.get('name')

    const [phone, setPhone] = useState('')
    const [reference, setReference] = useState('')
    const [searchOrders, setSearchOrders] = useState<Order[]>([])
    const [lastShopSlug, setLastShopSlug] = useState<string | null>(null)
    
    // Shop details state
    const [shopData, setShopData] = useState<ShopProfile | null>(null)

    // Loading states
    const [searchLoading, setSearchLoading] = useState(false)
    const [hasSearched, setHasSearched] = useState(false)

    // ─── 1. Load Phone & Slug from Storage & Fetch Shop ───
    useEffect(() => {
        try {
            const savedPhone = localStorage.getItem('shop_last_phone')
            if (savedPhone) setPhone(savedPhone)
            const savedReference = localStorage.getItem('shop_last_reference')
            if (savedReference) setReference(savedReference)
            const slugFromStorage = sessionStorage.getItem('shop_sticky_slug')
            setLastShopSlug(slugFromStorage)
            
            const activeSlug = shopParam || slugFromStorage
            if (activeSlug) {
                fetchShopData(activeSlug)
            }
        } catch (_) { }
    }, [shopParam])

    const fetchShopData = async (slug: string) => {
        try {
            const cleanSlug = slug.trim()
            const { data } = await supabase
                .from('shop_profiles')
                .select('shop_name, logo_url, owner_phone, owner_email, whatsapp_number, brand_color')
                .ilike('shop_slug', cleanSlug)
                .single()
            if (data) {
                setShopData(data as ShopProfile)
            }
        } catch (err) {
            console.error('Failed to fetch shop details', err)
        }
    }

    // Contrast utility for sticky header text color
    const isLightColor = (hex: string) => {
        if (!/^#([A-Fa-f0-9]{3}){1,4}$/.test(hex)) return false
        const r = parseInt(hex.slice(1, 3), 16)
        const g = parseInt(hex.slice(3, 5), 16)
        const b = parseInt(hex.slice(5, 7), 16)
        const yiq = ((r * 299) + (g * 587) + (b * 114)) / 1000
        return yiq >= 128
    }

    const brandColor = shopData?.brand_color || '#2563eb'
    const safeBrandColor = /^#([A-Fa-f0-9]{3}){1,4}$/.test(brandColor) ? brandColor : '#2563eb'
    const brandContrastText = isLightColor(safeBrandColor) ? '#030712' : '#ffffff'

    // ─── 2. Handle Manual Search with 20min Cache ───
    const handleSearch = async (e: React.FormEvent) => {
        e.preventDefault()
        if (!phone.trim()) { toast.error('Enter a phone number'); return }
        if (!reference.trim()) { toast.error('Enter your payment reference'); return }

        const cleanPhone = phone.replace(/\s+/g, '')
        const cleanReference = reference.trim()
        const ghanaPhoneRegex = /^(0\d{9}|233\d{9})$/
        const referenceRegex = /^(RC-)?SHOP-[A-Za-z0-9_-]{3,120}$/
        if (!ghanaPhoneRegex.test(cleanPhone)) {
            toast.error('Enter a valid Ghana phone number (e.g. 0244123456)')
            return
        }
        if (!referenceRegex.test(cleanReference)) {
            toast.error('Enter a valid shop payment reference (starts with SHOP- or RC-SHOP-)')
            return
        }

        setSearchLoading(true)
        setHasSearched(true)
        
        // Caching Logic: Check cache and TTL
        const cacheKey = `shop_tracker_cache_${cleanPhone}_${cleanReference}`
        try {
            const cachedData = localStorage.getItem(cacheKey)
            if (cachedData) {
                const parsed = JSON.parse(cachedData)
                if (parsed.timestamp && Date.now() - parsed.timestamp <= 20 * 60 * 1000) {
                    let orders = parsed.orders || []
                    if (shopParam) orders = orders.filter((o: Order) => o.shop_slug === shopParam)
                    setSearchOrders(orders)
                    setSearchLoading(false)
                    return
                }
            }
        } catch (err) { }

        try {
            const res = await fetch(`/api/shop/lookup-orders?phone=${encodeURIComponent(cleanPhone)}&reference=${encodeURIComponent(cleanReference)}`)
            if (!res.ok) throw new Error('Failed to fetch')
            const json = await res.json()

            let fetchedOrders = (json.orders as Order[] || [])
            
            // Save to cache before applying shop-specific filter
            try {
                localStorage.setItem(cacheKey, JSON.stringify({
                    timestamp: Date.now(),
                    orders: fetchedOrders
                }))
                localStorage.setItem('shop_last_phone', cleanPhone)
                localStorage.setItem('shop_last_reference', cleanReference)
            } catch (_) {}

            // Filter by shop if param exists
            if (shopParam) {
                fetchedOrders = fetchedOrders.filter(o => o.shop_slug === shopParam)
            }

            setSearchOrders(fetchedOrders)
        } catch (err) {
            console.error(err)
            toast.error('Failed to fetch orders. Please try again.')
        } finally {
            setSearchLoading(false)
        }
    }

    return (
        <div className={cn("min-h-screen  pb-20", shopData && "theme-tracker")}>
            {shopData && (
                <style dangerouslySetInnerHTML={{
                    __html: `
                        .theme-tracker {
                            --brand-color: ${safeBrandColor};
                            --brand-contrast-text: ${brandContrastText};
                        }
                    `
                }} />
            )}
            
            {/* ── Permanent Top Bar ── */}
            {shopData && (
                <>
                    <div className="fixed top-0 left-0 w-full z-[45] shadow-lg border-b border-black/5 dark:border-white/5 bg-[var(--brand-color)]/95 backdrop-blur-md transition-all duration-300 ease-in-out">
                        <div className="max-w-2xl mx-auto px-4 py-3 flex items-center justify-between gap-3">
                            <div className="flex items-center gap-3 min-w-0">
                                {shopData.logo_url && (
                                    <div className="relative w-8 h-8 rounded-lg overflow-hidden flex-shrink-0 border border-black/5 shadow-sm bg-white/20">
                                        <Image src={shopData.logo_url} alt="Logo" fill className="object-contain" />
                                    </div>
                                )}
                                <h1 className="font-black text-[15px] sm:text-lg truncate text-[var(--brand-contrast-text)] transition-colors">
                                    {shopData.shop_name}
                                </h1>
                            </div>
                            <ThemeToggle />
                        </div>
                    </div>
                    {/* Spacer */}
                    <div className="h-[60px] flex-shrink-0" />
                </>
            )}

            <div className="max-w-md mx-auto p-4 space-y-8 mt-4">
                {/* Page header */}
                <div className="text-center space-y-2">
                    <h1 className="text-2xl font-black text-gray-900 dark:text-white">
                        {nameParam || shopData?.shop_name ? `Track Your ${nameParam || shopData?.shop_name} Orders` : 'Track Your Order'}
                    </h1>
                    <p className="text-muted-foreground text-sm max-w-xs mx-auto">
                        Orders within the past 48 hours.
                    </p>
                    {/* Buy More Data Button */}
                    {(searchOrders.length > 0 || lastShopSlug || shopParam) && (
                        <div className="pt-2">
                            <Link
                                href={`/shop/${shopParam || searchOrders[0]?.shop_slug || lastShopSlug}`}
                                className="inline-flex items-center gap-2 text-sm font-bold text-emerald-600 hover:text-emerald-700 bg-emerald-50 hover:bg-emerald-100 px-4 py-2 rounded-full transition-colors"
                            >
                                <ShoppingCart className="w-4 h-4" />
                                Buy More Data
                            </Link>
                        </div>
                    )}
                </div>

                {/* ── UI Policy Descriptor Update ── */}
                <div className="bg-blue-50 dark:bg-blue-900/20 text-blue-800 dark:text-blue-300 rounded-xl p-4 text-xs flex items-start gap-3 border border-blue-100 dark:border-blue-800/50 shadow-sm">
                    <Info className="w-5 h-5 flex-shrink-0 mt-0.5 text-blue-600 dark:text-blue-400" />
                    <p className="leading-relaxed font-medium">Tracking operates instantly with your phone number and payment reference. Recent results are locked for 20 minutes, showing only orders strictly within the past 48 hours.</p>
                </div>

                {/* ── Search Section ── */}
                <Card className="border-none shadow-lg bg-white dark:bg-gray-900">
                    <CardContent className="p-5 space-y-4">
                        <form onSubmit={handleSearch} className="space-y-4">
                            <div className="space-y-1.5">
                                <label className="text-xs font-bold text-gray-600 dark:text-gray-400 uppercase tracking-wide">
                                    Phone Number
                                </label>
                                <div className="relative">
                                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                                    <Input
                                        type="tel"
                                        placeholder="0244123456"
                                        value={phone}
                                        onChange={(e) => setPhone(e.target.value)}
                                        className="pl-9 h-11 bg-gray-50 dark:bg-gray-800 border-gray-200 dark:border-gray-700 focus:ring-2 focus:ring-emerald-500/20"
                                    />
                                </div>
                            </div>
                            <div className="space-y-1.5">
                                <label className="text-xs font-bold text-gray-600 dark:text-gray-400 uppercase tracking-wide">
                                    Payment Reference
                                </label>
                                <div className="relative">
                                    <Package className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                                    <Input
                                        type="text"
                                        placeholder="SHOP-..."
                                        value={reference}
                                        onChange={(e) => setReference(e.target.value)}
                                        className="pl-9 h-11 bg-gray-50 dark:bg-gray-800 border-gray-200 dark:border-gray-700 focus:ring-2 focus:ring-emerald-500/20"
                                    />
                                </div>
                            </div>
                            <Button
                                type="submit"
                                disabled={searchLoading || !phone.trim() || !reference.trim()}
                                className="w-full h-11 font-bold bg-emerald-600 hover:bg-emerald-700 text-white shadow-md active:scale-[0.98] transition-all"
                            >
                                {searchLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : 'Find My Orders'}
                            </Button>
                        </form>
                    </CardContent>
                </Card>

                {/* ── Search Results ── */}
                {hasSearched && (
                    <div className="space-y-4 animate-in fade-in slide-in-from-bottom-8 duration-500">
                        <div className="flex items-center gap-2 px-1">
                            {searchOrders.length > 0 ? (
                                <CalendarDays className="w-4 h-4 text-emerald-600" />
                            ) : (
                                <Info className="w-4 h-4 text-muted-foreground" />
                            )}
                            <h2 className="font-bold text-sm text-gray-800 dark:text-gray-200">
                                {searchOrders.length > 0 ? `Found ${searchOrders.length} Order${searchOrders.length === 1 ? '' : 's'}` : 'Search Results'}
                            </h2>
                        </div>

                        {searchOrders.length === 0 ? (
                            <div className="text-center py-10 px-4 rounded-2xl border-2 border-dashed border-gray-200 dark:border-gray-800">
                                <div className="w-12 h-12 rounded-full bg-gray-100 dark:bg-gray-800 flex items-center justify-center mx-auto mb-4 shadow-inner">
                                    <Search className="w-5 h-5 text-gray-400" />
                                </div>
                                <h3 className="font-bold text-gray-900 dark:text-white text-lg">Can't find your order, or looking for past orders?</h3>
                                <p className="text-sm text-muted-foreground mt-2 leading-relaxed">
                                    We couldn't find any recent orders for <span className="font-mono font-medium text-emerald-600">{phone}</span>.
                                    Older orders are securely archived off-screen to keep the system fast.
                                </p>
                                
                                {shopData && (
                                    <div className="mt-6 text-left bg-white dark:bg-gray-800 rounded-xl p-4 border border-gray-100 dark:border-gray-700 shadow-sm space-y-3">
                                        <p className="text-xs font-bold text-gray-500 uppercase tracking-widest text-center mb-1">Contact Shop Owner for Help</p>
                                        <div className="flex flex-col gap-2">
                                            {shopData.whatsapp_number && (
                                                <a href={`https://wa.me/${shopData.whatsapp_number}`} target="_blank" rel="noreferrer" className="flex items-center justify-center gap-2 bg-[#25D366] hover:bg-[#1ebe5d] text-white px-4 py-2.5 rounded-lg text-sm font-bold transition-all shadow-sm">
                                                    <MessageCircle className="w-4 h-4" /> WhatsApp Support
                                                </a>
                                            )}
                                            <div className="flex gap-2">
                                                {shopData.owner_phone && (
                                                    <a href={`tel:${shopData.owner_phone}`} className="flex-1 flex items-center justify-center gap-2 bg-gray-100 hover:bg-gray-200 dark:bg-gray-700 dark:hover:bg-gray-600 text-gray-900 dark:text-white px-4 py-2.5 rounded-lg text-sm font-bold transition-all shadow-sm">
                                                        <Phone className="w-4 h-4" /> Call
                                                    </a>
                                                )}
                                                {shopData.owner_email && (
                                                    <a href={`mailto:${shopData.owner_email}`} className="flex-1 flex items-center justify-center gap-2 bg-gray-100 hover:bg-gray-200 dark:bg-gray-700 dark:hover:bg-gray-600 text-gray-900 dark:text-white px-4 py-2.5 rounded-lg text-sm font-bold transition-all shadow-sm">
                                                        <Mail className="w-4 h-4" /> Email
                                                    </a>
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                )}
                            </div>
                        ) : (
                            <div className="space-y-3">
                                {searchOrders.map(order => <OrderCard key={order.id} order={order} />)}
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    )
}
