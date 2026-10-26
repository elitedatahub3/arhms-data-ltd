import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { verifyBundlesAdmin } from '@/lib/bundle-admin'
import { finalizeBundleOrder } from '@/lib/bundle-order-completion'
import { triggerBundleDispatch } from '@/lib/bundle-dispatcher'
import { reconcileBundleOrder } from '@/lib/bundle-settlement'

export const dynamic = 'force-dynamic'

const STATUSES = ['pending', 'processing', 'completed', 'failed', 'refunded']

/** GET — recent orders with buyer name, optional ?status= and ?q= (reference or phone). */
export async function GET(request: NextRequest) {
    const admin = await verifyBundlesAdmin()
    if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const status = request.nextUrl.searchParams.get('status')
    const q = (request.nextUrl.searchParams.get('q') || '').trim()

    const supabase = createServerClient() as any
    let query = supabase
        .from('bundle_orders')
        .select('*, users:user_id (first_name, last_name, email, phone_number)')
        .order('created_at', { ascending: false })
        .limit(200)

    if (status && STATUSES.includes(status)) query = query.eq('status', status)
    if (q) {
        // Only characters a reference or phone can hold, so the filter cannot be
        // broken out of.
        const safe = q.replace(/[^A-Za-z0-9-]/g, '')
        if (safe) query = query.or(`reference_code.ilike.%${safe}%,beneficiary_phone.ilike.%${safe}%,provider_reference.ilike.%${safe}%`)
    }

    const { data, error } = await query
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    // Today's totals for the header cards.
    const since = new Date()
    since.setHours(0, 0, 0, 0)
    const { data: today } = await supabase
        .from('bundle_orders')
        .select('status, total_paid, cost_amount, kf_commission')
        .gte('created_at', since.toISOString())

    const summary = { orders: 0, completed: 0, sales: 0, markup: 0, kfCommission: 0 }
    for (const o of (today || [])) {
        summary.orders++
        if (o.status === 'completed') {
            summary.completed++
            summary.sales += Number(o.total_paid || 0)
            summary.markup += Number(o.total_paid || 0) - Number(o.cost_amount || 0)
            summary.kfCommission += Number(o.kf_commission || 0)
        }
    }

    return NextResponse.json({ orders: data || [], summary })
}

/**
 * PATCH — { orderId, action, note? }
 *   send     release a pending order (bypasses the auto-dispatch switch)
 *   recheck  ask KingFlexy for the order's status now
 *   complete mark delivered by hand
 *   refund   fail and return the money to the buyer's wallet
 */
export async function PATCH(request: NextRequest) {
    const admin = await verifyBundlesAdmin()
    if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    let body: any
    try {
        body = await request.json()
    } catch {
        return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
    }
    const { orderId, action } = body || {}
    const note = typeof body?.note === 'string' ? body.note.slice(0, 500) : null
    if (typeof orderId !== 'string') return NextResponse.json({ error: 'orderId required' }, { status: 400 })

    const supabase = createServerClient() as any
    const { data: order } = await supabase.from('bundle_orders').select('*').eq('id', orderId).single()
    if (!order) return NextResponse.json({ error: 'Order not found' }, { status: 404 })

    switch (action) {
        case 'send': {
            const res = await triggerBundleDispatch(orderId, { force: true })
            return res.dispatched
                ? NextResponse.json({ success: true })
                : NextResponse.json({ error: `Not sent: ${res.reason}` }, { status: 409 })
        }
        case 'recheck': {
            const outcome = await reconcileBundleOrder(order, { resendIfMissing: false })
            return NextResponse.json({ success: true, outcome })
        }
        case 'complete': {
            if (order.status === 'completed' || order.status === 'refunded') {
                return NextResponse.json({ error: `Order is already ${order.status}` }, { status: 409 })
            }
            const res = await finalizeBundleOrder({ orderId, status: 'completed', actorId: admin.userId, note: note || 'Marked delivered by admin.', existingOrder: order })
            return res.success ? NextResponse.json({ success: true }) : NextResponse.json({ error: res.error }, { status: 500 })
        }
        case 'refund': {
            if (order.payment_status !== 'paid') {
                return NextResponse.json({ error: `Payment is already ${order.payment_status}` }, { status: 409 })
            }
            if (order.status === 'completed') {
                return NextResponse.json({ error: 'This bundle was delivered. Refunding it would pay for it twice.' }, { status: 409 })
            }
            const res = await finalizeBundleOrder({ orderId, status: 'failed', refund: true, actorId: admin.userId, note: note || 'Refunded by admin.', existingOrder: order })
            return res.success ? NextResponse.json({ success: true, refunded: res.refunded }) : NextResponse.json({ error: res.error }, { status: 500 })
        }
        default:
            return NextResponse.json({ error: 'action must be send, recheck, complete or refund' }, { status: 400 })
    }
}
