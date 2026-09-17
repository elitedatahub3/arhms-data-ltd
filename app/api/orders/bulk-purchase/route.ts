import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { checkMtnRegistrationBatch, registrationRequiredBody } from '@/lib/mtn-registration-gate'
import { generateReferenceCode } from '@/lib/utils'
import { createRouteHandlerClient } from '@/lib/supabase-server'
import { cookies } from 'next/headers'
import { waitUntil } from '@vercel/functions'
import { Ratelimit } from '@upstash/ratelimit'
import { Redis } from '@upstash/redis'
import { checkFraudSignals, logSuspiciousActivity } from '@/lib/security'

// Lazy-init so a missing env var or exhausted Redis limit does not crash the module
let bulkRateLimit: Ratelimit | null = null
try {
    bulkRateLimit = new Ratelimit({
        redis: Redis.fromEnv(),
        limiter: Ratelimit.slidingWindow(1, '5 s'),
        prefix: 'rl:bulk-purchase',
    })
} catch (e) {
    console.error('[BulkPurchase] Redis init failed — rate limit disabled:', e)
}

interface BulkOrderItem {
    packageId: string
    phoneNumber: string
    packagePrice: number
}

interface FulfillmentOutcome {
    failed: boolean
    type: 'error' | 'skipped' | 'success'
    reason?: string
    referenceCode: string
    network: string
}

