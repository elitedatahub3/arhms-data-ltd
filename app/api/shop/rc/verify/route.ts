import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { Redis } from '@upstash/redis'
import { checkPaymentStatus } from '@/lib/moolre-payment-service'
import { verifyTransaction } from '@/lib/paystack-momo-service'
import { isPaystackMomoPending, clearPaystackMomoPending } from '@/lib/paystack-momo-checkout'
import { sendPushToAdmins } from '@/lib/web-push'
import { creditShopRcProfit } from '@/lib/shop-service'

const redis = Redis.fromEnv()

export async function GET(request: NextRequest) {
    const { searchParams } = new URL(request.url)
    const ref = searchParams.get('ref')
    const slug = searchParams.get('slug')

    if (!ref || !slug) {
        return NextResponse.json({ success: false, error: 'ref and slug are required' }, { status: 400 })
    }

    if (!ref.startsWith('RC-SHOP-') || ref.length > 60) {
        return NextResponse.json({ success: false, error: 'invalid_ref' }, { status: 400 })
    }

    try {
        // 1. Ask whichever gateway actually collected.
        //
        // The pending marker is what says this was the Paystack MoMo rail. Asking
        // Moolre about a Paystack reference returns "unknown" forever, and the
        // storefront's 40x3s poll then tells the guest to wait on money already in.
        const isPaystackMomo = await isPaystackMomoPending(ref)

        if (isPaystackMomo) {
            const verified = await verifyTransaction(ref)

            if (verified.outcome === 'failed') {
                await _failOrder(ref)
                await clearPaystackMomoPending(ref)
                return NextResponse.json({ success: false, status: 'failed', message: 'Payment was not completed.' })
            }
            if (verified.outcome !== 'paid') {
                return NextResponse.json({ success: true, status: 'pending' })
            }
        } else {
            const moolreResponse = await checkPaymentStatus(ref)

            if (!moolreResponse.success || moolreResponse.txstatus === null) {
                return NextResponse.json({ success: true, status: 'pending' })
            }

            // Pending / processing
            if (moolreResponse.txstatus === 0 || moolreResponse.txstatus === 3) {
                return NextResponse.json({ success: true, status: 'pending' })
            }

            // Failed / cancelled
            if (moolreResponse.txstatus === 2) {
                // Release reserved vouchers by updating the pending order to failed
                await _failOrder(ref)
                return NextResponse.json({ success: false, status: 'failed', message: 'Payment was not completed.' })
            }
        }

        // 2. Payment succeeded — fetch metadata from Redis
        let metaStr: string | null = null
        try {
            metaStr = await redis.get<string>(`shop:rc:meta:${ref}`)
        } catch (redisErr) {
            console.error('[shop/rc/verify] Redis get error (falling back to DB):', redisErr)
        }

        const db = createServerClient() as any
        let meta: any

        if (metaStr) {
            try {
                meta = typeof metaStr === 'string' ? JSON.parse(metaStr) : metaStr
            } catch {
                meta = metaStr
            }
        } else {
            // Fallback: Fetch metadata directly from the database if Redis is down or key expired
            const { data: dbOrder } = await db
                .from('results_checker_orders')
                .select(`
                    id, shop_id, shop_name, type_id, type_name, quantity, unit_price, cost_price_at_time, shop_markup, total_paid,
                    shop_profiles!inner(owner_id)
                `)
                .eq('reference_code', ref)
                .maybeSingle()

            if (!dbOrder) {
                console.error('[shop/rc/verify] Metadata missing from Redis AND database for ref:', ref)
                return NextResponse.json({ success: false, status: 'error', error: 'Order metadata not found' }, { status: 500 })
            }

            meta = {
                shop_id: dbOrder.shop_id,
                shop_name: dbOrder.shop_name,
                rc_type_id: dbOrder.type_id,
                rc_type_name: dbOrder.type_name,
                order_id: dbOrder.id,
                quantity: dbOrder.quantity,
                unit_price: dbOrder.unit_price,
                cost_price: dbOrder.cost_price_at_time,
                shop_markup: dbOrder.shop_markup,
                total_paid: dbOrder.total_paid,
                owner_id: dbOrder.shop_profiles?.owner_id,
            }
        }



        // 3. Idempotency — check if already fulfilled
        const { data: existingOrder } = await db
            .from('results_checker_orders')
            .select('id, status, payment_status, inventory_ids')
            .eq('id', meta.order_id)
            .maybeSingle()

        if (existingOrder?.payment_status === 'completed') {
            // Already processed — return vouchers from DB
            const vouchers = await _fetchVouchers(db, existingOrder.inventory_ids || [])
            return NextResponse.json({ success: true, status: 'completed', vouchers })
        }

        // 4. Finalize: mark inventory as sold
        const { data: soldCount, error: finalizeErr } = await db.rpc('finalize_results_checker_sale', {
            p_order_id: meta.order_id,
            p_user_id: null,
        })

        if (finalizeErr) {
            console.error('[shop/rc/verify] finalize_results_checker_sale failed:', finalizeErr)
            return NextResponse.json({ success: false, status: 'error', error: 'Failed to finalize vouchers' }, { status: 500 })
        }

        // 5. Fetch the sold inventory IDs for this order
        const { data: soldInventory } = await db
            .from('results_checker_inventory')
            .select('id, pin, serial_number')
            .eq('status', 'sold')
            .eq('sold_to_user_id', null) // guest purchase
            // Match by reserved_by_order which was the temp order ID
            // Actually finalize_results_checker_sale uses reserved_by_order = p_order_id
            // We stored temp order ID as the reservation, so we need to use it here
            // Instead, fetch by the order record's inventory_ids once updated below

        // Fetch by looking up reserved inventory that was just finalized
        const { data: newlyFinalizedInventory } = await db
            .from('results_checker_inventory')
            .select('id, pin, serial_number')
            .eq('type_id', meta.rc_type_id)
            .eq('status', 'sold')
            .is('reserved_by_order', null)
            .order('sold_at', { ascending: false })
            .limit(meta.quantity)

        const inventoryIds = (newlyFinalizedInventory || []).map((i: any) => i.id)

        // 6. Update order to completed
        await db
            .from('results_checker_orders')
            .update({
                status: 'completed',
                payment_status: 'completed',
                inventory_ids: inventoryIds,
                fulfilled_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
            })
            .eq('id', meta.order_id)

        // 7. Credit shop wallet profit.
        // Shares creditShopRcProfit with finalizeRCGatewayOrder, which settles the
        // same order when a payment webhook beats this poll. The helper is
        // idempotent on the reference, so whichever path arrives second is a no-op
        // instead of a second credit.
        const shopProfit = Number(meta.shop_markup) || 0
        if (shopProfit > 0 && meta.owner_id) {
            await creditShopRcProfit({
                ownerId: meta.owner_id,
                amount: shopProfit,
                description: `RC Voucher sale: ${meta.rc_type_name} x${meta.quantity}`,
                reference: ref,
            })
        }

        // 8. Notify admin of RC sale
        await sendPushToAdmins({
            title: 'Results Checker Sale',
            body: `${meta.quantity}x ${meta.rc_type_name || 'RC Voucher'} sold · Shop: ${slug}`,
            url: '/admin/vouchers',
        }).catch(() => {})

        // 9. Clean up Redis meta
        await redis.del(`shop:rc:meta:${ref}`)
        await redis.del(`shop:rc:orderid:${ref}`)

        const vouchers = (newlyFinalizedInventory || []).map((v: any) => ({
            pin: v.pin,
            serial_number: v.serial_number,
        }))

        return NextResponse.json({ success: true, status: 'completed', vouchers })

    } catch (error: any) {
        console.error('[shop/rc/verify]', error)
        return NextResponse.json({ success: false, status: 'error', error: 'Internal server error' }, { status: 500 })
    }
}

async function _failOrder(ref: string) {
    try {
        const db = createServerClient() as any
        await db
            .from('results_checker_orders')
            .update({ status: 'failed', payment_status: 'failed', updated_at: new Date().toISOString() })
            .eq('reference_code', ref)
    } catch (e) {
        console.error('[shop/rc/verify] _failOrder error:', e)
    }
}

async function _fetchVouchers(db: any, inventoryIds: string[]) {
    if (!inventoryIds.length) return []
    const { data } = await db
        .from('results_checker_inventory')
        .select('pin, serial_number')
        .in('id', inventoryIds)
    return (data || []).map((v: any) => ({ pin: v.pin, serial_number: v.serial_number }))
}
