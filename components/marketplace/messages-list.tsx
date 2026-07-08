'use client'

import { useState } from 'react'
import { Search, MessageSquare, Trash2, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * MessagesList — Jiji/OLX-style inbox for the marketplace.
 *
 * Presentational + local-state only, seeded with DUMMY_CONVERSATIONS. The data
 * shape mirrors the real backend (/api/marketplace/conversations/list) so wiring
 * is a near one-to-one swap:
 *   - conv.id, conv.listing.{title,price_pesewas}, conv.unread_count, conv.last_message,
 *     conv.last_message_at all come straight from that endpoint today.
 *   - conv.other_user.{name,avatar_url} and conv.listing.image_url are the two
 *     fields to ADD to the endpoint's select() for full fidelity (it currently
 *     returns only other_user_id + title/price).
 *
 * Wire later by replacing DUMMY_CONVERSATIONS with a fetch/SWR call and dropping
 * the local delete into a DELETE endpoint.
 */

const BRAND_GREEN = '#00A652'

export interface ListConversation {
    id: string
    listing: { id: string; title: string; price_pesewas: number; image_url?: string }
    other_user: { id: string; name: string; avatar_url?: string }
    last_message: string
    last_message_at: string // ISO
    unread_count: number
}

interface MessagesListProps {
    /** Controlled data. Omit to use the built-in dummy list (demo mode). */
    conversations?: ListConversation[]
    onOpen?: (conversationId: string) => void
    onDelete?: (conversationId: string) => void
    loading?: boolean
}

// ── Dummy data (matches the real API shape) ────────────────────────────────
const now = Date.now()
const iso = (msAgo: number) => new Date(now - msAgo).toISOString()

const DUMMY_CONVERSATIONS: ListConversation[] = [
    {
        id: 'c1',
        listing: { id: 'l1', title: 'Toyota Corolla 2018 · Clean', price_pesewas: 12500000, image_url: 'https://images.unsplash.com/photo-1621007947382-bb3c3994e3fb?auto=format&fit=crop&w=200&q=60' },
        other_user: { id: 'u1', name: 'Kwame Mensah', avatar_url: '' },
        last_message: 'Is this still available? I can come see it today.',
        last_message_at: iso(2 * 60 * 1000),
        unread_count: 2,
    },
    {
        id: 'c2',
        listing: { id: 'l2', title: 'iPhone 13 Pro Max 256GB', price_pesewas: 650000, image_url: 'https://images.unsplash.com/photo-1511707171634-5f897ff02aa9?auto=format&fit=crop&w=200&q=60' },
        other_user: { id: 'u2', name: 'Ama Owusu', avatar_url: '' },
        last_message: 'You: Best price is GHS 6,200, no less 🙂',
        last_message_at: iso(3 * 60 * 60 * 1000),
        unread_count: 0,
    },
    {
        id: 'c3',
        listing: { id: 'l3', title: '2-Bedroom Apartment, East Legon', price_pesewas: 250000000, image_url: 'https://images.unsplash.com/photo-1568605114967-8130f3a36994?auto=format&fit=crop&w=200&q=60' },
        other_user: { id: 'u3', name: 'Yaw Boateng', avatar_url: '' },
        last_message: 'Can we meet tomorrow around 4pm?',
        last_message_at: iso(28 * 60 * 60 * 1000),
        unread_count: 1,
    },
    {
        id: 'c4',
        listing: { id: 'l4', title: 'HP EliteBook 840 G5', price_pesewas: 320000, image_url: 'https://images.unsplash.com/photo-1496181133206-80ce9b88a853?auto=format&fit=crop&w=200&q=60' },
        other_user: { id: 'u4', name: 'Efua Sarpong', avatar_url: '' },
        last_message: 'You: Sent you the location 👍',
        last_message_at: iso(3 * 24 * 60 * 60 * 1000),
        unread_count: 0,
    },
]

