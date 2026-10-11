/**
 * MTN registration gate — which admin_settings keys switch it on, per surface.
 *
 * Kept apart from lib/mtn-registration-gate.ts because it is pure: the admin page
 * imports it in the browser, and the gate module pulls in the supplier client.
 */

/**
 * Which toggle governs a call. 'shop' is the reseller storefronts; 'site' is the main
 * site — the dashboard purchase routes and USSD, which sells the main catalogue.
 */
export type GateSurface = 'shop' | 'site'

/** One admin_settings key per surface. The admin fulfillment page writes these. */
export const MTN_GATE_KEYS: Record<GateSurface, string> = {
    shop: 'mtn_registration_gate_shop_enabled',
    site: 'mtn_registration_gate_site_enabled',
}

/**
 * The single switch that predates the split. Read only as a fallback for a surface
 * whose own key has never been written, so deploying the split changes nothing until
 * an admin flips one of the new toggles.
 */
export const LEGACY_MTN_GATE_KEY = 'mtn_registration_gate_enabled'

/** Every key a gate decision can depend on, for callers that batch their reads. */
export const ALL_MTN_GATE_KEYS = [MTN_GATE_KEYS.shop, MTN_GATE_KEYS.site, LEGACY_MTN_GATE_KEY]

/**
 * Resolution from raw admin_settings values. Shared by the gate, the USSD route (which
 * reads its settings in its own batched query) and the admin page, so none of them can
 * disagree about whether a surface is gated. An absent row falls back to the legacy
 * key; a present row — even 'false' — is final.
 */
export function resolveGateEnabled(raw: Record<string, unknown>, surface: GateSurface): boolean {
    const own = raw[MTN_GATE_KEYS[surface]]
    const value = own === undefined || own === null ? raw[LEGACY_MTN_GATE_KEY] : own
    return String(value) === 'true'
}
