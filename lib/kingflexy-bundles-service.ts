/**
 * KingFlexy Commission Services — Standard Bundles (/api/v2/bundles/*).
 *
 * Same Commission Services key as utilities and airtime (kf_cs_live_), and the same
 * retry/deadline/breaker shape as lib/kingflexy-utility-service.ts — copied rather
 * than shared so a bundles outage opens its own breaker and leaves bill payments
 * flowing.
 *
 * KingFlexy charges us the catalog price with no discount. Our margin is the markup
 * in lib/bundle-pricing.ts plus the commission they credit to our KF Commission
 * Wallet once an order is delivered.
 *
 * Telecel Broadband is deliberately dropped from the catalog here: it pays no
 * commission and is out of scope until an admin asks for it.
 */
import { unstable_cache, revalidateTag } from 'next/cache'
import { sanitizeForLog } from '@/lib/safe-log'

const KF_COMMISSION_KEY = process.env.KINGFLEXY_COMMISSION_KEY || ''
const KF_V2_URL = process.env.KINGFLEXY_API_V2_URL || 'https://api.kingflexygh.com/api/v2'

export const BUNDLE_NETWORKS = ['MTN', 'Telecel', 'AT'] as const
export type BundleNetwork = typeof BUNDLE_NETWORKS[number]

export function isBundleNetwork(v: unknown): v is BundleNetwork {
    return typeof v === 'string' && (BUNDLE_NETWORKS as readonly string[]).includes(v)
}

export const BUNDLE_CATALOG_TAG = 'kf-bundles-catalog'
const CATALOG_TTL_SECONDS = 15 * 60

// ─── Circuit Breaker ─────────────────────────────────────────────────────────
let circuitState: 'closed' | 'open' | 'half-open' = 'closed'
let failureCount = 0
let lastFailureTime: number | null = null
const FAILURE_THRESHOLD = 5
const RECOVERY_TIMEOUT = 60_000

function checkCircuit(): boolean {
    if (circuitState === 'closed') return true
    if (circuitState === 'open') {
        if (lastFailureTime && Date.now() - lastFailureTime > RECOVERY_TIMEOUT) {
            circuitState = 'half-open'
            return true
        }
        return false
    }
    return true
}

function recordSuccess() {
    failureCount = 0
    circuitState = 'closed'
}

function recordFailure() {
    failureCount++
    lastFailureTime = Date.now()
    if (failureCount >= FAILURE_THRESHOLD) {
        circuitState = 'open'
        console.log('[KingFlexyBundles] Circuit breaker OPENED')
    }
}

// ─── Shared request helper ───────────────────────────────────────────────────

interface KfResponse {
    ok: boolean
    status: number
    data: any
    /** Set when we never got a parseable answer at all — distinct from a rejection. */
    transportError?: string
}

/**
 * One HTTP call with a whole-call budget across retries. Retries transport failures
 * and 5xx only; a 4xx is an answer and repeating it just burns the rate limit.
 */
