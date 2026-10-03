import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { isCronAuthorized, cronUnauthorizedResponse } from '@/lib/cron-control'
import { sendPushToAdmins } from '@/lib/web-push'
import { UTILITY_SERVICES, isUtilityService } from '@/lib/hubtel-utility-service'

/**
 * Surfaces utility bill payments that went quiet.
 *
 * Two ways an order gets stranded: the process died between claiming
 * dispatch_claimed_at and hearing back from Hubtel (still 'pending' with a claim
 * stamp), or Hubtel accepted it with '0001' and the callback never arrived
 * ('processing').
 *
 * This sweep deliberately does NOT try to resolve them, exactly as
 * /api/cron/sync-hubtel-airtime does not. Hubtel publishes no status endpoint for
 * Commission Services, and the transaction-status API is scoped to the collection
 * account. Guessing would mean either refunding a bill that was actually paid or
 * closing out one that never was. So it does the one safe thing: flags the order for
 * a human and stops.
 *
 * Not gated on any enable flag — like verify-hubtel-payments, this exists to catch
 * money that has already moved, and a missing env var must not silently disable it.
 */
const STALE_MINUTES = 15
// Alerting on the same order every five minutes forever would train admins to
// ignore the alert. One notification per order, then it lives on in /admin/utilities.
const ALERT_CUTOFF_MINUTES = 60

export async function GET(request: NextRequest) {
    if (!isCronAuthorized(request)) {
        return cronUnauthorizedResponse()
    }

    const supabase = createServerClient() as any
    const results = { checked: 0, flagged: 0, errors: [] as string[] }

    try {
        const staleCutoff = new Date(Date.now() - STALE_MINUTES * 60 * 1000).toISOString()
        const alertFloor = new Date(Date.now() - ALERT_CUTOFF_MINUTES * 60 * 1000).toISOString()

        const { data: staleOrders, error } = await supabase
            .from('utility_orders')
            .select('id, reference_code, service, account_number, bill_amount, status, dispatch_claimed_at, fulfillment_note, created_at')
            .in('status', ['pending', 'processing'])
            .not('dispatch_claimed_at', 'is', null)
            .lt('created_at', staleCutoff)
            .gt('created_at', alertFloor)
            .limit(25)

        if (error) {
            console.error('[CronUtility] Order query failed:', error)
            results.errors.push(`order query: ${error.message}`)
        } else {
            for (const order of (staleOrders || [])) {
                results.checked++
                try {
                    // A note already on the order means we have alerted on it before.
                    if (String(order.fulfillment_note || '').includes('Confirm in the Hubtel portal')) continue

                    const label = isUtilityService(order.service) ? UTILITY_SERVICES[order.service].label : order.service
                    const ageMinutes = Math.round((Date.now() - new Date(order.created_at).getTime()) / 60000)

                    const note = order.status === 'pending'
                        ? `This ${label} payment (GHS ${Number(order.bill_amount).toFixed(2)}) was sent to Hubtel ${ageMinutes} minutes ago but no response was ever recorded — the delivery state is UNKNOWN. Confirm in the Hubtel portal before refunding or re-sending.`
                        : `Hubtel accepted this ${label} payment (GHS ${Number(order.bill_amount).toFixed(2)}) ${ageMinutes} minutes ago but no callback has arrived. Confirm in the Hubtel portal.`

                    await supabase
                        .from('utility_orders')
                        .update({ fulfillment_note: note, updated_at: new Date().toISOString() })
                        .eq('id', order.id)

                    await sendPushToAdmins({
                        title: '⏳ Utility bill payment unresolved',
                        body: `${order.reference_code} · ${label} → ${order.account_number}. ${note}`,
                        url: '/admin/utilities',
                    }).catch(() => {})

                    results.flagged++
                    console.warn(`[CronUtility] Flagged ${order.reference_code} (${order.status}, ${ageMinutes}m old)`)
                } catch (err: any) {
                    results.errors.push(`${order.reference_code}: ${err.message}`)
                }
            }
        }
    } catch (err: any) {
        console.error('[CronUtility] Sweep failed:', err)
        results.errors.push(`sweep: ${err.message}`)
    }

    console.log('[CronUtility] Run complete:', results)
    return NextResponse.json({ success: true, ...results })
}

// Accept any method (cron-job.org's sent method doesn't always match its UI); auth-gated.
export const POST = GET
export const PUT = GET
export const PATCH = GET
export const DELETE = GET

