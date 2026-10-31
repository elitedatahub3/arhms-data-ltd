import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { createRouteHandlerClient } from '@/lib/supabase-server'
import { isBundleNetwork } from '@/lib/kingflexy-bundles-service'
import { resolveBundleTier } from '@/lib/bundle-pricing'
import { getPricedCatalog, isBundleNetworkEnabled, isBundlesDashboardOpen, loadBundleSettings } from '@/lib/bundle-order-intent'

export const dynamic = 'force-dynamic'

/**
 * The Standard Bundles catalog for one network, priced for the signed-in user's tier.
 *
 * Never exposes KingFlexy's cost or catalog keys — only our opaque bundle key, which
 * /api/bundles/create re-resolves server-side.
 */
export async function GET(request: NextRequest) {
    const userClient = await createRouteHandlerClient()
    const { data: { user }, error: authError } = await userClient.auth.getUser()
    if (authError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const network = request.nextUrl.searchParams.get('network') || 'MTN'
    if (!isBundleNetwork(network)) {
        return NextResponse.json({ error: 'network must be MTN, Telecel or AT' }, { status: 400 })
    }

    const supabase = createServerClient() as any
    const [settings, userResult] = await Promise.all([
        loadBundleSettings(supabase),
        // '*' so a database without is_api_user still answers.
        supabase.from('users').select('*').eq('id', user.id).single(),
    ])

    const networks = {
        MTN: isBundleNetworkEnabled(settings, 'MTN'),
        Telecel: isBundleNetworkEnabled(settings, 'Telecel'),
        AT: isBundleNetworkEnabled(settings, 'AT'),
    }

    if (!isBundlesDashboardOpen(settings)) {
        return NextResponse.json({ enabled: false, networks, catalog: null })
    }

    const tier = resolveBundleTier(userResult.data)
    const priced = await getPricedCatalog(network, tier, settings)
    if (!priced.ok) return NextResponse.json({ error: priced.error }, { status: priced.status })

    return NextResponse.json({ enabled: true, networks, tier, catalog: priced.catalog })
}
