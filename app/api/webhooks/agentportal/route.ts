import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { syncShopOrderStatus } from '@/lib/shop-service'
import crypto from 'crypto'

// Agent Portal GH completion webhook.
// Docs: POST <our-url> with header `X-Webhook-Signature: sha256=<hex>` where the
// signature is an HMAC-SHA256 of the RAW request body keyed with our webhook secret.
// Payload (event: "order.completed") carries an `items[]` array; each item echoes
// the `reference` we sent at /api/queue/add (the Arhms order id) plus a terminal
// `status` of 'success' | 'failed'.

const AGENTPORTAL_API_URL = process.env.AGENTPORTAL_API_URL || 'https://api.agentportalgh.com'

function verifySignature(rawBody: string, header: string | null, secret: string): boolean {
    if (!header) return false
    const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex')
    const a = Buffer.from(expected)
    const b = Buffer.from(header)
    return a.length === b.length && crypto.timingSafeEqual(a, b)
}

// Fetch the full item list when the webhook payload was truncated (>500 items).
async function fetchAllItems(orderId: string): Promise<any[]> {
    const key = process.env.AGENTPORTAL_API_KEY || ''
    if (!key || !orderId) return []
    try {
        const resp = await fetch(
            `${AGENTPORTAL_API_URL}/api/beneficiaries/orders/${encodeURIComponent(orderId)}/items`,
            { method: 'GET', headers: { 'Accept': 'application/json', 'X-API-Key': key } }
        )
        const text = await resp.text()
        const data = JSON.parse(text)
        return Array.isArray(data) ? data : (data?.data || data?.items || [])
    } catch (e) {
        console.error('[AgentPortalWebhook] Failed to fetch full item list:', e)
        return []
    }
}

export async function POST(request: NextRequest) {
    try {
        const secret = process.env.AGENTPORTAL_WEBHOOK_SECRET
        if (!secret) {
            console.error('[AgentPortalWebhook] AGENTPORTAL_WEBHOOK_SECRET is not configured')
            return NextResponse.json({ error: 'Webhook unavailable' }, { status: 503 })
        }

        // Read the RAW body first — signature is computed over the exact bytes.
        const rawBody = await request.text()
        const signature = request.headers.get('x-webhook-signature')

        if (!verifySignature(rawBody, signature, secret)) {
            console.error('[AgentPortalWebhook] Invalid webhook signature')
            return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
        }

        let payload: any
        try {
            payload = JSON.parse(rawBody)
        } catch (e) {
            console.error('[AgentPortalWebhook] Failed to parse payload')
            return NextResponse.json({ error: 'Invalid payload' }, { status: 400 })
        }

        if (payload?.event !== 'order.completed') {
            console.log(`[AgentPortalWebhook] Ignored event '${payload?.event}'`)
            return NextResponse.json({ success: true }, { status: 200 })
        }

        let items: any[] = Array.isArray(payload?.items) ? payload.items : []
        if (payload?.items_truncated && payload?.order_id) {
            const full = await fetchAllItems(payload.order_id)
            if (full.length > 0) items = full
        }

        if (items.length === 0) {
            return NextResponse.json({ success: true, updated: 0 }, { status: 200 })
        }

        const supabase = createServerClient()
        let updated = 0

        for (const item of items) {
            const reference = item?.reference
            if (!reference) continue

            const itemStatus = (item?.status || '').toLowerCase()
            const newStatus = itemStatus === 'success' ? 'completed' : itemStatus === 'failed' ? 'failed' : null
            if (!newStatus) continue // only act on terminal items

            // Match back to the Arhms order by the reference we submitted (orders.id).
            const { data: order } = await (supabase
                .from('orders') as any)
                .select('id, status, shop_order_id, fulfillment_method')
                .eq('id', reference)
                .maybeSingle()

            if (!order) {
                console.warn(`[AgentPortalWebhook] No order found for reference ${reference}`)
                continue
            }

            // Only advance orders currently in processing (idempotent — skip already-terminal).
            if (order.status !== 'processing') {
                continue
            }

            const { error: updErr } = await (supabase.from('orders') as any)
                .update({ status: newStatus, updated_at: new Date().toISOString() })
                .eq('id', order.id)
                .eq('status', 'processing')

            if (updErr) {
                console.error(`[AgentPortalWebhook] orders update failed for ${order.id}: ${updErr.message}`)
                continue
            }

            if (order.shop_order_id) {
                await (supabase.from('shop_orders') as any)
                    .update({ status: newStatus, updated_at: new Date().toISOString() })
                    .eq('id', order.shop_order_id)
            }

            await syncShopOrderStatus(order.id, newStatus).catch(err =>
                console.error(`[AgentPortalWebhook] syncShopOrderStatus failed for ${order.id}:`, err)
            )

            console.log(`[AgentPortalWebhook] order ${order.id}: processing → ${newStatus}${newStatus === 'failed' ? ' (manual refund required)' : ''}`)
            updated++
        }

        return NextResponse.json({ success: true, updated }, { status: 200 })

    } catch (error: any) {
        console.error('[AgentPortalWebhook] Unhandled exception:', error)
        // Return 2xx so the supplier doesn't hammer retries on our internal error;
        // the fallback cron will reconcile anything we missed.
        return NextResponse.json({ success: true }, { status: 200 })
    }
}
