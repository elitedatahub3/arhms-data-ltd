import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { validateAdminAccess } from '@/lib/auth-utils'
import { SMS_UNLOCK_PRICE_KEYS, SMS_PROVIDER_KEY } from '@/lib/sms/sms-purchase'
import { SMS_PLATFORM_SETTING_KEYS } from '@/lib/sms/platform'
import { normaliseWhatsApp } from '@/lib/sms/sms-rules'
import { isKingFlexySmsConfigured } from '@/lib/kingflexy-sms-service'
import { getActiveSmsProvider } from '@/lib/sms-service'

/**
 * Customer SMS configuration: the master switch, unlock prices per tier, pool
 * senders, the inline-send threshold, and the credit bundle price list.
 *
 * Its own endpoint rather than more keys on /api/admin/settings, because that
 * one admits sub-admins and these are prices.
 */

const SETTING_KEYS = [
    // The only on/off switch. Deliberately not a page_access_* key: those reach
    // the nav through the public_admin_settings allowlist view, which a new key
    // is not in, so the toggle would save and never hide anything.
    'sms_customer_enabled',
    // The storefront gateway, split from the platform's own in 20260929000000.
    'active_sms_provider_storefront',
    'sms_pool_senders',
    'sms_inline_send_max',
    SMS_PROVIDER_KEY,
    ...SMS_UNLOCK_PRICE_KEYS,
    // SMS Platform: daily limits and sender caps per mode, and the documents WhatsApp.
    ...SMS_PLATFORM_SETTING_KEYS,
]

const unquote = (v: any) => (v === null || v === undefined ? '' : String(v).replace(/^"+|"+$/g, ''))

export async function GET(request: NextRequest) {
    try {
        const authResult = await validateAdminAccess(false, request)
        if (authResult.error) return NextResponse.json({ error: authResult.error }, { status: authResult.status })

        const supabase = createServerClient()

        const { data: rows } = await (supabase as any)
            .from('admin_settings')
            .select('key, value')
            .in('key', SETTING_KEYS)

        const settings: Record<string, string> = {}
        for (const key of SETTING_KEYS) settings[key] = ''
        for (const row of rows || []) settings[row.key] = unquote(row.value)

        const { data: bundles } = await (supabase as any)
            .from('sms_credit_bundles')
            .select('id, name, credits, price, sort_order, is_active')
            .order('sort_order', { ascending: true })

        // What Customer SMS will actually send through, which is not always the
        // global gateway toggle — see the send route.
        const kingflexyConfigured = isKingFlexySmsConfigured()
        return NextResponse.json({
            success: true,
            settings,
            bundles: bundles || [],
            kingflexyConfigured,
            platformGateway: await getActiveSmsProvider('main'),
            customerSmsGateway: await getActiveSmsProvider('storefront'),
        })
    } catch (error: any) {
        console.error('[AdminSmsConfig] GET error:', error)
        return NextResponse.json({ error: 'Failed to load SMS settings' }, { status: 500 })
    }
}

/**
 * body: { settings?: Record<key, string>, bundles?: Bundle[], deleteBundleIds?: string[] }
 */
export async function POST(request: NextRequest) {
    try {
        const authResult = await validateAdminAccess(false, request)
        if (authResult.error) return NextResponse.json({ error: authResult.error }, { status: authResult.status })

        const supabase = createServerClient()
        const body: any = await request.json().catch(() => ({}))

        if (body.settings && typeof body.settings === 'object') {
            const updates: { key: string; value: string }[] = []

            for (const [key, raw] of Object.entries(body.settings)) {
                if (!SETTING_KEYS.includes(key)) continue
                const value = String(raw ?? '').trim()

                if (key === 'sms_business_docs_whatsapp') {
                    const wa = value ? normaliseWhatsApp(value) : ''
                    if (wa === null) {
                        return NextResponse.json({ error: 'Documents WhatsApp must be a Ghana number, e.g. 233244123456' }, { status: 400 })
                    }
                    updates.push({ key, value: wa })
                    continue
                }

                if ((SMS_UNLOCK_PRICE_KEYS as readonly string[]).includes(key) || key === 'sms_inline_send_max' || key.startsWith('sms_daily_limit_') || key.startsWith('sms_sender_cap_')) {
                    const n = Number(value)
                    if (!Number.isFinite(n) || n < 0) {
                        return NextResponse.json({ error: `${key} must be a number of zero or more` }, { status: 400 })
                    }
                }

                // Plain string, the way /api/admin-settings writes. Seeded rows arrive
                // JSON-quoted instead, which is why every SMS reader unquotes.
                updates.push({ key, value })
            }

            if (updates.length) {
                const { error } = await (supabase as any).from('admin_settings').upsert(updates, { onConflict: 'key' })
                if (error) {
                    console.error('[AdminSmsConfig] settings upsert failed:', error)
                    return NextResponse.json({ error: 'Could not save settings' }, { status: 500 })
                }
            }
        }

        if (Array.isArray(body.bundles)) {
            for (const b of body.bundles) {
                const name = String(b.name || '').trim()
                const credits = Math.floor(Number(b.credits))
                const price = Number(b.price)

                if (!name || !(credits > 0) || !(price >= 0)) {
                    return NextResponse.json(
                        { error: `Bundle "${name || 'untitled'}" needs a name, a positive credit count and a price` },
                        { status: 400 }
                    )
                }

                const row = {
                    name,
                    credits,
                    price,
                    sort_order: Math.floor(Number(b.sort_order) || 0),
                    is_active: b.is_active !== false,
                    updated_at: new Date().toISOString(),
                }

                const { error } = b.id
                    ? await (supabase as any).from('sms_credit_bundles').update(row).eq('id', b.id)
                    : await (supabase as any).from('sms_credit_bundles').insert(row)

                if (error) {
                    console.error('[AdminSmsConfig] bundle save failed:', error)
                    return NextResponse.json({ error: `Could not save bundle "${name}"` }, { status: 500 })
                }
            }
        }

        if (Array.isArray(body.deleteBundleIds) && body.deleteBundleIds.length) {
            // Deactivate rather than delete: past purchases reference the bundle,
            // and their history should still say what was bought.
            await (supabase as any)
                .from('sms_credit_bundles')
                .update({ is_active: false, updated_at: new Date().toISOString() })
                .in('id', body.deleteBundleIds)
        }

        return NextResponse.json({ success: true })
    } catch (error: any) {
        console.error('[AdminSmsConfig] POST error:', error)
        return NextResponse.json({ error: error.message || 'Failed to save SMS settings' }, { status: 500 })
    }
}
