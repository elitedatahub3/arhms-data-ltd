/**
 * Pays a Commission Services partner their share of a completed bill payment.
 *
 * The share is a percentage of what the PROVIDER (KingFlexy) paid us on that order,
 * not of the bill.
 * That is what `commission_share_percent` means in the API response, and it has a
 * useful property the bill-percentage model did not: a share of the commission can
 * never exceed the commission, so there is no ceiling to configure and no way to pay
 * out more than was earned.
 *
 * This is the only place commission money is created, so it hangs off
 * finalizeUtilityOrder — already the single choke point for order state, reached by
 * the dispatcher, the Hubtel callback and an admin pressing a button in /admin.
 * All three earn identically without knowing this file exists.
 *
 * The hard part is paying exactly once, because those three can race: a callback can
 * land while the reconciliation cron is mid-sweep over the same order. So the ROW is
 * the mutex, not a flag read off a snapshot we were handed — see the claim below. It
 * is the same latch utility_orders.payment_status uses for refunds.
 */
import { createServerClient } from '@/lib/supabase'

type Supabase = ReturnType<typeof createServerClient>

function round2(n: number): number {
    return Math.round((n + Number.EPSILON) * 100) / 100
}

/**
 * The partner's cut, as a percentage. Admin-configurable, and returned to the caller
 * on POST /pay so they can show it before the order settles.
 */
export async function commissionSharePercent(supabase?: Supabase): Promise<number> {
    const db = (supabase || createServerClient()) as any
    try {
        const { data } = await db
            .from('admin_settings')
            .select('value')
            .eq('key', 'commission_share_percent')
            .maybeSingle()

        const pct = parseFloat((data as any)?.value ?? '')
        return Number.isFinite(pct) && pct >= 0 ? pct : 0
    } catch {
        return 0
    }
}

export interface CreditCommissionParams {
    orderId: string
    supabase?: Supabase
}

/**
 * Never throws and never returns a failure the caller must handle: an order that
 * settled correctly must not be reported as failed because a commission credit hit a
 * problem. Anything that goes wrong is logged and left for a retry — the latch is
 * unwound so the next attempt can claim it.
 */
export async function creditCommissionForOrder(params: CreditCommissionParams): Promise<void> {
    const { orderId } = params
    const supabase = (params.supabase || createServerClient()) as any

    try {
        if (!orderId) return

        // Re-read rather than accept a caller's snapshot. finalizeUtilityOrder is
        // routinely handed an `existingOrder` captured BEFORE the provider's
        // commission figure was written — the Hubtel callback updates the row and
        // then passes the pre-update copy. Reading the commission off that stale copy
        // would find null on every first callback and pay nothing.
        const { data: order } = await supabase
            .from('utility_orders')
            .select('*')
            .eq('id', orderId)
            .maybeSingle()

        if (!order?.id || !order?.user_id) return

        // Only orders placed through a COMMISSION key earn. A dashboard order, a
        // storefront order, or one placed with a standard data key pays nobody.
        if (!order.api_key_id) return
        if (order.commission_credited_at) return

        const { data: keyRow } = await supabase
            .from('api_keys')
            .select('kind')
            .eq('id', order.api_key_id)
            .maybeSingle()

        if (!keyRow || keyRow.kind !== 'commission') return

        const pct = await commissionSharePercent(supabase)
        if (pct <= 0) return

        // What Hubtel actually paid us. Absent means we do not yet know — the
        // callback may still be in flight — and paying a share of an unknown number
        // is guesswork. Returning WITHOUT claiming the latch is the important part:
        // it leaves the order creditable when the figure does arrive.
        const providerCommission = Number(order.commission)
        if (!Number.isFinite(providerCommission) || providerCommission <= 0) {
            console.warn(`[Commission] ${order.reference_code}: no provider commission recorded yet — not crediting.`)
            return
        }

        const share = round2(providerCommission * (pct / 100))
        if (share <= 0) return

        // ── Claim, then credit ────────────────────────────────────────────────
        const { data: claim } = await supabase
            .from('utility_orders')
            .update({ commission_credited_at: new Date().toISOString() })
            .eq('id', orderId)
            .is('commission_credited_at', null)
            .select('id')
            .maybeSingle()

        // No row back means another caller already paid this order.
        if (!claim) return

        const { error: creditError } = await supabase.rpc('credit_commission_wallet_balance', {
            p_user_id: order.user_id,
            p_amount: share,
        })

        if (creditError) {
            // No money moved, so the claim has to go back or the order reads as paid
            // while the partner is still owed.
            console.error('[Commission] CRITICAL: credit failed for', order.reference_code, creditError)
            await supabase
                .from('utility_orders')
                .update({ commission_credited_at: null })
                .eq('id', orderId)
                .then(() => {}, () => {})
            return
        }

        // ── Ledger row ────────────────────────────────────────────────────────
        // Worth having, but it must never take down a credit that succeeded.
        try {
            const { data: wallet } = await supabase
                .from('commission_wallets')
                .select('id')
                .eq('owner_id', order.user_id)
                .maybeSingle()

            if (wallet?.id) {
                await supabase.from('commission_transactions').insert({
                    wallet_id:   wallet.id,
                    user_id:     order.user_id,
                    source:      'utility',
                    order_id:    order.id,
                    amount:      share,
                    description: `Commission on ${order.service} bill GHS ${Number(order.bill_amount).toFixed(2)}`,
                    reference:   order.reference_code ?? null,
                })
            }
        } catch (e) {
            console.error('[Commission] Ledger row failed (non-fatal):', e)
        }
    } catch (e) {
        console.error('[Commission] Unexpected error:', e)
    }
}

/**
 * What a completed order actually paid the partner, for GET /utilities/orders.
 * Null until the order completes and the credit lands.
 */
export async function commissionEarnedFor(
    orderId: string,
    supabase?: Supabase
): Promise<number | null> {
    const db = (supabase || createServerClient()) as any
    try {
        const { data } = await db
            .from('commission_transactions')
            .select('amount')
            .eq('source', 'utility')
            .eq('order_id', orderId)
            .maybeSingle()

        return data ? Number((data as any).amount) : null
    } catch {
        return null
    }
}
