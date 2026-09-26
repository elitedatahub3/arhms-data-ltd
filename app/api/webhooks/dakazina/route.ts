import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { syncShopOrderStatus } from '@/lib/shop-service'
import { normaliseSupplierStatus } from '@/lib/order-status-display'
import crypto from 'crypto'

// DataKazina status webhook.
//
// This is the ONLY status channel for Dakazina orders. Their status endpoint
// (POST {base}/fetch-single-transaction) returns 404 "route could not be found",
// so unlike every sibling supplier there is NO reconciliation cron behind this —
// an event we drop is a completion nobody ever recovers. That single fact drives
// the two places this route deviates from the others, both marked below.
//
// Auth: their dashboard has a URL box and no header or secret field, so the secret
// has to ride in the query string:
//   https://arhmsgh.com/api/webhooks/dakazina?secret={your_secret}
// {your_secret} is a placeholder: replace it, braces included, with the value of
// the DAKAZINA_WEBHOOK_SECRET env var. Braces left in the registered URL 401.
// Apex host, never www — www 307s to the apex and the redirect strips credentials.
// Headers are still accepted first in case they ever add a field for them.
//
// Payload (their dashboard's example):
//   { id, type, status, previous_status, order_code, reference,
//     amount, user_id, occurred_at, test, metadata }
// Note there is no incoming_api_ref — the ref WE send at fulfillment is not echoed
// back — so matching goes through order_code/reference. See fulfillment-service.

function timingSafeEquals(a: string, b: string): boolean {
    const bufA = Buffer.from(a)
    const bufB = Buffer.from(b)
    // Length check first: timingSafeEqual throws on mismatched lengths.
    return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB)
}

function isAuthorized(request: NextRequest, secret: string): boolean {
    const bearer = request.headers.get('authorization')
    if (bearer?.startsWith('Bearer ') && timingSafeEquals(bearer.slice(7), secret)) return true

    const headerSecret = request.headers.get('x-dakazina-webhook-secret')
    if (headerSecret && timingSafeEquals(headerSecret, secret)) return true

    const querySecret = request.nextUrl.searchParams.get('secret')
    if (querySecret && timingSafeEquals(querySecret, secret)) return true

    return false
}

function mapDakazinaStatus(status: string): 'pending' | 'processing' | 'completed' | 'failed' {
    const s = normaliseSupplierStatus(status)
    const COMPLETED = ['completed', 'complete', 'delivered', 'success', 'successful', 'credited', 'fulfilled']
    const FAILED = ['failed', 'failure', 'cancelled', 'canceled', 'refund', 'refunded', 'rejected', 'reversed', 'declined']
    // 'waiting' is Dakazina's own held-for-review state; it surfaces as
    // "On Hold — Verifying" via VERIFYING_LABELS, not as a status change.
    // 'verified'/'unverified' are the two remaining dashboard triggers and are
    // deliberately absent: their meaning is unconfirmed, and an unlisted label
    // falls through to a non-terminal state rather than guessing at completion.
    const IN_FLIGHT = ['processing', 'pending', 'queued', 'in progress', 'waiting', 'verifying', 'on hold', 'onhold', 'awaiting verification', 'pending verification', 'under review']
    if (COMPLETED.includes(s)) return 'completed'
    if (FAILED.includes(s)) return 'failed'
    if (IN_FLIGHT.includes(s)) return 'processing'
    return 'pending'
}

