import { createServerClient } from '@/lib/supabase'
import { updateOrderWithColumnFallback } from '@/lib/order-update-fallback'
import { sendPushToUser, sendPushToAdmins } from '@/lib/web-push'
import {
    fulfillWithFallback, ordersStamp, optionalStampKeys, failureReason, describeAttempts,
} from '@/lib/supplier-router'

/**
 * Routes a paid order to the network's primary supplier — or its fallback, when
 * the primary definitely refuses (see lib/supplier-router.ts).
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

        const outcome = await fulfillWithFallback({
            db: supabase,
            network,
            phone: (order as any).phone_number,
            size: (order as any).size,
            orderId,
            match: { column: 'id', value: orderId },
            mode: 'live',
        })

        if (outcome.status === 'disabled') {
            await sendAdminNewOrderAlert({ ...alertDetails, reason: 'Global auto-fulfillment is disabled' })
                .catch(err => console.error('[Fulfillment] Admin alert (global disabled) failed:', err))
            return
        }

        if (outcome.status === 'conflict') {
            console.error(`[Fulfillment] CONFLICT DETECTED for ${network} on order ${orderId}`)
            await sendAdminNewOrderAlert({
                ...alertDetails,
                reason: `⚠️ SYSTEM HALTED: Multiple suppliers are active for ${network}. Order ${orderId} kept pending. Fix in admin panel immediately.`
            }).catch(err => console.error('[Fulfillment] Conflict alert failed:', err))
            return
        }

        if (outcome.status === 'no_supplier') {
            console.log(`[Fulfillment] No active supplier for network ${network}. Order ${orderId} kept pending.`)
            await sendAdminNewOrderAlert({ ...alertDetails, reason: `No active supplier configured for network: ${network}` })
                .catch(err => console.error('[Fulfillment] No-supplier alert failed:', err))
            return
        }

        const supplierLabel = outcome.supplier.id
        console.log(`[Fulfillment] Order ${orderId} | network: ${network} | ${describeAttempts(outcome.attempts)}`)

        if (outcome.status === 'placed') {
            const result = outcome.result
            // ── Build atomic orders update ─────────────────────────────────
            const ordersUpdate: Record<string, any> = {
                status: 'processing',
                updated_at: new Date().toISOString(),
                ...ordersStamp(outcome.supplier, outcome.reference),
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
                optionalStampKeys(ordersUpdate),
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
                    ...(outcome.fellBack ? { fallback: describeAttempts(outcome.attempts) } : {}),
                },
            })

            // Sync status to healing wrapper so shop owners see it
            await syncShopOrderStatus(orderId, 'processing').catch(err =>
                console.error(`[Fulfillment] syncShopOrderStatus failed for ${orderId}:`, err)
            )

            if ((order as any).user_id) {
                await sendPushToUser((order as any).user_id, {
                    title: 'Order Received',
                    body: `Your ${(order as any).network} ${(order as any).size} order is being processed.`,
                    url: '/dashboard/my-orders',
                    tag: `data-order-${(order as any).reference_code}`,
                }).catch(() => {})
            }

            // AirtelTigo via Agent Portal has no verification gate — it delivers quickly.
            // Reassure the recipient once that delivery is instant.
            //
            // Both go through sendPlatformOrderSms: a buyer who switched on "use my
            // sender ID" in the SMS Platform sends it under their own name, from
            // their credits; everyone else (and every storefront order) gets the
            // house message exactly as before.
            const { sendPlatformOrderSms } = await import('@/lib/sms/platform-order-sms')
            const recipientDisplay = String((order as any).phone_number || '').replace(/^233/, '0')
            const smsBase = {
                userId: (order as any).user_id,
                isShopOrder: !!(order as any).shop_order_id,
                recipient: (order as any).phone_number,
                reference: `data:${orderId}:received`,
            }
            if (supplierLabel === 'agentportal' && /^AT/i.test(network)) {
                const { sendAtInstantDeliverySMS } = await import('@/lib/sms-service')
                await sendPlatformOrderSms({
                    ...smsBase,
                    body: `Your ${(order as any).network} ${(order as any).size} data order for ${recipientDisplay} has been received and will be delivered instantly. Thank you.`,
                    houseSend: () => sendAtInstantDeliverySMS((order as any).phone_number, {
                        network: (order as any).network,
                        size: (order as any).size,
                    }),
                })
            } else {
                // EVERY other network — the order is with the supplier now, so confirm
                // receipt once without quoting a delivery time. The retry cron must
                // never re-send this.
                //
                // Was `else if (/MTN/i.test(network))`, which silently sent nothing for
                // Telecel (no branch at all) and nothing for AirtelTigo whenever
                // AgentPortal was not the active supplier — which is the case now that
                // Dakazina fulfils. Only MTN buyers ever got a message.
                //
                // sendMtnOrderReceivedSMS is network-agnostic despite the name: it
                // interpolates details.network and says only "received and is being
                // processed".
                const { sendMtnOrderReceivedSMS } = await import('@/lib/sms-service')
                await sendPlatformOrderSms({
                    ...smsBase,
                    body: `Your ${(order as any).network} ${(order as any).size} data order for ${recipientDisplay} has been received and is being processed. Thank you.`,
                    houseSend: () => sendMtnOrderReceivedSMS((order as any).phone_number, {
                        network: (order as any).network,
                        size: (order as any).size,
                    }),
                })
            }
        } else {
            // Failure — keep order as pending (do not update orders table status)
            const result = outcome.result
            const reason = failureReason(outcome)
            console.warn(`[Fulfillment] Order ${orderId} not placed: ${reason}`)

            // MTN whitelist gate (Agent Portal): the number is auto-submitted to MTN
            // for verification (up to 2 weeks) and the auto-refulfill cron delivers once it
            // clears. No SMS is sent to the recipient while the order is pending.

            await sendAdminNewOrderAlert({ ...alertDetails, reason: `Auto-fulfillment API error — ${reason}` })
                .catch(err => console.error('[Fulfillment] Admin alert (API failed) failed:', err))

            await sendPushToAdmins({
                title: 'Fulfillment failed',
                body: `Order ${(order as any).reference_code}: ${reason}`,
                url: '/admin/orders',
            }).catch(() => {})

            await (supabase.from('mtn_fulfillment_tracking') as any).insert({
                order_id: orderId,
                status: 'failed',
                api_response: { error: result.error, supplier: supplierLabel, network, attempts: outcome.attempts, ...result.apiResponse },
            })
        }
    } catch (error) {
        console.error(`[Fulfillment] Error processing order ${orderId}:`, error)
    }
}