export async function POST(request: NextRequest) {
    try {
        const cookieStore = await cookies()
        const supabaseUserClient = await createRouteHandlerClient()
        const { data: { user: authUser }, error: authError } = await supabaseUserClient.auth.getUser()

        if (authError || !authUser) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const userId = authUser.id

        // === SUB-AGENT GATE: Block subs on bulk purchases (v1 scope) ===
        const supabase = createServerClient()
        const { data: subAgentData } = await supabase
            .from('sub_agents')
            .select('id')
            .eq('user_id', userId)
            .single()

        if (subAgentData) {
            return NextResponse.json(
                { error: 'Bulk purchase is not yet available for sub-agents. Use single purchase instead.' },
                { status: 403 }
            )
        }

        // Fail-open: if Redis is exhausted, allow the request rather than blocking
        try {
            if (bulkRateLimit) {
                const { success: rateLimitOk } = await bulkRateLimit.limit(userId)
                if (!rateLimitOk) {
                    return NextResponse.json({ error: 'Too many requests. Please wait a few seconds.' }, { status: 429 })
                }
            }
        } catch (rlErr) {
            console.error('[BulkPurchase] Rate limit check failed (Redis exhausted?), proceeding:', rlErr)
        }

        let body: { orders: BulkOrderItem[] }
        try {
            body = await request.json()
        } catch {
            return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
        }

        const { orders: rawOrders } = body

        if (!Array.isArray(rawOrders) || rawOrders.length === 0) {
            return NextResponse.json({ error: 'No orders provided' }, { status: 400 })
        }

        if (rawOrders.length > 20) {
            return NextResponse.json({ error: 'Maximum 20 orders per batch' }, { status: 400 })
        }

        // === SECURITY: Per-item validation and deduplication ===
        const uniqueKeys = new Set<string>()
        const orders: BulkOrderItem[] = []
        for (const order of rawOrders) {
            if (!order.phoneNumber || typeof order.phoneNumber !== 'string' || order.phoneNumber.replace(/\D/g, '').length < 9) {
                return NextResponse.json({ error: `Invalid phone number format for ${order.phoneNumber || 'unknown'}` }, { status: 400 })
            }
            if (!order.packageId || typeof order.packageId !== 'string') {
                return NextResponse.json({ error: 'Invalid package ID format' }, { status: 400 })
            }
            if (typeof order.packagePrice !== 'number' || order.packagePrice <= 0 || order.packagePrice > 1000) {
                return NextResponse.json({ error: `Invalid price for ${order.phoneNumber || 'unknown'}` }, { status: 400 })
            }
            
            const key = `${order.phoneNumber}-${order.packageId}`
            if (!uniqueKeys.has(key)) {
                uniqueKeys.add(key)
                orders.push(order)
            }
        }

        // === 1. Get user role ===
        const { data: userRoleData } = await supabase
            .from('users')
            .select('role, email, first_name, last_name')
            .eq('id', userId)
            .single()

        const isAgent = (userRoleData as any)?.role === 'agent'
        const isAdminUser = (userRoleData as any)?.role === 'admin' || (userRoleData as any)?.role === 'sub-admin'

        if (!isAgent && !isAdminUser) {
            return NextResponse.json({ error: 'Bulk orders are only available to agents and admins' }, { status: 403 })
        }

        // === 2. Validate all orders server-side ===
        const packageIds = [...new Set(orders.map(o => o.packageId))]
        const { data: packages, error: pkgsError } = await supabase
            .from('data_packages')
            .select('*')
            .in('id', packageIds)
            .eq('is_available', true)

        if (pkgsError || !packages) {
            return NextResponse.json({ error: 'Failed to load packages' }, { status: 500 })
        }

        const pkgMap = new Map(packages.map((p: any) => [p.id, p]))

        // Validate each order and compute authoritative prices
        const validatedOrders = orders.map((order) => {
            const pkg = pkgMap.get(order.packageId)
            if (!pkg) return { ...order, error: 'Package not found' }

            const authoritativePrice = (isAgent && (pkg as any).agent_price > 0)
                ? (pkg as any).agent_price
                : (pkg as any).price

            return {
                ...order,
                packagePrice: authoritativePrice,
                network: (pkg as any).network,
                size: (pkg as any).size,
                costPrice: (pkg as any).cost_price || 0,
            }
        })

        const invalidOrders = validatedOrders.filter((o: any) => o.error)
        if (invalidOrders.length > 0) {
            return NextResponse.json({ error: `Some packages are invalid: ${invalidOrders.map((o: any) => o.error).join(', ')}` }, { status: 400 })
        }

        // MTN registration gate. One upstream round trip for the whole batch, before
        // the wallet is touched. A single unregistered line refuses the WHOLE batch:
        // charging for part of a paste the agent submitted as one unit would leave them
        // reconciling which lines went through against which did not.
        const { unregistered } = await checkMtnRegistrationBatch(
            supabase,
            validatedOrders.map((o: any) => ({ phoneNumber: o.phoneNumber, packageNetwork: o.network }))
        )
        if (unregistered.length > 0) {
            return NextResponse.json(
                registrationRequiredBody(unregistered, validatedOrders.length),
                { status: 409 }
            )
        }

        // === 3. Calculate total and deduct atomically ===
        const totalCost = validatedOrders.reduce((sum, o: any) => sum + o.packagePrice, 0)

        // === SECURITY: Fraud Check for Admin/Agent ===
        const isFraud = await checkFraudSignals(userId, 'bulk_admin', supabase)
        if (isFraud) {
            await logSuspiciousActivity(userId, 'bulk_purchase', 'Fraud signals detected on bulk order', supabase)
            return NextResponse.json({ error: 'Bulk action blocked due to suspicious activity' }, { status: 403 })
        }

        const { data: deductResult, error: deductError } = await (supabase as any)
            .rpc('deduct_wallet_balance', {
                p_user_id: userId,
                p_amount: totalCost,
            })

        if (deductError) {
            if (deductError.message?.includes('INSUFFICIENT_BALANCE')) {
                return NextResponse.json({ error: 'Insufficient balance for all orders' }, { status: 400 })
            }
            console.error('Bulk wallet deduction error:', deductError)
            return NextResponse.json({ error: 'Failed to process payment' }, { status: 500 })
        }

        const walletRow = deductResult?.[0] || deductResult
        const walletId = walletRow?.wallet_id
        const newBalance = walletRow?.new_balance

        if (!walletId) {
            return NextResponse.json({ error: 'Wallet not found' }, { status: 404 })
        }

        // === 4. Insert all orders in one batch ===
        const referenceCodes = validatedOrders.map(() => generateReferenceCode())

        const orderInserts = validatedOrders.map((order: any, i) => ({
            user_id: userId,
            phone_number: order.phoneNumber,
            network: order.network,
            size: order.size,
            price: order.packagePrice,
            cost_price_at_time: order.costPrice,
            role_at_time: (userRoleData as any)?.role || 'customer',
            status: 'pending',
            payment_status: 'paid',
            reference_code: referenceCodes[i],
            fulfillment_method: 'auto',
        }))

        const { data: createdOrders, error: ordersError } = await (supabase.from('orders') as any)
            .insert(orderInserts)
            .select('id, reference_code, network, size, phone_number')

        if (ordersError) {
            console.error('Bulk order insert error:', ordersError)
            // Refund the full amount atomically using the RPC (same as single purchase)
            const { error: refundError } = await (supabase as any)
                .rpc('credit_wallet_balance', {
                    p_user_id: userId,
                    p_amount: totalCost,
                })
            if (refundError) {
                console.error('CRITICAL: Bulk refund RPC failed after order insert error', refundError)
            }
            return NextResponse.json({ error: 'Failed to create orders' }, { status: 500 })
        }

        // === 5. Insert all wallet transactions in one batch ===
        const txInserts = validatedOrders.map((order: any, i) => ({
            wallet_id: walletId,
            user_id: userId,
            type: 'debit',
            amount: order.packagePrice,
            description: `Bulk data purchase: ${order.size} for ${order.phoneNumber}`,
            reference: referenceCodes[i],
            source: 'purchase',
            status: 'completed',
        }))

        await (supabase.from('wallet_transactions') as any).insert(txInserts)

        // === 6. Insert a single summary notification ===
        await (supabase.from('notifications') as any).insert({
            user_id: userId,
            title: 'Bulk Order Placed',
            message: `${validatedOrders.length} orders have been placed successfully. Total: GHS ${totalCost.toFixed(2)}`,
            type: 'order_update',
            action_url: `/dashboard/my-orders`,
        })

        // === 7. Background: SMS + Fulfillment + Aggregated Admin Alert ===
        if (createdOrders && createdOrders.length > 0) {
            const userName = `${(userRoleData as any)?.first_name || ''} ${(userRoleData as any)?.last_name || ''}`.trim() || 'Customer'
            const userEmail = (userRoleData as any)?.email || 'Unknown'

            // Use waitUntil so the lambda stays alive after returning the response
            waitUntil((async () => {
                const allResults = await Promise.allSettled(
                    (createdOrders as any[]).map((order) =>
                        processOrderNotifications(order, { email: userEmail, name: userName })
                    )
                )

                // Collect all failures (API errors) and skips (disabled fulfillment)
                const exceptions: FulfillmentOutcome[] = allResults
                    .filter(r => r.status === 'fulfilled' && (r as PromiseFulfilledResult<FulfillmentOutcome>).value?.failed)
                    .map(r => (r as PromiseFulfilledResult<FulfillmentOutcome>).value)

                // Send ONE aggregated summary email to all admins if any exceptions
                if (exceptions.length > 0) {
                    const { sendAdminBulkOrderAlert } = await import('@/lib/email-service')
                    await sendAdminBulkOrderAlert({
                        totalOrders: createdOrders.length,
                        failureCount: exceptions.length,
                        failures: exceptions.map(e => ({
                            referenceCode: e.referenceCode,
                            network: e.network,
                            reason: e.reason || 'Unknown',
                            type: e.type as 'error' | 'skipped',
                        })),
                        customerName: userName,
                        customerEmail: userEmail,
                    }).catch(err => console.error('[BulkPurchase] Admin alert error:', err))
                }
            })())
        }

        return NextResponse.json({
            success: true,
            ordersPlaced: validatedOrders.length,
            totalCost,
            newBalance,
        })

    } catch (error) {
        console.error('Bulk purchase error:', error)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}

/**
 * Trigger fulfillment for one order.
 * Returns outcome so caller can aggregate for admin alert.
 */
async function processOrderNotifications(
    order: { id: string; reference_code: string; network: string; phone_number: string; size: string },
    user: { email: string; name: string }
): Promise<FulfillmentOutcome> {
    // No "order received" SMS — beneficiaries only hear from us on delivery.
    // On a bulk run this also stops one text per line item landing at once.
    return triggerFulfillment(order, user)
}

/**
 * Trigger fulfillment for a single order and return an outcome object.
 * Does NOT send any admin emails — caller aggregates outcomes.
 */
async function triggerFulfillment(
    order: { id: string; reference_code: string; network: string; phone_number: string; size: string },
    user: { email: string; name: string }
): Promise<FulfillmentOutcome> {
    const base: Omit<FulfillmentOutcome, 'failed' | 'type' | 'reason'> = {
        referenceCode: order.reference_code,
        network: order.network,
    }

    try {
        const { fulfillOrder } = await import('@/lib/fulfillment-service')
        const { syncShopOrderStatus } = await import('@/lib/shop-service')
        const supabase = createServerClient()

        const { data: settingsData } = await supabase
            .from('admin_settings')
            .select('key, value')
            .in('key', ['auto_fulfillment_enabled', 'fulfillment_settings'])

        const settingsMap = (settingsData || []).reduce((acc: any, curr: any) => {
            acc[curr.key] = curr.value
            return acc
        }, {})

        // Check global fulfillment switch
        if (String(settingsMap.auto_fulfillment_enabled) === 'false') {
            return { ...base, failed: true, type: 'skipped', reason: 'Global auto-fulfillment is disabled' }
        }

        // Check per-network fulfillment switch
        let fulfillmentSettings = { networks: {} as Record<string, boolean> }
        try {
            if (settingsMap.fulfillment_settings) {
                fulfillmentSettings = typeof settingsMap.fulfillment_settings === 'string'
                    ? JSON.parse(settingsMap.fulfillment_settings)
                    : settingsMap.fulfillment_settings
            }
        } catch { /* ignore parse errors */ }

        if (fulfillmentSettings.networks[order.network] === false) {
            return { ...base, failed: true, type: 'skipped', reason: `Auto-fulfillment is disabled for network: ${order.network}` }
        }

        // Avoid double-fulfilling
        const { data: existingTracking } = await supabase
            .from('mtn_fulfillment_tracking').select('status').eq('order_id', order.id).single()
        if (existingTracking) return { ...base, failed: false, type: 'success' }

        // Call fulfillment API
        const result = await fulfillOrder(order.network, order.phone_number, order.size, order.id)

        if (result.success) {
            await (supabase.from('mtn_fulfillment_tracking') as any).insert({
                order_id: order.id,
                status: 'processing',
                api_response: result.apiResponse || { reference: result.reference, network: order.network },
            })
            await (supabase.from('orders') as any)
                .update({ status: 'processing', updated_at: new Date().toISOString() })
                .eq('id', order.id)

            // Sync status to healing wrapper so shop owners see it
            await syncShopOrderStatus(order.id, 'processing').catch(err => 
                console.error(`[BulkFulfillment] syncShopOrderStatus failed for ${order.id}:`, err)
            )

            return { ...base, failed: false, type: 'success' }
        } else {
            await (supabase.from('mtn_fulfillment_tracking') as any).insert({
                order_id: order.id,
                status: 'failed',
                api_response: { error: result.error, network: order.network, ...result.apiResponse },
            })
            return {
                ...base,
                failed: true,
                type: 'error',
                reason: `Auto-fulfillment API error: ${result.error || 'Unknown error'}`
            }
        }
    } catch (error: any) {
        console.error(`[BulkFulfillment] Error processing order ${order.id}:`, error)
        return { ...base, failed: true, type: 'error', reason: `Exception: ${error?.message || 'Unknown'}` }
    }
}

