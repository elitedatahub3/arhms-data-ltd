import { Crown, Gem, Flame, type LucideIcon } from 'lucide-react'
import type { ClassifiedListing } from '@/types/supabase'

/**
 * Jiji-style presentation helpers for classified listing cards.
 *
 * The live classifieds system has no named prestige tiers — only `is_boosted`
 * plus a duration code (`boost_tier` = '7d'..'90d'). We DERIVE a display tier
 * from that duration so cards get the tiered VIP/DIAMOND look without any
 * schema change. Longer boost = higher tier (a visual proxy).
 */

export const POPULAR_THRESHOLD = 50

export interface ListingTier {
    key: 'top' | 'vip' | 'diamond'
    label: string
    Icon: LucideIcon
    /** ribbon background + text colour */
    ribbonClass: string
    /** card border colour */
    borderClass: string
    /** tier icon colour (for the bottom-row chip) */
    iconClass: string
}

const DIAMOND: ListingTier = {
    key: 'diamond',
    label: 'DIAMOND',
    Icon: Gem,
    ribbonClass: 'bg-teal-500 text-white',
    borderClass: 'border-teal-400 dark:border-teal-500',
    iconClass: 'text-teal-500',
}

const VIP: ListingTier = {
    key: 'vip',
    label: 'VIP',
    Icon: Crown,
    ribbonClass: 'bg-amber-400 text-amber-950',
    borderClass: 'border-amber-400',
    iconClass: 'text-amber-500',
}

const TOP: ListingTier = {
    key: 'top',
    label: 'TOP',
    Icon: Flame,
    ribbonClass: 'bg-blue-500 text-white',
    borderClass: 'border-blue-400 dark:border-blue-500',
    iconClass: 'text-blue-500',
}

type TierInput = Pick<ClassifiedListing, 'is_boosted' | 'boosted_until' | 'boost_tier'>

/** Returns the display tier for an actively-boosted listing, else null. */
export function getListingTier(listing: TierInput): ListingTier | null {
    const active = Boolean(
        listing.is_boosted &&
            listing.boosted_until &&
            new Date(listing.boosted_until) > new Date()
    )
    if (!active) return null

    switch (listing.boost_tier) {
        case '90d':
            return DIAMOND
        case '30d':
        case '60d':
            return VIP
        // '7d' | '14d' | '21d' and any boosted-but-unknown duration → TOP
        default:
            return TOP
    }
}

export function isPopular(listing: Pick<ClassifiedListing, 'view_count'>): boolean {
    return (listing.view_count ?? 0) >= POPULAR_THRESHOLD
}

const CONDITION_LABELS: Record<string, string> = {
    new: 'Brand New',
    'like-new': 'Like New',
    used: 'Used',
    refurbished: 'Refurbished',
}

export function conditionLabel(condition?: string | null): string {
    if (!condition) return ''
    return CONDITION_LABELS[condition] ?? condition
}
