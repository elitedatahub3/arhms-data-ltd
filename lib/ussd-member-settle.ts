/**
 * Settles a USSD order placed by a registered user ("member") — see lib/ussd-member.ts.
 *
 * Two steps, each idempotent on its own, so the payment webhook and the reconciliation
 * sweep can both call this for one payment, in any order, any number of times:
 *
 *   1. Credit the MoMo payment to the member's wallet. processCompletedWalletPayment()
 *      — the dashboard top-up path — claims the pending wallet_payments row with an
 *      atomic pending→completed update, so the wallet moves once.
 *
 *   2. Buy the item from the wallet through the dashboard's own purchase code, keyed on
 *      the USSD reference, so a repeat finds the order the first call made.
 *
 * If step 2 fails (out of stock, a sub's upline stopped selling the item, …) the money
 * is already in the member's wallet: they are told by SMS and can spend it on the
 * dashboard. Nothing goes to a refund queue and no order is left half-made.
 */
import { processCompletedWalletPayment } from '@/lib/payments'
import { purchaseDataWithWallet } from '@/lib/wallet-data-purchase'
import { purchaseWithWallet } from '@/lib/vouchers/checkout'
import { sendSMS } from '@/lib/sms-service'
import { USSD_MEMBER_PAYMENT_KIND } from '@/lib/ussd-member'
import { resolveAfaApiPrice, resolveAfaCostPrice } from '@/lib/afa-pricing'

export interface MemberSettleResult {
    success: boolean
    /** True when the wallet was credited but the item could not be bought. */
    creditedOnly?: boolean
    error?: string
}

/** The pending member payment for `reference`, or null when it is not a member order. */
export async function findMemberPayment(db: any, reference: string): Promise<any | null> {
    const { data } = await db
        .from('wallet_payments')
        .select('id, user_id, amount, status, metadata')
        .eq('reference', reference)
        .maybeSingle()
    return data?.metadata?.kind === USSD_MEMBER_PAYMENT_KIND ? data : null
}

export async function settleMemberUssdOrder(
    db: any,
    params: { payment: any; reference: string; amountPaid: number }
): Promise<MemberSettleResult> {
    const { payment, reference, amountPaid } = params
    const meta = payment.metadata || {}
    const expected = Number(payment.amount)

    // Never credit more than was paid. Paystack charges the exact menu price, so a
    // shortfall means something is wrong; leave the row pending for a human.
    if (amountPaid + 0.05 < expected) {
        console.error(`[UssdMember] Underpaid ${reference}: paid ${amountPaid}, expected ${expected}`)
        return { success: false, error: 'Amount paid is less than the order price' }
    }

    // 1. Wallet credit — idempotent.
    //
    // The metadata passed here REPLACES the row's metadata (processCompletedWalletPayment
    // writes `providerMetadata || payment.metadata`). The row's metadata is the order —
    // package, recipient, kind — and kind is how every later settlement recognises this as
    // a member order. Overwriting it would let the next webhook or sweep fall through to
    // the shop/house fulfiller and deliver the item a second time. So the original is
    // carried through, with the payment details added.
    const credit = await processCompletedWalletPayment(
        reference,
        { ...meta, channel: 'ussd', amount_paid: amountPaid },
        payment.user_id
    )
    if (!credit.success) {
        console.error('[UssdMember] Wallet credit failed:', reference, credit.error)
        return { success: false, error: credit.error || 'Wallet credit failed' }
    }

    // 2. Purchase from the wallet — exactly one settlement gets to try.
    //
    // The webhook and the 5-minute sweep can arrive together. Without a claim both would
    // deduct the wallet before either created the order, and the loser would be told the
    // purchase failed. The claim is an atomic conditional update on the payment row, so
    // only one caller proceeds; the other returns success because the first owns it.
    const claimed = await claimPurchase(db, reference, { ...meta, channel: 'ussd', amount_paid: amountPaid })
    if (!claimed) {
        console.log('[UssdMember] Purchase already claimed by another settlement:', reference)
        return { success: true }
    }

    const purchase = await buyFromWallet(db, payment.user_id, meta, reference, expected)
    if (purchase.ok) return { success: true }

    // A failure with the order already in place is a lost race or a retry, not a failed
    // purchase — never tell the member their order failed when it exists.
    if (await orderAlreadyPlaced(db, meta.order_type, reference)) return { success: true }

    // The claim is deliberately kept on failure: a repeat delivery of the same webhook
    // must not buy again, and must not send the "we could not complete" SMS twice.

    console.error('[UssdMember] Purchase failed after credit:', reference, purchase.error)
    await notifyCreditedOnly(meta, expected, purchase.error)
    return { success: true, creditedOnly: true, error: purchase.error }
}

