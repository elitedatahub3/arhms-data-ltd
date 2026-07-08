'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useRouter, useParams } from 'next/navigation'
import { useAuth } from '@/contexts/auth-context'
import {
    ChatConversation,
    type ChatMessage,
    type ChatHeader,
} from '@/components/marketplace/chat-conversation'
import { Loader2 } from 'lucide-react'

/**
 * Chat thread (opened from the Messages tab).
 *
 * Container: loads /api/marketplace/conversations/[id], maps to ChatConversation,
 * polls every 2s, and sends via POST /api/marketplace/conversations/[id]/messages
 * with an optimistic append reconciled on the next poll.
 */
export default function ChatThreadPage() {
    const router = useRouter()
    const params = useParams<{ id: string }>()
    const id = params?.id as string
    const { user } = useAuth()

    const [header, setHeader] = useState<ChatHeader | null>(null)
    const [messages, setMessages] = useState<ChatMessage[]>([])
    const seededHeader = useRef(false)

    const load = useCallback(async () => {
        try {
            const res = await fetch(`/api/marketplace/conversations/${id}`)
            if (res.status === 404 || res.status === 403) {
                router.replace('/classifieds/buyer/messages')
                return
            }
            if (!res.ok) return
            const data = await res.json()

            const conv = data.conversation
            // Seed the header once (it doesn't change during the conversation).
            if (!seededHeader.current && conv) {
                setHeader({
                    other_user: {
                        id: conv.other_user?.id ?? conv.other_user_id,
                        name: conv.other_user?.name ?? 'Marketplace user',
                    },
                    listing: {
                        id: conv.listing?.id ?? conv.listing_id,
                        title: conv.listing?.title ?? '',
                        price_pesewas: conv.listing?.price_pesewas ?? 0,
                        image_url: conv.listing?.image_url ?? undefined,
                    },
                })
                seededHeader.current = true
            }

            setMessages(
                (data.messages || []).map((m: any) => ({
                    id: m.id,
                    user_id: m.user_id,
                    message: m.message,
                    created_at: m.created_at,
                    read_at: m.read_at,
                }))
            )
        } catch (err) {
            console.error('[Chat] load error:', err)
        }
    }, [id, router])

    useEffect(() => {
        load()
        const interval = setInterval(load, 2000)
        return () => clearInterval(interval)
    }, [load])

    const handleSend = useCallback(
        async (text: string) => {
            if (!user) return
            // Optimistic append — reconciled when the next poll returns the real row.
            const temp: ChatMessage = {
                id: `temp-${Date.now()}`,
                user_id: user.id,
                message: text,
                created_at: new Date().toISOString(),
                read_at: null,
            }
            setMessages((prev) => [...prev, temp])

            try {
                await fetch(`/api/marketplace/conversations/${id}/messages`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ conversation_id: id, message: text }),
                })
                await load()
            } catch (err) {
                console.error('[Chat] send error:', err)
            }
        },
        [id, user, load]
    )

    // Wait for the real header before rendering (never fall back to dummy data
    // in wired mode). A 404/403 redirects away; a transient error keeps polling.
    if (!header) {
        return (
            <div className="flex h-screen items-center justify-center bg-gray-50 dark:bg-[#0a0f1c]">
                <Loader2 className="h-7 w-7 animate-spin text-emerald-600 dark:text-emerald-400" />
            </div>
        )
    }

    return (
        <ChatConversation
            conversationId={id}
            currentUserId={user?.id}
            header={header}
            messages={messages}
            onSend={handleSend}
            onBack={() => router.push('/classifieds/buyer/messages')}
            onOpenListing={(listingId) => router.push(`/classifieds/${listingId}`)}
        />
    )
}
