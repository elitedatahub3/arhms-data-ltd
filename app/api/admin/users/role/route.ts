import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { createRouteHandlerClient } from '@/lib/supabase-server'
import { cookies } from 'next/headers'
import { sendAgentUpgradeSuccessSMS, sendDealerUpgradeSuccessSMS } from '@/lib/sms-service'
import { snapshotBeforeDealer, CLEARED_PRE_DEALER } from '@/lib/dealer-role-history'

export async function POST(request: NextRequest) {
    try {
        const cookieStore = await cookies()
        const supabaseUserClient = await createRouteHandlerClient()
        const { data: { user: authUser }, error: authError } = await supabaseUserClient.auth.getUser()

        if (authError || !authUser) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        // Check if requester is admin
        const { data: userData } = await supabaseUserClient
            .from('users')
            .select('role')
            .eq('id', authUser.id)
            .single()

        if (userData?.role !== 'admin') {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
        }

        const body = await request.json()
        const { userId, role, dealerMonths } = body

        if (!userId || !role) {
            return NextResponse.json({ error: 'userId and role are required' }, { status: 400 })
        }

        // Dealer grants can run for 1, 3 or 6 months. Defaults to 1 month so
        // existing callers that omit the field keep their previous behaviour.
        const DEALER_PLAN_DAYS: Record<number, number> = { 1: 30, 3: 90, 6: 180 }
        const requestedMonths = dealerMonths === undefined ? 1 : Number(dealerMonths)

        if (role === 'dealer' && !DEALER_PLAN_DAYS[requestedMonths]) {
            return NextResponse.json({ error: 'dealerMonths must be 1, 3 or 6' }, { status: 400 })
        }

        // Service role client to bypass RLS
        const supabase = createServerClient()

        // -----------------------------------------------------------------
        // Fetch the user's CURRENT role BEFORE changing it so we can pass
        // the old role to the pricing adjustment RPC below.
        // -----------------------------------------------------------------
        const { data: currentUser } = await (supabase
            .from('users') as any)
            .select('role, dealer_claimed_at, dealer_expires_at, agent_expires_at')
            .eq('id', userId)
            .single()

        const oldRole: string = currentUser?.role ?? 'customer'

        // Calculate expiration based on new role
        // A role set directly by an admin is final: drop any "restore to" snapshot.
        // The dealer branch below replaces it with a fresh one.
        const updateData: any = { role, ...CLEARED_PRE_DEALER }
        if (role === 'agent') {
            const expiresAt = new Date()
            expiresAt.setDate(expiresAt.getDate() + 3) // 3-day agent subscription
            updateData.agent_expires_at = expiresAt.toISOString()
            // Clear dealer fields when promoting to agent
            updateData.dealer_expires_at = null
        } else if (role === 'dealer') {
            const now = new Date()
            const planDays = DEALER_PLAN_DAYS[requestedMonths]

            // Extend from the later of "now" and any unexpired dealer window,
            // matching how paid dealer subscriptions stack.
            const currentExpiry = currentUser?.dealer_expires_at ? new Date(currentUser.dealer_expires_at) : null
            const base = currentExpiry && currentExpiry > now ? currentExpiry : now
            const expiresAt = new Date(base.getTime() + planDays * 24 * 60 * 60 * 1000)

            // Preserve the original claim date so an admin grant doesn't retroactively
            // burn a user's free-trial eligibility record.
            updateData.dealer_claimed_at = currentUser?.dealer_claimed_at ?? now.toISOString()
            updateData.dealer_expires_at = expiresAt.toISOString()
            // Remember what they were so they go back to it when the dealership
            // ends. agent_expires_at is left alone; the paused agent time lives
            // in the snapshot. On a renewal (already dealer) the snapshot is kept.
            const snapshot = snapshotBeforeDealer(currentUser ?? {}, now)
            if (oldRole === 'dealer') {
                delete updateData.pre_dealer_role
                delete updateData.pre_dealer_agent_seconds_left
            } else {
                Object.assign(updateData, snapshot)
            }
        } else {
            updateData.agent_expires_at = null
        }

        const { error: updateError } = await (supabase
            .from('users') as any)
            .update(updateData)
            .eq('id', userId)

        if (updateError) {
            console.error('[AdminRoleUpdate] Update error:', updateError)
            throw updateError
        }

        // -----------------------------------------------------------------
        // Auto-adjust shop pricing to preserve the owner's profit margins.
        // This replaces the old "deactivate shop on role change" behaviour.
        // The shop stays live; only selling prices are silently recalculated.
        // Also resets per-shop fee overrides so the shop inherits the correct
        // global fee defaults for the new role.
        // -----------------------------------------------------------------
        if (oldRole !== role) {
            try {
                const { data: rpcResult, error: rpcError } = await (supabase as any)
                    .rpc('adjust_shop_pricing_for_role_change', {
                        p_user_id: userId,
                        p_old_role: oldRole,
                        p_new_role: role,
                    })

                if (rpcError) {
                    // Log but don't fail — pricing adjustment is non-blocking
                    console.error('[AdminRoleUpdate] Pricing RPC error:', rpcError)
                } else {
                    console.log('[AdminRoleUpdate] Pricing adjustment result:', rpcResult)
                }
            } catch (rpcErr) {
                console.error('[AdminRoleUpdate] Unexpected RPC error:', rpcErr)
            }

            // Reset shop fee overrides to null so the shop inherits global defaults
            // for the user's new role. Non-blocking — failure does not abort the role change.
            try {
                await (supabase
                    .from('shop_profiles') as any)
                    .update({
                        paystack_fee_percent:   null,
                        withdrawal_fee_percent: null,
                        withdrawal_fee_flat:    null,
                        min_withdrawal_amount:  null,
                        updated_at: new Date().toISOString(),
                    })
                    .eq('owner_id', userId)
                console.log('[AdminRoleUpdate] Shop fee overrides reset')
            } catch (resetErr) {
                console.error('[AdminRoleUpdate] Failed to reset shop fee overrides (non-fatal):', resetErr)
            }
        }

        // Send SMS notification if user was upgraded to dealer
        if (role === 'dealer') {
            try {
                const { data: userDetails } = await (supabase
                    .from('users') as any)
                    .select('phone_number, first_name, dealer_expires_at')
                    .eq('id', userId)
                    .single()

                if (userDetails?.phone_number) {
                    await sendDealerUpgradeSuccessSMS(
                        userDetails.phone_number,
                        userDetails.first_name || 'User',
                        userDetails.dealer_expires_at
                    )
                    console.log('[AdminRoleUpdate] Dealer SMS sent')
                } else {
                    console.warn(`[AdminRoleUpdate] No phone number for dealer user ${userId}`)
                }
            } catch (smsError) {
                console.error('[AdminRoleUpdate] Dealer SMS error:', smsError)
            }
        }

        // Send SMS notification if user was upgraded to agent
        if (role === 'agent') {
            try {
                const { data: userDetails } = await (supabase
                    .from('users') as any)
                    .select('phone_number, first_name')
                    .eq('id', userId)
                    .single()

                if (userDetails?.phone_number) {
                    const expiryDate = new Date()
                    expiryDate.setDate(expiryDate.getDate() + 3)

                    await sendAgentUpgradeSuccessSMS(
                        userDetails.phone_number,
                        userDetails.first_name || 'User',
                        '3 Days',
                        3,
                        expiryDate.toISOString()
                    )
                    console.log('[AdminRoleUpdate] SMS sent')
                } else {
                    console.warn(`[AdminRoleUpdate] No phone number for user ${userId}`)
                }
            } catch (smsError) {
                console.error('[AdminRoleUpdate] SMS error:', smsError)
                // Don't fail the request if SMS fails
            }
        }

        return NextResponse.json({
            success: true,
            userId,
            newRole: role,
            ...(role === 'dealer' && {
                dealerMonths: requestedMonths,
                dealerExpiresAt: updateData.dealer_expires_at,
            }),
        })
    } catch (error: any) {
        console.error('Admin Role Update Error:', error)
        return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 })
    }
}
