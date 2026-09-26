import { NextRequest } from 'next/server'
import {
    validateApiKey, isApiError, apiSuccessV2, apiError,
    logApiRequest, getClientIp, enforceRateLimit,
} from '@/lib/api-auth'
import { generateReferenceCode } from '@/lib/utils'
import {
    dataNetworkError, normaliseRecipient, findPackageForSize, isDuplicateReferenceError,
} from '@/lib/api-v2-networks'

/**
 * Batch purchase. Atomic in the sense the docs promise: every order is validated and
 * priced before the wallet is touched, so a bad entry at index 40 costs nothing.
 */
const ENDPOINT = '/api/v2/data/bulk'
const MAX_ORDERS = 100

export async function POST(request: NextRequest) {
    const startTime = Date.now()
    const ip = getClientIp(request)

    const auth = await validateApiKey(request, { version: 'v2', kind: 'standard' })
    if (isApiError(auth)) {
        logApiRequest({ apiKeyId: null, userId: null, endpoint: ENDPOINT, method: 'POST', statusCode: (auth as any).status, responseTimeMs: Date.now() - startTime, ip, errorMessage: 'Auth failed' })
        return auth
    }

    const limited = await enforceRateLimit(auth, 'bulk')
    if (limited) return limited

    const { userId, apiKeyId, userRole, supabase } = auth

    const { data: subAgentData } = await supabase
        .from('sub_agents')
        .select('id')
        .eq('user_id', userId)
        .single()

    if (subAgentData) {
        logApiRequest({ apiKeyId, userId, endpoint: ENDPOINT, method: 'POST', statusCode: 403, responseTimeMs: Date.now() - startTime, ip, errorMessage: 'Sub-agents not supported on the API' })
        return apiError(403, 'Sub-agents are not yet available on the API. Please use the dashboard instead.')
    }

    let body: any
    try { body = await request.json() } catch {
        return apiError(400, 'Invalid JSON body')
    }

    const rawOrders = body?.orders

    if (!Array.isArray(rawOrders) || rawOrders.length === 0) {
        return apiError(400, 'orders must be a non-empty array')
    }
    if (rawOrders.length > MAX_ORDERS) {
        return apiError(400, `Maximum ${MAX_ORDERS} orders per bulk request`)
    }

    // Shape validation for the whole batch first — nothing is charged until every
    // entry is known good.
    const phones: string[] = []
    for (let i = 0; i < rawOrders.length; i++) {
        const o = rawOrders[i]
        if (!o?.network || o?.volume_gb === undefined || o?.volume_gb === null || !o?.recipient) {
            return apiError(400, `Order at index ${i}: network, volume_gb, and recipient are required`)
        }
        const networkError = dataNetworkError(o.network)
        if (networkError) return apiError(400, `Order at index ${i}: ${networkError}`)

        const phone = normaliseRecipient(o.recipient)
        if (!phone) return apiError(400, `Order at index ${i}: invalid recipient phone "${o.recipient}"`)
        phones.push(phone)
    }

    // Duplicate references inside one batch would collide on orders.reference_code
    // and fail the insert AFTER the wallet was debited. Caught here instead.
    const refs = rawOrders.map((o: any) => o.reference).filter(Boolean)
    if (new Set(refs).size !== refs.length) {
        return apiError(400, 'Duplicate reference values within the batch')
    }

    if (refs.length > 0) {
        const { data: clashes } = await (supabase.from('orders') as any)
            .select('reference_code')
            .in('reference_code', refs)

        if ((clashes as any[])?.length) {
            const taken = (clashes as any[]).map(c => c.reference_code).join(', ')
            return apiError(409, `These references have already been used: ${taken}`)
        }
    }

    const { data: allPackages } = await (supabase.from('data_packages') as any)
        .select('id, network, size, price, agent_price, cost_price')
        .eq('is_available', true)

    const packages = ((allPackages as any[]) || [])

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
        const candidates = packages.filter((p: any) => p.network === o.network)
        const pkg = findPackageForSize(candidates, o.volume_gb)

        if (!pkg) {
            return apiError(404, `Order at index ${i}: no available package for ${o.network} ${o.volume_gb}`)
        }
        const price = isActiveAgent && pkg.agent_price > 0 ? pkg.agent_price : pkg.price
        resolved.push({ pkg, price, phone: phones[i], clientRef: o.reference })
        totalCost += price
    }

    totalCost = Math.round((totalCost + Number.EPSILON) * 100) / 100

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
        .select('id, reference_code, network, size, phone_number, price')

    if (insertError) {
        await (supabase as any).rpc('credit_wallet_balance', { p_user_id: userId, p_amount: totalCost }).catch(() => {})

        // The pre-flight check above catches references already taken at the time it
        // ran; a concurrent batch can still claim one in between.
        if (isDuplicateReferenceError(insertError)) {
            logApiRequest({ apiKeyId, userId, endpoint: ENDPOINT, method: 'POST', statusCode: 409, responseTimeMs: Date.now() - startTime, ip, errorMessage: 'Duplicate reference' })
            return apiError(409, 'One of the references in this batch is already in use. Nothing was charged.')
        }

        logApiRequest({ apiKeyId, userId, endpoint: ENDPOINT, method: 'POST', statusCode: 500, responseTimeMs: Date.now() - startTime, ip, errorMessage: insertError.message })
        return apiError(500, 'Failed to create orders')
    }

    const created = (createdOrders as any[]) || []

    // Matched by reference rather than array index: Postgres does not guarantee the
    // RETURNING order matches the insert order, and pairing the wrong price to the
    // wrong order would put a wrong number in the customer's ledger.
    const priceByRef = new Map(orderInserts.map(o => [o.reference_code, o]))
    const txInserts = created.map((o: any) => {
        const src = priceByRef.get(o.reference_code)
        return {
            wallet_id:   walletId,
            user_id:     userId,
            type:        'debit',
            amount:      src?.price ?? o.price,
            description: `API Bulk: ${o.network} ${o.size} → ${o.phone_number}`,
            reference:   o.reference_code,
            source:      'api_bulk',
            status:      'completed',
        }
    })
    ;(supabase.from('wallet_transactions') as any).insert(txInserts).then(() => {}).catch(() => {})

    logApiRequest({ apiKeyId, userId, endpoint: ENDPOINT, method: 'POST', statusCode: 201, responseTimeMs: Date.now() - startTime, ip })

    return apiSuccessV2({
        orders_placed: created.length,
        total_cost:    totalCost,
        new_balance:   newBalance,
        orders: created.map((o: any) => ({
            order_id:  o.id,
            reference: o.reference_code,
            status:    'pending',
            network:   o.network,
            size:      o.size,
            recipient: o.phone_number,
        })),
    })
}
