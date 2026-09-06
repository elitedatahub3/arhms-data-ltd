import { NextRequest, NextResponse } from 'next/server'
import { createRouteHandlerClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { isUtilitySurfaceOpen, utilitySurfaceSettingKeys, UTILITY_LAUNCH_KEY } from '@/lib/utility-order-intent'
import { Ratelimit } from '@upstash/ratelimit'
import { Redis } from '@upstash/redis'
import {
    UTILITY_SERVICES,
    isUtilityService,
} from '@/lib/hubtel-utility-service'
// The catalogue above stays; the network call comes from the provider seam.
import { queryUtilityAccount } from '@/lib/utility-provider'

/**
 * Resolves a utility account number to the customer's name before they pay.
 *
 * The whole point of the utilities flow: a DSTV smartcard or an ECG meter is a bare
 * string of digits with no check digit, and a mistyped one belongs to somebody else.
 * The form will not enable its Pay button until this returns a name.
 *
 * Rate-limited per user because it is an unauthenticated-feeling free lookup against
 * a third party that bills us for the relationship, and because scanning it over a
 * range of account numbers would enumerate other people's names.
 *
 * Nothing this returns is trusted on the way back in — /api/utilities/create and
 * /api/utilities/gateway-init both re-run the same query server-side before they
 * charge anything. This endpoint exists so the customer can SEE the name, not so the
 * server can learn it.
 */
let lookupRateLimit: Ratelimit | null = null
try {
    lookupRateLimit = new Ratelimit({
        redis: Redis.fromEnv(),
        limiter: Ratelimit.slidingWindow(20, '1 m'),
        prefix: 'rl:utility-query',
    })
} catch (e) {
    console.error('[UtilityQuery] Redis init failed — lookup rate limit disabled:', e)
}

export async function POST(request: NextRequest) {
    try {
        const supabaseUserClient = await createRouteHandlerClient()
        const { data: { user: authUser }, error: authError } = await supabaseUserClient.auth.getUser()

        if (authError || !authUser) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        // Live in production ahead of the public launch — see isUtilitySurfaceOpen.
        // Verifying somebody's account is a third-party call we pay for, so it is
        // gated too, not just the payment.
        const db = createServerClient()
        const [{ data: gateProfile }, { data: gateRows }] = await Promise.all([
            db.from('users').select('role').eq('id', authUser.id).single(),
            db.from('admin_settings').select('key, value').in('key', [UTILITY_LAUNCH_KEY, ...utilitySurfaceSettingKeys()]),
        ])
        const gateSettings: Record<string, string> = {}
        for (const row of ((gateRows || []) as any[])) gateSettings[row.key] = row.value
        if (!isUtilitySurfaceOpen('dashboard', (gateProfile as any)?.role, gateSettings)) {
            return NextResponse.json({ error: 'Bill payments are not available yet.' }, { status: 403 })
        }

        // Fail open, the same way /api/orders/purchase and the broadcast routes do.
        // Upstash's quota runs out long before Hubtel's does, and when it did, this
        // was the only route that turned that into a 500: every other caller catches
        // here, so a lookup that costs us nothing must not be the one thing that
        // breaks. A throw from .limit() means the limiter is unavailable, not that
        // the user is over their limit.
        try {
            if (lookupRateLimit) {
                const { success } = await lookupRateLimit.limit(authUser.id)
                if (!success) {
                    return NextResponse.json(
                        { error: 'Too many lookups. Please wait a moment and try again.' },
                        { status: 429 }
                    )
                }
            }
        } catch (rlErr) {
            console.error('[UtilityQuery] Rate limit check failed (Redis exhausted?), proceeding:', rlErr)
        }

        let body: any
        try {
            body = await request.json()
        } catch {
            return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
        }

        const { service, accountNumber, phone } = body

        if (!isUtilityService(service)) {
            return NextResponse.json({ error: 'Unknown utility service' }, { status: 400 })
        }

        const def = UTILITY_SERVICES[service]
        const cleanAccount = String(accountNumber ?? '').replace(/\s+/g, '')
        const cleanPhone = String(phone ?? '').replace(/\s+/g, '')

        // ECG looks up by phone and returns the meters, so it is the one service that
        // does not need an account number to ask its question.
        if (def.kind !== 'meter-by-phone' && !def.accountPattern.test(cleanAccount)) {
            return NextResponse.json({ error: `Enter a valid ${def.accountLabel}.` }, { status: 400 })
        }
        if (def.requiresPhone && !/^0\d{9}$/.test(cleanPhone)) {
            return NextResponse.json(
                { error: 'Enter a valid Ghana phone number: 0XXXXXXXXX (10 digits starting with 0)' },
                { status: 400 }
            )
        }

        const result = await queryUtilityAccount({
            service,
            accountNumber: cleanAccount || undefined,
            phone: def.requiresPhone ? cleanPhone : undefined,
        })

        if (!result.success) {
            return NextResponse.json({ error: result.error || 'Account could not be verified' }, { status: 400 })
        }

        // sessionId is deliberately NOT returned. It is single-use, the browser has no
        // use for it, and the charge paths fetch their own moments before paying.
        return NextResponse.json({
            success: true,
            service,
            accountName: result.accountName ?? null,
            amountDue: result.amountDue ?? null,
            meters: result.meters ?? null,
            details: result.details ?? [],
        })
    } catch (error) {
        console.error('[UtilityQuery] Unexpected error:', error)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
