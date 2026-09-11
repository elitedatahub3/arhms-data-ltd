import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { createRouteHandlerClient } from '@/lib/supabase-server'
import { fetchAllRows } from '@/lib/supabase-pagination'

/**
 * GET endpoint to fetch all users with phone numbers for SMS broadcast
 * Admin only - bypasses RLS
 */
export async function GET(request: NextRequest) {
    try {
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

        if (!userData || (userData as any).role !== 'admin') {
            return NextResponse.json({ error: 'Forbidden - Admin only' }, { status: 403 })
        }

        // Service role client to bypass RLS
        const supabase = createServerClient()

        // Fetch all users with phone numbers. Paged, because an unbounded select stops at
        // PostgREST's 1000-row cap and the recipient count would silently under-report.
        const { data: users, error: fetchError } = await fetchAllRows<any>(() => supabase
            .from('users')
            .select('id, first_name, last_name, phone_number, role, email')
            .not('phone_number', 'is', null)
            .order('first_name', { ascending: true })
            .order('id', { ascending: true }))

        if (fetchError) {
            console.error('[SMSBroadcast] Error fetching users:', fetchError)
            return NextResponse.json({ error: 'Failed to fetch users' }, { status: 500 })
        }

        // Fetch all shops to get shop owners
        const { data: shops, error: shopsError } = await fetchAllRows<any>(() => supabase
            .from('shop_profiles')
            .select('id, shop_name, owner_phone, owner_email')
            .not('owner_phone', 'is', null)
            .order('id', { ascending: true }))

        let combinedUsers = users || []

        if (shops && !shopsError) {
            // Most shop owners are also users. Drop those duplicates here so the count the
            // admin sees matches the number of phones the broadcast actually reaches.
            const normalisePhone = (phone: string) => (phone || '').replace(/\s+/g, '')
            const userPhones = new Set(combinedUsers.map((u: any) => normalisePhone(u.phone_number)))

            const shopOwners = (shops as any[])
                .filter(shop => !userPhones.has(normalisePhone(shop.owner_phone)))
                .map(shop => ({
                    id: `shop_${shop.id}`,
                    first_name: 'Shop Owner:',
                    last_name: shop.shop_name,
                    phone_number: shop.owner_phone,
                    role: 'shop_owner',
                    email: shop.owner_email || ''
                }))

            combinedUsers = [...combinedUsers, ...shopOwners]
        }

        return NextResponse.json({
            success: true,
            users: combinedUsers
        })
    } catch (error: any) {
        console.error('[SMSBroadcast] Error:', error)
        return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 })
    }
}
