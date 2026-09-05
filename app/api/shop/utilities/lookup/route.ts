import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { Ratelimit } from '@upstash/ratelimit'
import { Redis } from '@upstash/redis'
import { UTILITY_SERVICES, isUtilityService } from '@/lib/hubtel-utility-service'
import { queryUtilityAccount } from '@/lib/utility-provider'
import { isUtilityVisibleTo, UTILITY_LAUNCH_KEY, utilitySettingKeys } from '@/lib/utility-order-intent'
import { computeUtilityMarkup } from '@/lib/utility-shop-pricing'

/**
 * Storefront account lookup, for guests.
 *
 * The customer must see whose bill they are about to pay before they pay it — a
 * meter or smartcard number is bare digits with no check digit, and a mistyped one
 * belongs to a stranger. Nothing here is trusted afterwards: /api/utilities/
 * gateway-init re-queries the provider before it charges anyone.
 *
 * Also quotes the price, because the storefront has to show a total before the
 * customer commits and must not compute the markup itself — a number the browser
 * worked out is a number the browser can change.
 *
 * Rate limited by IP rather than by account. It is unauthenticated and each call is
 * a paid third-party request, and scanning it across a range of numbers would
 * enumerate strangers' names.
 */
let lookupLimit: Ratelimit | null = null
try {
    lookupLimit = new Ratelimit({
        redis: Redis.fromEnv(),
        limiter: Ratelimit.slidingWindow(10, '1 m'),
        prefix: 'rl:shop-utility-lookup',
    })
} catch (e) {
    console.error('[ShopUtilityLookup] Redis init failed — rate limit disabled:', e)
}

function clientIp(request: NextRequest): string {
    return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
        || request.headers.get('x-real-ip')
        || 'unknown'
}

export async function POST(request: NextRequest) {
    try {
        // Fails OPEN, like every other limiter here: Upstash running out of quota
        // must not be the thing that closes a shop's storefront.
        try {
            if (lookupLimit) {
                const { success } = await lookupLimit.limit(clientIp(request))
                if (!success) {
                    return NextResponse.json({ error: 'Too many lookups. Please wait a moment.' }, { status: 429 })
                }
            }
        } catch (e) {
            console.error('[ShopUtilityLookup] Rate limit check failed (allowing):', e)
        }

        let body: any
        try { body = await request.json() } catch {
            return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
        }

        const { shopSlug, service, accountNumber, phone, amount } = body

        if (!isUtilityService(service)) {
            return NextResponse.json({ error: 'Unknown service' }, { status: 400 })
        }
        if (typeof shopSlug !== 'string' || !shopSlug.trim()) {
            return NextResponse.json({ error: 'shopSlug is required' }, { status: 400 })
        }

        const db = createServerClient() as any
        const def = UTILITY_SERVICES[service]

        const { data: shop } = await db
            .from('shop_profiles')
            .select('id, name, owner_id, utilities_enabled, approval_status, is_active')
            .eq('slug', shopSlug.trim())
            .maybeSingle()

        if (!shop || shop.approval_status !== 'approved' || shop.is_active !== true) {
            return NextResponse.json({ error: 'Shop not found' }, { status: 404 })
        }
        if (shop.utilities_enabled !== true) {
            return NextResponse.json({ error: 'This shop does not accept bill payments.' }, { status: 403 })
        }

        const [{ data: owner }, { data: settingRows }] = await Promise.all([
            db.from('users').select('role').eq('id', shop.owner_id).maybeSingle(),
            db.from('admin_settings').select('key, value').in('key', [
                ...utilitySettingKeys(service),
                UTILITY_LAUNCH_KEY,
            ]),
        ])

        const settings: Record<string, string> = {}
        for (const row of ((settingRows as any[]) || [])) settings[row.key] = row.value

        // The shop's own toggle cannot open a product the platform has closed.
        if (!isUtilityVisibleTo((owner as any)?.role, settings)) {
            return NextResponse.json({ error: 'Bill payments are not available yet.' }, { status: 403 })
        }
        if (settings[`utility_enabled_${service}`] === 'false') {
            return NextResponse.json({ error: `${def.label} is currently unavailable.` }, { status: 503 })
        }

        const account = String(accountNumber ?? '').replace(/\s+/g, '')
        const cleanPhone = String(phone ?? '').replace(/\s+/g, '')
        const isEcg = def.kind === 'meter-by-phone'

        if (def.requiresPhone && !/^0\d{9}$/.test(cleanPhone)) {
            return NextResponse.json({ error: 'Enter a valid phone number: 0XXXXXXXXX' }, { status: 400 })
        }
        // ECG is looked up by phone, so the meter is optional at this stage — the
        // customer picks one from the list this returns.
        if (!isEcg && !def.accountPattern.test(account)) {
            return NextResponse.json({ error: `Enter a valid ${def.accountLabel}.` }, { status: 400 })
        }

        const lookup = await queryUtilityAccount({
            service,
            accountNumber: account || cleanPhone,
            phone: def.requiresPhone ? cleanPhone : undefined,
        })

        if (!lookup.success) {
            return NextResponse.json({ error: lookup.error || 'That account could not be verified.' }, { status: 400 })
        }

        // Quote only when an amount was given — the first call usually just resolves
        // the name, and the customer types the amount afterwards.
        let quote: any = null
        const billAmount = Number(amount)
        if (Number.isFinite(billAmount) && billAmount > 0) {
            const ownerRole = (owner as any)?.role === 'agent' ? 'agent' : 'customer'
            const platformRate = parseFloat(settings[`utility_fee_${service}_${ownerRole}`] || '2')
            const markup = await computeUtilityMarkup(db, {
                shopId: shop.id,
                service,
                ownerRole,
                billAmount,
            })
            const platformFee = Math.round(billAmount * platformRate) / 100
            quote = {
                bill_amount: billAmount,
                platform_fee: markup.platformAmount,
                shop_fee: markup.resellerAmount,
                total_fee: markup.totalFee,
                total: Math.round((billAmount + markup.totalFee) * 100) / 100,
                total_fee_percent: markup.totalPercent,
                // A gateway charge may still be added at checkout depending on the
                // provider, exactly as the dashboard flow warns.
                _platformFeeRaw: platformFee,
            }
        }

        return NextResponse.json({
            success: true,
            shop: { id: shop.id, name: shop.name },
            service,
            label: def.label,
            account_label: def.accountLabel,
            requires_phone: def.requiresPhone,
            requires_email: def.requiresEmail,
            account_name: lookup.accountName ?? null,
            amount_due: lookup.amountDue ?? null,
            meters: (lookup.meters || []).map(m => ({
                name: (/^(.*?)\s*\(/.exec(m.label)?.[1] || m.label || '').trim(),
                meterNumber: m.meterNumber,
                outstanding: m.balance,
            })),
            min_amount: Number(settings[`utility_min_amount_${service}`] ?? 1),
            max_amount: Number(settings[`utility_max_amount_${service}`] ?? 1000),
            quote,
        })
    } catch (err: any) {
        console.error('[ShopUtilityLookup] error:', err)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
