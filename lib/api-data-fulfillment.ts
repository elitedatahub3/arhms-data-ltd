/**
 * Auto-fulfilment for a data order placed over the developer API.
 *
 * Lifted verbatim out of app/api/v1/data/purchase/route.ts when v2 arrived, because
 * the alternative was two copies of the supplier matrix — and the moment a seventh
 * supplier is added, one of them is wrong. Same reasoning as
 * lib/airtime-order-completion.ts: one implementation, several callers. The matrix
 * itself now lives in lib/supplier-router.ts, shared with every other order path,
 * along with the fallback supplier switch.
 *
 * MUST be awaited by the route, not fired and forgotten. Vercel kills async work the
 * instant the HTTP response is sent, so a backgrounded dispatch here silently leaves
 * every API order sitting at 'pending'.
 */
import type { createServerClient } from '@/lib/supabase'
import { updateOrderWithColumnFallback } from '@/lib/order-update-fallback'
import { fulfillWithFallback, ordersStamp, optionalStampKeys, failureReason } from '@/lib/supplier-router'

type Supabase = ReturnType<typeof createServerClient>

export interface FulfillApiDataOrderParams {
    supabase: Supabase
    orderId: string
    network: string
    recipient: string
    size: string
    /** Tag for the console line, e.g. 'v2/purchase'. */
    logPrefix: string
}

/**
 * @returns 'processing' when a supplier accepted the order, 'pending' otherwise.
 *          Never throws — a fulfilment problem leaves the order in the admin queue,
 *          it does not fail a request the customer has already paid for.
 */
export async function fulfillApiDataOrder(
    params: FulfillApiDataOrderParams
): Promise<'pending' | 'processing'> {
    const { supabase, orderId, network, recipient, size, logPrefix } = params

    try {
        // Disabled, no supplier, or two primaries for one network all leave the order
        // pending for an admin. Picking one of two arbitrarily would send the bundle
        // twice the moment the admin notices and disables the wrong one.
        const outcome = await fulfillWithFallback({
            db: supabase,
            network,
            phone: recipient,
            size,
            orderId,
            match: { column: 'id', value: orderId },
            mode: 'live',
        })

        if (outcome.status === 'failed') {
            console.error(`[${logPrefix}] Fulfillment failed for ${orderId}: ${failureReason(outcome)}`)
            return 'pending'
        }
        if (outcome.status !== 'placed') return 'pending'

        const orderUpdate: Record<string, any> = {
            status: 'processing',
            updated_at: new Date().toISOString(),
            ...ordersStamp(outcome.supplier, outcome.reference),
        }
        // The supplier has been paid: shed the reference/method columns rather than
        // lose the status transition to a DB that is behind the code.
        await updateOrderWithColumnFallback(
            supabase, 'orders', { column: 'id', value: orderId },
            orderUpdate, optionalStampKeys(orderUpdate), `[${logPrefix}]`
        )
        return 'processing'
    } catch (e) {
        console.error(`[${logPrefix}] Fulfillment error:`, e)
        return 'pending'
    }
}
