/**
 * Decides whether an airtime order can be delivered automatically, and delivers it.
 *
 * Mirrors lib/order-fulfillment-dispatcher.ts (the data-bundle equivalent) but with
 * one difference that shapes everything here: airtime cannot be recalled. A data
 * bundle sent twice is an annoyance; airtime sent twice is money gone. So:
 *
 *   • the leg row is INSERTED BEFORE the provider is called, and the unique
 *     (order_id, leg_index) constraint is what makes a second invocation a no-op;
 *   • there is no retry loop anywhere in this path;
 *   • a failure leaves the order 'pending' for an admin rather than guessing.
 *
 * There is exactly one leg per order now. The leg table dates from when Hubtel capped
 * a single top-up at GHS 100 and forced a split; KingFlexy's Airtime v2 API documents
 * no such cap, so every order is one purchase call. The table itself is kept — not
 * because splitting is still needed, but because it's already the idempotency claim
 * (insert-before-call, UNIQUE (order_id, leg_index)) and /admin/airtime already
 * renders it, so reusing it costs nothing and touches no admin UI.
 */
import { createServerClient } from '@/lib/supabase'
import { sendPushToAdmins } from '@/lib/web-push'
import { finalizeAirtimeOrder } from '@/lib/airtime-order-completion'
import { purchaseAirtime, AIRTIME_PROVIDER } from '@/lib/airtime-provider'

const NETWORK_SETTING_KEY: Record<string, string> = {
    MTN: 'airtime_auto_mtn',
    Telecel: 'airtime_auto_telecel',
    AT: 'airtime_auto_at',
}

/**
 * Leaves the order pending, records why, and puts it in front of an admin.
 * Never throws — a failed alert must not mask the fulfilment failure itself.
 */
async function haltForAdmin(supabase: any, order: any, note: string): Promise<void> {
    console.error(`[AirtimeDispatch] Order ${order.reference_code} halted: ${note}`)

    try {
        await supabase
            .from('airtime_orders')
            .update({ fulfillment_note: note, updated_at: new Date().toISOString() })
            .eq('id', order.id)
    } catch (e) {
        console.error('[AirtimeDispatch] Could not write fulfillment_note:', e)
    }

    await sendPushToAdmins({
        title: '⚠️ Airtime auto-fulfil failed',
        body: `${order.network} GHS ${Number(order.airtime_amount).toFixed(2)} → ${order.beneficiary_phone}. ${note}`,
        url: '/admin/airtime',
    }).catch(() => {})
}

export interface AirtimeDispatchResult {
    /** True only when KingFlexy accepted the purchase. */
    dispatched: boolean
    /** Why it was not dispatched — for the caller's logs, not the customer. */
    reason?: string
}

/**
 * Attempts automatic delivery of one airtime order.
 *
 * Never throws. Callers that fire it from `waitUntil` can ignore the result; the
 * storefront reads `dispatched` to decide whether an admin still needs the
 * "fulfil this by hand" email.
 */
