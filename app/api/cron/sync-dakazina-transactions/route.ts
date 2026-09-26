import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { syncShopOrderStatus } from '@/lib/shop-service'
import { normaliseSupplierStatus } from '@/lib/order-status-display'
import { areCronJobsEnabled, cronDisabledResponse } from '@/lib/cron-control'

// Dakazina reconciliation — the PULL side, and the only thing that can reach orders
// whose webhook fired while matching was broken. Those events are gone and are never
// re-sent, so roughly 218 orders sat delivered-at-Dakazina but 'processing' here.
//
// Replaces the dead POST /fetch-single-transaction (404 — they reorganised the API)
// with GET /fetch-transactions, which a live probe showed answering 401 rather than
// 404, i.e. present and only wanting the key.
//
// Matching reuses what the webhook proved in production: their reference WRAPS our
// orders.id — "875" + uuid + "0248781324" — so a uuid scan over every string in the
// row is the link. Nothing here assumes the wrapper's shape.
//
// Written to be safe when the response shape differs from expectations:
//   • no uuid found in a row            → row skipped
//   • uuid not one of ours              → no row matches, nothing happens
//   • status field absent/unrecognised  → NOT terminal, nothing happens
//   • order not currently 'processing'  → skipped
// The failure mode is doing nothing, never completing an undelivered order. Every run
// logs the row keys and the distinct status labels it saw, so anything unrecognised
// shows up rather than being silently dropped.

export const maxDuration = 60
const RUN_BUDGET_MS = 50_000

const BASE = process.env.DATAKAZINA_API_BASE_URL || 'https://reseller.dakazinabusinessconsult.com/api/v1'
const KEY = process.env.DATAKAZINA_API_KEY || ''

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi

// Keys a status might arrive under. First one holding a non-empty string wins.
const STATUS_KEYS = ['status', 'transaction_status', 'order_status', 'delivery_status', 'state', 'current_status']

const COMPLETED = ['completed', 'complete', 'delivered', 'success', 'successful', 'credited', 'fulfilled']
const FAILED = ['failed', 'failure', 'cancelled', 'canceled', 'refund', 'refunded', 'rejected', 'reversed', 'declined']

function scanForIds(value: any, depth = 0): string[] {
    if (depth > 3 || value === null || value === undefined) return []
    if (typeof value === 'string') return value.match(UUID_RE) || []
    if (Array.isArray(value)) return value.flatMap(v => scanForIds(v, depth + 1))
    if (typeof value === 'object') return Object.values(value).flatMap(v => scanForIds(v, depth + 1))
    return []
}

function findStatus(row: any): string | null {
    for (const k of STATUS_KEYS) {
        const v = row?.[k]
        if (typeof v === 'string' && v.trim() !== '') return v
    }
    return null
}

function mapStatus(raw: string): 'completed' | 'failed' | null {
    const s = normaliseSupplierStatus(raw)
    if (COMPLETED.includes(s)) return 'completed'
    if (FAILED.includes(s)) return 'failed'
    return null   // non-terminal or unknown — deliberately does nothing
}

// Finds the row array wherever it sits: root, data, data.data, data.transactions…
function locateRows(data: any): { rows: any[]; foundAt: string } {
    if (Array.isArray(data)) return { rows: data, foundAt: '(root)' }
    if (data && typeof data === 'object') {
        for (const k of Object.keys(data)) {
            if (Array.isArray(data[k])) return { rows: data[k], foundAt: k }
        }
        for (const k of Object.keys(data)) {
            const inner = data[k]
            if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
                for (const k2 of Object.keys(inner)) {
                    if (Array.isArray(inner[k2])) return { rows: inner[k2], foundAt: `${k}.${k2}` }
                }
            }
        }
    }
    return { rows: [], foundAt: 'none' }
}

