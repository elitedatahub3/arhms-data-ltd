import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { isCronAuthorized, cronUnauthorizedResponse } from '@/lib/cron-control'
import { sendPushToAdmins } from '@/lib/web-push'

/**
 * Surfaces airtime top-ups that went quiet.
 *
 * Two ways a leg gets stranded: the process died between claiming the row and
 * hearing back from Hubtel ('submitting'), or Hubtel accepted it with '0001' and
 * the callback never arrived ('pending').
 *
 * This sweep deliberately does NOT try to resolve them. Hubtel publishes no status
 * endpoint for Commission Services, and the transaction-status API is scoped to the
 * collection account. Guessing would mean either marking a delivered top-up failed
 * (and paying for it twice when an admin re-sends) or closing out one that never
 * landed. So it does the one safe thing: flags the order for a human and stops.
 *
 * Not gated on any enable flag — like verify-hubtel-payments, this exists to catch
 * money that has already moved, and a missing env var must not silently disable it.
 */
const STALE_MINUTES = 15
// Alerting on the same leg every five minutes forever would train admins to ignore
// the alert. One notification per leg, then it lives on in /admin/airtime.
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

        const { data: staleLegs, error } = await supabase
            .from('airtime_fulfillment_legs')
            .select('id, order_id, leg_index, amount, status, client_reference, created_at')
            .in('status', ['submitting', 'pending'])
            .lt('created_at', staleCutoff)
            .gt('created_at', alertFloor)
            .limit(25)

        if (error) {
            console.error('[CronAirtime] Leg query failed:', error)
            results.errors.push(`leg query: ${error.message}`)
        } else {
            for (const leg of (staleLegs || [])) {
                results.checked++
                try {
                    const { data: order } = await supabase
                        .from('airtime_orders')
                        .select('id, reference_code, network, beneficiary_phone, airtime_amount, fulfillment_note')
                        .eq('id', leg.order_id)
                        .single()

                    if (!order) continue

                    const ageMinutes = Math.round((Date.now() - new Date(leg.created_at).getTime()) / 60000)
                    const note = leg.status === 'submitting'
                        ? `Leg ${leg.leg_index} (GHS ${Number(leg.amount).toFixed(2)}) was sent to Hubtel ${ageMinutes} minutes ago but no response was ever recorded — the delivery state is UNKNOWN. Confirm in the Hubtel portal before re-sending.`
                        : `Leg ${leg.leg_index} (GHS ${Number(leg.amount).toFixed(2)}) was accepted by Hubtel ${ageMinutes} minutes ago but no callback has arrived. Confirm in the Hubtel portal.`

                    // Only write once — a note that already names this leg means we
                    // have alerted on it before.
                    if (String(order.fulfillment_note || '').includes(`Leg ${leg.leg_index} (GHS`)) continue

                    await supabase
                        .from('airtime_orders')
                        .update({ fulfillment_note: note, updated_at: new Date().toISOString() })
                        .eq('id', order.id)

                    await sendPushToAdmins({
                        title: '⏳ Airtime top-up unresolved',
                        body: `${order.reference_code} · ${order.network} → ${order.beneficiary_phone}. ${note}`,
                        url: '/admin/airtime',
                    }).catch(() => {})

                    results.flagged++
                    console.warn(`[CronAirtime] Flagged ${order.reference_code} leg ${leg.leg_index} (${leg.status}, ${ageMinutes}m old)`)
                } catch (err: any) {
                    results.errors.push(`${leg.client_reference}: ${err.message}`)
                }
            }
        }
    } catch (err: any) {
        console.error('[CronAirtime] Sweep failed:', err)
        results.errors.push(`sweep: ${err.message}`)
    }

    console.log('[CronAirtime] Run complete:', results)
    return NextResponse.json({ success: true, ...results })
}

// Accept any method (cron-job.org's sent method doesn't always match its UI); auth-gated.
export const POST = GET
export const PUT = GET
export const PATCH = GET
export const DELETE = GET