export async function triggerAirtimeFulfillment(orderId: string): Promise<AirtimeDispatchResult> {
    const supabase = createServerClient() as any

    try {
        const { data: order, error } = await supabase
            .from('airtime_orders')
            .select('*')
            .eq('id', orderId)
            .single()

        if (error || !order) {
            console.error('[AirtimeDispatch] Order not found:', orderId, error?.message)
            return { dispatched: false, reason: 'order not found' }
        }

        // ── Eligibility ──────────────────────────────────────────────────────
        if (order.status !== 'pending') {
            console.log(`[AirtimeDispatch] Order ${order.reference_code} is '${order.status}', not pending — skipping.`)
            return { dispatched: false, reason: `order is ${order.status}` }
        }

        // Mashup is an MTN data/voice bundle bought through the airtime form, not
        // airtime. KingFlexy's airtime API cannot deliver it, so it stays manual.
        if (order.type === 'mashup') {
            console.log(`[AirtimeDispatch] Order ${order.reference_code} is a mashup — manual fulfilment only.`)
            return { dispatched: false, reason: 'mashup is manual-only' }
        }

        if (!NETWORK_SETTING_KEY[order.network]) {
            console.log(`[AirtimeDispatch] Unsupported network '${order.network}' — leaving manual.`)
            return { dispatched: false, reason: `unsupported network ${order.network}` }
        }

        // ── Admin toggles ────────────────────────────────────────────────────
        const networkKey = NETWORK_SETTING_KEY[order.network]
        const { data: settingRows } = await supabase
            .from('admin_settings')
            .select('key, value')
            .in('key', ['airtime_auto_fulfillment_enabled', networkKey])

        const settings: Record<string, string> = {}
        for (const row of (settingRows || [])) settings[row.key] = row.value

        if (settings['airtime_auto_fulfillment_enabled'] !== 'true') {
            console.log('[AirtimeDispatch] Auto-fulfilment is disabled — order left for an admin.')
            return { dispatched: false, reason: 'auto-fulfilment disabled' }
        }
        if (settings[networkKey] !== 'true') {
            console.log(`[AirtimeDispatch] Auto-fulfilment is off for ${order.network} — order left for an admin.`)
            return { dispatched: false, reason: `auto-fulfilment off for ${order.network}` }
        }

        const amount = Number(order.airtime_amount)
        const clientReference = order.reference_code

        // Claim the leg first. If this insert fails on the unique constraint the
        // order has already been dispatched by another invocation, and sending it
        // again would double-credit the beneficiary.
        const { data: leg, error: claimError } = await supabase
            .from('airtime_fulfillment_legs')
            .insert({
                order_id: orderId,
                leg_index: 1,
                client_reference: clientReference,
                amount,
                status: 'submitting',
            })
            .select()
            .single()

        if (claimError || !leg) {
            // 23505 = unique violation.
            if (claimError?.code === '23505') {
                console.log(`[AirtimeDispatch] ${order.reference_code} already claimed — stopping.`)
                return { dispatched: false, reason: 'already claimed' }
            }
            await haltForAdmin(supabase, order, `Could not record dispatch claim: ${claimError?.message || 'unknown error'}.`)
            return { dispatched: false, reason: 'could not record claim' }
        }

        await supabase
            .from('airtime_orders')
            .update({
                provider: AIRTIME_PROVIDER,
                provider_reference: clientReference,
                auto_fulfillment_attempted_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
            })
            .eq('id', orderId)

        console.log(
            `[AirtimeDispatch] ${order.reference_code} | ${order.network} | GHS ${amount.toFixed(2)} → ${order.beneficiary_phone}`
        )

        const result = await purchaseAirtime({
            network: order.network,
            phone: order.beneficiary_phone,
            amount,
            reference: clientReference,
        })

        await supabase
            .from('airtime_fulfillment_legs')
            .update({
                status: result.success ? 'pending' : 'failed',
                transaction_id: result.supplierOrderId ?? null,
                message: result.error ?? result.status ?? null,
                raw: result.raw ?? null,
                updated_at: new Date().toISOString(),
            })
            .eq('id', leg.id)

        await supabase
            .from('airtime_orders')
            .update({
                provider_response: (result.raw ?? null) as any,
                updated_at: new Date().toISOString(),
            })
            .eq('id', orderId)

        if (!result.success) {
            const refundHint = result.knownUnpaid
                ? 'KingFlexy confirms nothing was charged to our balance — a manual wallet credit is safe.'
                : 'KingFlexy did not confirm whether this was charged — check their dashboard before refunding.'
            await haltForAdmin(
                supabase,
                order,
                `KingFlexy rejected the top-up: ${result.error || 'unknown error'}. ${refundHint}`
            )
            return { dispatched: false, reason: result.error || 'provider rejected purchase' }
        }

        // KingFlexy always dispatches asynchronously — "poll for final status" — so a
        // successful purchase call never means delivered yet. The reconciliation cron
        // (sync-kingflexy-airtime) is what ever moves this to 'completed'.
        await finalizeAirtimeOrder({
            orderId,
            status: 'processing',
            existingOrder: order,
        })

        console.log(`[AirtimeDispatch] ${order.reference_code} dispatched — awaiting KingFlexy confirmation.`)
        return { dispatched: true }
    } catch (err: any) {
        // A crash here must never surface to the customer: their money is already
        // handled and the order simply stays pending for an admin.
        console.error('[AirtimeDispatch] Unexpected error for order', orderId, err)
        return { dispatched: false, reason: String(err?.message || err) }
    }
}
