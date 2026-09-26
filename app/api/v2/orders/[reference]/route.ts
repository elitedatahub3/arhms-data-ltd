import { NextRequest } from 'next/server'
import {
    validateApiKey, isApiError, apiSuccessV2, apiError,
    logApiRequest, getClientIp, enforceRateLimit,
} from '@/lib/api-auth'

/**
 * Status of a data, airtime, AFA or result checker order, by reference.
 *
 * v1 only knew about the `orders` table; each product since has its own, so one
 * reference has four places to look and the `type` field says which was found.
 *
 * Standard key only. Bill payments are deliberately NOT reachable here — they have
 * their own endpoint at /api/v2/utilities/orders/:reference, gated on the commission
 * key, which keeps the two products' surfaces from bleeding into each other.
 */
const ENDPOINT = '/api/v2/orders/:reference'

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ reference: string }> }
) {
    const startTime = Date.now()
    const ip = getClientIp(request)

    const auth = await validateApiKey(request, { version: 'v2', kind: 'standard' })
    if (isApiError(auth)) {
        logApiRequest({ apiKeyId: null, userId: null, endpoint: ENDPOINT, method: 'GET', statusCode: (auth as any).status, responseTimeMs: Date.now() - startTime, ip, errorMessage: 'Auth failed' })
        return auth
    }

    const limited = await enforceRateLimit(auth, 'status')
    if (limited) return limited

    const { userId, apiKeyId, supabase } = auth
    const { reference } = await params

    if (!reference || reference.length > 100) {
        return apiError(400, 'Invalid reference')
    }

    /**
     * Scoped to this key first, then to the user. The second lookup is what lets a
     * caller check an order they placed in the dashboard; without it, only orders
     * created by this exact key would ever be visible.
     */
    async function lookup(table: string, columns: string): Promise<any | null> {
        const byKey = await (supabase.from(table) as any)
            .select(columns)
            .eq('reference_code', reference)
            .eq('api_key_id', apiKeyId)
            .maybeSingle()

        if (byKey.data) return byKey.data

        const byUser = await (supabase.from(table) as any)
            .select(columns)
            .eq('reference_code', reference)
            .eq('user_id', userId)
            .maybeSingle()

        return byUser.data ?? null
    }

    const dataOrder = await lookup(
        'orders',
        'id, reference_code, status, payment_status, network, size, phone_number, price, source, created_at, updated_at, fulfillment_method'
    )

    if (dataOrder) {
        logApiRequest({ apiKeyId, userId, endpoint: ENDPOINT, method: 'GET', statusCode: 200, responseTimeMs: Date.now() - startTime, ip })
        return apiSuccessV2({
            type:           'data',
            order_id:       dataOrder.id,
            reference:      dataOrder.reference_code,
            status:         dataOrder.status,
            payment_status: dataOrder.payment_status,
            network:        dataOrder.network,
            size:           dataOrder.size,
            recipient:      dataOrder.phone_number,
            price:          dataOrder.price,
            source:         dataOrder.source,
            created_at:     dataOrder.created_at,
            updated_at:     dataOrder.updated_at,
        })
    }

    const airtimeOrder = await lookup(
        'airtime_orders',
        'id, reference_code, status, type, network, beneficiary_phone, airtime_amount, fee_amount, total_paid, created_at, updated_at, fulfillment_note'
    )

    if (airtimeOrder) {
        logApiRequest({ apiKeyId, userId, endpoint: ENDPOINT, method: 'GET', statusCode: 200, responseTimeMs: Date.now() - startTime, ip })
        return apiSuccessV2({
            type:           airtimeOrder.type === 'mashup' ? 'mashup' : 'airtime',
            order_id:       airtimeOrder.id,
            reference:      airtimeOrder.reference_code,
            status:         airtimeOrder.status,
            network:        airtimeOrder.network,
            recipient:      airtimeOrder.beneficiary_phone,
            airtime_amount: airtimeOrder.airtime_amount,
            fee_amount:     airtimeOrder.fee_amount,
            total_paid:     airtimeOrder.total_paid,
            note:           airtimeOrder.fulfillment_note,
            created_at:     airtimeOrder.created_at,
            updated_at:     airtimeOrder.updated_at,
        })
    }

    const afaOrder = await lookup(
        'afa_orders',
        'id, reference_code, status, payment_status, full_name, phone, region, payment_amount, created_at, updated_at'
    )

    if (afaOrder) {
        logApiRequest({ apiKeyId, userId, endpoint: ENDPOINT, method: 'GET', statusCode: 200, responseTimeMs: Date.now() - startTime, ip })
        return apiSuccessV2({
            type:           'afa',
            order_id:       afaOrder.id,
            reference:      afaOrder.reference_code,
            status:         afaOrder.status,
            payment_status: afaOrder.payment_status,
            applicant:      afaOrder.full_name,
            phone:          afaOrder.phone,
            region:         afaOrder.region,
            amount_paid:    afaOrder.payment_amount,
            // Restated on every poll: `completed` here means an agent finished the
            // registration by hand, not that anything was dispatched upstream.
            fulfillment:    'manual',
            created_at:     afaOrder.created_at,
            updated_at:     afaOrder.updated_at,
        })
    }

    const rcOrder = await lookup(
        'results_checker_orders',
        'id, reference_code, status, payment_status, type_name, quantity, unit_price, total_paid, inventory_ids, created_at, updated_at'
    )

    if (rcOrder) {
        // The PINs are returned again rather than only at purchase: a partner whose
        // process died mid-response would otherwise have paid for vouchers they can
        // never read back, and they are already sold to this order.
        const { data: vouchers } = await (supabase.from('results_checker_inventory') as any)
            .select('pin, serial_number')
            .in('id', rcOrder.inventory_ids || [])

        logApiRequest({ apiKeyId, userId, endpoint: ENDPOINT, method: 'GET', statusCode: 200, responseTimeMs: Date.now() - startTime, ip })
        return apiSuccessV2({
            type:           'results_checker',
            order_id:       rcOrder.id,
            reference:      rcOrder.reference_code,
            status:         rcOrder.status,
            payment_status: rcOrder.payment_status,
            type_name:      rcOrder.type_name,
            quantity:       rcOrder.quantity,
            unit_price:     rcOrder.unit_price,
            total_paid:     rcOrder.total_paid,
            vouchers:       ((vouchers as any[]) || []).map(v => ({ pin: v.pin, serial: v.serial_number })),
            created_at:     rcOrder.created_at,
            updated_at:     rcOrder.updated_at,
        })
    }

    logApiRequest({ apiKeyId, userId, endpoint: ENDPOINT, method: 'GET', statusCode: 404, responseTimeMs: Date.now() - startTime, ip, errorMessage: 'Order not found' })
    return apiError(404, `No order found with reference: ${reference}. Bill payments are at /api/v2/utilities/orders/${reference}.`)
}