async function kfRequest(
    method: 'GET' | 'POST',
    path: string,
    body?: any,
    budgetMs = 25_000
): Promise<KfResponse> {
    const deadline = Date.now() + budgetMs
    const maxAttempts = 3
    let lastError: Error | null = null

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const res = await fetch(`${KF_V2_URL}${path}`, {
                method,
                headers: {
                    Accept: 'application/json',
                    // Raw key, no "Bearer" — same as every other KingFlexy endpoint.
                    Authorization: KF_COMMISSION_KEY,
                    ...(body ? { 'Content-Type': 'application/json' } : {}),
                },
                ...(body ? { body: JSON.stringify(body) } : {}),
                cache: 'no-store',
                signal: AbortSignal.timeout(Math.max(2_000, deadline - Date.now())),
            })

            const raw = await res.text()
            let data: any = null
            try {
                data = raw ? JSON.parse(raw) : null
            } catch {
                console.error(`[KingFlexyBundles] Non-JSON response (HTTP ${res.status}):`, raw.slice(0, 300))
                if (res.status >= 500) recordFailure()
                return { ok: false, status: res.status, data: null, transportError: `Unexpected response format (HTTP ${res.status})` }
            }

            if (res.status >= 500) {
                recordFailure()
                if (attempt < maxAttempts && Date.now() < deadline) {
                    await new Promise(r => setTimeout(r, 2000 * attempt))
                    continue
                }
            } else {
                recordSuccess()
            }

            return { ok: res.ok, status: res.status, data }
        } catch (err: any) {
            lastError = err
            console.error(`[KingFlexyBundles] ${method} ${path} attempt ${attempt} failed:`, err?.message)
            if (Date.now() >= deadline) break
            if (attempt < maxAttempts) await new Promise(r => setTimeout(r, 2000 * attempt))
        }
    }

    recordFailure()
    return { ok: false, status: 0, data: null, transportError: lastError?.message || 'Could not reach KingFlexy' }
}

/** The precise reason is logged, never returned — callers include storefront buyers. */
function configError(): string | null {
    if (!KF_COMMISSION_KEY) {
        console.error('[KingFlexyBundles] KINGFLEXY_COMMISSION_KEY is not configured.')
        return 'Bundles are temporarily unavailable. Please try again shortly.'
    }
    if (!KF_COMMISSION_KEY.startsWith('kf_cs_live_')) {
        console.error('[KingFlexyBundles] KINGFLEXY_COMMISSION_KEY is not a Commission Services key (expected the kf_cs_live_ prefix).')
        return 'Bundles are temporarily unavailable. Please try again shortly.'
    }
    return null
}

function errorMessage(res: KfResponse, fallback: string): string {
    return res.transportError || res.data?.error?.message || res.data?.message || fallback
}

// ─── Catalog ─────────────────────────────────────────────────────────────────

export interface KfBundle {
    /** Opaque catalog key. Sent back to /purchase exactly as received. */
    value: string | null
    /** Non-null on a Special bundle, which is bought by pack_id alone. */
    packId: string | null
    /** What KingFlexy charges us. Their `price` always equals this. */
    amount: number
    size: string
    plan: string | null
    family: string
    familyLabel: string
    validity: string | null
}

export interface KfBundleFamily {
    key: string
    label: string
    description: string | null
}

export interface KfBundleCatalog {
    network: BundleNetwork
    /** Their own on/off for this network. */
    enabled: boolean
    families: KfBundleFamily[]
    bundles: KfBundle[]
}

// Flat rather than a discriminated union: strictNullChecks is off in this repo, and
// without it TypeScript does not narrow on a boolean discriminant.
export interface CatalogResult {
    success: boolean
    catalog?: KfBundleCatalog
    error?: string
}

function normaliseCatalog(network: BundleNetwork, d: any): KfBundleCatalog {
    const bundles: KfBundle[] = (Array.isArray(d?.bundles) ? d.bundles : [])
        .map((b: any): KfBundle => ({
            value: b?.value != null && b.value !== '' ? String(b.value) : null,
            packId: b?.pack_id != null && b.pack_id !== '' ? String(b.pack_id) : null,
            amount: Number(b?.amount ?? b?.price ?? 0),
            size: String(b?.size ?? b?.plan ?? ''),
            plan: b?.plan != null ? String(b.plan) : null,
            family: String(b?.family ?? 'standard'),
            familyLabel: String(b?.family_label ?? b?.family ?? 'Bundles'),
            validity: b?.validity != null ? String(b.validity) : null,
        }))
        // A row we cannot buy back is worse than a missing row.
        .filter((b: KfBundle) => b.amount > 0 && (b.value || b.packId) && b.size)

    const families: KfBundleFamily[] = (Array.isArray(d?.families) ? d.families : [])
        .map((f: any) => ({ key: String(f?.key ?? ''), label: String(f?.label ?? f?.key ?? ''), description: f?.description ?? null }))
        .filter((f: KfBundleFamily) => f.key && bundles.some(b => b.family === f.key))

    // A family that appears on bundles but not in families[] still gets a tab.
    for (const b of bundles) {
        if (!families.some(f => f.key === b.family)) {
            families.push({ key: b.family, label: b.familyLabel, description: null })
        }
    }

    return { network, enabled: d?.enabled !== false, families, bundles }
}

