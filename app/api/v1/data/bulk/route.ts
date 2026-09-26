import { NextRequest, NextResponse } from 'next/server'
import {
    validateApiKey, isApiError, apiSuccess, apiError,
    logApiRequest, getClientIp,
} from '@/lib/api-auth'
import { generateReferenceCode } from '@/lib/utils'

const ENDPOINT = '/api/v1/data/bulk'
const MAX_ORDERS = 100

export async function POST(request: NextRequest) {
    const startTime = Date.now()
    const ip = getClientIp(request)

    const auth = await validateApiKey(request)
    if (isApiError(auth)) {
        logApiRequest({ apiKeyId: null, userId: null, endpoint: ENDPOINT, method: 'POST', statusCode: (auth as any).status, responseTimeMs: Date.now() - startTime, ip, errorMessage: 'Auth failed' })
        return auth
    }

    const { userId, apiKeyId, userRole, supabase } = auth

    let body: any
    try { body = await request.json() } catch {
        return apiError(400, 'Invalid JSON body')
    }

    const { orders: rawOrders } = body

    if (!Array.isArray(rawOrders) || rawOrders.length === 0) {
        return apiError(400, 'orders must be a non-empty array')
    }

    if (rawOrders.length > MAX_ORDERS) {
        return apiError(400, `Maximum ${MAX_ORDERS} orders per bulk request`)
    }

    // Validate all order shapes first
    const validNetworks = ['MTN', 'Telecel', 'AT']
    for (let i = 0; i < rawOrders.length; i++) {
        const o = rawOrders[i]
        if (!o.network || !o.volume_gb || !o.recipient) {
            return apiError(400, `Order at index ${i}: network, volume_gb, and recipient are required`)
        }
        if (!validNetworks.includes(o.network)) {
            return apiError(400, `Order at index ${i}: invalid network "${o.network}"`)
        }
        const phone = String(o.recipient).replace(/\s+/g, '')
        if (!/^(0\d{9}|233\d{9})$/.test(phone)) {
            return apiError(400, `Order at index ${i}: invalid recipient phone "${o.recipient}"`)
        }
    }

    // Fetch all available packages once
    const { data: allPackages } = await (supabase.from('data_packages') as any)
        .select('id, network, size, price, agent_price, cost_price')
        .eq('is_available', true)

    const packages = allPackages || []

    // Resolve package + price for each order
    const { data: userExpiry } = await supabase
        .from('users')
        .select('agent_expires_at')
        .eq('id', userId)
        .single()

    const agentExpired = (userExpiry as any)?.agent_expires_at
        && new Date((userExpiry as any).agent_expires_at) < new Date()
    const isActiveAgent = userRole === 'agent' && !agentExpired

    const resolved: Array<{ pkg: any; price: number; phone: string; clientRef?: string }> = []
    let totalCost = 0

    for (let i = 0; i < rawOrders.length; i++) {
        const o = rawOrders[i]
        const sizeQuery = String(o.volume_gb).replace(/gb/i, '').trim()
        const pkg = packages.find((p: any) =>
            p.network === o.network &&
            p.size.toLowerCase().replace(/\s+/g, '').includes(sizeQuery.toLowerCase())
        )
        if (!pkg) {
            return apiError(404, `Order at index ${i}: no available package for ${o.network} ${o.volume_gb}`)
        }
        const price = isActiveAgent && pkg.agent_price > 0 ? pkg.agent_price : pkg.price
        resolved.push({ pkg, price, phone: String(o.recipient).replace(/\s+/g, ''), clientRef: o.reference })
        totalCost += price
    }

    // NOTE: the MTN registration gate deliberately does NOT run here. This endpoint no
    // longer returns 409 MTN_NOT_REGISTERED, and acknowledge_registration is accepted
    // but ignored — see app/api/orders/purchase/route.ts for the reasoning.

    // Single atomic wallet deduction for total
    const { data: deductResult, error: deductError } = await (supabase as any).rpc('deduct_wallet_balance', {
        p_user_id: userId,
        p_amount: totalCost,
    })

    if (deductError) {
        if (deductError.message?.includes('INSUFFICIENT_BALANCE')) {
            logApiRequest({ apiKeyId, userId, endpoint: ENDPOINT, method: 'POST', statusCode: 402, responseTimeMs: Date.now() - startTime, ip, errorMessage: 'Insufficient balance' })
            return apiError(402, `Insufficient balance. Total required: GHS ${totalCost.toFixed(2)}`)
        }
        logApiRequest({ apiKeyId, userId, endpoint: ENDPOINT, method: 'POST', statusCode: 500, responseTimeMs: Date.now() - startTime, ip, errorMessage: deductError.message })
        return apiError(500, 'Payment processing failed')
    }

    const walletRow = deductResult?.[0] || deductResult
    const walletId = walletRow?.wallet_id
    const newBalance = walletRow?.new_balance

    if (!walletId) return apiError(404, 'Wallet not found')

    // Create all orders
    const orderInserts = resolved.map(({ pkg, price, phone, clientRef }) => ({
        user_id:            userId,
        phone_number:       phone,
        network:            pkg.network,
        size:               pkg.size,
        price,
        cost_price_at_time: pkg.cost_price || 0,
        role_at_time:       userRole,
        status:             'pending',
        payment_status:     'paid',
        reference_code:     clientRef || generateReferenceCode(),
        fulfillment_method: 'auto',
        source:             'api',
        api_key_id:         apiKeyId,
    }))

    const { data: createdOrders, error: insertError } = await (supabase.from('orders') as any)
        .insert(orderInserts)
        .select('id, reference_code, network, size, phone_number')

    if (insertError) {
        // Refund full amount
        await (supabase as any).rpc('credit_wallet_balance', { p_user_id: userId, p_amount: totalCost }).catch(() => {})
        logApiRequest({ apiKeyId, userId, endpoint: ENDPOINT, method: 'POST', statusCode: 500, responseTimeMs: Date.now() - startTime, ip, errorMessage: insertError.message })
        return apiError(500, 'Failed to create orders')
    }

    // Wallet transactions (fire-and-forget)
    const txInserts = resolved.map(({ price, phone, pkg }, idx) => ({
        wallet_id:   walletId,
        user_id:     userId,
        type:        'debit',
        amount:      price,
        description: `API Bulk: ${pkg.network} ${pkg.size} → ${phone}`,
        reference:   (createdOrders as any[])[idx]?.reference_code,
        source:      'api_bulk',
        status:      'completed',
    }))
    ;(supabase.from('wallet_transactions') as any).insert(txInserts).then(() => {}).catch(() => {})

    logApiRequest({ apiKeyId, userId, endpoint: ENDPOINT, method: 'POST', statusCode: 201, responseTimeMs: Date.now() - startTime, ip })

    return apiSuccess({
        orders_created: (createdOrders as any[]).map((o: any) => ({
            order_id:  o.id,
            reference: o.reference_code,
            status:    'pending',
            network:   o.network,
            size:      o.size,
            recipient: o.phone_number,
        })),
        total_charged:  totalCost,
        wallet_balance: newBalance,
    })
}
