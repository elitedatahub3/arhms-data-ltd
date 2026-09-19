import { NextRequest, NextResponse } from 'next/server'
import { createRouteHandlerClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { z } from 'zod'
import { phoneSchema } from '@/lib/validation'
import { getBanks } from '@/lib/moolre-transfer-service'
import { sendAdminCommissionWithdrawalAlert } from '@/lib/email-service'
import { commissionWithdrawalSettings } from '@/lib/commission-withdrawal'

/**
 * A partner asks to be paid out from their Commission Wallet.
 *
 * Mirrors the shop flow (app/api/shop/withdraw): the balance is debited HERE, at
 * request time, not at approval. Two requests worth more than the balance is the
 * failure mode that matters, and deduct_commission_wallet_balance settles it inside one
 * UPDATE. A rejection later refunds it.
 */
const withdrawSchema = z.object({
    amount: z.union([
        z.number().positive(),
        z.string().regex(/^\d+(\.\d{1,2})?$/).transform(Number),
    ]),
    accountNumber: z.string().min(8, 'Number is too short').max(30, 'Number is too long')
        .regex(/^\d+$/, 'Must contain only digits'),
    network: z.enum(['MTN MoMo', 'Telecel Cash', 'AirtelTigo Money', 'Bank']),
    payment_type: z.enum(['momo', 'bank']).default('momo'),
    bankId: z.string().regex(/^[A-Za-z0-9_-]+$/, 'Invalid bank ID format').optional(),
    branch: z.string().max(100).optional(),
    accountName: z.string().min(2, 'Account name is required').max(120),
}).superRefine((data, ctx) => {
    if (data.network !== 'Bank' && !phoneSchema.safeParse(data.accountNumber).success) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['accountNumber'],
            message: 'Must be a valid Ghanaian MoMo number (e.g. 0241234567)',
        })
    }
    if (data.payment_type === 'bank' && !data.bankId) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['bankId'], message: 'Choose your bank' })
    }
})

export async function POST(req: NextRequest) {
    try {
        const supabaseUser = await createRouteHandlerClient()
        const { data: { user }, error: authError } = await supabaseUser.auth.getUser()
        if (authError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

        let body: any
        try { body = await req.json() } catch {
            return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
        }

        const parsed = withdrawSchema.safeParse(body)
        if (!parsed.success) {
            return NextResponse.json({
                error: 'Invalid input',
                details: parsed.error.errors.map(e => `${e.path.join('.')}: ${e.message}`),
            }, { status: 400 })
        }

        const amount = Number(parsed.data.amount)
        const accountNumber = parsed.data.accountNumber.trim()
        const network = parsed.data.network
        const paymentType = parsed.data.payment_type
        const accountName = parsed.data.accountName.trim()
        const bankId = parsed.data.bankId?.trim()
        const branch = parsed.data.branch?.trim()

        const db = createServerClient() as any

        const [{ data: wallet }, settings] = await Promise.all([
            db.from('commission_wallets').select('id, balance').eq('owner_id', user.id).maybeSingle(),
            commissionWithdrawalSettings(db),
        ])

        if (!wallet) {
            return NextResponse.json({ error: 'You have no commission earnings yet.' }, { status: 400 })
        }

        if (amount < settings.minAmount) {
            return NextResponse.json(
                { error: `Minimum withdrawal is GHS ${settings.minAmount.toFixed(2)}` },
                { status: 400 }
            )
        }
        if (amount > Number(wallet.balance)) {
            return NextResponse.json({ error: 'Insufficient commission balance' }, { status: 400 })
        }

        // One pending request at a time. The balance guard alone would allow a partner to
        // split their balance across several requests, which buries the admin queue and
        // makes a rejection refund ambiguous to read on the page.
        const { count: openCount } = await db
            .from('commission_withdrawals')
            .select('id', { count: 'exact', head: true })
            .eq('user_id', user.id)
            .in('status', ['pending', 'moolre_pending'])

        if ((openCount ?? 0) > 0) {
            return NextResponse.json(
                { error: 'You already have a withdrawal awaiting approval. Wait for it to be processed.' },
                { status: 409 }
            )
        }

        const fee = Math.round((amount * settings.feePercent / 100 + settings.feeFlat) * 100) / 100
        const netAmount = Math.round((amount - fee) * 100) / 100
        if (netAmount <= 0) {
            return NextResponse.json({ error: 'The fee would leave nothing to pay out.' }, { status: 400 })
        }

        // Resolved server-side from Moolre's list — never taken from the client.
        let bankName: string | null = null
        if (paymentType === 'bank' && bankId) {
            try {
                const banks = await getBanks()
                bankName = banks.find(b => b.id === bankId)?.name ?? null
            } catch { /* non-blocking: the admin still sees the id */ }
        }

        const { data: deducted, error: deductError } = await db
            .rpc('deduct_commission_wallet_balance', { p_user_id: user.id, p_amount: amount })

        if (deductError) {
            if (String(deductError.message).includes('INSUFFICIENT_BALANCE')) {
                return NextResponse.json({ error: 'Insufficient commission balance' }, { status: 400 })
            }
            throw deductError
        }

        const newBalance = deducted?.[0]?.new_balance ?? deducted?.new_balance ?? null

        const { data: row, error: insertError } = await db
            .from('commission_withdrawals')
            .insert({
                wallet_id:        wallet.id,
                user_id:          user.id,
                amount,
                fee,
                net_amount:       netAmount,
                payment_type:     paymentType,
                network,
                momo_number:      paymentType === 'momo' ? accountNumber : null,
                account_number:   paymentType === 'bank' ? accountNumber : null,
                account_name:     accountName,
                bank_id:          bankId ?? null,
                bank_name:        bankName,
                branch:           branch ?? null,
                status:           'pending',
                balance_snapshot: newBalance,
            })
            .select('id, amount, net_amount, status, created_at')
            .single()

        if (insertError) {
            // Put the money back: the debit already succeeded, so failing here without
            // this would take the balance and leave no request behind to approve.
            await db.rpc('refund_commission_withdrawal', { p_user_id: user.id, p_amount: amount })
                .catch(() => console.error('[CommissionWithdraw] REFUND FAILED after insert error', user.id, amount))
            throw insertError
        }

        const { data: profile } = await db
            .from('users').select('first_name, last_name, phone_number').eq('id', user.id).maybeSingle()

        sendAdminCommissionWithdrawalAlert({
            partnerName: [profile?.first_name, profile?.last_name].filter(Boolean).join(' ') || 'Partner',
            partnerPhone: profile?.phone_number || '',
            amount,
            netAmount,
            accountName,
            accountNumber,
            network,
            requestedAt: new Date().toLocaleString('en-GB'),
        }).catch(err => console.warn('[CommissionWithdraw] admin alert failed:', err?.message || err))

        return NextResponse.json({ success: true, withdrawal: row, newBalance })
    } catch (error: any) {
        console.error('[CommissionWithdraw]', error)
        return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 })
    }
}
