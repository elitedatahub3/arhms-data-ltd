import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { sendPushToAdmins } from '@/lib/web-push'
import { getAirtimeOrderStatus } from '@/lib/airtime-provider'
import { finalizeAirtimeOrder } from '@/lib/airtime-order-completion'

/**
 * Reconciles airtime top-ups against KingFlexy.
 *
 * This does something its Hubtel predecessor could not. Hubtel Commission Services
 * publishes no status endpoint for airtime, so /api/cron/sync-hubtel-airtime could
 * only flag a stranded leg and stop — guessing would mean leaving a delivered top-up
 * marked pending forever, or re-sending one that already landed. KingFlexy exposes
 * GET /airtime/orders/{reference}, so here the answer can simply be asked for.
 *
 * Not gated on any enable flag, like verify-hubtel-payments and
 * sync-kingflexy-utility: this exists to settle money that has already moved, and a
 * missing toggle must not silently disable it.
 */
const STALE_MINUTES = 2
// One alert per order. Re-notifying every five minutes forever trains admins to
// ignore the alert entirely.
const ALERT_CUTOFF_MINUTES = 60
const BATCH = 25

/**
 * How old a paid-but-undispatched order may be before this sweep will still send it.
 *
 * Mirrors sync-kingflexy-utility's rescue sweep: the dispatcher can exit before
 * claiming a leg (auto-fulfilment was off at creation time, then flipped on later),
 * leaving a paid order with no provider and no leg row that nothing else ever looks
 * at again. Bounded rather than unlimited: airtime cannot be recalled, so sending a
 * days-old top-up unasked is its own kind of wrong — inside the window the customer
 * is still waiting, outside it a human decides.
 */
const RESCUE_WINDOW_HOURS = 24

export async function GET(request: NextRequest) {
    const authHeader = request.headers.get('authorization')
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const supabase = createServerClient() as any
    const results = { checked: 0, completed: 0, failed: 0, pending: 0, rescued: 0, flagged: 0, errors: [] as string[] }

    try {
        const staleCutoff = new Date(Date.now() - STALE_MINUTES * 60 * 1000).toISOString()

        // ── Sweep 1: legs already sent to KingFlexy, awaiting final status ──────
        const { data: openLegs, error } = await supabase
            .from('airtime_fulfillment_legs')
            .select('id, order_id, client_reference, amount, status, created_at, airtime_orders!inner(id, reference_code, network, beneficiary_phone, airtime_amount, status, provider, created_at)')
            .in('status', ['submitting', 'pending'])
            .eq('airtime_orders.provider', 'kingflexy')
            .lt('created_at', staleCutoff)
            .order('created_at', { ascending: true })
            .limit(BATCH)

        if (error) {
            console.error('[CronKfAirtime] Leg query failed:', error)
            return NextResponse.json({ error: error.message }, { status: 500 })
        }

        for (const leg of (openLegs || [])) {
            results.checked++
            const order = leg.airtime_orders

            if (order.status !== 'processing' && order.status !== 'pending') {
                // Already resolved by another path (admin action, race with the
                // webhook-less flow) — nothing left for this sweep to do.
                continue
            }

            const status = await getAirtimeOrderStatus(leg.client_reference)

            if (!status.success) {
                // Could not reach them, or they do not recognise the reference. Leave
                // the leg exactly as it is and try again next sweep.
                results.errors.push(`${order.reference_code}: ${status.error}`)
                continue
            }

            if (status.status === 'completed') {
                await supabase
                    .from('airtime_fulfillment_legs')
                    .update({ status: 'success', raw: (status.raw ?? null) as any, updated_at: new Date().toISOString() })
                    .eq('id', leg.id)

                await finalizeAirtimeOrder({ orderId: order.id, status: 'completed' })
                results.completed++
                continue
            }

            if (status.status === 'failed') {
                // They tell us plainly the top-up failed. Airtime has no automated
                // refund path (it may still have landed before the failure was
                // reported), so this returns the order to 'pending' for a human
                // rather than closing it out — same as the Hubtel webhook's handling
                // of a failed leg.
                await supabase
                    .from('airtime_fulfillment_legs')
                    .update({ status: 'failed', raw: (status.raw ?? null) as any, updated_at: new Date().toISOString() })
                    .eq('id', leg.id)

                const ageMin = (Date.now() - new Date(leg.created_at).getTime()) / 60000
                const note = `KingFlexy reported this top-up as failed. Confirm on their dashboard before refunding.`

                await supabase
                    .from('airtime_orders')
                    .update({ status: 'pending', fulfillment_note: note, updated_at: new Date().toISOString() })
                    .eq('id', order.id)

                if (ageMin < ALERT_CUTOFF_MINUTES) {
                    await sendPushToAdmins({
                        title: '⚠️ Airtime top-up failed',
                        body: `${order.network} GHS ${Number(order.airtime_amount).toFixed(2)} → ${order.beneficiary_phone}. ${note}`,
                        url: '/admin/airtime',
                    }).catch(() => {})
                }

                results.failed++
                continue
            }

            results.pending++
        }

        // ── Sweep 2: paid but never dispatched ───────────────────────────────
        // Distinct from the sweep above, which chases legs already sent. These were
        // charged and then dropped — the dispatcher returned before claiming, so
        // they carry no provider and no leg row and nothing else ever looks at them.
        const rescueFloor = new Date(Date.now() - RESCUE_WINDOW_HOURS * 3600 * 1000).toISOString()

        const { data: undispatched } = await supabase
            .from('airtime_orders')
            .select('id, reference_code, network, beneficiary_phone, airtime_amount, type, created_at')
            .eq('status', 'pending')
            .is('provider', null)
            .neq('type', 'mashup')
            .lt('created_at', staleCutoff)
            .order('created_at', { ascending: true })
            .limit(BATCH)

        for (const order of (undispatched || [])) {
            results.checked++

            if (order.created_at < rescueFloor) {
                // Too old to send unasked. Surface it once and leave the call to a
                // human — see RESCUE_WINDOW_HOURS.
                results.flagged++
                await sendPushToAdmins({
                    title: '⚠️ Paid airtime order was never sent',
                    body: `${order.reference_code}: ${order.network} GHS ${Number(order.airtime_amount).toFixed(2)} → ${order.beneficiary_phone} was charged but never dispatched, and is now over ${RESCUE_WINDOW_HOURS}h old. Fulfil it by hand.`,
                    url: '/admin/airtime',
                }).catch(() => {})
                continue
            }

            // triggerAirtimeFulfillment is the only safe way to send one: it claims
            // the leg with an insert-before-call, so this racing the admin's own
            // retry cannot top up the same order twice.
            const { triggerAirtimeFulfillment } = await import('@/lib/airtime-fulfillment-dispatcher')
            const sent = await triggerAirtimeFulfillment(order.id)
            if (sent.dispatched) {
                results.rescued++
                console.log(`[CronKfAirtime] Rescued undispatched order ${order.reference_code}`)
            } else {
                results.errors.push(`${order.reference_code}: ${sent.reason}`)
            }
        }

        return NextResponse.json({ success: true, ...results })
    } catch (err: any) {
        console.error('[CronKfAirtime] Unexpected error:', err)
        return NextResponse.json({ error: String(err?.message || err) }, { status: 500 })
    }
}
