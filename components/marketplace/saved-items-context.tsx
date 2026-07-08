'use client'

import { createContext, useContext, useState, useCallback, useMemo, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

/**
 * SavedItems store — global saved/wishlist state kept in sync across every
 * SaveButton and the SavedItemsScreen.
 *
 * MOCK backend: `mockApi` below simulates the network with latency and always
 * succeeds. To connect the REAL backend, replace the three mockApi calls with
 * the existing endpoints (they already exist):
 *   list   → GET    /api/classifieds/favorites            → { favorites: string[] }
 *   add    → POST   /api/classifieds/favorites  body { listing_id }   (Bearer token)
 *   remove → DELETE /api/classifieds/favorites?listing_id=<id>        (Bearer token)
 * and seed the initial state from the list call. Optimistic updates + rollback
 * are already wired here, so the swap is mechanical.
 */

export interface SavedListing {
    id: string
    title: string
    price: number // raw GH₵ (matches classified_listings.price)
    location?: string
    created_at?: string // ISO
    image_url?: string | null
    available?: boolean // false → "No longer available"
}

interface SavedItemsContextValue {
    savedIds: Set<string>
    savedItems: SavedListing[]
    count: number
    isSaved: (id: string) => boolean
    toggle: (listing: SavedListing) => Promise<void>
    remove: (id: string) => Promise<void>
    clearAll: () => Promise<void>
    isLoggedIn: boolean
}

const SavedItemsContext = createContext<SavedItemsContextValue | null>(null)

// ── Mock API (swap for /api/classifieds/favorites) ─────────────────────────
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const mockApi = {
    async add(_listingId: string) {
        await wait(250)
        // throw new Error('network') // ← uncomment to exercise rollback
    },
    async remove(_listingId: string) {
        await wait(250)
    },
}

// ── Dummy seed data ────────────────────────────────────────────────────────
const now = Date.now()
const iso = (daysAgo: number) => new Date(now - daysAgo * 86400000).toISOString()

const DUMMY_SAVED: SavedListing[] = [
    { id: 'l1', title: 'Toyota Corolla 2018 · Clean, one owner', price: 125000, location: 'East Legon, Accra', created_at: iso(1), image_url: 'https://images.unsplash.com/photo-1621007947382-bb3c3994e3fb?auto=format&fit=crop&w=500&q=60', available: true },
    { id: 'l2', title: 'iPhone 13 Pro Max 256GB', price: 6200, location: 'Kumasi', created_at: iso(3), image_url: 'https://images.unsplash.com/photo-1511707171634-5f897ff02aa9?auto=format&fit=crop&w=500&q=60', available: true },
    { id: 'l3', title: '2-Bedroom Apartment for rent', price: 2500, location: 'Spintex, Accra', created_at: iso(6), image_url: 'https://images.unsplash.com/photo-1568605114967-8130f3a36994?auto=format&fit=crop&w=500&q=60', available: false },
    { id: 'l4', title: 'HP EliteBook 840 G5 · i7', price: 3200, location: 'Takoradi', created_at: iso(9), image_url: 'https://images.unsplash.com/photo-1496181133206-80ce9b88a853?auto=format&fit=crop&w=500&q=60', available: true },
]

interface ProviderProps {
    children: ReactNode
    /** Simulate auth state. Real wiring: derive from useAuth(). */
    initialLoggedIn?: boolean
    /** Seed. Real wiring: hydrate from GET /api/classifieds/favorites. */
    initialItems?: SavedListing[]
}

export function SavedItemsProvider({
    children,
    initialLoggedIn = true,
    initialItems = DUMMY_SAVED,
}: ProviderProps) {
    const router = useRouter()
    const [items, setItems] = useState<SavedListing[]>(initialItems)
    const isLoggedIn = initialLoggedIn

    const savedIds = useMemo(() => new Set(items.map((i) => i.id)), [items])
    const isSaved = useCallback((id: string) => savedIds.has(id), [savedIds])

    const promptLogin = useCallback(() => {
        toast('Log in to save items', {
            action: { label: 'Log in', onClick: () => router.push('/classifieds/auth/login') },
        })
    }, [router])

    // Add with optimistic update + rollback + toast/undo.
    const add = useCallback(
        async (listing: SavedListing) => {
            setItems((prev) => (prev.some((i) => i.id === listing.id) ? prev : [listing, ...prev]))
            try {
                await mockApi.add(listing.id)
                toast('Saved to your list', {
                    action: { label: 'Undo', onClick: () => void remove(listing.id) },
                })
            } catch {
                setItems((prev) => prev.filter((i) => i.id !== listing.id)) // rollback
                toast.error("Couldn't save. Please try again.")
            }
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps
        []
    )

    // Remove with optimistic update + rollback.
    const remove = useCallback(async (id: string) => {
        let snapshot: SavedListing[] = []
        setItems((prev) => {
            snapshot = prev
            return prev.filter((i) => i.id !== id)
        })
        try {
            await mockApi.remove(id)
        } catch {
            setItems(snapshot) // rollback
            toast.error("Couldn't remove. Please try again.")
        }
    }, [])

    const toggle = useCallback(
        async (listing: SavedListing) => {
            if (!isLoggedIn) {
                promptLogin()
                return
            }
            if (savedIds.has(listing.id)) {
                await remove(listing.id)
            } else {
                await add(listing)
            }
        },
        [isLoggedIn, savedIds, promptLogin, add, remove]
    )

    const clearAll = useCallback(async () => {
        const snapshot = items
        setItems([])
        try {
            await Promise.all(snapshot.map((i) => mockApi.remove(i.id)))
            toast('Cleared your saved list')
        } catch {
            setItems(snapshot)
            toast.error("Couldn't clear. Please try again.")
        }
    }, [items])

    const value: SavedItemsContextValue = {
        savedIds,
        savedItems: items,
        count: items.length,
        isSaved,
        toggle,
        remove,
        clearAll,
        isLoggedIn,
    }

    return <SavedItemsContext.Provider value={value}>{children}</SavedItemsContext.Provider>
}

export function useSavedItems(): SavedItemsContextValue {
    const ctx = useContext(SavedItemsContext)
    if (!ctx) throw new Error('useSavedItems must be used within a SavedItemsProvider')
    return ctx
}
