'use client'

import { SavedItemsProvider, type SavedListing } from '@/components/marketplace/saved-items-context'
import { SaveButton } from '@/components/marketplace/save-button'
import { SavedItemsScreen } from '@/components/marketplace/saved-items-screen'

/**
 * Preview harness for the Saved Items feature (dummy data + mock store).
 * Tapping a bookmark in the "feed" strip updates the Saved screen below in
 * real time — demonstrating the cross-screen sync. Delete once wired.
 */
const FEED: SavedListing[] = [
    { id: 'l5', title: 'Samsung 55" 4K Smart TV', price: 4500, location: 'Osu, Accra', created_at: new Date().toISOString(), image_url: 'https://images.unsplash.com/photo-1593359677879-a4bb92f829d1?auto=format&fit=crop&w=400&q=60', available: true },
    { id: 'l6', title: 'Office Desk + Chair set', price: 1200, location: 'Tema', created_at: new Date().toISOString(), image_url: 'https://images.unsplash.com/photo-1524758631624-e2822e304c36?auto=format&fit=crop&w=400&q=60', available: true },
    { id: 'l1', title: 'Toyota Corolla 2018', price: 125000, location: 'East Legon', created_at: new Date().toISOString(), image_url: 'https://images.unsplash.com/photo-1621007947382-bb3c3994e3fb?auto=format&fit=crop&w=400&q=60', available: true },
]

export default function SavedDemoPage() {
    return (
        <SavedItemsProvider>
            <div className="mx-auto max-w-[480px] px-4 pt-4">
                <h2 className="mb-2 text-sm font-bold text-gray-700 dark:text-gray-300">
                    Demo feed — tap the bookmark to save
                </h2>
                <div className="grid grid-cols-3 gap-2">
                    {FEED.map((l) => (
                        <div key={l.id} className="relative aspect-square overflow-hidden rounded-xl bg-gray-100 dark:bg-white/5">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={l.image_url ?? ''} alt={l.title} className="h-full w-full object-cover" />
                            <div className="absolute right-1.5 top-1.5">
                                <SaveButton listing={l} size="sm" />
                            </div>
                        </div>
                    ))}
                </div>
            </div>
            <SavedItemsScreen />
        </SavedItemsProvider>
    )
}
