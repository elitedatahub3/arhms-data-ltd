/**
 * MTN registration gate — which admin_settings keys switch it on, per surface.
 *
 * Kept apart from lib/mtn-registration-gate.ts because it is pure: the admin page
 * imports it in the browser, and the gate module pulls in the supplier client.
 */

/**
 * Which toggle governs a call. 'shop' is the reseller storefronts; 'site' is the main
 * site — the dashboard purchase routes and USSD, which sells the main catalogue; 'api'
 * is the developer API's data endpoints (v1 and v2, single and bulk).
 */
export type GateSurface = 'shop' | 'site' | 'api'

/** One admin_settings key per surface. The admin fulfillment page writes these. */
export const MTN_GATE_KEYS: Record<GateSurface, string> = {
    shop: 'mtn_registration_gate_shop_enabled',
    site: 'mtn_registration_gate_site_enabled',
    api: 'mtn_registration_gate_api_enabled',
}

/**
 * The single switch that predates the split. Read only as a fallback for a surface
 * whose own key has never been written, so deploying the split changes nothing until
 * an admin flips one of the new toggles. Never for 'api': the API was ungated when the
 * legacy key was in use, and must stay so until its own switch is turned on.
 */
export const LEGACY_MTN_GATE_KEY = 'mtn_registration_gate_enabled'

/** Every key a gate decision can depend on, for callers that batch their reads. */
export const ALL_MTN_GATE_KEYS = [MTN_GATE_KEYS.shop, MTN_GATE_KEYS.site, MTN_GATE_KEYS.api, LEGACY_MTN_GATE_KEY]

/**
 * Resolution from raw admin_settings values. Shared by the gate, the USSD route (which
 * reads its settings in its own batched query) and the admin page, so none of them can
 * disagree about whether a surface is gated. An absent row falls back to the legacy
 * key (except for 'api', which is off); a present row — even 'false' — is final.
 */
export function resolveGateEnabled(raw: Record<string, unknown>, surface: GateSurface): boolean {
    const own = raw[MTN_GATE_KEYS[surface]]
    const absent = own === undefined || own === null
    if (absent && surface === 'api') return false
    const value = absent ? raw[LEGACY_MTN_GATE_KEY] : own
    return String(value) === 'true'
}
