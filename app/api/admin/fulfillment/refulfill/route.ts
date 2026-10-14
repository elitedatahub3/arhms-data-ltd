import { createRouteHandlerClient } from '@/lib/supabase-server'
import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import {
    loadFulfillmentConfig, resolveRoute, fulfillWithFallback, ordersStamp, shopOrdersStamp,
    optionalStampKeys, describeAttempts, failureReason,
} from '@/lib/supplier-router'
import { updateOrderWithColumnFallback } from '@/lib/order-update-fallback'
import { syncShopOrderStatus } from '@/lib/shop-service'

// Create a service role client to bypass RLS for administrative fulfillment
const supabaseAdmin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
        auth: {
            autoRefreshToken: false,
            persistSession: false
        }
    }
)

// Orders are refulfilled one at a time, and each one waits on a supplier HTTP call.
// With the default limit a handful of slow orders runs past it and the function is
// killed mid-loop — the admin sees no response at all, and whichever order held the
// lock is stranded in 'processing'.
export const maxDuration = 60

// Stop starting new orders once this much of the budget is gone, so the route always
// gets to return its counts. An order already in flight still needs its supplier call
// to finish: a fully stalled supplier takes ~31s to exhaust its own retry budget
// (measured), so 25s here keeps the worst case (~56s) inside maxDuration.
const REFULFILL_TIME_BUDGET_MS = 25_000

