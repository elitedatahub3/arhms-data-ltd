import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { areCronJobsEnabled, cronDisabledResponse } from '@/lib/cron-control'
import {
    parseFulfillmentSettings, resolveRoute, fulfillWithFallback, ordersStamp, shopOrdersStamp,
    optionalStampKeys, describeAttempts, failureReason, type FulfillmentConfig,
} from '@/lib/supplier-router'
import { updateOrderWithColumnFallback } from '@/lib/order-update-fallback'

const supabaseAdmin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
)

export async function GET(request: NextRequest) {
    if (!areCronJobsEnabled()) return cronDisabledResponse()

    const authHeader = request.headers.get('authorization')
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // ── Load settings ────────────────────────────────────────────────────────
    const { data: settingsData } = await supabaseAdmin
        .from('admin_settings')
        .select('key, value')
        .in('key', [
            'auto_fulfillment_enabled',
            'fulfillment_settings',
            'cron_auto_refulfill_enabled',
            'cron_auto_refulfill_delay_minutes',
        ])

    const s = (settingsData || []).reduce((acc: Record<string, string>, r: any) => {
        acc[r.key] = r.value
        return acc
    }, {})

    // Respect global auto-fulfillment kill-switch
    if (String(s.auto_fulfillment_enabled) === 'false') {
        return NextResponse.json({ skipped: true, reason: 'Global auto-fulfillment is disabled' })
    }

    // Respect cron-specific toggle
    if (s.cron_auto_refulfill_enabled !== 'true') {
        return NextResponse.json({ skipped: true, reason: 'Auto-Refulfill cron is disabled in admin settings' })
    }

    const delayMinutes = Math.max(1, parseInt(s.cron_auto_refulfill_delay_minutes || '5'))
    const cutoff = new Date(Date.now() - delayMinutes * 60 * 1000).toISOString()

    // Routing (primary + fallback per network). The global switch was checked above.
    const config: FulfillmentConfig = { globalEnabled: true, settings: parseFulfillmentSettings(s.fulfillment_settings) }

    // ── Fetch pending orders older than the configured delay (max 50) ─────────
    const { data: pendingOrders, error: fetchError } = await supabaseAdmin
        .from('orders')
        .select('id, network, phone_number, size, status, user_id, price, shop_order_id, reference_code')
        .eq('status', 'pending')
        .lt('created_at', cutoff)
        .order('created_at', { ascending: true })
        .limit(50)

    if (fetchError) {
        console.error('[CronRefulfill] DB fetch error:', fetchError)
        return NextResponse.json({ error: fetchError.message }, { status: 500 })
    }

    if (!pendingOrders || pendingOrders.length === 0) {
        return NextResponse.json({ success: true, fulfilled: 0, skipped: 0, failed: 0, message: 'No pending orders to refulfill' })
    }

    let fulfilled = 0
    let skipped = 0
    let failed = 0

    const { sendAdminNewOrderAlert } = await import('@/lib/email-service')
    const { syncShopOrderStatus } = await import('@/lib/shop-service')

    for (const order of pendingOrders) {
        // Checked before taking the lock; the router re-checks the same config.
        const route = resolveRoute(config.settings, order.network)

        // No supplier active → skip
        if (route.kind === 'none') {
            console.log(`[CronRefulfill] No active supplier for ${order.network} — skipping ${order.id}`)
            skipped++
            continue
        }

        // More than one active → conflict — skip and alert
        if (route.kind === 'conflict') {
            console.error(`[CronRefulfill] CONFLICT: Multiple suppliers active for ${order.network} on ${order.id}`)
            await sendAdminNewOrderAlert({
                referenceCode: order.reference_code || order.id,
                phoneNumber: order.phone_number,
                network: order.network,
                size: order.size,
                price: order.price,
                customerName: 'Cron Auto-Refulfill',
                customerEmail: 'N/A',
                source: 'shop_storefront',
                shopName: 'Cron Auto-Refulfill',
                reason: `⚠️ CONFLICT: Multiple suppliers active for ${order.network}. Order ${order.id} skipped.`,
            }).catch(e => console.error('[CronRefulfill] Alert error:', e))
            skipped++
            continue
        }

        // ── ATOMIC LOCK: claim the order ─────────────────────────────────────
        const { data: lockedOrder, error: lockError } = await supabaseAdmin
            .from('orders')
            .update({ status: 'processing' })
            .eq('id', order.id)
            .eq('status', 'pending') // Only grab if still pending
            .select()
            .single()

        if (lockError || !lockedOrder) {
            console.log(`[CronRefulfill] Lock failed for ${order.id} — already taken`)
            skipped++
            continue
        }

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
            // Stamp fulfilled_by on shop_orders before each supplier call
            onBeforeAttempt: order.shop_order_id
                ? async (supplier) => {
                    await supabaseAdmin.from('shop_orders').update({ fulfilled_by: supplier.id }).eq('id', order.shop_order_id)
                }
                : undefined,
        })

        // An idempotency collision (alreadySubmitted) is not a fresh success, but
        // the order already exists at the supplier — the router reports it as placed,
        // so it stays in 'processing' (locked above) rather than reverting to pending
        // and looping forever.
        if (outcome.status === 'placed') {
            const supplierLabel = outcome.supplier.id
            const alreadySubmitted = !outcome.result.success
            console.log(`[CronRefulfill] ${alreadySubmitted ? '↺ already submitted — kept processing' : '✅ fulfilled'} ${order.id}: ${describeAttempts(outcome.attempts)}`)

            await supabaseAdmin.from('mtn_fulfillment_tracking').insert({
                order_id: order.id,
                status: alreadySubmitted ? 'processing' : 'success',
                api_response: {
                    ...outcome.result.apiResponse,
                    note: alreadySubmitted
                        ? `Cron Auto-Refulfill: order already submitted at ${supplierLabel} (idempotency) — kept processing`
                        : `Cron Auto-Refulfill Success via ${supplierLabel}`,
                    ...(outcome.fellBack ? { fallback: describeAttempts(outcome.attempts) } : {}),
                },
            })

            // Stamp fulfillment_method + supplier reference on the orders row so the
            // per-supplier status-sync crons (which filter on these) can later move
            // this order from processing → completed/failed. Without this, a direct
            // (non-shop) order fulfilled here stays stuck in 'processing' forever.
            // The reference sheds first, then fulfillment_method (guarded by
            // orders_fulfillment_method_check), if the DB is behind the code.
            const ordersUpdate = ordersStamp(outcome.supplier, outcome.reference)
            await updateOrderWithColumnFallback(
                supabaseAdmin, 'orders', { column: 'id', value: order.id },
                ordersUpdate, optionalStampKeys(ordersUpdate), '[CronRefulfill]'
            )

            if (order.shop_order_id) {
                const shopOrderUpdate: Record<string, any> = {
                    status: 'processing',
                    updated_at: new Date().toISOString(),
                    ...shopOrdersStamp(outcome.supplier, outcome.reference),
                }
                await updateOrderWithColumnFallback(
                    supabaseAdmin, 'shop_orders', { column: 'id', value: order.shop_order_id },
                    shopOrderUpdate, optionalStampKeys(shopOrderUpdate), '[CronRefulfill]'
                )
            }

            await syncShopOrderStatus(order.id, 'processing').catch(err =>
                console.error(`[CronRefulfill] syncShopOrderStatus error for ${order.id}:`, err)
            )

            fulfilled++
        } else {
            const reason = outcome.status === 'failed' ? failureReason(outcome) : `no supplier (${outcome.status})`
            console.error(`[CronRefulfill] ❌ ${order.id} failed — ${reason}`)

            await supabaseAdmin.from('mtn_fulfillment_tracking').insert({
                order_id: order.id,
                status: 'failed',
                api_response: outcome.status === 'failed'
                    ? { ...outcome.result.apiResponse, note: `Cron Auto-Refulfill Failed — ${reason}`, error: outcome.result.error, attempts: outcome.attempts }
                    : { note: `Cron Auto-Refulfill Failed — ${reason}` },
            })

            // Revert to pending so the next cron run can retry
            await supabaseAdmin.from('orders').update({ status: 'pending' }).eq('id', order.id)
            if (order.shop_order_id) {
                await supabaseAdmin.from('shop_orders').update({ status: 'pending' }).eq('id', order.shop_order_id)
            }
            await syncShopOrderStatus(order.id, 'pending').catch(() => {})

            failed++
        }
    }

    console.log(`[CronRefulfill] Done — fulfilled:${fulfilled} skipped:${skipped} failed:${failed}`)
    return NextResponse.json({ success: true, total: pendingOrders.length, fulfilled, skipped, failed })
}
