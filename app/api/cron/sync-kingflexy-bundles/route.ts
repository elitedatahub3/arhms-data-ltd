import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { sendPushToAdmins } from '@/lib/web-push'
import { reconcileBundleOrder, retryMissedRefund } from '@/lib/bundle-settlement'
import { triggerBundleDispatch, BUNDLES_ADMIN_PATH } from '@/lib/bundle-dispatcher'

/**
 * Reconciles Standard Bundle orders against KingFlexy. Schedule on cron-job.org
 * every 2–5 minutes, non-www URL, `Authorization: Bearer $CRON_SECRET`.
 *
 * Not gated on CRON_JOBS_ENABLED, like sync-kingflexy-utility: it settles money
 * that has already moved, and a missing toggle must not silently disable it.
 *
 *  1. 'processing' orders older than STALE_MINUTES: ask KingFlexy. A 404 means they
 *     never received it, so it is re-sent with the SAME reference — safe, because
 *     that reference is their idempotency key.
 *  2. Paid but never dispatched (auto-dispatch was off, or the function died before
 *     claiming): dispatch, inside RESCUE_WINDOW_HOURS.
 *  3. Older than RESCUE_WINDOW_HOURS and still open: alert an admin once.
 */
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const STALE_MINUTES = 2
const BATCH = 25
const RESCUE_WINDOW_HOURS = 24

export async function GET(request: NextRequest) {
    if (request.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const supabase = createServerClient() as any
    const results = { checked: 0, rescued: 0, flagged: 0, errors: [] as string[], outcomes: {} as Record<string, number> }
    const bump = (k: string) => { results.outcomes[k] = (results.outcomes[k] || 0) + 1 }

    try {
        const staleCutoff = new Date(Date.now() - STALE_MINUTES * 60_000).toISOString()
        const rescueFloor = new Date(Date.now() - RESCUE_WINDOW_HOURS * 3_600_000).toISOString()

        // ── 1. In flight ─────────────────────────────────────────────────────
        const { data: inFlight, error } = await supabase
            .from('bundle_orders')
            .select('*')
            .eq('status', 'processing')
            .lt('updated_at', staleCutoff)
            .order('updated_at', { ascending: true })
            .limit(BATCH)

        if (error) {
            console.error('[CronKfBundles] Query failed:', error)
            return NextResponse.json({ error: error.message }, { status: 500 })
        }

        for (const order of (inFlight || [])) {
            results.checked++
            const outcome = await reconcileBundleOrder(order, { resendIfMissing: true })
            bump(outcome)

            if ((outcome === 'in_flight' || outcome === 'status_unavailable') && order.created_at < rescueFloor && !order.flagged_at) {
                results.flagged++
                await flag(supabase, order, `has been processing at KingFlexy for over ${RESCUE_WINDOW_HOURS}h. Check it with them, then complete or refund it.`)
            } else if (outcome === 'in_flight' || outcome === 'status_unavailable' || outcome === 'resent') {
                // Touch updated_at so the oldest rows do not hog every batch.
                await supabase.from('bundle_orders').update({ updated_at: new Date().toISOString() }).eq('id', order.id).eq('status', 'processing')
            }
        }

        // ── 2/3. Paid, never dispatched ──────────────────────────────────────
        const { data: undispatched } = await supabase
            .from('bundle_orders')
            .select('*')
            .eq('status', 'pending')
            .eq('payment_status', 'paid')
            .lt('created_at', staleCutoff)
            .is('flagged_at', null)
            .order('created_at', { ascending: true })
            .limit(BATCH)

        for (const order of (undispatched || [])) {
            results.checked++
            if (order.created_at < rescueFloor) {
                results.flagged++
                await flag(supabase, order, `was paid but never sent, and is over ${RESCUE_WINDOW_HOURS}h old. Send or refund it by hand.`)
                continue
            }
            const sent = await triggerBundleDispatch(order.id)
            if (sent.dispatched) results.rescued++
            else if (sent.reason !== 'auto-dispatch is off') results.errors.push(`${order.reference_code}: ${sent.reason}`)
        }

        // ── 4. Failed but never refunded (the wallet credit errored) ─────────
        const { data: owed } = await supabase
            .from('bundle_orders')
            .select('*')
            .eq('status', 'failed')
            .eq('payment_status', 'paid')
            .limit(BATCH)

        for (const order of (owed || [])) {
            results.checked++
            if (await retryMissedRefund(order)) bump('refund_retried')
            else results.errors.push(`${order.reference_code}: refund retry failed`)
        }

        return NextResponse.json({ success: true, ...results })
    } catch (err: any) {
        console.error('[CronKfBundles] Unexpected error:', err)
        return NextResponse.json({ error: String(err?.message || err) }, { status: 500 })
    }
}

async function flag(supabase: any, order: any, why: string) {
    await supabase.from('bundle_orders').update({ flagged_at: new Date().toISOString() }).eq('id', order.id)
    await sendPushToAdmins({
        title: 'Standard Bundle needs attention',
        body: `${order.reference_code}: ${order.network} ${order.bundle_label} to ${order.beneficiary_phone} ${why}`,
        url: BUNDLES_ADMIN_PATH,
    }).catch(() => {})
}
