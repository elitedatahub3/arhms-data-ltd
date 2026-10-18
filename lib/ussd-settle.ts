/**
 * Settles a paid USSD order by type.
 *
 * The Paystack webhook and the reconciliation sweep both settle USSD payments and used
 * to carry the same two-way ternary (data or result checker). A third product made that
 * a place to forget a branch, so both call this instead. Every fulfiller is idempotent
 * on the reference, so the two may race.
 */
import type { UssdOrderType } from '@/lib/ussd-reference'

export async function fulfillUssdSession(params: {
    orderType: UssdOrderType
    sessionId: string
    referenceCode: string
    amountPaid: number
    deferredWork: Array<() => Promise<void>>
}): Promise<{ success: boolean; error?: string }> {
    const { orderType, ...rest } = params

    if (orderType === 'data') {
        return (await import('@/lib/ussd-data-fulfillment')).fulfillUSSDDataBySession(rest)
    }
    if (orderType === 'util') {
        // A utility bill is recorded as a wallet_payments row, not in the session, and the
        // webhook and sweep route it through lib/ussd-utility-settle.ts before they ever
        // resolve a session. Reaching here means that routing was bypassed — and the
        // default below would hand the payment to the result-checker fulfiller.
        return { success: false, error: 'Utility bills settle through their payment record' }
    }
    if (orderType === 'afa') {
        return (await import('@/lib/ussd-afa-fulfillment')).fulfillUSSDAFABySession(rest)
    }
    return (await import('@/lib/ussd-rc-fulfillment')).fulfillUSSDRCBySession(rest)
}
