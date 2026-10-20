import { NextResponse } from 'next/server'
import { validateAdminAccess } from '@/lib/auth-utils'
import { createServerClient } from '@/lib/supabase'

/**
 * Switch an account on or off as an API user (users.is_api_user).
 *
 * API users are the only accounts whose standard API key works, and they pay the
 * admin-set API prices over the API and on the dashboard — see lib/api-pricing.ts.
 * Their role is untouched. Admin only, like role changes.
 *
 * Turning it off takes effect on the dashboard at once; an API key that was used in
 * the last minute may keep working until lib/api-auth.ts's 60s cache expires.
 */
export async function POST(request: Request) {
    const auth = await validateAdminAccess(false, request)
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status })

    let body: any
    try { body = await request.json() } catch {
        return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const { userId, enabled } = body ?? {}
    if (!userId || typeof userId !== 'string' || typeof enabled !== 'boolean') {
        return NextResponse.json({ error: 'userId and enabled (boolean) are required' }, { status: 400 })
    }

    const supabase = createServerClient()
    const { data, error } = await (supabase.from('users') as any)
        .update({ is_api_user: enabled, updated_at: new Date().toISOString() })
        .eq('id', userId)
        .select('id, is_api_user')
        .maybeSingle()

    if (error) {
        // The column arrives with migration 20261015010000_api_users.sql.
        const missing = /is_api_user/.test(error.message || '')
        return NextResponse.json(
            { error: missing ? 'Run migration 20261015010000_api_users.sql first.' : error.message },
            { status: 500 }
        )
    }
    if (!data) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    return NextResponse.json({ success: true, is_api_user: data.is_api_user })
}
