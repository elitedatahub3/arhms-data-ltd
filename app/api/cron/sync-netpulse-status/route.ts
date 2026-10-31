import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { checkOrderStatus } from '@/lib/netpulse-service'
import { areCronJobsEnabled, cronDisabledResponse, isCronAuthorized, cronUnauthorizedResponse } from '@/lib/cron-control'

// NetPulse has no webhook — polling GET /api/v1/order-status/{reference} is the
// ONLY way an order reaches a terminal state. Mirrors sync-eazydata-status.
//
// Rules (supplier label → mapped status, see mapNetPulseStatus):
//   "Delivered"/"completed"        → completed : update order to completed
//   "failed"/"cancelled"/"refunded"→ failed    : update order to failed (admin does manual refund)
//   "Verifying"/"On Hold"          → processing: do nothing, re-poll next run
//   Order already completed or pending : skip (only process orders in processing state)

// This cron polls the supplier once PER ORDER, serially. Without a duration cap the
// platform kills the function mid-loop and every order after that point is silently
// skipped — so give it room, then stop ourselves just short of the kill with a clean
// response. Combined with oldest-first ordering, the next run resumes where we left off.
export const maxDuration = 60
const RUN_BUDGET_MS = 50_000

export async function GET(request: NextRequest) {
    if (!areCronJobsEnabled()) return cronDisabledResponse()

    const startedAt = Date.now()
    const outOfTime = () => Date.now() - startedAt > RUN_BUDGET_MS

    if (!isCronAuthorized(request)) {
        return cronUnauthorizedResponse()
    }

    const supabase = createServerClient()
    let totalChecked = 0
    let totalUpdated = 0
    let totalFailed = 0
    const errors: string[] = []

    // Tally of the supplier's RAW status labels for orders that did NOT move.
    // mapNetPulseStatus matches a hand-transcribed list; a label outside it parks
    // an order in processing forever, and the console log that would reveal it is
    // only visible to whoever can read the platform logs. Returning the tally
    // makes a stuck-label diagnosable from the response alone. Labels only —
    // no order ids, no phone numbers.
    const supplierLabelCounts: Record<string, number> = {}
    const noteSupplierLabel = (raw: string | undefined) => {
        const label = (raw || '').trim().toLowerCase() || '(empty)'
        supplierLabelCounts[label] = (supplierLabelCounts[label] || 0) + 1
    }

    // ── Part A: shop_orders ───────────────────────────────────────────────────
    try {
        const { data: shopOrders, error: shopError } = await (supabase
            .from('shop_orders') as any)
            .select('id, netpulse_reference, status')
            .eq('fulfilled_by', 'netpulse')
            .eq('status', 'processing')      // only orders currently in processing
            .not('netpulse_reference', 'is', null)
            // Oldest first: without an explicit order Postgres returns an arbitrary
            // (but stable) page, so anything past the limit is NEVER checked and the
            // backlog starves itself. Oldest-first guarantees stuck orders drain.
            .order('created_at', { ascending: true })
            .limit(50)

        if (shopError) {
            errors.push(`shop_orders query failed: ${shopError.message}`)
        } else {
            for (const order of shopOrders || []) {
                if (outOfTime()) {
                    errors.push('shop_orders: run budget exhausted — remaining orders deferred to next run')
                    break
                }
                // Extra safety: skip if somehow already completed or pending
                if (order.status === 'completed' || order.status === 'pending') continue

                totalChecked++
                try {
                    const statusResult = await checkOrderStatus(order.netpulse_reference)
                    if (!statusResult.success) continue

                    const newStatus = statusResult.status

                    // Raw supplier label, for display only (see lib/order-status-display).
                    // Nulled on terminal states so a stale "verifying" can't outlive
                    // the order it described.
                    //
                    // Written in its OWN statement, never merged into the status update
                    // below, and its error is deliberately ignored. supplier_status is a
                    // later addition than this route: if the code ever runs against a DB
                    // where the migration hasn't been applied, PostgREST rejects the
                    // whole statement — merging it would take order completion down with
                    // it. Losing a cosmetic label is acceptable; losing completions is not.
                    const supplierLabel = (statusResult.message || '').trim().toLowerCase() || null
                    const isTerminal = newStatus === 'completed' || newStatus === 'failed'
                    await (supabase.from('shop_orders') as any)
                        .update({ supplier_status: isTerminal ? null : supplierLabel })
                        .eq('id', order.id)

                    if (newStatus === 'completed') {
                        const { error: updateError } = await (supabase
                            .from('shop_orders') as any)
                            .update({ status: 'completed', updated_at: new Date().toISOString() })
                            .eq('id', order.id)
                        if (updateError) {
                            errors.push(`shop_orders update failed for ${order.id}: ${updateError.message}`)
                            totalFailed++
                        } else {
                            console.log(`[NetPulseCron] shop_orders ${order.id}: processing → completed`)
                            totalUpdated++
                        }
                    } else if (newStatus === 'failed') {
                        // NetPulse failed — mark failed, admin handles manual refund
                        const { error: updateError } = await (supabase
                            .from('shop_orders') as any)
                            .update({ status: 'failed', updated_at: new Date().toISOString() })
                            .eq('id', order.id)
                        if (updateError) {
                            errors.push(`shop_orders update failed for ${order.id}: ${updateError.message}`)
                            totalFailed++
                        } else {
                            console.log(`[NetPulseCron] shop_orders ${order.id}: processing → failed (manual refund required)`)
                            totalUpdated++
                        }
                    } else {
                        // Still in flight — supplier_status above now carries the sub-state
                        // so the UI can show "Verifying" rather than a bare "Processing".
                        // Log + tally the RAW label too: mapNetPulseStatus works off a
                        // hand-transcribed list, so an unrecognised string parks the
                        // order here forever.
                        noteSupplierLabel(statusResult.message)
                        console.log(`[NetPulseCron] shop_orders ${order.id}: supplier says "${statusResult.message}" → ${newStatus} (no change)`)
                    }
                } catch (orderErr: any) {
                    errors.push(`shop_orders exception for ${order.id}: ${orderErr.message}`)
                    totalFailed++
                }
            }
        }
    } catch (partAErr: any) {
        errors.push(`Part A failed: ${partAErr.message}`)
    }

    // ── Part B: orders ────────────────────────────────────────────────────────
    try {
        const { data: mainOrders, error: mainError } = await (supabase
            .from('orders') as any)
            .select('id, netpulse_reference, status')
            .eq('fulfillment_method', 'netpulse')
            .eq('status', 'processing')
            .not('netpulse_reference', 'is', null)
            // Oldest first: without an explicit order Postgres returns an arbitrary
            // (but stable) page, so anything past the limit is NEVER checked and the
            // backlog starves itself. Oldest-first guarantees stuck orders drain.
            .order('created_at', { ascending: true })
            .limit(50)

        if (mainError) {
            errors.push(`orders query failed: ${mainError.message}`)
        } else {
            for (const order of mainOrders || []) {
                if (outOfTime()) {
                    errors.push('orders: run budget exhausted — remaining orders deferred to next run')
                    break
                }
                if (order.status === 'completed' || order.status === 'pending') continue

                totalChecked++
                try {
                    const statusResult = await checkOrderStatus(order.netpulse_reference)
                    if (!statusResult.success) continue

                    const newStatus = statusResult.status

                    // Separate, error-ignored write — see the shop_orders half above.
                    const supplierLabel = (statusResult.message || '').trim().toLowerCase() || null
                    const isTerminal = newStatus === 'completed' || newStatus === 'failed'
                    await (supabase.from('orders') as any)
                        .update({ supplier_status: isTerminal ? null : supplierLabel })
                        .eq('id', order.id)

                    if (newStatus === 'completed') {
                        const { error: updateError } = await (supabase
                            .from('orders') as any)
                            .update({ status: 'completed', updated_at: new Date().toISOString() })
                            .eq('id', order.id)
                        if (updateError) {
                            errors.push(`orders update failed for ${order.id}: ${updateError.message}`)
                            totalFailed++
                        } else {
                            console.log(`[NetPulseCron] orders ${order.id}: processing → completed`)
                            totalUpdated++
                        }
                    } else if (newStatus === 'failed') {
                        const { error: updateError } = await (supabase
                            .from('orders') as any)
                            .update({ status: 'failed', updated_at: new Date().toISOString() })
                            .eq('id', order.id)
                        if (updateError) {
                            errors.push(`orders update failed for ${order.id}: ${updateError.message}`)
                            totalFailed++
                        } else {
                            console.log(`[NetPulseCron] orders ${order.id}: processing → failed (manual refund required)`)
                            totalUpdated++
                        }
                    } else {
                        noteSupplierLabel(statusResult.message)
                        console.log(`[NetPulseCron] orders ${order.id}: supplier says "${statusResult.message}" → ${newStatus} (no change)`)
                    }
                } catch (orderErr: any) {
                    errors.push(`orders exception for ${order.id}: ${orderErr.message}`)
                    totalFailed++
                }
            }
        }
    } catch (partBErr: any) {
        errors.push(`Part B failed: ${partBErr.message}`)
    }

    return NextResponse.json({
        success: true,
        checked: totalChecked,
        updated: totalUpdated,
        failed: totalFailed,
        // Raw supplier labels for everything that stayed put, e.g.
        // { "verifying": 18, "processing": 2 }. If a label here is one
        // mapNetPulseStatus doesn't recognise, those orders are stuck.
        supplierLabels: supplierLabelCounts,
        errors,
    })
}

// Accept any method (cron-job.org's sent method doesn't always match its UI); auth-gated.
export const POST = GET
export const PUT = GET
export const PATCH = GET
export const DELETE = GET

