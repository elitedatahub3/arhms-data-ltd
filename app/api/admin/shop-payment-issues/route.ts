import { NextRequest, NextResponse } from 'next/server'
import { createRouteHandlerClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { reconcileShopPayment } from '@/lib/shop-payment-reconcile'

/**
 * Storefront payments that were PAID but did not become an order.
 *
 * Reads the ledger (shop_payment_meta.status = 'needs_attention'): rows the
 * settlement path refused after retries, or at once for a reason retrying cannot
 * fix such as an amount mismatch. Also reports how many payments are still pending
 * past the point the cron should have settled them, as an early warning that the
 * cron is not running.
 *
 *   GET                                   list
 *   POST { reference, action: 'retry' }   ask the gateway again and settle
 *   POST { reference, action: 'resolve', note }  a human dealt with it (refund / manual delivery)
 */

async function requireAdmin() {
    const supabase = await createRouteHandlerClient()
    const { data: { user: authUser }, error: authError } = await supabase.auth.getUser()
    if (authError || !authUser) {
        return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
    }

    const { data: userData } = await supabase
        .from('users')
        .select('role')
        .eq('id', authUser.id)
        .single()

    if ((userData as any)?.role !== 'admin') {
        return { error: NextResponse.json({ error: 'Forbidden - Admin only' }, { status: 403 }) }
    }
    return { userId: authUser.id }
}

/** Pending this long means the cron should have answered by now. */
const STALE_PENDING_MINUTES = 90

export async function GET() {
    const auth = await requireAdmin()
    if (auth.error) return auth.error

    const db = createServerClient() as any
    const { data, error } = await db
        .from('shop_payment_meta')
        .select('reference, provider, slug, attempts, last_error, created_at, last_checked_at, metadata')
        .eq('status', 'needs_attention')
        .order('created_at', { ascending: false })
        .limit(100)

    if (error) {
        // Before migration 20261013000000 the column does not exist.
        const notMigrated = ['42703', 'PGRST204', '42P01', 'PGRST205'].includes(String(error.code))
        return NextResponse.json({
            success: true,
            migrated: !notMigrated,
            issues: [],
            stalePending: 0,
            error: notMigrated ? undefined : error.message,
        })
    }

    const { count: stalePending } = await db
        .from('shop_payment_meta')
        .select('reference', { count: 'exact', head: true })
        .eq('status', 'pending')
        .lt('created_at', new Date(Date.now() - STALE_PENDING_MINUTES * 60 * 1000).toISOString())

    const issues = (data || []).map((row: any) => ({
        reference: row.reference,
        provider: row.provider,
        slug: row.slug,
        attempts: row.attempts,
        lastError: row.last_error,
        createdAt: row.created_at,
        lastCheckedAt: row.last_checked_at,
        shopName: row.metadata?.shop_name ?? null,
        guestPhone: row.metadata?.guest_phone ?? null,
        payerPhone: row.metadata?.payer_phone ?? null,
        item: row.metadata?.package_size
            ? `${row.metadata.network ?? ''} ${row.metadata.package_size}`.trim()
            : row.metadata?.airtime_amount
                ? `${row.metadata.network ?? ''} GHS ${row.metadata.airtime_amount} airtime`.trim()
                : null,
        price: row.metadata?.selling_price ?? row.metadata?.airtime_amount ?? null,
    }))

    return NextResponse.json({ success: true, migrated: true, issues, stalePending: stalePending ?? 0 })
}

export async function POST(request: NextRequest) {
    const auth = await requireAdmin()
    if (auth.error) return auth.error

    const body = await request.json().catch(() => ({}))
    const reference = String(body?.reference || '')
    const action = String(body?.action || '')
    if (!reference.startsWith('SHOP-') || reference.length > 50) {
        return NextResponse.json({ error: 'Invalid reference' }, { status: 400 })
    }

    const db = createServerClient() as any
    const { data: row } = await db
        .from('shop_payment_meta')
        .select('reference, provider, created_at, metadata, status')
        .eq('reference', reference)
        .maybeSingle()
    if (!row) return NextResponse.json({ error: 'Payment not found in the ledger' }, { status: 404 })

    if (action === 'resolve') {
        const note = String(body?.note || 'Resolved manually by admin').slice(0, 300)
        await db
            .from('shop_payment_meta')
            .update({ status: 'failed', last_error: `[resolved by admin ${auth.userId}] ${note}` })
            .eq('reference', reference)
        return NextResponse.json({ success: true, outcome: 'resolved' })
    }

    if (action === 'retry') {
        // Never fails or expires a payment from here: an admin retry can only settle.
        const result = await reconcileShopPayment(row, {
            failureCutoffMs: Number.POSITIVE_INFINITY,
            abandonAfterMs: Number.POSITIVE_INFINITY,
        })
        return NextResponse.json({ success: result.outcome === 'settled' || result.outcome === 'already_settled', ...result })
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
}
