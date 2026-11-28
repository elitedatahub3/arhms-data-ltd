import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { createRouteHandlerClient } from '@/lib/supabase-server'
import { listDgBillers, datagodUtilityConfigProblem } from '@/lib/datagod-utility-service'

/**
 * Admin "Test Datagod" on /admin/utilities: reads Datagod's live biller list with the
 * configured Commission Services key. Moves no money. Returns the exact reason on
 * failure (missing key, test key, suspended or unapproved key) — admin-only, so the
 * detail is safe to show.
 */
export const dynamic = 'force-dynamic'

async function verifyAdmin() {
    const userClient = await createRouteHandlerClient()
    const { data: { user: authUser }, error } = await userClient.auth.getUser()
    if (error || !authUser) return null
    const supabase = createServerClient()
    const { data: user } = await supabase.from('users').select('role').eq('id', authUser.id).single()
    const role = (user as any)?.role
    return ['admin', 'sub-admin'].includes(role) ? authUser.id : null
}

export async function GET() {
    if (!(await verifyAdmin())) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const warning = datagodUtilityConfigProblem()
    const catalog = await listDgBillers()
    if (!catalog.success) {
        return NextResponse.json({ success: false, error: catalog.error, status: catalog.status ?? null, warning })
    }
    return NextResponse.json({ success: true, billers: catalog.billers, warning })
}
