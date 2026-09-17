/**
 * MTN Registration Gate
 *
 * An MTN number that is not enabled ("whitelisted") on the Agent Portal account
 * cannot receive data. Historically we only found that out at fulfillment time —
 * after the wallet was debited — and the order sat pending with no explanation.
 *
 * This module moves the check in front of payment, on the surfaces that use it.
 *
 * WHERE IT RUNS, and why each one refuses:
 *
 *   • Shop storefront (/api/shop/initialize) — REFUSES. A guest has no account, so a
 *     held order is one they can neither track nor chase.
 *
 *   • USSD (/api/hubtel/interact) — REFUSES, and fails closed. A caller cannot be
 *     shown a dialog, cannot be told anything after the line drops, and cannot be
 *     refunded in-session.
 *
 *   • Dashboard — REFUSES, across all three of its purchase routes:
 *     /api/orders/purchase, /api/orders/bulk-purchase and /api/orders/gateway-init.
 *     Added by explicit request: a pending order an agent cannot explain to their own
 *     customer is worth less than a clear "not yet". All three must stay gated together
 *     — leaving any one open is a way to buy the same number the others just refused,
 *     and Direct Pay (gateway-init) takes the money before an order row exists at all.
 *     A bulk batch refuses whole, so an agent never has to reconcile a part-charged paste.
 *
 * The public API v1 deliberately does NOT call this. An integrator's order is accepted,
 * the supplier rejects it at fulfillment time and auto-submits the number to MTN, and it
 * stays pending for the auto-refulfill cron to deliver once the number is enabled. That
 * is the behaviour that predates this module, kept so a live integration never starts
 * seeing an error code it was not written to handle.
 *
 * So do not "restore consistency" by wiring this into an API v1 route. That exemption
 * is the requirement; scripts/test-mtn-gate-strict.ts asserts the whole import graph.
 *
 * Three things worth knowing before you change anything here:
 *
 *   1. Checking is NOT read-only. verifyMtnWhitelist() auto-submits any number that
 *      is not yet enabled, as a side effect of the same upstream call. There is no
 *      check-only endpoint. So merely reaching this code starts the registration —
 *      which is what makes "try again in two weeks" an honest thing to tell someone
 *      we just refused.
 *
 *   2. It fails OPEN, with one named exception. A supplier outage must not stop MTN
 *      sales, so anything we cannot answer confidently resolves to "not gated" and the
 *      order proceeds as pending — the whitelistPending path in fulfillOrder() is still
 *      the backstop it always was. The exception is checkMtnRegistrationStrict(), used
 *      only by USSD, which fails CLOSED; see the note on that function for why.
 *
 *   3. It is off by default, and that toggle is the ONLY thing controlling it.
 *      admin_settings.mtn_registration_gate_enabled runs the check regardless of which
 *      supplier currently fulfils MTN — see loadGateSettings for why that is a
 *      deliberate choice with a real cost attached.
 */
import { verifyMtnWhitelist } from '@/lib/agentportal-service'
import { validateGhanaianPhone } from '@/lib/phone-validation'
import { redactIdentifier } from '@/lib/safe-log'

/**
 * Only plain MTN data orders are gated.
 *
 * 'Special MTN Mashup' and 'EXPRESS MTN' also run on MTN SIMs, but they are always
 * fulfilled MANUALLY by an admin — they never go through Agent Portal, so the
 * whitelist has no bearing on whether they can be delivered. Gating them would block
 * a sale on a check that does not apply to it.
 */
const MTN_PACKAGE_NETWORKS = new Set(['MTN'])

/** How long a "not registered" answer is trusted before we ask upstream again. */
const NEGATIVE_TTL_MS = 30 * 60 * 1000

/** How long the admin settings read is memoized in-process. */
const SETTINGS_TTL_MS = 60 * 1000

/** Upstream budget on the purchase path — this sits between Pay and the payment prompt. */
const UPSTREAM_TIMEOUT_MS = 4000

/**
 * Upstream budget on the USSD path — a quarter of the web one, deliberately.
 *
 * This check sits inside a live keypress on a step that previously did no network I/O
 * at all. Hubtel drops the session if we take too long, and a dropped session reads to
 * the caller as a broken service. Better to answer "cannot verify" fast than to hang.
 */
const USSD_UPSTREAM_TIMEOUT_MS = 1500

/** The single wait time quoted to buyers. Change it here and everywhere follows. */
export const REGISTRATION_WAIT_TEXT = 'up to 2 weeks'

