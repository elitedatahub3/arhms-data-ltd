/**
 * Network names the v2 API accepts, and why they differ from v1's.
 *
 * data_packages.network stores 'AT-iShare' and 'AT-BigTime' — see the NETWORKS
 * constant in app/admin/packages/page.tsx, which is what actually writes those rows.
 * v1 validates the network against ['MTN', 'Telecel', 'AT'], so a v1 caller asking
 * for 'AT' passes validation and then fails package lookup with a 404, while
 * 'AT-iShare' is rejected at validation. AirtelTigo is effectively unreachable on v1.
 *
 * v2 takes the names the packages are actually filed under. 'AT' is still accepted on
 * input and treated as ambiguous with a message naming both real options, rather than
 * silently picking one and sending the wrong bundle.
 */
/**
 * True when an insert failed because the client `reference` is already taken.
 *
 * reference_code is UNIQUE across the WHOLE table on orders, airtime_orders and
 * utility_orders — not per user. So an idempotency lookup has to be scoped to the
 * caller (otherwise one partner reads another's order), and a reference already
 * claimed by somebody else then surfaces here as a constraint violation rather than
 * as a cache hit. That deserves a 409 telling the caller to pick another reference,
 * not a bare 500.
 */
export function isDuplicateReferenceError(error: any): boolean {
    if (!error) return false
    return error.code === '23505'
        || /duplicate key value|unique constraint/i.test(String(error.message || ''))
}

export const DATA_NETWORKS = ['MTN', 'Telecel', 'AT-iShare', 'AT-BigTime'] as const
export type DataNetwork = typeof DATA_NETWORKS[number]

/** Airtime is a top-up on the line itself, so AirtelTigo is one destination. */
export const AIRTIME_NETWORKS = ['MTN', 'Telecel', 'AT'] as const
export type AirtimeNetwork = typeof AIRTIME_NETWORKS[number]

export function isDataNetwork(value: unknown): value is DataNetwork {
    return typeof value === 'string' && (DATA_NETWORKS as readonly string[]).includes(value)
}

export function isAirtimeNetwork(value: unknown): value is AirtimeNetwork {
    return typeof value === 'string' && (AIRTIME_NETWORKS as readonly string[]).includes(value)
}

/** null when the value is a valid network; an error message when it is not. */
export function dataNetworkError(value: unknown): string | null {
    if (isDataNetwork(value)) return null
    if (typeof value === 'string' && value.trim().toUpperCase() === 'AT') {
        return 'Ambiguous network "AT". Use "AT-iShare" or "AT-BigTime".'
    }
    return `Invalid network. Must be one of: ${DATA_NETWORKS.join(', ')}`
}

/**
 * Ghana MSISDN, in the two shapes the rest of the codebase accepts.
 * Returns the whitespace-stripped number, or null when it is not one.
 */
export function normaliseRecipient(raw: unknown): string | null {
    const clean = String(raw ?? '').replace(/\s+/g, '')
    return /^(0\d{9}|233\d{9})$/.test(clean) ? clean : null
}

/**
 * Matches a requested size against data_packages.size.
 *
 * Same substring rule v1 uses, with one guard added: '1' must not match '10GB'. v1
 * compares with .includes(), so volume_gb: 1 can resolve to the 10GB or 100GB package
 * and charge for it. Exact-first, then the loose match as a fallback for inputs like
 * '5GB' or '1.5'.
 */
export function findPackageForSize<T extends { size: string }>(
    packages: T[],
    volumeGb: unknown
): T | undefined {
    const wanted = String(volumeGb ?? '').replace(/gb/i, '').trim().toLowerCase()
    if (!wanted) return undefined

    const norm = (s: string) => s.toLowerCase().replace(/\s+/g, '')
    const stripped = (s: string) => norm(s).replace(/gb$/, '')

    const exact = packages.find(p => stripped(p.size) === wanted)
    if (exact) return exact

    return packages.find(p => norm(p.size).includes(wanted))
}
