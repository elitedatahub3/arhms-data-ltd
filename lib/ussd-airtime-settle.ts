/**
 * Settles airtime paid for over USSD, and tells the payer how it ended.
 *
 * The payment is a wallet_payments row of kind 'airtime_order' — the very row
 * /api/airtime/gateway-init writes for a website payment — recorded just before the MoMo
 * charge (lib/ussd-airtime.ts, recordAirtimePayment). So settlement is the website's:
 * processAirtimeDirectOrder claims the row with an atomic pending -> completed update, creates
 * the order and dispatches the top-up. Racing callers (the payment webhook and the 5-minute
 * sweep) are safe because only one wins that claim.
 *
 * It is recognised by metadata, not by reference prefix. Every collection webhook routes
 * AIRPAY- references to processAirtimeDirectOrder, but a USSD- reference goes to the USSD
 * fulfillers first, and one that fell through to the wallet top-up path would CREDIT THE
 * WALLET instead of buying the airtime.
 *
 * Airtime has no automatic refund (see the dispatcher): a top-up the provider refuses is held
 * for an admin, and the dispatcher tells nobody but the admins. A caller who hung up has no
 * screen to notice it on, so they are texted ("taking longer than expected"). The texts say
 * "our team is checking it" rather than promising money back, except in the one case where the
 * settler itself returns the money to the wallet.
 */
import { processAirtimeDirectOrder } from '@/lib/airtime-order-payments'
import { sendSMS } from '@/lib/sms-service'
import { validateGhanaianPhone } from '@/lib/phone-validation'

/**
 * completed — sent.
 * delayed   — the provider refused or the dispatch could not be recorded; the order is held for
 *             an admin and is NOT final (the dispatcher leaves it pending). Sent once.
 * failed    — an admin or the provider marked it failed: final.
 * refunded  — the order could not even be created and the money went back to the wallet.
 */
export type UssdAirtimeEvent = 'completed' | 'delayed' | 'failed' | 'refunded'

const ascii = (s: unknown) => String(s ?? '').replace(/[^\x20-\x7E]/g, '').trim()
const money = (n: unknown) => Number(n ?? 0).toFixed(2)
/** Last four digits only: enough to recognise the number, not enough to leak it. */
const tail = (phone: unknown) => `****${String(phone ?? '').slice(-4)}`

export function composeAirtimeSms(
    event: UssdAirtimeEvent,
    meta: Record<string, any>,
    totalPaid: number,
    reference: string
): string {
    const network = ascii(meta.network)
    const amount = money(meta.airtime_amount)
    const to = tail(meta.beneficiary_phone)
    const ref = reference.slice(-8)

    switch (event) {
        case 'completed':
            return `ARHMS: GHS ${amount} ${network} airtime was sent to ${to}. Ref ${ref}`
        case 'refunded':
            return `ARHMS: Your GHS ${money(totalPaid)} ${network} airtime payment for ${to} could not be completed and was returned to your ARHMS wallet. Ref ${ref}`
        case 'delayed':
            return `ARHMS: Your GHS ${amount} ${network} airtime for ${to} is taking longer than expected. Our team is checking it and will contact you. Ref ${ref}`
        case 'failed':
            return `ARHMS: Your GHS ${amount} ${network} airtime order for ${to} could not be completed. Please contact support with Ref ${ref}`
    }
}

/**
 * Texts the person who paid. A no-op for anything that is not a USSD airtime payment, so
 * callers can invoke it unconditionally.
 *
 * Sent from the platform's house sender (sendSMS: active_sms_provider and SMS_ENABLED apply).
 * These are notices about the payer's own money, not order confirmations to a customer — those
 * ("received" and "credited") are sent by processAirtimeDirectOrder and finalizeAirtimeOrder
 * through sendPlatformOrderSms, to the beneficiary, under the buyer's own sender ID when they
 * have switched that on.
 *
 * `completed` is sent only when the payer is NOT the beneficiary: a beneficiary is already
 * texted "credited successfully" by finalizeAirtimeOrder, and the same person should not get
 * two messages. Failures always go to the payer — nothing else tells them.
 */