/**
 * Throws on failure so unstable_cache never stores an outage — the next call
 * retries instead of serving "unavailable" for 15 minutes.
 */
const fetchCatalogCached = unstable_cache(
    async (network: BundleNetwork): Promise<KfBundleCatalog> => {
        const res = await kfRequest('GET', `/bundles/catalog?network=${encodeURIComponent(network)}`, undefined, 15_000)
        if (!res.ok || res.data?.success !== true) {
            throw new Error(errorMessage(res, `Could not load the bundle catalog (HTTP ${res.status})`))
        }
        return normaliseCatalog(network, res.data.data)
    },
    ['kf-bundles-catalog-v1'],
    { revalidate: CATALOG_TTL_SECONDS, tags: [BUNDLE_CATALOG_TAG] }
)

export async function getBundleCatalog(network: BundleNetwork): Promise<CatalogResult> {
    const cfg = configError()
    if (cfg) return { success: false, error: cfg }
    if (!checkCircuit()) return { success: false, error: 'Bundles are temporarily unavailable. Please try again shortly.' }
    try {
        return { success: true, catalog: await fetchCatalogCached(network) }
    } catch (e: any) {
        console.error(`[KingFlexyBundles] Catalog ${network} failed:`, e?.message)
        return { success: false, error: 'Bundles are temporarily unavailable. Please try again shortly.' }
    }
}

/** Drop the cached catalog — after a 404 "bundle no longer available", or from admin. */
export function invalidateBundleCatalog(): void {
    try {
        revalidateTag(BUNDLE_CATALOG_TAG)
    } catch (e: any) {
        console.error('[KingFlexyBundles] revalidateTag failed (non-fatal):', e?.message)
    }
}

// ─── Purchase ────────────────────────────────────────────────────────────────

export interface KfBundlePurchaseParams {
    network: BundleNetwork
    phone: string
    /** Our reference_code — their idempotency key. Never regenerate it on a retry. */
    reference: string
    value?: string | null
    amount?: number
    packId?: string | null
}

/**
 * How a purchase attempt ended, from the point of view of the customer's money.
 *
 *  - accepted         KingFlexy took the order (or replayed the original).
 *  - definite_refusal 4xx that charged nothing: wrong carrier, bad number, bundle
 *                     gone, product paused. Safe to refund the customer.
 *  - kf_wallet_empty  Our float at KingFlexy is short. Also charged nothing — refund
 *                     the customer and tell an admin to top up.
 *  - retry_same_ref   409: the first attempt is still being processed. Ask again later
 *                     with the SAME reference.
 *  - unknown          Transport failure or 5xx. The order may exist upstream, so this
 *                     must never be refunded on its own — the cron asks them.
 */
export type KfPurchaseOutcome = 'accepted' | 'definite_refusal' | 'kf_wallet_empty' | 'retry_same_ref' | 'unknown'

export interface KfBundlePurchaseResult {
    outcome: KfPurchaseOutcome
    httpStatus: number
    orderReference?: string
    status?: string
    error?: string
    raw?: any
}

