import { NextRequest } from 'next/server'
import { randomBytes } from 'crypto'
import {
    validateApiKey, isApiError, apiSuccessV2, apiError,
    logApiRequest, getClientIp, enforceRateLimit,
} from '@/lib/api-auth'
import { waitUntil } from '@vercel/functions'
import { sendPushToAdmins } from '@/lib/web-push'
import {
    buildUtilityIntent, utilitySettingKeys, isUtilityVisibleTo, UTILITY_LAUNCH_KEY,
} from '@/lib/utility-order-intent'
import { triggerUtilityFulfillment, buildUtilityClientReference } from '@/lib/utility-fulfillment-dispatcher'
import { UTILITY_SERVICES } from '@/lib/hubtel-utility-service'
import { BILLER_KEYS, isBillerKey, serviceForBiller } from '@/lib/api-v2-billers'
import { commissionSharePercent } from '@/lib/commission-earning'

/**
 * Pay a bill at face value from the partner's wallet.
 *
 * Mirrors app/api/utilities/create/route.ts. The account is re-verified against the
 * provider by buildUtilityIntent() BEFORE the wallet is touched — that re-query is
 * the only thing standing between a mistyped digit and a stranger's bill, so it is
 * never skipped in favour of trusting what /lookup returned earlier.
 *
 * `reference` is a pure IDEMPOTENCY key, not the order's reference. It is stored in
 * its own column, unique per user, and the order gets a generated
 * UTIL-<BILLER>-<random> code of its own. That separation is what lets two partners
 * both use "bill_001" without colliding on a table-wide unique constraint.
 */
const ENDPOINT = '/api/v2/utilities/pay'
const REFERENCE_PATTERN = /^[A-Za-z0-9._-]{1,64}$/
const DUPLICATE_WINDOW_MS = 30_000

function round2(n: number): number {
    return Math.round((n + Number.EPSILON) * 100) / 100
}

