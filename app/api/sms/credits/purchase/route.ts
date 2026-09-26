import { NextResponse } from 'next/server'
import {
    loadSmsContext,
    isCustomerSmsEnabled,
    startSmsPurchase,
    submitSmsPurchaseOtp,
    SMS_DISABLED_MESSAGE,
} from '@/lib/sms/sms-purchase'

/**
 * Buys a credit bundle.
 *
 * Credits are added by processCompletedSmsCreditPurchase once the gateway
 * confirms, never here. The sms_credit_purchases row this writes is what that
 * handler latches onto for idempotency, so it has to exist before the charge.
 */
export async function POST(request: Request) {
    try {
        const ctx = await loadSmsContext()
        if ('error' in ctx) return NextResponse.json({ error: ctx.error }, { status: ctx.status })

        const { authUser, supabaseAdmin, account, settingsMap } = ctx

        if (!isCustomerSmsEnabled(settingsMap)) {
            return NextResponse.json({ error: SMS_DISABLED_MESSAGE }, { status: 503 })
        }

        const body: any = await request.json().catch(() => ({}))
        const { bundleId, phone, network, otp, reference: submittedReference } = body

        if (otp) {
            return submitSmsPurchaseOtp({
                supabaseAdmin,
                userId: authUser.id,
                reference: String(submittedReference || ''),
                otp: String(otp),
            })
        }

        if (account.status !== 'active') {
            return NextResponse.json(
                { error: 'Unlock Customer SMS before buying credits' },
                { status: 403 }
            )
        }

        if (!bundleId) {
            return NextResponse.json({ error: 'Choose a credit bundle' }, { status: 400 })
        }

        // Price and credit count are read from the table, never taken from the
        // request: a client that could name its own amount could buy 5,000
        // credits for a pesewa.
        const { data: bundle } = await supabaseAdmin
            .from('sms_credit_bundles')
            .select('id, name, credits, price, is_active')
            .eq('id', bundleId)
            .maybeSingle()

        if (!bundle || !(bundle as any).is_active) {
            return NextResponse.json({ error: 'That bundle is no longer available' }, { status: 400 })
        }

        const credits = Number((bundle as any).credits)
        const amount = Number((bundle as any).price)

        return startSmsPurchase({
            ctx,
            kind: 'sms_credits',
            amount,
            phone: String(phone || ''),
            network: String(network || ''),
            extraMetadata: { bundle_id: (bundle as any).id, credits },
            description: 'ARHMS SMS Credits',
            beforeCharge: async (reference) => {
                const { error } = await (supabaseAdmin.from('sms_credit_purchases') as any).insert({
                    account_id: account.id,
                    bundle_id: (bundle as any).id,
                    credits,
                    amount,
                    reference,
                    status: 'pending',
                })
                if (error) {
                    console.error('[SmsCreditsPurchase] ledger insert failed:', error)
                    return { ok: false, error: 'Could not record the purchase' }
                }
                return { ok: true }
            },
        })
    } catch (error: any) {
        console.error('[SmsCreditsPurchase] Error:', error)
        return NextResponse.json({ error: error.message || 'Failed to start the purchase' }, { status: 500 })
    }
}
