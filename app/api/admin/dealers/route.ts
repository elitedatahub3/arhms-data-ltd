import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { createRouteHandlerClient } from '@/lib/supabase-server'
import { cookies } from 'next/headers'
import { restoreFromDealer } from '@/lib/dealer-role-history'

export async function GET(request: NextRequest) {
    try {
        const cookieStore = await cookies()
        const supabaseUserClient = await createRouteHandlerClient()
        const { data: { user: authUser }, error: authError } = await supabaseUserClient.auth.getUser()

        if (authError || !authUser) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const { data: userData } = await supabaseUserClient
            .from('users')
            .select('role')
            .eq('id', authUser.id)
            .single()

        if (userData?.role !== 'admin') {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
        }

        const supabase = createServerClient()

        const { data: dealers, error: fetchError } = await supabase
            .from('users')
            .select(`
                id,
                email,
                first_name,
                last_name,
                phone_number,
                role,
                status,
                dealer_claimed_at,
                dealer_expires_at,
                created_at,
                updated_at
            `)
            .eq('role', 'dealer')
            .order('dealer_expires_at', { ascending: true })

        if (fetchError) {
            console.error('[AdminDealers] Fetch error:', fetchError)
            return NextResponse.json({ error: 'Database error' }, { status: 500 })
        }

        return NextResponse.json(dealers || [])
    } catch (error: any) {
        console.error('[AdminDealers] Exception:', error)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}

export async function POST(request: NextRequest) {
    try {
        const cookieStore = await cookies()
        const supabaseUserClient = await createRouteHandlerClient()
        const { data: { user: authUser }, error: authError } = await supabaseUserClient.auth.getUser()

        if (authError || !authUser) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const { data: userData } = await supabaseUserClient
            .from('users')
            .select('role')
            .eq('id', authUser.id)
            .single()

        if (userData?.role !== 'admin') {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
        }

        const body = await request.json()
        const { userId, action, days } = body

        if (!userId || !action) {
            return NextResponse.json({ error: 'userId and action are required' }, { status: 400 })
        }

        const supabase = createServerClient()

        const { data: dealer } = await supabase
            .from('users')
            .select('role, dealer_expires_at')
            .eq('id', userId)
            .single()

        if (!dealer || (dealer as any).role !== 'dealer') {
            return NextResponse.json({ error: 'User is not a dealer' }, { status: 400 })
        }

        if (action === 'extend' || action === 'reduce') {
            const numDays = parseInt(days)
            if (isNaN(numDays) || numDays === 0) {
                return NextResponse.json({ error: 'Valid days value required' }, { status: 400 })
            }

            const currentExpiry = (dealer as any).dealer_expires_at
                ? new Date((dealer as any).dealer_expires_at)
                : new Date()

            const newExpiry = new Date(currentExpiry)
            newExpiry.setDate(newExpiry.getDate() + numDays)

            const { error: updateError } = await (supabase
                .from('users') as any)
                .update({
                    dealer_expires_at: newExpiry.toISOString(),
                    updated_at: new Date().toISOString(),
                })
                .eq('id', userId)

            if (updateError) {
                return NextResponse.json({ error: updateError.message }, { status: 500 })
            }

            return NextResponse.json({
                success: true,
                newExpiry: newExpiry.toISOString(),
                isExpired: newExpiry < new Date(),
            })
        }

        if (action === 'revoke') {
            // Back to what they were before the dealership (customer, or their agent plan)
            const result = await restoreFromDealer(supabase as any, userId, { requireExpired: false })

            if (!result.restored) {
                const message = result.reason === 'not_dealer' ? 'User is not a dealer' : (result.error || 'Failed to revoke dealer')
                return NextResponse.json({ error: message }, { status: result.reason === 'error' ? 500 : 400 })
            }

            return NextResponse.json({ success: true, newRole: result.newRole })
        }

        return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
    } catch (error: any) {
        console.error('[AdminDealers] POST Exception:', error)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
