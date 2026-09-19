import { Metadata } from 'next'
import Link from 'next/link'
import Image from 'next/image'
import { createServerClient } from '@/lib/supabase'
import { CheckCircle2, ShoppingCart, Clock, XCircle, RefreshCw } from 'lucide-react'
import { CopyButton } from './copy-button'

interface Props {
    params: Promise<{ shopSlug: string }>
    searchParams: Promise<{ ref?: string }>
}

export const revalidate = 0 // Always fresh for success page

export async function generateMetadata({ params }: Props): Promise<Metadata> {
    const { shopSlug } = await params
    return { title: `Order Confirmed — ${shopSlug}` }
}

export default async function ShopSuccessPage({ params, searchParams }: Props) {
    const { shopSlug } = await params
    const { ref } = await searchParams

    const supabase = createServerClient()

    // Fetch shop branding
    const cleanSlug = shopSlug.trim()
    const { data: shop } = await (supabase
        .from('shop_profiles')
        .select('shop_name, logo_url, brand_color, whatsapp_number')
        .ilike('shop_slug', cleanSlug)
        .single() as any)

    // Fetch order details
    let order: any = null
    let isRc = false
    let isAfa = false
    let rcVouchers: any[] = []

    if (ref) {
        if (ref.startsWith('AFA-SHOP-')) {
            isAfa = true
            const { data } = await (supabase
                .from('afa_orders')
                .select('full_name, phone, payment_amount, status, payment_status')
                .eq('reference_code', ref)
                .single() as any)

            if (data) {
                order = {
                    guest_phone: data.phone,
                    network: 'AFA',
                    package_size: `AFA Registration — ${data.full_name}`,
                    selling_price: data.payment_amount,
                    // AFA has no supplier integration: an admin processes it by
                    // hand, so the customer's outcome is driven by whether the
                    // payment landed, not by the fulfilment status.
                    status: data.payment_status === 'failed' ? 'failed' : 'pending',
                    package_id: 'afa_registration',
                }
            }
        } else if (ref.startsWith('RC-')) {
            isRc = true
            const { data } = await (supabase
                .from('results_checker_orders')
                .select('customer_phone, type_name, quantity, total_paid, status, payment_status, id')
                .eq('reference_code', ref)
                .single() as any)
            
            if (data) {
                order = {
                    guest_phone: data.customer_phone,
                    network: 'Voucher',
                    package_size: `${data.quantity}x ${data.type_name?.toUpperCase()}`,
                    selling_price: data.total_paid,
                    status: data.status,
                    package_id: 'rc_voucher', // acts as a flag to not be airtime
                }
                
                if (data.status === 'completed') {
                    const { data: vouchers } = await (supabase
                        .from('results_checker_inventory')
                        .select('pin, serial_number')
                        .eq('order_id', data.id) as any)
                    rcVouchers = vouchers || []
                }
            }
        } else {
            const { data } = await (supabase
                .from('shop_orders')
                .select('guest_phone, network, package_size, selling_price, status, package_id')
                .eq('paystack_reference', ref)
                .single() as any)
            order = data
        }
    }

    const brandColor = shop?.brand_color || '#059669'
    const isAirtime = !isRc && !isAfa && order?.package_id == null && !!order
    const orderStatus = order?.status || 'pending'
    const isFailed = orderStatus === 'failed'
    const isPending = orderStatus === 'pending' || orderStatus === 'processing'

    // Build status-aware hero content
    const heroConfig = (() => {
        if (isFailed) {
            return {
                iconBg: 'bg-red-500',
                Icon: XCircle,
                title: isAfa ? 'Payment Issue' : 'Order Issue',
                subtitle: isAfa
                    ? 'Your AFA registration payment was not completed. Nothing has been charged for this application — please try again or contact the shop.'
                    : isAirtime
                        ? 'There was a problem processing your airtime order. Your payment was received but the order could not be completed.'
                        : 'There was a problem processing your data bundle order. Your payment was received but the order could not be completed.',
                statusColor: 'text-red-600',
            }
        }
        if (isAfa) {
            return {
                iconBg: 'bg-sky-500',
                Icon: Clock,
                title: 'Application Received!',
                subtitle: 'Your payment was successful and your AFA registration has been submitted for processing. The shop will contact you once it is complete.',
                statusColor: 'text-sky-600',
            }
        }
        if (isAirtime) {
            return {
                iconBg: 'bg-amber-500',
                Icon: Clock,
                title: 'Order Received!',
                subtitle: 'Your airtime order is pending manual fulfillment and will be sent shortly by the shop team.',
                statusColor: 'text-amber-600',
            }
        }
        if (isPending) {
            return {
                iconBg: '',
                Icon: CheckCircle2,
                title: 'Payment Successful!',
                subtitle: 'Your data bundle is being processed and will be delivered shortly.',
                statusColor: 'text-blue-600',
            }
        }
        return {
            iconBg: '',
            Icon: CheckCircle2,
            title: 'Payment Successful!',
            subtitle: 'Your data bundle has been delivered successfully.',
            statusColor: 'text-emerald-600',
        }
    })()

    const orderNoun = isAfa ? 'AFA registration' : isRc ? 'results checker voucher' : isAirtime ? 'airtime' : 'data'
    const whatsappText = isFailed
        ? `Hi! I had an issue with my ${orderNoun} order. Reference: ${ref || ''}. Please help.`
        : isAfa
            ? `Hi! I just submitted an AFA registration through your shop. Reference: ${ref || ''}`
            : `Hi! I just bought ${orderNoun} from your shop. Reference: ${ref || ''}`

    return (
        <div className="min-h-screen flex flex-col">
            {/* Header */}
            <div className="py-6 px-4" style={{ backgroundColor: brandColor } as any}>
                <div className="max-w-md mx-auto flex items-center gap-3">
                    {shop?.logo_url && (
                        <div className="relative w-10 h-10 rounded-xl overflow-hidden bg-white/20">
                            <Image src={shop.logo_url} alt={shop.shop_name || ''} fill className="object-contain" />
                        </div>
                    )}
                    <h1 className="text-white font-bold">{shop?.shop_name || shopSlug}</h1>
                </div>
            </div>

            <div className="flex-1 flex items-center justify-center px-4 py-12">
                <div className="max-w-md w-full text-center space-y-6">
                    {/* Hero icon — status aware */}
                    <div className="flex justify-center">
                        {isFailed ? (
                            <div className="w-20 h-20 rounded-full flex items-center justify-center shadow-lg bg-red-500">
                                <heroConfig.Icon className="w-10 h-10 text-white" />
                            </div>
                        ) : isAirtime ? (
                            <div className="w-20 h-20 rounded-full flex items-center justify-center shadow-lg bg-amber-500">
                                <heroConfig.Icon className="w-10 h-10 text-white" />
                            </div>
                        ) : (
                            <div className="w-20 h-20 rounded-full flex items-center justify-center shadow-lg" style={{ backgroundColor: brandColor } as any}>
                                <heroConfig.Icon className="w-10 h-10 text-white" />
                            </div>
                        )}
                    </div>

                    <div>
                        <h2 className="text-2xl font-black text-gray-900 dark:text-white">{heroConfig.title}</h2>
                        <p className="text-muted-foreground mt-2 text-sm">{heroConfig.subtitle}</p>
                    </div>

                    {/* Airtime pending notice */}
                    {isAirtime && !isFailed && (
                        <div className="flex items-start gap-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-xl p-4 text-left">
                            <Clock className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                            <p className="text-xs text-amber-700 dark:text-amber-400 font-medium leading-relaxed">
                                Airtime orders are fulfilled manually by the shop team. You will receive your airtime within a few minutes to an hour. If it takes longer, contact the shop on WhatsApp.
                            </p>
                        </div>
                    )}

                    {/* Failed notice */}
                    {isFailed && (
                        <div className="flex items-start gap-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl p-4 text-left">
                            <XCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
                            <p className="text-xs text-red-700 dark:text-red-400 font-medium leading-relaxed">
                                Please contact the shop owner on WhatsApp with your reference code to resolve this issue. Do not attempt to repurchase until you have spoken to the shop team.
                            </p>
                        </div>
                    )}

                    {/* RC Vouchers Delivery */}
                    {isRc && !isFailed && !isPending && rcVouchers.length > 0 && (
                        <div className="space-y-3">
                            <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-xl p-3 mb-4">
                                <p className="text-xs text-amber-700 dark:text-amber-400 font-medium text-center">
                                    ⚠️ Please copy and save your PIN and Serial Number now.
                                </p>
                            </div>
                            {rcVouchers.map((v, i) => (
                                <div key={i} className="bg-white dark:bg-gray-800 rounded-xl p-4 border border-emerald-200 dark:border-emerald-800 shadow-sm space-y-3 text-left">
                                    {rcVouchers.length > 1 && (
                                        <p className="text-[10px] font-black text-gray-400 uppercase tracking-wider">Voucher {i + 1}</p>
                                    )}
                                    <div className="space-y-3">
                                        <div>
                                            <p className="text-[10px] font-black text-gray-400 uppercase tracking-wider mb-1">PIN</p>
                                            <div className="flex items-center justify-between bg-gray-50 dark:bg-gray-900 rounded-lg px-3 py-2 border border-gray-100 dark:border-gray-700">
                                                <span className="font-mono text-lg font-black text-gray-900 dark:text-white tracking-widest">{v.pin}</span>
                                                <CopyButton text={v.pin} />
                                            </div>
                                        </div>
                                        <div>
                                            <p className="text-[10px] font-black text-gray-400 uppercase tracking-wider mb-1">Serial Number</p>
                                            <div className="flex items-center justify-between bg-gray-50 dark:bg-gray-900 rounded-lg px-3 py-2 border border-gray-100 dark:border-gray-700">
                                                <span className="font-mono text-base font-black text-gray-900 dark:text-white tracking-widest">{v.serial_number}</span>
                                                <CopyButton text={v.serial_number} />
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}

                    {/* Order summary */}
                    {order && (
                        <div className="bg-white dark:bg-gray-800 rounded-2xl border border-gray-200 dark:border-gray-700 p-5 text-left space-y-3">
                            <h3 className="font-bold text-sm text-gray-900 dark:text-white">Order Summary</h3>
                            <div className="space-y-2 text-sm">
                                <div className="flex justify-between">
                                    <span className="text-muted-foreground">Package</span>
                                    <span className="font-semibold">
                                        {isAirtime ? `${order.network} GHS ${parseFloat(order.selling_price).toFixed(2)} Airtime` : `${order.network} ${order.package_size}`}
                                    </span>
                                </div>
                                <div className="flex justify-between">
                                    <span className="text-muted-foreground">Recipient</span>
                                    <span className="font-mono font-semibold">{order.guest_phone}</span>
                                </div>
                                <div className="flex justify-between items-center">
                                    <span className="text-muted-foreground">{isAirtime ? 'Airtime Value' : 'Amount Paid'}</span>
                                    <span className="font-bold" style={{ color: brandColor } as any}>
                                        GHS {parseFloat(order.selling_price).toFixed(2)}
                                    </span>
                                </div>
                                <div className="flex justify-between">
                                    <span className="text-muted-foreground">Status</span>
                                    <span className={`font-semibold capitalize ${heroConfig.statusColor}`}>{orderStatus}</span>
                                </div>
                                {ref && (
                                    <div className="flex justify-between items-center pt-2 border-t">
                                        <span className="text-muted-foreground text-xs">Reference</span>
                                        <div className="flex items-center gap-1.5 bg-gray-50 dark:bg-gray-900 px-2 py-1 rounded-md border border-gray-100 dark:border-gray-800">
                                            <span className="font-mono text-[11px] text-gray-500 font-medium">
                                                {ref.length > 20 ? `SHOP-...${ref.slice(-8)}` : ref}
                                            </span>
                                            <CopyButton text={ref} />
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>
                    )}

                    {/* Actions */}
                    <div className="flex flex-col gap-3">
                        {!isFailed && (
                            <Link
                                href={`/shop/${shopSlug}`}
                                className="flex items-center justify-center gap-2 py-3 rounded-xl text-white font-bold transition-all hover:opacity-90"
                                style={{ backgroundColor: brandColor } as any}
                            >
                                <ShoppingCart className="w-4 h-4" />
                                {isAirtime ? 'Buy More Airtime' : 'Buy More Data'}
                            </Link>
                        )}

                        {isFailed && (
                            <Link
                                href={`/shop/${shopSlug}`}
                                className="flex items-center justify-center gap-2 py-3 rounded-xl border-2 border-gray-300 text-gray-700 dark:text-gray-300 font-bold transition-all hover:bg-gray-100 dark:hover:bg-gray-800"
                            >
                                <RefreshCw className="w-4 h-4" />
                                Try Again
                            </Link>
                        )}

                        {shop?.whatsapp_number && (
                            <a
                                href={`https://wa.me/${shop.whatsapp_number}?text=${encodeURIComponent(whatsappText)}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="flex items-center justify-center gap-2 py-3 rounded-xl bg-[#25D366] text-white font-bold transition-all hover:opacity-90"
                            >
                                <svg viewBox="0 0 24 24" className="w-4 h-4 fill-white" xmlns="http://www.w3.org/2000/svg">
                                    <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.008-.57-.008-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.88 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
                                </svg>
                                {isFailed ? 'Contact Shop — Get Help' : 'Contact Shop on WhatsApp'}
                            </a>
                        )}
                    </div>
                </div>
            </div>
        </div>
    )
}
