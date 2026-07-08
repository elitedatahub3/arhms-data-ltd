import { NextRequest, NextResponse } from 'next/server'
import { createRouteHandlerClient } from '@/lib/supabase-server'
import { primaryImageUrl, getUserDisplayNames } from '@/lib/marketplace-messaging'

export async function GET(
    request: NextRequest,
    { params: { id } }: { params: { id: string } }
) {
    try {
        const supabaseUserClient = await createRouteHandlerClient()

        const {
            data: { user },
        } = await supabaseUserClient.auth.getUser()

        if (!user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const page = Math.max(1, parseInt(request.nextUrl.searchParams.get('page') || '1'))
        const limit = Math.min(100, parseInt(request.nextUrl.searchParams.get('limit') || '50'))
        const offset = (page - 1) * limit

        // Get conversation (+ listing details for the pinned chat header).
        // These marketplace_* tables aren't in the generated Database types, so
        // the row infers `never` — cast to any (matches the rest of these routes).
        const { data: conversationData, error: convError } = await supabaseUserClient
            .from('marketplace_conversations')
            .select(
                '*, classified_listings(title, price_pesewas, classified_listing_images(storage_path, display_order))'
            )
            .eq('id', id)
            .single()

        if (convError || !conversationData) {
            return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
        }
        const conversation = conversationData as any

        // Check authorization
        if (
            conversation.buyer_id !== user.id &&
            conversation.seller_id !== user.id
        ) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
        }

        // Get messages
        const { data: messages, count, error: messagesError } = await supabaseUserClient
            .from('marketplace_conversation_messages')
            .select('id, user_id, message, created_at, read_at', { count: 'exact' })
            .eq('conversation_id', id)
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1)

        if (messagesError) {
            console.error('[Conversation] Messages error:', messagesError)
            return NextResponse.json(
                { error: 'Failed to fetch messages' },
                { status: 500 }
            )
        }

        // Mark messages as read
        const unreadMessageIds = (messages || [])
            .filter((m: any) => !m.read_at && m.user_id !== user.id)
            .map((m: any) => m.id)

        if (unreadMessageIds.length > 0) {
            await (supabaseUserClient.from('marketplace_conversation_messages') as any)
                .update({ read_at: new Date().toISOString() })
                .in('id', unreadMessageIds)
        }

        const otherUserId =
            conversation.buyer_id === user.id
                ? conversation.seller_id
                : conversation.buyer_id

        const names = await getUserDisplayNames([otherUserId])
        const listing = (conversation as any).classified_listings

        return NextResponse.json({
            success: true,
            conversation: {
                id: conversation.id,
                listing_id: conversation.listing_id,
                other_user_id: otherUserId,
                other_user: { id: otherUserId, name: names[otherUserId] || 'Marketplace user' },
                listing: {
                    id: conversation.listing_id,
                    title: listing?.title ?? '',
                    price_pesewas: listing?.price_pesewas ?? 0,
                    image_url: primaryImageUrl(listing?.classified_listing_images),
                },
                created_at: conversation.created_at,
            },
            messages: (messages || []).reverse(),
            pagination: {
                page,
                limit,
                total: count || 0,
                pages: Math.ceil((count || 0) / limit),
            },
        })
    } catch (error) {
        console.error('[Conversation] Error:', error)
        return NextResponse.json(
            { error: 'Internal server error' },
            { status: 500 }
        )
    }
}
