/**
 * Buy a data bundle from a user's wallet — the whole sequence, in one place.
 *
 * Extracted from app/api/orders/purchase/route.ts so the dashboard and USSD member
 * orders charge, record and fulfil a bundle identically: price from
 * resolveDataPrice(), an atomic wallet deduction, the order row, the ledger and
 * notifications, then supplier fulfilment. The route keeps what is genuinely its
 * own — auth, rate limiting, input validation and the MTN registration gate.
 */
import { resolveDataPrice } from '@/lib/data-order-pricing'
import { triggerFulfillment } from '@/lib/order-fulfillment-dispatcher'
import { generateReferenceCode } from '@/lib/utils'
import { sendAdminNewOrderAlert } from '@/lib/email-service'
import { sendAdminAgentOrderAlert } from '@/lib/sms-service'
import { sendPushToUser, sendPushToAdmins } from '@/lib/web-push'

/**
 * One flat shape rather than a discriminated union: the project does not compile in
 * strict mode, where `if (!result.ok)` does not narrow a union. `ok` says which
 * fields to read — error/status/body when false, order and friends when true.
 */
export interface WalletDataPurchaseResult {
    ok: boolean
    error?: string
    status?: number
    /** A refusal's own response body (e.g. the MTN registration 409). */
    body?: any
    isDuplicate?: boolean
    order?: { id: string; reference_code: string; status: string }
    price?: number
    newBalance?: number
    network?: string
    size?: string
}