export async function POST(request: NextRequest) {
    const startTime = Date.now()
    const ip = getClientIp(request)

    const auth = await validateApiKey(request, { version: 'v2', kind: 'commission' })
    if (isApiError(auth)) {
        logApiRequest({ apiKeyId: null, userId: null, endpoint: ENDPOINT, method: 'POST', statusCode: (auth as any).status, responseTimeMs: Date.now() - startTime, ip, errorMessage: 'Auth failed' })
        return auth
    }

    const limited = await enforceRateLimit(auth, 'pay')
    if (limited) return limited

    const { userId, apiKeyId, userRole, supabase } = auth

    let body: any
    try { body = await request.json() } catch {
        return apiError(400, 'Invalid JSON body')
    }

    const { biller, account, phone, email, amount, reference: clientRef } = body

    if (!isBillerKey(biller)) {
        return apiError(400, `Invalid biller. Must be one of: ${BILLER_KEYS.join(', ')}`)
    }
    if (clientRef !== undefined && clientRef !== null && !REFERENCE_PATTERN.test(String(clientRef))) {
        return apiError(400, 'reference must be 1–64 characters of letters, numbers, dot, underscore or hyphen')
    }

    const service = serviceForBiller(biller)
    const def = UTILITY_SERVICES[service]
    const idempotencyKey = clientRef ? String(clientRef) : null

    // ── Idempotent replay ────────────────────────────────────────────────────
    // Checked before anything else, including the provider round trip: a retried
    // request must not spend another paid lookup, let alone place a second payment.
    // Scoped to this user, which is what makes the key their own namespace.
    if (idempotencyKey) {
        const { data: existing } = await (supabase.from('utility_orders') as any)
            .select('id, reference_code, status')
            .eq('user_id', userId)
            .eq('api_idempotency_key', idempotencyKey)
            .maybeSingle()

        if (existing) {
            logApiRequest({ apiKeyId, userId, endpoint: ENDPOINT, method: 'POST', statusCode: 200, responseTimeMs: Date.now() - startTime, ip })
            // Deliberately smaller than a fresh response: nothing new happened, and
            // echoing an amount or a balance would imply a second charge.
            return apiSuccessV2({
                reference:         existing.reference_code,
                order_id:          existing.id,
                status:            existing.status,
                already_processed: true,
            })
        }
    }

    const { data: settingsRows } = await (supabase.from('admin_settings') as any)
        .select('key, value')
        .in('key', [
            ...utilitySettingKeys(service),
            UTILITY_LAUNCH_KEY,
            'utility_api_min_amount',
            'utility_api_max_amount',
        ])

    const settings: Record<string, string> = {}
    for (const row of ((settingsRows as any[]) || [])) settings[row.key] = row.value

    if (!isUtilityVisibleTo(userRole, settings)) {
        logApiRequest({ apiKeyId, userId, endpoint: ENDPOINT, method: 'POST', statusCode: 503, responseTimeMs: Date.now() - startTime, ip, errorMessage: 'Utilities not launched' })
        return apiError(503, 'Utility bill payments are currently disabled.')
    }
    if (settings[`utility_enabled_${service}`] === 'false') {
        return apiError(503, `${def.label} is currently disabled.`)
    }

    // API limits are checked before buildUtilityIntent's per-service ones so the
    // error names the same numbers GET /billers publishes.
    const parsedAmount = round2(Number(amount))
    const minAmount = Number(settings['utility_api_min_amount'] ?? 1)
    const maxAmount = Number(settings['utility_api_max_amount'] ?? 1000)

    if (!Number.isFinite(parsedAmount) || parsedAmount < minAmount) {
        return apiError(400, `Minimum payment is GHS ${minAmount.toFixed(2)}`)
    }
    if (parsedAmount > maxAmount) {
        return apiError(400, `Maximum payment is GHS ${maxAmount.toFixed(2)}`)
    }

    const cleanAccount = String(account ?? '').replace(/\s+/g, '')
    const cleanPhone = String(phone ?? '').replace(/\s+/g, '')

    if (def.requiresPhone && !/^0\d{9}$/.test(cleanPhone)) {
        return apiError(400, `phone is required for ${biller}. Use Ghana format: 0XXXXXXXXX`)
    }
    // Ghana Water will not issue a receipt without one, and buildUtilityIntent
    // rejects the payment outright — better to say so by name than to let the
    // generic validator answer.
    if (def.requiresEmail && !String(email ?? '').trim()) {
        return apiError(400, `email is required for ${biller} — the provider sends the receipt to it`)
    }

    // ── 30-second duplicate window ───────────────────────────────────────────
    // Only for callers who sent no reference. With one, the replay above already
    // answered; without one there is nothing to tell a double-submit apart from a
    // deliberate second payment, so the safer reading wins.
    if (!idempotencyKey) {
        const since = new Date(Date.now() - DUPLICATE_WINDOW_MS).toISOString()
        const { data: recent } = await (supabase.from('utility_orders') as any)
            .select('id, reference_code')
            .eq('user_id', userId)
            .eq('service', service)
            .eq('account_number', cleanAccount)
            .eq('bill_amount', parsedAmount)
            .gte('created_at', since)
            .maybeSingle()

        if (recent) {
            logApiRequest({ apiKeyId, userId, endpoint: ENDPOINT, method: 'POST', statusCode: 409, responseTimeMs: Date.now() - startTime, ip, errorMessage: 'Duplicate within 30s' })
            return apiError(409, `An identical payment was placed within the last 30 seconds (${recent.reference_code}). Send a unique "reference" to place distinct payments, or reuse the original request's reference to retry it safely.`)
        }
    }

    const built = await buildUtilityIntent(
        { service, accountNumber: cleanAccount, amount: parsedAmount, phone: cleanPhone, email, acknowledgeUnlinkedMeter: body?.acknowledge_unlinked_meter === true },
        settings,
        'api'
    )

    if (!built.ok) {
        logApiRequest({ apiKeyId, userId, endpoint: ENDPOINT, method: 'POST', statusCode: built.status, responseTimeMs: Date.now() - startTime, ip, errorMessage: built.error })
        return apiError(built.status, built.error)
    }

    const intent = built.intent

    const { data: deductResult, error: deductError } = await (supabase as any).rpc('deduct_wallet_balance', {
        p_user_id: userId,
        p_amount: intent.totalPaid,
    })

    if (deductError) {
        if (deductError.message?.includes('INSUFFICIENT_BALANCE')) {
            logApiRequest({ apiKeyId, userId, endpoint: ENDPOINT, method: 'POST', statusCode: 400, responseTimeMs: Date.now() - startTime, ip, errorMessage: 'Insufficient balance' })
            return apiError(400, 'Insufficient wallet balance. Top up your wallet and retry.')
        }
        logApiRequest({ apiKeyId, userId, endpoint: ENDPOINT, method: 'POST', statusCode: 500, responseTimeMs: Date.now() - startTime, ip, errorMessage: deductError.message })
        return apiError(500, 'Payment processing failed')
    }

    const walletRow = deductResult?.[0] || deductResult
    const walletId = walletRow?.wallet_id
    const newBalance = walletRow?.new_balance

    if (!walletId) return apiError(404, 'Wallet not found')

    // Ours, not the caller's. Table-wide unique, and what GET /utilities/orders takes.
    const referenceCode = `UTIL-${biller.toUpperCase()}-${randomBytes(8).toString('hex')}`

    const { data: order, error: orderError } = await (supabase.from('utility_orders') as any)
        .insert({
            user_id:             userId,
            user_role:           userRole,
            service:             intent.service,
            account_number:      intent.accountNumber,
            account_name:        intent.accountName,
            destination:         intent.destination,
            customer_phone:      intent.customerPhone,
            customer_email:      intent.customerEmail,
            session_id:          intent.sessionId,
            bill_amount:         intent.billAmount,
            fee_rate:            intent.feeRate,
            fee_amount:          intent.feeAmount,
            total_paid:          intent.totalPaid,
            payment_method:      'wallet',
            payment_status:      'paid',
            status:              'pending',
            reference_code:      referenceCode,
            client_reference:    buildUtilityClientReference(referenceCode),
            api_idempotency_key: idempotencyKey,
            api_key_id:          apiKeyId,
        })
        .select()
        .single()

    if (orderError || !order) {
        // Nothing was bought — put the money straight back.
        await (supabase as any).rpc('credit_wallet_balance', { p_user_id: userId, p_amount: intent.totalPaid }).catch(() => {})
        logApiRequest({ apiKeyId, userId, endpoint: ENDPOINT, method: 'POST', statusCode: 500, responseTimeMs: Date.now() - startTime, ip, errorMessage: orderError?.message })
        return apiError(500, 'Failed to create order')
    }

    ;(supabase.from('wallet_transactions') as any).insert({
        wallet_id:   walletId,
        user_id:     userId,
        type:        'debit',
        amount:      intent.totalPaid,
        description: `API ${intent.label}: GHS ${intent.billAmount.toFixed(2)} → ${intent.accountNumber}`,
        reference:   referenceCode,
        source:      'api_purchase',
        status:      'completed',
    }).then(() => {}).catch(() => {})

    sendPushToAdmins({
        title: 'New API Bill Payment',
        body: `API: ${intent.label} GHS ${intent.billAmount.toFixed(2)} → ${intent.accountNumber}`,
        url: '/admin/utilities',
    }).catch(() => {})

    waitUntil(triggerUtilityFulfillment((order as any).id))

    const sharePercent = await commissionSharePercent(supabase)

    logApiRequest({ apiKeyId, userId, endpoint: ENDPOINT, method: 'POST', statusCode: 201, responseTimeMs: Date.now() - startTime, ip })

    return apiSuccessV2({
        reference:   referenceCode,
        order_id:    (order as any).id,
        status:      'pending',
        biller,
        account:     intent.accountNumber,
        amount:      intent.billAmount,
        // What the partner will earn once the order completes, not what they have
        // earned now — the provider has not reported its commission yet.
        commission_share_percent: sharePercent,
        new_balance: newBalance,
    })
}
