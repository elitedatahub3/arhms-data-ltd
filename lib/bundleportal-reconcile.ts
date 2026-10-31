import { createServerClient } from '@/lib/supabase'
import { fetchRecentOrderStatuses } from '@/lib/bundleportal-service'

// BundlePortal reconciliation — the SAFETY NET behind app/api/webhooks/bundleportal.
// BundlePortal NEVER retries a webhook (5s timeout, one attempt), so any delivery
// we miss is gone for good. This pages get_transactions and applies what it finds
// to orders still in 'processing'.
//
// Shared by app/api/cron/sync-bundleportal-status and the admin "Sync" button
// (app/api/admin/fulfillment/sync-bundleportal), so the two can never drift.
//
// Matching: get_transactions rows carry the order_id WE sent. That is
// shop_orders.id for storefront orders and orders.id everywhere else, so an
// orders row is matched on its id OR its shop_order_id.
//
// Rules (supplier label → mapped status, see mapBundlePortalStatus):
//   completed/delivered            → completed : update order to completed
//   failed/cancelled/refunded      → failed    : update order to failed (admin refunds by hand)
//   processing/cached              → processing: do nothing, re-check next run
// Every write is guarded by .eq('status','processing'), so overlapping runs (or a
// run racing the webhook) are no-ops.

export interface BundlePortalReconcileResult {
    success: true
    checked: number
    updated: number
    failed: number
    // Raw supplier labels for everything that stayed put, e.g. { "cached": 3 }.
    // A label here that mapBundlePortalStatus doesn't recognise means those
    // orders are stuck.
    supplierLabels: Record<string, number>
    errors: string[]
}

