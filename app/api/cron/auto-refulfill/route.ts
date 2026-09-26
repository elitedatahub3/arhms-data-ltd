import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { areCronJobsEnabled, cronDisabledResponse } from '@/lib/cron-control'

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

    // Parse supplier network routing
    const dbFulfillmentSettings = typeof s.fulfillment_settings === 'string'
        ? JSON.parse(s.fulfillment_settings)
        : s.fulfillment_settings || {}
    const networkSettings: Record<string, boolean> = dbFulfillmentSettings.networks || {}
    const codecraftNetworkSettings: Record<string, boolean> = dbFulfillmentSettings.codecraft_networks || {}
    const kingflexyNetworkSettings: Record<string, boolean> = dbFulfillmentSettings.kingflexy_networks || {}
    const eazydataNetworkSettings: Record<string, boolean> = dbFulfillmentSettings.eazydata_networks || {}
    const agentportalNetworkSettings: Record<string, boolean> = dbFulfillmentSettings.agentportal_networks || {}
    const netpulseNetworkSettings: Record<string, boolean> = dbFulfillmentSettings.netpulse_networks || {}
    const hendylinksNetworkSettings: Record<string, boolean> = dbFulfillmentSettings.hendylinks_networks || {}

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
    const { fulfillOrder } = await import('@/lib/fulfillment-service')
    const { fulfillOrder: ccFulfillOrder } = await import('@/lib/codecraft-service')
    const { fulfillOrder: kfFulfillOrder } = await import('@/lib/kingflexy-service')
    const { fulfillOrder: edFulfillOrder } = await import('@/lib/eazydata-service')
    const { fulfillOrder: apFulfillOrder } = await import('@/lib/agentportal-service')
    const { fulfillOrder: npFulfillOrder } = await import('@/lib/netpulse-service')
    const { fulfillOrder: hlFulfillOrder } = await import('@/lib/hendylinks-service')
    const { syncShopOrderStatus } = await import('@/lib/shop-service')

    for (const order of pendingOrders) {
        const isDataKazinaEnabled = networkSettings[order.network] === true
        const isCodeCraftEnabled = codecraftNetworkSettings[order.network] === true
        const isKingFlexyEnabled = kingflexyNetworkSettings[order.network] === true
        const isEazyDataEnabled = eazydataNetworkSettings[order.network] === true
        const isAgentPortalEnabled = agentportalNetworkSettings[order.network] === true
        const isNetPulseEnabled = netpulseNetworkSettings[order.network] === true
        const isHendyLinksEnabled = hendylinksNetworkSettings[order.network] === true

        // No supplier active → skip
        if (!isDataKazinaEnabled && !isCodeCraftEnabled && !isKingFlexyEnabled && !isEazyDataEnabled && !isAgentPortalEnabled && !isNetPulseEnabled && !isHendyLinksEnabled) {
            console.log(`[CronRefulfill] No active supplier for ${order.network} — skipping ${order.id}`)
            skipped++
            continue
        }

        // More than one active → conflict — skip and alert
        const activeCount = [isDataKazinaEnabled, isCodeCraftEnabled, isKingFlexyEnabled, isEazyDataEnabled, isAgentPortalEnabled, isNetPulseEnabled, isHendyLinksEnabled].filter(Boolean).length
        if (activeCount > 1) {
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

        const supplierLabel = isCodeCraftEnabled ? 'codecraft' : isKingFlexyEnabled ? 'kingflexy' : isEazyDataEnabled ? 'eazydata' : isAgentPortalEnabled ? 'agentportal' : isNetPulseEnabled ? 'netpulse' : isHendyLinksEnabled ? 'hendylinks' : 'datakazina'

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

        // Stamp fulfilled_by on shop_orders
        if (order.shop_order_id) {
            await supabaseAdmin
                .from('shop_orders')
                .update({ fulfilled_by: supplierLabel })
                .eq('id', order.shop_order_id)
        }

        // webhookRef is set by the Dakazina path only (see lib/fulfillment-service).
        const result: { success: boolean; reference?: string; transactionId?: string; webhookRef?: string; error?: string; apiResponse?: any; alreadySubmitted?: boolean } = isCodeCraftEnabled
            ? await ccFulfillOrder(order.network, order.phone_number, order.size, order.id)
            : isKingFlexyEnabled
                ? await kfFulfillOrder(order.network, order.phone_number, order.size, order.id)
                : isEazyDataEnabled
                    ? await edFulfillOrder(order.network, order.phone_number, order.size, order.id)
                    : isAgentPortalEnabled
                        ? await apFulfillOrder(order.network, order.phone_number, order.size, order.id)
                        : isNetPulseEnabled
                            ? await npFulfillOrder(order.network, order.phone_number, order.size, order.id)
                            : isHendyLinksEnabled
                                // isRetry: HendyLinks accepts no idempotency key, so a request
                                // that timed out may already have created an order. This makes
                                // the service check their history before placing another.
                                ? await hlFulfillOrder(order.network, order.phone_number, order.size, order.id, { isRetry: true })
                                : await fulfillOrder(order.network, order.phone_number, order.size, order.id)

        // An idempotency collision (alreadySubmitted) is not a fresh success, but
        // the order already exists at the supplier — keep it in 'processing' (locked
        // above) rather than reverting to pending and looping forever.
        const alreadySubmitted = !result.success && result.alreadySubmitted === true
        if (result.success || alreadySubmitted) {
            console.log(`[CronRefulfill] ${alreadySubmitted ? '↺ already submitted — kept processing' : '✅ fulfilled'} ${order.id} via ${supplierLabel}`)

            await supabaseAdmin.from('mtn_fulfillment_tracking').insert({
                order_id: order.id,
                status: alreadySubmitted ? 'processing' : 'success',
                api_response: {
                    ...result.apiResponse,
                    note: alreadySubmitted
                        ? `Cron Auto-Refulfill: order already submitted at ${supplierLabel} (idempotency) — kept processing`
                        : `Cron Auto-Refulfill Success via ${supplierLabel}`,
                },
            })

            // Stamp fulfillment_method + supplier reference on the orders row so the
            // per-supplier status-sync crons (which filter on these) can later move
            // this order from processing → completed/failed. Without this, a direct
            // (non-shop) order fulfilled here stays stuck in 'processing' forever.
            // Reference columns are unconstrained → stamp them first so they always
            // apply, even on a DB where the eazydata fulfillment_method migration
            // hasn't run yet.
            const refUpdate: Record<string, any> = {}
            if (result.transactionId) {
                if (isCodeCraftEnabled) refUpdate.codecraft_reference = result.transactionId
                else if (isKingFlexyEnabled) refUpdate.kingflexy_reference = result.transactionId
                else if (isEazyDataEnabled) refUpdate.eazydata_reference = result.transactionId
                else if (isAgentPortalEnabled) refUpdate.agentportal_reference = result.transactionId
                else if (isNetPulseEnabled) refUpdate.netpulse_reference = result.transactionId
                else if (isHendyLinksEnabled) refUpdate.hendylinks_reference = result.transactionId
                else refUpdate.dakazina_reference = result.transactionId
            }
            // See the matching note in app/api/admin/fulfillment/refulfill.
            if (result.webhookRef) refUpdate.dakazina_reference = result.webhookRef
            if (Object.keys(refUpdate).length > 0) {
                await supabaseAdmin.from('orders').update(refUpdate).eq('id', order.id)
            }
            // fulfillment_method is guarded by orders_fulfillment_method_check
            // (requires migration 20260713_add_eazydata_fulfillment_method.sql).
            await supabaseAdmin.from('orders').update({ fulfillment_method: supplierLabel }).eq('id', order.id)

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
                if (isNetPulseEnabled && result.transactionId) {
                    shopOrderUpdate.netpulse_reference = result.transactionId
                }
                if (isHendyLinksEnabled && result.transactionId) {
                    shopOrderUpdate.hendylinks_reference = result.transactionId
                }
                await supabaseAdmin.from('shop_orders').update(shopOrderUpdate).eq('id', order.shop_order_id)
            }

            await syncShopOrderStatus(order.id, 'processing').catch(err =>
                console.error(`[CronRefulfill] syncShopOrderStatus error for ${order.id}:`, err)
            )

            fulfilled++
        } else {
            console.error(`[CronRefulfill] ❌ ${order.id} failed via ${supplierLabel}: ${result.error}`)

            await supabaseAdmin.from('mtn_fulfillment_tracking').insert({
                order_id: order.id,
                status: 'failed',
                api_response: { ...result.apiResponse, note: `Cron Auto-Refulfill Failed via ${supplierLabel}`, error: result.error },
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
