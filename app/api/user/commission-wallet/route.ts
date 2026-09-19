import { NextResponse } from 'next/server'
import { createRouteHandlerClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { commissionSharePercent } from '@/lib/commission-earning'
import { commissionWithdrawalSettings } from '@/lib/commission-withdrawal'

/**
 * Commission wallet for the dashboard.
 *
 * /api/v2/commission/balance answers the same question but authenticates with a
 * Commission Services key, which the browser does not have — the key is shown once
 * and never stored. This is the session-authenticated twin.
 */
export async function GET() {
    try {
        const supabaseUser = await createRouteHandlerClient()
        const { data: { user }, error } = await supabaseUser.auth.getUser()
        if (error || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

        const supabase = createServerClient()

        const { data: wallet } = await (supabase.from('commission_wallets') as any)
            .select('balance, total_earned, total_withdrawn')
            .eq('owner_id', user.id)
            .maybeSingle()

        const [{ data: recent }, { data: withdrawals }, sharePercent, withdrawalSettings] = await Promise.all([
            (supabase.from('commission_transactions') as any)
                .select('id, source, amount, description, reference, created_at')
                .eq('user_id', user.id)
                .order('created_at', { ascending: false })
                .limit(20),
            (supabase.from('commission_withdrawals') as any)
                .select('id, amount, fee, net_amount, status, network, momo_number, account_number, account_name, admin_note, created_at, processed_at')
                .eq('user_id', user.id)
                .order('created_at', { ascending: false })
                .limit(20),
            // The same figure lib/commission-earning pays out with, so the page can
            // never state a rate the credit does not use.
            commissionSharePercent(supabase),
            commissionWithdrawalSettings(supabase),
        ])

        // No row until the first earning — report zero rather than 404.
        return NextResponse.json({
            success: true,
            wallet: {
                balance:         Number((wallet as any)?.balance ?? 0),
                total_earned:    Number((wallet as any)?.total_earned ?? 0),
                total_withdrawn: Number((wallet as any)?.total_withdrawn ?? 0),
                currency:        'GHS',
            },
            share_percent: sharePercent,
            withdrawals: (withdrawals as any[]) || [],
            withdrawal: {
                min_amount:  withdrawalSettings.minAmount,
                fee_percent: withdrawalSettings.feePercent,
                fee_flat:    withdrawalSettings.feeFlat,
                // One at a time: the request route refuses a second while one is open,
                // so the page disables the form rather than letting it fail on submit.
                has_open_request: ((withdrawals as any[]) || [])
                    .some(w => ['pending', 'moolre_pending'].includes(w.status)),
            },
            transactions: (recent as any[]) || [],
        })
    } catch {
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
