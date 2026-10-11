import { NextRequest, NextResponse } from 'next/server'
import { createRouteHandlerClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { checkMtnRegistrationBatch, isMtnPackageNetwork } from '@/lib/mtn-registration-gate'
import { validateGhanaianPhone } from '@/lib/phone-validation'

const MAX_NUMBERS = 100

/**
 * Registration status for a set of numbers, for the bulk Validate step.
 *
 * This is a UX aid so an agent can see which of their pasted numbers will be delayed
 * BEFORE they pay — it is never the enforcement point. /api/orders/bulk-purchase does
 * its own check and 409s regardless of what this returned.
 *
 * Warms the same mtn_registered_numbers cache the purchase gate reads, so the
 * subsequent submit costs no extra upstream call.
 */
export async function POST(request: NextRequest) {
    try {
        const userClient = await createRouteHandlerClient()
        const { data: { user: authUser }, error: authError } = await userClient.auth.getUser()

        if (authError || !authUser) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        let body: { numbers?: unknown; network?: unknown }
        try {
            body = await request.json()
        } catch {
            return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
        }

        const rawNumbers = body?.numbers
        const network = String(body?.network ?? '')

        if (!Array.isArray(rawNumbers) || rawNumbers.length === 0) {
            return NextResponse.json({ error: 'No numbers provided' }, { status: 400 })
        }

        if (rawNumbers.length > MAX_NUMBERS) {
            return NextResponse.json({ error: `Maximum ${MAX_NUMBERS} numbers per check` }, { status: 400 })
        }

        // Non-MTN batches need no upstream call at all.
        if (!isMtnPackageNetwork(network)) {
            return NextResponse.json({ gateActive: false, statuses: {} })
        }

        const entries = rawNumbers
            .map(raw => String(raw ?? '').trim())
            .filter(Boolean)
            .map(phoneNumber => ({ phoneNumber, packageNetwork: network }))

        // Service-role client: the gate reads admin_settings and writes the cache,
        // neither of which is reachable under the caller's RLS.
        const supabase = createServerClient()
        const { statusByNumber } = await checkMtnRegistrationBatch(supabase, entries, 'site')

        // Key the response by the caller's original input so the UI can line results up
        // with its own rows without re-implementing normalization.
        const statuses: Record<string, string> = {}
        for (const { phoneNumber } of entries) {
            const validation = validateGhanaianPhone(phoneNumber)
            if (!validation.isValid) continue
            const status = statusByNumber.get(validation.normalizedNumber)
            if (status) statuses[phoneNumber] = status
        }

        return NextResponse.json({
            gateActive: statusByNumber.size > 0,
            statuses,
        })
    } catch (err: any) {
        // Fail open — this is advisory only, and the submit path enforces regardless.
        console.error('[MTN VerifyBatch] Error:', err)
        return NextResponse.json({ gateActive: false, statuses: {} })
    }
}
