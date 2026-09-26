import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { fetchRecentOrderStatuses } from '@/lib/hendylinks-service'
import { areCronJobsEnabled, cronDisabledResponse } from '@/lib/cron-control'

// HendyLinks reconciliation cron (driven by cron-job.org, every 5 min) — the
// SAFETY NET, not the primary channel. app/api/webhooks/hendylinks is what
// normally closes orders out; this catches anything a missed, delayed or
// mis-signed webhook left stuck in 'processing'.
//
// Scheduling, in full:
//   • cron-job.org → GET https://arhmsgh.com/api/cron/sync-hendylinks-status
//     with header `Authorization: Bearer <CRON_SECRET>`. NEVER the www host —
//     that 307s cross-host and the redirect strips the auth header, so the job
//     goes red with a 401 that looks like a bad secret.
//   • vercel.json also carries this path, as a belt-and-braces second trigger.
//     Both running is safe: every write is guarded by .eq('status','processing'),
//     so a second run over the same backlog is a no-op. Drop either one if the
//     duplicated supplier reads ever matter.
//
// CRON_JOBS_ENABLED must be 'true' in the environment. When it is not, this
// returns HTTP 200 {"disabled": true} — deliberately, so the scheduler does not
// flag the job as failing — which means the console stays GREEN while nothing
// reconciles. If orders sit in 'processing', check that flag first.
//
// Rules (supplier label → mapped status, see mapHendyLinksStatus):
//   "completed"/"delivered"/"success" → completed : update order to completed
//   "failed"/"cancelled"/"refunded"   → failed    : update order to failed (admin refunds by hand)
//   "processing"/"verifying"          → processing: do nothing, re-check next run
//   Order already completed or pending: skip (only orders in processing are processed)
//
// Unlike the other sync crons this makes ONE batched supplier call for the whole
// backlog rather than one per order: HendyLinks has no per-order status endpoint,
// only GET /api/orders?limit&offset, so we page that history once and match locally.
// Supplier traffic per run is therefore bounded no matter how deep the backlog is,
// and a run with nothing pending makes no supplier calls at all.

export const maxDuration = 60
const RUN_BUDGET_MS = 50_000
// Leaves ~20s of the budget for the DB writes that follow the scan.
const SCAN_BUDGET_MS = 30_000

