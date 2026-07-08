'use client'

import { useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import {
    ArrowLeft,
    MoreVertical,
    Flag,
    MessageSquare,
    Phone,
    Star,
    BadgeCheck,
    Clock,
    ShieldCheck,
    Mail,
} from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * PublicProfileScreen — view another seller's marketplace profile (Jiji/OLX style).
 *
 * Presentational + dummy data. Shapes mirror likely real sources so wiring is a
 * swap:
 *   - seller  → the `classified_sellers_public` view (id, first_name, last_name,
 *     seller_verified_at) + users.phone_verified + a future reviews aggregate.
 *   - listings → getSellerListings(sellerId, 'active') over classified_listings.
 *   - reviews  → a future classified_reviews table (none exists yet).
 * Message/Call/Report are callbacks (sensible toast defaults).
 */

const BRAND_GREEN = '#00A652'

export interface PublicSeller {
    id: string
    name: string
    avatar_url?: string | null
    phone_verified?: boolean
    email_verified?: boolean
    id_verified?: boolean // seller_verified_at present
    joined_at?: string // ISO
    rating_avg?: number
    rating_count?: number
    response_time?: string // e.g. "Usually responds within an hour"
    stats?: { active: number; sold: number; followers?: number }
}

export interface SellerListing {
    id: string
    title: string
    price: number
    image_url?: string | null
    location?: string
    available?: boolean
}

export interface SellerReview {
    id: string
    author_name: string
    rating: number // 1..5
    text: string
    created_at: string // ISO
}

interface PublicProfileScreenProps {
    seller?: PublicSeller
    listings?: SellerListing[]
    reviews?: SellerReview[]
    onBack?: () => void
    onMessage?: () => void
    onCall?: () => void
    onReport?: () => void
    onOpenListing?: (id: string) => void
}

// ── Dummy data ─────────────────────────────────────────────────────────────
const DUMMY_SELLER: PublicSeller = {
    id: 'u1',
    name: 'Kwame Mensah',
    avatar_url: '',
    phone_verified: true,
    email_verified: true,
    id_verified: true,
    joined_at: '2023-03-01T00:00:00Z',
    rating_avg: 4.8,
    rating_count: 32,
    response_time: 'Usually responds within an hour',
    stats: { active: 12, sold: 47, followers: 128 },
}

const DUMMY_LISTINGS: SellerListing[] = [
    { id: 'l1', title: 'Toyota Corolla 2018 · Clean', price: 125000, location: 'East Legon', image_url: 'https://images.unsplash.com/photo-1621007947382-bb3c3994e3fb?auto=format&fit=crop&w=500&q=60', available: true },
    { id: 'l2', title: 'iPhone 13 Pro Max 256GB', price: 6200, location: 'Kumasi', image_url: 'https://images.unsplash.com/photo-1511707171634-5f897ff02aa9?auto=format&fit=crop&w=500&q=60', available: true },
    { id: 'l4', title: 'HP EliteBook 840 G5', price: 3200, location: 'Takoradi', image_url: 'https://images.unsplash.com/photo-1496181133206-80ce9b88a853?auto=format&fit=crop&w=500&q=60', available: true },
    { id: 'l5', title: 'Samsung 55" 4K Smart TV', price: 4500, location: 'Osu', image_url: 'https://images.unsplash.com/photo-1593359677879-a4bb92f829d1?auto=format&fit=crop&w=500&q=60', available: true },
]

const DUMMY_REVIEWS: SellerReview[] = [
    { id: 'r1', author_name: 'Ama Owusu', rating: 5, text: 'Very responsive and honest. The item was exactly as described. Highly recommend!', created_at: '2024-06-10T00:00:00Z' },
    { id: 'r2', author_name: 'Yaw Boateng', rating: 5, text: 'Smooth transaction, met at a safe place. Would buy again.', created_at: '2024-05-22T00:00:00Z' },
    { id: 'r3', author_name: 'Efua Sarpong', rating: 4, text: 'Good seller, slight delay in replying but everything went fine.', created_at: '2024-04-15T00:00:00Z' },
]

const cedis = (price: number) => `GH₵ ${Number(price).toLocaleString()}`

function initials(name: string): string {
    return name.trim().split(/\s+/).slice(0, 2).map((n) => n[0]?.toUpperCase() ?? '').join('') || '?'
}

function memberSince(iso?: string): string {
    if (!iso) return ''
    return `Joined ${new Date(iso).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}`
}

function reviewDate(iso: string): string {
    return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

function Stars({ value, className }: { value: number; className?: string }) {
    return (
        <span className={cn('inline-flex', className)}>
            {[1, 2, 3, 4, 5].map((i) => (
                <Star
                    key={i}
                    className="h-3.5 w-3.5"
                    style={{ color: i <= Math.round(value) ? '#F59E0B' : undefined }}
                    fill={i <= Math.round(value) ? '#F59E0B' : 'none'}
                    stroke={i <= Math.round(value) ? '#F59E0B' : 'currentColor'}
                />
            ))}
        </span>
    )
}

export function PublicProfileScreen({
    seller = DUMMY_SELLER,
    listings = DUMMY_LISTINGS,
    reviews = DUMMY_REVIEWS,
    onBack,
    onMessage,
    onCall,
    onReport,
    onOpenListing,
}: PublicProfileScreenProps) {
    const [tab, setTab] = useState<'ads' | 'reviews'>('ads')
    const [menuOpen, setMenuOpen] = useState(false)

    const handleMessage = () => (onMessage ? onMessage() : toast('Opening chat…'))
    const handleCall = () => (onCall ? onCall() : toast('Revealing phone number…'))
    const handleReport = () => {
        setMenuOpen(false)
        if (onReport) onReport()
        else toast('Reported. Our team will review this seller.')
    }

    return (
        <div className="mx-auto min-h-screen max-w-[480px] bg-white dark:bg-[#0a0f1c]">
            {/* Top bar */}
            <header className="sticky top-0 z-20 flex items-center justify-between border-b border-gray-100 bg-white/95 px-2 py-2.5 backdrop-blur dark:border-gray-800 dark:bg-[#0a0f1c]/95">
                <button
                    type="button"
                    onClick={onBack}
                    aria-label="Back"
                    className="flex h-9 w-9 items-center justify-center rounded-full text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-white/10"
                >
                    <ArrowLeft className="h-5 w-5" />
                </button>
                <span className="text-sm font-bold text-gray-900 dark:text-white">Seller profile</span>
                <div className="relative">
                    <button
                        type="button"
                        onClick={() => setMenuOpen((o) => !o)}
                        aria-label="More options"
                        aria-expanded={menuOpen}
                        className="flex h-9 w-9 items-center justify-center rounded-full text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-white/10"
                    >
                        <MoreVertical className="h-5 w-5" />
                    </button>
                    {menuOpen && (
                        <>
                            <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
                            <div className="absolute right-0 top-10 z-20 w-44 overflow-hidden rounded-xl border border-gray-100 bg-white shadow-lg dark:border-gray-800 dark:bg-[#151c2c]">
                                <button
                                    type="button"
                                    onClick={handleReport}
                                    className="flex w-full items-center gap-2 px-4 py-3 text-sm font-medium text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20"
                                >
                                    <Flag className="h-4 w-4" />
                                    Report user
                                </button>
                            </div>
                        </>
                    )}
                </div>
            </header>

            {/* Profile header */}
            <div className="px-4 pt-5">
                <div className="flex flex-col items-center text-center">
                    {seller.avatar_url ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={seller.avatar_url} alt={seller.name} className="h-20 w-20 rounded-full object-cover" />
                    ) : (
                        <span className="flex h-20 w-20 items-center justify-center rounded-full bg-emerald-100 text-2xl font-black text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300">
                            {initials(seller.name)}
                        </span>
                    )}
                    <h1 className="mt-3 text-xl font-black text-gray-900 dark:text-white">{seller.name}</h1>

                    {/* Rating */}
                    {seller.rating_count ? (
                        <button
                            type="button"
                            onClick={() => setTab('reviews')}
                            className="mt-1 flex items-center gap-1.5 text-sm"
                        >
                            <Star className="h-4 w-4" style={{ color: '#F59E0B' }} fill="#F59E0B" />
                            <span className="font-bold text-gray-900 dark:text-white">
                                {seller.rating_avg?.toFixed(1)}
                            </span>
                            <span className="text-gray-500 dark:text-gray-400">
                                ({seller.rating_count} reviews)
                            </span>
                        </button>
                    ) : null}

                    {/* Verification badges */}
                    <div className="mt-2 flex flex-wrap items-center justify-center gap-1.5">
                        {seller.id_verified && <Badge icon={ShieldCheck} label="ID Verified" />}
                        {seller.phone_verified && <Badge icon={BadgeCheck} label="Phone Verified" />}
                        {seller.email_verified && <Badge icon={Mail} label="Email Verified" />}
                    </div>

                    {/* Member since + response time */}
                    {seller.joined_at && (
                        <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">{memberSince(seller.joined_at)}</p>
                    )}
                    {seller.response_time && (
                        <p className="mt-1 flex items-center gap-1 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                            <Clock className="h-3.5 w-3.5" />
                            {seller.response_time}
                        </p>
                    )}
                </div>

                {/* Action buttons */}
                <div className="mt-4 flex gap-2">
                    <button
                        type="button"
                        onClick={handleMessage}
                        className="flex h-11 flex-1 items-center justify-center gap-2 rounded-xl text-sm font-bold text-white transition-transform active:scale-95"
                        style={{ backgroundColor: BRAND_GREEN }}
                    >
                        <MessageSquare className="h-4 w-4" />
                        Message
                    </button>
                    <button
                        type="button"
                        onClick={handleCall}
                        className="flex h-11 flex-1 items-center justify-center gap-2 rounded-xl border border-gray-200 text-sm font-bold text-gray-800 transition-transform active:scale-95 dark:border-gray-700 dark:text-gray-200"
                    >
                        <Phone className="h-4 w-4" />
                        Call
                    </button>
                </div>

                {/* Stats row */}
                {seller.stats && (
                    <div className="mt-4 grid grid-cols-3 divide-x divide-gray-100 rounded-2xl border border-gray-100 dark:divide-gray-800 dark:border-gray-800">
                        <Stat label="Active Ads" value={seller.stats.active} onClick={() => setTab('ads')} />
                        <Stat label="Sold" value={seller.stats.sold} />
                        <Stat
                            label="Rating"
                            value={`${seller.rating_avg?.toFixed(1) ?? '—'} ★`}
                            onClick={() => setTab('reviews')}
                        />
                    </div>
                )}
            </div>

            {/* Tabs */}
            <div className="mt-5 flex border-b border-gray-100 px-4 dark:border-gray-800">
                {(['ads', 'reviews'] as const).map((t) => (
                    <button
                        key={t}
                        type="button"
                        onClick={() => setTab(t)}
                        className={cn(
                            'relative flex-1 pb-3 pt-1 text-sm font-bold transition-colors',
                            tab === t ? 'text-gray-900 dark:text-white' : 'text-gray-400'
                        )}
                    >
                        {t === 'ads' ? `Active Ads (${listings.length})` : `Reviews (${reviews.length})`}
                        {tab === t && (
                            <span
                                className="absolute inset-x-0 bottom-0 h-0.5 rounded-full"
                                style={{ backgroundColor: BRAND_GREEN }}
                            />
                        )}
                    </button>
                ))}
            </div>

            {/* Tab content */}
            <div className="px-4 py-4">
                {tab === 'ads' ? (
                    listings.length === 0 ? (
                        <EmptyTab text="This seller has no active ads." />
                    ) : (
                        <div className="grid grid-cols-2 gap-3">
                            {listings.map((l) => (
                                <Link
                                    key={l.id}
                                    href={`/classifieds/${l.id}`}
                                    onClick={(e) => {
                                        if (onOpenListing) {
                                            e.preventDefault()
                                            onOpenListing(l.id)
                                        }
                                    }}
                                    className="overflow-hidden rounded-2xl border border-gray-100 bg-white dark:border-gray-800 dark:bg-[#151c2c]"
                                >
                                    <div className="aspect-square bg-gray-100 dark:bg-white/5">
                                        {l.image_url && (
                                            // eslint-disable-next-line @next/next/no-img-element
                                            <img src={l.image_url} alt={l.title} className="h-full w-full object-cover" />
                                        )}
                                    </div>
                                    <div className="p-2.5">
                                        <p className="text-sm font-black text-emerald-600 dark:text-emerald-400">{cedis(l.price)}</p>
                                        <h3 className="mt-0.5 line-clamp-2 text-[13px] font-medium text-gray-900 dark:text-white">
                                            {l.title}
                                        </h3>
                                        {l.location && (
                                            <p className="mt-1 truncate text-[11px] text-gray-400">{l.location}</p>
                                        )}
                                    </div>
                                </Link>
                            ))}
                        </div>
                    )
                ) : reviews.length === 0 ? (
                    <EmptyTab text="No reviews yet." />
                ) : (
                    <div className="flex flex-col gap-3">
                        {reviews.map((r) => (
                            <div
                                key={r.id}
                                className="rounded-2xl border border-gray-100 p-4 dark:border-gray-800"
                            >
                                <div className="flex items-center gap-3">
                                    <span className="flex h-9 w-9 items-center justify-center rounded-full bg-gray-100 text-xs font-bold text-gray-600 dark:bg-white/10 dark:text-gray-300">
                                        {initials(r.author_name)}
                                    </span>
                                    <div className="flex-1">
                                        <p className="text-sm font-bold text-gray-900 dark:text-white">{r.author_name}</p>
                                        <div className="flex items-center gap-2">
                                            <Stars value={r.rating} className="text-gray-300" />
                                            <span className="text-[11px] text-gray-400">{reviewDate(r.created_at)}</span>
                                        </div>
                                    </div>
                                </div>
                                <p className="mt-2.5 text-sm text-gray-600 dark:text-gray-300">{r.text}</p>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    )
}

function Badge({ icon: Icon, label }: { icon: typeof BadgeCheck; label: string }) {
    return (
        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700 dark:bg-emerald-900/25 dark:text-emerald-300">
            <Icon className="h-3.5 w-3.5" />
            {label}
        </span>
    )
}

function Stat({
    label,
    value,
    onClick,
}: {
    label: string
    value: string | number
    onClick?: () => void
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={!onClick}
            className={cn('flex flex-col items-center py-3', onClick && 'active:bg-gray-50 dark:active:bg-white/5')}
        >
            <span className="text-lg font-black text-gray-900 dark:text-white">{value}</span>
            <span className="text-[11px] text-gray-500 dark:text-gray-400">{label}</span>
        </button>
    )
}

function EmptyTab({ text }: { text: string }) {
    return <p className="py-12 text-center text-sm text-gray-500 dark:text-gray-400">{text}</p>
}

export default PublicProfileScreen