// Relative timestamp: "now", "2m", "3h", "Yesterday", "3d", else date.
function formatRelative(isoStr: string): string {
    const then = new Date(isoStr).getTime()
    const diff = Date.now() - then
    const m = Math.floor(diff / 60000)
    if (m < 1) return 'now'
    if (m < 60) return `${m}m`
    const h = Math.floor(m / 60)
    if (h < 24) return `${h}h`
    const d = Math.floor(h / 24)
    if (d === 1) return 'Yesterday'
    if (d < 7) return `${d}d`
    return new Date(isoStr).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

function initials(name: string): string {
    return name.trim().split(/\s+/).slice(0, 2).map((n) => n[0]?.toUpperCase() ?? '').join('') || '?'
}

const cedis = (pesewas: number) =>
    `GHS ${(pesewas / 100).toLocaleString('en-GH', { maximumFractionDigits: 0 })}`

export function MessagesList({ conversations, onOpen, onDelete, loading }: MessagesListProps) {
    // Controlled by the `conversations` prop; falls back to dummy data for the
    // standalone demo. `hidden` gives optimistic removal in both modes.
    const source = conversations ?? DUMMY_CONVERSATIONS
    const [hidden, setHidden] = useState<Set<string>>(new Set())
    const [openRow, setOpenRow] = useState<string | null>(null) // row with delete revealed

    const items = source.filter((c) => !hidden.has(c.id))

    const remove = (id: string) => {
        setHidden((prev) => new Set(prev).add(id))
        setOpenRow(null)
        onDelete?.(id)
    }

    return (
        <div className="mx-auto flex min-h-screen max-w-[480px] flex-col bg-white dark:bg-[#0a0f1c]">
            {/* Header */}
            <header className="sticky top-0 z-10 flex items-center justify-between border-b border-gray-100 bg-white/95 px-4 py-3 backdrop-blur dark:border-gray-800 dark:bg-[#0a0f1c]/95">
                <h1 className="text-xl font-black text-gray-900 dark:text-white">Messages</h1>
                <button
                    type="button"
                    aria-label="Search messages"
                    className="flex h-9 w-9 items-center justify-center rounded-full text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-white/10"
                >
                    <Search className="h-5 w-5" />
                </button>
            </header>

            {/* Loading */}
            {loading && items.length === 0 ? (
                <div className="flex flex-1 items-center justify-center py-20">
                    <Loader2 className="h-7 w-7 animate-spin text-emerald-600 dark:text-emerald-400" />
                </div>
            ) : items.length === 0 ? (
                <div className="flex flex-1 flex-col items-center justify-center px-8 py-20 text-center">
                    <span className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-gray-100 dark:bg-white/5">
                        <MessageSquare className="h-8 w-8 text-gray-400" />
                    </span>
                    <p className="text-base font-bold text-gray-900 dark:text-white">No messages yet</p>
                    <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                        Start a conversation from any listing and it&apos;ll show up here.
                    </p>
                </div>
            ) : (
                <ul className="flex-1 divide-y divide-gray-100 dark:divide-gray-800">
                    {items.map((conv) => {
                        const revealed = openRow === conv.id
                        const unread = conv.unread_count > 0
                        return (
                            <li key={conv.id} className="relative overflow-hidden">
                                {/* Delete action sits behind the row, revealed on long-press/swipe */}
                                <button
                                    type="button"
                                    onClick={() => remove(conv.id)}
                                    aria-label={`Delete conversation with ${conv.other_user.name}`}
                                    className="absolute inset-y-0 right-0 flex w-20 items-center justify-center bg-red-500 text-white"
                                >
                                    <Trash2 className="h-5 w-5" />
                                </button>

                                <button
                                    type="button"
                                    onClick={() => (revealed ? setOpenRow(null) : onOpen?.(conv.id))}
                                    onContextMenu={(e) => {
                                        e.preventDefault()
                                        setOpenRow(revealed ? null : conv.id)
                                    }}
                                    {...longPressHandlers(() => setOpenRow(conv.id))}
                                    className={cn(
                                        'relative flex w-full items-center gap-3 bg-white px-4 py-3 text-left transition-transform dark:bg-[#0a0f1c]',
                                        revealed ? '-translate-x-20' : 'translate-x-0',
                                        'active:bg-gray-50 dark:active:bg-white/5'
                                    )}
                                >
                                    {/* Avatar with listing thumbnail badge */}
                                    <div className="relative flex-shrink-0">
                                        {conv.other_user.avatar_url ? (
                                            // eslint-disable-next-line @next/next/no-img-element
                                            <img
                                                src={conv.other_user.avatar_url}
                                                alt={conv.other_user.name}
                                                className="h-13 w-13 rounded-full object-cover"
                                                style={{ height: 52, width: 52 }}
                                            />
                                        ) : (
                                            <span
                                                className="flex items-center justify-center rounded-full bg-emerald-100 text-sm font-bold text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300"
                                                style={{ height: 52, width: 52 }}
                                            >
                                                {initials(conv.other_user.name)}
                                            </span>
                                        )}
                                        {conv.listing.image_url && (
                                            // eslint-disable-next-line @next/next/no-img-element
                                            <img
                                                src={conv.listing.image_url}
                                                alt={conv.listing.title}
                                                className="absolute -bottom-1 -right-1 h-6 w-6 rounded-md border-2 border-white object-cover dark:border-[#0a0f1c]"
                                            />
                                        )}
                                    </div>

                                    {/* Text column */}
                                    <div className="min-w-0 flex-1">
                                        <div className="flex items-center justify-between gap-2">
                                            <span
                                                className={cn(
                                                    'truncate text-[15px] text-gray-900 dark:text-white',
                                                    unread ? 'font-bold' : 'font-semibold'
                                                )}
                                            >
                                                {conv.other_user.name}
                                            </span>
                                            <span
                                                className={cn(
                                                    'flex-shrink-0 text-xs',
                                                    unread
                                                        ? 'font-semibold text-emerald-600 dark:text-emerald-400'
                                                        : 'text-gray-400'
                                                )}
                                            >
                                                {formatRelative(conv.last_message_at)}
                                            </span>
                                        </div>
                                        <p className="truncate text-[13px] text-gray-500 dark:text-gray-500">
                                            {conv.listing.title}
                                        </p>
                                        <div className="mt-0.5 flex items-center justify-between gap-2">
                                            <p
                                                className={cn(
                                                    'truncate text-[13px]',
                                                    unread
                                                        ? 'font-medium text-gray-800 dark:text-gray-200'
                                                        : 'text-gray-500 dark:text-gray-400'
                                                )}
                                            >
                                                {conv.last_message || '(no messages yet)'}
                                            </p>
                                            {unread ? (
                                                <span
                                                    className="flex h-5 min-w-[20px] flex-shrink-0 items-center justify-center rounded-full px-1.5 text-[11px] font-bold text-white"
                                                    style={{ backgroundColor: BRAND_GREEN }}
                                                >
                                                    {conv.unread_count}
                                                </span>
                                            ) : (
                                                <span className="flex-shrink-0 text-[11px] text-gray-400">
                                                    {cedis(conv.listing.price_pesewas)}
                                                </span>
                                            )}
                                        </div>
                                    </div>
                                </button>
                            </li>
                        )
                    })}
                </ul>
            )}
        </div>
    )
}

// Press-and-hold (500ms) → reveal the row's delete action. Works with touch + mouse.
function longPressHandlers(onLongPress: () => void) {
    let timer: ReturnType<typeof setTimeout> | null = null
    const start = () => {
        timer = setTimeout(onLongPress, 500)
    }
    const clear = () => {
        if (timer) clearTimeout(timer)
        timer = null
    }
    return {
        onPointerDown: start,
        onPointerUp: clear,
        onPointerLeave: clear,
        onPointerCancel: clear,
    }
}

export default MessagesList
