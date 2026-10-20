import { createServerClient } from '@/lib/supabase'
import { creditOrderProfit } from '@/lib/shop-profit-credit'

/**
 * Settlement for a storefront AFA registration.
 *
 * Mirrors finalizeRCGatewayOrder in lib/vouchers/checkout.ts. This is the single
 * settlement path: every payment webhook and the browser's verify poll call it,
 * and whichever arrives second must be a no-op — hence the payment_status guard
 * here and the reference-keyed idempotency inside creditShopRcProfit.
 *
 * Note what this does NOT do: it never touches `status`. AFA has no supplier
 * integration — an admin works the queue at /admin/afa-management by hand — so a
 * paid application stays `pending` and only becomes visible to that queue once
 * payment_status flips to 'completed'.
 */
export async function finalizeAfaShopOrder(params: {
    reference: string
    paidAmountKobo: number
}): Promise<{ success: boolean; alreadyProcessed?: boolean }> {
    const { reference, paidAmountKobo } = params
    const supabase = createServerClient()
    const db = supabase as any

    // 1. Idempotency — load the order
    const { data: order, error: orderFetchError } = await db
        .from('afa_orders')
        // '*' rather than a column list: the split columns (parent_/grandparent_)
        // arrive with a migration, and naming them before it runs would fail the
        // whole select — and with it, settlement of a paid order.
        .select('*')
        .eq('reference_code', reference)
        .maybeSingle()

    if (orderFetchError || !order) {
        console.error('[AFA Gateway] Order not found:', reference)
        return { success: false }
    }

    if (order.payment_status === 'completed') {
        return { success: true, alreadyProcessed: true }
    }

    // 2. Amount verification (±5 pesewa rounding tolerance)
    const expectedKobo = Math.round(Number(order.payment_amount) * 100)
    if (Math.abs(paidAmountKobo - expectedKobo) > 5) {
        console.error(`[AFA Gateway] Amount mismatch on ${reference}: expected ${expectedKobo}, got ${paidAmountKobo}`)
        throw new Error('AMOUNT_MISMATCH')
    }

    // 3. Mark paid. This is what puts the application into the admin queue.
    const { error: updateError } = await db
        .from('afa_orders')
        .update({
            payment_status: 'completed',
            updated_at: new Date().toISOString(),
        })
        .eq('id', order.id)

    if (updateError) {
        console.error('[AFA Gateway] Failed to mark order paid:', updateError)
        return { success: false }
    }

    // 4. Credit the shop's markup.
    //
    // creditShopRcProfit is not RC-specific — it is the generic shop-wallet
    // credit for sales that produce no `shop_orders` row, and AFA is another
    // such sale. It claims the credit via the unique index on
    // shop_wallet_transactions(reference, type), so the webhook and the verify
    // poll racing each other still credits exactly once.
    //
    // Every leg on the row is paid — the selling shop and, on a sub's sale, each
    // upline — each under its own reference (lib/shop-profit.ts).
    if (order.shop_id) {
        await creditOrderProfit(db, order, reference, `AFA Registration: ${order.full_name}`)
    }

    // 5. Tell the admins there is something to process. Best-effort — a failed
    //    alert must never undo a settled payment.
    await notifyAdminsOfAfaApplication(db, order).catch((err) => {
        console.error('[AFA Gateway] Admin notification failed (non-fatal):', err)
    })

    return { success: true }
}

/** Emails every admin and fires a push. Never throws. */
export async function notifyAdminsOfAfaApplication(db: any, order: any) {
    try {
        const { data: adminUsers } = await db
            .from('users')
            .select('email')
            .eq('role', 'admin')

        const recipients = new Set<string>()
        if (process.env.ADMIN_EMAIL) recipients.add(process.env.ADMIN_EMAIL)
        for (const u of (adminUsers || []) as any[]) {
            if (u.email) recipients.add(u.email)
        }

        if (recipients.size > 0) {
            const { sendAdminNewAfaApplicationAlert } = await import('@/lib/email-service')
            await Promise.allSettled(
                Array.from(recipients).map(email =>
                    sendAdminNewAfaApplicationAlert(
                        {
                            applicantName: order.full_name,
                            phone: order.phone,
                            region: order.region,
                        },
                        email
                    )
                )
            )
        }
    } catch (emailError) {
        console.error('[AFA Gateway] Admin alert email failed:', emailError)
    }

    try {
        const { sendPushToAdmins } = await import('@/lib/web-push')
        await sendPushToAdmins({
            title: 'New AFA Application',
            body: `${order.full_name} · ${order.region}${order.shop_name ? ` · Shop: ${order.shop_name}` : ''}`,
            url: '/admin/afa-management',
        })
    } catch (pushError) {
        console.error('[AFA Gateway] Admin push failed:', pushError)
    }
}

/** Marks a storefront AFA order failed after a declined or abandoned payment. */
export async function failAfaShopOrder(reference: string) {
    try {
        const db = createServerClient() as any
        await db
            .from('afa_orders')
            .update({ payment_status: 'failed', updated_at: new Date().toISOString() })
            .eq('reference_code', reference)
            .eq('payment_status', 'pending_payment')
    } catch (e) {
        console.error('[AFA Gateway] failAfaShopOrder error:', e)
    }
}
