/**
 * The SMS account behind an SMS API key — what /api/v2/sms/* needs about the
 * caller, resolved once. The session-based twin is loadSmsContext() in
 * lib/sms/sms-purchase.ts; this one starts from a validated API key instead.
 */

import { NextRequest, NextResponse } from 'next/server'
import {
    validateApiKey, isApiError, apiError, logApiRequest, getClientIp, enforceRateLimit,
    type ApiAuthResult, type RateLimitBucket,
} from '@/lib/api-auth'
import { resolveSmsAccount, type SmsAccount } from '@/lib/sms/customer-sms'
import { resolveSubAgentContext } from '@/lib/sub-agents'
import { isCustomerSmsEnabled, smsBlockReason, SMS_DISABLED_MESSAGE } from '@/lib/sms/sms-purchase'
import { getAccountMode, isSmsBusinessApproved, SMS_API_NEEDS_BUSINESS, SMS_PLATFORM_SETTING_KEYS } from '@/lib/sms/platform'
import type { SmsMode } from '@/lib/sms/sms-rules'

export interface SmsApiContext {
    auth: ApiAuthResult
    db: any
    account: SmsAccount
    mode: SmsMode
    shopId: string | null
    settingsMap: Record<string, any>
    /** Logs the call to api_logs with this request's timing and endpoint. */
    log: (statusCode: number, errorMessage?: string) => void
}

export async function loadSmsApiContext(
    request: NextRequest,
    endpoint: string,
    bucket: RateLimitBucket
): Promise<SmsApiContext | NextResponse> {
    const startTime = Date.now()
    const ip = getClientIp(request)
    const method = request.method

    const auth = await validateApiKey(request, { version: 'v2', kind: 'sms' })
    if (isApiError(auth)) {
        logApiRequest({ apiKeyId: null, userId: null, endpoint, method, statusCode: auth.status, responseTimeMs: Date.now() - startTime, ip, errorMessage: 'Auth failed' })
        return auth
    }

    const log = (statusCode: number, errorMessage?: string) => logApiRequest({
        apiKeyId: auth.apiKeyId, userId: auth.userId, endpoint, method, statusCode,
        responseTimeMs: Date.now() - startTime, ip, errorMessage,
    })

    const limited = await enforceRateLimit(auth, bucket)
    if (limited) {
        log(429, 'Rate limited')
        return limited
    }

    // validateApiKey hands back a service-role client.
    const db = auth.supabase as any

    const { data: settings } = await db
        .from('admin_settings')
        .select('key, value')
        .in('key', ['sms_customer_enabled', 'sms_inline_send_max', 'sms_pool_senders', ...SMS_PLATFORM_SETTING_KEYS])
    const settingsMap: Record<string, any> = {}
    for (const row of (settings || [])) settingsMap[(row as any).key] = (row as any).value

    if (!isCustomerSmsEnabled(settingsMap)) {
        log(503, 'SMS disabled')
        return apiError(503, SMS_DISABLED_MESSAGE)
    }

    // validateApiKey has already refused an inactive user; a sub-agent whose
    // membership is not active is refused the same way the dashboard does.
    const sub = await resolveSubAgentContext(db, auth.userId)
    const blocked = smsBlockReason(null, sub)
    if (blocked) {
        log(403, blocked)
        return apiError(403, blocked)
    }

    const { data: shop } = await db
        .from('shop_profiles')
        .select('id')
        .eq('owner_id', auth.userId)
        .maybeSingle()

    const account = await resolveSmsAccount(db, auth.userId, (shop as any)?.id ?? null)
    if (!account) {
        log(500, 'No SMS account')
        return apiError(500, 'Could not load your SMS account')
    }

    // Checked on every call, not only at key generation, so a business that is
    // later rejected loses the API with it.
    if (!(await isSmsBusinessApproved(db, account.id))) {
        log(403, 'Business not approved')
        return apiError(403, SMS_API_NEEDS_BUSINESS)
    }

    const mode = await getAccountMode(db, account.id)

    return { auth, db, account, mode, shopId: (shop as any)?.id ?? null, settingsMap, log }
}