/** A claim older than this is a settlement that died mid-purchase, and may be retaken. */
const CLAIM_LEASE_MS = 2 * 60 * 1000

/**
 * Atomically claims the right to buy for `reference`. True for exactly one caller.
 *
 * One UPDATE with a WHERE on the claim marker: when two arrive together, Postgres makes
 * the second wait for the first to commit and then re-evaluates the WHERE, which no
 * longer matches. If the claim query itself errors we proceed without it — buying is
 * still protected by the idempotency check inside the purchase — and say so loudly,
 * because stranding a paid order is worse than the rare double attempt.
 */
async function claimPurchase(db: any, reference: string, metadata: Record<string, unknown>): Promise<boolean> {
    const now = new Date()
    const staleBefore = new Date(now.getTime() - CLAIM_LEASE_MS).toISOString()
    const { data, error } = await db
        .from('wallet_payments')
        .update({ metadata: { ...metadata, purchase_claimed_at: now.toISOString() } })
        .eq('reference', reference)
        .or(`metadata->>purchase_claimed_at.is.null,metadata->>purchase_claimed_at.lt.${staleBefore}`)
        .select('id')

    if (error) {
        console.error('[UssdMember] Purchase claim query failed; proceeding unclaimed:', reference, error.message)
        return true
    }
    return Array.isArray(data) && data.length > 0
}

/** True when an order for this reference already exists and did not fail. */
async function orderAlreadyPlaced(db: any, orderType: string, reference: string): Promise<boolean> {
    const table = orderType === 'rc' ? 'results_checker_orders' : orderType === 'afa' ? 'afa_orders' : 'orders'
    const { data } = await db.from(table).select('id, status').eq('reference_code', reference).maybeSingle()
    return !!data && data.status !== 'failed'
}

async function buyFromWallet(
    db: any,
    userId: string,
    meta: any,
    reference: string,
    paidAmount: number
): Promise<{ ok: boolean; error?: string }> {
    if (meta.order_type === 'afa') return buyAfaFromWallet(db, userId, meta, reference, paidAmount)

    if (meta.order_type === 'data') {
        const result = await purchaseDataWithWallet({
            supabase: db,
            userId,
            packageId: meta.package_id,
            phoneNumber: meta.recipient,
            referenceCode: reference,
        })
        return result.ok ? { ok: true } : { ok: false, error: result.error || 'Purchase failed' }
    }

    if (meta.order_type === 'rc') {
        // A repeat call finds the order the first one made.
        const { data: existing } = await db
            .from('results_checker_orders')
            .select('id, status')
            .eq('reference_code', reference)
            .maybeSingle()
        if (existing && existing.status !== 'failed') return { ok: true }

        const { data: user } = await db
            .from('users')
            .select('*')
            .eq('id', userId)
            .maybeSingle()

        // A sub buys at their upline's price with the sale attributed upward — the
        // same call /api/dashboard/sub/rc makes.
        let subOverride: Record<string, unknown> = {}
        const { data: membership } = await db
            .from('sub_agents')
            .select('upline_shop_id')
            .eq('user_id', userId)
            .maybeSingle()
        if (membership?.upline_shop_id) {
            const [{ data: pricing }, { data: shop }] = await Promise.all([
                db.from('shop_rc_pricing').select('selling_price')
                    .eq('shop_id', membership.upline_shop_id).eq('rc_type_id', meta.type_id).maybeSingle(),
                db.from('shop_profiles').select('shop_name, owner_id').eq('id', membership.upline_shop_id).maybeSingle(),
            ])
            if (!pricing) return { ok: false, error: 'This voucher is no longer available from your Lead' }
            subOverride = {
                unitPriceOverride: parseFloat(pricing.selling_price),
                shopId: membership.upline_shop_id,
                shopName: shop?.shop_name,
                shopOwnerId: shop?.owner_id,
            }
        }

        try {
            await purchaseWithWallet({
                userId,
                userRole: user?.role || 'customer',
                typeId: meta.type_id,
                quantity: 1,
                customerName: user?.first_name || 'Customer',
                customerEmail: user?.email,
                customerPhone: meta.recipient,
                referenceCode: reference,
                apiPricing: user?.is_api_user === true,
                ...subOverride,
            } as any)
            return { ok: true }
        } catch (error: any) {
            return { ok: false, error: friendlyRcError(error?.message) }
        }
    }

    return { ok: false, error: `Unknown order type: ${meta.order_type}` }
}

/**
 * AFA registration from the wallet, through the same RPC the dashboard uses.
 *
 * process_afa_order deducts the wallet and inserts the order in one transaction, and
 * afa_orders.reference_code is UNIQUE, so a repeat raises a duplicate error (read as
 * success) instead of charging twice. A sub-agent is refused here as well as on the
 * menu: their purchase goes through process_sub_afa_order, which is not installed.
 */