export async function GET(request: NextRequest) {
    if (!areCronJobsEnabled()) return cronDisabledResponse()

    const startedAt = Date.now()
    const outOfTime = () => Date.now() - startedAt > RUN_BUDGET_MS

    const authHeader = request.headers.get('authorization')
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const supabase = createServerClient()
    let totalChecked = 0
    let totalUpdated = 0
    let totalFailed = 0
    const errors: string[] = []

    // Tally of the supplier's RAW status labels for orders that did NOT move.
    // mapHendyLinksStatus matches hand-written synonym lists, and their docs only
    // ever name two of their labels — a label outside those lists parks an order in
    // processing forever, and the console line that would reveal it is visible only
    // to whoever can read platform logs. Returning the tally makes a stuck label
    // diagnosable from the response alone. Labels only — no order ids, no phones.
    const supplierLabelCounts: Record<string, number> = {}
    const noteSupplierLabel = (raw: string | undefined) => {
        const label = (raw || '').trim().toLowerCase() || '(empty)'
        supplierLabelCounts[label] = (supplierLabelCounts[label] || 0) + 1
    }

    // ── Collect the backlog from both tables ──────────────────────────────────
    // Oldest first: without an explicit order Postgres returns an arbitrary (but
    // stable) page, so anything past the limit is NEVER checked and the backlog
    // starves itself. Oldest-first guarantees stuck orders drain.
    let shopOrders: any[] = []
    let mainOrders: any[] = []

    try {
        const { data, error } = await (supabase
            .from('shop_orders') as any)
            .select('id, hendylinks_reference, status')
            .eq('fulfilled_by', 'hendylinks')
            .eq('status', 'processing')
            .not('hendylinks_reference', 'is', null)
            .order('created_at', { ascending: true })
            .limit(50)
        if (error) errors.push(`shop_orders query failed: ${error.message}`)
        else shopOrders = data || []
    } catch (err: any) {
        errors.push(`shop_orders query exception: ${err.message}`)
    }

    try {
        const { data, error } = await (supabase
            .from('orders') as any)
            .select('id, hendylinks_reference, status')
            .eq('fulfillment_method', 'hendylinks')
            .eq('status', 'processing')
            .not('hendylinks_reference', 'is', null)
            .order('created_at', { ascending: true })
            .limit(50)
        if (error) errors.push(`orders query failed: ${error.message}`)
        else mainOrders = data || []
    } catch (err: any) {
        errors.push(`orders query exception: ${err.message}`)
    }

    const wantedRefs = Array.from(new Set([
        ...shopOrders.map(o => String(o.hendylinks_reference)),
        ...mainOrders.map(o => String(o.hendylinks_reference)),
    ]))

    if (wantedRefs.length === 0) {
        return NextResponse.json({
            success: true, checked: 0, updated: 0, failed: 0, supplierLabels: {}, errors,
        })
    }

    // ── One batched read of the supplier's history ────────────────────────────
    const statuses = await fetchRecentOrderStatuses({
        wantedRefs,
        budgetMs: SCAN_BUDGET_MS,
    })

    // An order in our backlog that the scan never saw is NOT resolved — it may
    // simply have fallen off the pages we read. Report it so a backlog older than
    // the history window is visible rather than silently ignored.
    const unseen = wantedRefs.length - statuses.size
    if (unseen > 0) {
        errors.push(`${unseen} of ${wantedRefs.length} references were not found in the scanned history`)
    }

    /** Apply the scan result to one table's backlog. */
    const applyTo = async (table: 'shop_orders' | 'orders', rows: any[]) => {
        for (const order of rows) {
            if (outOfTime()) {
                errors.push(`${table}: run budget exhausted — remaining orders deferred to next run`)
                break
            }
            // Extra safety: skip if somehow already completed or pending
            if (order.status === 'completed' || order.status === 'pending') continue

            const hit = statuses.get(String(order.hendylinks_reference))
            if (!hit) continue

            totalChecked++
            const newStatus = hit.status

            try {
                // Raw supplier label, for display only (see lib/order-status-display).
                // Nulled on terminal states so a stale "verifying" can't outlive the
                // order it described.
                //
                // Written in its OWN statement, never merged into the status update
                // below, and its error is deliberately ignored. supplier_status is a
                // later addition than this pattern: against a DB where that migration
                // hasn't been applied, PostgREST rejects the whole statement — merging
                // it would take order completion down with it. Losing a cosmetic label
                // is acceptable; losing completions is not.
                const supplierLabel = (hit.raw || '').trim().toLowerCase() || null
                const isTerminal = newStatus === 'completed' || newStatus === 'failed'
                await (supabase.from(table) as any)
                    .update({ supplier_status: isTerminal ? null : supplierLabel })
                    .eq('id', order.id)

                if (!isTerminal) {
                    // Still in flight — supplier_status above now carries the sub-state
                    // so the UI can show "Verifying" rather than a bare "Processing".
                    // Log and tally the RAW label too: an unrecognised string parks the
                    // order here forever.
                    noteSupplierLabel(hit.raw)
                    console.log(`[HendyLinksCron] ${table} ${order.id}: supplier says "${hit.raw}" → ${newStatus} (no change)`)
                    continue
                }

                const { error: updateError } = await (supabase.from(table) as any)
                    .update({ status: newStatus, updated_at: new Date().toISOString() })
                    .eq('id', order.id)
                    // Row-level idempotency: the webhook may have closed this order out
                    // between our read and this write.
                    .eq('status', 'processing')

                if (updateError) {
                    errors.push(`${table} update failed for ${order.id}: ${updateError.message}`)
                    totalFailed++
                } else {
                    console.log(`[HendyLinksCron] ${table} ${order.id}: processing → ${newStatus}${newStatus === 'failed' ? ' (manual refund required)' : ''}`)
                    totalUpdated++
                }
            } catch (orderErr: any) {
                errors.push(`${table} exception for ${order.id}: ${orderErr.message}`)
                totalFailed++
            }
        }
    }

    try {
        await applyTo('shop_orders', shopOrders)
    } catch (partAErr: any) {
        errors.push(`Part A failed: ${partAErr.message}`)
    }

    try {
        await applyTo('orders', mainOrders)
    } catch (partBErr: any) {
        errors.push(`Part B failed: ${partBErr.message}`)
    }

    return NextResponse.json({
        success: true,
        checked: totalChecked,
        updated: totalUpdated,
        failed: totalFailed,
        // Raw supplier labels for everything that stayed put, e.g.
        // { "processing": 4 }. If a label here is one mapHendyLinksStatus doesn't
        // recognise, those orders are stuck.
        supplierLabels: supplierLabelCounts,
        errors,
    })
}

// Accept any method (cron-job.org's sent method doesn't always match its UI); auth-gated.
export const POST = GET
export const PUT = GET
export const PATCH = GET
export const DELETE = GET
