/**
 * Pays the reseller chain its margin on a completed bill.
 *
 * Runs off the snapshot taken at checkout (`utility_orders.reseller_split`), never a
 * fresh calculation. A bill settles minutes or hours after it was paid for, and by
 * then a Lead may have changed their margin or a sub may have left the chain —
 * recomputing would quietly pay today's configuration for yesterday's sale, to
 * people who may no longer be entitled to it. The customer was charged a specific
 * split; that exact split is what gets paid out.
 *
 * Only on 'completed'. A refunded or failed bill delivered nothing, so nobody earns
 * — and because the customer's money is returned in full, paying a shop would be
 * paying it out of ours.
 */
import { createServerClient } from '@/lib/supabase'

type Supabase = ReturnType<typeof createServerClient>

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

interface SplitLeg {
    shop_id: string
    owner_id: string
    percent: number
    amount: number
}

export interface CreditResellersParams {
    orderId: string
    supabase?: Supabase
}

/**
 * Never throws. A bill that reached the customer must not be reported as failed
 * because a wallet credit had a problem — the failure is logged and the latch is
 * released so the next sweep can retry.
 */
export async function creditResellersForOrder(params: CreditResellersParams): Promise<void> {
    const { orderId } = params
    const supabase = (params.supabase || createServerClient()) as any

    try {
        if (!orderId) return

        // Re-read rather than trust a caller's snapshot: finalizeUtilityOrder is
        // routinely handed an `existingOrder` captured before the terminal update.
        const { data: order } = await supabase
            .from('utility_orders')
            .select('id, reference_code, service, status, shop_id, reseller_split, reseller_fee_amount, reseller_credited_at')
            .eq('id', orderId)
            .maybeSingle()

        if (!order?.id) return
        if (order.status !== 'completed') return
        if (!order.shop_id) return                 // dashboard sale — no reseller
        if (order.reseller_credited_at) return

        const legs: SplitLeg[] = Array.isArray(order.reseller_split) ? order.reseller_split : []
        const payable = legs.filter(l => l?.owner_id && Number(l.amount) > 0)
        if (payable.length === 0) return

        // ── Claim before paying ──────────────────────────────────────────────
        // The row is the mutex. finalizeUtilityOrder is reachable from the
        // dispatcher, the KingFlexy webhook and the reconciliation cron, and two of
        // them can arrive at once — without this a shop is paid twice.
        const { data: claim } = await supabase
            .from('utility_orders')
            .update({ reseller_credited_at: new Date().toISOString() })
            .eq('id', orderId)
            .is('reseller_credited_at', null)
            .select('id')
            .maybeSingle()

        if (!claim) return

        let creditedAny = false

        for (const leg of payable) {
            const amount = round2(Number(leg.amount))
            if (amount <= 0) continue

            const { error } = await supabase.rpc('credit_shop_wallet_balance', {
                p_user_id: leg.owner_id,
                p_amount: amount,
            })

            if (error) {
                // One leg failing must not cost the others theirs. Logged loudly
                // because it means a real person is owed money the ledger will not
                // show.
                console.error(
                    `[UtilityResellerCredit] CRITICAL: could not pay shop ${leg.shop_id} ` +
                    `GHS ${amount.toFixed(2)} on ${order.reference_code}:`, error
                )
                continue
            }

            creditedAny = true

            // Ledger row. Worth having, but it must never undo a credit that landed
            // — shop_wallet_transactions.type is behind a CHECK allowing only
            // 'profit' and 'withdrawal', so this uses 'profit' like a data sale.
            try {
                const { data: wallet } = await supabase
                    .from('shop_wallets')
                    .select('id')
                    .eq('owner_id', leg.owner_id)
                    .maybeSingle()

                if (wallet?.id) {
                    await supabase.from('shop_wallet_transactions').insert({
                        shop_wallet_id: wallet.id,
                        type: 'profit',
                        amount,
                        description: `Bill payment: ${order.service} ${order.reference_code}`,
                        status: 'completed',
                    })
                }
            } catch (e) {
                console.error('[UtilityResellerCredit] Ledger row failed (non-fatal):', e)
            }
        }

        if (!creditedAny) {
            // Nothing moved, so release the latch rather than leaving the order
            // marked paid-out when nobody was paid.
            await supabase
                .from('utility_orders')
                .update({ reseller_credited_at: null })
                .eq('id', orderId)
                .then(() => {}, () => {})
        }
    } catch (e) {
        console.error('[UtilityResellerCredit] Unexpected error:', e)
    }
}
