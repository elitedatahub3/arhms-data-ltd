import { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { createServerClient } from '@/lib/supabase'
import Image from 'next/image'
import Link from 'next/link'
import { ArrowLeft, Phone, Mail, MessageCircle, MapPin, ShieldCheck, Clock, CheckCircle2, AlertTriangle, Users, BookOpen } from 'lucide-react'
import { CopyrightFooter } from '@/components/CopyrightFooter'

interface Props {
    params: Promise<{ shopSlug: string }>
}

export const revalidate = 3600 // Revalidate once an hour

export async function generateMetadata({ params }: Props): Promise<Metadata> {
    const { shopSlug } = await params
    const cleanSlug = shopSlug.trim()
    const supabaseAdmin = createServerClient()

    const { data: shop } = await (supabaseAdmin
        .from('shop_profiles')
        .select('shop_name, description')
        .ilike('shop_slug', cleanSlug)
        .eq('approval_status', 'approved')
        .eq('is_active', true)
        .single() as any)

    if (!shop) return { title: 'Not Found' }

    return {
        title: `About ${shop.shop_name}`,
        description: `Learn more about ${shop.shop_name} and our official terms of service.`,
    }
}

export default async function ShopAboutPage({ params }: Props) {
    const { shopSlug } = await params
    const cleanSlug = shopSlug.trim()
    const supabaseAdmin = createServerClient()

    const { data: shop } = await (supabaseAdmin
        .from('shop_profiles')
        .select('shop_name, description, owner_phone, owner_email, whatsapp_number, logo_url, community_link, brand_color, is_active, approval_status')
        .ilike('shop_slug', cleanSlug)
        .single() as any)

    if (!shop || shop.approval_status !== 'approved' || !shop.is_active) {
        notFound()
    }

    const { data: adminSettings } = await (supabaseAdmin
        .from('admin_settings')
        .select('key, value')
        .in('key', ['copyright_footer_enabled', 'copyright_footer_text', 'copyright_footer_link_url', 'copyright_footer_link_text']) as any)
        
    const settingsMap: Record<string, string> = {}
    for (const row of adminSettings || []) {
        settingsMap[row.key] = row.value
    }

    const brandColor = shop.brand_color || '#2563eb'
    const isValidHex = (color: string) => /^#([A-Fa-f0-9]{3}){1,4}$/.test(color)
    const safeBrandColor = isValidHex(brandColor) ? brandColor : '#2563eb'

    return (
        <div className="min-h-screen flex flex-col theme-shop pt-16">
            <style dangerouslySetInnerHTML={{ __html: `.theme-shop { --brand-color: ${safeBrandColor}; }` }} />

            {/* Permanent Header (Simplified) */}
            <div className="fixed top-0 left-0 w-full z-50 shadow-sm bg-[var(--brand-color)] h-14 flex items-center px-4">
                <div className="max-w-3xl mx-auto w-full flex items-center gap-3">
                    <Link href={`/shop/${shopSlug}`} className="p-1.5 bg-white/10 hover:bg-white/20 rounded-lg text-white transition-colors">
                        <ArrowLeft className="w-5 h-5" />
                    </Link>
                    <span className="text-white font-bold text-sm tracking-widest uppercase opacity-90">About Shop</span>
                </div>
            </div>

            <div className="flex-1 w-full max-w-3xl mx-auto px-4 py-8 space-y-8">
                {/* ── 1. Identity & Description ── */}
                <div className="bg-white dark:bg-gray-900 rounded-[2rem] p-6 sm:p-8 shadow-sm border border-gray-100 dark:border-gray-800 text-center relative overflow-hidden">
                    <div className="absolute top-0 left-0 w-full h-24 bg-[var(--brand-color)] opacity-10" />
                    <div className="relative z-10 flex flex-col items-center">
                        {shop.logo_url ? (
                            <div className="w-24 h-24 rounded-3xl overflow-hidden shadow-xl border-4 border-white dark:border-gray-800 mb-4 bg-white">
                                <Image src={shop.logo_url} alt="Logo" width={96} height={96} className="w-full h-full object-contain" />
                            </div>
                        ) : (
                            <div className="w-24 h-24 rounded-3xl shadow-xl border-4 border-white dark:border-gray-800 mb-4 bg-[var(--brand-color)] flex items-center justify-center text-white text-3xl font-black">
                                {shop.shop_name.charAt(0)}
                            </div>
                        )}
                        <h1 className="text-2xl font-black text-gray-900 dark:text-white capitalize">{shop.shop_name}</h1>
                        {shop.description && (
                            <p className="mt-3 text-sm font-medium text-gray-500 dark:text-gray-400 max-w-sm mx-auto leading-relaxed">
                                {shop.description}
                            </p>
                        )}
                    </div>
                </div>

                {/* ── 2. Official Contact Info ── */}
                <div className="bg-white dark:bg-gray-900 rounded-3xl p-6 shadow-sm border border-gray-100 dark:border-gray-800">
                    <div className="flex items-center gap-3 mb-6">
                        <div className="w-10 h-10 rounded-xl bg-blue-50 dark:bg-blue-900/20 flex items-center justify-center text-blue-600 dark:text-blue-400">
                            <Phone className="w-5 h-5" />
                        </div>
                        <h2 className="text-lg font-black text-gray-900 dark:text-white uppercase tracking-tighter">Contact & Support</h2>
                    </div>
                    
                    <div className="grid sm:grid-cols-2 gap-4">
                        <a href={`tel:${shop.owner_phone}`} className="flex items-center gap-4 p-4 rounded-2xl border border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors group">
                            <div className="w-10 h-10 rounded-full bg-gray-100 dark:bg-gray-800 flex items-center justify-center text-gray-500 group-hover:text-emerald-600 transition-colors">
                                <Phone className="w-5 h-5" />
                            </div>
                            <div>
                                <p className="text-[10px] font-black uppercase text-gray-400 tracking-widest">Phone Line</p>
                                <p className="text-sm font-bold text-gray-900 dark:text-gray-100">{shop.owner_phone}</p>
                            </div>
                        </a>
                        
                        {shop.whatsapp_number && (
                            <a href={`https://wa.me/${shop.whatsapp_number}`} target="_blank" rel="noopener noreferrer" className="flex items-center gap-4 p-4 rounded-2xl border border-emerald-100 dark:border-emerald-900/30 bg-emerald-50/50 dark:bg-emerald-950/20 hover:bg-emerald-50 dark:hover:bg-emerald-900/40 transition-colors group">
                                <div className="w-10 h-10 rounded-full bg-[#25D366]/20 flex items-center justify-center text-[#25D366]">
                                    <MessageCircle className="w-5 h-5" />
                                </div>
                                <div>
                                    <p className="text-[10px] font-black uppercase text-emerald-600/70 tracking-widest">WhatsApp Chat</p>
                                    <p className="text-sm font-bold text-emerald-900 dark:text-emerald-300">Tap to Message</p>
                                </div>
                            </a>
                        )}

                        {shop.owner_email && (
                            <a href={`mailto:${shop.owner_email}`} className="flex items-center gap-4 p-4 rounded-2xl border border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors group sm:col-span-2">
                                <div className="w-10 h-10 rounded-full bg-gray-100 dark:bg-gray-800 flex items-center justify-center text-gray-500 group-hover:text-blue-600 transition-colors">
                                    <Mail className="w-5 h-5" />
                                </div>
                                <div>
                                    <p className="text-[10px] font-black uppercase text-gray-400 tracking-widest">Support Email</p>
                                    <p className="text-sm font-bold text-gray-900 dark:text-gray-100">{shop.owner_email}</p>
                                </div>
                            </a>
                        )}
                    </div>
                </div>

                {/* ── 3. Community  ── */}
                {shop.community_link && (
                    <div className="bg-[var(--brand-color)] rounded-3xl p-6 sm:px-8 text-center sm:text-left sm:flex items-center justify-between shadow-md relative overflow-hidden">
                        <div className="absolute inset-0 opacity-10 bg-[url('https://www.transparenttextures.com/patterns/carbon-fibre.png')]" />
                        <div className="relative z-10 mb-5 sm:mb-0">
                            <h2 className="text-xl font-black text-white capitalize mb-1">Join Our Community</h2>
                            <p className="text-sm font-semibold text-white/80">Stay updated on the latest deals and network notices.</p>
                        </div>
                        <a href={shop.community_link} target="_blank" rel="noopener noreferrer" className="relative z-10 inline-flex items-center justify-center gap-2 px-6 py-3.5 rounded-xl bg-white text-gray-900 font-bold text-sm shadow-sm hover:scale-105 transition-transform">
                            <Users className="w-4 h-4 text-[var(--brand-color)]" /> Accept Invite
                        </a>
                    </div>
                )}

                {/* ── 4. Terms and Conditions ── */}
                <div className="bg-white dark:bg-gray-900 rounded-3xl p-6 shadow-sm border border-gray-100 dark:border-gray-800">
                    <div className="flex items-center gap-3 mb-6">
                        <div className="w-10 h-10 rounded-xl bg-purple-50 dark:bg-purple-900/20 flex items-center justify-center text-purple-600 dark:text-purple-400">
                            <BookOpen className="w-5 h-5" />
                        </div>
                        <h2 className="text-lg font-black text-gray-900 dark:text-white uppercase tracking-tighter">Terms & Conditions</h2>
                    </div>

                    <div className="space-y-6">
                        <div className="flex gap-4">
                            <div className="flex-shrink-0 mt-1">
                                <ShieldCheck className="w-5 h-5 text-emerald-500" />
                            </div>
                            <div>
                                <h3 className="text-sm font-black text-gray-900 dark:text-white mb-1">Instant, Non-Refundable Delivery</h3>
                                <p className="text-sm font-medium text-gray-500 dark:text-gray-400 leading-relaxed">
                                    All digital assets (Data and Airtime) are processed and transferred immediately upon successful payment. Once a transaction is completed and the asset is delivered, it cannot be reversed, recalled, or refunded under any circumstances.
                                </p>
                            </div>
                        </div>

                        <div className="flex gap-4">
                            <div className="flex-shrink-0 mt-1">
                                <AlertTriangle className="w-5 h-5 text-amber-500" />
                            </div>
                            <div>
                                <h3 className="text-sm font-black text-gray-900 dark:text-white mb-1">Buyer Accuracy Guarantee</h3>
                                <p className="text-sm font-medium text-gray-500 dark:text-gray-400 leading-relaxed">
                                    You (the customer) are solely responsible for ensuring that the recipient phone number and the selected telecommunications network are 100% accurate before clicking "Pay". We are not liable for items sent to an incorrect number due to user input errors.
                                </p>
                            </div>
                        </div>

                        <div className="flex gap-4">
                            <div className="flex-shrink-0 mt-1">
                                <Clock className="w-5 h-5 text-blue-500" />
                            </div>
                            <div>
                                <h3 className="text-sm font-black text-gray-900 dark:text-white mb-1">Processing Times & 24hr Reporting</h3>
                                <p className="text-sm font-medium text-gray-500 dark:text-gray-400 leading-relaxed">
                                    While 99% of transactions hit the entered number within seconds, telecommunications networks (MTN, Telecel, AT) may occasionally experience internal downtimes. 
                                    <strong className="text-gray-900 dark:text-white block mt-1">IMPORTANT: Customers must report any non-received orders to the shop owner within 24 hours of purchase. Failure to provide notification within this 24-hour window may result in the loss of eligibility for fulfillment, manual reversals, or refunds.</strong>
                                </p>
                            </div>
                        </div>

                        <div className="flex gap-4">
                            <div className="flex-shrink-0 mt-1">
                                <ShieldCheck className="w-5 h-5 text-purple-500" />
                            </div>
                            <div>
                                <h3 className="text-sm font-black text-gray-900 dark:text-white mb-1">Payment Verification & Stay-on-Page</h3>
                                <p className="text-sm font-medium text-gray-500 dark:text-gray-400 leading-relaxed text-blue-600 dark:text-blue-400 font-bold p-3 bg-blue-50/50 dark:bg-blue-900/10 rounded-xl border border-blue-100 dark:border-blue-900/30">
                                    To ensure your order is processed instantly, you <strong className="text-gray-900 dark:text-white underline">MUST NOT</strong> close the payment tab or leave the site until you see the final "Payment Successful" screen. 
                                    <span className="block mt-2 font-medium opacity-90">If you approve a payment manually on your phone, you must return to this site to trigger final verification. Failure to wait for this confirmation may result in fund loss or delayed fulfillment.</span>
                                </p>
                            </div>
                        </div>

                        <div className="flex gap-4">
                            <div className="flex-shrink-0 mt-1">
                                <CheckCircle2 className="w-5 h-5 text-gray-400" />
                            </div>
                            <div>
                                <h3 className="text-sm font-black text-gray-900 dark:text-white mb-1">Acceptance of Terms</h3>
                                <p className="text-sm font-medium text-gray-500 dark:text-gray-400 leading-relaxed">
                                    By using this storefront and initiating a purchase, you automatically accept these terms and conditions. If you do not agree to these precise conditions, you must exit the checkout page.
                                </p>
                            </div>
                        </div>
                    </div>
                </div>

                <div className="pb-10">
                    <CopyrightFooter 
                        variant="shop" 
                        shopName={shop.shop_name} 
                        adminSettings={settingsMap}
                        className="py-10"
                    />
                </div>
            </div>
        </div>
    )
}
