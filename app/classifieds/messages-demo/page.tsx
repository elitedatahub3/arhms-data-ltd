'use client'

import { useState } from 'react'
import { MessagesList } from '@/components/marketplace/messages-list'
import { ChatConversation } from '@/components/marketplace/chat-conversation'

/**
 * Preview harness for the marketplace messaging UI (dummy data).
 * MessagesList → tap a row → ChatConversation → back.
 *
 * Public single-segment route (`/classifieds/messages-demo`) so no auth is
 * required to view it. Delete once the components are wired to the real backend.
 */
export default function MessagesDemoPage() {
    const [openId, setOpenId] = useState<string | null>(null)

    if (openId) {
        return <ChatConversation conversationId={openId} onBack={() => setOpenId(null)} />
    }
    return <MessagesList onOpen={(id) => setOpenId(id)} />
}