export async function reconcileBundlePortalOrders(opts: { runBudgetMs?: number; scanBudgetMs?: number } = {}): Promise<BundlePortalReconcileResult> {
    const startedAt = Date.now()
    const runBudgetMs = opts.runBudgetMs ?? 50_000
    const outOfTime = () => Date.now() - startedAt > runBudgetMs

    const supabase = createServerClient()
    let totalChecked = 0
    let totalUpdated = 0
    let totalFailed = 0
    const errors: string[] = []

    const supplierLabelCounts: Record<string, number> = {}
    const noteSupplierLabel = (raw: string | undefined) => {
        const label = (raw || '').trim().toLowerCase() || '(empty)'
        supplierLabelCounts[label] = (supplierLabelCounts[label] || 0) + 1
    }

    // ── Collect the backlog from both tables (oldest first, so it drains) ─────
    let shopOrders: any[] = []
    let mainOrders: any[] = []

    try {
        const { data, error } = await (supabase
            .from('shop_orders') as any)
            .select('id, status, created_at')
            .eq('fulfilled_by', 'bundleportal')
            .eq('status', 'processing')
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
            .select('id, shop_order_id, status, created_at')
            .eq('fulfillment_method', 'bundleportal')
            .eq('status', 'processing')
            .order('created_at', { ascending: true })
            .limit(50)
        if (error) errors.push(`orders query failed: ${error.message}`)
        else mainOrders = data || []
    } catch (err: any) {
        errors.push(`orders query exception: ${err.message}`)
    }

    const wantedOrderIds = Array.from(new Set([
        ...shopOrders.map(o => String(o.id)),
        ...mainOrders.map(o => String(o.id)),
        ...mainOrders.filter(o => o.shop_order_id).map(o => String(o.shop_order_id)),
    ]))

    if (wantedOrderIds.length === 0) {
        return { success: true, checked: 0, updated: 0, failed: 0, supplierLabels: {}, errors }
    }

    // ── One batched read of the supplier's history ────────────────────────────
    // Page back to the oldest backlog order (with slack for clock skew between
    // our created_at and theirs), so an order is only "missing" once the scan has
    // actually read past the moment it was placed.
    const createdTimes = [...shopOrders, ...mainOrders]
        .map(o => Date.parse(String(o.created_at ?? '')))
        .filter(Number.isFinite)
    const scanBackTo = createdTimes.length > 0
        ? new Date(Math.min(...createdTimes) - 15 * 60_000).toISOString()
        : undefined

    const scan = await fetchRecentOrderStatuses({
        wantedOrderIds,
        budgetMs: opts.scanBudgetMs ?? 30_000,
        scanBackTo,
    })
    const statuses = scan.statuses

    const lookup = (order: any) =>
        statuses.get(String(order.id)) || (order.shop_order_id ? statuses.get(String(order.shop_order_id)) : undefined)

    // A storefront order is one shop_orders row AND one orders row; count it once.
    const backlog = new Map<string, any>()
    for (const o of shopOrders) backlog.set(String(o.id), o)
    for (const o of mainOrders) {
        const key = String(o.shop_order_id || o.id)
        if (!backlog.has(key)) backlog.set(key, o)
    }

    const scanReachedFullDepth = ['all_found', 'end_of_history', 'reached_cutoff'].includes(scan.stopReason)
    const oldestSeenMs = scan.oldestSeenAt ? Date.parse(scan.oldestSeenAt) : Infinity
    const missing: any[] = []
    const notReached: any[] = []
    const staleInFlight: { order: any; raw: string }[] = []
    const STALE_MS = 2 * 60 * 60_000

    for (const o of backlog.values()) {
        const hit = lookup(o)
        const createdMs = Date.parse(String(o.created_at ?? ''))
        if (!hit) {
            const scannedPastIt = scanReachedFullDepth || (Number.isFinite(createdMs) && oldestSeenMs <= createdMs)
            ;(scannedPastIt ? missing : notReached).push(o)
        } else if (hit.status === 'processing' && Number.isFinite(createdMs) && Date.now() - createdMs > STALE_MS) {
            staleInFlight.push({ order: o, raw: hit.raw })
        }
    }

    const hoursOld = (o: any) => Math.floor((Date.now() - Date.parse(String(o.created_at))) / 3_600_000)

    // Most actionable first: errors[0] is what the admin push notification shows.
    if (missing.length > 0) {
        errors.push(`${missing.length} of ${backlog.size} BundlePortal orders are not in their transaction history (read back to ${scan.oldestSeenAt ?? 'n/a'}) — check them on the BundlePortal dashboard (e.g. ${missing[0].id})`)
    }
    // Logged only, not pushed: admin asked to stop the "still undelivered after 2h+" push.
    if (staleInFlight.length > 0) {
        const oldest = staleInFlight.reduce((a, b) => (Date.parse(a.order.created_at) <= Date.parse(b.order.created_at) ? a : b))
        console.warn(`[BundlePortalSync] ${staleInFlight.length} BundlePortal orders still undelivered after 2h+ (oldest ${hoursOld(oldest.order)}h, supplier says "${oldest.raw}") — chase BundlePortal or refund`)
    }
    if (notReached.length > 0) {
        errors.push(`BundlePortal history scan incomplete (${scan.stopReason}, ${scan.pagesRead} pages) — ${notReached.length} of ${backlog.size} orders not checked this run`)
    }

    /** Apply the scan result to one table's backlog. */
    const applyTo = async (table: 'shop_orders' | 'orders', rows: any[]) => {
        for (const order of rows) {
            if (outOfTime()) {
                errors.push(`${table}: run budget exhausted — remaining orders deferred to next run`)
                break
            }
            if (order.status !== 'processing') continue

            const hit = lookup(order)
            if (!hit) continue

            totalChecked++
            const newStatus = hit.status

            try {
                // Raw supplier label, for display only, in its OWN statement with its
                // error ignored: against a DB without the supplier_status migration a
                // merged statement would take order completion down with it.
                const supplierLabel = (hit.raw || '').trim().toLowerCase() || null
                const isTerminal = newStatus === 'completed' || newStatus === 'failed'
                await (supabase.from(table) as any)
                    .update({ supplier_status: isTerminal ? null : supplierLabel })
                    .eq('id', order.id)

                if (!isTerminal) {
                    noteSupplierLabel(hit.raw)
                    console.log(`[BundlePortalSync] ${table} ${order.id}: supplier says "${hit.raw}" → ${newStatus} (no change)`)
                    continue
                }

                const { error: updateError } = await (supabase.from(table) as any)
                    .update({ status: newStatus, updated_at: new Date().toISOString() })
                    .eq('id', order.id)
                    .eq('status', 'processing')

                if (updateError) {
                    errors.push(`${table} update failed for ${order.id}: ${updateError.message}`)
                    totalFailed++
                } else {
                    console.log(`[BundlePortalSync] ${table} ${order.id}: processing → ${newStatus}${newStatus === 'failed' ? ' (manual refund required)' : ''}`)
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

    return {
        success: true,
        checked: totalChecked,
        updated: totalUpdated,
        failed: totalFailed,
        supplierLabels: supplierLabelCounts,
        errors,
    }
}
