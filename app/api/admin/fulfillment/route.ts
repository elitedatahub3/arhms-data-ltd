import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { validateAdminAccess } from '@/lib/auth-utils'
import { parsePagination } from '@/lib/pagination'

export async function GET(request: NextRequest) {
    try {
        const authResult = await validateAdminAccess(false, request)
        if (authResult.error) {
            return NextResponse.json({ error: authResult.error }, { status: authResult.status })
        }

        const { searchParams } = new URL(request.url)
        const network = searchParams.get('network')
        const status = searchParams.get('status')
        const startDate = searchParams.get('startDate')
        const endDate = searchParams.get('endDate')
        const search = searchParams.get('search')
        // A busy day runs well past a couple hundred orders, and the fulfillment
        // centre's stat tiles are computed from whatever this returns — a silent
        // cap made the admin's "today" totals under-report the day. The page walks
        // pages via `offset` and adds them up, so keep the ceiling generous.
        const { limit, offset } = parsePagination(searchParams, { defaultLimit: 500, maxLimit: 1000 })

        // Use service role client to bypass RLS
        const supabase = createServerClient()

        // The date range means what it says — except when you ask for the queue.
        //
        // Picking a date answers "what happened then", so "All" is scoped to it
        // strictly: Today shows today, and nothing older leaks in. Picking
        // Pending, Processing or Verifying asks a different question — "what is
        // still outstanding" — and a stuck order is nearly always older than the
        // window being looked at, so those three ignore dates and show the whole
        // queue. That is the only way both readings can be true at once.
        const OPEN_STATUSES = ['pending', 'processing']

        // 'verifying' is a held 'processing' order — still open work.
        const viewingOpenOnly = status === 'verifying' || OPEN_STATUSES.includes(status || '')

        // `supplier_status` is a later migration than this route. Selected through a
        // flag so that a DB without it degrades to the old column list instead of
        // PostgREST rejecting the whole query and blanking the fulfillment list —
        // the same trade the NetPulse cron makes on the write side.
        const buildQuery = (withSupplierStatus: boolean) => {
            let q = supabase
                .from('orders')
                .select(`
                    id, created_at, phone_number, network, size, price, status, payment_status,${withSupplierStatus ? ' supplier_status,' : ''} user_id, shop_name, shop_order_id, cost_price_at_time,
                    users (
                        first_name,
                        last_name,
                        role,
                        email
                    ),
                    shop_orders (
                        cost_price,
                        admin_cost_at_time
                    ),
                    mtn_fulfillment_tracking (
                        status,
                        api_response,
                        retry_count
                    )
                `, { count: 'exact' })

            // Filter by pertinent statuses for fulfillment center
            if (withSupplierStatus && status === 'verifying') {
                // Not a real status — an order held for review is still 'processing',
                // carrying the hold in supplier_status. Matched with LIKE rather than
                // an exact list because suppliers write the label their own way
                // ("On Hold", "on_hold", "Pending Verification"); the canonical set
                // lives in lib/order-status-display.
                q = q
                    .eq('status', 'processing')
                    .or('supplier_status.ilike.%verif%,supplier_status.ilike.%hold%,supplier_status.ilike.%review%')
            } else if (status === 'verifying') {
                q = q.eq('status', 'processing')
            } else if (status && status !== 'All') {
                q = q.eq('status', status)
            } else {
                q = q.in('status', ['processing', 'failed', 'completed', 'pending'])
            }

            if (network && network !== 'All') {
                q = q.eq('network', network)
            }

            if (viewingOpenOnly) {
                // A work queue, not a report — show everything outstanding.
            } else {
                if (startDate) {
                    q = q.gte('created_at', startDate)
                }
                if (endDate) {
                    q = q.lte('created_at', endDate)
                }
            }

            if (search) {
                q = q.ilike('phone_number', `%${search}%`)
            }

            return q.order('created_at', { ascending: false }).range(offset, offset + limit - 1)
        }

        let { data: rawOrders, error: fetchError, count } = await buildQuery(true)

        // 42703 = undefined_column: the migration has not been applied here.
        if (fetchError?.code === '42703') {
            console.warn('[FulfillmentFetch] supplier_status missing — retrying without it')
            ;({ data: rawOrders, error: fetchError, count } = await buildQuery(false))
        }

        if (fetchError) {
            console.error('[FulfillmentFetch] Error:', fetchError)
            throw fetchError
        }

        // Transform data to match expected frontend structure (extracting transaction_id)
        const orders = (rawOrders || []).map((order: any) => {
            const tracking = order.mtn_fulfillment_tracking && order.mtn_fulfillment_tracking[0]
                ? order.mtn_fulfillment_tracking
                : []

            // Map tracking info to include extracted transaction_id
            const mappedTracking = tracking.map((t: any) => ({
                ...t,
                transaction_id: t.api_response?.data?.transaction_id || t.api_response?.transactionId || null
            }))

            const isShopOrder = order.shop_order_id && order.shop_orders
            
            const adminRevenue = isShopOrder 
                ? order.shop_orders.cost_price         // What the shop owner paid the admin
                : order.price                          // What the direct customer paid the admin

            const adminTrueCost = isShopOrder
                ? order.shop_orders.admin_cost_at_time // Admin's supplier cost for the shop order
                : order.cost_price_at_time             // Admin's supplier cost for the direct order

            return {
                ...order,
                original_shop_price: order.price,
                price: adminRevenue,
                cost_price: adminTrueCost,
                mtn_fulfillment_tracking: mappedTracking
            }
        })

        const total = typeof count === 'number' ? count : offset + orders.length

        return NextResponse.json({
            orders: orders,
            total,
            limit,
            offset,
            hasMore: offset + orders.length < total
        })
    } catch (error: any) {
        console.error('Fulfillment Orders Fetch Error:', error)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
