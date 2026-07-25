import { createRouteHandlerClient } from '@/lib/supabase-server'
import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { fulfillOrder } from '@/lib/fulfillment-service'
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

export async function POST(request: Request) {
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

        // Fetch settings to check if global auto-fulfillment and networks are enabled
        const { data: settingsData } = await supabaseAdmin
            .from('admin_settings')
            .select('key, value')
            .in('key', ['auto_fulfillment_enabled', 'fulfillment_settings'])

        const settingsMap = (settingsData || []).reduce((acc: any, curr: any) => {
            acc[curr.key] = curr.value
            return acc
        }, {})

        // Parse all supplier network settings from fulfillment_settings
        const dbFulfillmentSettings = typeof settingsMap.fulfillment_settings === 'string'
            ? JSON.parse(settingsMap.fulfillment_settings)
            : settingsMap.fulfillment_settings || {}
        const networkSettings = dbFulfillmentSettings.networks || {}
        const codecraftNetworkSettings = dbFulfillmentSettings.codecraft_networks || {}
        const kingflexyNetworkSettings = dbFulfillmentSettings.kingflexy_networks || {}
        const eazydataNetworkSettings = dbFulfillmentSettings.eazydata_networks || {}
        const agentportalNetworkSettings = dbFulfillmentSettings.agentportal_networks || {}

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

        const { sendAdminNewOrderAlert } = await import('@/lib/email-service')
        const { fulfillOrder: ccFulfillOrder } = await import('@/lib/codecraft-service')
        const { fulfillOrder: kfFulfillOrder } = await import('@/lib/kingflexy-service')
        const { fulfillOrder: edFulfillOrder } = await import('@/lib/eazydata-service')
        const { fulfillOrder: apFulfillOrder } = await import('@/lib/agentportal-service')

        // Process each pending order safely
        for (const order of pendingOrders) {
            const isDataKazinaEnabled = networkSettings[order.network] === true
            const isCodeCraftEnabled = codecraftNetworkSettings[order.network] === true
            const isKingFlexyEnabled = kingflexyNetworkSettings[order.network] === true
            const isEazyDataEnabled = eazydataNetworkSettings[order.network] === true
            const isAgentPortalEnabled = agentportalNetworkSettings[order.network] === true

            // No supplier enabled → skip
            if (!isDataKazinaEnabled && !isCodeCraftEnabled && !isKingFlexyEnabled && !isEazyDataEnabled && !isAgentPortalEnabled) {
                console.log(`[ManualRefulfill] Skipping order ${order.id}: No active supplier for network ${order.network}.`)
                skipped++
                continue
            }

            // Multiple suppliers enabled → conflict guard, skip
            const activeCount = [isDataKazinaEnabled, isCodeCraftEnabled, isKingFlexyEnabled, isEazyDataEnabled, isAgentPortalEnabled].filter(Boolean).length
            if (activeCount > 1) {
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

            // Determine which supplier will handle this order
            const supplierLabel = isCodeCraftEnabled ? 'codecraft' : isKingFlexyEnabled ? 'kingflexy' : isEazyDataEnabled ? 'eazydata' : isAgentPortalEnabled ? 'agentportal' : 'datakazina'

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
            console.log(`[ManualRefulfill] Locked order ${order.id}. Beginning fulfillment via ${supplierLabel}.`)

            // Stamp fulfilled_by on shop_orders before calling supplier
            if (order.shop_order_id) {
                await supabaseAdmin
                    .from('shop_orders')
                    .update({ fulfilled_by: supplierLabel })
                    .eq('id', order.shop_order_id)
            }

            let result: { success: boolean; reference?: string; transactionId?: string; error?: string; apiResponse?: any; alreadySubmitted?: boolean }
            if (isCodeCraftEnabled) {
                result = await ccFulfillOrder(order.network, order.phone_number, order.size, order.id)
            } else if (isKingFlexyEnabled) {
                result = await kfFulfillOrder(order.network, order.phone_number, order.size, order.id)
            } else if (isEazyDataEnabled) {
                result = await edFulfillOrder(order.network, order.phone_number, order.size, order.id)
            } else if (isAgentPortalEnabled) {
                result = await apFulfillOrder(order.network, order.phone_number, order.size, order.id)
            } else {
                result = await fulfillOrder(order.network, order.phone_number, order.size, order.id)
            }

            // An idempotency collision (alreadySubmitted) is not a fresh success, but
            // the order already exists at the supplier — keep it in 'processing'
            // (it was locked there above) rather than reverting to pending and
            // looping forever. We just can't stamp a supplier reference for it.
            const alreadySubmitted = !result.success && result.alreadySubmitted === true
            if (result.success || alreadySubmitted) {
                console.log(`[ManualRefulfill] ${alreadySubmitted ? 'ALREADY SUBMITTED — kept processing' : 'SUCCESS'} for order ${order.id} via ${supplierLabel}`)

                // Track outcome
                await supabaseAdmin.from('mtn_fulfillment_tracking').insert({
                    order_id: order.id,
                    status: alreadySubmitted ? 'processing' : 'success',
                    api_response: {
                        ...result.apiResponse,
                        note: alreadySubmitted
                            ? `Manual Admin Refill: order already submitted at ${supplierLabel} (idempotency) — kept processing`
                            : `Manual Admin Refill Success via ${supplierLabel}`
                    }
                })

                // Stamp fulfillment_method + supplier reference on the orders row so the
                // per-supplier status-sync crons (which filter on these) can later move
                // this order from processing → completed/failed. Without this, a direct
                // (non-shop) order refulfilled here stays stuck in 'processing' forever.
                // Reference columns are unconstrained → stamp them first so they always
                // apply, even on a DB where the eazydata fulfillment_method migration
                // hasn't run yet.
                const refUpdate: Record<string, any> = {}
                if (result.transactionId) {
                    if (isCodeCraftEnabled) refUpdate.codecraft_reference = result.transactionId
                    else if (isKingFlexyEnabled) refUpdate.kingflexy_reference = result.transactionId
                    else if (isEazyDataEnabled) refUpdate.eazydata_reference = result.transactionId
                    else if (isAgentPortalEnabled) refUpdate.agentportal_reference = result.transactionId
                    else refUpdate.dakazina_reference = result.transactionId
                }
                if (Object.keys(refUpdate).length > 0) {
                    await supabaseAdmin.from('orders').update(refUpdate).eq('id', order.id)
                }
                // fulfillment_method is guarded by orders_fulfillment_method_check
                // (requires migration 20260713_add_eazydata_fulfillment_method.sql).
                await supabaseAdmin.from('orders').update({ fulfillment_method: supplierLabel }).eq('id', order.id)

                // Update shop_orders to processing + stamp supplier reference
                if (order.shop_order_id) {
                    const shopOrderUpdate: Record<string, any> = {
                        status: 'processing',
                        updated_at: new Date().toISOString(),
                    }
                    if (isCodeCraftEnabled && result.transactionId) {
                        shopOrderUpdate.codecraft_reference_id = result.transactionId
                    }
                    if (isKingFlexyEnabled && result.transactionId) {
                        shopOrderUpdate.kingflexy_reference = result.transactionId
                    }
                    if (isEazyDataEnabled && result.transactionId) {
                        shopOrderUpdate.eazydata_reference = result.transactionId
                    }
                    if (isAgentPortalEnabled && result.transactionId) {
                        shopOrderUpdate.agentportal_reference = result.transactionId
                    }
                    await supabaseAdmin
                        .from('shop_orders')
                        .update(shopOrderUpdate)
                        .eq('id', order.shop_order_id)
                }

                // Sync status to the healing wrapper so shop owners see the transition to processing
                await syncShopOrderStatus(order.id, 'processing').catch(err =>
                    console.error(`[ManualRefulfill] syncShopOrderStatus failed for ${order.id}:`, err)
                )

                fulfilled++
            } else {
                console.error(`[ManualRefulfill] FAILED for order ${order.id} via ${supplierLabel}: ${result.error}`)

                // Track failure
                await supabaseAdmin.from('mtn_fulfillment_tracking').insert({
                    order_id: order.id,
                    status: 'failed',
                    api_response: { ...result.apiResponse, note: `Manual Admin Refill Failed via ${supplierLabel}`, error: result.error }
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
            failed
        })
    } catch (error: any) {
        console.error('[ManualRefulfill] Route Error:', error)
        return NextResponse.json(
            { error: error.message || 'Internal server error' },
            { status: 500 }
        )
    }
}
