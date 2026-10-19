import { NextRequest, NextResponse } from 'next/server'
import { createRouteHandlerClient } from '@/lib/supabase-server'
import { cookies } from 'next/headers'
import { createServerClient } from '@/lib/supabase'

export async function POST(request: NextRequest) {
    try {
        const cookieStore = await cookies()
        const supabaseUserClient = await createRouteHandlerClient()

        const { data: { user: authUser }, error: authError } = await supabaseUserClient.auth.getUser()

        if (authError || !authUser) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const supabase = createServerClient()

        const { data: dbUser, error: fetchError } = await supabase
            .from('users')
            .select('role, dealer_claimed_at, created_at')
            .eq('id', authUser.id)
            .single()

        if (fetchError || !dbUser) {
            return NextResponse.json({ error: 'User not found' }, { status: 404 })
        }

        if ((dbUser as any).role !== 'customer') {
            return NextResponse.json({ error: 'Only customers can claim the dealership role' }, { status: 400 })
        }

        if ((dbUser as any).dealer_claimed_at) {
            return NextResponse.json({ error: 'Dealership has already been claimed' }, { status: 400 })
        }

        // Free trial is only for users who registered on or after the feature launch date
        const DEALER_FEATURE_LAUNCH = new Date('2026-05-29T00:00:00Z')
        const userCreatedAt = new Date((dbUser as any).created_at)
        if (userCreatedAt < DEALER_FEATURE_LAUNCH) {
            return NextResponse.json({ error: 'Free dealer trial is only available to new users' }, { status: 403 })
        }

        // Check if the promo is currently active
        const { data: promoSetting } = await (supabase
            .from('admin_settings') as any)
            .select('value')
            .eq('key', 'dealer_promo_enabled')
            .single()
        if ((promoSetting as any)?.value !== 'true') {
            return NextResponse.json({ error: 'Dealer promo is currently inactive' }, { status: 403 })
        }

        const now = new Date()
        const expiresAt = new Date(now)
        expiresAt.setDate(expiresAt.getDate() + 30)

        const { error: updateError } = await (supabase
            .from('users') as any)
            .update({
                role: 'dealer',
                dealer_claimed_at: now.toISOString(),
                dealer_expires_at: expiresAt.toISOString(),
                // Only customers can claim, so the trial ends back at customer
                pre_dealer_role: 'customer',
                pre_dealer_agent_seconds_left: null,
                updated_at: now.toISOString(),
            })
            .eq('id', authUser.id)

        if (updateError) {
            console.error('[ClaimDealer] Update error:', updateError)
            return NextResponse.json({ error: 'Failed to claim dealership' }, { status: 500 })
        }

        // Adjust shop pricing to dealer cost tier (preserves profit margins)
        try {
            const { error: rpcError } = await (supabase as any)
                .rpc('adjust_shop_pricing_for_role_change', {
                    p_user_id: authUser.id,
                    p_old_role: 'customer',
                    p_new_role: 'dealer',
                })
            if (rpcError) {
                console.error('[ClaimDealer] Pricing RPC error (non-fatal):', rpcError)
            }
        } catch (rpcErr) {
            console.error('[ClaimDealer] Unexpected RPC error (non-fatal):', rpcErr)
        }

        return NextResponse.json({
            success: true,
            message: 'Dealership claimed! Enjoy your free 1-month trial.',
            dealer_expires_at: expiresAt.toISOString(),
        })
    } catch (error: any) {
        console.error('[ClaimDealer] Exception:', error)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
