import { NextRequest } from 'next/server'
import {
    validateApiKey, isApiError, apiSuccessV2, apiError,
    logApiRequest, getClientIp, enforceRateLimit,
} from '@/lib/api-auth'
import { sendPushToAdmins } from '@/lib/web-push'
import { generateReferenceCode } from '@/lib/utils'
import { fulfillApiDataOrder } from '@/lib/api-data-fulfillment'
import {
    dataNetworkError, normaliseRecipient, findPackageForSize, isDuplicateReferenceError,
} from '@/lib/api-v2-networks'

/**
 * Single data bundle purchase. Same flow as v1, with the network names corrected to
 * the ones data_packages actually uses and the size match tightened — see
 * lib/api-v2-networks.ts for both.
 */
const ENDPOINT = '/api/v2/data/purchase'

export async function POST(request: NextRequest) {
    const startTime = Date.now()
    const ip = getClientIp(request)

    const auth = await validateApiKey(request, { version: 'v2', kind: 'standard' })
    if (isApiError(auth)) {
        logApiRequest({ apiKeyId: null, userId: null, endpoint: ENDPOINT, method: 'POST', statusCode: (auth as any).status, responseTimeMs: Date.now() - startTime, ip, errorMessage: 'Auth failed' })
        return auth
    }

    const limited = await enforceRateLimit(auth, 'purchase')
    if (limited) return limited

    const { userId, apiKeyId, userRole, supabase } = auth

    // Sub-agents buy through their Lead's pricing cascade, which this route does not
    // implement. Carried over from v1 rather than silently charging them base price.
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

    const { network, volume_gb, recipient, reference: clientRef } = body

    if (!network || volume_gb === undefined || volume_gb === null || !recipient) {
        return apiError(400, 'network, volume_gb, and recipient are required')
    }

    const networkError = dataNetworkError(network)
    if (networkError) return apiError(400, networkError)

    const cleanPhone = normaliseRecipient(recipient)
    if (!cleanPhone) {
        return apiError(400, 'Invalid recipient phone. Use Ghana format: 0XXXXXXXXX or 233XXXXXXXXX')
    }

    // Idempotency on client-supplied reference
    if (clientRef) {
        const { data: existing } = await (supabase.from('orders') as any)
            .select('id, reference_code, status, size, network, phone_number, price')
            .eq('reference_code', clientRef)
            .eq('api_key_id', apiKeyId)
            .maybeSingle()

        if (existing) {
            logApiRequest({ apiKeyId, userId, endpoint: ENDPOINT, method: 'POST', statusCode: 200, responseTimeMs: Date.now() - startTime, ip })
            return apiSuccessV2({
                order_id:  existing.id,
                reference: existing.reference_code,
                status:    existing.status,
                network:   existing.network,
                size:      existing.size,
                recipient: existing.phone_number,
                price:     existing.price,
            }, { cached: true })
        }
    }

    const { data: packages } = await (supabase.from('data_packages') as any)
        .select('id, network, size, price, agent_price, cost_price, is_available')
        .eq('network', network)
        .eq('is_available', true)

    const pkg = findPackageForSize((packages as any[]) || [], volume_gb)

    if (!pkg) {
        return apiError(404, `No available package found for ${network} ${volume_gb}.`)
    }

    // NOTE: the MTN registration gate deliberately does NOT run here — an unregistered
    // recipient takes the fulfillment-time path instead. See
    // app/api/orders/purchase/route.ts for the full reasoning.

    const { data: userExpiry } = await supabase
        .from('users')
        .select('agent_expires_at')
        .eq('id', userId)
        .single()

    const agentExpired = (userExpiry as any)?.agent_expires_at
        && new Date((userExpiry as any).agent_expires_at) < new Date()
    const isActiveAgent = userRole === 'agent' && !agentExpired
    const priceToCharge = isActiveAgent && pkg.agent_price > 0 ? pkg.agent_price : pkg.price

    const { data: deductResult, error: deductError } = await (supabase as any).rpc('deduct_wallet_balance', {
        p_user_id: userId,
        p_amount: priceToCharge,
    })

    if (deductError) {
        if (deductError.message?.includes('INSUFFICIENT_BALANCE')) {
            logApiRequest({ apiKeyId, userId, endpoint: ENDPOINT, method: 'POST', statusCode: 402, responseTimeMs: Date.now() - startTime, ip, errorMessage: 'Insufficient balance' })
            return apiError(402, 'Insufficient wallet balance. Top up your wallet and retry.')
        }
        logApiRequest({ apiKeyId, userId, endpoint: ENDPOINT, method: 'POST', statusCode: 500, responseTimeMs: Date.now() - startTime, ip, errorMessage: deductError.message })
        return apiError(500, 'Payment processing failed')
    }

    const walletRow = deductResult?.[0] || deductResult
    const walletId = walletRow?.wallet_id
    const newBalance = walletRow?.new_balance

    if (!walletId) return apiError(404, 'Wallet not found')

    const referenceCode = clientRef || generateReferenceCode()

    const { data: order, error: orderError } = await (supabase.from('orders') as any)
        .insert({
            user_id:            userId,
            phone_number:       cleanPhone,
            network:            pkg.network,
            size:               pkg.size,
            price:              priceToCharge,
            cost_price_at_time: pkg.cost_price || 0,
            role_at_time:       userRole,
            status:             'pending',
            payment_status:     'paid',
            reference_code:     referenceCode,
            fulfillment_method: 'auto',
            source:             'api',
            api_key_id:         apiKeyId,
        })
        .select()
        .single()

    if (orderError) {
        await (supabase as any).rpc('credit_wallet_balance', { p_user_id: userId, p_amount: priceToCharge }).catch(() => {})

        // The idempotency lookup above is scoped to this key, so a reference already
        // claimed by a DIFFERENT caller reaches the insert and trips the global unique
        // constraint. That is a 409, not a server error.
        if (isDuplicateReferenceError(orderError)) {
            logApiRequest({ apiKeyId, userId, endpoint: ENDPOINT, method: 'POST', statusCode: 409, responseTimeMs: Date.now() - startTime, ip, errorMessage: 'Duplicate reference' })
            return apiError(409, `The reference "${referenceCode}" is already in use. Choose another.`)
        }

        logApiRequest({ apiKeyId, userId, endpoint: ENDPOINT, method: 'POST', statusCode: 500, responseTimeMs: Date.now() - startTime, ip, errorMessage: orderError.message })
        return apiError(500, 'Failed to create order')
    }

    ;(supabase.from('wallet_transactions') as any).insert({
        wallet_id:   walletId,
        user_id:     userId,
        type:        'debit',
        amount:      priceToCharge,
        description: `API: ${pkg.network} ${pkg.size} → ${cleanPhone}`,
        reference:   referenceCode,
        source:      'api_purchase',
        status:      'completed',
    }).then(() => {}).catch(() => {})

    sendPushToAdmins({
        title: 'New API Order',
        body: `API: ${pkg.network} ${pkg.size} → ${cleanPhone} (GHS ${priceToCharge.toFixed(2)})`,
        url: '/admin/orders',
    }).catch(() => {})

    // Awaited, not backgrounded: Vercel kills async work the moment the response is
    // sent, which would leave every API order stuck at 'pending'.
    const fulfillmentStatus = await fulfillApiDataOrder({
        supabase,
        orderId:   (order as any).id,
        network:   pkg.network,
        recipient: cleanPhone,
        size:      pkg.size,
        logPrefix: 'v2/purchase',
    })

    logApiRequest({ apiKeyId, userId, endpoint: ENDPOINT, method: 'POST', statusCode: 201, responseTimeMs: Date.now() - startTime, ip })

    return apiSuccessV2({
        order_id:    (order as any).id,
        reference:   referenceCode,
        status:      fulfillmentStatus,
        network:     pkg.network,
        size:        pkg.size,
        recipient:   cleanPhone,
        price:       priceToCharge,
        new_balance: newBalance,
    })
}
