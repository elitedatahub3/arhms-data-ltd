/**
 * Results Checker Voucher – Wallet Checkout Flow
 *
 * Performs an atomic: wallet deduction → order creation → inventory reservation → finalization.
 * On any failure, refunds the wallet and marks the order as failed.
 */

import { createServerClient } from '@/lib/supabase'
import { calculateRCPrice, getRCTypeById } from '@/lib/vouchers/pricing'
import { creditShopRcProfit } from '@/lib/shop-service'

export interface RCVoucher {
    id: string
    pin: string
    serial_number: string
}

export interface WalletPurchaseResult {
    order: Record<string, unknown>
    vouchers: RCVoucher[]
    newBalance: number
}

export async function purchaseWithWallet(params: {
    userId: string
    userRole: string
    typeId: string
    quantity: number
    customerName?: string
    customerEmail?: string
    customerPhone?: string
    /**
     * Fixed unit price, bypassing role/bulk pricing.
     *
     * Used by the sub-agent portal, where the price is whatever the sub's Lead
     * charges rather than anything derived from the sub's own role. Still
     * floored at cost_price below — a Lead cannot sell the platform's stock at
     * a loss.
     */
    unitPriceOverride?: number
    /** Parent shop to attribute the sale to, and credit. Sub purchases only. */
    shopId?: string
    shopName?: string
    shopOwnerId?: string
    /**
     * Caller-supplied reference, used instead of the generated one.
     *
     * The v2 API takes it as an idempotency key, so it has to reach the row —
     * a generated reference could not be looked up again on a retry. Unique
     * table-wide, so a collision surfaces as ORDER_CREATION_FAILED.
     */
    referenceCode?: string
    /** API key that placed the order. Null for dashboard and sub-agent purchases. */
    apiKeyId?: string
}): Promise<WalletPurchaseResult> {
    const {
        userId, userRole, typeId, quantity, customerName, customerEmail, customerPhone,
        unitPriceOverride, shopId, shopName, shopOwnerId, referenceCode: clientReference, apiKeyId,
    } = params
    const supabase = createServerClient()

    // 1. Fetch and validate the voucher type
    const type = await getRCTypeById(supabase, typeId)
    if (!type || !type.is_active) {
        throw new Error('PRODUCT_NOT_AVAILABLE')
    }

    // Role/bulk pricing, unless a fixed price was supplied. The cost floor is
    // enforced either way: calculateRCPrice throws on it, and the override is
    // checked here.
    let breakdown: Awaited<ReturnType<typeof calculateRCPrice>>
    let shopMarkup = 0

    if (unitPriceOverride != null) {
        if (!(unitPriceOverride > 0) || unitPriceOverride < type.cost_price) {
            throw new Error('PRICING_ERROR_UNIT_BELOW_COST')
        }
        const subtotal = parseFloat((unitPriceOverride * quantity).toFixed(2))
        breakdown = {
            unitPrice: unitPriceOverride,
            isBulk: false,
            matchedTier: null,
            shopMarkup: 0,
            subtotal,
            paystackFee: 0,
            total: subtotal,
        }
        shopMarkup = parseFloat(((unitPriceOverride - type.cost_price) * quantity).toFixed(2))
    } else {
        breakdown = await calculateRCPrice({ type, quantity, userRole })
    }

    // 2. Atomically deduct wallet balance via existing RPC
    const { data: walletData, error: deductError } = await (supabase as any).rpc(
        'deduct_wallet_balance',
        { p_user_id: userId, p_amount: breakdown.total }
    )

    if (deductError || !walletData) {
        throw new Error('INSUFFICIENT_BALANCE')
    }

    // deduct_wallet_balance RETURNS TABLE, so PostgREST hands back an array of rows
    const walletRow = Array.isArray(walletData) ? walletData[0] : walletData
    const new_balance = walletRow?.new_balance
    const wallet_id = walletRow?.wallet_id

    if (!wallet_id) {
        throw new Error('INSUFFICIENT_BALANCE')
    }

    // 3. Create order record in pending state
    // Random suffix, not just the clock. reference_code is UNIQUE, so two
    // purchases landing in the same millisecond used to fail order creation
    // outright; now it also keys the Lead's credit, where a collision would
    // silently drop the second payment as "already credited".
    const referenceCode = clientReference || `RC-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const { data: order, error: orderError } = await (supabase
        .from('results_checker_orders') as any)
        .insert({
            user_id: userId,
            user_role: userRole,
            customer_name: customerName,
            customer_email: customerEmail,
            customer_phone: customerPhone,
            type_id: typeId,
            type_name: type.name,
            quantity,
            unit_price: breakdown.unitPrice,
            cost_price_at_time: type.cost_price,
            total_paid: breakdown.total,
            // Null on an ordinary purchase; set when a sub buys through their Lead.
            shop_id: shopId ?? null,
            shop_name: shopName ?? null,
            shop_markup: shopMarkup,
            merchant_commission: shopMarkup,
            status: 'pending',
            payment_status: 'pending',
            reference_code: referenceCode,
            api_key_id: apiKeyId ?? null,
        })
        .select()
        .single()

    if (orderError || !order) {
        // Refund immediately if order insertion fails
        try {
            const { data: wallet } = await (supabase.from('wallets') as any).select('balance, total_spent').eq('id', wallet_id).single()
            if (wallet) {
                await (supabase as any).from('wallets').update({
                    balance: Number(wallet.balance) + Number(breakdown.total),
                    total_spent: Math.max(0, Number(wallet.total_spent || 0) - Number(breakdown.total)),
                    updated_at: new Date().toISOString()
                }).eq('id', wallet_id)
            }
        } catch(e) { console.error('Manual refund failed', e) }
        throw new Error('ORDER_CREATION_FAILED')
    }

    try {
        // 4. Reserve vouchers atomically (all-or-nothing via DB RPC)
        const { data: vouchers, error: assignError } = await (supabase as any).rpc(
            'assign_results_checker_vouchers',
            { p_type_id: typeId, p_quantity: quantity, p_order_id: order.id }
        )

        if (assignError) {
            console.error('[Assign Vouchers Error]', assignError)
            throw new Error('INSUFFICIENT_INVENTORY')
        }
        if (!vouchers || vouchers.length === 0) {
            throw new Error('INSUFFICIENT_INVENTORY')
        }

        // 5. Mark vouchers as sold
        await (supabase as any).rpc('finalize_results_checker_sale', {
            p_order_id: order.id,
            p_user_id: userId,
        })

        // 6. Complete the order
        await (supabase.from('results_checker_orders') as any)
            .update({
                status: 'completed',
                payment_status: 'completed',
                inventory_ids: vouchers.map((v: RCVoucher) => v.id),
                fulfilled_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
            })
            .eq('id', order.id)

        // 7. Credit the Lead on a sub purchase. Idempotent on the reference, and
        //    deliberately after the order is completed — a wallet write must
        //    never be what stops a paid-for voucher being handed over.
        if (shopOwnerId && shopMarkup > 0) {
            try {
                await creditShopRcProfit({
                    ownerId: shopOwnerId,
                    amount: shopMarkup,
                    description: `RC Voucher sale by sub-agent: ${type.name} x${quantity}`,
                    reference: referenceCode,
                })
            } catch (err) {
                console.error('[RC Wallet] Parent credit error:', err)
            }
        }

        // 8. Deliver vouchers via email/SMS (await to prevent serverless function cutoff)
        try {
            const { deliverVouchers } = await import('@/lib/vouchers/notifications')
            await deliverVouchers(order, vouchers)
        } catch (err) {
            console.error('[RC Wallet] Delivery error:', err)
        }

        return { order, vouchers, newBalance: new_balance }
    } catch (err) {
        // Fail-safe: refund wallet and mark order failed
        try {
            const { data: wallet } = await (supabase.from('wallets') as any).select('balance, total_spent').eq('id', wallet_id).single()
            if (wallet) {
                await (supabase as any).from('wallets').update({
                    balance: Number(wallet.balance) + Number(breakdown.total),
                    total_spent: Math.max(0, Number(wallet.total_spent || 0) - Number(breakdown.total)),
                    updated_at: new Date().toISOString()
                }).eq('id', wallet_id)
            }
        } catch(e) { console.error('Manual refund failed', e) }
        await (supabase.from('results_checker_orders') as any)
            .update({ status: 'failed', updated_at: new Date().toISOString() })
            .eq('id', order.id)
        throw err
    }
}

/**
 * Finalize a Results Checker order that was paid via Paystack gateway.
 * Called from the webhook processor after payment is verified.
 */
export async function finalizeRCGatewayOrder(params: {
    reference: string
    paidAmountKobo: number
    metadata?: Record<string, unknown>
}): Promise<{ success: boolean; alreadyProcessed?: boolean }> {
    const { reference, paidAmountKobo } = params
    const supabase = createServerClient()

    // 1. Idempotency check: load the order
    const { data: order, error: orderFetchError } = await (supabase
        .from('results_checker_orders') as any)
        .select('*')
        .eq('reference_code', reference)
        .single()

    if (orderFetchError || !order) {
        console.error('[RC Gateway] Order not found:', reference)
        return { success: false }
    }

    if (order.status === 'completed') {
        return { success: true, alreadyProcessed: true }
    }

    // 2. Amount verification (allow ±5 kobo rounding tolerance)
    const expectedKobo = Math.round(order.total_paid * 100)
    if (Math.abs(paidAmountKobo - expectedKobo) > 5) {
        console.error(`[RC Gateway] Amount mismatch on ${reference}: expected ${expectedKobo}, got ${paidAmountKobo}`)
        throw new Error('AMOUNT_MISMATCH')
    }

    // 3. Reserve vouchers
    const { data: vouchers, error: assignError } = await (supabase as any).rpc(
        'assign_results_checker_vouchers',
        { p_type_id: order.type_id, p_quantity: order.quantity, p_order_id: order.id }
    )

    if (assignError || !vouchers || vouchers.length === 0) {
        // Out of stock: mark payment as complete but leave fulfillment pending for manual action
        console.warn('[RC Gateway] Out of stock on', reference, '- flagging for manual fulfillment')
        await (supabase.from('results_checker_orders') as any)
            .update({ payment_status: 'completed', updated_at: new Date().toISOString() })
            .eq('id', order.id)
        return { success: true }
    }

    // 4. Mark vouchers as sold and complete the order
    await (supabase as any).rpc('finalize_results_checker_sale', {
        p_order_id: order.id,
        p_user_id: order.user_id ?? null,
    })

    await (supabase.from('results_checker_orders') as any)
        .update({
            status: 'completed',
            payment_status: 'completed',
            inventory_ids: vouchers.map((v: RCVoucher) => v.id),
            fulfilled_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
        })
        .eq('id', order.id)

    // 4b. Credit the shop's markup on storefront sales.
    //
    // Storefront RC orders use an `RC-SHOP-` reference, which also matches the
    // `RC-` branch every payment webhook dispatches on — so settlement usually
    // lands here, not in /api/shop/rc/verify. That route holds the only other
    // copy of this credit and skips it once the order is already `completed`,
    // so without this the shop owner silently lost their entire markup whenever
    // the webhook beat the browser poll (i.e. nearly always).
    //
    // creditShopRcProfit is idempotent on the reference, so the two paths racing
    // each other still credits exactly once.
    if (order.shop_id && Number(order.shop_markup) > 0) {
        const { data: shop } = await (supabase.from('shop_profiles') as any)
            .select('owner_id')
            .eq('id', order.shop_id)
            .maybeSingle()

        if (shop?.owner_id) {
            await creditShopRcProfit({
                ownerId: shop.owner_id,
                amount: Number(order.shop_markup),
                description: `RC Voucher sale: ${order.type_name} x${order.quantity}`,
                reference,
            })
        }
    }

    // 5. Deliver vouchers asynchronously (await to prevent serverless function cutoff)
    try {
        const { deliverVouchers } = await import('@/lib/vouchers/notifications')
        await deliverVouchers(order, vouchers)
    } catch (err) {
        console.error('[RC Gateway] Delivery error:', err)
    }

    return { success: true }
}







