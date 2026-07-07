import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { createRouteHandlerClient } from '@/lib/supabase-server'
import { cookies } from 'next/headers'
import { revalidateTag } from 'next/cache'
import { PUBLIC_CONFIG_CACHE_TAG } from '@/lib/cache-tags'

export const dynamic = 'force-dynamic' // Force Next.js not to cache this API route

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
let supabase: ReturnType<typeof createClient> | null = null

function getAdminSettingsClient(): ReturnType<typeof createClient> {
    if (!supabase) {
        if (!supabaseServiceKey) {
            throw new Error('[AdminSettings] SUPABASE_SERVICE_ROLE_KEY is not configured')
        }
        supabase = createClient(supabaseUrl, supabaseServiceKey)
    }
    return supabase!
}

export async function GET(request: Request) {
    try {
        const cookieStore = await cookies()
        const supabaseAuth = await createRouteHandlerClient()
        const { data: { user }, error: authError } = await supabaseAuth.auth.getUser()

        if (authError || !user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        // Look up the role with the service-role client (keyed by the getUser()-verified
        // user.id) so the check never depends on an RLS-bound self-read that can return
        // null and cause a false 403. This route is exempt from the middleware admin gate.
        const { data: dbUser } = await getAdminSettingsClient().from('users').select('role').eq('id', user.id).single()
        const role = (dbUser as any)?.role

        const PUBLIC_SAFE_KEYS = [
            'paystack_fee_percent',
            'agent_paystack_fee_percent',
            'announcement_enabled',
            'announcement_title',
            'announcement_message',
            'auto_fulfillment_enabled',
            'afa_price_customer',
            'afa_price_agent',
            'afa_price_dealer',
            'guest_storefront_url',
            'whatsapp_group_link',
            'whatsapp_channel_link',
            'whatsapp_admin_number',
            'whatsapp_community_link',
            'support_email',
            'footer_copyright_text',
            'footer_branding_text',
            'dealer_promo_enabled',
            'skip_google_oauth_otp',
            'special_mtn_mashup_hidden',
            'express_mtn_hidden',
            'standard_mtn_hidden',
            'active_payment_provider_classifieds',
            'classifieds_boost_fee_7d',
            'classifieds_boost_fee_14d',
            'classifieds_boost_fee_21d',
            'classifieds_boost_fee_30d',
            'classifieds_boost_fee_60d',
            'classifieds_boost_fee_90d'
        ]

        const isAdmin = role === 'admin' || role === 'sub-admin'

        const { searchParams } = new URL(request.url)
        const keysParam = searchParams.get('keys')
        
        if (!isAdmin && keysParam) {
            const requestedKeys = keysParam.split(',').map(k => k.trim())
            const disallowed = requestedKeys.filter(k => !PUBLIC_SAFE_KEYS.includes(k))
            if (disallowed.length > 0) {
                return NextResponse.json({ error: 'Forbidden: key not permitted' }, { status: 403 })
            }
        }
        if (!isAdmin && !keysParam) {
            return NextResponse.json({ error: 'Forbidden: must specify allowed keys' }, { status: 403 })
        }

        // Build the query
        let query = getAdminSettingsClient().from('admin_settings').select('key, value')
        
        if (keysParam) {
            const keys = keysParam.split(',').map(k => k.trim())
            query = query.in('key', keys)
        }

        const { data, error } = await query

        if (error) {
            throw error
        }

        // Convert array of {key, value} to a flat object
        const settings = (data || []).reduce((acc: any, curr: any) => {
            acc[curr.key] = curr.value
            return acc
        }, {})

        // Return with headers that explicitly forbid caching
        return NextResponse.json(settings, {
            headers: {
                'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
                'Pragma': 'no-cache',
                'Expires': '0',
            }
        })
    } catch (error) {
        console.error('Error fetching admin settings:', error)
        return NextResponse.json(
            { error: 'Failed to fetch settings' },
            { status: 500 }
        )
    }
}

export async function POST(request: Request) {
    try {
        const cookieStore = await cookies()
        const supabaseAuth = await createRouteHandlerClient()
        const { data: { user }, error: authError } = await supabaseAuth.auth.getUser()

        if (authError || !user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        // Look up the role with the service-role client (keyed by the getUser()-verified
        // user.id) so the check never depends on an RLS-bound self-read that can return
        // null and cause a false 403. This route is exempt from the middleware admin gate.
        const { data: dbUser } = await getAdminSettingsClient().from('users').select('role').eq('id', user.id).single()
        if ((dbUser as any)?.role !== 'admin') {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
        }

        const body = await request.json()
        const updates = Array.isArray(body?.updates) ? body.updates : null
        if (!updates || updates.length === 0) {
            return NextResponse.json({ error: 'updates array is required' }, { status: 400 })
        }

        const cleanUpdates = updates
            .filter((item: any) => typeof item?.key === 'string')
            .map((item: any) => ({ key: item.key, value: String(item.value ?? '') }))

        if (cleanUpdates.length === 0) {
            return NextResponse.json({ error: 'No valid settings provided' }, { status: 400 })
        }

        const { error } = await getAdminSettingsClient()
            .from('admin_settings')
            .upsert(cleanUpdates, { onConflict: 'key' })

        if (error) throw error

        revalidateTag(PUBLIC_CONFIG_CACHE_TAG)

        return NextResponse.json({ success: true }, {
            headers: {
                'Cache-Control': 'private, no-store',
            },
        })
    } catch (error) {
        console.error('Error saving admin settings:', error)
        return NextResponse.json(
            { error: 'Failed to save settings' },
            { status: 500 }
        )
    }
}
