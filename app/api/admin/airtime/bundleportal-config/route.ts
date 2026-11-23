import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { createRouteHandlerClient } from '@/lib/supabase-server'
import { getBundlePortalAirtimeConfig } from '@/lib/bundleportal-service'

export const dynamic = 'force-dynamic'

/**
 * Read-only: BundlePortal's live airtime config (enabled, networks, min/max,
 * payRatio, balance) for the supplier switch on Admin → Airtime → Settings.
 */
export async function GET() {
    const supabaseUserClient = await createRouteHandlerClient()
    const { data: { user: authUser }, error: authError } = await supabaseUserClient.auth.getUser()
    if (authError || !authUser) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const supabase = createServerClient()
    const { data: user } = await supabase.from('users').select('role').eq('id', authUser.id).single()
    if (!['admin', 'sub-admin'].includes((user as any)?.role)) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const config = await getBundlePortalAirtimeConfig()
    return NextResponse.json(config)
}
