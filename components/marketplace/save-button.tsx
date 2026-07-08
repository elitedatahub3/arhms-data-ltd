'use client'

import { useState } from 'react'
import { Bookmark } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useSavedItems, type SavedListing } from './saved-items-context'

const BRAND_GREEN = '#00A652'

interface SaveButtonProps {
    /** The listing this button saves. Needs enough to render the SavedItemsScreen card. */
    listing: SavedListing
    /**
     * overlay = circular translucent bg for placing over a listing image (cards)
     * inline  = bare icon button for toolbars (listing detail header)
     */
    variant?: 'overlay' | 'inline'
    size?: 'sm' | 'md'
    className?: string
}

/**
 * Reusable save/bookmark toggle. Reads the global SavedItems store so its state
 * stays in sync everywhere (feed card ↔ detail page ↔ Saved screen). Optimistic
 * toggle + scale-bounce animation live here; persistence/undo live in the store.
 */
export function SaveButton({ listing, variant = 'overlay', size = 'md', className }: SaveButtonProps) {
    const { isSaved, toggle } = useSavedItems()
    const saved = isSaved(listing.id)
    const [pop, setPop] = useState(false)

    const iconSize = size === 'sm' ? 'h-4 w-4' : 'h-5 w-5'
    const box = size === 'sm' ? 'h-8 w-8' : 'h-9 w-9'

    const handle = (e: React.MouseEvent) => {
        e.preventDefault()
        e.stopPropagation()
        setPop(true)
        window.setTimeout(() => setPop(false), 180)
        void toggle(listing)
    }

    return (
        <button
            type="button"
            onClick={handle}
            aria-pressed={saved}
            aria-label={saved ? 'Remove from saved' : 'Save item'}
            className={cn(
                'flex items-center justify-center rounded-full transition-transform duration-150',
                box,
                pop && 'scale-125',
                variant === 'overlay'
                    ? 'bg-white/80 shadow-sm backdrop-blur hover:bg-white dark:bg-black/40 dark:hover:bg-black/60'
                    : 'hover:bg-gray-100 dark:hover:bg-white/10',
                className
            )}
        >
            <Bookmark
                className={cn(iconSize, 'transition-colors', !saved && 'text-gray-600 dark:text-gray-300')}
                style={saved ? { color: BRAND_GREEN, fill: BRAND_GREEN } : undefined}
                strokeWidth={2}
            />
        </button>
    )
}

export default SaveButton
