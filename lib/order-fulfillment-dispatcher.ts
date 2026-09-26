import { createServerClient } from '@/lib/supabase'
import { updateOrderWithColumnFallback } from '@/lib/order-update-fallback'

/**
 * Routes a paid order to the active supplier for the given network.
 *
 * Extracted verbatim from app/api/orders/purchase/route.ts so both the
 * wallet purchase path and the direct-pay settlement path
 * (lib/data-order-payments.ts) dispatch through exactly the same logic.
 */
export async function triggerFulfillment(orderId: string, network: string, user: { email: string, name: string }) {
    try {
        const { sendAdminNewOrderAlert } = await import('@/lib/email-service')
        const { syncShopOrderStatus } = await import('@/lib/shop-service')
        const supabase = createServerClient()

        const { data: settingsData } = await supabase
            .from('admin_settings')
            .select('key, value')
            .in('key', ['auto_fulfillment_enabled', 'fulfillment_settings'])

        const settingsMap = (settingsData || []).reduce((acc: any, curr: any) => {
            acc[curr.key] = curr.value
            return acc
        }, {})

        const { data: order } = await supabase
            .from('orders')
            .select('*')
            .eq('id', orderId)
            .single()

        if (!order) {
            console.error(`[Fulfillment] Order ${orderId} not found`)
            return
        }

        const alertDetails = {
            referenceCode: (order as any).reference_code,
            phoneNumber: (order as any).phone_number,
            network: (order as any).network,
            size: (order as any).size,
            price: (order as any).price,
            customerName: user.name,
            customerEmail: user.email,
            source: 'main_site' as const,
            reason: ''
        }

        if (String(settingsMap.auto_fulfillment_enabled) === 'false') {
            await sendAdminNewOrderAlert({ ...alertDetails, reason: 'Global auto-fulfillment is disabled' })
                .catch(err => console.error('[Fulfillment] Admin alert (global disabled) failed:', err))
            return
        }

        // ── Parse all supplier network settings ───────────────────────────
        let fulfillmentSettings: {
            networks: Record<string, boolean>
            codecraft_networks: Record<string, boolean>
            kingflexy_networks: Record<string, boolean>
            eazydata_networks: Record<string, boolean>
            agentportal_networks: Record<string, boolean>
            netpulse_networks: Record<string, boolean>
            hendylinks_networks: Record<string, boolean>
        } = { networks: {}, codecraft_networks: {}, kingflexy_networks: {}, eazydata_networks: {}, agentportal_networks: {}, netpulse_networks: {}, hendylinks_networks: {} }
        try {
            if (settingsMap.fulfillment_settings) {
                const parsed = typeof settingsMap.fulfillment_settings === 'string'
                    ? JSON.parse(settingsMap.fulfillment_settings)
                    : settingsMap.fulfillment_settings
                fulfillmentSettings.networks = parsed.networks || {}
                fulfillmentSettings.codecraft_networks = parsed.codecraft_networks || {}
                fulfillmentSettings.kingflexy_networks = parsed.kingflexy_networks || {}
                fulfillmentSettings.eazydata_networks = parsed.eazydata_networks || {}
                fulfillmentSettings.agentportal_networks = parsed.agentportal_networks || {}
                fulfillmentSettings.netpulse_networks = parsed.netpulse_networks || {}
                fulfillmentSettings.hendylinks_networks = parsed.hendylinks_networks || {}
            }
        } catch (e) {
            console.error('[Fulfillment] Failed to parse fulfillment_settings:', e)
        }

        const isDataKazinaEnabled = fulfillmentSettings.networks[network] === true
        const isCodeCraftEnabled = fulfillmentSettings.codecraft_networks[network] === true
        const isKingFlexyEnabled = fulfillmentSettings.kingflexy_networks[network] === true
        const isEazyDataEnabled = fulfillmentSettings.eazydata_networks[network] === true
        const isAgentPortalEnabled = fulfillmentSettings.agentportal_networks[network] === true
        const isNetPulseEnabled = fulfillmentSettings.netpulse_networks[network] === true
        const isHendyLinksEnabled = fulfillmentSettings.hendylinks_networks[network] === true

        // ── Conflict Guard ─────────────────────────────────────────────────
        const activeSupplierCount = [isDataKazinaEnabled, isCodeCraftEnabled, isKingFlexyEnabled, isEazyDataEnabled, isAgentPortalEnabled, isNetPulseEnabled, isHendyLinksEnabled].filter(Boolean).length
        if (activeSupplierCount > 1) {
            console.error(`[Fulfillment] CONFLICT DETECTED for ${network} on order ${orderId}`)
            await sendAdminNewOrderAlert({
                ...alertDetails,
                reason: `⚠️ SYSTEM HALTED: Multiple suppliers are active for ${network}. Order ${orderId} kept pending. Fix in admin panel immediately.`
            }).catch(err => console.error('[Fulfillment] Conflict alert failed:', err))
            return
        }

        // ── No Supplier Guard ──────────────────────────────────────────────
        if (!isDataKazinaEnabled && !isCodeCraftEnabled && !isKingFlexyEnabled && !isEazyDataEnabled && !isAgentPortalEnabled && !isNetPulseEnabled && !isHendyLinksEnabled) {
            console.log(`[Fulfillment] No active supplier for network ${network}. Order ${orderId} kept pending.`)
            await sendAdminNewOrderAlert({ ...alertDetails, reason: `No active supplier configured for network: ${network}` })
                .catch(err => console.error('[Fulfillment] No-supplier alert failed:', err))
            return
        }

        const supplierLabel = isCodeCraftEnabled ? 'codecraft' : isKingFlexyEnabled ? 'kingflexy' : isEazyDataEnabled ? 'eazydata' : isAgentPortalEnabled ? 'agentportal' : isNetPulseEnabled ? 'netpulse' : isHendyLinksEnabled ? 'hendylinks' : 'datakazina'
        console.log(`[Fulfillment] Routing to ${supplierLabel} for order ${orderId} | network: ${network}`)

        // ── Idempotency check ──────────────────────────────────────────────
        const { data: existingTracking } = await supabase
            .from('mtn_fulfillment_tracking')
            .select('status')
            .eq('order_id', orderId)
            .single()

        if (existingTracking) {
            console.log(`[Fulfillment] Order ${orderId} already in tracking, skipping`)
            return
        }

        // ── Execute fulfillment ────────────────────────────────────────────
        // webhookRef is set by the Dakazina path only (see lib/fulfillment-service).
        let result: { success: boolean; reference?: string; transactionId?: string; webhookRef?: string; error?: string; apiResponse?: any }
        try {
            if (isCodeCraftEnabled) {
                const { fulfillOrder: ccFulfill } = await import('@/lib/codecraft-service')
                result = await ccFulfill(network, (order as any).phone_number, (order as any).size, orderId)
            } else if (isKingFlexyEnabled) {
                const { fulfillOrder: kfFulfill } = await import('@/lib/kingflexy-service')
                result = await kfFulfill(network, (order as any).phone_number, (order as any).size, orderId)
            } else if (isEazyDataEnabled) {
                const { fulfillOrder: edFulfill } = await import('@/lib/eazydata-service')
                result = await edFulfill(network, (order as any).phone_number, (order as any).size, orderId)
            } else if (isAgentPortalEnabled) {
                const { fulfillOrder: apFulfill } = await import('@/lib/agentportal-service')
                result = await apFulfill(network, (order as any).phone_number, (order as any).size, orderId)
            } else if (isNetPulseEnabled) {
                const { fulfillOrder: npFulfill } = await import('@/lib/netpulse-service')
                result = await npFulfill(network, (order as any).phone_number, (order as any).size, orderId)
            } else if (isHendyLinksEnabled) {
                const { fulfillOrder: hlFulfill } = await import('@/lib/hendylinks-service')
                result = await hlFulfill(network, (order as any).phone_number, (order as any).size, orderId)
            } else {
                const { fulfillOrder: dkFulfill } = await import('@/lib/fulfillment-service')
                result = await dkFulfill(network, (order as any).phone_number, (order as any).size, orderId)
            }
        } catch (supplierErr: any) {
            console.error(`[Fulfillment] Supplier call exception for order ${orderId}:`, supplierErr)
            await sendAdminNewOrderAlert({ ...alertDetails, reason: `Supplier exception: ${supplierErr.message}` })
                .catch(err => console.error('[Fulfillment] Exception alert failed:', err))
            return
        }

        if (result.success) {
            // ── Build atomic orders update ─────────────────────────────────
            const ordersUpdate: Record<string, any> = {
                status: 'processing',
                updated_at: new Date().toISOString(),
                fulfillment_method: supplierLabel,
            }
            if (isCodeCraftEnabled && (result.transactionId || result.reference)) {
                ordersUpdate.codecraft_reference = result.transactionId || result.reference
            }
            if (isKingFlexyEnabled && (result.transactionId || result.reference)) {
                ordersUpdate.kingflexy_reference = result.transactionId || result.reference
            }
            if (isEazyDataEnabled && (result.transactionId || result.reference)) {
                ordersUpdate.eazydata_reference = result.transactionId || result.reference
            }
            if (isAgentPortalEnabled && (result.transactionId || result.reference)) {
                ordersUpdate.agentportal_reference = result.transactionId || result.reference
            }
            if (isNetPulseEnabled && (result.transactionId || result.reference)) {
                ordersUpdate.netpulse_reference = result.transactionId || result.reference
            }
            if (isHendyLinksEnabled && (result.transactionId || result.reference)) {
                ordersUpdate.hendylinks_reference = result.transactionId || result.reference
            }
            if (!isCodeCraftEnabled && !isKingFlexyEnabled && !isEazyDataEnabled && !isAgentPortalEnabled && !isNetPulseEnabled && !isHendyLinksEnabled && (result.webhookRef || result.transactionId || result.reference)) {
                // webhookRef FIRST: it is the only identifier Dakazina echoes back on an
                // event, and their status endpoint 404s, so the webhook is the sole way
                // one of these orders can learn it was delivered.
                ordersUpdate.dakazina_reference = result.webhookRef || result.transactionId || result.reference
            }

            // The supplier has already been called and paid. Shed the optional columns
            // rather than let one missing migration fail the whole write — an order left
            // 'pending' here gets picked up by the refulfill cron and bought AGAIN.
            // Reference columns first (added by the newest supplier migration), then
            // fulfillment_method (guarded by orders_fulfillment_method_check, which the
            // same migration widens). The status transition is what must survive.
            await updateOrderWithColumnFallback(
                supabase,
                'orders',
                { column: 'id', value: orderId },
                ordersUpdate,
                [...Object.keys(ordersUpdate).filter(k => k.endsWith('_reference')), 'fulfillment_method'],
                '[OrderPurchase]'
            )

            await (supabase.from('mtn_fulfillment_tracking') as any).insert({
                order_id: orderId,
                status: 'processing',
                api_response: {
                    ...(result.apiResponse || {}),
                    reference: result.transactionId || result.reference,
                    supplier: supplierLabel,
                    network,
                },
            })

            // Sync status to healing wrapper so shop owners see it
            await syncShopOrderStatus(orderId, 'processing').catch(err =>
                console.error(`[Fulfillment] syncShopOrderStatus failed for ${orderId}:`, err)
            )

            // AirtelTigo via Agent Portal has no verification gate — it delivers quickly.
            // Reassure the recipient once that delivery is instant.
            if (isAgentPortalEnabled && /^AT/i.test(network)) {
                const { sendAtInstantDeliverySMS } = await import('@/lib/sms-service')
                await sendAtInstantDeliverySMS((order as any).phone_number, {
                    network: (order as any).network,
                    size: (order as any).size,
                }).catch(err => console.error('[Fulfillment] AT instant SMS failed:', err))
            } else if (/MTN/i.test(network)) {
                // MTN is with the supplier now. Confirm receipt once, without quoting a
                // delivery time — the retry cron must never re-send this.
                const { sendMtnOrderReceivedSMS } = await import('@/lib/sms-service')
                await sendMtnOrderReceivedSMS((order as any).phone_number, {
                    network: (order as any).network,
                    size: (order as any).size,
                }).catch(err => console.error('[Fulfillment] MTN order-received SMS failed:', err))
            }
        } else {
            // Failure — keep order as pending (do not update orders table status)
            console.warn(`[Fulfillment] Supplier ${supplierLabel} failed for order ${orderId}: ${result.error}`)

            // MTN whitelist gate (Agent Portal): the number is auto-submitted to MTN
            // for verification (up to 2 weeks) and the auto-refulfill cron delivers once it
            // clears. No SMS is sent to the recipient while the order is pending.

            await sendAdminNewOrderAlert({ ...alertDetails, reason: `Auto-fulfillment API error (${supplierLabel}): ${result.error || 'Unknown error'}` })
                .catch(err => console.error('[Fulfillment] Admin alert (API failed) failed:', err))

            await (supabase.from('mtn_fulfillment_tracking') as any).insert({
                order_id: orderId,
                status: 'failed',
                api_response: { error: result.error, supplier: supplierLabel, network, ...result.apiResponse },
            })
        }
    } catch (error) {
        console.error(`[Fulfillment] Error processing order ${orderId}:`, error)
    }
}
