'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { ArrowLeft, Phone, Paperclip, Send, Check, CheckCheck } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * ChatConversation — Jiji/OLX-style chat thread for the marketplace.
 *
 * Presentational + local-state only, seeded with dummy data. Shapes mirror the
 * real backend so wiring is a near one-to-one swap:
 *   - Message shape = /api/marketplace/conversations/[id] rows
 *     ({ id, user_id, message, created_at, read_at }).
 *   - Send = POST /api/marketplace/conversations/[id]/messages { message }.
 *   - `currentUserId` = supabase.auth.getUser().id; a message is "sent" (right,
 *     green) when msg.user_id === currentUserId, else "received" (left, gray).
 *   - The pinned header/listing + other_user come from the conversation record.
 *
 * The typing indicator here is simulated; with the real backend swap it for a
 * Supabase realtime presence/broadcast channel.
 */

const BRAND_GREEN = '#00A652'

export interface ChatMessage {
    id: string
    user_id: string
    message: string
    created_at: string // ISO
    read_at?: string | null
}

export interface ChatHeader {
    other_user: { id: string; name: string; avatar_url?: string; last_seen?: string }
    listing: { id: string; title: string; price_pesewas: number; image_url?: string }
}

interface ChatConversationProps {
    conversationId?: string
    currentUserId?: string
    header?: ChatHeader
    initialMessages?: ChatMessage[]
    /** Controlled messages (from a polling/realtime parent). Enables wired mode. */
    messages?: ChatMessage[]
    /** Wired-mode send handler (POST + optimistic update live in the parent). */
    onSend?: (text: string) => void | Promise<void>
    /** Wired-mode typing indicator. */
    otherTyping?: boolean
    onBack?: () => void
    onOpenListing?: (listingId: string) => void
}

const QUICK_REPLIES = [
    'Is this available?',
    "What's your best price?",
    'Can we meet today?',
    'Where are you located?',
]

// ── Dummy defaults (match the real API shape) ──────────────────────────────
const ME = 'me'
const now = Date.now()
const iso = (msAgo: number) => new Date(now - msAgo).toISOString()

const DUMMY_HEADER: ChatHeader = {
    other_user: { id: 'u1', name: 'Kwame Mensah', avatar_url: '', last_seen: 'online' },
    listing: {
        id: 'l1',
        title: 'Toyota Corolla 2018 · Clean',
        price_pesewas: 12500000,
        image_url: 'https://images.unsplash.com/photo-1621007947382-bb3c3994e3fb?auto=format&fit=crop&w=200&q=60',
    },
}

const DUMMY_MESSAGES: ChatMessage[] = [
    { id: 'm1', user_id: 'u1', message: 'Hi, is the Corolla still available?', created_at: iso(60 * 60 * 1000), read_at: iso(59 * 60 * 1000) },
    { id: 'm2', user_id: ME, message: 'Yes it is! Clean interior, one owner.', created_at: iso(58 * 60 * 1000), read_at: iso(57 * 60 * 1000) },
    { id: 'm3', user_id: 'u1', message: "What's your best price?", created_at: iso(50 * 60 * 1000), read_at: iso(49 * 60 * 1000) },
    { id: 'm4', user_id: ME, message: 'GHS 125,000. Slightly negotiable for a serious buyer.', created_at: iso(48 * 60 * 1000), read_at: null },
    { id: 'm5', user_id: 'u1', message: 'Is this still available? I can come see it today.', created_at: iso(2 * 60 * 1000), read_at: null },
]

function formatTime(isoStr: string): string {
    return new Date(isoStr).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
}

function initials(name: string): string {
    return name.trim().split(/\s+/).slice(0, 2).map((n) => n[0]?.toUpperCase() ?? '').join('') || '?'
}

const cedis = (pesewas: number) =>
    `GHS ${(pesewas / 100).toLocaleString('en-GH', { maximumFractionDigits: 0 })}`

