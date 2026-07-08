'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { useAuth } from '@/contexts/auth-context'
import { supabase } from '@/lib/supabase'
import { ListingGrid } from '@/components/classifieds/listing-grid'
import { Button } from '@/components/ui/button'
import { Loader2, Bookmark } from 'lucide-react'
import type { ClassifiedListing } from '@/types/supabase'

/**
 * Saved / Favorites tab (bottom-nav "Saved").
 *
 * Fetches the signed-in buyer's favourite listing ids, hydrates each one via
 * the listing-detail endpoint, and renders them with the shared ListingGrid.
 * Mobile-first standalone page — no buyer sidebar — so the marketplace bottom
 * nav stays in charge of navigation.
 */
export default function FavoritesPage() {
    const { isLoading: authLoading } = useAuth()

    const [listings, setListings] = useState<ClassifiedListing[]>([])
    const [favorites, setFavorites] = useState<string[]>([])
    const [isLoading, setIsLoading] = useState(true)
    const [isAuthed, setIsAuthed] = useState<boolean | null>(null)

    const loadFavorites = useCallback(async () => {
        setIsLoading(true)
        try {
            const { data: { session } } = await supabase.auth.getSession()
            const token = session?.access_token

            if (!token) {
                setIsAuthed(false)
                setListings([])
                return
            }
            setIsAuthed(true)

            const favRes = await fetch('/api/classifieds/favorites', {
                headers: { Authorization: `Bearer ${token}` },
            })
            if (!favRes.ok) throw new Error('Failed to load favorites')

            const { favorites: ids }: { favorites: string[] } = await favRes.json()
            setFavorites(ids)

            // Hydrate each favourited id into a full listing (favourite lists are small).
            const results = await Promise.all(
                ids.map(async (id) => {
                    const res = await fetch(`/api/classifieds/listings/${id}`)
                    return res.ok ? ((await res.json()) as ClassifiedListing) : null
                })
            )
            setListings(results.filter((l): l is ClassifiedListing => l !== null))
        } catch (error) {
            console.error('Error loading favorites:', error)
            setListings([])
        } finally {
            setIsLoading(false)
        }
    }, [])

    useEffect(() => {
        loadFavorites()
    }, [loadFavorites])

    // Un-favouriting from the grid removes the card immediately.
    const handleFavoriteToggle = async (listingId: string) => {
        try {
            const { data: { session } } = await supabase.auth.getSession()
            const token = session?.access_token
            if (!token) return

            const res = await fetch(`/api/classifieds/favorites?listing_id=${listingId}`, {
                method: 'DELETE',
                headers: { Authorization: `Bearer ${token}` },
            })
            if (res.ok) {
                setFavorites((prev) => prev.filter((id) => id !== listingId))
                setListings((prev) => prev.filter((l) => l.id !== listingId))
            }
        } catch (error) {
            console.error('Error removing favorite:', error)
        }
    }

    return (
        <div className="mx-auto min-h-screen max-w-3xl px-4 py-6">
            <div className="mb-6 flex items-center gap-3">
                <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-emerald-50 dark:bg-emerald-900/20">
                    <Bookmark className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
                </span>
                <div>
                    <h1 className="text-2xl font-black text-gray-900 dark:text-white">Saved</h1>
                    <p className="text-sm text-gray-500 dark:text-gray-400">Your saved listings</p>
                </div>
            </div>

            {authLoading || isLoading ? (
                <div className="flex items-center justify-center py-16">
                    <Loader2 className="h-7 w-7 animate-spin text-emerald-600 dark:text-emerald-400" />
                </div>
            ) : isAuthed === false ? (
                <EmptyState
                    title="Log in to see your saved items"
                    body="Sign in and tap the bookmark on any listing to save it here."
                    cta={{ href: '/classifieds/auth/login?redirect=/classifieds/buyer/favorites', label: 'Log in' }}
                />
            ) : listings.length === 0 ? (
                <EmptyState
                    title="No saved items yet"
                    body="Browse the marketplace and save listings you love to find them here."
                    cta={{ href: '/classifieds', label: 'Browse listings' }}
                />
            ) : (
                <ListingGrid
                    listings={listings}
                    favorites={favorites}
                    onFavoriteToggle={handleFavoriteToggle}
                    viewMode="grid"
                />
            )}
        </div>
    )
}

function EmptyState({
    title,
    body,
    cta,
}: {
    title: string
    body: string
    cta: { href: string; label: string }
}) {
    return (
        <div className="rounded-2xl border border-gray-100 bg-white p-12 text-center dark:border-gray-800 dark:bg-[#151c2c]">
            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-emerald-50 dark:bg-emerald-900/20">
                <Bookmark className="h-7 w-7 text-emerald-600 dark:text-emerald-400" />
            </div>
            <h2 className="mb-2 text-xl font-bold text-gray-900 dark:text-white">{title}</h2>
            <p className="mx-auto mb-6 max-w-sm text-gray-600 dark:text-gray-400">{body}</p>
            <Link href={cta.href}>
                <Button className="bg-emerald-600 hover:bg-emerald-700">{cta.label}</Button>
            </Link>
        </div>
    )
}
