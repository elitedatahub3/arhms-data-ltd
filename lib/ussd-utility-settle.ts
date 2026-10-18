/**
 * Settles a utility bill paid for over USSD.
 *
 * The payment is a wallet_payments row of kind 'utility_order' — the very row
 * /api/utilities/gateway-init writes for a website payment — recorded just before the MoMo
 * charge (lib/ussd-utilities-server.ts, handleCreate). So settlement is the website's:
 * processUtilityDirectOrder claims the row with an atomic pending -> completed update, builds
 * the order, pays the bill and refunds on a rejection. Racing callers (the payment webhook and
 * the 5-minute sweep) are safe because only one wins that claim.
 *
 * What is added here is what USSD lacks: a guard that the MoMo payment actually covered the
 * quote, and a text to the caller (who hung up long ago) saying what happened.
 *
 * It is recognised by metadata, not by reference prefix. The website routes UTIL- references to
 * processUtilityDirectOrder, but a USSD- reference is routed to the USSD fulfillers first, and
 * one that fell through to the wallet top-up path would CREDIT THE WALLET instead of paying the
 * bill — the failure lib/utility-order-intent.ts warns about.
 */
import { processUtilityDirectOrder } from '@/lib/utility-order-payments'
import { smsUssdUtilityPayer } from '@/lib/ussd-utility-sms'

/** Statuses after which finalizeUtilityOrder has already texted the caller. */
const FINAL = ['completed', 'refunded', 'failed']

/** The utility payment for `reference`, or null when it is not a USSD utility order. */
export async function findUssdUtilityPayment(db: any, reference: string): Promise<any | null> {
    if (!String(reference).startsWith('USSD-UTIL-')) return null
    const { data } = await db
        .from('wallet_payments')
        .select('id, user_id, total_amount, status, metadata')
        .eq('reference', reference)
        .maybeSingle()
    const meta = data?.metadata
    return meta?.kind === 'utility_order' && meta?.channel === 'ussd' ? data : null
}

export interface UssdUtilitySettleResult {
    success: boolean
    alreadyProcessed?: boolean
    error?: string
}

export async function settleUssdUtilityOrder(
    db: any,
    params: { payment: any; reference: string; amountPaid: number }
): Promise<UssdUtilitySettleResult> {
    const { payment, reference, amountPaid } = params
    const expected = Number(payment.total_amount)

    // Never pay a bill the MoMo payment did not cover. Paystack charges the quoted figure
    // exactly, so a shortfall means something is wrong; leave the row pending for a human.
    if (amountPaid + 0.05 < expected) {
        console.error(`[UssdUtility] Underpaid ${reference}: paid ${amountPaid}, expected ${expected}`)
        return { success: false, error: 'Amount paid is less than the bill total' }
    }

    const result = await processUtilityDirectOrder(reference, payment.user_id)

    if (!result.success) {
        // If the claim had already succeeded, money was taken and the order could not be
        // made — processUtilityDirectOrder refunded it. Tell the caller either way.
        const { data: after } = await db.from('wallet_payments').select('status').eq('reference', reference).maybeSingle()
        if (after?.status === 'completed') {
            await smsUssdUtilityPayer(db, { reference, event: 'failed' })
        }
        return { success: false, error: result.error }
    }

    if (result.alreadyProcessed) return { success: true, alreadyProcessed: true }

    // A bill paid or refunded straight away was already texted by finalizeUtilityOrder.
    // Only one still in flight needs the "we received it" text.
    const status = String(result.order?.status ?? 'pending')
    if (!FINAL.includes(status)) {
        await smsUssdUtilityPayer(db, { reference, event: 'processing' })
    }
    return { success: true }
}
