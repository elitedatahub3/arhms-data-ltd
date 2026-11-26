/**
 * Special Bundles: one customer order delivered as N Datagod purchases ("legs")
 * of the same base bundle to the same number. See SPECIAL_MULTIPLIERS in
 * lib/datagod-bundles-service.ts.
 *
 * Each leg's reference is `<reference_code>:<leg_no>`, Datagod's idempotency key,
 * so sending a leg twice (cron racing the dispatcher, a resend after a timeout)
 * replays the original instead of buying again.
 *
 * Datagod allows ~10 purchases a minute per key, so legs go out in small batches:
 * the dispatcher sends the first few, then the cron and the buyer's History page
 * send the rest. The order settles once EVERY leg is final:
 *   all delivered  → completed
 *   none delivered → failed, full refund
 *   some delivered → completed, the failed share refunded to the wallet
 *
 * Never throws: it runs inside waitUntil() and from crons.
 */
import { createServerClient } from '@/lib/supabase'
import { sendPushToAdmins } from '@/lib/web-push'
import { mapKfBundleStatus } from '@/lib/kingflexy-bundles-service'
import { parseSpecialBundleId, purchaseBundleViaDatagod, getDgBundleOrderStatus } from '@/lib/datagod-bundles-service'
import { finalizeBundleOrder } from '@/lib/bundle-order-completion'

const BUNDLES_ADMIN_PATH = '/admin/standard-bundles'

export function isMultiLegOrder(order: any): boolean {
    return order?.provider === 'datagod' && !!parseSpecialBundleId(order?.dg_bundle_id)
}

export type LegProgressOutcome = 'completed' | 'refunded' | 'partial' | 'in_flight'

interface Budget {
    /** Purchase POSTs this call may make (Datagod purchase group: 10/min). */
    sends: number
    /** Status GETs this call may make (Datagod status group: 30/min). */
    checks: number
}

const legRef = (order: any, n: number) => `${order.reference_code}:${n}`

/** Create the N leg rows once. Re-running is a no-op. */
async function ensureLegs(supabase: any, order: any, legs: number): Promise<any[]> {
    const rows = Array.from({ length: legs }, (_, i) => ({
        order_id: order.id,
        leg_no: i + 1,
        reference: legRef(order, i + 1),
        status: 'pending',
    }))
    await supabase.from('bundle_order_legs').upsert(rows, { onConflict: 'order_id,leg_no', ignoreDuplicates: true })
    const { data } = await supabase.from('bundle_order_legs').select('*').eq('order_id', order.id).order('leg_no')
    return data || []
}

async function setLeg(supabase: any, leg: any, patch: Record<string, any>) {
    Object.assign(leg, patch)
    await supabase.from('bundle_order_legs').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', leg.id)
}

/**
 * Advance one Special Bundle order as far as the budget allows, then settle it if
 * every leg is final. Safe to call from anywhere, any number of times.
 */
