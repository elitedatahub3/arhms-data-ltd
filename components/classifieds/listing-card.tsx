'use client'

import Image from 'next/image'
import Link from 'next/link'
import { Heart, BadgeCheck, ImageIcon, MapPin, Flame } from 'lucide-react'
import { cn } from '@/lib/utils'
import { getListingTier, isPopular, conditionLabel } from '@/lib/classifieds-tiers'
import type { ClassifiedListing, ClassifiedListingImage } from '@/types/supabase'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const STORAGE_BUCKET = 'classified-listing-images'

function getImagePublicUrl(storagePath: string): string {
    return `${SUPABASE_URL}/storage/v1/object/public/${STORAGE_BUCKET}/${storagePath}`
}

interface ListingCardProps {
    listing: ClassifiedListing & {
        classified_categories?: { name: string; slug: string }
        classified_listing_images?: Pick<ClassifiedListingImage, 'id' | 'storage_path' | 'display_order'>[]
        users?: { seller_verified_at?: string | null }
    }
    isFavorited?: boolean
    onFavoriteToggle?: (listingId: string) => void
}

export function ListingCard({ listing, isFavorited, onFavoriteToggle }: ListingCardProps) {
    // Sort images by display_order and pick the first one
    const images = [...(listing.classified_listing_images || [])].sort(
        (a, b) => (a.display_order ?? 0) - (b.display_order ?? 0)
    )
    const coverImage = images[0]
    const coverUrl = coverImage ? getImagePublicUrl(coverImage.storage_path) : null

    const tier = getListingTier(listing)
    const verified = Boolean(listing.users?.seller_verified_at)
    const popular = isPopular(listing)
    const condition = conditionLabel(listing.condition)

    return (
        <Link href={`/classifieds/${listing.id}`}>
            <div
                className={cn(
                    'group bg-white dark:bg-[#151c2c] rounded-xl overflow-hidden border-2 hover:shadow-lg transition-all duration-300 cursor-pointer h-full flex flex-col',
                    tier ? tier.borderClass : 'border-gray-100 dark:border-gray-800 hover:border-gray-200 dark:hover:border-gray-700'
                )}
            >
                {/* Image */}
                <div className="relative w-full aspect-square bg-gray-100 dark:bg-gray-800 overflow-hidden">
                    {coverUrl ? (
                        <Image
                            src={coverUrl}
                            alt={listing.title}
                            fill
                            sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 25vw"
                            className="object-cover transition-transform duration-300 group-hover:scale-105"
                            onError={(e) => {
                                const target = e.target as HTMLImageElement
                                target.style.display = 'none'
                                target.parentElement?.querySelector('.img-fallback')?.removeAttribute('style')
                            }}
                        />
                    ) : null}

                    {/* Placeholder — shown when no image or image fails to load */}
                    <div
                        className={cn(
                            'img-fallback w-full h-full bg-gradient-to-br from-gray-200 to-gray-300 dark:from-gray-700 dark:to-gray-800 flex flex-col items-center justify-center text-gray-400 gap-2',
                            coverUrl && 'hidden'
                        )}
                    >
                        <ImageIcon className="w-8 h-8 opacity-50" />
                        <span className="text-xs font-medium">No image</span>
                    </div>

                    {/* Tier ribbon — vertical strip on the left edge */}
                    {tier && (
                        <div
                            className={cn(
                                'absolute top-0 left-0 z-10 px-1 py-2 text-[10px] font-black tracking-widest rounded-br-md shadow-sm',
                                tier.ribbonClass
                            )}
                            style={{ writingMode: 'vertical-rl' }}
                        >
                            {tier.label}
                        </div>
                    )}

                    {/* Trust badges — stacked top-right */}
                    <div className="absolute top-2 right-2 z-10 flex flex-col items-end gap-1">
                        {verified && (
                            <span className="inline-flex items-center gap-1 rounded-full bg-white/90 dark:bg-gray-900/85 backdrop-blur px-2 py-0.5 text-[10px] font-bold text-gray-800 dark:text-gray-100 shadow-sm">
                                <BadgeCheck className="w-3.5 h-3.5 text-sky-600" />
                                Verified ID
                            </span>
                        )}
                        {popular && (
                            <span className="inline-flex items-center gap-1 rounded-full bg-white/90 dark:bg-gray-900/85 backdrop-blur px-2 py-0.5 text-[10px] font-bold text-gray-800 dark:text-gray-100 shadow-sm">
                                <Flame className="w-3.5 h-3.5 text-orange-500" />
                                POPULAR
                            </span>
                        )}
                    </div>

                    {/* Multi-image count badge */}
                    {images.length > 1 && (
                        <div className="absolute bottom-2 right-2 z-10 bg-black/60 text-white text-xs font-bold px-2 py-0.5 rounded-full flex items-center gap-1">
                            <ImageIcon className="w-3 h-3" />
                            {images.length}
                        </div>
                    )}

                    {/* Favorite button — bottom-left to avoid the trust badges */}
                    <button
                        title="Toggle favorite"
                        aria-label="Toggle favorite"
                        onClick={(e) => {
                            e.preventDefault()
                            onFavoriteToggle?.(listing.id)
                        }}
                        className={cn(
                            'absolute bottom-2 left-2 z-10 rounded-full p-2 transition-all',
                            isFavorited
                                ? 'bg-red-500 text-white'
                                : 'bg-white/80 dark:bg-gray-800/80 text-gray-500 hover:bg-white hover:text-red-500'
                        )}
                    >
                        <Heart className={cn('w-4 h-4', isFavorited && 'fill-current')} />
                    </button>
                </div>

                {/* Content */}
                <div className="flex-1 flex flex-col p-3">
                    {/* Price */}
                    <p className="text-base font-black text-emerald-600 dark:text-emerald-400 leading-tight">
                        GH₵ {Number(listing.price).toLocaleString()}
                    </p>

                    {/* Title */}
                    <h3 className="mt-1 font-semibold text-gray-900 dark:text-white text-sm line-clamp-2">
                        {listing.title}
                    </h3>

                    {/* Location */}
                    <p className="mt-1 flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400 truncate">
                        <MapPin className="w-3.5 h-3.5 shrink-0" />
                        <span className="truncate">{listing.location || 'Location not specified'}</span>
                    </p>

                    {/* Bottom row: condition pill + tier icon */}
                    <div className="mt-auto pt-2.5 flex items-center justify-between gap-2">
                        {condition ? (
                            <span className="text-[11px] font-semibold px-2 py-1 rounded-md bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300">
                                {condition}
                            </span>
                        ) : (
                            <span />
                        )}
                        {tier && (
                            <span className="inline-flex items-center justify-center rounded-md bg-gray-50 dark:bg-gray-800 p-1">
                                <tier.Icon className={cn('w-4 h-4', tier.iconClass)} />
                            </span>
                        )}
                    </div>
                </div>
            </div>
        </Link>
    )
}
