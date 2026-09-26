/**
 * The master switch for everything USSD.
 *
 * One admin_settings key gates the whole stack: the dial-in service, the sale of
 * short codes, and every surface that advertises either. It exists so USSD can be
 * taken off the air from /admin/settings without a deploy — the dial code itself
 * lives in the Hubtel dashboard, so a deploy could not take it down anyway.
 */
export const USSD_ENABLED_KEY = 'ussd_enabled'

/**
 * Hard block. Now lifted: /admin/settings decides again.
 *
 * The history matters, because it is the reason this constant exists at all. The
 * admin switch was flipped off and USSD kept taking money — the toggle only writes
 * on Save, so it was easy to believe the service was shut while the stored value
 * was still 'true'. The answer was taken away from the database entirely until
 * that could be trusted again.
 *
 * Lifting it is therefore only safe alongside a known stored value, which is why
 * migration 20260826000000_ussd_reopen_gate.sql force-writes ussd_enabled to
 * 'false' rather than leaving whatever was there. Removing this block without
 * pinning that value would hand the service back to the same unverified string
 * that caused the problem.
 *
 * TO CLOSE USSD AGAIN IN A HURRY: set this back to true. It outranks the database,
 * every cache and any unsaved form, and takes effect on deploy. Short codes shops
 * have already bought are untouched either way — this is a door, not a cancellation.
 */
const USSD_HARD_DISABLED = false

/**
 * Whether USSD is open for business.
 *
 * Fails CLOSED on purpose: a missing row, an unreachable admin_settings read, or
 * any value that isn't exactly 'true' all mean off. A switch whose job is to stop
 * a live service taking money is worthless if a failed lookup leaves the service
 * running, and every USSD step past this point needs the same database anyway.
 * Turning it back on is one deliberate 'true'.
 */
export function isUssdEnabled(
    settings: Record<string, string | null | undefined> | null | undefined
): boolean {
    if (USSD_HARD_DISABLED) return false
    return settings?.[USSD_ENABLED_KEY] === 'true'
}

/**
 * What a caller hears before the line drops when they dial in while USSD is off.
 *
 * ASCII only and well under a 160-character screen: a non-ASCII character makes
 * the Hubtel call throw, and a long one gets truncated mid-sentence.
 */
export const USSD_OFFLINE_MESSAGE =
    'ARHMS USSD is currently unavailable. Please buy at arhmsgh.com. Thank you.'

/** Shown wherever someone tries to buy or manage a short code while USSD is off. */
export const USSD_UNAVAILABLE_MESSAGE =
    'USSD short codes are currently unavailable. Please check back later.'
