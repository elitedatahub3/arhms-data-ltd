/**
 * Remembers what a user was before they became a dealer, and puts them back
 * when the dealership ends.
 *
 * - A customer goes back to customer.
 * - An agent goes back to their agent plan. Remaining agent time is PAUSED while
 *   they are a dealer: we store the seconds left and resume from "now" on restore.
 *   A lifetime agent (agent_expires_at NULL) stays lifetime.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

export interface PreDealerSnapshot {
    pre_dealer_role: 'customer' | 'agent'
    /** Seconds of agent time left; NULL with role 'agent' means lifetime */
    pre_dealer_agent_seconds_left: number | null
}

/**
 * Fields to write when a user becomes a dealer. Returns {} for an existing
 * dealer, so a renewal never overwrites the original snapshot.
 */
export function snapshotBeforeDealer(
    user: { role?: string | null; agent_expires_at?: string | null },
    now: Date = new Date()
): PreDealerSnapshot | Record<string, never> {
    if (user.role === 'dealer') return {}
    if (user.role === 'agent') {
        if (!user.agent_expires_at) {
            return { pre_dealer_role: 'agent', pre_dealer_agent_seconds_left: null }
        }
        const secondsLeft = Math.floor((new Date(user.agent_expires_at).getTime() - now.getTime()) / 1000)
        if (secondsLeft > 0) {
            return { pre_dealer_role: 'agent', pre_dealer_agent_seconds_left: secondsLeft }
        }
    }
    return { pre_dealer_role: 'customer', pre_dealer_agent_seconds_left: null }
}

/** Clears the snapshot, for when an admin sets a role directly. */
export const CLEARED_PRE_DEALER = { pre_dealer_role: null, pre_dealer_agent_seconds_left: null } as const

export interface RestoreResult {
    restored: boolean
    /** Set when restored */
    newRole?: 'customer' | 'agent'
    agentExpiresAt?: string | null
    /** Set when not restored */
    reason?: 'not_found' | 'not_dealer' | 'still_active' | 'race' | 'error'
    error?: string
}

/**
 * Turn a dealer back into what they were. Must be called with a service-role client.
 * requireExpired: only act if dealer_expires_at has passed (false for admin revoke).
 */
export async function restoreFromDealer(
    supabase: SupabaseClient,
    userId: string,
    { requireExpired }: { requireExpired: boolean }
): Promise<RestoreResult> {
    const { data: user, error: fetchError } = await (supabase.from('users') as any)
        .select('id, role, dealer_expires_at, pre_dealer_role, pre_dealer_agent_seconds_left')
        .eq('id', userId)
        .single()

    if (fetchError || !user) return { restored: false, reason: 'not_found', error: fetchError?.message }
    if (user.role !== 'dealer') return { restored: false, reason: 'not_dealer' }

    const now = new Date()
    if (requireExpired && user.dealer_expires_at && new Date(user.dealer_expires_at) > now) {
        return { restored: false, reason: 'still_active' }
    }

    let newRole: 'customer' | 'agent' = 'customer'
    let agentExpiresAt: string | null = null
    if (user.pre_dealer_role === 'agent') {
        newRole = 'agent'
        const secondsLeft = user.pre_dealer_agent_seconds_left
        agentExpiresAt = secondsLeft == null
            ? null
            : new Date(now.getTime() + Number(secondsLeft) * 1000).toISOString()
    }

    // The role guard makes this a no-op if another trigger (cron, client, admin)
    // already restored the user.
    const { data: updated, error: updateError } = await (supabase.from('users') as any)
        .update({
            role: newRole,
            agent_expires_at: agentExpiresAt,
            dealer_expires_at: null,
            ...CLEARED_PRE_DEALER,
            updated_at: now.toISOString(),
        })
        .eq('id', userId)
        .eq('role', 'dealer')
        .select('id')

    if (updateError) return { restored: false, reason: 'error', error: updateError.message }
    if (!updated || updated.length === 0) return { restored: false, reason: 'race' }

    // Move shop prices off the dealer cost tier, keeping the owner's profit margins.
    try {
        const { error: rpcError } = await (supabase as any).rpc('adjust_shop_pricing_for_role_change', {
            p_user_id: userId,
            p_old_role: 'dealer',
            p_new_role: newRole,
        })
        if (rpcError) console.error('[DealerRestore] Pricing RPC error (non-fatal):', rpcError)
    } catch (rpcErr) {
        console.error('[DealerRestore] Unexpected RPC error (non-fatal):', rpcErr)
    }

    // A customer's shop inherits the customer global fee settings (same as /api/agent/downgrade).
    if (newRole === 'customer') {
        try {
            await (supabase.from('shop_profiles') as any)
                .update({
                    paystack_fee_percent: null,
                    withdrawal_fee_percent: null,
                    withdrawal_fee_flat: null,
                    min_withdrawal_amount: null,
                    updated_at: now.toISOString(),
                })
                .eq('owner_id', userId)
        } catch (resetErr) {
            console.error('[DealerRestore] Failed to reset shop fee overrides (non-fatal):', resetErr)
        }
    }

    console.log(`[DealerRestore] User ${userId} dealer → ${newRole}${newRole === 'agent' ? ` (expires ${agentExpiresAt ?? 'never'})` : ''}`)
    return { restored: true, newRole, agentExpiresAt }
}