/**
 * What a USSD caller hears before the line drops, for each reason we refuse.
 *
 * ASCII only and well under a 160-character screen — a non-ASCII character makes the
 * Hubtel call throw, and a long one gets truncated mid-sentence. They live here rather
 * than in the route so the two-week promise is worded from the same place as everywhere
 * else, but note they cannot interpolate REGISTRATION_WAIT_TEXT: these are read aloud
 * off a feature-phone screen and the phrasing is tuned to the character budget.
 */
export const USSD_NOT_REGISTERED_MESSAGE =
    'This MTN number is not registered for data yet. We have started registering it. This can take up to 2 weeks. Please try again after that.'

export const USSD_REGISTRATION_UNVERIFIABLE_MESSAGE =
    'We cannot verify this MTN number right now. Please try again in a few minutes or buy at arhmsgh.com.'

/** Error code every gated route returns, and every client checks for. */
export const MTN_NOT_REGISTERED = 'MTN_NOT_REGISTERED'

export type RegistrationStatus = 'registered' | 'unregistered' | 'unknown'

export type RegistrationGateResult =
    /** Not MTN, gate off, already registered, or we could not tell — let it through. */
    | { gated: false }
    /** Confirmed not registered. Refuse unless the buyer has acknowledged the wait. */
    | { gated: true; normalizedNumber: string }

export interface BatchGateResult {
    /** Normalized numbers confirmed NOT registered. Empty means nothing to gate. */
    unregistered: string[]
    /** Per-number status, keyed by normalized number. Callers use this for UI badges. */
    statusByNumber: Map<string, RegistrationStatus>
}

/** True when a package is a plain MTN data bundle — the only kind this gate applies to. */
export function isMtnPackageNetwork(network: string | null | undefined): boolean {
    return MTN_PACKAGE_NETWORKS.has(String(network || '').trim())
}

/**
 * The 409 body. Produced by /api/shop/initialize and consumed by ShopStorefront —
 * the storefront is the only surface that returns this at all now (USSD refuses over
 * the wire with a plain message, and nothing else is gated). Kept as a shared helper
 * because the shape is a contract between a route and a client that live apart.
 *
 * `total` is unused at the single call site today; it stays for the batch framing the
 * dialog still renders ("3 of 20"), which a bulk storefront checkout would need.
 */
export function registrationRequiredBody(phoneNumbers: string[], total?: number) {
    const single = phoneNumbers.length === 1
    return {
        error: single
            ? 'This MTN number is not registered yet'
            : `${phoneNumbers.length} of these MTN numbers are not registered yet`,
        code: MTN_NOT_REGISTERED,
        registration: {
            phoneNumbers,
            phoneNumber: phoneNumbers[0],
            estimatedWait: REGISTRATION_WAIT_TEXT,
            ...(typeof total === 'number' ? { total } : {}),
        },
    }
}

// ─── Admin settings (memoized) ──────────────────────────────────────────────────

interface GateSettings {
    /** The one and only switch. Nothing else gates this. */
    enabled: boolean
}

let settingsCache: { value: GateSettings; expiresAt: number } | null = null

/**
 * Deliberately independent of which supplier currently fulfils MTN.
 *
 * An earlier version also required agentportal_networks.MTN === true, on the
 * reasoning that Agent Portal's whitelist is a list of numbers enabled on OUR Agent
 * Portal account — so while a different supplier (e.g. DataKazina) delivers MTN, a
 * number missing from that list may still receive data perfectly well.
 *
 * That guard was removed by explicit request: the check is now treated as a general
 * "has this MTN number ever been registered with us" signal and runs whenever the
 * admin toggle is on, whoever is fulfilling. The accepted cost is that some orders
 * the active supplier could have delivered will be held pending instead.
 *
 * If held orders start piling up on numbers that would have delivered fine, this is
 * the first thing to reconsider — not a bug.
 */
async function loadGateSettings(supabase: any): Promise<GateSettings> {
    if (settingsCache && settingsCache.expiresAt > Date.now()) return settingsCache.value

    const disabled: GateSettings = { enabled: false }

    try {
        const { data } = await supabase
            .from('admin_settings')
            .select('key, value')
            .eq('key', 'mtn_registration_gate_enabled')

        const row = (data || [])[0]

        // Absent row means off. Deploying this must not change buyer-facing behaviour.
        const value: GateSettings = { enabled: String(row?.value) === 'true' }

        settingsCache = { value, expiresAt: Date.now() + SETTINGS_TTL_MS }
        return value
    } catch (error: any) {
        // Cannot read settings → behave as if off. Fail open, and do not cache the
        // failure: the next request should get a fresh chance to read them.
        console.error('[MtnGate] Settings read failed, gate treated as off:', error?.message)
        return disabled
    }
}

/** Test/ops hook — drops the memo so a toggle flip applies immediately. */
export function clearGateSettingsCache() {
    settingsCache = null
}

