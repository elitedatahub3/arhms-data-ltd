'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { MessagesList, type ListConversation } from '@/components/marketplace/messages-list'

/**
 * Messages tab (bottom-nav "Messages").
 *
 * Container: fetches the signed-in user's conversations from
 * /api/marketplace/conversations/list, maps them to the MessagesList shape, and
 * polls every 4s. Tapping a row opens the thread at ./messages/[id].
 */
export default function MessagesPage() {
    const router = useRouter()
    const [conversations, setConversations] = useState<ListConversation[]>([])
    const [loading, setLoading] = useState(true)
    const loadedOnce = useRef(false)

    const load = useCallback(async () => {
        try {
            const res = await fetch('/api/marketplace/conversations/list?limit=50')
            if (!res.ok) {
                if (!loadedOnce.current) setConversations([])
                return
            }
            const data = await res.json()
            const mapped: ListConversation[] = (data.conversations || []).map((c: any) => ({
                id: c.id,
                listing: {
                    id: c.listing_id,
                    title: c.listing?.title ?? '',
                    price_pesewas: c.listing?.price_pesewas ?? 0,
                    image_url: c.listing?.image_url ?? undefined,
                },
                other_user: {
                    id: c.other_user?.id ?? c.other_user_id,
                    name: c.other_user?.name ?? 'Marketplace user',
                },
                last_message: c.last_message ?? '',
                last_message_at: c.last_message_at,
                unread_count: c.unread_count ?? 0,
            }))
            setConversations(mapped)
            loadedOnce.current = true
        } catch (err) {
            console.error('[Messages] load error:', err)
        } finally {
            setLoading(false)
        }
    }, [])

    useEffect(() => {
        load()
        const interval = setInterval(load, 4000)
        return () => clearInterval(interval)
    }, [load])

    return (
        <MessagesList
            conversations={conversations}
            loading={loading}
            onOpen={(id) => router.push(`/classifieds/buyer/messages/${id}`)}
        />
    )
}
