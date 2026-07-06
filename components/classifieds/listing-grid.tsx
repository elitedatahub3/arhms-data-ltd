'use client'

import { ListingCard } from './listing-card'
import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ClassifiedListing } from '@/types/supabase'

interface ListingGridProps {
    listings: Array<ClassifiedListing & { classified_categories?: { name: string; slug: string } }>
    isLoading?: boolean
    onLoadMore?: () => void
    favorites?: string[]
    onFavoriteToggle?: (listingId: string) => void
    viewMode?: 'grid' | 'list'
}

export function ListingGrid({
    listings,
    isLoading,
    onLoadMore,
    favorites = [],
    onFavoriteToggle,
    viewMode = 'grid',
}: ListingGridProps) {
    if (isLoading && listings.length === 0) {
        return (
            <div className="flex items-center justify-center py-12">
                <div className="text-center">
                    <Loader2 className="w-8 h-8 text-emerald-600 dark:text-emerald-400 animate-spin mx-auto mb-2" />
                    <p className="text-sm font-medium text-gray-600 dark:text-gray-400">Loading listings...</p>
                </div>
            </div>
        )
    }

    if (listings.length === 0) {
        return (
            <div className="text-center py-12">
                <p className="text-gray-600 dark:text-gray-400 font-medium">No listings found</p>
                <p className="text-xs text-gray-500 dark:text-gray-500 mt-1">Try adjusting your filters</p>
            </div>
        )
    }

    return (
        <div className="space-y-6">
            <div
                className={cn(
                    'grid gap-3 sm:gap-4',
                    viewMode === 'list'
                        ? 'grid-cols-1 sm:grid-cols-2'
                        : 'grid-cols-2 md:grid-cols-3 lg:grid-cols-4'
                )}
            >
                {listings.map((listing) => (
                    <ListingCard
                        key={listing.id}
                        listing={listing}
                        isFavorited={favorites.includes(listing.id)}
                        onFavoriteToggle={onFavoriteToggle}
                    />
                ))}
            </div>

            {isLoading && (
                <div className="flex items-center justify-center py-4">
                    <Loader2 className="w-5 h-5 text-emerald-600 dark:text-emerald-400 animate-spin" />
                </div>
            )}
        </div>
    )
}
