import { NextRequest, NextResponse } from 'next/server'
import { createRouteHandlerClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { z } from 'zod'
import { initiateTransfer, MOOLRE_CHANNEL_MAP } from '@/lib/moolre-transfer-service'
import { sendShopWithdrawalProcessedSMS, sendShopWithdrawalRejectedSMS } from '@/lib/sms-service'

/**
 * The admin queue for Commission Wallet payouts.
 *
 * Deliberately the same shape as /api/admin/process-withdrawal: 'manual' means the admin
 * paid by hand and is recording it, 'moolre' sends the transfer through Moolre, and
 * 'reject' refunds the partner. Each action claims the row with a conditional UPDATE
 * first, so two admins clicking at once cannot both pay.
 */
const actionSchema = z.object({
    withdrawalId: z.string().uuid('Invalid withdrawal id'),
    action: z.enum(['manual', 'moolre', 'reject']),
    adminNote: z.string().max(500).trim().optional(),
})

async function requireAdmin() {
    const supabaseUser = await createRouteHandlerClient()
    const { data: { user }, error } = await supabaseUser.auth.getUser()
    if (error || !user) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }

    const { data: dbUser } = await supabaseUser
        .from('users').select('role').eq('id', user.id).single()

    if (!dbUser || !['admin', 'sub-admin'].includes((dbUser as any).role)) {
        return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }
    }
    return { user }
}

export async function GET(request: NextRequest) {
    const auth = await requireAdmin()
    if ('error' in auth) return auth.error

    const status = new URL(request.url).searchParams.get('status')
    const db = createServerClient() as any

    let query = db
        .from('commission_withdrawals')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(100)

    if (status && status !== 'all') query = query.eq('status', status)

    const { data: rows, error } = await query
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    // Names for the queue. A join would need an FK PostgREST can follow from this table
    // to users; one keyed lookup is simpler than adding a relationship for a label.
    const ids = [...new Set((rows as any[]).map(r => r.user_id))]
    const { data: users } = ids.length
        ? await db.from('users').select('id, first_name, last_name, phone_number, email').in('id', ids)
        : { data: [] }

    const byId = new Map((users as any[] || []).map(u => [u.id, u]))

    return NextResponse.json({
        success: true,
        withdrawals: (rows as any[]).map(r => ({ ...r, partner: byId.get(r.user_id) ?? null })),
    })
}

