import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { createRouteHandlerClient } from '@/lib/supabase-server'
import { UTILITY_SERVICES, UTILITY_SERVICE_KEYS } from '@/lib/hubtel-utility-service'
import { isUtilitySurfaceOpen, utilitySurfaceSettingKeys, UTILITY_LAUNCH_KEY } from '@/lib/utility-order-intent'

/**
 * What the utilities form needs to render: which services are on, and what each
 * costs THIS user.
 *
 * A dedicated route rather than 25 more entries in /api/admin-settings'
 * PUBLIC_SAFE_KEYS. It also means the customer rate and the agent rate are never
 * both on the wire — the caller is told their own price and nothing else.
 *
 * Display only. Every number here is recomputed server-side in
 * lib/utility-order-intent.ts before a charge, so tampering with the response
 * changes what the form shows and nothing that is billed.
 */
export async function GET() {
    try {
        const supabaseUserClient = await createRouteHandlerClient()
        const { data: { user: authUser }, error: authError } = await supabaseUserClient.auth.getUser()

        if (authError || !authUser) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const supabase = createServerClient() as any

        const keys: string[] = ['page_access_utilities', UTILITY_LAUNCH_KEY, ...utilitySurfaceSettingKeys()]
        for (const service of UTILITY_SERVICE_KEYS) {
            keys.push(
                `utility_enabled_${service}`,
                `utility_fee_${service}_customer`,
                `utility_fee_${service}_agent`,
                `utility_min_amount_${service}`,
                `utility_max_amount_${service}`,
            )
        }

        const [{ data: profile }, { data: rows }] = await Promise.all([
            supabase.from('users').select('role, phone_number, email').eq('id', authUser.id).single(),
            supabase.from('admin_settings').select('key, value').in('key', keys),
        ])

        const settings: Record<string, string> = {}
        for (const row of (rows || [])) settings[row.key] = row.value

        const role: 'agent' | 'customer' = profile?.role === 'agent' ? 'agent' : 'customer'

        const services = UTILITY_SERVICE_KEYS.map(service => {
            const def = UTILITY_SERVICES[service]
            return {
                id: service,
                label: def.label,
                kind: def.kind,
                accountLabel: def.accountLabel,
                accountHint: def.accountHint,
                // Sent as a source string so the form can tell a finished account
                // number from a half-typed one and verify without a button press.
                // Serialised from the same regex the server validates with, so the
                // two cannot drift apart.
                accountPattern: def.accountPattern.source,
                requiresPhone: def.requiresPhone,
                requiresEmail: def.requiresEmail,
                enabled: settings[`utility_enabled_${service}`] !== 'false',
                feeRate: parseFloat(settings[`utility_fee_${service}_${role}`] || '2'),
                minAmount: parseFloat(settings[`utility_min_amount_${service}`] || '1'),
                maxAmount: parseFloat(settings[`utility_max_amount_${service}`] || '2000'),
            }
        })

        return NextResponse.json({
            pageEnabled: settings['page_access_utilities'] !== 'false',
            // The page is live in production before it is open — see
            // isUtilityVisibleTo. The dashboard shows Coming Soon on this alone.
            comingSoon: !isUtilitySurfaceOpen('dashboard', profile?.role, settings),
            role,
            defaultPhone: profile?.phone_number || null,
            defaultEmail: profile?.email || null,
            services,
        })
    } catch (error) {
        console.error('[UtilityConfig] Unexpected error:', error)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