// ─── Cache reads / writes ───────────────────────────────────────────────────────

interface CachedRow {
    phone_number: string
    is_registered: boolean
    first_submitted_at: string | null
    registered_at: string | null
    last_checked_at: string
}

async function readCache(supabase: any, numbers: string[]): Promise<Map<string, CachedRow>> {
    const byNumber = new Map<string, CachedRow>()
    if (numbers.length === 0) return byNumber

    const { data, error } = await supabase
        .from('mtn_registered_numbers')
        .select('phone_number, is_registered, first_submitted_at, registered_at, last_checked_at')
        .in('phone_number', numbers)

    if (error) {
        console.error('[MtnGate] Cache read failed, falling through to upstream:', error.message)
        return byNumber
    }

    for (const row of data || []) byNumber.set(row.phone_number, row as CachedRow)
    return byNumber
}

/**
 * Persist verification results. Exported so the bulk checker page
 * (/api/mtn/check-registration) warms the same cache the purchase gate reads.
 *
 * first_submitted_at is never overwritten — it is when we first asked MTN to enable
 * the number, and "how long has this been waiting?" is measured from it.
 */
export async function recordRegistrationResults(
    supabase: any,
    results: Array<{ phoneNumber: string; isRegistered: boolean }>
): Promise<void> {
    if (results.length === 0) return

    const now = new Date().toISOString()
    const existing = await readCache(supabase, results.map(r => r.phoneNumber))

    // Every row carries the same keys — a mixed-shape payload breaks a bulk upsert.
    const rows = results.map(({ phoneNumber, isRegistered }) => {
        const prior = existing.get(phoneNumber)
        return {
            phone_number: phoneNumber,
            is_registered: isRegistered,
            first_submitted_at: isRegistered
                ? (prior?.first_submitted_at ?? null)
                : (prior?.first_submitted_at ?? now),
            // Stamped the first time we see it enabled, then left alone.
            registered_at: isRegistered ? (prior?.registered_at ?? now) : null,
            last_checked_at: now,
        }
    })

    const { error } = await supabase
        .from('mtn_registered_numbers')
        .upsert(rows, { onConflict: 'phone_number' })

    if (error) {
        // The cache is an optimization, never a source of truth. Losing a write costs
        // one extra upstream call next time — it must not fail the purchase.
        console.error('[MtnGate] Cache write failed:', error.message)
    }
}

// ─── The gate ───────────────────────────────────────────────────────────────────

/**
 * Reduce raw entries to the distinct, valid, MTN numbers worth asking about.
 *
 * Both conditions matter: the PACKAGE must be plain MTN, and the NUMBER must carry an
 * MTN prefix. A Telecel number ordered onto an MTN bundle is a mis-typed order, not an
 * unregistered one, and the whitelist has nothing to say about it.
 */
function collectCandidates(
    entries: Array<{ phoneNumber: string; packageNetwork: string }>
): Set<string> {
    const candidates = new Set<string>()
    for (const entry of entries) {
        if (!isMtnPackageNetwork(entry.packageNetwork)) continue
        const validation = validateGhanaianPhone(entry.phoneNumber)
        if (!validation.isValid || validation.network !== 'MTN') continue
        candidates.add(validation.normalizedNumber)
    }
    return candidates
}

/**
 * Cache-first status resolution for a set of already-validated numbers.
 *
 * Shared by both entry points so the caching rules, the staleness window and the
 * auto-submit side effect cannot drift between the web path and the USSD path. The
 * only thing callers vary is how long they will wait upstream.
 *
 * Numbers we could not resolve come back as 'unknown'. This function does not decide
 * what that means — the caller does, and that is the whole difference between the
 * fail-open and fail-closed entry points below.
 */
async function resolveRegistrationStatuses(
    supabase: any,
    candidates: string[],
    timeoutMs: number
): Promise<Map<string, RegistrationStatus>> {
    const statusByNumber = new Map<string, RegistrationStatus>()
    if (candidates.length === 0) return statusByNumber

    const needsUpstream: string[] = []
    const cached = await readCache(supabase, candidates)
    const staleBefore = Date.now() - NEGATIVE_TTL_MS

    for (const number of candidates) {
        const row = cached.get(number)
        if (row?.is_registered) {
            // A number does not become un-registered. Positive results are permanent.
            statusByNumber.set(number, 'registered')
        } else if (row && new Date(row.last_checked_at).getTime() > staleBefore) {
            statusByNumber.set(number, 'unregistered')
        } else {
            needsUpstream.push(number)
        }
    }

    if (needsUpstream.length > 0) {
        const { success, allowed, error } = await verifyMtnWhitelist(needsUpstream, { timeoutMs })

        if (!success) {
            console.error('[MtnGate] Verify failed for', needsUpstream.length, 'number(s):', error)
            for (const number of needsUpstream) statusByNumber.set(number, 'unknown')
        } else {
            const results = needsUpstream.map(number => ({
                phoneNumber: number,
                isRegistered: allowed.has(number),
            }))
            for (const { phoneNumber, isRegistered } of results) {
                statusByNumber.set(phoneNumber, isRegistered ? 'registered' : 'unregistered')
            }
            await recordRegistrationResults(supabase, results)
        }
    }

    return statusByNumber
}

