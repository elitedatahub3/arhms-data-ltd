import { NextRequest, NextResponse } from 'next/server'
import { Ratelimit } from '@upstash/ratelimit'
import { Redis } from '@upstash/redis'
import { createServerClient } from '@/lib/supabase'
import { verifyMtnWhitelist } from '@/lib/agentportal-service'
import { verifyMtnNumbers } from '@/lib/bundleportal-service'
import { validateGhanaianPhone } from '@/lib/phone-validation'
import { recordRegistrationResults } from '@/lib/mtn-registration-gate'

export const maxDuration = 30

/**
 * Storefront "Check your MTN number", for guests.
 *
 * The storefront twin of /api/mtn/check-registration, cut down to ONE number: a guest
 * checks the number they are about to buy for, not a list. Same two servers:
 * Server 1 = Agent Portal (an unregistered number is auto-submitted to MTN),
 * Server 2 = BundlePortal (check only).
 *
 * Unauthenticated, and every call is a paid upstream request, so it is rate limited
 * by IP and only answers for a live shop.
 */
let checkLimit: Ratelimit | null = null
try {
    checkLimit = new Ratelimit({
        redis: Redis.fromEnv(),
        limiter: Ratelimit.slidingWindow(10, '1 m'),
        prefix: 'rl:shop-mtn-check',
    })
} catch (e) {
    console.error('[ShopMtnCheck] Redis init failed — rate limit disabled:', e)
}

function clientIp(request: NextRequest): string {
    return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
        || request.headers.get('x-real-ip')
        || 'unknown'
}

export async function POST(request: NextRequest) {
    try {
        // Fails OPEN, like the other storefront limiters.
        try {
            if (checkLimit) {
                const { success } = await checkLimit.limit(clientIp(request))
                if (!success) {
                    return NextResponse.json({ error: 'Too many checks. Please wait a moment.' }, { status: 429 })
                }
            }
        } catch (e) {
            console.error('[ShopMtnCheck] Rate limit check failed (allowing):', e)
        }

        let body: { shopSlug?: unknown; number?: unknown; server?: unknown }
        try { body = await request.json() } catch {
            return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
        }

        const shopSlug = typeof body.shopSlug === 'string' ? body.shopSlug.trim() : ''
        if (!shopSlug) {
            return NextResponse.json({ error: 'shopSlug is required' }, { status: 400 })
        }

        const server = Number(body.server) === 2 ? 2 : 1

        const validation = validateGhanaianPhone(String(body.number ?? '').trim())
        if (!validation.isValid) {
            return NextResponse.json({ error: validation.error || 'Enter a valid phone number' }, { status: 400 })
        }
        if (validation.network !== 'MTN') {
            return NextResponse.json({ error: `That is a ${validation.network} number, not MTN` }, { status: 400 })
        }
        const number = validation.normalizedNumber

        const db = createServerClient() as any
        const { data: shop } = await db
            .from('shop_profiles')
            .select('id')
            .eq('shop_slug', shopSlug)
            .eq('approval_status', 'approved')
            .eq('is_active', true)
            .maybeSingle()
        if (!shop) {
            return NextResponse.json({ error: 'Shop not found' }, { status: 404 })
        }

        if (!(server === 2 ? process.env.BUNDLEPORTAL_API_KEY : process.env.AGENTPORTAL_API_KEY)) {
            return NextResponse.json(
                { error: `Server ${server} is unavailable right now. Please try the other server.` },
                { status: 503 }
            )
        }

        if (server === 2) {
            const { success, allowed, failed, error } = await verifyMtnNumbers([number])
            if (!success || failed.has(number)) {
                return NextResponse.json(
                    { error: error || 'Could not check on Server 2 right now. Please try Server 1.' },
                    { status: 502 }
                )
            }
            return NextResponse.json({ server, number, registered: allowed.has(number) })
        }

        const { success, allowed, error } = await verifyMtnWhitelist([number])
        if (!success) {
            return NextResponse.json(
                { error: error || 'Could not reach MTN right now. Please try again.' },
                { status: 502 }
            )
        }
        const registered = allowed.has(number)

        // Warm the cache the purchase gate reads, so the order that follows costs no
        // extra upstream call. Best-effort.
        try {
            await recordRegistrationResults(db, [{ phoneNumber: number, isRegistered: registered }])
        } catch (cacheErr: any) {
            console.error('[ShopMtnCheck] Cache warm failed:', cacheErr?.message)
        }

        return NextResponse.json({ server, number, registered })
    } catch (err: any) {
        console.error('[ShopMtnCheck] Error:', err)
        return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
    }
}