export async function POST(request: Request) {
    const startedAt = Date.now()
    try {
        const supabase = await createRouteHandlerClient()
        const { data: { user: authUser } } = await supabase.auth.getUser()

        if (!authUser) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        // Verify admin role
        const { data: user } = await supabase
            .from('users')
            .select('role')
            .eq('id', authUser.id)
            .single()

        if (!user || (user.role !== 'admin' && user.role !== 'sub-admin')) {
            return NextResponse.json({ error: 'Forbidden: Admin access required' }, { status: 403 })
        }

        const body = await request.json()
        const { orderIds } = body

        // Routing (primary + fallback per network) — read once for the whole run.
        // globalEnabled is forced on: an admin pressing re-fulfil IS the manual
        // override, and this route never honoured the global auto switch.
        const config = { ...(await loadFulfillmentConfig(supabaseAdmin)), globalEnabled: true }

        // Construct query to find pending orders
        let query = supabaseAdmin
            .from('orders')
            .select('id, network, phone_number, size, status, user_id, price, shop_order_id, reference_code')
            .eq('status', 'pending')
            .order('created_at', { ascending: true })

        // If orderIds were provided, filter by those exact IDs
        if (orderIds && Array.isArray(orderIds) && orderIds.length > 0) {
            query = query.in('id', orderIds)
        }

        const { data: pendingOrders, error: fetchError } = await query

        if (fetchError) {
            throw fetchError
        }

        if (!pendingOrders || pendingOrders.length === 0) {
            return NextResponse.json({ success: true, count: 0, fulfilled: 0, skipped: 0, failed: 0, message: 'No pending orders found to fulfill' })
        }

        let fulfilled = 0
        let skipped = 0
        let failed = 0
        let remaining = 0

        const { sendAdminNewOrderAlert } = await import('@/lib/email-service')

        // Process each pending order safely
        for (const order of pendingOrders) {
            // Out of budget: leave the rest untouched (still 'pending', so a later run
            // picks them up) and return what we managed, rather than being killed with
            // no response at all.
            if (Date.now() - startedAt > REFULFILL_TIME_BUDGET_MS) {
                remaining = pendingOrders.length - (fulfilled + skipped + failed)
                console.warn(`[ManualRefulfill] Time budget exhausted — stopping with ${remaining} order(s) left for the next run.`)
                break
            }

            // Checked before taking the lock so a misconfigured network does not churn
            // every order through processing and back. The router re-checks the same config.
            const route = resolveRoute(config.settings, order.network)

            // No supplier enabled → skip
            if (route.kind === 'none') {
                console.log(`[ManualRefulfill] Skipping order ${order.id}: No active supplier for network ${order.network}.`)
                skipped++
                continue
            }

            // Multiple suppliers enabled → conflict guard, skip
            if (route.kind === 'conflict') {
                console.error(`[ManualRefulfill] CONFLICT: Multiple suppliers active for ${order.network} on order ${order.id}. Skipping.`)
                await sendAdminNewOrderAlert({
                    referenceCode: order.reference_code || order.id,
                    phoneNumber: order.phone_number,
                    network: order.network,
                    size: order.size,
                    price: order.price,
                    customerName: 'Shop Guest',
                    customerEmail: 'N/A',
                    source: 'shop_storefront',
                    shopName: 'Admin Refulfill',
                    reason: `⚠️ FULFILLMENT_CONFLICT: Multiple suppliers active for ${order.network}. Order ${order.id} skipped. Fix in admin panel.`
                }).catch(e => console.error('[ManualRefulfill] Alert error:', e))
                skipped++
                continue
            }

            // ATOMIC LOCK: Try to update this specific order from 'pending' to 'processing'
            // If another process/request already took it, this will return 0 rows
            const { data: updatedOrder, error: lockError } = await supabaseAdmin
                .from('orders')
                .update({ status: 'processing' })
                .eq('id', order.id)
                .eq('status', 'pending') // MUST still be pending
                .select()
                .single()

            if (lockError || !updatedOrder) {
                // The order was no longer pending, someone else grabbed it or it was canceled
                console.log(`[ManualRefulfill] Order ${order.id} lock failed (already processing/completed). Skipping.`)
                skipped++
                continue
            }

            // --- WE HAVE THE LOCK. NOW FULFILL ---
            console.log(`[ManualRefulfill] Locked order ${order.id}. Primary: ${route.primary.id}${route.fallback ? `, fallback: ${route.fallback.id}` : ''}.`)

            const outcome = await fulfillWithFallback({
                db: supabaseAdmin,
                network: order.network,
                phone: order.phone_number,
                size: order.size,
                orderId: order.id,
                match: { column: 'id', value: order.id },
                // HendyLinks checks its history first; BundlePortal reuses shop_orders.id.
                mode: 'retry',
                shopOrderId: order.shop_order_id,
                config,
                fallbackDeadline: startedAt + REFULFILL_TIME_BUDGET_MS,
                // Stamp fulfilled_by on shop_orders before each supplier call
                onBeforeAttempt: order.shop_order_id
                    ? async (supplier) => {
                        await supabaseAdmin.from('shop_orders').update({ fulfilled_by: supplier.id }).eq('id', order.shop_order_id)
                    }
                    : undefined,
            })

            // An idempotency collision (alreadySubmitted) is not a fresh success, but
            // the order already exists at the supplier — the router reports it as
            // placed, so it stays in 'processing' (locked above) rather than reverting
            // to pending and looping forever.
            if (outcome.status === 'placed') {
                const supplierLabel = outcome.supplier.id
                const alreadySubmitted = !outcome.result.success
                console.log(`[ManualRefulfill] ${alreadySubmitted ? 'ALREADY SUBMITTED — kept processing' : 'SUCCESS'} for order ${order.id}: ${describeAttempts(outcome.attempts)}`)

                // Track outcome
                await supabaseAdmin.from('mtn_fulfillment_tracking').insert({
                    order_id: order.id,
                    status: alreadySubmitted ? 'processing' : 'success',
                    api_response: {
                        ...outcome.result.apiResponse,
                        note: alreadySubmitted
                            ? `Manual Admin Refill: order already submitted at ${supplierLabel} (idempotency) — kept processing`
                            : `Manual Admin Refill Success via ${supplierLabel}`,
                        ...(outcome.fellBack ? { fallback: describeAttempts(outcome.attempts) } : {}),
                    }
                })

                // Stamp fulfillment_method + supplier reference on the orders row so the
                // per-supplier status-sync crons (which filter on these) can later move
                // this order from processing → completed/failed. Without this, a direct
                // (non-shop) order refulfilled here stays stuck in 'processing' forever.
                // The reference sheds first, then fulfillment_method (guarded by
                // orders_fulfillment_method_check), if the DB is behind the code.
                const ordersUpdate = ordersStamp(outcome.supplier, outcome.reference)
                await updateOrderWithColumnFallback(
                    supabaseAdmin, 'orders', { column: 'id', value: order.id },
                    ordersUpdate, optionalStampKeys(ordersUpdate), '[ManualRefulfill]'
                )

                // Update shop_orders to processing + stamp supplier reference
                if (order.shop_order_id) {
                    const shopOrderUpdate: Record<string, any> = {
                        status: 'processing',
                        updated_at: new Date().toISOString(),
                        ...shopOrdersStamp(outcome.supplier, outcome.reference),
                    }
                    await updateOrderWithColumnFallback(
                        supabaseAdmin, 'shop_orders', { column: 'id', value: order.shop_order_id },
                        shopOrderUpdate, optionalStampKeys(shopOrderUpdate), '[ManualRefulfill]'
                    )
                }

                // Sync status to the healing wrapper so shop owners see the transition to processing
                await syncShopOrderStatus(order.id, 'processing').catch(err =>
                    console.error(`[ManualRefulfill] syncShopOrderStatus failed for ${order.id}:`, err)
                )

                fulfilled++
            } else {
                const reason = outcome.status === 'failed' ? failureReason(outcome) : `no supplier (${outcome.status})`
                console.error(`[ManualRefulfill] FAILED for order ${order.id}: ${reason}`)

                // Track failure
                await supabaseAdmin.from('mtn_fulfillment_tracking').insert({
                    order_id: order.id,
                    status: 'failed',
                    api_response: outcome.status === 'failed'
                        ? { ...outcome.result.apiResponse, note: `Manual Admin Refill Failed — ${reason}`, error: outcome.result.error, attempts: outcome.attempts }
                        : { note: `Manual Admin Refill Failed — ${reason}` }
                })

                // Revert status to pending so it can be attempted again
                await supabaseAdmin.from('orders')
                    .update({ status: 'pending' })
                    .eq('id', order.id)

                // Revert shop_orders too
                if (order.shop_order_id) {
                    await supabaseAdmin
                        .from('shop_orders')
                        .update({ status: 'pending' })
                        .eq('id', order.shop_order_id)
                }

                // Sync the reversion back to pending
                await syncShopOrderStatus(order.id, 'pending').catch(err =>
                    console.error(`[ManualRefulfill] syncShopOrderStatus revert failed for ${order.id}:`, err)
                )

                failed++
            }
        }

        return NextResponse.json({
            success: true,
            count: pendingOrders.length,
            fulfilled,
            skipped,
            failed,
            remaining
        })
    } catch (error: any) {
        console.error('[ManualRefulfill] Route Error:', error)
        return NextResponse.json(
            { error: error.message || 'Internal server error' },
            { status: 500 }
        )
    }
}
