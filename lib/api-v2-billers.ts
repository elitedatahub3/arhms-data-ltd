/**
 * The biller vocabulary the v2 Commission Services API speaks.
 *
 * Deliberately a translation layer rather than a re-export. The public keys are
 * fixed contract — `ghana_water` with an underscore, because that is what the docs
 * promise integrators — while the internal service ids in lib/hubtel-utility-service
 * are `ghanawater` and free to change. Without this mapping the two would be welded
 * together and renaming either would break live integrations.
 */
import {
    UTILITY_SERVICES,
    type UtilityService,
    type UtilityDetailRow,
    type UtilityQueryResult,
} from '@/lib/hubtel-utility-service'

/** Public biller keys, in the order the docs list them. */
export const BILLER_KEYS = ['ecg', 'ghana_water', 'dstv', 'gotv', 'startimes'] as const
export type BillerKey = typeof BILLER_KEYS[number]

const BILLER_TO_SERVICE: Record<BillerKey, UtilityService> = {
    ecg:         'ecg',
    ghana_water: 'ghanawater',
    dstv:        'dstv',
    gotv:        'gotv',
    startimes:   'startimes',
}

const SERVICE_TO_BILLER: Record<string, BillerKey> = Object.fromEntries(
    Object.entries(BILLER_TO_SERVICE).map(([biller, service]) => [service, biller])
) as Record<string, BillerKey>

export function isBillerKey(value: unknown): value is BillerKey {
    return typeof value === 'string' && (BILLER_KEYS as readonly string[]).includes(value)
}

export function serviceForBiller(biller: BillerKey): UtilityService {
    return BILLER_TO_SERVICE[biller]
}

/** For rendering an order back out: the stored row holds the internal service id. */
export function billerForService(service: string): BillerKey | null {
    return SERVICE_TO_BILLER[service] ?? null
}

/** Public label for the account field, shorter than the form label used in the UI. */
const ACCOUNT_LABEL: Record<BillerKey, string> = {
    ecg:         'Meter number',
    ghana_water: 'Meter number',
    dstv:        'Smartcard number',
    gotv:        'IUC number',
    startimes:   'Account number',
}

const PUBLIC_LABEL: Record<BillerKey, string> = {
    ecg:         'ECG Prepaid & Postpaid',
    ghana_water: 'Ghana Water',
    dstv:        'DSTV',
    gotv:        'GOtv',
    startimes:   'StarTimes',
}

export interface BillerDescriptor {
    key: BillerKey
    label: string
    enabled: boolean
    account_label: string
    requires_phone: boolean
    /** Which field the provider actually queries on. ECG is the odd one out. */
    lookup_by: 'phone' | 'account'
    /** True only for ECG: one phone can carry several meters. */
    links_phone_to_account: boolean
    has_amount_due: boolean
}

/**
 * @param settings admin_settings rows keyed by name, already loaded by the caller.
 *
 * Disabled billers are still returned. An integrator building a picker needs to know
 * a biller exists in order to grey it out; omitting it makes their UI silently lose
 * an option and look broken rather than temporarily unavailable.
 */
export function describeBillers(settings: Record<string, string>): BillerDescriptor[] {
    return BILLER_KEYS.map(key => {
        const service = BILLER_TO_SERVICE[key]
        const def = UTILITY_SERVICES[service]
        const isEcg = def.kind === 'meter-by-phone'

        return {
            key,
            label:                  PUBLIC_LABEL[key],
            enabled:                settings[`utility_enabled_${service}`] !== 'false',
            account_label:          ACCOUNT_LABEL[key],
            requires_phone:         def.requiresPhone,
            lookup_by:              isEcg ? 'phone' : 'account',
            links_phone_to_account: isEcg,
            has_amount_due:         true,
        }
    })
}

/** admin_settings keys describeBillers() reads, for the caller's `.in()` query. */
export function billerCatalogSettingKeys(): string[] {
    return BILLER_KEYS.map(key => `utility_enabled_${BILLER_TO_SERVICE[key]}`)
}

/**
 * Splits a failed lookup into "no such account" (404) and "provider is down" (502).
 *
 * The distinction matters to an integrator: a 404 means stop and ask the customer to
 * re-enter the number, a 502 means retry in a moment. Getting it backwards either
 * sends them into an infinite retry loop or tells them a real meter does not exist.
 *
 * UtilityQueryResult carries no explicit flag, so this reads the two signals it does
 * have. A `responseCode` means Hubtel answered and rejected the account — a business
 * outcome. Its absence means we never got a parseable answer: circuit breaker open,
 * timeout, unwhitelisted IP, or a 5xx. The one wrinkle is ECG's "no meters linked",
 * which is a genuine not-found reported without a response code, so the default is
 * 404 and only the recognised unavailability messages escalate to 502.
 */
export function lookupFailureStatus(lookup: UtilityQueryResult): 404 | 502 {
    if (lookup.responseCode) return 404

    const message = String(lookup.error || '').toLowerCase()
    const unavailable =
        message.includes('temporarily unavailable')
        || message.includes('invalid response')
        || message.includes('timed out')
        || message.includes('timeout')
        || message.includes('unreachable')
        || message.includes('network')
        || message.includes('whitelist')

    return unavailable ? 502 : 404
}

/**
 * Pulls the bouquet / package name out of the provider's display rows.
 *
 * Pay-TV lookups return it as one keyed row among several; there is no dedicated
 * field on UtilityQueryResult because nothing in the web UI shows it. Returns null
 * rather than undefined so the JSON always carries the key — an integrator checking
 * `data.bouquet` should not have to distinguish "absent" from "not applicable".
 */
export function extractBouquet(details: UtilityDetailRow[] | undefined): string | null {
    for (const row of details || []) {
        const key = String(row?.display || '').toLowerCase().replace(/\s+/g, '')
        if (key.includes('bouquet') || key.includes('package') || key.includes('plan')) {
            const value = String(row?.value ?? '').trim()
            if (value) return value
        }
    }
    return null
}

/**
 * The lookup response shape the docs promise.
 *
 * ECG is genuinely different, not merely sparser: the provider answers a phone
 * number with a LIST of meters and no single account, so account_name /
 * account_number / amount_due / bouquet are all null and `meters` carries the
 * result. Every other biller is the mirror image — one account, empty `meters`.
 * Both shapes are always present so a client can parse one object.
 */
export function toLookupPayload(
    biller: BillerKey,
    account: string,
    lookup: UtilityQueryResult
): Record<string, any> {
    const isEcg = biller === 'ecg'

    if (isEcg) {
        return {
            account_name:   null,
            account_number: null,
            amount_due:     null,
            bouquet:        null,
            meters: (lookup.meters || []).map(m => ({
                // The provider packs "NAME (METER)" into one label; the name alone is
                // what a customer needs to recognise their own meter.
                name: (/^(.*?)\s*\(/.exec(m.label)?.[1] || m.label || '').trim(),
                meterNumber: m.meterNumber,
                outstanding: m.balance,
            })),
        }
    }

    return {
        account_name:   lookup.accountName ?? null,
        account_number: account,
        amount_due:     lookup.amountDue ?? null,
        bouquet:        extractBouquet(lookup.details),
        meters:         [],
    }
}
