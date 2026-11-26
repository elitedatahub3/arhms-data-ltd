/**
 * Datagod Developer API v2 — Standard Bundles (/v2/bundles/*).
 *
 * The second Standard Bundles provider beside lib/kingflexy-bundles-service.ts.
 * lib/bundle-provider.ts picks between them per network; nothing else should
 * import this file directly.
 *
 * Flow (Datagod docs, "Standard Bundles"):
 *   GET  /bundles/catalog?network=  → bundles with pay_amount + a bundle_token
 *   POST /bundles/purchase          → { bundle_token, recipient, reference, expected_pay }
 *   GET  /bundles/orders/{reference} → poll; Datagod sends NO webhooks.
 *
 * Key: a Commission Services key (dg2_live_… / dg2_test_…), raw in Authorization.
 * It spends our Datagod wallet. pay_amount is our cost; the markup in
 * lib/bundle-pricing.ts is our margin.
 *
 * bundle_token lasts token_valid_seconds (10 minutes). Orders store Datagod's
 * stable bundle id instead, and purchase always fetches a fresh token first, so a
 * Direct Pay order that waited minutes for MoMo still buys with a live token.
 *
 * The catalog shape was confirmed against the live API on 2026-11-26 (see
 * normaliseCatalog). The purchase and order-status bodies were not, since probing
 * them costs money, so those fields are still read under several spellings.
 * scripts/probe-datagod-bundles.mjs prints the raw responses.
 */
import { unstable_cache, revalidateTag } from 'next/cache'
import { sanitizeForLog } from '@/lib/safe-log'
import {
    mapKfBundleStatus,
    type BundleNetwork,
    type KfBundle,
    type KfBundleCatalog,
    type KfBundleFamily,
    type CatalogResult,
    type KfBundlePurchaseResult,
    type KfBundleStatusResult,
} from '@/lib/kingflexy-bundles-service'

const DG_KEY = process.env.DATAGOD_COMMISSION_KEY || ''
const DG_V2_URL = (process.env.DATAGOD_API_V2_URL || 'https://api.datagod.store/v2').replace(/\/+$/, '')

export const DG_BUNDLE_CATALOG_TAG = 'dg-bundles-catalog'
// Shorter than KingFlexy's 15 minutes: the cached copy is only for showing prices,
// but a shorter life keeps those prices close to what purchase will be charged.
const CATALOG_TTL_SECONDS = 5 * 60

const UNAVAILABLE = 'Bundles are temporarily unavailable. Please try again shortly.'

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
        console.log('[DatagodBundles] Circuit breaker OPENED')
    }
}

// ─── Shared request helper ───────────────────────────────────────────────────

interface DgResponse {
    ok: boolean
    status: number
    data: any
    transportError?: string
}

