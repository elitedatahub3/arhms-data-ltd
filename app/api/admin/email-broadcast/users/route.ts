import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { createRouteHandlerClient } from '@/lib/supabase-server'
import { fetchAllRows } from '@/lib/supabase-pagination'
import { cookies } from 'next/headers'

/**
 * GET endpoint to fetch all users with email addresses for Email broadcast
 * Admin only - bypasses RLS
 */
export async function GET(request: NextRequest) {
    try {
        const cookieStore = await cookies()
        const supabaseUserClient = await createRouteHandlerClient()
        const { data: { user: authUser }, error: authError } = await supabaseUserClient.auth.getUser()

        if (authError || !authUser) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        // Check if user is admin
        const { data: userData } = await supabaseUserClient
            .from('users')
            .select('role')
            .eq('id', authUser.id)
            .single()

        if (userData?.role !== 'admin') {
            return NextResponse.json({ error: 'Forbidden - Admin only' }, { status: 403 })
        }

        // Service role client to bypass RLS
        const supabase = createServerClient()

        // Fetch all users with email addresses. Paged, because an unbounded select stops at
        // PostgREST's 1000-row cap and the recipient count would silently under-report.
        const { data: users, error: fetchError } = await fetchAllRows<any>(() => supabase
            .from('users')
            .select('id, first_name, last_name, phone_number, role, email')
            .not('email', 'is', null)
            .order('first_name', { ascending: true })
            .order('id', { ascending: true }))

        if (fetchError) {
            console.error('[EmailBroadcast] Error fetching users:', fetchError)
            return NextResponse.json({ error: 'Failed to fetch users' }, { status: 500 })
        }

        return NextResponse.json({
            success: true,
            users: users || []
        })
    } catch (error: any) {
        console.error('[EmailBroadcast] Error:', error)
        return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 })
    }
}
