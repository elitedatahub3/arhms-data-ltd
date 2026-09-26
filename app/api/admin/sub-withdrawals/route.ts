import { NextRequest, NextResponse } from 'next/server'
import { createRouteHandlerClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { z } from 'zod'

/**
 * POST /api/admin/sub-withdrawals
 * Admin acts on a sub withdrawal still parked in 'shop_owner_pending'.
 *
 * A sub's request is created at status='shop_owner_pending' and only reaches the
 * admin payout queue once a Lead approves it or the 48h escalation cron forwards
 * it. Neither happens in practice: no screen calls
 * /api/shop/sub-withdrawals/{approve,reject}, and escalate-sub-withdrawals was
 * never registered on cron-job.org. The sub is debited at request time, so those
 * rows sit with the money already out of the wallet and no way to finish or undo.
 *
 * This gives the admin queue the two moves the Lead never made:
 *   release → status 'pending'  (enters the normal payout queue; pay as usual)
 *   refund  → status 'rejected' + balance credited back to the sub
 *
 * It deliberately does NOT reuse approve_sub_withdrawal() / reject_sub_withdrawal():
 * both hard-require the caller to BE the upline Lead, so an admin is refused.
 */

const actionSchema = z.object({
    transactionId: z.string().uuid('Invalid transaction ID'),
    action: z.enum(['release', 'refund']),
    adminNote: z.string().max(500).trim().optional(),
})

export async function POST(req: NextRequest) {
    try {
        // 1. Auth — verified server-side, never trusting a client-supplied role
        const supabase = await createRouteHandlerClient()
        const { data: { user } } = await supabase.auth.getUser()
        if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

        // The typed client infers a multi-column select on users as `never` — the
        // same generics problem next.config calls out in its ignoreBuildErrors note —
        // so the row shape is named here rather than left to inference.
        const { data: dbUser } = await supabase
            .from('users')
            .select('role, first_name, last_name')
            .eq('id', user.id)
            .single<{ role: string; first_name: string | null; last_name: string | null }>()

        // Same set the admin_all_shop_transactions RLS policy already grants FOR
        // ALL on this table, so this route hands out no access they lack today.
        const adminRoles = ['admin', 'subadmin', 'sub-admin']
        if (!dbUser || !adminRoles.includes(dbUser.role)) {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
        }

        // 2. Validate payload
        const body = await req.json()
        const parsed = actionSchema.safeParse(body)
        if (!parsed.success) {
            return NextResponse.json(
                { error: 'Invalid input', details: parsed.error.errors.map(e => e.message) },
                { status: 400 }
            )
        }

        const { transactionId, action, adminNote } = parsed.data
        const db = createServerClient() as any

        const adminName = [dbUser.first_name, dbUser.last_name].filter(Boolean).join(' ') || 'admin'
        const note = adminNote
            ? `${adminNote} — by ${adminName} (admin, on behalf of Lead)`
            : `Actioned by ${adminName} (admin, on behalf of Lead)`

        // 3. Load the row and confirm it really is a sub request in the Lead stage
        const { data: tx, error: fetchError } = await db
            .from('shop_wallet_transactions')
            .select('id, type, status, amount, wallet:shop_wallets!inner(owner_id)')
            .eq('id', transactionId)
            .single()

        if (fetchError || !tx) {
            return NextResponse.json({ error: 'Transaction not found' }, { status: 404 })
        }
        if (tx.type !== 'withdrawal') {
            return NextResponse.json({ error: 'Not a withdrawal' }, { status: 400 })
        }
        if (tx.status !== 'shop_owner_pending') {
            return NextResponse.json(
                { error: `Already actioned — this request is now "${tx.status}".` },
                { status: 400 }
            )
        }

        const subUserId = tx.wallet.owner_id

        // ─── RELEASE: hand it to the normal admin payout queue ───────────────────
        if (action === 'release') {
            // Re-asserting the status makes this the atomic claim: a double click,
            // a second admin, or the escalation cron firing in the same instant all
            // lose the race instead of both writes landing.
            const { data: released, error: releaseError } = await db
                .from('shop_wallet_transactions')
                .update({
                    status: 'pending',
                    sub_approval_status: 'approved',
                    sub_approved_by: user.id,
                    sub_approval_note: note,
                    updated_at: new Date().toISOString(),
                })
                .eq('id', transactionId)
                .eq('status', 'shop_owner_pending')
                .select('id')

            if (releaseError) throw releaseError
            if (!released?.length) {
                return NextResponse.json(
                    { error: 'Already actioned by someone else.' },
                    { status: 409 }
                )
            }

            return NextResponse.json({
                success: true,
                status: 'pending',
                message: 'Released to the payout queue. Pay it like any other request.',
            })
        }

        // ─── REFUND: decline and put the money back in the sub's wallet ──────────
        // Claim the row BEFORE crediting. Crediting first (as reject_sub_withdrawal
        // does) means two concurrent calls can both credit before either writes the
        // status, refunding the sub twice.
        const { data: claimed, error: claimError } = await db
            .from('shop_wallet_transactions')
            .update({
                status: 'rejected',
                sub_approval_status: 'rejected',
                sub_approved_by: user.id,
                sub_approval_note: note,
                updated_at: new Date().toISOString(),
            })
            .eq('id', transactionId)
            .eq('status', 'shop_owner_pending')
            .select('id')

        if (claimError) throw claimError
        if (!claimed?.length) {
            return NextResponse.json(
                { error: 'Already actioned by someone else.' },
                { status: 409 }
            )
        }

        // credit_shop_wallet_balance also backs the amount out of total_withdrawn,
        // which a bare balance UPDATE would leave permanently inflated.
        const { error: creditError } = await db.rpc('credit_shop_wallet_balance', {
            p_user_id: subUserId,
            p_amount: tx.amount,
        })

        if (creditError) {
            // Put it back so the refund stays retryable rather than stranding the
            // sub with a rejected request and no money returned.
            await db
                .from('shop_wallet_transactions')
                .update({
                    status: 'shop_owner_pending',
                    sub_approval_status: 'pending',
                    sub_approved_by: null,
                    sub_approval_note: null,
                    updated_at: new Date().toISOString(),
                })
                .eq('id', transactionId)

            console.error('[admin/sub-withdrawals] Refund credit failed:', creditError)
            return NextResponse.json(
                { error: 'Could not credit the wallet — nothing was changed. Try again.' },
                { status: 500 }
            )
        }

        return NextResponse.json({
            success: true,
            status: 'rejected',
            message: 'Request declined and the amount returned to the sub-agent wallet.',
        })
    } catch (error: any) {
        console.error('[admin/sub-withdrawals]', error)
        return NextResponse.json(
            { error: error.message || 'Internal server error' },
            { status: 500 }
        )
    }
}
