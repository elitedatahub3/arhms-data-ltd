import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { createRouteHandlerClient } from '@/lib/supabase-server'
import { cookies } from 'next/headers'
import { revalidateTag } from 'next/cache'
import { PUBLIC_CONFIG_CACHE_TAG } from '@/lib/cache-tags'

const AIRTIME_SETTING_KEYS = [
    'airtime_fee_mtn_customer',
    'airtime_fee_mtn_agent',
    'airtime_fee_telecel_customer',
    'airtime_fee_telecel_agent',
    'airtime_fee_at_customer',
    'airtime_fee_at_agent',
    // Developer API fee, every API caller. Blank = role fee (lib/api-pricing.ts).
    'airtime_fee_mtn_api',
    'airtime_fee_telecel_api',
    'airtime_fee_at_api',
    'airtime_min_amount',
    'airtime_max_amount',
    'airtime_enabled_mtn',
    'airtime_enabled_telecel',
    'airtime_enabled_at',
    'storefront_airtime_enabled',
    'storefront_mashup_enabled',
    // Hubtel Commission Services auto-fulfilment. The master switch plus one per
    // network, so a telco can be pulled without stopping the other two.
    'airtime_auto_fulfillment_enabled',
    'airtime_auto_mtn',
    'airtime_auto_telecel',
    'airtime_auto_at',
]

async function verifyAdmin(supabaseUserClient: any) {
    const { data: { user: authUser }, error: authError } = await supabaseUserClient.auth.getUser()
    if (authError || !authUser) return null
    const supabase = createServerClient()
    const { data: user } = await supabase.from('users').select('role').eq('id', authUser.id).single()
    const role = (user as any)?.role
    if (!['admin', 'sub-admin'].includes(role)) return null
    return { userId: authUser.id }
}

// GET — fetch all airtime settings
export async function GET(request: NextRequest) {
    try {
        const cookieStore = await cookies()
        const supabaseUserClient = await createRouteHandlerClient()
        const admin = await verifyAdmin(supabaseUserClient)
        if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

        const supabase = createServerClient()
        const { data, error } = await (supabase
            .from('admin_settings') as any)
            .select('key, value')
            .in('key', AIRTIME_SETTING_KEYS)

        if (error) return NextResponse.json({ error: error.message }, { status: 500 })

        const settings: Record<string, string> = {}
        for (const row of (data || [])) {
            settings[row.key] = row.value
        }

        return NextResponse.json({ settings })
    } catch (error) {
        console.error('[Admin Airtime Settings] GET error:', error)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}

// POST — save airtime settings
export async function POST(request: NextRequest) {
    try {
        const cookieStore = await cookies()
        const supabaseUserClient = await createRouteHandlerClient()
        const admin = await verifyAdmin(supabaseUserClient)
        if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

        const supabase = createServerClient()
        let body: any
        try { body = await request.json() } catch { return NextResponse.json({ error: 'Invalid body' }, { status: 400 }) }

        const updates = Object.entries(body)
            .filter(([key]) => AIRTIME_SETTING_KEYS.includes(key))
            .map(([key, value]) => ({ key, value: String(value) }))

        if (updates.length === 0) return NextResponse.json({ error: 'No valid settings provided' }, { status: 400 })

        const { error } = await (supabase
            .from('admin_settings') as any)
            .upsert(updates, { onConflict: 'key' })

        if (error) {
            console.error('[Admin Airtime Settings] Save error:', error)
            return NextResponse.json({ error: error.message }, { status: 500 })
        }

        revalidateTag(PUBLIC_CONFIG_CACHE_TAG)

        return NextResponse.json({ success: true })
    } catch (error) {
        console.error('[Admin Airtime Settings] POST error:', error)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
