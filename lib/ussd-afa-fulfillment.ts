/**
 * Fulfilment of an AFA registration sold through a shop's USSD menu.
 *
 * Called by the Paystack webhook and the reconciliation sweep (via lib/ussd-settle.ts)
 * once the caller's MoMo payment is confirmed. Registered users' AFA orders do not come
 * through here — they settle into their wallet (lib/ussd-member-settle.ts).
 *
 * AFA has no supplier. Fulfilling means putting the application in the admin queue at
 * /admin/afa-management, paying the shop its share, telling the admins, and telling the
 * caller it was received. It is recorded exactly as a storefront AFA order is
 * (source 'storefront', payment_status 'completed'), so the admin page and the profit
 * split treat the two identically.
 *
 * Idempotent on the reference: the webhook and the sweep may both arrive, in any order,
 * and afa_orders.reference_code is UNIQUE, so the second is a no-op.
 */
import { createClient } from '@supabase/supabase-js'
import { sendHubtelSMS } from '@/lib/hubtel-sms-service'
import { computeShopProfit, insertOrderWithSplit, profitColumns } from '@/lib/shop-profit'
import { creditOrderProfit } from '@/lib/shop-profit-credit'
import { notifyAdminsOfAfaApplication } from '@/lib/afa/checkout'
import { AFA_ITEM_NAME } from '@/lib/ussd-afa'

const supabaseAdmin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
) as any

export async function fulfillUSSDAFABySession(params: {
    sessionId: string
    referenceCode: string
    amountPaid: number
    deferredWork?: Array<() => Promise<void>>
}): Promise<{ success: boolean; error?: string }> {
    const { sessionId, referenceCode, amountPaid, deferredWork = [] } = params

    // 1. Already done? Checked before the session, because a retry arrives after the
    //    session has been cleaned up.
    const { data: existing } = await supabaseAdmin
        .from('afa_orders')
        .select('id, payment_status')
        .eq('reference_code', referenceCode)
        .maybeSingle()
    if (existing?.payment_status === 'completed') {
        console.log('[USSD-AFA Fulfill] Already fulfilled:', referenceCode)
        return { success: true }
    }

    // 2. The session carries the applicant's answers.
    const { data: session, error: sessionError } = await supabaseAdmin
        .from('hubtel_sessions')
        .select('*')
        .eq('session_id', sessionId)
        .maybeSingle()
    if (sessionError || !session) {
        console.error('[USSD-AFA Fulfill] Session not found:', sessionId, sessionError?.message)
        return { success: false, error: 'Session not found' }
    }

    const data = session.data || {}
    const form = data.afaForm
    const shopId: string | null = data.shopId || null
    if (!form || !shopId) {
        console.error('[USSD-AFA Fulfill] Incomplete session data:', referenceCode)
        return { success: false, error: 'Incomplete session data' }
    }

    // 3. The price comes from the database, never the session — and the payment must
    //    cover it.
    const [{ data: shop }, { data: pricing }] = await Promise.all([
        supabaseAdmin.from('shop_profiles').select('id, shop_name, owner_id').eq('id', shopId).maybeSingle(),
        supabaseAdmin.from('shop_afa_pricing').select('selling_price').eq('shop_id', shopId).maybeSingle(),
    ])
    const price = Number(pricing?.selling_price)
    if (!shop || !(price > 0)) {
        console.error('[USSD-AFA Fulfill] Shop or AFA price missing:', shopId)
        return { success: false, error: 'AFA price not configured' }
    }
    if (amountPaid + 0.01 < price) {
        console.error(`[USSD-AFA Fulfill] AMOUNT MISMATCH for ${referenceCode}: expected >= GHS ${price}, got GHS ${amountPaid}`)
        return { success: false, error: 'Amount paid is less than the AFA price' }
    }

    // 4. Who earns what. A non-positive margin does not stop the registration — the
    //    caller has paid — it only means nobody is credited.
    const split = await computeShopProfit(supabaseAdmin, { kind: 'afa', ownerId: shop.owner_id, unitPrice: price })
    const earns = !!split && split.totalMargin > 0
    if (!earns) console.error('[USSD-AFA Fulfill] No positive margin on a paid shop sale:', referenceCode)

    // 5. Record it. The same shape /api/shop/afa/initialize writes, already paid.
    const row = {
        user_id: null,
        shop_id: shop.id,
        shop_name: shop.shop_name,
        ...(split && earns ? profitColumns(split) : { shop_markup: 0 }),
        cost_price: split?.unitCost ?? 0,
        payment_amount: price,
        customer_email: null,
        full_name: form.full_name,
        phone: form.phone,
        id_type: 'Ghana Card',
        id_number: form.id_number,
        ghana_card: form.id_number,
        date_of_birth: form.date_of_birth,
        location: form.location,
        region: form.region,
        occupation: 'Farmer',
        notes: null,
        status: 'pending',
        payment_status: 'completed',
        source: 'storefront',
        reference_code: referenceCode,
    }
    const { error: insertError } = await insertOrderWithSplit(supabaseAdmin, 'afa_orders', row, 'id')
    if (insertError) {
        // The unique reference: another settlement got here first.
        if (insertError.code === '23505') return { success: true }
        console.error('[USSD-AFA Fulfill] Failed to create the order:', insertError)
        return { success: false, error: 'Failed to create order record' }
    }

    // 6. Pay the shop (and any upline). Idempotent per leg.
    await creditOrderProfit(supabaseAdmin, row, referenceCode, `USSD AFA Registration: ${form.full_name}`)

    // 7. Everything else is off the critical path.
    deferredWork.push(async () => {
        await notifyAdminsOfAfaApplication(supabaseAdmin, row).catch(() => {})
    })
    deferredWork.push(async () => {
        await sendHubtelSMS({
            recipient: data.payerMsisdn || session.mobile,
            message: `${AFA_ITEM_NAME} received for ${form.full_name}. We will process it and SMS you when it is done. ARHMS DATA`,
        }).catch((err: any) => console.error('[USSD-AFA Fulfill] SMS failed:', err?.message))
    })
    deferredWork.push(async () => {
        await supabaseAdmin.from('hubtel_sessions').delete().eq('session_id', sessionId)
    })

    return { success: true }
}