export async function purchaseDataWithWallet(params: {
    /** Service-role client. */
    supabase: any
    userId: string
    packageId: string
    phoneNumber: string
    /** Idempotency key: a repeat with the same reference returns the first order. */
    referenceCode?: string | null
    /**
     * Last check before any money moves, given the package. Return a refusal to
     * stop the purchase with nothing charged — the dashboard's MTN registration
     * gate runs here, exactly where it always sat in the route.
     */
    beforeCharge?: (pkg: any) => Promise<{ status: number; body: any } | null>
}): Promise<WalletDataPurchaseResult> {
    const { supabase, userId, packageId, phoneNumber } = params
    const clientReferenceCode = params.referenceCode || null

    // === IDEMPOTENCY: a repeated reference returns the order it already made ===
    if (clientReferenceCode) {
        const { data: existingOrder } = await supabase
            .from('orders')
            .select('id, reference_code, status')
            .eq('reference_code', clientReferenceCode)
            .maybeSingle()

        if (existingOrder) {
            console.log('[Purchase] Duplicate request blocked for client reference')
            return {
                ok: true,
                isDuplicate: true,
                order: {
                    id: existingOrder.id,
                    reference_code: existingOrder.reference_code,
                    status: existingOrder.status,
                },
            }
        }
    }

    const { data: pkg, error: pkgError } = await supabase
        .from('data_packages')
        .select('*')
        .eq('id', packageId)
        .eq('is_available', true)
        .single()

    if (pkgError || !pkg) {
        return { ok: false, error: 'Package not found', status: 404 }
    }

    const { data: blacklisted } = await supabase
        .from('phone_blacklist')
        .select('id')
        .eq('phone_number', phoneNumber)
        .single()

    if (blacklisted) {
        return { ok: false, error: 'This phone number is not allowed', status: 400 }
    }

    if (params.beforeCharge) {
        const refusal = await params.beforeCharge(pkg)
        if (refusal) {
            return { ok: false, error: refusal.body?.error || 'Refused', status: refusal.status, body: refusal.body }
        }
    }

    // Resolve the authoritative price (sub-agent gates + role pricing)
    const priceResult = await resolveDataPrice(supabase, userId, pkg)
    if (!priceResult.ok || !priceResult.data) {
        return { ok: false, error: priceResult.error || 'Failed to resolve price', status: priceResult.status || 500 }
    }

    const { price: priceToCharge, role: userRole } = priceResult.data
    const isAgent = userRole === 'agent'

    // === SECURITY: Atomic wallet deduction (prevents double-spend) ===
    const { data: deductResult, error: deductError } = await supabase
        .rpc('deduct_wallet_balance', {
            p_user_id: userId,
            p_amount: priceToCharge,
        })

    if (deductError) {
        if (deductError.message?.includes('INSUFFICIENT_BALANCE')) {
            return { ok: false, error: 'Insufficient balance', status: 400 }
        }
        console.error('Wallet deduction error:', deductError)
        return { ok: false, error: 'Failed to process payment', status: 500 }
    }

    const walletRow = deductResult?.[0] || deductResult
    const walletId = walletRow?.wallet_id
    const newBalance = walletRow?.new_balance

    if (!walletId) {
        return { ok: false, error: 'Wallet not found', status: 404 }
    }

    const referenceCode = clientReferenceCode || generateReferenceCode()

    // Create order AFTER successful deduction
    const { data: order, error: orderError } = await supabase
        .from('orders')
        .insert({
            user_id: userId,
            phone_number: phoneNumber,
            network: pkg.network,
            size: pkg.size,
            price: priceToCharge,
            cost_price_at_time: pkg.cost_price || 0,
            role_at_time: userRole || 'customer',
            status: 'pending',
            payment_status: 'paid',
            reference_code: referenceCode,
            fulfillment_method: 'auto',
        })
        .select()
        .single()

    if (orderError) {
        console.error('Order creation error:', orderError)
        // Refund the deducted amount atomically since order failed. A unique-
        // reference collision lands here too, so two racing settlements of one
        // USSD payment end with one order and one refund, never two charges.
        const { error: refundError } = await supabase
            .rpc('credit_wallet_balance', {
                p_user_id: userId,
                p_amount: priceToCharge,
            })

        if (refundError) {
            console.error('CRITICAL: Refund RPC failed', refundError)
        }
        return { ok: false, error: 'Failed to create order', status: 500 }
    }

    // === PERFORMANCE: Create wallet transaction (non-blocking, fire-and-forget) ===
    ;(supabase.from('wallet_transactions') as any).insert({
        wallet_id: walletId,
        user_id: userId,
        type: 'debit',
        amount: priceToCharge,
        description: `Data purchase: ${pkg.size} for ${phoneNumber}`,
        reference: referenceCode,
        source: 'purchase',
        status: 'completed',
    }).then(() => {}).catch((e: any) => console.error('[Purchase] Tx insert error:', e))

    // === PERFORMANCE: Create notification + web push (fire-and-forget) ===
    const progressMessage = `Your order for ${pkg.size} to ${phoneNumber} has been placed and is being processed.`

    ;(supabase.from('notifications') as any).insert({
        user_id: userId,
        title: 'Order Placed',
        message: progressMessage,
        type: 'order_update',
        action_url: `/dashboard/my-orders`,
    }).then(() => {}).catch((e: any) => console.error('[Purchase] Notification error:', e))

    await sendPushToUser(userId, {
        title: 'Order Placed',
        body: `Your ${pkg.size} bundle for ${phoneNumber} is being processed.`,
        url: '/dashboard/my-orders',
    }).catch((e: any) => console.error('[Purchase] Push error:', e))

    // === NOTIFICATIONS & AUTO-FULFILLMENT: Awaited to ensure Vercel doesn't kill process ===
    try {
        const { data: userData, error: userFetchError } = await supabase
            .from('users')
            .select('email, first_name, last_name, phone_number, role')
            .eq('id', userId)
            .single()

        if (userFetchError || !userData) {
            console.error('[Purchase] Post-purchase user fetch failed:', userFetchError)
        } else {
            const userEmail = userData.email
            const firstName = userData.first_name || 'Customer'

            // No "order received" SMS from here — triggerFulfillment sends one once
            // the supplier has actually accepted the order.

            if (isAgent) {
                await sendAdminAgentOrderAlert()
                    .catch((err: Error) => console.error('[Purchase] Admin agent alert failed:', err))
            }

            await sendPushToAdmins({
                title: 'New Data Order',
                body: `${firstName} · ${pkg.network} ${pkg.size} → ${phoneNumber} (GHS ${Number(priceToCharge).toFixed(2)})`,
                url: '/admin/orders',
            }).catch(() => {})

            // An unregistered MTN recipient is not special-cased here. The supplier
            // rejects it, auto-submits the number to MTN, and the order stays pending
            // for the auto-refulfill cron — the behaviour that predates the gate.
            if (pkg.network === 'EXPRESS MTN') {
                // EXPRESS MTN is always manual — skip auto-fulfillment, just alert admin
                await sendAdminNewOrderAlert({
                    referenceCode: order.reference_code,
                    phoneNumber: order.phone_number,
                    network: order.network,
                    size: order.size,
                    price: priceToCharge,
                    customerName: `${firstName} ${userData.last_name || ''}`.trim() || 'Customer',
                    customerEmail: userEmail || 'Unknown',
                    source: 'main_site' as const,
                    reason: 'EXPRESS MTN — Manual fulfillment required'
                }).catch(err => console.error('[Purchase] EXPRESS MTN admin alert failed:', err))
            } else {
                await triggerFulfillment(order.id, pkg.network, {
                    email: userEmail || 'Unknown',
                    name: `${firstName} ${userData.last_name || ''}`.trim() || 'Customer'
                })
            }
        }
    } catch (postPurchaseError) {
        console.error('[Purchase] Post-purchase notification/fulfillment failed:', postPurchaseError)
    }

    return {
        ok: true,
        isDuplicate: false,
        order: { id: order.id, reference_code: referenceCode, status: 'pending' },
        price: priceToCharge,
        newBalance,
        network: pkg.network,
        size: pkg.size,
    }
}
