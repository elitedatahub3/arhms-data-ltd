import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { sendPushToAdmins } from '@/lib/web-push'
import { UTILITY_SERVICES, isUtilityService } from '@/lib/hubtel-utility-service'
import { getUtilityOrderStatus } from '@/lib/utility-provider'
import { finalizeUtilityOrder } from '@/lib/utility-order-completion'

/**
 * Reconciles bill payments against KingFlexy.
 *
 * This does something its Hubtel predecessor could not. Hubtel publishes no status
 * endpoint for Commission Services, so /api/cron/sync-hubtel-utility can only flag a
 * stranded order and stop — guessing would mean refunding a bill that was paid, or
 * closing out one that never was. KingFlexy exposes GET /utilities/orders/{reference},
 * so here the answer can simply be asked for.
 *
 * It is the fallback that matters, not a nicety: their webhooks are fire-and-forget
 * with a single retry and no replay, so any delivery lost to a deploy or a blip is
 * lost for good. Without this sweep those orders would sit 'processing' forever with
 * the customer already charged.
 *
 * Not gated on any enable flag, like verify-hubtel-payments: this exists to settle
 * money that has already moved, and a missing toggle must not silently disable it.
 */
const STALE_MINUTES = 2
// One alert per order. Re-notifying every five minutes forever trains admins to
// ignore the alert entirely.
const ALERT_CUTOFF_MINUTES = 60
const BATCH = 25

/**
 * How old a paid-but-undispatched order may be before this sweep will still send it.
 *
 * Both reconciliation crons used to filter on `dispatch_claimed_at IS NOT NULL`, so
 * an order that was PAID but never dispatched was invisible to them permanently. Two
 * real ECG payments sat that way — one for 17 days — because the dispatcher exits on
 * the auto-fulfilment flag BEFORE it claims, leaving provider and
 * dispatch_claimed_at null. Nothing else in the system ever looks at those rows.
 *
 * Bounded rather than unlimited on purpose. Paying a days-old bill is its own kind of
 * wrong: the customer has very likely paid it elsewhere by then, and a bill payment
 * cannot be recalled. Inside the window the customer is still waiting; outside it, a
 * human decides between fulfilling and refunding.
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

        const { data: openOrders, error } = await supabase
            .from('utility_orders')
            .select('id, reference_code, external_transaction_id, service, account_number, account_name, bill_amount, total_paid, status, dispatch_claimed_at, created_at')
            .in('status', ['pending', 'processing'])
            .not('dispatch_claimed_at', 'is', null)
            .lt('created_at', staleCutoff)
            .order('created_at', { ascending: true })
            .limit(BATCH)

        if (error) {
            console.error('[CronKfUtility] Order query failed:', error)
            return NextResponse.json({ error: error.message }, { status: 500 })
        }

        for (const order of (openOrders || [])) {
            results.checked++
            const label = isUtilityService(order.service) ? UTILITY_SERVICES[order.service].label : order.service

            // Claimed but no supplier reference means the process died between
            // claiming the latch and hearing back. We cannot ask about an order we
            // have no handle on, and re-sending could pay the bill twice — so this
            // is the one case that still needs a human.
            if (!order.external_transaction_id) {
                const ageMin = (Date.now() - new Date(order.created_at).getTime()) / 60000
                if (ageMin < ALERT_CUTOFF_MINUTES) {
                    results.flagged++
                    await sendPushToAdmins({
                        title: '⚠️ Bill payment with no supplier reference',
                        body: `${order.reference_code}: ${label} GHS ${Number(order.bill_amount).toFixed(2)} was claimed but never got a KingFlexy reference. Check their dashboard before re-sending.`,
                        url: '/admin/utilities',
                    }).catch(() => {})
                }
                continue
            }

            const status = await getUtilityOrderStatus(order.external_transaction_id)

            if (!status.success) {
                // Could not reach them, or they do not recognise the reference. Leave
                // the order exactly as it is and try again next sweep.
                results.errors.push(`${order.reference_code}: ${status.error}`)
                continue
            }

            if (status.status === 'completed') {
                // Write their realised commission first: creditCommissionForOrder
                // re-reads the row and pays an API partner a share of this number, so
                // it has to be on the row before the order is finalised.
                await supabase
                    .from('utility_orders')
                    .update({
                        commission: status.commissionEarned ?? null,
                        account_name: status.accountName ?? order.account_name ?? null,
                        provider_response: (status.raw ?? null) as any,
                        updated_at: new Date().toISOString(),
                    })
                    .eq('id', order.id)

                await finalizeUtilityOrder({ orderId: order.id, status: 'completed' })
                results.completed++
                continue
            }

            if (status.status === 'failed' || status.status === 'refunded') {
                // They tell us plainly that the bill was not paid, so the customer's
                // money is ours to give back.
                await finalizeUtilityOrder({
                    orderId: order.id,
                    status: 'failed',
                    note: `KingFlexy reported the ${label} payment as ${status.status}.`,
                    refund: true,
                })
                results.failed++
                continue
            }

            results.pending++
        }

        // ── Paid but never dispatched ────────────────────────────────────────
        // Distinct from the sweep above, which chases orders already sent. These were
        // charged and then dropped — the dispatcher returned before claiming, so they
        // carry no provider and no claim stamp and no other code path will ever look
        // at them again.
        const rescueFloor = new Date(Date.now() - RESCUE_WINDOW_HOURS * 3600 * 1000).toISOString()

        const { data: undispatched } = await supabase
            .from('utility_orders')
            .select('id, reference_code, service, bill_amount, account_number, created_at')
            .eq('status', 'pending')
            .eq('payment_status', 'paid')
            .is('dispatch_claimed_at', null)
            .lt('created_at', new Date(Date.now() - STALE_MINUTES * 60 * 1000).toISOString())
            .order('created_at', { ascending: true })
            .limit(BATCH)

        for (const order of (undispatched || [])) {
            const label = isUtilityService(order.service) ? UTILITY_SERVICES[order.service].label : order.service
            results.checked++

            if (order.created_at < rescueFloor) {
                // Too old to send unasked. Surface it once and leave the call to a
                // human — see RESCUE_WINDOW_HOURS.
                results.flagged++
                await sendPushToAdmins({
                    title: '⚠️ Paid bill was never sent',
                    body: `${order.reference_code}: ${label} GHS ${Number(order.bill_amount).toFixed(2)} → ${order.account_number} was charged but never dispatched, and is now over ${RESCUE_WINDOW_HOURS}h old. Fulfil or refund it by hand.`,
                    url: '/admin/utilities',
                }).catch(() => {})
                continue
            }

            // triggerUtilityFulfillment is the only safe way to send one: it claims
            // dispatch_claimed_at with a conditional UPDATE first, so this racing the
            // admin Retry button cannot pay the same bill twice.
            const { triggerUtilityFulfillment } = await import('@/lib/utility-fulfillment-dispatcher')
            const sent = await triggerUtilityFulfillment(order.id)
            if (sent.dispatched) {
                results.rescued++
                console.log(`[CronKfUtility] Rescued undispatched order ${order.reference_code}`)
            } else {
                results.errors.push(`${order.reference_code}: ${sent.reason}`)
            }
        }

        return NextResponse.json({ success: true, ...results })
    } catch (err: any) {
        console.error('[CronKfUtility] Unexpected error:', err)
        return NextResponse.json({ error: String(err?.message || err) }, { status: 500 })
    }
}
