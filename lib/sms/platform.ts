/**
 * SMS Platform — the account-level state that sits on top of Customer SMS:
 * Platform vs Business Mode, the business registration, daily limits and
 * sender ID caps.
 *
 * Every read here tolerates the 20261010000000_sms_platform migration not having
 * run yet. A missing column or table answers "Platform Mode, no business", so
 * deploying ahead of the migration degrades to today's behaviour instead of
 * failing every SMS route.
 */

import type { SmsMode } from '@/lib/sms/sms-rules'

export const SMS_PLATFORM_SETTING_KEYS = [
    'sms_daily_limit_platform',
    'sms_daily_limit_business',
    'sms_sender_cap_platform',
    'sms_sender_cap_business',
    // Where business owners send their Ghana Card and registration documents.
    'sms_business_docs_whatsapp',
] as const

const DEFAULTS = {
    sms_daily_limit_platform: 1000,
    sms_daily_limit_business: 0,
    sms_sender_cap_platform: 3,
    sms_sender_cap_business: 200,
} as const

/** admin_settings values arrive as JSON-quoted strings ("\"1000\""). */
function numberSetting(settings: Record<string, any>, key: keyof typeof DEFAULTS): number {
    const raw = settings?.[key]
    if (raw === undefined || raw === null || raw === '') return DEFAULTS[key]
    const n = Number(String(raw).replace(/^"+|"+$/g, '').trim())
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULTS[key]
}

/** Recipients per UTC day for this mode. 0 means no limit. */
export function dailyLimitFor(mode: SmsMode, settings: Record<string, any>): number {
    return numberSetting(settings, mode === 'business' ? 'sms_daily_limit_business' : 'sms_daily_limit_platform')
}

/** How many live (pending, submitted or approved) sender IDs this mode may hold. */
export function senderCapFor(mode: SmsMode, settings: Record<string, any>): number {
    return numberSetting(settings, mode === 'business' ? 'sms_sender_cap_business' : 'sms_sender_cap_platform')
}

export async function getAccountMode(db: any, accountId: string): Promise<SmsMode> {
    try {
        const { data, error } = await db.from('sms_accounts').select('mode').eq('id', accountId).maybeSingle()
        if (error) return 'platform'
        return (data as any)?.mode === 'business' ? 'business' : 'platform'
    } catch {
        return 'platform'
    }
}

export interface SmsBusinessRow {
    id: string
    business_name: string
    description: string
    domain: string | null
    ghana_card_last4: string | null
    whatsapp: string | null
    status: 'draft' | 'pending' | 'approved' | 'rejected'
    rejection_reason: string | null
    submitted_at: string | null
    reviewed_at: string | null
    created_at: string
    updated_at: string
}

export const SMS_BUSINESS_COLUMNS =
    'id, business_name, description, domain, ghana_card_last4, whatsapp, status, rejection_reason, submitted_at, reviewed_at, created_at, updated_at'

/** The account's business registration, or null (also when the table is missing). */
export async function getSmsBusiness(db: any, accountId: string): Promise<SmsBusinessRow | null> {
    try {
        const { data, error } = await db
            .from('sms_businesses')
            .select(SMS_BUSINESS_COLUMNS)
            .eq('account_id', accountId)
            .maybeSingle()
        if (error) return null
        return (data as SmsBusinessRow) ?? null
    } catch {
        return null
    }
}

/**
 * The SMS API is for verified businesses only: a key can be generated, and an
 * existing key used, only while the account's business registration is approved.
 * Shops are not exempt — an approved shop is not a verified SMS business.
 */
export const SMS_API_NEEDS_BUSINESS =
    'The SMS API is available once your business is approved. Submit it under Business & Sender ID.'

export async function isSmsBusinessApproved(db: any, accountId: string): Promise<boolean> {
    return (await getSmsBusiness(db, accountId))?.status === 'approved'
}

/** Start of the current UTC day — Ghana is UTC+0 all year, so this is local midnight. */
export function startOfTodayIso(): string {
    const now = new Date()
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString()
}

/** Messages queued on this account since midnight, across every source. */
export async function countSentToday(db: any, accountId: string): Promise<number> {
    const { count, error } = await db
        .from('sms_messages')
        .select('id', { count: 'exact', head: true })
        .eq('account_id', accountId)
        .gte('created_at', startOfTodayIso())
    if (error) {
        // Fail open: a counting error must not stop paid-for sends.
        console.error('[SmsPlatform] daily count failed:', error.message)
        return 0
    }
    return count ?? 0
}

// ============================================================
// CREDIT BUNDLES
// ============================================================

/** Customer SMS (shop and sub portals) and the SMS Platform keep separate price lists. */
export type BundleAudience = 'shop' | 'platform'

export function bundleAudienceFor(portal: string | null | undefined): BundleAudience {
    return portal === 'platform' ? 'platform' : 'shop'
}

/**
 * Active bundles for one price list.
 *
 * Before 20261016010000_sms_platform_bundles.sql adds the audience column,
 * every bundle is a shop bundle: Customer SMS keeps its list and the SMS
 * Platform has none, rather than both erroring.
 */
export async function fetchBundles(db: any, audience: BundleAudience): Promise<{ id: string; name: string; credits: number; price: number }[]> {
    const { data, error } = await db
        .from('sms_credit_bundles')
        .select('id, name, credits, price')
        .eq('is_active', true)
        .eq('audience', audience)
        .order('sort_order', { ascending: true })

    if (!error) return data || []
    if (error.code !== '42703') {
        console.error('[SmsPlatform] bundle query failed:', error.message)
        return []
    }
    if (audience === 'platform') return []

    const { data: all } = await db
        .from('sms_credit_bundles')
        .select('id, name, credits, price')
        .eq('is_active', true)
        .order('sort_order', { ascending: true })
    return all || []
}

/** Which price list a bundle row belongs to; rows from before the column are shop bundles. */
export function bundleAudienceOf(row: { audience?: string | null } | null | undefined): BundleAudience {
    return row?.audience === 'platform' ? 'platform' : 'shop'
}
