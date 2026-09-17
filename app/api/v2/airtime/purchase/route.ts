import { NextRequest } from 'next/server'
import {
    validateApiKey, isApiError, apiSuccessV2, apiError,
    logApiRequest, getClientIp, enforceRateLimit,
} from '@/lib/api-auth'
import { generateReferenceCode } from '@/lib/utils'
import { waitUntil } from '@vercel/functions'
import { sendPushToAdmins } from '@/lib/web-push'
import { triggerAirtimeFulfillment } from '@/lib/airtime-fulfillment-dispatcher'
import { MIN_DELIVERABLE_AIRTIME_GHS } from '@/lib/kingflexy-airtime-service'
import { isAirtimeNetwork, isDuplicateReferenceError } from '@/lib/api-v2-networks'

/**
 * Airtime top-up over the STANDARD key.
 *
 * Airtime is sold like a data bundle: the caller is charged the ordinary role fee and
 * earns nothing extra. Commission Services is a separate product covering utility
 * bills only, and a commission key is rejected here with 403 like anywhere else
 * outside /api/v2/utilities/*.
 *
 * Mirrors app/api/airtime/create/route.ts, with two deliberate differences:
 *
 *  - No beneficiary SMS, admin email or admin SMS. Those exist so a human buyer and
 *    the ops team can see a one-off order; at API volume they are noise and cost.
 *    The completion SMS still fires from lib/airtime-order-completion.ts.
 *  - The 30-second duplicate window is gone. `reference` is the idempotency key, which
 *    is both stronger and does not punish a partner legitimately topping the same
 *    number twice.
 */
const ENDPOINT = '/api/v2/airtime/purchase'

const NETWORK_KEY_MAP: Record<string, string> = {
    MTN: 'mtn',
    Telecel: 'telecel',
    AT: 'at',
}

