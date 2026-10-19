import { NextResponse } from 'next/server'
import {
    loadSmsContext,
    smsBlockReason,
    isCustomerSmsEnabled,
    startSmsPurchase,
    withPortal,
    submitSmsPurchaseOtp,
    SMS_DISABLED_MESSAGE,
} from '@/lib/sms/sms-purchase'
import { activateSmsAccountFree } from '@/lib/payments'

/**
 * The one-time Customer SMS unlock.
 *
 * Mobile money only: a pending wallet_payments row is left here and settled by
 * the gateway's webhook through processCompletedSmsUnlock, which is what flips
 * the account from 'locked' to 'active'. Nothing is unlocked in this route.
 */
export async function POST(request: Request) {
    try {
        const ctx = await loadSmsContext()
        if ('error' in ctx) return NextResponse.json({ error: ctx.error }, { status: ctx.status })

        const { authUser, supabaseAdmin, account, shop, sub, settingsMap, unlockPrice } = ctx

        // 503, not 400: nothing is wrong with the request or the caller — the
        // service is switched off, and it may well be back.
        if (!isCustomerSmsEnabled(settingsMap)) {
            return NextResponse.json({ error: SMS_DISABLED_MESSAGE }, { status: 503 })
        }

        const body: any = await request.json().catch(() => ({}))
        const { phone, network, paymentMethod, otp, reference: submittedReference } = body

        // Handled before anything is minted: this finishes a charge that already
        // exists rather than starting a new one.
        if (otp) {
            return submitSmsPurchaseOtp({
                supabaseAdmin,
                userId: authUser.id,
                reference: String(submittedReference || ''),
                otp: String(otp),
            })
        }

        const blockedReason = smsBlockReason(shop, sub, ctx.userStatus)
        if (blockedReason) {
            // A sub blocked on membership is a 403 (they may not trade at all);
            // a missing or unapproved shop is a 400 (fix the shop and come back).
            const status = sub.isSub && shop && shop.approval_status === 'approved' ? 403 : 400
            return NextResponse.json({ error: blockedReason }, { status })
        }

        if (account.status === 'active') {
            return NextResponse.json({ error: 'Customer SMS is already unlocked on your account' }, { status: 400 })
        }
        if (account.status === 'suspended') {
            return NextResponse.json(
                { error: 'Your Customer SMS access is suspended. Please contact support.' },
                { status: 403 }
            )
        }

        // Fee waived by the admin: activate without a payment. Must come before
        // startSmsPurchase, which refuses a zero amount.
        if (ctx.freeActivation) {
            const result = await activateSmsAccountFree({
                accountId: account.id,
                userId: authUser.id,
                portal: withPortal(ctx, body.portal).portal,
            })
            if (!result.success) {
                return NextResponse.json({ error: result.error || 'Could not activate Customer SMS' }, { status: 500 })
            }
            return NextResponse.json({ success: true, free: true })
        }

        return startSmsPurchase({
            ctx: withPortal(ctx, body.portal),
            kind: 'sms_unlock',
            amount: unlockPrice,
            phone: String(phone || ''),
            network: String(network || ''),
            paymentMethod: String(paymentMethod || ''),
            description: 'ARHMS Customer SMS Activation',
        })
    } catch (error: any) {
        console.error('[SmsUnlock] Error:', error)
        return NextResponse.json({ error: error.message || 'Failed to start the unlock' }, { status: 500 })
    }
}
