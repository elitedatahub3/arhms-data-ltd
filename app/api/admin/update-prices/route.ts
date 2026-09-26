import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { createRouteHandlerClient } from '@/lib/supabase-server'
import { cookies } from 'next/headers'
import { revalidateTag } from 'next/cache'
import { PUBLIC_CONFIG_CACHE_TAG } from '@/lib/cache-tags'
import { z } from 'zod'

export async function POST(request: NextRequest) {
    try {
        // 1. AUTHENTICATE USER
        const cookieStore = await cookies()
        const supabaseUserClient = await createRouteHandlerClient()
        const { data: { user: authUser }, error: authError } = await supabaseUserClient.auth.getUser()

        if (authError || !authUser) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        // 2. VERIFY ADMIN ROLE
        const { data: userData } = await supabaseUserClient
            .from('users')
            .select('role')
            .eq('id', authUser.id)
            .single()

        if (userData?.role !== 'admin') {
            return NextResponse.json({ error: 'Forbidden - Admin access required' }, { status: 403 })
        }

        // 3. CONTINUE WITH PRICE UPDATE LOGIC
        const body = await request.json()
        const { prices, showStrikethrough, dealerPrice6m, dealerPrice3m, planEnabled } = body

        // Handle a single agent plan being switched on or off: { planEnabled: { plan: '3d', enabled: false } }
        if (planEnabled !== undefined) {
            const planToggleSchema = z.object({
                plan: z.enum(['3d', '14d', '30d', 'permanent']),
                enabled: z.boolean(),
            })
            const toggleResult = planToggleSchema.safeParse(planEnabled)
            if (!toggleResult.success) {
                return NextResponse.json({ error: 'Invalid plan toggle' }, { status: 400 })
            }

            const supabaseAdmin = createClient(
                process.env.NEXT_PUBLIC_SUPABASE_URL!,
                process.env.SUPABASE_SERVICE_ROLE_KEY!,
                { auth: { autoRefreshToken: false, persistSession: false } }
            )

            const key = `agent_plan_enabled_${toggleResult.data.plan}`
            await supabaseAdmin.from('admin_settings').delete().eq('key', key)
            const { error } = await supabaseAdmin.from('admin_settings').insert({ key, value: String(toggleResult.data.enabled) } as any)
            if (error) return NextResponse.json({ error: error.message }, { status: 500 })

            revalidateTag(PUBLIC_CONFIG_CACHE_TAG)
            return NextResponse.json({ success: true, plan: toggleResult.data.plan, enabled: toggleResult.data.enabled })
        }

        if (!prices && dealerPrice6m === undefined && dealerPrice3m === undefined) {
            return NextResponse.json({ error: 'Prices are required' }, { status: 400 })
        }

        // Handle dealer-only price update (no agent prices in body)
        if ((dealerPrice6m !== undefined || dealerPrice3m !== undefined) && !prices) {
            const supabaseAdmin = createClient(
                process.env.NEXT_PUBLIC_SUPABASE_URL!,
                process.env.SUPABASE_SERVICE_ROLE_KEY!,
                { auth: { autoRefreshToken: false, persistSession: false } }
            )

            if (dealerPrice6m !== undefined) {
                const dealerPriceNum = z.coerce.number().min(1).max(100000).safeParse(dealerPrice6m)
                if (!dealerPriceNum.success) {
                    return NextResponse.json({ error: 'Invalid dealer 6-month price value' }, { status: 400 })
                }
                await supabaseAdmin.from('admin_settings').delete().eq('key', 'dealer_subscription_price_6m')
                const { error } = await supabaseAdmin.from('admin_settings').insert({ key: 'dealer_subscription_price_6m', value: String(dealerPriceNum.data) } as any)
                if (error) return NextResponse.json({ error: error.message }, { status: 500 })
            }

            if (dealerPrice3m !== undefined) {
                const dealer3mNum = z.coerce.number().min(1).max(100000).safeParse(dealerPrice3m)
                if (!dealer3mNum.success) {
                    return NextResponse.json({ error: 'Invalid dealer 3-month price value' }, { status: 400 })
                }
                await supabaseAdmin.from('admin_settings').delete().eq('key', 'dealer_subscription_price_3m')
                const { error } = await supabaseAdmin.from('admin_settings').insert({ key: 'dealer_subscription_price_3m', value: String(dealer3mNum.data) } as any)
                if (error) return NextResponse.json({ error: error.message }, { status: 500 })
            }

            revalidateTag(PUBLIC_CONFIG_CACHE_TAG)
            return NextResponse.json({ success: true, message: 'Dealer subscription prices updated' })
        }

        // === SECURITY: Validate all price values before writing to DB ===
        const pricesSchema = z.object({
            '3d':        z.coerce.number({ invalid_type_error: 'Price for 3d must be a number' }).min(1, 'Price must be at least 1').max(10000, 'Price cannot exceed 10000'),
            '14d':       z.coerce.number({ invalid_type_error: 'Price for 14d must be a number' }).min(1, 'Price must be at least 1').max(10000, 'Price cannot exceed 10000'),
            '30d':       z.coerce.number({ invalid_type_error: 'Price for 30d must be a number' }).min(1, 'Price must be at least 1').max(10000, 'Price cannot exceed 10000'),
            'permanent': z.coerce.number({ invalid_type_error: 'Price for permanent must be a number' }).min(1, 'Price must be at least 1').max(10000, 'Price cannot exceed 10000'),
        })

        const pricesResult = pricesSchema.safeParse(prices)
        if (!pricesResult.success) {
            const details = pricesResult.error.errors.map((e: any) => `${e.path.join('.')}: ${e.message}`)
            return NextResponse.json({ error: 'Invalid price values', details }, { status: 400 })
        }
        if (showStrikethrough !== undefined && typeof showStrikethrough !== 'boolean') {
            return NextResponse.json({ error: 'showStrikethrough must be a boolean' }, { status: 400 })
        }

        const validatedPrices = pricesResult.data

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

        // First, fetch current prices to move them to old prices
        const { data: currentData } = await supabaseAdmin
            .from('admin_settings')
            .select('key, value')
            .in('key', ['agent_upgrade_price_3d', 'agent_upgrade_price_14d', 'agent_upgrade_price_30d', 'agent_upgrade_price_permanent'])

        // Store current prices as old prices (only if they exist and are different)
        const oldPriceUpdates = []
        if (currentData) {
            const current3d = currentData.find(s => s.key === 'agent_upgrade_price_3d')?.value
            const current14d = currentData.find(s => s.key === 'agent_upgrade_price_14d')?.value
            const current30d = currentData.find(s => s.key === 'agent_upgrade_price_30d')?.value
            const currentPermanent = currentData.find(s => s.key === 'agent_upgrade_price_permanent')?.value

            if (current3d && current3d !== String(validatedPrices['3d'])) {
                oldPriceUpdates.push({ key: 'agent_upgrade_price_3d_old', value: current3d })
            }
            if (current14d && current14d !== String(validatedPrices['14d'])) {
                oldPriceUpdates.push({ key: 'agent_upgrade_price_14d_old', value: current14d })
            }
            if (current30d && current30d !== String(validatedPrices['30d'])) {
                oldPriceUpdates.push({ key: 'agent_upgrade_price_30d_old', value: current30d })
            }
            if (currentPermanent && currentPermanent !== String(validatedPrices['permanent'])) {
                oldPriceUpdates.push({ key: 'agent_upgrade_price_permanent_old', value: currentPermanent })
            }
        }

        // Update old prices
        for (const { key, value } of oldPriceUpdates) {
            await supabaseAdmin.from('admin_settings').delete().eq('key', key)
            await supabaseAdmin.from('admin_settings').insert({ key, value } as any)
        }

        // Update new prices — use validatedPrices (Zod-parsed), not raw input
        const updates = [
            { key: 'agent_upgrade_price_3d', value: String(validatedPrices['3d']) },
            { key: 'agent_upgrade_price_14d', value: String(validatedPrices['14d']) },
            { key: 'agent_upgrade_price_30d', value: String(validatedPrices['30d']) },
            { key: 'agent_upgrade_price_permanent', value: String(validatedPrices['permanent']) }
        ]

        // Update strikethrough toggle if provided
        if (showStrikethrough !== undefined) {
            updates.push({ key: 'show_price_strikethrough', value: String(showStrikethrough) })
        }

        for (const { key, value } of updates) {
            // Delete existing record if it exists
            await supabaseAdmin.from('admin_settings').delete().eq('key', key)

            // Insert new record
            const { error } = await supabaseAdmin.from('admin_settings').insert({ key, value } as any)

            if (error) {
                console.error(`Error updating ${key}:`, error)
                return NextResponse.json(
                    { error: `Failed to update ${key}: ${error.message}` },
                    { status: 500 }
                )
            }
        }

        // Verify the updates
        const { data: verifyData, error: verifyError } = await supabaseAdmin
            .from('admin_settings')
            .select('key, value')
            .in('key', ['agent_upgrade_price_3d', 'agent_upgrade_price_14d', 'agent_upgrade_price_30d', 'agent_upgrade_price_permanent'])

        if (verifyError) {
            console.error('Verification error:', verifyError)
        }

        const verified = {
            '3d': (verifyData as any)?.find((s: any) => s.key === 'agent_upgrade_price_3d')?.value || validatedPrices['3d'],
            '14d': (verifyData as any)?.find((s: any) => s.key === 'agent_upgrade_price_14d')?.value || validatedPrices['14d'],
            '30d': (verifyData as any)?.find((s: any) => s.key === 'agent_upgrade_price_30d')?.value || validatedPrices['30d'],
            'permanent': (verifyData as any)?.find((s: any) => s.key === 'agent_upgrade_price_permanent')?.value || validatedPrices['permanent']
        }

        revalidateTag(PUBLIC_CONFIG_CACHE_TAG)

        return NextResponse.json({
            success: true,
            verified,
            message: `Prices updated: 3d=GHS${verified['3d']}, 14d=GHS${verified['14d']}, 30d=GHS${verified['30d']}, permanent=GHS${verified['permanent']}`
        })

    } catch (error: any) {
        console.error('Error in update-prices API:', error)
        return NextResponse.json(
            { error: error.message || 'Internal server error' },
            { status: 500 }
        )
    }
}
