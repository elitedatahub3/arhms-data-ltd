import { NextRequest, NextResponse } from 'next/server'
import { validateAdminAccess } from '@/lib/auth-utils'

// Diagnostic, admin-only. Reports the SHAPE of Dakazina's transaction feed.
//
// Why this exists: lib/fulfillment-service.ts calls POST /fetch-single-transaction,
// which Dakazina removed — it answers 404, so checkOrderStatus() and the admin
// "Sync Dakazina" button silently do nothing and report "updated 0". Probing their
// API showed GET /fetch-transactions answers 401 rather than 404, i.e. it exists and
// only wants the key. It is the replacement, but its response shape is undocumented
// to us (their /docs/ is behind a login).
//
// This route is how we learn that shape without guessing field names, and without
// putting DATAKAZINA_API_KEY in front of anyone: the key stays server-side, and only
// the KEY NAMES plus a redacted sample come back. Guessing is the failure mode that
// produced /admin/up2u-checker, which shipped against an invented path and 404s.
//
// Delete this once the reconciliation cron is built on the real shape.

const BASE = process.env.DATAKAZINA_API_BASE_URL || 'https://reseller.dakazinabusinessconsult.com/api/v1'
const KEY = process.env.DATAKAZINA_API_KEY || ''

// Values may carry customer phone numbers, so nothing is echoed raw. Short,
// non-numeric-looking values pass through because those are the status labels and
// reference formats we actually need to read.
function redact(value: any): any {
    if (value === null || value === undefined) return value
    if (typeof value === 'number' || typeof value === 'boolean') return value
    if (Array.isArray(value)) return `[array:${value.length}]`
    if (typeof value === 'object') return `{object:${Object.keys(value).join('|')}}`

    const s = String(value)
    // A run of 9+ digits is a phone number or an account id — length only.
    if (/\d{9,}/.test(s)) return `<${s.length} chars, digits>`
    if (s.length > 64) return `<${s.length} chars>`
    return s
}

export async function GET(request: NextRequest) {
    const authResult = await validateAdminAccess(true, request)
    if (authResult.error) {
        return NextResponse.json({ error: authResult.error }, { status: authResult.status })
    }

    if (!KEY) {
        return NextResponse.json({ error: 'DATAKAZINA_API_KEY is not configured' }, { status: 503 })
    }

    const url = `${BASE}/fetch-transactions`

    try {
        const response = await fetch(url, {
            method: 'GET',
            headers: { 'Accept': 'application/json', 'x-api-key': KEY },
            signal: AbortSignal.timeout(20_000),
        })

        const rawText = await response.text()

        let data: any
        try {
            data = JSON.parse(rawText)
        } catch {
            // Non-JSON is itself the answer (an HTML error page, say) — report enough
            // to recognise it without dumping a whole page into the response.
            return NextResponse.json({
                ok: false,
                httpStatus: response.status,
                note: 'Response was not JSON',
                bodyStart: rawText.slice(0, 300),
            })
        }

        // Find the row array wherever it lives: data, data.data, data.transactions…
        let rows: any[] = []
        let rowsFoundAt = 'none'
        if (Array.isArray(data)) {
            rows = data
            rowsFoundAt = '(root)'
        } else if (data && typeof data === 'object') {
            for (const k of Object.keys(data)) {
                if (Array.isArray(data[k])) {
                    rows = data[k]
                    rowsFoundAt = k
                    break
                }
                if (data[k] && typeof data[k] === 'object') {
                    for (const k2 of Object.keys(data[k])) {
                        if (Array.isArray(data[k][k2])) {
                            rows = data[k][k2]
                            rowsFoundAt = `${k}.${k2}`
                            break
                        }
                    }
                }
                if (rows.length > 0) break
            }
        }

        const firstRow = rows[0] && typeof rows[0] === 'object' ? rows[0] : null

        return NextResponse.json({
            ok: response.ok,
            httpStatus: response.status,
            topLevelKeys: data && typeof data === 'object' ? Object.keys(data) : [],
            rowsFoundAt,
            rowCount: rows.length,
            // The payload: which columns each transaction carries.
            rowKeys: firstRow ? Object.keys(firstRow) : [],
            sampleRowRedacted: firstRow
                ? Object.fromEntries(Object.entries(firstRow).map(([k, v]) => [k, redact(v)]))
                : null,
            // Second row too: one row cannot show which fields vary per transaction.
            secondRowRedacted: rows[1] && typeof rows[1] === 'object'
                ? Object.fromEntries(Object.entries(rows[1]).map(([k, v]) => [k, redact(v)]))
                : null,
        })

    } catch (error: any) {
        return NextResponse.json({
            ok: false,
            error: error?.name === 'TimeoutError' ? 'Timed out after 20s' : (error?.message || 'Request failed'),
        }, { status: 200 })
    }
}