export async function POST(request: NextRequest) {
    try {
        const secret = process.env.DAKAZINA_WEBHOOK_SECRET
        if (!secret) {
            console.error('[DakazinaWebhook] DAKAZINA_WEBHOOK_SECRET is not configured')
            // 503, not 401 — our misconfiguration, not a forged request.
            return NextResponse.json({ success: false, error: 'Webhook unavailable' }, { status: 503 })
        }

        if (!isAuthorized(request, secret)) {
            console.error('[DakazinaWebhook] Unauthorized delivery')
            return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
        }

        let payload: any
        try {
            payload = await request.json()
        } catch (err) {
            console.error('[DakazinaWebhook] Failed to parse payload:', err)
            return NextResponse.json({ success: false, error: 'Invalid payload' }, { status: 400 })
        }

        const {
            type, status, order_code, reference, transaction_code, transaction_id,
            // The ref WE send at /buy-data-package, under every spelling they might
            // echo it back as. This is our own orders.id, and it is the ONLY key we
            // control — worth far more than any code they mint, if they return it.
            incoming_api_ref, api_ref, client_reference, custom_reference,
        } = payload || {}

        if (type === 'test_event' || payload?.test === true) {
            console.log('[DakazinaWebhook] Test event received — acknowledged, no order touched')
            return NextResponse.json({ success: true, message: 'Test event received' }, { status: 200 })
        }

        // Their real events have never been observed, so log the WHOLE payload's shape:
        // which identifiers actually arrive is the open question this answers, and the
        // field names matter more than the values. Keys only — no values, since the
        // payload may carry a customer's number.
        console.log(
            `[DakazinaWebhook] event status='${status}' order_code='${order_code ?? ''}' ` +
            `reference='${reference ?? ''}' transaction_code='${transaction_code ?? ''}' ` +
            `keys=[${Object.keys(payload || {}).join(',')}]`
        )

        const newStatus = mapDakazinaStatus(String(status ?? ''))
        const isTerminal = newStatus === 'completed' || newStatus === 'failed'

        // Every identifier the event offers is tried, because which one we stamped
        // depends on WHEN the order was placed:
        //   • after the webhookRef fix  → dakazina_reference holds order_code
        //   • before it                 → it holds transaction_code, or our own order id
        // Including transaction_code/transaction_id is what gives the older backlog a
        // chance of matching at all. It costs nothing when absent, and the
        // exactly-one-match guard below still refuses to act on an ambiguous hit.
        const candidates = [order_code, reference, transaction_code, transaction_id]
            .filter(v => v !== undefined && v !== null && String(v).trim() !== '')
            .map(v => String(v))

        if (candidates.length === 0) {
            console.warn('[DakazinaWebhook] Event carried no usable identifier — cannot match')
            return NextResponse.json({ success: true, updated: 0 }, { status: 200 })
        }

        const supabase = createServerClient()

        // Our own order id, EMBEDDED in their reference. Confirmed from a live event:
        //
        //   reference = "875772ad44b-3808-4fab-8cd0-4c7d5998eeb30248781324"
        //                  └──────── 772ad44b-3808-4fab-8cd0-4c7d5998eeb3 ────────┘
        //
        // i.e. a 3-char prefix, our orders.id, then a 10-digit suffix. They do NOT
        // send incoming_api_ref as its own field, and transaction_code comes through
        // empty — their real keys are:
        //   type,status,previous_status,user_id,occurred_at,id,order_code,reference,
        //   amount,metadata
        // So this embedded id is the ONLY link between their event and our order.
        //
        // Scanned with a SUBSTRING search over every string the payload carries, not
        // anchored, because the affix lengths are theirs to change and only one real
        // sample has been seen. Wrong guesses cost nothing: a UUID that is not one of
        // ours simply matches no row.
        const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi

        const scanForIds = (value: any, depth = 0): string[] => {
            if (depth > 3 || value === null || value === undefined) return []
            if (typeof value === 'string') return value.match(UUID_RE) || []
            if (Array.isArray(value)) return value.flatMap(v => scanForIds(v, depth + 1))
            if (typeof value === 'object') return Object.values(value).flatMap(v => scanForIds(v, depth + 1))
            return []
        }

        // Explicit fields first, then anything else in the payload (metadata included).
        const ownIds = Array.from(new Set([
            ...scanForIds([incoming_api_ref, api_ref, client_reference, custom_reference]),
            ...scanForIds(reference),
            ...scanForIds(order_code),
            ...scanForIds(payload),
        ].map(v => v.toLowerCase())))

        if (ownIds.length > 0) {
            const { data: byOwnId, error: ownIdError } = await (supabase
                .from('orders') as any)
                .select('id, status, shop_order_id')
                .in('id', ownIds)
                .limit(2)

            if (ownIdError) {
                console.error(`[DakazinaWebhook] embedded-id lookup failed: ${ownIdError.message}`)
                return NextResponse.json({ success: false, error: 'Lookup failed' }, { status: 500 })
            }

            if (byOwnId && byOwnId.length === 1) {
                console.log(`[DakazinaWebhook] matched order ${byOwnId[0].id} via id embedded in their reference`)
                return await applyOutcome(supabase, byOwnId[0], newStatus, isTerminal, status)
            }

            if (byOwnId && byOwnId.length > 1) {
                console.error(`[DakazinaWebhook] AMBIGUOUS: embedded ids [${ownIds.join(', ')}] hit multiple orders — refusing`)
                return NextResponse.json({ success: true, updated: 0 }, { status: 200 })
            }

            console.warn(`[DakazinaWebhook] embedded ids [${ownIds.join(', ')}] matched no order — falling back to reference match`)
        }

        // Direct and storefront orders both stamp the supplier id on
        // orders.dakazina_reference, so this one lookup covers each.
        const { data: matches, error: lookupError } = await (supabase
            .from('orders') as any)
            .select('id, status, shop_order_id')
            .in('dakazina_reference', candidates)
            .limit(2)

        if (lookupError) {
            console.error(`[DakazinaWebhook] Lookup failed for [${candidates.join(', ')}]: ${lookupError.message}`)
            // DEVIATION 1 (no fallback cron): 5xx so they retry. A sibling supplier
            // would return 2xx here and let its cron reconcile; we have no cron.
            return NextResponse.json({ success: false, error: 'Lookup failed' }, { status: 500 })
        }

        if (!matches || matches.length === 0) {
            console.warn(`[DakazinaWebhook] No order matches [${candidates.join(', ')}]`)
            return NextResponse.json({ success: true, updated: 0 }, { status: 200 })
        }

        // Refuse to guess. Two rows sharing a reference means the stamp is not unique,
        // and completing an arbitrary one of them would be worse than completing none.
        if (matches.length > 1) {
            console.error(`[DakazinaWebhook] AMBIGUOUS: [${candidates.join(', ')}] matches multiple orders — refusing`)
            return NextResponse.json({ success: true, updated: 0 }, { status: 200 })
        }

        return await applyOutcome(supabase, matches[0], newStatus, isTerminal, status)

    } catch (error: any) {
        console.error('[DakazinaWebhook] Unhandled exception:', error)
        // DEVIATION 2 (no fallback cron): siblings swallow this as 2xx because their
        // cron will re-check. Nothing re-checks Dakazina, so ask for the retry.
        return NextResponse.json({ success: false, error: 'Internal error' }, { status: 500 })
    }
}

