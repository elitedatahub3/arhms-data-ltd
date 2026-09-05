/**
 * Decides whether a utility bill order can be paid automatically, and pays it.
 *
 * Mirrors lib/airtime-fulfillment-dispatcher.ts. The difference is the shape of the
 * work, not the caution: airtime above GHS 100 is split into legs and a separate
 * table's UNIQUE (order_id, leg_index) is what makes a second invocation a no-op.
 * A utility payment is one request, so the same guarantee comes from a conditional
 * UPDATE that claims `dispatch_claimed_at` before anything is sent. Whoever loses
 * that race sends nothing.
 *
 * Everything else carries over unchanged, and for the same reason — the money
 * cannot be recalled:
 *
 *   • no retry loop anywhere in this path;
 *   • an outright rejection refunds the customer, because we know the bill was
 *     never paid;
 *   • anything ambiguous is left for an admin rather than guessed at.
 */
import { createServerClient } from '@/lib/supabase'
import { sendPushToAdmins } from '@/lib/web-push'
import { logInitiate } from '@/lib/hubtel-payment-log'
import { finalizeUtilityOrder } from '@/lib/utility-order-completion'
import {
    UTILITY_SERVICES,
    isUtilityService,
} from '@/lib/hubtel-utility-service'
import { payUtilityBill, UTILITY_PROVIDER } from '@/lib/utility-provider'

/**
 * Hubtel allows 36 characters. reference_code is `UTIL-GHD-<ts>-<hex>`, so taking
 * its tail keeps us comfortably inside that while staying unique per order.
 */
export function buildUtilityClientReference(referenceCode: string): string {
    return `UTLB-${String(referenceCode || '').slice(-28)}`
}

/**
 * Leaves the order failed, records why, refunds when we know the bill went unpaid,
 * and puts it in front of an admin. Never throws — a failed alert must not mask the
 * fulfilment failure itself.
 */
async function haltForAdmin(
    order: any,
    note: string,
    opts: { refund: boolean }
): Promise<void> {
    const label = isUtilityService(order.service) ? UTILITY_SERVICES[order.service].label : order.service
    console.error(`[UtilityDispatch] Order ${order.reference_code} halted: ${note}`)

    await finalizeUtilityOrder({
        orderId: order.id,
        status: 'failed',
        note,
        refund: opts.refund,
        existingOrder: order,
    }).catch(e => console.error('[UtilityDispatch] finalize failed:', e))

    await sendPushToAdmins({
        title: '⚠️ Utility bill auto-payment failed',
        body: `${label} GHS ${Number(order.bill_amount).toFixed(2)} → ${order.account_number}. ${note}`,
        url: '/admin/utilities',
    }).catch(() => {})
}

export interface UtilityDispatchResult {
    dispatched: boolean
    /** Why it was not dispatched — for the caller's logs, not the customer. */
    reason?: string
}

/**
 * Attempts automatic payment of one utility bill order.
 *
 * Never throws. Callers that fire it from `waitUntil` can ignore the result.
 */