export async function smsUssdAirtimePayer(
    db: any,
    params: { reference: string; event: UssdAirtimeEvent; totalPaid?: number }
): Promise<void> {
    const { reference, event } = params
    if (!String(reference).startsWith('USSD-AIR-')) return

    const { data: payment } = await db
        .from('wallet_payments')
        .select('total_amount, metadata')
        .eq('reference', reference)
        .maybeSingle()
    const meta = payment?.metadata
    if (!meta || meta.channel !== 'ussd' || !meta.payer_msisdn) return

    if (event === 'completed') {
        const payer = validateGhanaianPhone(String(meta.payer_msisdn)).normalizedNumber
        const beneficiary = validateGhanaianPhone(String(meta.beneficiary_phone)).normalizedNumber
        if (payer && payer === beneficiary) return
    }

    // A held order can be re-dispatched by the rescue sweep every few minutes, and each
    // attempt would halt again. Say it once: an atomic claim on a marker in the record.
    if (event === 'delayed') {
        const { data: claimed, error } = await db
            .from('wallet_payments')
            .update({ metadata: { ...meta, delayed_sms_at: new Date().toISOString() } })
            .eq('reference', reference)
            .or('metadata->>delayed_sms_at.is.null')
            .select('id')
        if (!error && !(Array.isArray(claimed) && claimed.length > 0)) return
        if (error) console.error('[UssdAirtimeSms] Could not claim the delayed text; sending anyway:', error.message)
    }

    const total = params.totalPaid ?? Number(payment.total_amount)
    try {
        await sendSMS({ recipient: meta.payer_msisdn, message: composeAirtimeSms(event, meta, total, reference) })
    } catch (error: any) {
        console.error('[UssdAirtimeSms] SMS failed:', reference, error?.message)
    }
}

/** The airtime payment for `reference`, or null when it is not a USSD airtime order. */
export async function findUssdAirtimePayment(db: any, reference: string): Promise<any | null> {
    if (!String(reference).startsWith('USSD-AIR-')) return null
    const { data } = await db
        .from('wallet_payments')
        .select('id, user_id, total_amount, status, metadata')
        .eq('reference', reference)
        .maybeSingle()
    const meta = data?.metadata
    return meta?.kind === 'airtime_order' && meta?.channel === 'ussd' ? data : null
}

export interface UssdAirtimeSettleResult {
    success: boolean
    alreadyProcessed?: boolean
    error?: string
}

export async function settleUssdAirtimeOrder(
    db: any,
    params: { payment: any; reference: string; amountPaid: number }
): Promise<UssdAirtimeSettleResult> {
    const { payment, reference, amountPaid } = params
    const expected = Number(payment.total_amount)

    // Never buy airtime the MoMo payment did not cover. Paystack charges the quoted figure
    // exactly, so a shortfall means something is wrong; leave the row pending for a human.
    if (amountPaid + 0.05 < expected) {
        console.error(`[UssdAirtime] Underpaid ${reference}: paid ${amountPaid}, expected ${expected}`)
        return { success: false, error: 'Amount paid is less than the airtime total' }
    }

    const result = await processAirtimeDirectOrder(reference, payment.user_id)

    if (!result.success) {
        // If the claim had already succeeded, money was taken and the order could not be made
        // — processAirtimeDirectOrder credited it back to the wallet. Say so.
        const { data: after } = await db.from('wallet_payments').select('status').eq('reference', reference).maybeSingle()
        if (after?.status === 'completed') {
            await smsUssdAirtimePayer(db, { reference, event: 'refunded' })
        }
        return { success: false, error: result.error }
    }

    return { success: true, alreadyProcessed: result.alreadyProcessed === true }
}
