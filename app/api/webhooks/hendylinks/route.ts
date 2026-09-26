import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { syncShopOrderStatus } from '@/lib/shop-service'
import { mapHendyLinksStatus } from '@/lib/hendylinks-service'
import crypto from 'crypto'

// HendyLinks completion webhook.
// Docs: POST <our-url> with header `X-Webhook-Signature: sha256=<hex>` where the
// signature is an HMAC-SHA256 of the RAW request body. Payload
// (event: "order.status_changed") carries a single `order` object whose `id` is the
// supplier order id we stamped on orders.hendylinks_reference at fulfillment time.
//
// This is the PRIMARY status channel. app/api/cron/sync-hendylinks-status is the
// fallback that reconciles anything a missed or mis-signed delivery left behind.
// Note this route is deliberately NOT gated on CRON_JOBS_ENABLED — completions
// keep flowing even when the crons are switched off.

function verifySignature(rawBody: string, header: string | null, secret: string): boolean {
    if (!header) return false
    const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex')
    const a = Buffer.from(expected)
    const b = Buffer.from(header)
    // Length check first: timingSafeEqual throws on mismatched lengths.
    return a.length === b.length && crypto.timingSafeEqual(a, b)
}

export async function POST(request: NextRequest) {
    try {
        // Their docs sign with the API token itself. A dedicated var is still read
        // first so the signing secret can be rotated separately if they ever add one.
        const secret = process.env.HENDYLINKS_WEBHOOK_SECRET || process.env.HENDYLINKS_API_KEY
        if (!secret) {
            console.error('[HendyLinksWebhook] No HENDYLINKS_WEBHOOK_SECRET or HENDYLINKS_API_KEY configured')
            // 503, not 401 — this is our misconfiguration, not a forged request.
            return NextResponse.json({ error: 'Webhook unavailable' }, { status: 503 })
        }

        // Read the RAW body first — signature is computed over the exact bytes.
        const rawBody = await request.text()
        const signature = request.headers.get('x-webhook-signature')

        if (!verifySignature(rawBody, signature, secret)) {
            console.error('[HendyLinksWebhook] Invalid webhook signature')
            return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
        }

        let payload: any
        try {
            payload = JSON.parse(rawBody)
        } catch (e) {
            console.error('[HendyLinksWebhook] Failed to parse payload')
            return NextResponse.json({ error: 'Invalid payload' }, { status: 400 })
        }

        if (payload?.event !== 'order.status_changed') {
            console.log(`[HendyLinksWebhook] Ignored event '${payload?.event}'`)
            return NextResponse.json({ success: true }, { status: 200 })
        }

        const supplierOrderId = payload?.order?.id
        const rawStatus = payload?.order?.status
        if (supplierOrderId === undefined || supplierOrderId === null || !rawStatus) {
            console.warn('[HendyLinksWebhook] Payload carried no order id or status')
            return NextResponse.json({ success: true, updated: 0 }, { status: 200 })
        }

        const reference = String(supplierOrderId)
        const newStatus = mapHendyLinksStatus(String(rawStatus))

        // Non-terminal states (still processing / verifying) tell us nothing we can
        // act on — the order is already 'processing'. Record the supplier's own
        // wording so the UI can show "Verifying" instead of a bare "Processing",
        // then stop. The cron re-checks these.
        const isTerminal = newStatus === 'completed' || newStatus === 'failed'

        const supabase = createServerClient()

        // Direct and storefront orders both stamp the supplier id on
        // orders.hendylinks_reference, so this one lookup covers each.
        const { data: order } = await (supabase
            .from('orders') as any)
            .select('id, status, shop_order_id')
            .eq('hendylinks_reference', reference)
            .maybeSingle()

        if (!order) {
            console.warn(`[HendyLinksWebhook] No order found for reference ${reference}`)
            return NextResponse.json({ success: true, updated: 0 }, { status: 200 })
        }

        // Only advance orders currently in processing (idempotent — skip already-terminal).
        if (order.status !== 'processing') {
            return NextResponse.json({ success: true, updated: 0 }, { status: 200 })
        }

        // Raw supplier label, for display only (see lib/order-status-display).
        // Written in its OWN statement and its error deliberately ignored: if this
        // ever runs against a DB without the supplier_status migration, PostgREST
        // rejects the whole statement — merging it would take order completion down
        // with it. Losing a cosmetic label is acceptable; losing completions is not.
        const supplierLabel = String(rawStatus).trim().toLowerCase() || null
        await (supabase.from('orders') as any)
            .update({ supplier_status: isTerminal ? null : supplierLabel })
            .eq('id', order.id)

        if (order.shop_order_id) {
            await (supabase.from('shop_orders') as any)
                .update({ supplier_status: isTerminal ? null : supplierLabel })
                .eq('id', order.shop_order_id)
        }

        if (!isTerminal) {
            console.log(`[HendyLinksWebhook] order ${order.id}: supplier says "${rawStatus}" → ${newStatus} (no change)`)
            return NextResponse.json({ success: true, updated: 0 }, { status: 200 })
        }

        const { error: updErr } = await (supabase.from('orders') as any)
            .update({ status: newStatus, updated_at: new Date().toISOString() })
            .eq('id', order.id)
            // Second idempotency guard, at the row level: two overlapping deliveries
            // cannot both count this order.
            .eq('status', 'processing')

        if (updErr) {
            console.error(`[HendyLinksWebhook] orders update failed for ${order.id}: ${updErr.message}`)
            return NextResponse.json({ success: true, updated: 0 }, { status: 200 })
        }

        if (order.shop_order_id) {
            await (supabase.from('shop_orders') as any)
                .update({ status: newStatus, updated_at: new Date().toISOString() })
                .eq('id', order.shop_order_id)
                .eq('status', 'processing')
        }

        await syncShopOrderStatus(order.id, newStatus).catch(err =>
            console.error(`[HendyLinksWebhook] syncShopOrderStatus failed for ${order.id}:`, err)
        )

        console.log(`[HendyLinksWebhook] order ${order.id}: processing → ${newStatus}${newStatus === 'failed' ? ' (manual refund required)' : ''}`)

        return NextResponse.json({ success: true, updated: 1 }, { status: 200 })

    } catch (error: any) {
        console.error('[HendyLinksWebhook] Unhandled exception:', error)
        // Return 2xx so the supplier doesn't hammer retries on our internal error;
        // the fallback cron will reconcile anything we missed.
        return NextResponse.json({ success: true }, { status: 200 })
    }
}