export async function progressMultiLegOrder(order: any, budget: Budget): Promise<LegProgressOutcome> {
    const supabase = createServerClient() as any
    const spec = parseSpecialBundleId(order.dg_bundle_id)
    if (!spec) return 'in_flight'

    try {
        const legs = await ensureLegs(supabase, order, spec.legs)
        if (legs.length !== spec.legs) {
            console.error('[BundleLegs] Could not create legs for', order.reference_code, '(is migration 20261127010000 run?)')
            if (legs.length === 0) {
                // Legs are created before anything is sent, so none means nothing
                // was bought: refund rather than hold the buyer's money.
                await finalizeBundleOrder({ orderId: order.id, status: 'failed', refund: true, note: 'Special Bundle could not be started (legs table missing).', existingOrder: order })
                return 'refunded'
            }
            return 'in_flight'
        }
        const legCost = Math.round((Number(order.cost_amount) / spec.legs) * 100) / 100
        let stopAlert: string | null = null

        for (const leg of legs) {
            if (leg.status === 'completed' || leg.status === 'failed') continue

            // ── In flight or uncertain: ask Datagod first ────────────────────
            if (leg.status === 'processing' || leg.status === 'sending') {
                if (budget.checks <= 0) continue
                budget.checks--
                const st = await getDgBundleOrderStatus(leg.reference)
                if (st.found) {
                    if (st.status === 'completed') await setLeg(supabase, leg, { status: 'completed', provider_response: st.raw ?? null })
                    else if (st.status === 'failed' || st.status === 'refunded') await setLeg(supabase, leg, { status: 'failed', note: st.reason ?? `Datagod: ${st.status}`, provider_response: st.raw ?? null })
                    else if (leg.status === 'sending') await setLeg(supabase, leg, { status: 'processing' })
                    continue
                }
                // A plain 404 is the only proof Datagod never saw it: resend, same ref.
                if (!st.notFound || budget.sends <= 0) continue
            }

            // ── Send (pending, or a 'sending' leg Datagod never received) ────
            if (budget.sends <= 0) continue
            budget.sends--
            await setLeg(supabase, leg, { status: 'sending', sent_at: new Date().toISOString() })
            const r = await purchaseBundleViaDatagod({
                network: order.network,
                phone: order.beneficiary_phone,
                reference: leg.reference,
                dgBundleId: spec.baseId,
                maxCost: legCost,
            })

            if (r.outcome === 'accepted') {
                const s = mapKfBundleStatus(r.status)
                await setLeg(supabase, leg, {
                    status: s === 'completed' ? 'completed' : s === 'failed' || s === 'refunded' ? 'failed' : 'processing',
                    provider_response: r.raw ?? null,
                })
            } else if (r.outcome === 'definite_refusal' || r.outcome === 'kf_wallet_empty') {
                await setLeg(supabase, leg, { status: 'failed', note: (r.error || `HTTP ${r.httpStatus}`).slice(0, 500), provider_response: r.raw ?? null })
                // Whatever refused this leg (number not eligible, wallet empty, key
                // blocked) will refuse the rest: stop instead of hammering Datagod.
                for (const other of legs) {
                    if (other.status === 'pending') await setLeg(supabase, other, { status: 'failed', note: `Not sent: leg ${leg.leg_no} was refused.` })
                }
                if (r.outcome === 'kf_wallet_empty') stopAlert = 'Top up the Datagod wallet'
                else if (r.keyProblem) stopAlert = 'Datagod refused our account'
                break
            } else {
                // retry_same_ref / unknown: stays 'sending'; the next pass asks
                // Datagod and only resends on a plain 404.
                await setLeg(supabase, leg, { note: (r.error || '').slice(0, 500), provider_response: r.raw ?? null })
            }
        }

        if (stopAlert) {
            await sendPushToAdmins({
                title: stopAlert,
                body: `Special Bundle ${order.reference_code} was stopped: ${legs.find(l => l.status === 'failed')?.note ?? 'refused'}`.slice(0, 200),
                url: BUNDLES_ADMIN_PATH,
            }).catch(() => {})
        }

        return await settleIfDone(supabase, order, legs)
    } catch (e) {
        console.error('[BundleLegs] Unexpected error for', order?.reference_code, e)
        return 'in_flight'
    }
}

async function settleIfDone(supabase: any, order: any, legs: any[]): Promise<LegProgressOutcome> {
    const n = legs.length
    const delivered = legs.filter(l => l.status === 'completed').length
    const failed = legs.filter(l => l.status === 'failed').length
    const open = n - delivered - failed

    if (open > 0) {
        const waiting = legs.filter(l => l.status === 'pending').length
        await supabase.from('bundle_orders').update({
            fulfillment_note: `Special x${n}: ${delivered} delivered, ${open - waiting} in flight, ${waiting} waiting, ${failed} failed.`,
            updated_at: new Date().toISOString(),
        }).eq('id', order.id).eq('status', 'processing')
        return 'in_flight'
    }

    if (delivered === n) {
        await finalizeBundleOrder({ orderId: order.id, status: 'completed', note: `Special x${n}: all ${n} delivered.`, existingOrder: order })
        return 'completed'
    }

    if (delivered === 0) {
        const why = legs.find(l => l.note)?.note
        await finalizeBundleOrder({ orderId: order.id, status: 'failed', refund: true, note: `Datagod: none of the ${n} parts were delivered${why ? ` (${why})` : ''}.`.slice(0, 500), existingOrder: order })
        return 'refunded'
    }

    const refundAmount = Math.round(Number(order.total_paid) * (failed / n) * 100) / 100
    await finalizeBundleOrder({
        orderId: order.id,
        status: 'completed',
        partialRefund: refundAmount,
        note: `Special x${n}: ${delivered} of ${n} delivered; GHS ${refundAmount.toFixed(2)} refunded for the ${failed} that failed.`,
        existingOrder: order,
    })
    return 'partial'
}
