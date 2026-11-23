import { NextResponse } from 'next/server'
import { createRouteHandlerClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { listNotReceivedReports, parseGigabytes, reportNotReceived } from '@/lib/kuntanii-service'

// Admin → Kuntanii Reports. Lists a day's Kuntanii orders and raises / checks
// "not received" disputes at Kuntanii (POST/GET /orders/{id}/not-received).
// Nothing is stored on our side: Kuntanii is the record of every report, and
// "Check" reads them back. A Kuntanii refund credits OUR Kuntanii balance only —
// the customer is never refunded by this route.

export const maxDuration = 60

async function requireAdmin() {
    const supabase = await createRouteHandlerClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const { data } = await (supabase.from('users') as any).select('role').eq('id', user.id).single()
    if (!data || data.role !== 'admin') return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
    return null
}

const BASE_COLS = 'id, shop_order_id, phone_number, network, size, status, created_at'

/** One order row, tolerating a missing kuntanii_reference / supplier_status column. */
async function selectOrders(build: (cols: string) => any) {
    for (const cols of [`${BASE_COLS}, kuntanii_reference, supplier_status`, `${BASE_COLS}, supplier_status`, BASE_COLS]) {
        const res = await build(cols)
        if (!res.error) return res
        if (!/kuntanii_reference|supplier_status/i.test(res.error.message || '')) return res
    }
    return build(BASE_COLS)
}

/** The externalOrderIds Kuntanii may know this order by, most specific first. */
function keysFor(o: any): string[] {
    return [o.kuntanii_reference, o.shop_order_id, o.id].filter(Boolean).map(String)
}

export async function GET(request: Request) {
    try {
        const denied = await requireAdmin()
        if (denied) return denied
        const url = new URL(request.url)
        const db = createServerClient() as any

        // ?orderId=… → the reports Kuntanii holds for that order.
        const orderId = url.searchParams.get('orderId')
        if (orderId) {
            const { data: order, error } = await selectOrders(cols =>
                db.from('orders').select(cols).eq('id', orderId).eq('fulfillment_method', 'kuntanii').maybeSingle())
            if (error) return NextResponse.json({ error: error.message }, { status: 500 })
            if (!order) return NextResponse.json({ error: 'Not a Kuntanii order' }, { status: 404 })
            return NextResponse.json(await listNotReceivedReports(keysFor(order)))
        }

        // ?date=YYYY-MM-DD (Ghana = UTC) → that day's Kuntanii orders.
        const date = url.searchParams.get('date') || new Date().toISOString().slice(0, 10)
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return NextResponse.json({ error: 'Bad date' }, { status: 400 })
        const start = new Date(`${date}T00:00:00.000Z`)
        const end = new Date(start.getTime() + 24 * 3600_000)
        const { data, error } = await selectOrders(cols =>
            db.from('orders').select(cols)
                .eq('fulfillment_method', 'kuntanii')
                .gte('created_at', start.toISOString())
                .lt('created_at', end.toISOString())
                .order('created_at', { ascending: false })
                .limit(1000))
        if (error) return NextResponse.json({ error: error.message }, { status: 500 })
        const orders = (data || []).map((o: any) => ({
            id: o.id,
            externalOrderId: keysFor(o)[0],
            isShop: !!o.shop_order_id,
            phone: o.phone_number,
            network: o.network,
            size: o.size,
            dataGb: parseGigabytes(o.size || ''),
            status: o.status,
            supplierStatus: o.supplier_status ?? null,
            createdAt: o.created_at,
        }))
        return NextResponse.json({ date, orders })
    } catch (error: any) {
        console.error('[KuntaniiNotReceived] GET error:', error)
        return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 })
    }
}

export async function POST(request: Request) {
    try {
        const denied = await requireAdmin()
        if (denied) return denied
        const body = await request.json().catch(() => ({}))
        const orderIds: string[] = Array.isArray(body.orderIds) ? body.orderIds.map(String).slice(0, 10)
            : body.orderId ? [String(body.orderId)] : []
        if (orderIds.length === 0) return NextResponse.json({ error: 'orderId required' }, { status: 400 })
        const description = typeof body.description === 'string' && body.description.trim()
            ? body.description.trim()
            : 'Customer says the bundle never arrived.'

        const db = createServerClient() as any
        const { data: orders, error } = await selectOrders(cols =>
            db.from('orders').select(cols).in('id', orderIds).eq('fulfillment_method', 'kuntanii'))
        if (error) return NextResponse.json({ error: error.message }, { status: 500 })
        const byId = new Map<string, any>((orders || []).map((o: any) => [String(o.id), o]))

        const results = []
        for (const id of orderIds) {
            const o = byId.get(id)
            if (!o) { results.push({ orderId: id, success: false, error: 'Not a Kuntanii order' }); continue }
            // Always taken from OUR row, never from the client.
            const res = await reportNotReceived(keysFor(o), {
                phoneNumber: o.phone_number,
                dataGb: parseGigabytes(o.size || ''),
                description,
            })
            results.push({ orderId: id, ...res })
        }
        return NextResponse.json({ results })
    } catch (error: any) {
        console.error('[KuntaniiNotReceived] POST error:', error)
        return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 })
    }
}
