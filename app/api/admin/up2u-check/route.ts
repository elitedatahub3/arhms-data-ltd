import { NextRequest, NextResponse } from 'next/server'
import { validateAdminAccess } from '@/lib/auth-utils'
import { validateGhanaianPhone } from '@/lib/phone-validation'
import { checkUp2uDelivery, type Up2uRecord } from '@/lib/eazydata-service'

export const maxDuration = 60

const MAX_NUMBERS = 50
// Parallel supplier calls. Keeps a full 50-number batch well inside maxDuration
// (10 batches x 10s timeout worst case) without hammering Eazy Data.
const CONCURRENCY = 5

interface LookupRow {
    input: string
    phone: string
    success: boolean
    records: Up2uRecord[]
    error?: string
    apiResponse?: unknown
}

/**
 * Admin support tool: confirm UP2U deliveries to MTN numbers via Eazy Data.
 * POST { numbers: string[] } → { results, summary }. Add ?debug=1 to include the raw
 * (sanitised) supplier response, useful while the endpoint shape is being confirmed.
 */
export async function POST(request: NextRequest) {
    const auth = await validateAdminAccess(false)
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status })
    }

    let body: { numbers?: unknown }
    try {
        body = await request.json()
    } catch {
        return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
    }

    const rawNumbers = body?.numbers
    if (!Array.isArray(rawNumbers) || rawNumbers.length === 0) {
        return NextResponse.json({ error: 'No numbers provided' }, { status: 400 })
    }

    const debug = request.nextUrl.searchParams.get('debug') === '1'

    // Classify and dedupe first, so invalid and non-MTN numbers never reach the supplier.
    const results: LookupRow[] = []
    const seen = new Set<string>()
    for (const raw of rawNumbers) {
        const input = String(raw ?? '').trim()
        if (!input) continue

        const validation = validateGhanaianPhone(input)
        if (!validation.isValid) {
            results.push({ input, phone: '', success: false, records: [], error: validation.error || 'Invalid number' })
            continue
        }
        if (seen.has(validation.normalizedNumber)) continue
        seen.add(validation.normalizedNumber)

        if (validation.network !== 'MTN') {
            results.push({ input, phone: validation.normalizedNumber, success: false, records: [], error: 'Not an MTN number' })
            continue
        }
        results.push({ input, phone: validation.normalizedNumber, success: false, records: [] })
    }

    const toLookup = results.filter(r => r.phone && !r.error)
    if (toLookup.length > MAX_NUMBERS) {
        return NextResponse.json({ error: `Maximum ${MAX_NUMBERS} MTN numbers per check` }, { status: 400 })
    }

    for (let i = 0; i < toLookup.length; i += CONCURRENCY) {
        const batch = toLookup.slice(i, i + CONCURRENCY)
        const lookups = await Promise.all(batch.map(row => checkUp2uDelivery(row.phone)))
        batch.forEach((row, index) => {
            const lookup = lookups[index]
            row.success = lookup.success
            row.records = lookup.records
            row.error = lookup.error
            if (debug) row.apiResponse = lookup.apiResponse
        })
    }

    return NextResponse.json({
        results,
        summary: {
            total: results.length,
            checked: toLookup.length,
            withRecords: results.filter(r => r.success && r.records.length > 0).length,
            noRecords: results.filter(r => r.success && r.records.length === 0).length,
            errors: results.filter(r => !r.success).length,
        },
    })
}