async function buyAfaFromWallet(
    db: any,
    userId: string,
    meta: any,
    reference: string,
    paidAmount: number
): Promise<{ ok: boolean; error?: string }> {
    const { data: existing } = await db.from('afa_orders').select('id').eq('reference_code', reference).maybeSingle()
    if (existing) return { ok: true }

    const form = meta.afa
    if (!form) return { ok: false, error: 'The registration details were lost' }

    const [{ data: user }, { data: membership }] = await Promise.all([
        db.from('users').select('*').eq('id', userId).maybeSingle(),
        db.from('sub_agents').select('id').eq('user_id', userId).maybeSingle(),
    ])
    if (membership) return { ok: false, error: 'AFA is not available to sub-agents on USSD' }

    const priced = user?.is_api_user === true
        ? await resolveAfaApiPrice(db, user?.role)
        : await resolveAfaCostPrice(db, user?.role)
    if (!priced.ok || !priced.price) return { ok: false, error: 'AFA pricing is not configured' }
    // The wallet holds what was paid; a price that rose in between is not charged silently.
    if (priced.price > paidAmount + 0.005) return { ok: false, error: 'The price changed since you dialled' }

    const { error } = await db.rpc('process_afa_order', {
        p_user_id: userId,
        p_amount: priced.price,
        p_form_data: {
            full_name: form.full_name,
            phone: form.phone,
            id_type: 'Ghana Card',
            id_number: form.id_number,
            date_of_birth: form.date_of_birth,
            location: form.location,
            region: form.region,
            notes: null,
        },
        p_reference_code: reference,
    })

    if (error) {
        const message = String(error.message || '')
        if (error.code === '23505' || /duplicate key|afa_orders_reference_code_unique/.test(message)) return { ok: true }
        if (message.includes('INSUFFICIENT_BALANCE')) return { ok: false, error: 'Not enough balance' }
        console.error('[UssdMember] process_afa_order failed:', reference, message)
        return { ok: false, error: 'The registration could not be completed' }
    }

    // Best-effort — a failed alert must never undo a placed order.
    try {
        const { notifyAdminsOfAfaApplication } = await import('@/lib/afa/checkout')
        await notifyAdminsOfAfaApplication(db, { full_name: form.full_name, phone: form.phone, region: form.region })
    } catch (alertError: any) {
        console.error('[UssdMember] AFA admin alert failed:', alertError?.message)
    }

    // Confirm to the applicant. A main-site order: the platform's house sender, or the buyer's OWN
    // sender ID (paid from their SMS credits) when they have switched on "Use my sender ID for order
    // confirmations" — the same rule as every other platform confirmation (sendPlatformOrderSms),
    // which falls back to the house message whenever their sender cannot be used, so the applicant
    // is never left without one. Only reached for a freshly placed order: a duplicate returned above.
    try {
        const { sendPlatformOrderSms } = await import('@/lib/sms/platform-order-sms')
        const applicant = String(form.phone || '')
        const name = String(form.full_name || '').replace(/[^\x20-\x7E]/g, '').trim()
        const body = `Your AFA registration for ${name} has been received and is being processed. Thank you.`
        await sendPlatformOrderSms({
            userId,
            isShopOrder: false,
            recipient: applicant,
            body,
            reference: `afa:${reference}:received`,
            houseSend: () => sendSMS({ recipient: applicant, message: `${body}\n\nARHMSGh` }),
        })
    } catch (smsError: any) {
        console.error('[UssdMember] AFA confirmation SMS failed:', smsError?.message)
    }
    return { ok: true }
}

function friendlyRcError(code: string | undefined): string {
    switch (code) {
        case 'INSUFFICIENT_INVENTORY': return 'Out of stock'
        case 'INSUFFICIENT_BALANCE': return 'The price changed since you dialled'
        case 'PRODUCT_NOT_AVAILABLE': return 'This voucher is unavailable'
        default: return 'The order could not be completed'
    }
}

/** ASCII-only and one SMS long — it goes out through Hubtel. */
async function notifyCreditedOnly(meta: any, amount: number, reason: string) {
    const to = meta.payer_msisdn || meta.recipient
    if (!to) return
    const item = String(meta.item_name || 'your order').replace(/[^\x20-\x7E]/g, '')
    const why = String(reason || '').replace(/[^\x20-\x7E]/g, '').slice(0, 50)
    try {
        // The platform's house sender: this is a notice to the payer about their own money.
        await sendSMS({
            recipient: to,
            message: `ARHMS: Your GHS ${amount.toFixed(2)} payment is safe in your ARHMS wallet. We could not complete ${item} (${why}). Buy again from your wallet at arhmsgh.com.`,
        })
    } catch (error: any) {
        console.error('[UssdMember] Credited-only SMS failed:', error?.message)
    }
}
