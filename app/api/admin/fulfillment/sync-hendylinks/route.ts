import { NextResponse } from 'next/server'
import { createRouteHandlerClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { fetchRecentOrderStatuses } from '@/lib/hendylinks-service'

// Manual twin of app/api/cron/sync-hendylinks-status, for the "Status Sync" button
// in the admin Fulfillment Center.
//
// Rules (same as cron):
//   HendyLinks → completed        : update order to completed
//   HendyLinks → failed/cancelled : update order to failed (admin does manual refund)
//   HendyLinks → processing       : do nothing
//   Order already completed or pending: skip
//
// Like the cron, this makes ONE batched supplier read for the whole backlog —
// HendyLinks has no per-order status endpoint, only paged order history.

export const maxDuration = 60

export async function POST() {
    try {
        const supabase = await createRouteHandlerClient()
        const { data: { user: authUser } } = await supabase.auth.getUser()
        if (!authUser) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

        // `as any`: the generated Supabase types resolve this select to `never`, which is
        // why every sibling admin route trips a typecheck error here. Cast rather than
        // add a 52nd.
        const { data: userData } = await (supabase.from('users') as any).select('role').eq('id', authUser.id).single()
        if (!userData || userData.role !== 'admin') return NextResponse.json({ error: 'Admin access required' }, { status: 403 })

        const db = createServerClient() as any
        let checked = 0
        let updated = 0
        let failed = 0
        const errors: string[] = []
        const supplierLabels: Record<string, number> = {}

        // ── Collect the backlog from both tables ──────────────────────────────
        const { data: shopOrders, error: shopError } = await db
            .from('shop_orders')
            .select('id, hendylinks_reference, status')
            .eq('fulfilled_by', 'hendylinks')
            .eq('status', 'processing')
            .not('hendylinks_reference', 'is', null)
            .order('created_at', { ascending: true })
            .limit(50)
        if (shopError) errors.push(`shop_orders query failed: ${shopError.message}`)

        const { data: mainOrders, error: mainError } = await db
            .from('orders')
            .select('id, hendylinks_reference, status')
            .eq('fulfillment_method', 'hendylinks')
            .eq('status', 'processing')
            .not('hendylinks_reference', 'is', null)
            .order('created_at', { ascending: true })
            .limit(50)
        if (mainError) errors.push(`orders query failed: ${mainError.message}`)

        const wantedRefs = Array.from(new Set([
            ...(shopOrders || []).map((o: any) => String(o.hendylinks_reference)),
            ...(mainOrders || []).map((o: any) => String(o.hendylinks_reference)),
        ]))

        if (wantedRefs.length === 0) {
            return NextResponse.json({ success: true, checked: 0, updated: 0, failed: 0, supplierLabels, errors })
        }

        const statuses = await fetchRecentOrderStatuses({ wantedRefs, budgetMs: 30_000 })

        const unseen = wantedRefs.length - statuses.size
        if (unseen > 0) {
            errors.push(`${unseen} of ${wantedRefs.length} references were not found in the scanned history`)
        }

        const applyTo = async (table: 'shop_orders' | 'orders', rows: any[]) => {
            for (const order of rows) {
                if (order.status === 'completed' || order.status === 'pending') continue

                const hit = statuses.get(String(order.hendylinks_reference))
                if (!hit) continue

                checked++
                const newStatus = hit.status

                try {
                    // Separate, error-ignored write — see the cron for why.
                    const supplierLabel = (hit.raw || '').trim().toLowerCase() || null
                    const isTerminal = newStatus === 'completed' || newStatus === 'failed'
                    await db.from(table)
                        .update({ supplier_status: isTerminal ? null : supplierLabel })
                        .eq('id', order.id)

                    if (!isTerminal) {
                        const label = supplierLabel || '(empty)'
                        supplierLabels[label] = (supplierLabels[label] || 0) + 1
                        continue
                    }

                    const { error: updateError } = await db.from(table)
                        .update({ status: newStatus, updated_at: new Date().toISOString() })
                        .eq('id', order.id)
                        .eq('status', 'processing')

                    if (updateError) {
                        errors.push(`${table} update failed for ${order.id}: ${updateError.message}`)
                        failed++
                    } else {
                        console.log(`[HendyLinksSync] ${table} ${order.id}: processing → ${newStatus}${newStatus === 'failed' ? ' (manual refund required)' : ''}`)
                        updated++
                    }
                } catch (err: any) {
                    errors.push(`${table} exception for ${order.id}: ${err.message}`)
                    failed++
                }
            }
        }

        await applyTo('shop_orders', shopOrders || [])
        await applyTo('orders', mainOrders || [])

        return NextResponse.json({ success: true, checked, updated, failed, supplierLabels, errors })

    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 500 })
    }
}
