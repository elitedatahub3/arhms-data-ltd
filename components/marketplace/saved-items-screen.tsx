'use client'

import { useState } from 'react'
import Link from 'next/link'
import { LayoutGrid, List, Bookmark, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useSavedItems, type SavedListing } from './saved-items-context'
import { SaveButton } from './save-button'

/**
 * SavedItemsScreen — the "Saved" tab. Reads the global SavedItems store, so
 * unsaving here (via the bookmark or long-press "Remove") instantly reflects on
 * every card and detail page. Grid/list toggle, count, clear-all, empty state.
 */

const cedis = (price: number) => `GH₵ ${Number(price).toLocaleString()}`

function postedAgo(iso?: string): string {
    if (!iso) return ''
    const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000)
    if (days <= 0) return 'Today'
    if (days === 1) return 'Yesterday'
    if (days < 30) return `${days}d ago`
    return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

export function SavedItemsScreen() {
    const { savedItems, count, clearAll, remove } = useSavedItems()
    const [view, setView] = useState<'grid' | 'list'>('grid')

    if (count === 0) {
        return (
            <div className="mx-auto flex min-h-screen max-w-[480px] flex-col bg-white dark:bg-[#0a0f1c]">
                <Header count={0} view={view} setView={setView} onClearAll={clearAll} />
                <div className="flex flex-1 flex-col items-center justify-center px-8 py-20 text-center">
                    <span className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-gray-100 dark:bg-white/5">
                        <Bookmark className="h-8 w-8 text-gray-400" />
                    </span>
                    <p className="text-base font-bold text-gray-900 dark:text-white">
                        You haven&apos;t saved anything yet
                    </p>
                    <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                        Tap the bookmark on any listing to keep it here.
                    </p>
                    <Link
                        href="/classifieds"
                        className="mt-6 rounded-full px-6 py-2.5 text-sm font-bold text-white"
                        style={{ backgroundColor: '#00A652' }}
                    >
                        Browse listings
                    </Link>
                </div>
            </div>
        )
    }

    return (
        <div className="mx-auto min-h-screen max-w-[480px] bg-white dark:bg-[#0a0f1c]">
            <Header count={count} view={view} setView={setView} onClearAll={clearAll} />
            <div className="px-4 py-4">
                {view === 'grid' ? (
                    <div className="grid grid-cols-2 gap-3">
                        {savedItems.map((item) => (
                            <GridCard key={item.id} item={item} onRemove={() => remove(item.id)} />
                        ))}
                    </div>
                ) : (
                    <div className="flex flex-col gap-3">
                        {savedItems.map((item) => (
                            <ListRow key={item.id} item={item} onRemove={() => remove(item.id)} />
                        ))}
                    </div>
                )}
            </div>
        </div>
    )
}

function Header({
    count,
    view,
    setView,
    onClearAll,
}: {
    count: number
    view: 'grid' | 'list'
    setView: (v: 'grid' | 'list') => void
    onClearAll: () => void
}) {
    return (
        <header className="sticky top-0 z-10 border-b border-gray-100 bg-white/95 px-4 py-3 backdrop-blur dark:border-gray-800 dark:bg-[#0a0f1c]/95">
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-xl font-black text-gray-900 dark:text-white">Saved Items</h1>
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                        {count} {count === 1 ? 'item' : 'items'}
                    </p>
                </div>
                <div className="flex items-center gap-1">
                    {count > 0 && (
                        <button
                            type="button"
                            onClick={onClearAll}
                            className="mr-1 rounded-full px-3 py-1.5 text-xs font-semibold text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20"
                        >
                            Clear all
                        </button>
                    )}
                    <ViewToggle view={view} setView={setView} />
                </div>
            </div>
        </header>
    )
}

function ViewToggle({ view, setView }: { view: 'grid' | 'list'; setView: (v: 'grid' | 'list') => void }) {
    return (
        <div className="flex rounded-full bg-gray-100 p-0.5 dark:bg-white/5">
            {(['grid', 'list'] as const).map((v) => {
                const Icon = v === 'grid' ? LayoutGrid : List
                return (
                    <button
                        key={v}
                        type="button"
                        onClick={() => setView(v)}
                        aria-label={`${v} view`}
                        aria-pressed={view === v}
                        className={cn(
                            'flex h-8 w-8 items-center justify-center rounded-full transition-colors',
                            view === v
                                ? 'bg-white text-gray-900 shadow-sm dark:bg-[#1e2637] dark:text-white'
                                : 'text-gray-400'
                        )}
                    >
                        <Icon className="h-4 w-4" />
                    </button>
                )
            })}
        </div>
    )
}

