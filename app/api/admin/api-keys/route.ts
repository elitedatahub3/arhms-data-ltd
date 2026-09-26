import { NextRequest, NextResponse } from 'next/server'
import { createRouteHandlerClient } from '@/lib/supabase-server'
import { cookies } from 'next/headers'
import { createServerClient } from '@/lib/supabase'
import { sendPushToAdmins } from '@/lib/web-push'

async function verifyAdmin(supabaseUser: any) {
    const { data: { user }, error } = await supabaseUser.auth.getUser()
    if (error || !user) return null
    const supabase = createServerClient()
    const { data } = await supabase.from('users').select('role').eq('id', user.id).single()
    if (!['admin', 'sub-admin'].includes((data as any)?.role)) return null
    return user.id
}

// GET — list all API keys with user info
export async function GET(request: NextRequest) {
    try {
        const cookieStore = await cookies()
        const supabaseUser = await createRouteHandlerClient()
        if (!await verifyAdmin(supabaseUser)) {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
        }

        const { searchParams } = new URL(request.url)
        const status = searchParams.get('status') // pending | active | revoked | all
        const kind = searchParams.get('kind')     // standard | commission | all
        const page = parseInt(searchParams.get('page') || '1')
        const limit = parseInt(searchParams.get('limit') || '30')
        const offset = (page - 1) * limit

        const supabase = createServerClient()
        let query = (supabase.from('api_keys') as any)
            .select(`
                id, key_prefix, name, status, kind, last_used_at, created_at,
                users!api_keys_user_id_fkey(id, first_name, last_name, email, role)
            `, { count: 'exact' })
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1)

        if (status && status !== 'all') query = query.eq('status', status)
        if (kind && kind !== 'all') query = query.eq('kind', kind)

        const { data: keys, error, count } = await query

        if (error) return NextResponse.json({ error: error.message }, { status: 500 })

        return NextResponse.json({
            success: true,
            keys: keys || [],
            total: count || 0,
            page,
            totalPages: Math.ceil((count || 0) / limit),
        })
    } catch (err: any) {
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}

// PATCH — approve or revoke a key
// Body: { keyId, action: 'approve' | 'revoke' }
export async function PATCH(request: NextRequest) {
    try {
        const cookieStore = await cookies()
        const supabaseUser = await createRouteHandlerClient()
        if (!await verifyAdmin(supabaseUser)) {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
        }

        const { keyId, action } = await request.json()
        if (!keyId || !['approve', 'revoke'].includes(action)) {
            return NextResponse.json({ error: 'keyId and action (approve|revoke) are required' }, { status: 400 })
        }

        const supabase = createServerClient()
        const newStatus = action === 'approve' ? 'active' : 'revoked'

        const { data: key, error } = await (supabase.from('api_keys') as any)
            .update({ status: newStatus, updated_at: new Date().toISOString() })
            .eq('id', keyId)
            .select('id, key_prefix, user_id, users!api_keys_user_id_fkey(first_name, email)')
            .single()

        if (error) return NextResponse.json({ error: error.message }, { status: 500 })

        // Notify the key owner in-app
        ;(supabase.from('notifications') as any).insert({
            user_id: key.user_id,
            title: action === 'approve' ? 'API Key Approved' : 'API Key Revoked',
            message: action === 'approve'
                ? 'Your Developer API key has been approved and is now active.'
                : 'Your Developer API key has been revoked. Contact support if this is an error.',
            type: 'system',
            action_url: '/dashboard/developer-api',
        }).then(() => {}).catch(() => {})

        return NextResponse.json({ success: true, status: newStatus })
    } catch (err: any) {
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
