/**
 * Texts the person who paid for a utility bill over USSD.
 *
 * A USSD caller hung up the moment the MoMo prompt was sent. The website tells a buyer
 * their bill went through, or didn't, on the page they are looking at; here there is no
 * page, so a bill that is refunded or fails would otherwise leave them with money gone and
 * no explanation. These texts are that explanation.
 *
 * They are most important for a SHOP sale, where the money of a failed bill is returned to
 * the account of record — the shop owner's wallet — not to the stranger who paid. The
 * message says so plainly and names the shop, so the buyer knows who to ask.
 *
 * No-ops for anything that is not a USSD utility payment, so the callers can invoke it
 * unconditionally.
 *
 * Sent from the platform's house sender (sendSMS: active_sms_provider and SMS_ENABLED apply).
 * They are notices to the person who paid about THEIR money, not order confirmations to a
 * customer, so the SMS Platform's own-sender setting does not apply to them.
 */
import { sendSMS } from '@/lib/sms-service'

export type UssdUtilityEvent = 'processing' | 'completed' | 'refunded' | 'failed'

const LABELS: Record<string, string> = {
    ecg: 'ECG', dstv: 'DSTV', gotv: 'GOtv', startimes: 'StarTimes', ghanawater: 'Ghana Water',
}

const ascii = (s: unknown) => String(s ?? '').replace(/[^\x20-\x7E]/g, '').trim()
const money = (n: unknown) => Number(n ?? 0).toFixed(2)
/** Last four characters only: enough to recognise the account, not enough to leak it. */
const tail = (account: unknown) => `****${String(account ?? '').slice(-4)}`

export function composeUtilitySms(
    event: UssdUtilityEvent,
    meta: Record<string, any>,
    totalPaid: number,
    reference: string
): string {
    const label = LABELS[String(meta.service)] ?? ascii(meta.service)
    const acct = tail(meta.account_number)
    const ref = reference.slice(-8)
    const shop = ascii(meta.shop_name).slice(0, 24)

    switch (event) {
        case 'processing':
            return `ARHMS: We received GHS ${money(totalPaid)} for ${label} ${acct}. We are paying the bill and will SMS you when it is done. Ref ${ref}`
        case 'completed':
            return `ARHMS: Your ${label} bill of GHS ${money(meta.bill_amount)} for ${acct} was paid successfully. Ref ${ref}`
        case 'refunded':
            return meta.shop_id
                ? `ARHMS: Your ${label} payment of GHS ${money(totalPaid)} for ${acct} could not be completed and was refunded to ${shop || 'the shop'}. Please contact them. Ref ${ref}`
                : `ARHMS: Your ${label} payment of GHS ${money(totalPaid)} for ${acct} could not be completed and was returned to your ARHMS wallet. Ref ${ref}`
        case 'failed':
            return `ARHMS: Your ${label} payment of GHS ${money(totalPaid)} for ${acct} could not be completed. Our team is checking it and will contact you. Ref ${ref}`
    }
}

/**
 * @param db        a service-role client
 * @param reference the USSD-UTIL- payment reference
 */
export async function smsUssdUtilityPayer(
    db: any,
    params: { reference: string; event: UssdUtilityEvent; totalPaid?: number }
): Promise<void> {
    const { reference, event } = params
    if (!String(reference).startsWith('USSD-UTIL-')) return

    const { data: payment } = await db
        .from('wallet_payments')
        .select('total_amount, metadata')
        .eq('reference', reference)
        .maybeSingle()
    const meta = payment?.metadata
    if (!meta || meta.channel !== 'ussd' || !meta.payer_msisdn) return

    const total = params.totalPaid ?? Number(payment.total_amount)
    try {
        await sendSMS({ recipient: meta.payer_msisdn, message: composeUtilitySms(event, meta, total, reference) })
    } catch (error: any) {
        console.error('[UssdUtilitySms] SMS failed:', reference, error?.message)
    }
}