export async function POST(request: NextRequest) {
    const auth = await requireAdmin()
    if ('error' in auth) return auth.error

    let body: any
    try { body = await request.json() } catch {
        return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
    }

    const parsed = actionSchema.safeParse(body)
    if (!parsed.success) {
        return NextResponse.json(
            { error: 'Invalid input', details: parsed.error.errors.map(e => e.message) },
            { status: 400 }
        )
    }

    const { withdrawalId, action, adminNote } = parsed.data
    const db = createServerClient() as any

    const { data: row, error: fetchError } = await db
        .from('commission_withdrawals').select('*').eq('id', withdrawalId).single()

    if (fetchError || !row) return NextResponse.json({ error: 'Withdrawal not found' }, { status: 404 })

    const { data: partner } = await db
        .from('users').select('first_name, phone_number').eq('id', row.user_id).maybeSingle()

    const firstName = partner?.first_name || 'Partner'
    const phone = partner?.phone_number || ''
    const payTo = row.momo_number || row.account_number || ''

    // ── Reject: refund and close ──
    if (action === 'reject') {
        const { data: claimed, error: claimError } = await db
            .from('commission_withdrawals')
            .update({
                status: 'rejected',
                admin_note: adminNote || null,
                processed_at: new Date().toISOString(),
                processed_by: auth.user.id,
                updated_at: new Date().toISOString(),
            })
            .eq('id', withdrawalId)
            .eq('status', 'pending')
            .select()

        if (claimError) return NextResponse.json({ error: claimError.message }, { status: 500 })
        if (!claimed?.length) {
            return NextResponse.json({ error: 'Only a pending withdrawal can be rejected.' }, { status: 400 })
        }

        // Refund the gross amount — the fee was never taken, it was only deducted from
        // what we would have paid out.
        const { error: refundError } = await db
            .rpc('refund_commission_withdrawal', { p_user_id: row.user_id, p_amount: row.amount })

        if (refundError) {
            // Leave it rejected and shout: the partner is short until someone corrects it,
            // and silently flipping the row back would hide that.
            console.error('[CommissionWithdrawals] REFUND FAILED', withdrawalId, refundError.message)
            return NextResponse.json({
                error: 'Marked rejected but the refund failed. Credit the partner manually.',
            }, { status: 500 })
        }

        if (phone) sendShopWithdrawalRejectedSMS(phone, firstName).catch(() => {})
        return NextResponse.json({ success: true, status: 'rejected' })
    }

    // ── Manual: the admin already paid ──
    if (action === 'manual') {
        const { data: claimed, error: claimError } = await db
            .from('commission_withdrawals')
            .update({
                status: 'completed',
                admin_note: adminNote || null,
                processed_at: new Date().toISOString(),
                processed_by: auth.user.id,
                updated_at: new Date().toISOString(),
            })
            .eq('id', withdrawalId)
            .in('status', ['pending', 'moolre_pending'])
            .select()

        if (claimError) return NextResponse.json({ error: claimError.message }, { status: 500 })
        if (!claimed?.length) {
            return NextResponse.json({ error: 'This withdrawal is already completed or rejected.' }, { status: 400 })
        }

        if (phone) {
            sendShopWithdrawalProcessedSMS(phone, firstName, Number(row.net_amount), row.network || 'MoMo', payTo)
                .catch(() => {})
        }
        return NextResponse.json({ success: true, status: 'completed', method: 'manual' })
    }

    // ── Moolre: send the transfer ──
    const channel = MOOLRE_CHANNEL_MAP[row.network || '']
    if (channel === undefined) {
        return NextResponse.json(
            { error: `No Moolre channel for network "${row.network}". Pay manually instead.` },
            { status: 400 }
        )
    }

    // Locked BEFORE the API call: if the transfer succeeds and our write then fails, the
    // row is already in moolre_pending and the sync cron finishes it. The reverse order
    // could pay twice.
    const { data: locked, error: lockError } = await db
        .from('commission_withdrawals')
        .update({ status: 'moolre_pending', updated_at: new Date().toISOString() })
        .eq('id', withdrawalId)
        .eq('status', 'pending')
        .select()

    if (lockError) return NextResponse.json({ error: lockError.message }, { status: 500 })
    if (!locked?.length) {
        return NextResponse.json({ error: 'This withdrawal is already being processed.' }, { status: 400 })
    }

    const transfer = await initiateTransfer({
        amount: Number(row.net_amount),
        receiver: payTo,
        channel,
        shopName: `Commission payout — ${firstName}`,
        transactionId: withdrawalId,
        bankId: row.bank_id ?? undefined,
    })

    const unlock = async () => {
        await db.from('commission_withdrawals')
            .update({ status: 'pending', updated_at: new Date().toISOString() })
            .eq('id', withdrawalId)
    }

    if (!transfer.success && transfer.txstatus === null) {
        await unlock()
        return NextResponse.json(
            { error: `Moolre error: ${transfer.error || 'unknown'}. Reverted to pending.` },
            { status: 502 }
        )
    }

    if (transfer.txstatus === 2) {
        await unlock()
        return NextResponse.json(
            { error: 'Moolre rejected the transfer. Reverted to pending — try again or pay manually.' },
            { status: 400 }
        )
    }

    const patch: Record<string, any> = {
        moolre_transaction_id: transfer.transactionid,
        moolre_external_ref:   withdrawalId,
        moolre_status:         transfer.txstatus,
        admin_note:            adminNote || null,
        processed_by:          auth.user.id,
        updated_at:            new Date().toISOString(),
    }

    if (transfer.txstatus === 1) {
        patch.status = 'completed'
        patch.processed_at = new Date().toISOString()
    }

    const { error: patchError } = await db
        .from('commission_withdrawals').update(patch).eq('id', withdrawalId)

    if (patchError) {
        console.error('[CommissionWithdrawals] post-transfer write failed', withdrawalId, patchError.message)
        return NextResponse.json({
            error: 'Transfer submitted but the database write failed. The sync cron will resolve it.',
        }, { status: 500 })
    }

    if (transfer.txstatus === 1 && phone) {
        sendShopWithdrawalProcessedSMS(phone, firstName, Number(row.net_amount), row.network || 'MoMo', payTo)
            .catch(() => {})
    }

    return NextResponse.json({
        success: true,
        status: transfer.txstatus === 1 ? 'completed' : 'moolre_pending',
        method: 'moolre',
        moolreTransactionId: transfer.transactionid,
    })
}