function round2(n: number): number {
    return Math.round((n + Number.EPSILON) * 100) / 100
}

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

    let body: any
    try { body = await request.json() } catch {
        return apiError(400, 'Invalid JSON body')
    }

    const { network, amount, recipient, reference: clientRef, use_exact_amount } = body

    if (!network || amount === undefined || amount === null || !recipient) {
        return apiError(400, 'network, amount, and recipient are required')
    }

    if (!isAirtimeNetwork(network)) {
        return apiError(400, 'Invalid network. Must be one of: MTN, Telecel, AT')
    }

    // Airtime lands on the handset, so the destination must be a local MSISDN — the
    // 233-prefixed form the data endpoints accept is not valid here.
    const cleanPhone = String(recipient).replace(/\s+/g, '')
    if (!/^0\d{9}$/.test(cleanPhone)) {
        return apiError(400, 'Invalid recipient phone. Use Ghana format: 0XXXXXXXXX (10 digits starting with 0)')
    }

    // Idempotency: an identical reference returns the original order untouched.
    //
    // Scoped to this caller. reference_code is UNIQUE across the whole table, so an
    // unscoped lookup would hand one partner another partner's order the moment the
    // two happened to pick the same string.
    if (clientRef) {
        const { data: existing } = await (supabase.from('airtime_orders') as any)
            .select('id, reference_code, status, network, beneficiary_phone, airtime_amount, total_paid')
            .eq('reference_code', clientRef)
            .eq('user_id', userId)
            .maybeSingle()

        if (existing) {
            logApiRequest({ apiKeyId, userId, endpoint: ENDPOINT, method: 'POST', statusCode: 200, responseTimeMs: Date.now() - startTime, ip })
            return apiSuccessV2({
                order_id:       existing.id,
                reference:      existing.reference_code,
                status:         existing.status,
                network:        existing.network,
                recipient:      existing.beneficiary_phone,
                airtime_amount: existing.airtime_amount,
                total_paid:     existing.total_paid,
            }, { cached: true })
        }
    }

    // Same fee band the dashboard uses, so an agent is charged over the API exactly
    // what they are charged in the app.
    const feeBand: 'agent' | 'customer' = userRole === 'agent' ? 'agent' : 'customer'

    const networkKey = NETWORK_KEY_MAP[network]
    const { data: settingsRows } = await (supabase.from('admin_settings') as any)
        .select('key, value')
        .in('key', [
            `airtime_enabled_${networkKey}`,
            `airtime_fee_${networkKey}_${feeBand}`,
            'airtime_min_amount',
            'airtime_max_amount',
        ])

    const settings: Record<string, string> = {}
    for (const row of ((settingsRows as any[]) || [])) settings[row.key] = row.value

    if (settings[`airtime_enabled_${networkKey}`] === 'false') {
        return apiError(400, `${network} airtime is currently unavailable.`)
    }

    const parsedAmount = Number(amount)
    const minAmount = parseFloat(settings['airtime_min_amount'] || '1')
    const maxAmount = parseFloat(settings['airtime_max_amount'] || '500')

    if (!Number.isFinite(parsedAmount) || parsedAmount < minAmount) {
        return apiError(400, `Minimum airtime amount is GHS ${minAmount.toFixed(2)}`)
    }
    if (parsedAmount > maxAmount) {
        return apiError(400, `Maximum airtime amount is GHS ${maxAmount.toFixed(2)}`)
    }

    // Fee is always resolved server-side, never taken from the request.
    const feeRate = parseFloat(settings[`airtime_fee_${networkKey}_${feeBand}`] || '5')

    let airtimeAmount: number
    let feeAmount: number
    let totalPaid: number

    if (use_exact_amount) {
        // The beneficiary receives exactly `amount`; the fee is added on top.
        airtimeAmount = round2(parsedAmount)
        feeAmount = round2(parsedAmount * (feeRate / 100))
        totalPaid = round2(airtimeAmount + feeAmount)
    } else {
        // The caller is charged exactly `amount`; the fee comes out of it.
        totalPaid = round2(parsedAmount)
        feeAmount = round2(parsedAmount * (feeRate / 100))
        airtimeAmount = round2(parsedAmount - feeAmount)
    }

    if (airtimeAmount < MIN_DELIVERABLE_AIRTIME_GHS) {
        // Checked BEFORE the wallet is touched: the supplier would reject this
        // after we had already taken the money.
        const needed = Math.ceil((MIN_DELIVERABLE_AIRTIME_GHS / (1 - feeRate / 100)) * 100) / 100
        return apiError(400, `Airtime after the ${feeRate}% fee would be GHS ${airtimeAmount.toFixed(2)}, below the GHS ${MIN_DELIVERABLE_AIRTIME_GHS.toFixed(2)} minimum the provider accepts. Send at least GHS ${needed.toFixed(2)}, or set use_exact_amount to true to add the fee on top.`)
    }

    const { data: deductResult, error: deductError } = await (supabase as any).rpc('deduct_wallet_balance', {
        p_user_id: userId,
        p_amount: totalPaid,
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

    const referenceCode = clientRef || `AIR-${generateReferenceCode()}`

    const { data: order, error: orderError } = await (supabase.from('airtime_orders') as any)
        .insert({
            user_id:           userId,
            user_role:         userRole,
            beneficiary_phone: cleanPhone,
            network,
            airtime_amount:    airtimeAmount,
            fee_rate:          feeRate,
            fee_amount:        feeAmount,
            total_paid:        totalPaid,
            use_exact_amount:  Boolean(use_exact_amount),
            status:            'pending',
            reference_code:    referenceCode,
            type:              'airtime',
            api_key_id:        apiKeyId,
        })
        .select()
        .single()

    if (orderError) {
        await (supabase as any).rpc('credit_wallet_balance', { p_user_id: userId, p_amount: totalPaid }).catch(() => {})

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
        amount:      totalPaid,
        description: `API Airtime: GHS ${airtimeAmount.toFixed(2)} for ${cleanPhone} (${network})`,
        reference:   referenceCode,
        source:      'airtime',
        status:      'completed',
    }).then(() => {}).catch(() => {})

    sendPushToAdmins({
        title: 'New API Airtime Order',
        body: `API: ${network} GHS ${airtimeAmount.toFixed(2)} → ${cleanPhone}`,
        url: '/admin/airtime',
    }).catch(() => {})

    // Deferred, unlike the data path: Hubtel splits a top-up above GHS 100 into
    // several legs and can take many seconds. The order is already recorded, and the
    // caller polls GET /api/v2/orders/:reference or waits for the webhook.
    waitUntil(triggerAirtimeFulfillment((order as any).id))

    logApiRequest({ apiKeyId, userId, endpoint: ENDPOINT, method: 'POST', statusCode: 201, responseTimeMs: Date.now() - startTime, ip })

    return apiSuccessV2({
        order_id:       (order as any).id,
        reference:      referenceCode,
        status:         'pending',
        network,
        recipient:      cleanPhone,
        airtime_amount: airtimeAmount,
        fee_amount:     feeAmount,
        total_paid:     totalPaid,
        new_balance:    newBalance,
    })
}