export async function purchaseBundleViaKingFlexy(params: KfBundlePurchaseParams): Promise<KfBundlePurchaseResult> {
    const cfg = configError()
    if (cfg) return { outcome: 'definite_refusal', httpStatus: 0, error: cfg }
    if (!checkCircuit()) {
        // The breaker opens before any request is made, so nothing reached them.
        return { outcome: 'retry_same_ref', httpStatus: 0, error: 'Bundle provider temporarily unavailable.' }
    }

    const body: Record<string, any> = params.packId
        ? { pack_id: params.packId, beneficiary_phone: params.phone, reference: params.reference }
        : { network: params.network, beneficiary_phone: params.phone, value: params.value, amount: params.amount, reference: params.reference }

    console.log(`[KingFlexyBundles] Purchase ${params.network} ${params.packId ? `pack ${params.packId}` : `GHS ${params.amount}`} -> ${params.phone} (ref ${params.reference})`)

    const res = await kfRequest('POST', '/bundles/purchase', body, 25_000)

    if (res.transportError) {
        return { outcome: 'unknown', httpStatus: res.status, error: res.transportError }
    }

    if (res.ok && res.data?.success === true) {
        const d = res.data.data || {}
        return {
            outcome: 'accepted',
            httpStatus: res.status,
            orderReference: d.order_reference ?? undefined,
            status: d.status ?? 'pending',
            raw: sanitizeForLog(res.data),
        }
    }

    const message = errorMessage(res, `Purchase refused (HTTP ${res.status})`)
    const raw = sanitizeForLog(res.data)

    if (res.status === 409) return { outcome: 'retry_same_ref', httpStatus: 409, error: message, raw }

    if (res.status === 404) {
        // Their catalog moved under us. Drop ours so the next page load shows the truth.
        invalidateBundleCatalog()
        return { outcome: 'definite_refusal', httpStatus: 404, error: message, raw }
    }

    if (res.status === 400 && /insufficient|balance/i.test(message)) {
        return { outcome: 'kf_wallet_empty', httpStatus: 400, error: message, raw }
    }

    // 400 wrong carrier / bad number, 503 paused, 401/403 key problems: answered and
    // documented as "nothing was charged".
    if (res.status >= 400 && res.status < 500) return { outcome: 'definite_refusal', httpStatus: res.status, error: message, raw }
    if (res.status === 503) return { outcome: 'definite_refusal', httpStatus: 503, error: message, raw }

    return { outcome: 'unknown', httpStatus: res.status, error: message, raw }
}

// ─── Status ──────────────────────────────────────────────────────────────────

export type KfBundleStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'refunded'

export function mapKfBundleStatus(raw: unknown): KfBundleStatus {
    const s = String(raw ?? '').toLowerCase()
    if (s === 'completed' || s === 'success' || s === 'delivered') return 'completed'
    if (s === 'refunded' || s === 'refund' || s === 'reversed') return 'refunded'
    if (s === 'failed' || s === 'cancelled' || s === 'canceled') return 'failed'
    if (s === 'processing') return 'processing'
    return 'pending'
}

export interface KfBundleStatusResult {
    found: boolean
    /** With found=false: a 404, they never received it. Safe to re-POST with the same reference. */
    notFound?: boolean
    status?: KfBundleStatus
    orderReference?: string
    commission?: number | null
    reason?: string
    error?: string
    raw?: any
}

export async function getKfBundleOrderStatus(reference: string): Promise<KfBundleStatusResult> {
    const cfg = configError()
    if (cfg) return { found: false, notFound: false, error: cfg }
    if (!checkCircuit()) return { found: false, notFound: false, error: 'Provider temporarily unavailable.' }

    const res = await kfRequest('GET', `/bundles/orders/${encodeURIComponent(reference)}`, undefined, 15_000)

    if (res.status === 404 && !res.transportError) return { found: false, notFound: true }
    if (!res.ok || res.data?.success !== true) {
        return { found: false, notFound: false, error: errorMessage(res, `Status unavailable (HTTP ${res.status})`) }
    }

    const d = res.data.data || {}
    return {
        found: true,
        status: mapKfBundleStatus(d.status),
        orderReference: d.order_reference ?? undefined,
        commission: d.commission != null ? Number(d.commission) : null,
        reason: d.reason ?? undefined,
        raw: sanitizeForLog(res.data),
    }
}