export async function GET(request: NextRequest) {
    if (!areCronJobsEnabled()) return cronDisabledResponse()

    const authHeader = request.headers.get('authorization')
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    if (!KEY) {
        return NextResponse.json({ error: 'DATAKAZINA_API_KEY is not configured' }, { status: 503 })
    }

    const startedAt = Date.now()
    const outOfTime = () => Date.now() - startedAt > RUN_BUDGET_MS

    let rows: any[] = []
    let foundAt = 'none'

    try {
        const response = await fetch(`${BASE}/fetch-transactions`, {
            method: 'GET',
            headers: { 'Accept': 'application/json', 'x-api-key': KEY },
            signal: AbortSignal.timeout(25_000),
        })

        const rawText = await response.text()
        if (!response.ok) {
            console.error(`[DakazinaSync] HTTP ${response.status}: ${rawText.slice(0, 200)}`)
            return NextResponse.json({ success: false, httpStatus: response.status }, { status: 200 })
        }

        let data: any
        try {
            data = JSON.parse(rawText)
        } catch {
            console.error(`[DakazinaSync] Non-JSON response: ${rawText.slice(0, 200)}`)
            return NextResponse.json({ success: false, error: 'Non-JSON response' }, { status: 200 })
        }

        const located = locateRows(data)
        rows = located.rows
        foundAt = located.foundAt

    } catch (err: any) {
        console.error('[DakazinaSync] Fetch failed:', err?.message || err)
        return NextResponse.json({ success: false, error: 'Fetch failed' }, { status: 200 })
    }

    // The shape, every run. Cheap, and the only thing that makes an unexpected
    // response diagnosable rather than a silent "updated 0".
    console.log(
        `[DakazinaSync] rows=${rows.length} foundAt='${foundAt}' ` +
        `rowKeys=[${rows[0] && typeof rows[0] === 'object' ? Object.keys(rows[0]).join(',') : ''}]`
    )

    if (rows.length === 0) {
        return NextResponse.json({ success: true, rows: 0, updated: 0, foundAt }, { status: 200 })
    }

    const supabase = createServerClient()
    const seenLabels = new Set<string>()
    let considered = 0, matched = 0, updated = 0, skippedNoId = 0, skippedNonTerminal = 0
    const errors: string[] = []

    for (const row of rows) {
        if (outOfTime()) {
            errors.push('run budget exhausted — remaining rows deferred to next run')
            break
        }
        if (!row || typeof row !== 'object') continue
        considered++

        const rawStatus = findStatus(row)
        if (rawStatus) seenLabels.add(normaliseSupplierStatus(rawStatus))

        const target = rawStatus ? mapStatus(rawStatus) : null
        if (!target) { skippedNonTerminal++; continue }

        const ids = Array.from(new Set(scanForIds(row).map(v => v.toLowerCase())))
        if (ids.length === 0) { skippedNoId++; continue }

        try {
            const { data: found, error: lookupErr } = await (supabase
                .from('orders') as any)
                .select('id, status, shop_order_id')
                .in('id', ids)
                .eq('status', 'processing')   // only ever advance in-flight orders
                .limit(2)

            if (lookupErr) { errors.push(`lookup: ${lookupErr.message}`); continue }
            if (!found || found.length !== 1) continue   // 0 = not ours; >1 = ambiguous, refuse

            const order = found[0]
            matched++

            const { error: updErr } = await (supabase.from('orders') as any)
                .update({ status: target, supplier_status: null, updated_at: new Date().toISOString() })
                .eq('id', order.id)
                .eq('status', 'processing')   // row-level idempotency

            if (updErr) { errors.push(`update ${order.id}: ${updErr.message}`); continue }

            if (order.shop_order_id) {
                await (supabase.from('shop_orders') as any)
                    .update({ status: target, supplier_status: null, updated_at: new Date().toISOString() })
                    .eq('id', order.shop_order_id)
                    .eq('status', 'processing')
            }

            await syncShopOrderStatus(order.id, target).catch(err =>
                console.error(`[DakazinaSync] syncShopOrderStatus failed for ${order.id}:`, err)
            )

            updated++
            console.log(`[DakazinaSync] order ${order.id}: processing → ${target}${target === 'failed' ? ' (manual refund required)' : ''}`)

        } catch (err: any) {
            errors.push(`row exception: ${err?.message || err}`)
        }
    }

    // Distinct labels seen — an unrecognised one silently does nothing, so surfacing
    // it here is what stops a new wording stranding orders the way it has before.
    console.log(`[DakazinaSync] statusLabels=[${Array.from(seenLabels).join(',')}]`)

    return NextResponse.json({
        success: true,
        rows: rows.length,
        foundAt,
        considered,
        matched,
        updated,
        skippedNoId,
        skippedNonTerminal,
        statusLabels: Array.from(seenLabels),
        errors,
    }, { status: 200 })
}
