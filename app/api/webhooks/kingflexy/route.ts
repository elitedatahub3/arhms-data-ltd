import { NextRequest, NextResponse } from 'next/server'
import { createHmac, timingSafeEqual } from 'crypto'
import { createServerClient } from '@/lib/supabase'
import { UTILITY_SERVICES, isUtilityService } from '@/lib/hubtel-utility-service'
import { getUtilityOrderStatus } from '@/lib/utility-provider'
import { finalizeUtilityOrder } from '@/lib/utility-order-completion'

/**
 * KingFlexy order callbacks.
 *
 * Saves us polling every open order: they POST here the moment one reaches a
 * terminal state. It is not a replacement for /api/cron/sync-kingflexy-utility
 * though — their delivery is fire-and-forget with a single retry and no replay, so a
 * callback lost to a deploy is lost permanently and only the sweep will settle that
 * order.
 *
 * The signature is the whole security model. Anyone who learns this URL can
 * otherwise POST a fake order.completed and have us finalise an order — and for a
 * commission-key order that also credits a partner's wallet. So an unverified body
 * is never acted on.
 */
export const dynamic = 'force-dynamic'

function verifySignature(rawBody: string, header: string | null): boolean {
    const secret = process.env.KINGFLEXY_WEBHOOK_SECRET
    if (!secret || !header) return false

    const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')

    // Their header is bare hex; tolerate a "sha256=" prefix in case that changes.
    const received = header.startsWith('sha256=') ? header.slice(7) : header

    const a = Buffer.from(expected)
    const b = Buffer.from(received)
    // timingSafeEqual throws on a length mismatch, so that is checked first — and a
    // differing length is already a failed comparison.
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
}

export async function POST(request: NextRequest) {
    // The RAW bytes, before any parsing. Re-serialising a parsed object changes key
    // order and whitespace, and the HMAC would never match.
    const rawBody = await request.text()

    if (!verifySignature(rawBody, request.headers.get('x-kft-signature'))) {
        console.error('[KingFlexyWebhook] Rejected: bad or missing X-KFT-Signature')
        return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
    }

    let event: any
    try {
        event = JSON.parse(rawBody)
    } catch {
        return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
    }

    const product = String(event?.product || '')
    const reference = String(event?.reference || '')

    // Data and airtime orders are reconciled by their own paths; only bill payments
    // are fulfilled through KingFlexy today. Acknowledge the rest so they are not
    // retried at us forever.
    if (product !== 'utilities') {
        console.log(`[KingFlexyWebhook] Ignoring product '${product}' for ${reference}`)
        return NextResponse.json({ received: true, ignored: product })
    }

    if (!reference) {
        return NextResponse.json({ error: 'Missing reference' }, { status: 400 })
    }

    const supabase = createServerClient() as any

    // Their reference is what we stored as external_transaction_id at dispatch. Fall
    // back to our own reference_code because the docs describe `reference` as "the
    // same value you sent (or that was echoed back)", which differs by product.
    let { data: order } = await supabase
        .from('utility_orders')
        .select('id, reference_code, service, status, bill_amount, account_name, external_transaction_id')
        .eq('external_transaction_id', reference)
        .maybeSingle()

    if (!order) {
        const byOurs = await supabase
            .from('utility_orders')
            .select('id, reference_code, service, status, bill_amount, account_name, external_transaction_id')
            .eq('reference_code', reference)
            .maybeSingle()
        order = byOurs.data
    }

    if (!order) {
        // 200, not 404: an unknown reference is not something they can fix by
        // retrying, and a non-2xx would just burn their one retry.
        console.warn(`[KingFlexyWebhook] No order matches reference ${reference}`)
        return NextResponse.json({ received: true, matched: false })
    }

    if (order.status === 'completed' || order.status === 'refunded') {
        return NextResponse.json({ received: true, alreadyFinal: order.status })
    }

    const label = isUtilityService(order.service) ? UTILITY_SERVICES[order.service].label : order.service

    // The payload is a notification, not a source of truth — their own docs say to
    // treat the status endpoint as authoritative. Re-reading also fetches
    // commission_earned, which the callback does not carry and which an API
    // partner's share is calculated from.
    const authoritative = order.external_transaction_id
        ? await getUtilityOrderStatus(order.external_transaction_id)
        : { success: false as const, error: 'no supplier reference on the order' }

    const settled = authoritative.success ? authoritative.status : undefined
    const eventSaysCompleted = event?.event === 'order.completed'

    if (settled === 'completed' || (!authoritative.success && eventSaysCompleted)) {
        if (authoritative.success) {
            // Commission must land on the row BEFORE finalising: the credit re-reads
            // the order and pays a partner a percentage of this figure.
            await supabase
                .from('utility_orders')
                .update({
                    commission: authoritative.commissionEarned ?? null,
                    account_name: authoritative.accountName ?? order.account_name ?? null,
                    provider_response: (authoritative.raw ?? null) as any,
                    updated_at: new Date().toISOString(),
                })
                .eq('id', order.id)
        }

        await finalizeUtilityOrder({ orderId: order.id, status: 'completed' })
        console.log(`[KingFlexyWebhook] ${order.reference_code} completed.`)
        return NextResponse.json({ received: true })
    }

    if (settled === 'failed' || settled === 'refunded' || (!authoritative.success && event?.event === 'order.failed')) {
        await finalizeUtilityOrder({
            orderId: order.id,
            status: 'failed',
            note: `KingFlexy reported the ${label} payment as failed.`,
            refund: true,
        })
        console.log(`[KingFlexyWebhook] ${order.reference_code} failed and was refunded.`)
        return NextResponse.json({ received: true })
    }

    // Still in flight upstream. Leave it; the cron will settle it.
    return NextResponse.json({ received: true, status: settled ?? 'unknown' })
}
