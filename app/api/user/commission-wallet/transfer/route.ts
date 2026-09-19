import { NextResponse } from 'next/server'
import { createRouteHandlerClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'

/**
 * POST /api/user/commission-wallet/transfer
 *
 * Moves commission earnings into the partner's main wallet, where they can be
 * spent on data, airtime and bills like any other balance. Instant, no fee.
 *
 * Money moves in two steps, the same shape the rest of this codebase uses (see
 * the refund path in app/api/orders/purchase/route.ts):
 *
 *   1. deduct_commission_wallet_balance — the balance guard lives in the UPDATE's
 *      WHERE clause, so two taps of Transfer cannot both pass it and overdraw.
 *   2. topup_wallet_balance — credits the main wallet and its total_credited.
 *
 * If step 2 fails, step 1 is reversed before returning, so a failed transfer
 * never leaves the money in neither wallet. The reversal does not go through
 * credit_commission_wallet_balance, because that function also adds to
 * total_earned — it is for earnings, and this money was earned once already.
 */
export async function POST(request: Request) {
    try {
        const supabaseUser = await createRouteHandlerClient()
        const { data: { user }, error: authError } = await supabaseUser.auth.getUser()
        if (authError || !user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const body = await request.json().catch(() => ({}))
        const raw = Number(body?.amount)

        if (!Number.isFinite(raw) || raw <= 0) {
            return NextResponse.json({ error: 'Enter an amount to transfer.' }, { status: 400 })
        }

        // Money is stored as NUMERIC(12,2); anything finer would be silently
        // rounded by the database and the two wallets would disagree.
        const amount = Math.round(raw * 100) / 100
        if (amount <= 0) {
            return NextResponse.json({ error: 'Enter an amount to transfer.' }, { status: 400 })
        }

        const supabase: any = createServerClient()

        const { data: mainWallet } = await supabase
            .from('wallets')
            .select('id')
            .eq('user_id', user.id)
            .maybeSingle()

        if (!mainWallet?.id) {
            return NextResponse.json(
                { error: 'Your main wallet is not set up yet. Open the Wallet page first.' },
                { status: 400 }
            )
        }

        // ── 1. Take it out of the commission wallet ──────────────────────────
        const { error: debitError } = await supabase.rpc('deduct_commission_wallet_balance', {
            p_user_id: user.id,
            p_amount: amount,
        })

        if (debitError) {
            const insufficient = String(debitError.message || '').includes('INSUFFICIENT_BALANCE')
            if (insufficient) {
                return NextResponse.json(
                    { error: 'That is more than your commission balance.' },
                    { status: 400 }
                )
            }
            console.error('[commission-transfer] debit failed:', debitError)
            return NextResponse.json({ error: 'Could not complete the transfer.' }, { status: 500 })
        }

        // ── 2. Put it into the main wallet ───────────────────────────────────
        const { data: newMainBalance, error: creditError } = await supabase.rpc('topup_wallet_balance', {
            p_user_id: user.id,
            p_amount: amount,
        })

        if (creditError || newMainBalance === null) {
            console.error('[commission-transfer] credit failed, reversing debit:', creditError)

            // Deducting a negative amount adds it back and un-does the
            // total_withdrawn bump in the same statement — atomic, and without
            // the read-then-write race a plain UPDATE would have here.
            const { error: reversalError } = await supabase.rpc('deduct_commission_wallet_balance', {
                p_user_id: user.id,
                p_amount: -amount,
            })

            if (reversalError) {
                // The partner is short by `amount` until someone puts it back.
                console.error(
                    `CRITICAL: commission transfer left GHS ${amount} in neither wallet for user ${user.id}`,
                    reversalError
                )
            }

            return NextResponse.json({ error: 'Could not complete the transfer.' }, { status: 500 })
        }

        // ── 3. Record it on the main wallet's statement ──────────────────────
        // `source` is constrained to payment/refund/admin/purchase, and money
        // arriving in the wallet is a payment. Non-fatal: the balances are
        // already correct, and a missing statement line must not read as a
        // failed transfer and invite a second attempt.
        const { error: txError } = await supabase.from('wallet_transactions').insert({
            wallet_id: mainWallet.id,
            user_id: user.id,
            type: 'credit',
            amount,
            description: 'Transfer from Commission Wallet',
            reference: `COMM-${Date.now()}`,
            source: 'payment',
            status: 'completed',
        })

        if (txError) {
            console.error('[commission-transfer] statement line failed:', txError)
        }

        const { data: commissionWallet } = await supabase
            .from('commission_wallets')
            .select('balance, total_earned, total_withdrawn')
            .eq('owner_id', user.id)
            .maybeSingle()

        return NextResponse.json({
            success: true,
            amount,
            wallet: {
                balance: Number(commissionWallet?.balance ?? 0),
                total_earned: Number(commissionWallet?.total_earned ?? 0),
                total_withdrawn: Number(commissionWallet?.total_withdrawn ?? 0),
                currency: 'GHS',
            },
            main_wallet_balance: Number(newMainBalance),
        })
    } catch (error) {
        console.error('[commission-transfer] unexpected error:', error)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