// Long-press (500ms) or right-click → remove from saved.
function longPress(onFire: () => void) {
    let t: ReturnType<typeof setTimeout> | null = null
    const start = () => {
        t = setTimeout(onFire, 500)
    }
    const clear = () => {
        if (t) clearTimeout(t)
        t = null
    }
    return { onPointerDown: start, onPointerUp: clear, onPointerLeave: clear, onPointerCancel: clear }
}

function UnavailableBadge() {
    return (
        <div className="absolute inset-0 flex items-center justify-center bg-black/50">
            <span className="rounded-md bg-white/90 px-2 py-1 text-[11px] font-bold text-gray-800">
                No longer available
            </span>
        </div>
    )
}

function GridCard({ item, onRemove }: { item: SavedListing; onRemove: () => void }) {
    return (
        <Link
            href={`/classifieds/${item.id}`}
            onContextMenu={(e) => {
                e.preventDefault()
                onRemove()
            }}
            {...longPress(onRemove)}
            className="group overflow-hidden rounded-2xl border border-gray-100 bg-white dark:border-gray-800 dark:bg-[#151c2c]"
        >
            <div className="relative aspect-square bg-gray-100 dark:bg-white/5">
                {item.image_url && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                        src={item.image_url}
                        alt={item.title}
                        className={cn('h-full w-full object-cover', item.available === false && 'opacity-60')}
                    />
                )}
                <div className="absolute right-2 top-2">
                    <SaveButton listing={item} size="sm" />
                </div>
                {item.available === false && <UnavailableBadge />}
            </div>
            <div className="p-2.5">
                <p className="text-sm font-black text-emerald-600 dark:text-emerald-400">{cedis(item.price)}</p>
                <h3 className="mt-0.5 line-clamp-2 text-[13px] font-medium text-gray-900 dark:text-white">
                    {item.title}
                </h3>
                <p className="mt-1 truncate text-[11px] text-gray-400">
                    {item.location} · {postedAgo(item.created_at)}
                </p>
            </div>
        </Link>
    )
}

function ListRow({ item, onRemove }: { item: SavedListing; onRemove: () => void }) {
    return (
        <Link
            href={`/classifieds/${item.id}`}
            onContextMenu={(e) => {
                e.preventDefault()
                onRemove()
            }}
            {...longPress(onRemove)}
            className="flex gap-3 overflow-hidden rounded-2xl border border-gray-100 bg-white p-2 dark:border-gray-800 dark:bg-[#151c2c]"
        >
            <div className="relative h-24 w-24 flex-shrink-0 overflow-hidden rounded-xl bg-gray-100 dark:bg-white/5">
                {item.image_url && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                        src={item.image_url}
                        alt={item.title}
                        className={cn('h-full w-full object-cover', item.available === false && 'opacity-60')}
                    />
                )}
                {item.available === false && <UnavailableBadge />}
            </div>
            <div className="flex min-w-0 flex-1 flex-col">
                <p className="text-base font-black text-emerald-600 dark:text-emerald-400">{cedis(item.price)}</p>
                <h3 className="mt-0.5 line-clamp-2 text-sm font-medium text-gray-900 dark:text-white">
                    {item.title}
                </h3>
                <p className="mt-auto truncate text-xs text-gray-400">
                    {item.location} · {postedAgo(item.created_at)}
                </p>
            </div>
            <div className="flex flex-col items-center justify-between py-1">
                <SaveButton listing={item} size="sm" variant="inline" />
                <button
                    type="button"
                    onClick={(e) => {
                        e.preventDefault()
                        onRemove()
                    }}
                    aria-label="Remove from saved"
                    className="flex h-8 w-8 items-center justify-center rounded-full text-gray-400 hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-900/20"
                >
                    <Trash2 className="h-4 w-4" />
                </button>
            </div>
        </Link>
    )
}

export default SavedItemsScreen
