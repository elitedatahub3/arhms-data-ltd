import { NextRequest, NextResponse } from 'next/server'
import { revalidateTag } from 'next/cache'
import { createServerClient } from '@/lib/supabase'
import { PUBLIC_CONFIG_CACHE_TAG } from '@/lib/cache-tags'
import { verifyBundlesAdmin } from '@/lib/bundle-admin'
import { BUNDLE_PRICE_TIERS, BUNDLE_SETTING_KEYS, bundleSettingKeys } from '@/lib/bundle-pricing'
import { BUNDLE_NETWORKS } from '@/lib/kingflexy-bundles-service'
import { BUNDLE_PROVIDERS, diagnoseProviderCatalog, invalidateAllBundleCatalogs, isBundleProvider } from '@/lib/bundle-provider'

export const dynamic = 'force-dynamic'

const BOOLEAN_KEYS = new Set<string>([
    BUNDLE_SETTING_KEYS.enabled,
    BUNDLE_SETTING_KEYS.networkEnabled('MTN'),
    BUNDLE_SETTING_KEYS.networkEnabled('Telecel'),
    BUNDLE_SETTING_KEYS.networkEnabled('AT'),
    BUNDLE_SETTING_KEYS.autoDispatch,
    BUNDLE_SETTING_KEYS.storefront,
    BUNDLE_SETTING_KEYS.pageAccess,
])
const PERCENT_KEYS = new Set<string>(BUNDLE_PRICE_TIERS.map(BUNDLE_SETTING_KEYS.markupPercent))
const PROVIDER_KEYS = new Set<string>(BUNDLE_NETWORKS.map(BUNDLE_SETTING_KEYS.provider))

/**
 * GET: settings. With ?check=1, also whether each provider's catalog answers for
 * our key right now, per network: `providers.kingflexy.MTN`, `providers.datagod.AT`, …
 */
export async function GET(request: NextRequest) {
    const admin = await verifyBundlesAdmin()
    if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const supabase = createServerClient() as any
    const { data, error } = await supabase.from('admin_settings').select('key, value').in('key', bundleSettingKeys())
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    const settings: Record<string, string> = {}
    for (const row of (data || [])) settings[row.key] = row.value

    type Check = { ok: boolean; bundles?: number; enabled?: boolean; error?: string }
    let providers: Record<string, Record<string, Check>> | undefined
    if (request.nextUrl.searchParams.get('check') === '1') {
        invalidateAllBundleCatalogs()
        providers = {}
        await Promise.all(BUNDLE_PROVIDERS.map(async p => {
            const out: Record<string, Check> = {}
            for (const n of BUNDLE_NETWORKS) {
                // The diagnostic read: same request, but the real reason on failure
                // (missing key, HTTP status, network error) instead of the buyer text.
                const res = await diagnoseProviderCatalog(p, n)
                out[n] = res.success
                    ? { ok: true, bundles: res.catalog.bundles.length, enabled: res.catalog.enabled }
                    : { ok: false, error: res.error }
            }
            providers[p] = out
        }))
    }

    return NextResponse.json({ settings, providers })
}

/** POST — upsert whitelisted settings. Body: { settings: { key: value } } */
export async function POST(request: NextRequest) {
    const admin = await verifyBundlesAdmin()
    if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    let body: any
    try {
        body = await request.json()
    } catch {
        return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
    }
    const input = body?.settings
    if (!input || typeof input !== 'object') return NextResponse.json({ error: 'settings object required' }, { status: 400 })

    const rows: { key: string; value: string }[] = []
    for (const [key, raw] of Object.entries(input)) {
        const value = String(raw ?? '').trim()
        if (BOOLEAN_KEYS.has(key)) {
            if (value !== 'true' && value !== 'false') return NextResponse.json({ error: `${key} must be true or false` }, { status: 400 })
        } else if (PERCENT_KEYS.has(key)) {
            const n = Number(value)
            if (!Number.isFinite(n) || n < 0 || n > 100) return NextResponse.json({ error: `${key} must be a percentage between 0 and 100` }, { status: 400 })
        } else if (PROVIDER_KEYS.has(key)) {
            if (!isBundleProvider(value)) return NextResponse.json({ error: `${key} must be ${BUNDLE_PROVIDERS.join(' or ')}` }, { status: 400 })
        } else if (key === BUNDLE_SETTING_KEYS.markupMinGhs) {
            const n = Number(value)
            if (!Number.isFinite(n) || n < 0 || n > 1000) return NextResponse.json({ error: 'Minimum markup must be between 0 and 1000 GHS' }, { status: 400 })
        } else {
            return NextResponse.json({ error: `Unknown setting ${key}` }, { status: 400 })
        }
        rows.push({ key, value })
    }
    if (!rows.length) return NextResponse.json({ error: 'Nothing to save' }, { status: 400 })

    const supabase = createServerClient() as any

    // Datagod orders need the provider / dg_bundle_id columns. Refuse the switch
    // rather than let every Datagod purchase fail on insert.
    if (rows.some(r => PROVIDER_KEYS.has(r.key) && r.value === 'datagod')) {
        const [probe, legsProbe] = await Promise.all([
            supabase.from('bundle_orders').select('provider, dg_bundle_id, refunded_amount').limit(1),
            supabase.from('bundle_order_legs').select('id').limit(1),
        ])
        if (probe.error || legsProbe.error) {
            return NextResponse.json({ error: 'Run migrations 20261127000000_bundle_provider.sql and 20261127010000_bundle_order_legs.sql before switching a network to Datagod.' }, { status: 409 })
        }
    }

    const { error } = await supabase.from('admin_settings').upsert(rows, { onConflict: 'key' })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    revalidateTag(PUBLIC_CONFIG_CACHE_TAG)
    // A provider switch changes which catalog buyers see; drop both so the next
    // page load reads the new provider's prices fresh.
    if (rows.some(r => PROVIDER_KEYS.has(r.key))) invalidateAllBundleCatalogs()
    return NextResponse.json({ success: true })
}