/** Same contract as kfRequest: retries transport failures and 5xx only. */
async function dgRequest(method: 'GET' | 'POST', path: string, body?: any, budgetMs = 25_000): Promise<DgResponse> {
    const deadline = Date.now() + budgetMs
    const maxAttempts = 3
    let lastError: Error | null = null

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const res = await fetch(`${DG_V2_URL}${path}`, {
                method,
                headers: {
                    Accept: 'application/json',
                    Authorization: DG_KEY,
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
                console.error(`[DatagodBundles] Non-JSON response (HTTP ${res.status}):`, raw.slice(0, 300))
                if (res.status >= 500) recordFailure()
                return { ok: false, status: res.status, data: null, transportError: `Unexpected response format (HTTP ${res.status})` }
            }

            if (res.status >= 500) {
                recordFailure()
                // 502 = Datagod could not reach its upstream; retrying a purchase is
                // safe (same reference), retrying a catalog read is harmless.
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
            console.error(`[DatagodBundles] ${method} ${path} attempt ${attempt} failed:`, err?.message)
            if (Date.now() >= deadline) break
            if (attempt < maxAttempts) await new Promise(r => setTimeout(r, 2000 * attempt))
        }
    }

    recordFailure()
    return { ok: false, status: 0, data: null, transportError: lastError?.message || 'Could not reach Datagod' }
}

function configError(): string | null {
    if (!DG_KEY) {
        console.error('[DatagodBundles] DATAGOD_COMMISSION_KEY is not configured.')
        return UNAVAILABLE
    }
    if (!DG_KEY.startsWith('dg2_')) {
        console.error('[DatagodBundles] DATAGOD_COMMISSION_KEY is not a v2 key (expected the dg2_live_ / dg2_test_ prefix).')
        return UNAVAILABLE
    }
    return null
}

function errorMessage(res: DgResponse, fallback: string): string {
    return res.transportError || res.data?.error?.message || res.data?.message || fallback
}

/**
 * Datagod's error.code repeats the HTTP status; the specific reason
 * (PRICE_CHANGED, BUNDLE_TOKEN_EXPIRED, …) may sit in another field or only in the
 * message, so look for the word anywhere in the error body.
 */
function hasErrorCode(res: DgResponse, code: string): boolean {
    const e = res.data?.error ?? res.data
    if (!e) return false
    for (const k of ['type', 'reason', 'error_code', 'code_name', 'slug', 'code']) {
        if (typeof e?.[k] === 'string' && e[k].toUpperCase() === code) return true
    }
    try {
        return JSON.stringify(e).toUpperCase().includes(code)
    } catch {
        return false
    }
}

// ─── Catalog ─────────────────────────────────────────────────────────────────

const pick = (o: any, ...keys: string[]) => {
    for (const k of keys) if (o?.[k] != null && o[k] !== '') return o[k]
    return undefined
}

export interface DgBundle extends KfBundle {
    dgBundleId: string
    /** Valid for tokenValidSeconds from when the catalog was read. */
    dgToken: string
}

export interface DgCatalog extends KfBundleCatalog {
    bundles: DgBundle[]
    tokenValidSeconds: number
    fetchedAt: number
}

/**
 * The token's first segment is base64url JSON, e.g.
 *   {"network":"TELECEL","value":"BDLHRBOOST2","amount":1,"display":"…","category":"Hourly","issuedAt":…}
 * `value` is the provider's stable product code. Reading it is a convenience, not
 * a contract: if it ever stops decoding we fall back to category + display.
 */
function tokenPayload(token: string): any {
    try {
        const seg = token.split('.')[0]
        return JSON.parse(Buffer.from(seg.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))
    } catch {
        return null
    }
}

/** Short, URL-safe family key from a category name ("Fuse (Mins + Data)" → "fuse-mins-data"). */
function slug(s: string): string {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'bundles'
}

/**
 * Real shape (probed 2026-11-26):
 *   data: { network, token_valid_seconds, categories: [{ name, bundles: [
 *     { bundle_token, display, face_amount, pay_amount, customer_cashback } ] }] }
 * There is no bundle id, so one is derived (see bundleIdFor) that is the same on
 * every catalog read, which is what lets dispatch find the bundle again with a
 * fresh token.
 */
function bundleIdFor(category: string, b: any, token: string): string {
    const face = Number(b?.face_amount ?? 0).toFixed(2)
    const code = tokenPayload(token)?.value
    if (typeof code === 'string' && code) return `${code}:${face}`
    return `${slug(category)}:${String(b?.display ?? '').trim()}:${face}`.slice(0, 200)
}

function normaliseCatalog(network: BundleNetwork, d: any): DgCatalog {
    const categories: any[] = Array.isArray(d?.categories) ? d.categories : []
    const bundles: DgBundle[] = []
    const families: KfBundleFamily[] = []
    const seen = new Set<string>()

    for (const c of categories) {
        const name = String(c?.name ?? 'Bundles')
        const family = slug(name)
        let added = false
        for (const b of (Array.isArray(c?.bundles) ? c.bundles : [])) {
            const token = String(b?.bundle_token ?? '')
            const amount = Number(b?.pay_amount ?? 0)
            const size = String(b?.display ?? '').trim()
            // A row we cannot buy back is worse than a missing row.
            if (!token || !(amount > 0) || !size || b?.available === false) continue
            const dgBundleId = bundleIdFor(name, b, token)
            // Two rows deriving one id would make purchase ambiguous: keep the first.
            if (seen.has(dgBundleId)) continue
            seen.add(dgBundleId)
            bundles.push({
                value: null,
                packId: null,
                amount,
                size,
                plan: null,
                family,
                familyLabel: name,
                validity: null,
                dgBundleId,
                dgToken: token,
            })
            added = true
        }
        if (added && !families.some(f => f.key === family)) families.push({ key: family, label: name, description: null })
    }

    const ttl = Number(pick(d, 'token_valid_seconds', 'token_ttl_seconds'))
    return {
        network,
        enabled: d?.enabled !== false && d?.available !== false,
        families,
        bundles,
        tokenValidSeconds: Number.isFinite(ttl) && ttl > 0 ? ttl : 600,
        fetchedAt: Date.now(),
    }
}

/** Datagod names AirtelTigo "AT" in the docs, the same as ours. */
async function loadCatalog(network: BundleNetwork): Promise<DgCatalog> {
    const res = await dgRequest('GET', `/bundles/catalog?network=${encodeURIComponent(network)}`, undefined, 15_000)
    if (!res.ok || res.data?.success !== true) {
        throw new Error(errorMessage(res, `Could not load the Datagod bundle catalog (HTTP ${res.status})`))
    }
    return normaliseCatalog(network, res.data.data)
}

const fetchCatalogCached = unstable_cache(loadCatalog, ['dg-bundles-catalog-v1'], {
    revalidate: CATALOG_TTL_SECONDS,
    tags: [DG_BUNDLE_CATALOG_TAG],
})

/** For showing prices. The tokens inside may be stale — never purchase with them. */
export async function getDgBundleCatalog(network: BundleNetwork): Promise<CatalogResult> {
    const cfg = configError()
    if (cfg) return { success: false, error: cfg }
    if (!checkCircuit()) return { success: false, error: UNAVAILABLE }
    try {
        return { success: true, catalog: await fetchCatalogCached(network) }
    } catch (e: any) {
        console.error(`[DatagodBundles] Catalog ${network} failed:`, e?.message)
        return { success: false, error: UNAVAILABLE }
    }
}

/**
 * ADMIN ONLY (Test connection): the same uncached catalog read, but the precise
 * reason comes back instead of the generic buyer message. Never show it to buyers.
 */
export async function diagnoseDgBundleCatalog(network: BundleNetwork): Promise<CatalogResult> {
    if (!DG_KEY) return { success: false, error: 'DATAGOD_COMMISSION_KEY is not set on this deployment (add it in Vercel, then redeploy).' }
    if (!DG_KEY.startsWith('dg2_')) return { success: false, error: `DATAGOD_COMMISSION_KEY does not look like a v2 key (starts "${DG_KEY.slice(0, 6)}…", expected dg2_).` }
    const res = await dgRequest('GET', `/bundles/catalog?network=${encodeURIComponent(network)}`, undefined, 15_000)
    if (res.transportError) return { success: false, error: `Could not reach ${DG_V2_URL}: ${res.transportError}` }
    if (!res.ok || res.data?.success !== true) {
        return { success: false, error: `Datagod answered HTTP ${res.status}: ${errorMessage(res, 'no message')}` }
    }
    const catalog = normaliseCatalog(network, res.data.data)
    if (!catalog.bundles.length) return { success: false, error: 'Datagod answered, but no bundle in the reply could be read.' }
    return { success: true, catalog }
}

export function invalidateDgBundleCatalog(): void {
    try {
        revalidateTag(DG_BUNDLE_CATALOG_TAG)
    } catch (e: any) {
        console.error('[DatagodBundles] revalidateTag failed (non-fatal):', e?.message)
    }
}

// ─── Purchase ────────────────────────────────────────────────────────────────

export interface DgBundlePurchaseParams {
    network: BundleNetwork
    phone: string
    /** Our reference_code — Datagod's idempotency key. Never regenerate it. */
    reference: string
    dgBundleId: string
    /** What we priced the order at (bundle_orders.cost_amount). Never pay more. */
    maxCost: number
}

/** Adds a flag the dispatcher uses to alert an admin about our own key setup. */
export interface DgBundlePurchaseResult extends KfBundlePurchaseResult {
    keyProblem?: boolean
}

export async function purchaseBundleViaDatagod(params: DgBundlePurchaseParams, isRetry = false): Promise<DgBundlePurchaseResult> {
    const cfg = configError()
    if (cfg) return { outcome: 'definite_refusal', httpStatus: 0, error: 'DATAGOD_COMMISSION_KEY is missing or not a dg2_ key', keyProblem: true }
    if (!checkCircuit()) return { outcome: 'retry_same_ref', httpStatus: 0, error: 'Datagod temporarily unavailable (circuit open).' }

    // 1. A fresh token. A failed catalog read means nothing was sent, so the order
    //    can wait for the cron rather than being refunded on a blip.
    let catalog: DgCatalog
    try {
        catalog = await loadCatalog(params.network)
    } catch (e: any) {
        return { outcome: 'retry_same_ref', httpStatus: 0, error: `Could not load a fresh Datagod catalog: ${e?.message}` }
    }

    const bundle = catalog.bundles.find(b => b.dgBundleId === params.dgBundleId)
    if (!bundle) {
        invalidateDgBundleCatalog()
        return { outcome: 'definite_refusal', httpStatus: 404, error: 'Datagod no longer lists this bundle' }
    }

    // 2. Never pay Datagod more than the price the customer was charged for.
    const maxCost = Math.round(params.maxCost * 100) / 100
    if (bundle.amount > maxCost + 0.0001) {
        invalidateDgBundleCatalog()
        return { outcome: 'definite_refusal', httpStatus: 409, error: `Datagod price went up from GHS ${maxCost.toFixed(2)} to GHS ${bundle.amount.toFixed(2)}` }
    }

    console.log(`[DatagodBundles] Purchase ${params.network} ${bundle.size} (id ${bundle.dgBundleId}, GHS ${bundle.amount}) -> ${params.phone} (ref ${params.reference})`)

    const res = await dgRequest('POST', '/bundles/purchase', {
        bundle_token: bundle.dgToken,
        recipient: params.phone,
        reference: params.reference,
        expected_pay: Number(bundle.amount.toFixed(2)),
    }, 25_000)

    if (res.transportError) return { outcome: 'unknown', httpStatus: res.status, error: res.transportError }

    const raw = sanitizeForLog(res.data)

    if (res.ok && res.data?.success === true) {
        const d = res.data.data || {}
        const o = d.order ?? d
        return {
            outcome: 'accepted',
            httpStatus: res.status,
            orderReference: pick(o, 'order_reference', 'order_id', 'id', 'provider_reference') != null
                ? String(pick(o, 'order_reference', 'order_id', 'id', 'provider_reference'))
                : undefined,
            status: o?.status ?? 'pending',
            raw,
        }
    }

    const message = errorMessage(res, `Purchase refused (HTTP ${res.status})`)

    if (res.status === 409) {
        // Token aged out between our catalog read and the POST. Nothing charged:
        // re-read and resend under the SAME reference, once.
        if (hasErrorCode(res, 'BUNDLE_TOKEN_EXPIRED')) {
            return isRetry
                ? { outcome: 'retry_same_ref', httpStatus: 409, error: message, raw }
                : purchaseBundleViaDatagod(params, true)
        }
        if (hasErrorCode(res, 'PRICE_CHANGED')) {
            invalidateDgBundleCatalog()
            return { outcome: 'definite_refusal', httpStatus: 409, error: message, raw }
        }
        // REFERENCE_REUSED: Datagod has a DIFFERENT order under our reference. Do not
        // refund on our own — an admin must look. Everything else on 409
        // (REQUEST_IN_PROGRESS, OUTCOME_UNKNOWN) means "ask again with the same ref".
        if (hasErrorCode(res, 'REFERENCE_REUSED')) return { outcome: 'unknown', httpStatus: 409, error: message, raw }
        return { outcome: 'retry_same_ref', httpStatus: 409, error: message, raw }
    }

    // 402 = our Datagod wallet is short. Nothing charged.
    if (res.status === 402) return { outcome: 'kf_wallet_empty', httpStatus: 402, error: message, raw }

    // 401/403: our key is missing, pending, revoked or the wrong type. Nothing
    // charged, but every order will keep failing until an admin fixes it.
    if (res.status === 401 || res.status === 403) return { outcome: 'definite_refusal', httpStatus: res.status, error: message, raw, keyProblem: true }

    if (res.status === 404) invalidateDgBundleCatalog()

    // 429 = rate limited before anything ran. Ask again later, same reference.
    if (res.status === 429) return { outcome: 'retry_same_ref', httpStatus: 429, error: message, raw }

    // 400 bad input, 404 gone, 503 switched off: documented as nothing charged.
    if (res.status >= 400 && res.status < 500) return { outcome: 'definite_refusal', httpStatus: res.status, error: message, raw }
    if (res.status === 503) return { outcome: 'definite_refusal', httpStatus: 503, error: message, raw }

    // 500 (incl. OUTCOME_UNKNOWN), 502: may or may not exist. Never refund on this.
    return { outcome: 'unknown', httpStatus: res.status, error: message, raw }
}

// ─── Status ──────────────────────────────────────────────────────────────────

export async function getDgBundleOrderStatus(reference: string): Promise<KfBundleStatusResult> {
    const cfg = configError()
    if (cfg) return { found: false, notFound: false, error: cfg }
    if (!checkCircuit()) return { found: false, notFound: false, error: 'Provider temporarily unavailable.' }

    const res = await dgRequest('GET', `/bundles/orders/${encodeURIComponent(reference)}`, undefined, 15_000)

    // A plain 404 is the ONLY proof Datagod never saw this reference.
    if (res.status === 404 && !res.transportError) return { found: false, notFound: true }
    if (!res.ok || res.data?.success !== true) {
        return { found: false, notFound: false, error: errorMessage(res, `Status unavailable (HTTP ${res.status})`) }
    }

    const d = res.data.data || {}
    const raw = sanitizeForLog(res.data)

    // 200 with order: null + claim.state = our request is reserved but unconfirmed.
    // It is NOT missing: never resend under a new reference, never refund. Report
    // it as in flight and let the cron ask again.
    const hasOrderKey = Object.prototype.hasOwnProperty.call(d, 'order')
    const o = hasOrderKey ? d.order : d
    if (!o) {
        return { found: true, status: 'processing', reason: d?.claim?.state ? `claim ${d.claim.state}` : undefined, raw }
    }

    return {
        found: true,
        status: mapKfBundleStatus(o.status),
        orderReference: pick(o, 'order_reference', 'order_id', 'id') != null ? String(pick(o, 'order_reference', 'order_id', 'id')) : undefined,
        commission: null,
        reason: pick(o, 'reason', 'failure_reason', 'message') != null ? String(pick(o, 'reason', 'failure_reason', 'message')) : undefined,
        raw,
    }
}
