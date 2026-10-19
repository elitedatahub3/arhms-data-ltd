import { NextResponse } from 'next/server'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { areCronJobsEnabled, cronDisabledResponse } from '@/lib/cron-control'
import { restoreFromDealer } from '@/lib/dealer-role-history'

// Path kept for any existing cron-job.org entry. It no longer promotes expired
// dealers to 30-day agents: every dealer whose plan has ended goes back to what
// they were before (customer, or their agent plan with the time they had left).
// The client does the same on login; this sweep catches dealers who don't log in.

let supabaseAdmin: SupabaseClient | null = null

function getSupabaseAdmin(): SupabaseClient {
    if (!supabaseAdmin) {
        supabaseAdmin = createClient(
            process.env.NEXT_PUBLIC_SUPABASE_URL!,
            process.env.SUPABASE_SERVICE_ROLE_KEY!,
            {
                auth: {
                    autoRefreshToken: false,
                    persistSession: false
                }
            }
        )
    }
    return supabaseAdmin!
}

export async function GET(request: Request) {
    try {
        if (!areCronJobsEnabled()) return cronDisabledResponse()

        const authHeader = request.headers.get('authorization')
        if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const supabase = getSupabaseAdmin()

        const { data: expiredDealers, error: fetchError } = await supabase
            .from('users')
            .select('id')
            .eq('role', 'dealer')
            .lt('dealer_expires_at', new Date().toISOString())
            .limit(200)

        if (fetchError) {
            console.error('[RestoreExpiredDealers] Fetch error:', fetchError)
            return NextResponse.json({ error: 'Database error' }, { status: 500 })
        }

        if (!expiredDealers || expiredDealers.length === 0) {
            return NextResponse.json({ message: 'No expired dealers to restore', processed: 0 })
        }

        const results = []
        for (const dealer of expiredDealers) {
            const result = await restoreFromDealer(supabase, dealer.id, { requireExpired: true })
            results.push(
                result.restored
                    ? { id: dealer.id, status: 'restored', newRole: result.newRole }
                    : { id: dealer.id, status: result.reason, error: result.error }
            )
        }

        return NextResponse.json({
            message: 'Expired dealers restored to their previous role',
            processed: results.length,
            details: results
        })

    } catch (error: any) {
        console.error('[RestoreExpiredDealers] Exception:', error)
        return NextResponse.json({ error: 'Internal server error', details: error.message }, { status: 500 })
    }
}