export async function triggerUtilityFulfillment(orderId: string): Promise<UtilityDispatchResult> {
    const supabase = createServerClient() as any

    try {
        const { data: order, error } = await supabase
            .from('utility_orders')
            .select('*')
            .eq('id', orderId)
            .single()

        if (error || !order) {
            console.error('[UtilityDispatch] Order not found:', orderId, error?.message)
            return { dispatched: false, reason: 'order not found' }
        }

        // ── Eligibility ──────────────────────────────────────────────────────
        if (order.status !== 'pending') {
            console.log(`[UtilityDispatch] Order ${order.reference_code} is '${order.status}', not pending — skipping.`)
            return { dispatched: false, reason: `order is ${order.status}` }
        }

        if (!isUtilityService(order.service)) {
            console.log(`[UtilityDispatch] Unknown service '${order.service}' — leaving manual.`)
            return { dispatched: false, reason: `unsupported service ${order.service}` }
        }

        const def = UTILITY_SERVICES[order.service]

        // ── Admin toggles ────────────────────────────────────────────────────
        const serviceKey = `utility_auto_${order.service}`
        const { data: settingRows } = await supabase
            .from('admin_settings')
            .select('key, value')
            .in('key', ['utility_auto_fulfillment_enabled', serviceKey])

        const settings: Record<string, string> = {}
        for (const row of (settingRows || [])) settings[row.key] = row.value

        if (settings['utility_auto_fulfillment_enabled'] !== 'true') {
            console.log('[UtilityDispatch] Auto-payment is disabled — order left for an admin.')
            return { dispatched: false, reason: 'auto-fulfilment disabled' }
        }
        if (settings[serviceKey] !== 'true') {
            console.log(`[UtilityDispatch] Auto-payment is off for ${def.label} — order left for an admin.`)
            return { dispatched: false, reason: `auto-fulfilment off for ${order.service}` }
        }

        // ── Claim ────────────────────────────────────────────────────────────
        // The whole idempotency story. Nothing above this line has spent anything,
        // and nothing below runs twice for one order: a concurrent invocation
        // (double submit, webhook plus cron, a retried serverless function) finds
        // dispatch_claimed_at already set and gets no row back.
        const clientReference = order.client_reference || buildUtilityClientReference(order.reference_code)

        const { data: claimed } = await supabase
            .from('utility_orders')
            .update({
                dispatch_claimed_at: new Date().toISOString(),
                provider: UTILITY_PROVIDER,
                client_reference: clientReference,
                updated_at: new Date().toISOString(),
            })
            .eq('id', orderId)
            .eq('status', 'pending')
            .is('dispatch_claimed_at', null)
            .select()
            .maybeSingle()

        if (!claimed) {
            console.log(`[UtilityDispatch] Order ${order.reference_code} already claimed — not sending again.`)
            return { dispatched: false, reason: 'already claimed' }
        }

        console.log(
            `[UtilityDispatch] ${order.reference_code} | ${def.label} | GHS ${Number(order.bill_amount).toFixed(2)} → ` +
            `${order.account_number} (dest ${order.destination})`
        )

        // ── Pay ──────────────────────────────────────────────────────────────
        // Our reference_code goes as THEIR idempotency key, so a retry returns the
        // original order rather than paying the bill a second time.
        const result = await payUtilityBill({
            service: order.service,
            accountNumber: order.account_number,
            amount: Number(order.bill_amount),
            // Their /pay wants the customer's MSISDN for ECG and Ghana Water and
            // nothing for the TV billers. `destination` was Hubtel's field and
            // encoded that rule per service; here the phone is simply the phone.
            phone: def.requiresPhone ? order.customer_phone : null,
            reference: order.reference_code,
        })

        await supabase
            .from('utility_orders')
            .update({
                provider: UTILITY_PROVIDER,
                // THEIR reference (UTIL-<BILLER>-<hex>), not ours — it is what the
                // status endpoint and the webhook correlate on.
                external_transaction_id: result.supplierReference ?? null,
                transaction_id: result.orderId ?? null,
                // Commission is not known yet: they report it once the order settles,
                // and the cron or webhook writes it then.
                provider_response: (result.raw ?? null) as any,
                updated_at: new Date().toISOString(),
            })
            .eq('id', orderId)

        // Bill payments sit in /admin/hubtel-payments alongside collections and
        // airtime so an admin has one place to answer "what happened to this order?".
        // The table predates KingFlexy and is keyed on our own client reference, so
        // it keeps working across the provider change.
        await logInitiate({
            clientReference,
            status: result.success ? 'pending' : 'failed',
            amount: Number(order.bill_amount),
            payerMsisdn: order.customer_phone ?? null,
            customerName: order.account_name ?? null,
            transactionId: result.supplierReference ?? null,
            responseCode: null,
            message: result.error ?? null,
            userId: order.user_id ?? null,
            raw: result.raw,
        })

        if (!result.success) {
            // knownUnpaid is set by the client: true for a 4xx, which is a definite
            // refusal with nothing charged, and false for a timeout or a 5xx, where
            // the payment may have landed and refunding would give the money away
            // twice. That judgement lives with the code that saw the HTTP status.
            const knownUnpaid = result.knownUnpaid === true
            await haltForAdmin(
                { ...order, status: 'pending' },
                `KingFlexy rejected the ${def.label} payment: ${result.error || 'unknown error'}.` +
                (knownUnpaid ? '' : ' The request may or may not have reached the provider — confirm in the KingFlexy dashboard BEFORE refunding or re-sending.'),
                { refund: knownUnpaid }
            )
            return { dispatched: false, reason: result.error || 'provider rejected payment' }
        }

        // Their /pay always answers 'pending' and settles asynchronously, so this
        // never completes an order outright — the webhook or the reconciliation cron
        // closes it out. An idempotent replay lands here too, which is correct: the
        // original order is already in flight and will report through the same path.
        await finalizeUtilityOrder({
            orderId,
            status: 'processing',
            existingOrder: { ...order, status: 'pending' },
        })

        console.log(
            `[UtilityDispatch] ${order.reference_code} dispatched to KingFlexy as ` +
            `${result.supplierReference ?? '(no reference returned)'}` +
            (result.alreadyProcessed ? ' — idempotent replay of an existing order.' : ' — awaiting settlement.')
        )
        return { dispatched: true }
    } catch (err: any) {
        // A crash here must never surface to the customer: their money is already
        // handled and the order simply stays for an admin.
        console.error('[UtilityDispatch] Unexpected error for order', orderId, err)
        return { dispatched: false, reason: String(err?.message || err) }
    }
}
