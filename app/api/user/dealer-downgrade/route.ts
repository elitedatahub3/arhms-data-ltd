import { NextRequest, NextResponse } from 'next/server'
import { createRouteHandlerClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { restoreFromDealer } from '@/lib/dealer-role-history'

// Called by the client (contexts/auth-context.tsx) once the dealer plan has
// expired. The user goes back to what they were before: a customer, or their
// agent plan with the agent time they had left.
export async function POST(request: NextRequest) {
    try {
        const supabaseUserClient = await createRouteHandlerClient()

        const { data: { user: authUser }, error: authError } = await supabaseUserClient.auth.getUser()

        if (authError || !authUser) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const result = await restoreFromDealer(createServerClient() as any, authUser.id, { requireExpired: true })

        if (!result.restored) {
            switch (result.reason) {
                case 'not_dealer':
                case 'race':
                    // Already restored (e.g. by the cron) — nothing left to do
                    return NextResponse.json({ error: 'User is not a dealer' }, { status: 400 })
                case 'still_active':
                    return NextResponse.json({ error: 'Dealer subscription is still active' }, { status: 400 })
                default:
                    console.error('[DealerDowngrade] Restore failed:', result)
                    return NextResponse.json({ error: 'Failed to downgrade' }, { status: 500 })
            }
        }

        return NextResponse.json({ success: true, newRole: result.newRole, agentExpiresAt: result.agentExpiresAt })
    } catch (error: any) {
        console.error('[DealerDowngrade] Exception:', error)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
