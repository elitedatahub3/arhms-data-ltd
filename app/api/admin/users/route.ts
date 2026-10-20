import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { createRouteHandlerClient } from '@/lib/supabase-server'
import { cookies } from 'next/headers'
import { validateAdminAccess } from '@/lib/auth-utils'

export async function GET(request: NextRequest) {
    try {
        const authResult = await validateAdminAccess(false, request)
        if (authResult.error) {
            return NextResponse.json({ error: authResult.error }, { status: authResult.status })
        }
        const { supabase: supabaseUserClient } = authResult

        const { searchParams } = new URL(request.url)
        const rawLimit = parseInt(searchParams.get('limit') || '50')
        const limit = Math.min(Math.max(rawLimit, 1), 200)
        const offset = Math.max(parseInt(searchParams.get('offset') || '0'), 0)
        const rawSearch = searchParams.get('search')
        const search = rawSearch ? rawSearch.trim().slice(0, 100) : null
        const role = searchParams.get('role')

        // 'api' is not a role: it filters to accounts an admin has switched on as API
        // users (users.is_api_user), whatever their role.
        const VALID_ROLES = ['customer', 'agent', 'dealer', 'sub-admin', 'admin', 'api', 'all']
        if (role && !VALID_ROLES.includes(role)) {
            return NextResponse.json({ error: 'Invalid role filter' }, { status: 400 })
        }

        // Service role client to bypass RLS
        const supabase = createServerClient()

        // Every live key, keyed by user. Few enough rows to read whole; lets the card
        // flag someone who requested a key but is not yet an API user.
        const { data: keyRows } = await (supabase.from('api_keys') as any)
            .select('user_id, status')
            .in('status', ['active', 'pending'])
        const apiStatusByUser = new Map<string, string>()
        for (const k of ((keyRows as any[]) || [])) {
            // One active key outranks a pending one.
            if (apiStatusByUser.get(k.user_id) !== 'active') apiStatusByUser.set(k.user_id, k.status)
        }

        // Add timeout to prevent hanging queries
        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Database query timeout')), 10000)
        )

        let query = supabase
            .from('users')
            // '*' rather than a column list so is_api_user comes back when the
            // migration has run, without breaking this page when it has not.
            .select(`
                *,
                wallets (
                    balance
                )
            `, { count: 'exact' })

        if (role === 'api') {
            query = query.eq('is_api_user', true)
        } else if (role && role !== 'all') {
            query = query.eq('role', role)
        }

        if (search) {
            query = query.or(`email.ilike.%${search}%,first_name.ilike.%${search}%,last_name.ilike.%${search}%,phone_number.ilike.%${search}%`)
        }

        const fetchPromise = query
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1)

        const { data: users, count, error: fetchError } = await Promise.race([
            fetchPromise,
            timeoutPromise
        ]) as any

        if (fetchError) {
            console.error('[AdminUsersFetch] Database error:', fetchError)
            throw new Error(`Database query failed: ${fetchError.message}`)
        }

        return NextResponse.json({
            users: ((users as any[]) || []).map(u => ({ ...u, api_key_status: apiStatusByUser.get(u.id) ?? null })),
            totalCount: count || 0
        })
    } catch (error: any) {
        console.error('Admin Users Fetch Error:', error)
        return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 })
    }
}
