import { NextRequest } from 'next/server'
import {
    validateApiKey, isApiError, apiSuccessV2, apiError,
    logApiRequest, getClientIp, enforceRateLimit,
} from '@/lib/api-auth'
import { generateReferenceCode } from '@/lib/utils'
import { purchaseWithWallet } from '@/lib/vouchers/checkout'

/**
 * Buy result checker vouchers over the STANDARD key.
 *
 * The one endpoint here that settles synchronously. Vouchers are sold from stock we
 * already hold, so purchaseWithWallet debits, reserves the PINs and marks them sold
 * inside the request — there is no supplier to wait on and nothing to poll. The PINs
 * come back in this response and are also emailed/SMSed by the shared delivery path.
 *
 * That makes the failure mode different too: INSUFFICIENT_INVENTORY is a real answer,
 * and the wallet is refunded before it is raised.
 */
const ENDPOINT = '/api/v2/results-checker/purchase'

const MAX_QUANTITY = 50

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

    const {
        type_id: typeId,
        quantity,
        reference: clientRef,
        customer_name: customerName,
        customer_email: customerEmail,
        customer_phone: customerPhone,
    } = body ?? {}

    if (!typeId || typeof typeId !== 'string') {
        return apiError(400, 'type_id is required. Call GET /api/v2/results-checker/types for the catalogue.')
    }

    const qty = Number(quantity)
    if (!Number.isInteger(qty) || qty < 1) {
        return apiError(400, 'quantity must be a whole number of at least 1')
    }
    if (qty > MAX_QUANTITY) {
        return apiError(400, `quantity may not exceed ${MAX_QUANTITY} vouchers per request`)
    }

    if (clientRef !== undefined && (typeof clientRef !== 'string' || clientRef.length > 100)) {
        return apiError(400, 'reference must be a string of at most 100 characters')
    }

    // Idempotency: an identical reference returns the vouchers already bought under
    // it. Scoped to this caller — reference_code is unique table-wide, so an unscoped
    // read would hand one partner another partner's PINs.
    if (clientRef) {
        const { data: existing } = await (supabase.from('results_checker_orders') as any)
            .select('id, reference_code, status, type_name, quantity, unit_price, total_paid, inventory_ids')
            .eq('reference_code', clientRef)
            .eq('user_id', userId)
            .maybeSingle()

        if (existing) {
            const { data: vouchers } = await (supabase.from('results_checker_inventory') as any)
                .select('id, pin, serial_number')
                .in('id', existing.inventory_ids || [])

            logApiRequest({ apiKeyId, userId, endpoint: ENDPOINT, method: 'POST', statusCode: 200, responseTimeMs: Date.now() - startTime, ip })
            return apiSuccessV2({
                order_id:   existing.id,
                reference:  existing.reference_code,
                status:     existing.status,
                type_name:  existing.type_name,
                quantity:   existing.quantity,
                unit_price: existing.unit_price,
                total_paid: existing.total_paid,
                vouchers:   ((vouchers as any[]) || []).map(v => ({ pin: v.pin, serial: v.serial_number })),
            }, { cached: true })
        }
    }

    const referenceCode = clientRef || `RC-${generateReferenceCode()}`

    try {
        const result = await purchaseWithWallet({
            userId,
            userRole,
            typeId,
            quantity: qty,
            customerName,
            customerEmail,
            customerPhone,
            referenceCode,
            apiKeyId,
        })

        const order = result.order as any

        logApiRequest({ apiKeyId, userId, endpoint: ENDPOINT, method: 'POST', statusCode: 201, responseTimeMs: Date.now() - startTime, ip })

        return apiSuccessV2({
            order_id:    order.id,
            reference:   referenceCode,
            status:      'completed',
            type_name:   order.type_name,
            quantity:    qty,
            unit_price:  order.unit_price,
            total_paid:  order.total_paid,
            new_balance: result.newBalance,
            vouchers:    result.vouchers.map(v => ({ pin: v.pin, serial: v.serial_number })),
        })
    } catch (error: any) {
        // purchaseWithWallet signals with sentinel messages and has already refunded
        // the wallet on anything past the debit, so each of these is safe to retry.
        const known: Record<string, { status: number; message: string }> = {
            PRODUCT_NOT_AVAILABLE:        { status: 404, message: 'That voucher type is unavailable. Call GET /api/v2/results-checker/types for the current catalogue.' },
            INSUFFICIENT_BALANCE:         { status: 402, message: 'Insufficient wallet balance. Top up your wallet and retry.' },
            INSUFFICIENT_INVENTORY:       { status: 409, message: 'Not enough vouchers in stock for that quantity. Your wallet has not been charged.' },
            ORDER_CREATION_FAILED:        { status: 500, message: 'Could not create the order. Your wallet has not been charged.' },
            PRICING_ERROR_UNIT_BELOW_COST:{ status: 500, message: 'Pricing is misconfigured for that voucher type. Please contact support.' },
        }

        const mapped = known[error?.message]
        if (mapped) {
            logApiRequest({ apiKeyId, userId, endpoint: ENDPOINT, method: 'POST', statusCode: mapped.status, responseTimeMs: Date.now() - startTime, ip, errorMessage: error.message })
            return apiError(mapped.status, mapped.message)
        }

        console.error('[v2/results-checker/purchase] Unexpected error:', error)
        logApiRequest({ apiKeyId, userId, endpoint: ENDPOINT, method: 'POST', statusCode: 500, responseTimeMs: Date.now() - startTime, ip, errorMessage: error?.message })
        return apiError(500, 'Failed to complete the purchase')
    }
}
