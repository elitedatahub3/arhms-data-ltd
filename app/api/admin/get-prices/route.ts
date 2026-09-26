import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { createRouteHandlerClient } from '@/lib/supabase-server'
import { cookies } from 'next/headers'

export async function GET(request: NextRequest) {
    try {
        // 1. AUTHENTICATE USER
        const cookieStore = await cookies()
        const supabaseUserClient = await createRouteHandlerClient()
        const { data: { user: authUser }, error: authError } = await supabaseUserClient.auth.getUser()

        if (authError || !authUser) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        // 2. FETCH UPGRADE PRICES
        // (Removed admin-only restriction - pricing is public information for self-service upgrades)
        // Create admin client with service role key to bypass RLS
        const supabaseAdmin = createClient(
            process.env.NEXT_PUBLIC_SUPABASE_URL!,
            process.env.SUPABASE_SERVICE_ROLE_KEY!,
            {
                auth: {
                    autoRefreshToken: false,
                    persistSession: false
                }
            }
        )

        // Fetch prices from admin_settings (including old prices and strikethrough toggle)
        const { data, error } = await supabaseAdmin
            .from('admin_settings')
            .select('key, value')
            .in('key', [
                'agent_upgrade_price_3d', 'agent_upgrade_price_14d', 'agent_upgrade_price_30d', 'agent_upgrade_price_permanent',
                'agent_upgrade_price_3d_old', 'agent_upgrade_price_14d_old', 'agent_upgrade_price_30d_old', 'agent_upgrade_price_permanent_old',
                'agent_plan_enabled_3d', 'agent_plan_enabled_14d', 'agent_plan_enabled_30d', 'agent_plan_enabled_permanent',
                'show_price_strikethrough', 'guest_storefront_url',
                'whatsapp_group_link', 'whatsapp_channel_link', 'whatsapp_admin_number', 'whatsapp_community_link',
                'dealer_subscription_price_6m',
                'dealer_subscription_price_3m'
            ])

        if (error) {
            console.error('Error fetching prices:', error)
            return NextResponse.json({ error: error.message }, { status: 500 })
        }

        const prices = {
            '3d': parseFloat(data?.find(s => s.key === 'agent_upgrade_price_3d')?.value || '9.99'),
            '14d': parseFloat(data?.find(s => s.key === 'agent_upgrade_price_14d')?.value || '49.99'),
            '30d': parseFloat(data?.find(s => s.key === 'agent_upgrade_price_30d')?.value || '99.99'),
            'permanent': parseFloat(data?.find(s => s.key === 'agent_upgrade_price_permanent')?.value || '149.99')
        }

        const oldPrices = {
            '3d': parseFloat(data?.find(s => s.key === 'agent_upgrade_price_3d_old')?.value || '0'),
            '14d': parseFloat(data?.find(s => s.key === 'agent_upgrade_price_14d_old')?.value || '0'),
            '30d': parseFloat(data?.find(s => s.key === 'agent_upgrade_price_30d_old')?.value || '0'),
            'permanent': parseFloat(data?.find(s => s.key === 'agent_upgrade_price_permanent_old')?.value || '0')
        }

        // A plan is on unless an admin has explicitly switched it off
        const enabledPlans = {
            '3d': data?.find(s => s.key === 'agent_plan_enabled_3d')?.value !== 'false',
            '14d': data?.find(s => s.key === 'agent_plan_enabled_14d')?.value !== 'false',
            '30d': data?.find(s => s.key === 'agent_plan_enabled_30d')?.value !== 'false',
            'permanent': data?.find(s => s.key === 'agent_plan_enabled_permanent')?.value !== 'false'
        }

        const showStrikethrough = data?.find(s => s.key === 'show_price_strikethrough')?.value === 'true'
        const guestStorefrontUrl = data?.find(s => s.key === 'guest_storefront_url')?.value || `${process.env.NEXT_PUBLIC_APP_URL || ''}/shop/demo`
        
        // Add WhatsApp links (No hardcoded fallbacks to prevent leaks and allow hiding)
        const whatsappGroupLink = data?.find(s => s.key === 'whatsapp_group_link')?.value || ''
        const whatsappChannelLink = data?.find(s => s.key === 'whatsapp_channel_link')?.value || ''
        const whatsappAdminNumber = data?.find(s => s.key === 'whatsapp_admin_number')?.value || ''
        const whatsappCommunityLink = data?.find(s => s.key === 'whatsapp_community_link')?.value || ''

        const dealerPrice6m = parseFloat(data?.find(s => s.key === 'dealer_subscription_price_6m')?.value || '0')
        const dealerPrice3m = parseFloat(data?.find(s => s.key === 'dealer_subscription_price_3m')?.value || '0')

        return NextResponse.json({
            prices,
            oldPrices,
            enabledPlans,
            showStrikethrough,
            guestStorefrontUrl,
            whatsappGroupLink,
            whatsappChannelLink,
            whatsappAdminNumber,
            whatsappCommunityLink,
            dealerPrice6m,
            dealerPrice3m,
        })

    } catch (error: any) {
        console.error('Error in get-prices API:', error)
        return NextResponse.json(
            { error: error.message || 'Internal server error' },
            { status: 500 }
        )
    }
}