// Shared by both match paths (our own ref, and their codes) so a completion behaves
// identically however the order was found.
async function applyOutcome(
    supabase: any,
    order: { id: string; status: string; shop_order_id?: string | null },
    newStatus: string,
    isTerminal: boolean,
    rawStatus: any,
): Promise<NextResponse> {
    // Idempotent: only advance orders still in processing.
    if (order.status !== 'processing') {
        return NextResponse.json({ success: true, updated: 0 }, { status: 200 })
    }

    // Raw supplier label, display only. Its own statement, error ignored on
    // purpose: against a DB without the supplier_status migration PostgREST
    // rejects the whole statement, and a cosmetic label must never take order
    // completion down with it.
    const supplierLabel = normaliseSupplierStatus(String(rawStatus ?? '')) || null
    await (supabase.from('orders') as any)
        .update({ supplier_status: isTerminal ? null : supplierLabel })
        .eq('id', order.id)

    if (order.shop_order_id) {
        await (supabase.from('shop_orders') as any)
            .update({ supplier_status: isTerminal ? null : supplierLabel })
            .eq('id', order.shop_order_id)
    }

    // WAITING/PROCESSING are non-terminal: the order is already 'processing', so the
    // label above is all there is to record.
    if (!isTerminal) {
        console.log(`[DakazinaWebhook] order ${order.id}: supplier says "${rawStatus}" → ${newStatus} (no change)`)
        return NextResponse.json({ success: true, updated: 0 }, { status: 200 })
    }

    const { error: updErr } = await (supabase.from('orders') as any)
        .update({ status: newStatus, updated_at: new Date().toISOString() })
        .eq('id', order.id)
        // Second idempotency guard, at row level: two overlapping deliveries
        // cannot both count this order.
        .eq('status', 'processing')

    if (updErr) {
        console.error(`[DakazinaWebhook] orders update failed for ${order.id}: ${updErr.message}`)
        // DEVIATION 1 again — make them retry rather than lose the completion.
        return NextResponse.json({ success: false, error: 'Update failed' }, { status: 500 })
    }

    if (order.shop_order_id) {
        await (supabase.from('shop_orders') as any)
            .update({ status: newStatus, updated_at: new Date().toISOString() })
            .eq('id', order.shop_order_id)
            .eq('status', 'processing')
    }

    await syncShopOrderStatus(order.id, newStatus).catch(err =>
        console.error(`[DakazinaWebhook] syncShopOrderStatus failed for ${order.id}:`, err)
    )

    console.log(`[DakazinaWebhook] order ${order.id}: processing → ${newStatus}${newStatus === 'failed' ? ' (manual refund required)' : ''}`)

    return NextResponse.json({ success: true, updated: 1 }, { status: 200 })
}
