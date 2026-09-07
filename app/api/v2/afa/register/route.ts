import { NextRequest } from 'next/server'
import {
    validateApiKey, isApiError, apiSuccessV2, apiError,
    logApiRequest, getClientIp, enforceRateLimit,
} from '@/lib/api-auth'
import { generateReferenceCode } from '@/lib/utils'
import { sendPushToAdmins } from '@/lib/web-push'
import { validateAfaFormData } from '@/lib/afa-validation'
import { resolveAfaCostPrice } from '@/lib/afa-pricing'
import { isDuplicateReferenceError } from '@/lib/api-v2-networks'

/**
 * MTN AFA registration over the STANDARD key.
 *
 * Mirrors app/api/user/afa-registration/route.ts — same validation, same role-tiered
 * price — with the API conventions the rest of v2 uses: key auth, `reference` as the
 * idempotency key, and no admin email per order (that exists so ops can see a one-off
 * dashboard application; at API volume it is noise).
 *
 * AFA has no supplier API. The wallet is debited and the application filed; an
 * admin then works it by hand at /admin/afa-management. So a successful call means
 * "paid and queued", NOT "registered" — status stays `pending` until a human moves
 * it, which is why the response says so explicitly and the docs repeat it.
 */
const ENDPOINT = '/api/v2/afa/register'

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

    const { reference: clientRef, ...applicant } = body ?? {}

    if (clientRef !== undefined && (typeof clientRef !== 'string' || clientRef.length > 100)) {
        return apiError(400, 'reference must be a string of at most 100 characters')
    }

    // Flat body rather than the dashboard's nested `formData`: a REST caller sends the
    // applicant fields directly. validateAfaFormData is shared verbatim so the API
    // cannot accept an application the admin queue would find unprocessable.
    const formData = {
        full_name:     applicant.full_name,
        phone:         applicant.phone,
        id_type:       applicant.id_type,
        id_number:     applicant.id_number,
        date_of_birth: applicant.date_of_birth,
        location:      applicant.location,
        region:        applicant.region,
        occupation:    applicant.occupation || 'Farmer',
        notes:         applicant.notes || null,
    }

    const invalid = validateAfaFormData(formData)
    if (invalid) {
        logApiRequest({ apiKeyId, userId, endpoint: ENDPOINT, method: 'POST', statusCode: invalid.status, responseTimeMs: Date.now() - startTime, ip, errorMessage: invalid.error })
        return apiError(invalid.status, invalid.error)
    }

    // Idempotency: an identical reference returns the original application untouched.
    // Scoped to this caller — reference_code is unique table-wide, so an unscoped read
    // would hand one partner another's applicant details.
    if (clientRef) {
        const { data: existing } = await (supabase.from('afa_orders') as any)
            .select('id, reference_code, status, payment_amount, full_name, phone')
            .eq('reference_code', clientRef)
            .eq('user_id', userId)
            .maybeSingle()

        if (existing) {
            logApiRequest({ apiKeyId, userId, endpoint: ENDPOINT, method: 'POST', statusCode: 200, responseTimeMs: Date.now() - startTime, ip })
            return apiSuccessV2({
                order_id:    existing.id,
                reference:   existing.reference_code,
                status:      existing.status,
                applicant:   existing.full_name,
                phone:       existing.phone,
                amount_paid: existing.payment_amount,
            }, { cached: true })
        }
    }

    // Price is always resolved server-side, from the same admin_settings rows the
    // dashboard reads. Fails closed — a missing row is a config error, never a free
    // registration.
    const price = await resolveAfaCostPrice(supabase, userRole)
    if (!price.ok) {
        logApiRequest({ apiKeyId, userId, endpoint: ENDPOINT, method: 'POST', statusCode: 503, responseTimeMs: Date.now() - startTime, ip, errorMessage: 'AFA pricing not configured' })
        return apiError(503, price.error)
    }

    const referenceCode = clientRef || `AFA-${generateReferenceCode()}`

    // Debit then insert, rather than the dashboard's process_afa_order RPC.
    //
    // That RPC is invoked with the caller's own Supabase client; here the only client
    // is the service-role one, and the RPC's definition is not in this repo to check
    // what it assumes about auth.uid(). This is the same debit → insert → refund-on-
    // failure shape app/api/v2/airtime/purchase/route.ts uses, and it lets api_key_id
    // and the caller's reference land in the row itself instead of a follow-up write.
    const { data: deductResult, error: deductError } = await (supabase as any).rpc('deduct_wallet_balance', {
        p_user_id: userId,
        p_amount:  price.price,
    })

    if (deductError) {
        if (deductError.message?.includes('INSUFFICIENT_BALANCE')) {
            logApiRequest({ apiKeyId, userId, endpoint: ENDPOINT, method: 'POST', statusCode: 402, responseTimeMs: Date.now() - startTime, ip, errorMessage: 'Insufficient balance' })
            return apiError(402, 'Insufficient wallet balance. Top up your wallet and retry.')
        }
        console.error('[v2/afa/register] Wallet deduction error:', deductError)
        logApiRequest({ apiKeyId, userId, endpoint: ENDPOINT, method: 'POST', statusCode: 500, responseTimeMs: Date.now() - startTime, ip, errorMessage: deductError.message })
        return apiError(500, 'Payment processing failed')
    }

    const walletRow = deductResult?.[0] || deductResult
    const walletId = walletRow?.wallet_id
    const newBalance = walletRow?.new_balance

    if (!walletId) return apiError(404, 'Wallet not found')

    const idNumber = String(formData.id_number).trim()

    const { data: order, error: orderError } = await (supabase.from('afa_orders') as any)
        .insert({
            user_id:        userId,
            full_name:      formData.full_name,
            phone:          formData.phone,
            id_type:        formData.id_type,
            id_number:      idNumber,
            // Kept in sync with id_number, the way the storefront route and the
            // dashboard RPC both populate it.
            ghana_card:     idNumber,
            date_of_birth:  formData.date_of_birth,
            location:       formData.location,
            region:         formData.region,
            occupation:     formData.occupation,
            notes:          formData.notes,
            payment_amount: price.price,
            // Paid outright from the wallet, so it enters the admin queue immediately —
            // unlike a storefront order, which sits at pending_payment until settled.
            payment_status: 'completed',
            status:         'pending',
            reference_code: referenceCode,
            api_key_id:     apiKeyId,
        })
        .select('id')
        .single()

    if (orderError) {
        await (supabase as any).rpc('credit_wallet_balance', { p_user_id: userId, p_amount: price.price }).catch(() => {})

        if (isDuplicateReferenceError(orderError)) {
            logApiRequest({ apiKeyId, userId, endpoint: ENDPOINT, method: 'POST', statusCode: 409, responseTimeMs: Date.now() - startTime, ip, errorMessage: 'Duplicate reference' })
            return apiError(409, `The reference "${referenceCode}" is already in use. Choose another.`)
        }

        console.error('[v2/afa/register] Order creation error:', orderError)
        logApiRequest({ apiKeyId, userId, endpoint: ENDPOINT, method: 'POST', statusCode: 500, responseTimeMs: Date.now() - startTime, ip, errorMessage: orderError.message })
        return apiError(500, 'Failed to create the registration')
    }

    ;(supabase.from('wallet_transactions') as any).insert({
        wallet_id:   walletId,
        user_id:     userId,
        type:        'debit',
        amount:      price.price,
        description: `API AFA Registration: ${formData.full_name}`,
        reference:   referenceCode,
        source:      'purchase',
        status:      'completed',
    }).then(() => {}).catch((e: any) => console.error('[v2/afa/register] Tx insert error:', e?.message))

    // The queue is worked by hand, so an admin has to learn there is something in it.
    sendPushToAdmins({
        title: 'New API AFA Application',
        body:  `API: ${formData.full_name} · ${formData.region}`,
        url:   '/admin/afa-management',
    }).catch(() => {})

    logApiRequest({ apiKeyId, userId, endpoint: ENDPOINT, method: 'POST', statusCode: 201, responseTimeMs: Date.now() - startTime, ip })

    return apiSuccessV2({
        order_id:    (order as any).id,
        reference:   referenceCode,
        status:      'pending',
        applicant:   formData.full_name,
        phone:       formData.phone,
        amount_paid: price.price,
        new_balance: newBalance,
        // Said plainly because it is the one place this product differs from every
        // other endpoint here: nothing is dispatched upstream.
        fulfillment: 'manual',
        note:        'Registration paid and queued. An agent processes it by hand — poll GET /api/v2/orders/{reference} for the outcome.',
    })
}