export function ChatConversation({
    conversationId,
    currentUserId = ME,
    header = DUMMY_HEADER,
    initialMessages,
    messages: controlledMessages,
    onSend,
    otherTyping: controlledTyping,
    onBack,
    onOpenListing,
}: ChatConversationProps) {
    // Wired mode: the parent supplies messages + an onSend handler and owns
    // fetching/optimistic updates. Demo mode: internal state + a fake auto-reply.
    const wired = typeof onSend === 'function'
    const [internalMessages, setInternalMessages] = useState<ChatMessage[]>(
        initialMessages ?? DUMMY_MESSAGES
    )
    const [internalTyping, setInternalTyping] = useState(false)
    const [input, setInput] = useState('')
    const endRef = useRef<HTMLDivElement>(null)
    const idRef = useRef(0)

    const messages = wired ? controlledMessages ?? [] : internalMessages
    const otherTyping = wired ? !!controlledTyping : internalTyping

    // Auto-scroll to the latest message whenever the list or typing state changes.
    useEffect(() => {
        endRef.current?.scrollIntoView({ behavior: 'smooth' })
    }, [messages, otherTyping])

    const send = useCallback(
        (text: string) => {
            const trimmed = text.trim()
            if (!trimmed) return
            setInput('')

            if (wired) {
                onSend!(trimmed)
                return
            }

            // Demo mode: append locally, then fake the other party's reply.
            setInternalMessages((prev) => [
                ...prev,
                {
                    id: `local-${idRef.current++}`,
                    user_id: currentUserId,
                    message: trimmed,
                    created_at: new Date().toISOString(),
                    read_at: null,
                },
            ])
            setInternalTyping(true)
            window.setTimeout(() => {
                setInternalTyping(false)
                setInternalMessages((prev) => [
                    ...prev,
                    {
                        id: `local-${idRef.current++}`,
                        user_id: header.other_user.id,
                        message: 'Great, thanks! 👍',
                        created_at: new Date().toISOString(),
                        read_at: null,
                    },
                ])
            }, 1800)
        },
        [wired, onSend, currentUserId, header.other_user.id]
    )

    const status = header.other_user.last_seen === 'online' ? 'Online' : header.other_user.last_seen

    return (
        <div className="mx-auto flex h-screen max-w-[480px] flex-col bg-gray-50 dark:bg-[#0a0f1c]">
            {/* Header */}
            <header className="flex items-center gap-3 border-b border-gray-100 bg-white px-2 py-2.5 dark:border-gray-800 dark:bg-[#151c2c]">
                <button
                    type="button"
                    onClick={onBack}
                    aria-label="Back"
                    className="flex h-9 w-9 items-center justify-center rounded-full text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-white/10"
                >
                    <ArrowLeft className="h-5 w-5" />
                </button>
                {header.other_user.avatar_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={header.other_user.avatar_url} alt={header.other_user.name} className="h-9 w-9 rounded-full object-cover" />
                ) : (
                    <span className="flex h-9 w-9 items-center justify-center rounded-full bg-emerald-100 text-xs font-bold text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300">
                        {initials(header.other_user.name)}
                    </span>
                )}
                <div className="min-w-0 flex-1">
                    <p className="truncate text-[15px] font-bold text-gray-900 dark:text-white">
                        {header.other_user.name}
                    </p>
                    {status && (
                        <p className="flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400">
                            {header.other_user.last_seen === 'online' && (
                                <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: BRAND_GREEN }} />
                            )}
                            {status}
                        </p>
                    )}
                </div>
                <button
                    type="button"
                    aria-label="Call"
                    className="flex h-9 w-9 items-center justify-center rounded-full text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-white/10"
                >
                    <Phone className="h-5 w-5" />
                </button>
            </header>

            {/* Pinned listing card */}
            <button
                type="button"
                onClick={() => onOpenListing?.(header.listing.id)}
                className="flex items-center gap-3 border-b border-gray-100 bg-white px-3 py-2 text-left dark:border-gray-800 dark:bg-[#151c2c]"
            >
                {header.listing.image_url && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                        src={header.listing.image_url}
                        alt={header.listing.title}
                        className="h-11 w-11 flex-shrink-0 rounded-lg object-cover"
                    />
                )}
                <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-gray-900 dark:text-white">
                        {header.listing.title}
                    </p>
                    <p className="text-sm font-bold" style={{ color: BRAND_GREEN }}>
                        {cedis(header.listing.price_pesewas)}
                    </p>
                </div>
                <span className="flex-shrink-0 text-xs font-medium text-gray-400">View →</span>
            </button>

            {/* Messages */}
            <div className="flex-1 space-y-1.5 overflow-y-auto px-3 py-4">
                {messages.map((msg, i) => {
                    const isOwn = msg.user_id === currentUserId
                    const prev = messages[i - 1]
                    const grouped = prev && prev.user_id === msg.user_id
                    return (
                        <div key={msg.id} className={cn('flex', isOwn ? 'justify-end' : 'justify-start')}>
                            <div
                                className={cn(
                                    'max-w-[75%] px-3.5 py-2 shadow-sm',
                                    isOwn
                                        ? 'rounded-2xl rounded-br-md text-white'
                                        : 'rounded-2xl rounded-bl-md bg-white text-gray-900 dark:bg-[#1e2637] dark:text-gray-100',
                                    grouped && 'mt-0.5'
                                )}
                                style={isOwn ? { backgroundColor: BRAND_GREEN } : undefined}
                            >
                                <p className="whitespace-pre-wrap break-words text-[14px] leading-snug">{msg.message}</p>
                                <span
                                    className={cn(
                                        'mt-0.5 flex items-center justify-end gap-1 text-[10px]',
                                        isOwn ? 'text-white/70' : 'text-gray-400'
                                    )}
                                >
                                    {formatTime(msg.created_at)}
                                    {isOwn &&
                                        (msg.read_at ? (
                                            <CheckCheck className="h-3.5 w-3.5" />
                                        ) : (
                                            <Check className="h-3.5 w-3.5" />
                                        ))}
                                </span>
                            </div>
                        </div>
                    )
                })}

                {/* Typing indicator */}
                {otherTyping && (
                    <div className="flex justify-start">
                        <div className="rounded-2xl rounded-bl-md bg-white px-4 py-3 shadow-sm dark:bg-[#1e2637]">
                            <span className="flex gap-1">
                                {[0, 150, 300].map((delay) => (
                                    <span
                                        key={delay}
                                        className="h-1.5 w-1.5 animate-bounce rounded-full bg-gray-400"
                                        style={{ animationDelay: `${delay}ms` }}
                                    />
                                ))}
                            </span>
                        </div>
                    </div>
                )}
                <div ref={endRef} />
            </div>

            {/* Quick replies */}
            <div className="scrollbar-hide flex gap-2 overflow-x-auto px-3 py-2">
                {QUICK_REPLIES.map((q) => (
                    <button
                        key={q}
                        type="button"
                        onClick={() => send(q)}
                        className="flex-shrink-0 whitespace-nowrap rounded-full border border-gray-200 bg-white px-3 py-1.5 text-[13px] font-medium text-gray-700 active:scale-95 dark:border-gray-700 dark:bg-[#151c2c] dark:text-gray-300"
                    >
                        {q}
                    </button>
                ))}
            </div>

            {/* Input bar */}
            <form
                onSubmit={(e) => {
                    e.preventDefault()
                    send(input)
                }}
                className="flex items-center gap-2 border-t border-gray-100 bg-white px-3 py-2.5 dark:border-gray-800 dark:bg-[#151c2c]"
                style={{ paddingBottom: 'calc(0.625rem + env(safe-area-inset-bottom))' }}
            >
                <button
                    type="button"
                    aria-label="Attach image"
                    className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full text-gray-500 hover:bg-gray-100 dark:hover:bg-white/10"
                >
                    <Paperclip className="h-5 w-5" />
                </button>
                <input
                    type="text"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    placeholder="Type a message..."
                    className="h-10 flex-1 rounded-full bg-gray-100 px-4 text-[14px] text-gray-900 outline-none placeholder:text-gray-400 focus:ring-2 focus:ring-emerald-500/40 dark:bg-white/5 dark:text-white"
                />
                <button
                    type="submit"
                    disabled={!input.trim()}
                    aria-label="Send message"
                    className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full text-white transition-colors disabled:cursor-not-allowed"
                    style={{ backgroundColor: input.trim() ? BRAND_GREEN : '#cbd5e1' }}
                >
                    <Send className="h-5 w-5" />
                </button>
            </form>
        </div>
    )
}

export default ChatConversation