/**
 * Batch form. One upstream round-trip for the whole set, however many numbers.
 * `entries` are raw phone strings paired with the package network they were ordered for.
 *
 * Fails OPEN: an 'unknown' never lands in `unregistered`, so a supplier outage lets the
 * order through as pending rather than stopping the sale.
 */
export async function checkMtnRegistrationBatch(
    supabase: any,
    entries: Array<{ phoneNumber: string; packageNetwork: string }>
): Promise<BatchGateResult> {
    const empty: BatchGateResult = { unregistered: [], statusByNumber: new Map() }

    const settings = await loadGateSettings(supabase)
    if (!settings.enabled) return empty

    const candidates = collectCandidates(entries)
    if (candidates.size === 0) return empty

    const statusByNumber = await resolveRegistrationStatuses(
        supabase,
        Array.from(candidates),
        UPSTREAM_TIMEOUT_MS
    )

    const unregistered = Array.from(statusByNumber.entries())
        .filter(([, status]) => status === 'unregistered')
        .map(([number]) => number)

    if (unregistered.length > 0) {
        console.log('[MtnGate] Gating', unregistered.length, 'unregistered number(s), e.g.',
            redactIdentifier(unregistered[0]))
    }

    return { unregistered, statusByNumber }
}

/**
 * Single-number form. Call this straight after phone + package validation and
 * BEFORE any wallet deduction or payment prompt.
 */
export async function checkMtnRegistration(
    supabase: any,
    rawPhone: string,
    packageNetwork: string
): Promise<RegistrationGateResult> {
    const { unregistered } = await checkMtnRegistrationBatch(supabase, [
        { phoneNumber: rawPhone, packageNetwork },
    ])

    if (unregistered.length === 0) return { gated: false }
    return { gated: true, normalizedNumber: unregistered[0] }
}

export type StrictGateResult =
    | { blocked: false }
    | { blocked: true; reason: 'unregistered' | 'unverifiable' }

/**
 * USSD form. The one place this gate fails CLOSED.
 *
 * Everywhere else an unanswerable check lets the sale through (invariant 2 in the
 * header). USSD is the deliberate exception, and the reason is that USSD has none of
 * the recovery paths the web has. There is no dialog to warn in, no email or order page
 * to explain a held order through, and once the line drops we cannot reach the caller
 * again. Money taken over USSD for data we cannot deliver is money we have to find and
 * refund by hand. So an order we could not verify is one we do not take money for.
 *
 * The cost is real and worth stating: while Agent Portal is down, or if
 * AGENTPORTAL_API_KEY is unset, every MTN USSD data sale stops. That is the accepted
 * trade, not an oversight.
 *
 * `enabled` is passed in rather than read here on purpose. /api/hubtel/interact already
 * batches every admin_settings key it needs into a single round trip, because on that
 * route a millisecond costs a sale — adding a second lookup inside a keypress would
 * undo the thing that route is built around.
 */
export async function checkMtnRegistrationStrict(
    supabase: any,
    rawPhone: string,
    packageNetwork: string,
    opts: { enabled: boolean; timeoutMs?: number }
): Promise<StrictGateResult> {
    if (!opts.enabled) return { blocked: false }

    // Not a plain MTN bundle, or not an MTN number: the whitelist has no bearing on
    // this sale, so refusing it would block on a check that does not apply.
    const candidates = collectCandidates([{ phoneNumber: rawPhone, packageNetwork }])
    if (candidates.size === 0) return { blocked: false }

    const [number] = Array.from(candidates)
    const statusByNumber = await resolveRegistrationStatuses(
        supabase,
        [number],
        opts.timeoutMs ?? USSD_UPSTREAM_TIMEOUT_MS
    )

    const status = statusByNumber.get(number)
    if (status === 'registered') return { blocked: false }

    // 'unregistered', 'unknown', or missing entirely all refuse. The last case should
    // be unreachable, but defaulting it to "allow" would be the one bug in here that
    // silently reopens the door this function exists to shut.
    const reason = status === 'unregistered' ? 'unregistered' : 'unverifiable'
    console.log('[MtnGate] USSD refusing', redactIdentifier(number), '-', reason)
    return { blocked: true, reason }
}
