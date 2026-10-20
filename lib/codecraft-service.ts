import { createServerClient } from '@/lib/supabase'
import { sanitizeForLog } from '@/lib/safe-log'
import type { SupplierFailureKind } from '@/lib/supplier-failure'

// CodeCraft Fulfillment Service — Mirrors lib/fulfillment-service.ts architecture exactly

const CODECRAFT_API_KEY = process.env.CODECRAFT_API_KEY || ''
const CODECRAFT_API_BASE_URL = 'https://api.codecraftnetwork.com/api'

// ─── Circuit Breaker ───────────────────────────────────────────────────────────
// Independent from DataKazina — same closed/open/half-open pattern
let circuitState: 'closed' | 'open' | 'half-open' = 'closed'
let failureCount = 0
let lastFailureTime: number | null = null
const FAILURE_THRESHOLD = 5
const RECOVERY_TIMEOUT = 60000 // 1 minute

// ─── Interfaces ───────────────────────────────────────────────────────────────
interface FulfillmentResponse {
    success: boolean
    reference?: string
    transactionId?: string
    error?: string
    apiResponse?: any
    isRateLimited?: boolean
    failureKind?: SupplierFailureKind
}

interface StatusResponse {
    success: boolean
    status: 'pending' | 'processing' | 'completed' | 'failed'
    message?: string
    data?: any
}

// ─── Bundle Cache ─────────────────────────────────────────────────────────────
// Structure: { regular: { [network]: [{ gig: number, amount: string }] }, bigtime: { [network]: [...] } }
interface BundleEntry { gig: number; amount: string }
interface BundleMap {
    regular: Record<string, BundleEntry[]>
    bigtime: Record<string, BundleEntry[]>
}

let bundleMappingCache: BundleMap = { regular: {}, bigtime: {} }
let lastBundleFetch: number | null = null
const BUNDLE_CACHE_DURATION = 3600000 // 1 hour
const BUNDLE_MAP_KEY = 'codecraft_bundle_map'

// ─── STRICT Bundle Routing Rules ──────────────────────────────────────────────
// MTN 1–9 GB   → Regular → /initiate.php
// MTN 10–100 GB → BigTime → /special.php
// AT 1–15 GB   → Regular → /initiate.php
// AT 20+ GB    → BigTime → /special.php
// TELECEL all  → Regular → /initiate.php
function resolveEndpointAndType(
    network: string,
    gigVolume: number
): { endpoint: string; packageType: 'regular' | 'bigtime' } {
    const baseName = network.startsWith('AT') ? 'AT' : network

    if (baseName === 'MTN') {
        return { endpoint: `${CODECRAFT_API_BASE_URL}/initiate.php`, packageType: 'regular' }
    }

    if (baseName === 'AT') {
        if (gigVolume >= 20) return { endpoint: `${CODECRAFT_API_BASE_URL}/special.php`, packageType: 'bigtime' }
        return { endpoint: `${CODECRAFT_API_BASE_URL}/initiate.php`, packageType: 'regular' }
    }

    // TELECEL — always Regular
    return { endpoint: `${CODECRAFT_API_BASE_URL}/initiate.php`, packageType: 'regular' }
}

// Map internal network name to CodeCraft network string
function resolveNetworkName(network: string): string {
    if (network === 'AT-iShare' || network === 'AT-BigTime') return 'AT'
    if (network === 'Telecel') return 'TELECEL'
    return network // MTN passes through unchanged
}

// ─── Circuit Breaker Helpers ──────────────────────────────────────────────────
function checkCircuit(): boolean {
    if (circuitState === 'closed') return true
    if (circuitState === 'open') {
        const now = Date.now()
        if (lastFailureTime && now - lastFailureTime > RECOVERY_TIMEOUT) {
            circuitState = 'half-open'
            return true
        }
        return false
    }
    return true // half-open allows one attempt
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
        console.log('[CodeCraft] Circuit breaker OPENED')
    }
}

// ─── Response Helpers ─────────────────────────────────────────────────────────
// CodeCraft returns status as number 200, string '200', or legacy string 'success'
function isStatus200(data: any): boolean {
    return data?.status === 200 || data?.status === '200' || data?.status === 'success'
}

// A failure on CodeCraft's own upstream leg rather than on our request.
// Signals: undocumented 5xx-range code (502 SOAP/upstream, 512 observed for
// Telecel), a nested provider_response, or an echoed upstream http_code.
const UPSTREAM_PROVIDER_CODES = [502, 512]
function isUpstreamProviderFailure(data: any): boolean {
    if (UPSTREAM_PROVIDER_CODES.includes(Number(data?.status))) return true
    if (data?.provider_response) return true
    // http_code is the upstream's status, echoed alongside CodeCraft's own status
    const upstreamHttp = Number(data?.http_code)
    return !!upstreamHttp && upstreamHttp >= 400 && !isStatus200(data)
}

async function parseJsonSafe(response: Response, logPrefix: string): Promise<any | null> {
    const rawText = await response.text()
    try {
        return JSON.parse(rawText)
    } catch (e) {
        console.error(`${logPrefix} Non-JSON response (HTTP ${response.status}):`, rawText.slice(0, 300))
        return null
    }
}

// Ghana local format (0XXXXXXXXX) as expected by CodeCraft
function normalizePhone(phoneNumber: string): string {
    let normalized = (phoneNumber || '').trim().replace(/[\s-]/g, '')
    if (normalized.startsWith('+')) normalized = normalized.slice(1)
    if (normalized.startsWith('233')) return '0' + normalized.slice(3)
    if (!normalized.startsWith('0')) return '0' + normalized
    return normalized
}

// ─── Bundle Mapping Cache (Two-Tier: Memory + Supabase) ───────────────────────
/**
 * Fetch available packages from CodeCraft and cache in memory + Supabase.
 * Fallback to stale cache on failure. 1-hour TTL.
 */
export async function fetchAllBundleMappings(): Promise<BundleMap> {
    const now = Date.now()

    // 1. Memory Cache Check (fastest path — same container)
    const hasMemCache =
        Object.keys(bundleMappingCache.regular).length > 0 ||
        Object.keys(bundleMappingCache.bigtime).length > 0
    if (hasMemCache && lastBundleFetch && now - lastBundleFetch < BUNDLE_CACHE_DURATION) {
        return bundleMappingCache
    }

    const supabase = createServerClient()

    try {
        // 2. Persistent Cache Check (Supabase — cross-instance)
        const { data: storedSettings } = await (supabase
            .from('admin_settings') as any)
            .select('value')
            .eq('key', BUNDLE_MAP_KEY)
            .maybeSingle()

        let storedMap: any = null
        if (storedSettings?.value) {
            try {
                storedMap = typeof storedSettings.value === 'string'
                    ? JSON.parse(storedSettings.value)
                    : storedSettings.value
            } catch (e) {
                console.error('[CodeCraft] Failed to parse stored bundle map')
            }
        }

        // Use stored map if fresh (< 1 hour)
        if (storedMap?.mappings && storedMap?.fetched_at) {
            const fetchedAt = new Date(storedMap.fetched_at).getTime()
            if (now - fetchedAt < BUNDLE_CACHE_DURATION) {
                console.log('[CodeCraft] Using fresh persistent cache from Supabase')
                bundleMappingCache = storedMap.mappings
                lastBundleFetch = fetchedAt
                return bundleMappingCache
            }
        }

        // 3. API Fetch (slow path)
        console.log('[CodeCraft] Persistent cache stale or missing. Fetching from API...')
        const response = await fetch(`${CODECRAFT_API_BASE_URL}/packages.php`, {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'x-api-key': CODECRAFT_API_KEY,
            },
        })

        // If API error, fallback to STALE persistent cache
        if (!response.ok) {
            console.warn(`[CodeCraft] API Error ${response.status}. Falling back to stale persistent cache.`)
            if (storedMap?.mappings) {
                bundleMappingCache = storedMap.mappings
                lastBundleFetch = now // Temporarily treat as fresh to avoid tight loops
                return bundleMappingCache
            }
            throw new Error(`Failed to fetch packages and no cache available (Status: ${response.status})`)
        }

        const rawText = await response.text()
        let data: any
        try {
            data = JSON.parse(rawText)
        } catch (e) {
            console.error(`[CodeCraft] Non-JSON response (HTTP ${response.status}) from /packages.php:`, rawText.slice(0, 300))
            if (storedMap?.mappings) {
                bundleMappingCache = storedMap.mappings
                lastBundleFetch = now
                return bundleMappingCache
            }
            throw new Error(`Supplier returned unexpected response format (HTTP ${response.status})`)
        }

        // Build the new map from regular_packages and bigtime_packages arrays
        // { regular: { MTN: [{gig:1,amount:'4.50'}, ...], AT: [...] }, bigtime: {...} }
        const newMappings: BundleMap = { regular: {}, bigtime: {} }

        const regularPkgs: any[] = data?.data?.data?.regular_packages || data?.data?.regular_packages || []
        const bigtimePkgs: any[] = data?.data?.data?.bigtime_packages || data?.data?.bigtime_packages || []

        for (const pkg of regularPkgs) {
            if (!pkg.network || pkg.package === undefined) continue
            if (!newMappings.regular[pkg.network]) newMappings.regular[pkg.network] = []
            newMappings.regular[pkg.network].push({ gig: Number(pkg.package), amount: String(pkg.amount) })
        }

        for (const pkg of bigtimePkgs) {
            if (!pkg.network || pkg.package === undefined) continue
            if (!newMappings.bigtime[pkg.network]) newMappings.bigtime[pkg.network] = []
            newMappings.bigtime[pkg.network].push({ gig: Number(pkg.package), amount: String(pkg.amount) })
        }

        // 4. Update both caches
        bundleMappingCache = newMappings
        lastBundleFetch = now

        await (supabase.from('admin_settings') as any).upsert({
            key: BUNDLE_MAP_KEY,
            value: {
                mappings: newMappings,
                fetched_at: new Date().toISOString(),
            },
        }, { onConflict: 'key' })

        console.log('[CodeCraft] Persistent bundle cache updated successfully')
        return newMappings

    } catch (error) {
        console.error('[CodeCraft] Error in fetchAllBundleMappings:', error)
        return bundleMappingCache // Return whatever we have (may be empty on cold start)
    }
}

// ─── Main Fulfillment Function ─────────────────────────────────────────────────
/**
 * Fulfill a data order via CodeCraft API.
 * Mirrors the signature of fulfillment-service.ts fulfillOrder().
 */
export async function fulfillOrder(
    network: string,
    phoneNumber: string,
    dataSize: string,
    orderId: string
): Promise<FulfillmentResponse> {

    if (!checkCircuit()) {
        console.warn(`[CodeCraft] Circuit breaker is OPEN. Order ${orderId} kept pending.`)
        return { success: false, error: 'Service temporarily unavailable (circuit open)', failureKind: 'refused' }
    }

    if (!CODECRAFT_API_KEY) {
        return { success: false, error: 'CodeCraft API key not configured', failureKind: 'refused' }
    }

    try {
        // ── Extract numeric GB volume from size string ──────────────────────
        const sizeMatch = dataSize.match(/[\d.]+/)
        if (!sizeMatch) {
            console.log(`[CodeCraft] Skip: Could not extract numeric volume from "${dataSize}"`)
            return { success: false, error: `Invalid data size format: ${dataSize}`, failureKind: 'refused' }
        }

        const gigVolume = Number(sizeMatch[0])
        if (isNaN(gigVolume) || gigVolume <= 0) {
            return { success: false, error: `Invalid GB volume parsed from: ${dataSize}`, failureKind: 'refused' }
        }

        // ── Strict Routing ──────────────────────────────────────────────────
        const { endpoint, packageType } = resolveEndpointAndType(network, gigVolume)
        const codecraftNetwork = resolveNetworkName(network)

        console.log(`[CodeCraft] Order ${orderId} | ${network} → ${codecraftNetwork} | ${gigVolume}GB | Type: ${packageType} | Endpoint: ${endpoint}`)

        // ── Bundle Map Validation ───────────────────────────────────────────
        const bundleMap = await fetchAllBundleMappings()
        const packageList = bundleMap[packageType][codecraftNetwork] || []

        const matchedBundle = packageList.find(b => b.gig === gigVolume)
        if (!matchedBundle) {
            const available = packageList.map(b => `${b.gig}GB`).join(', ') || 'none'
            console.log(`[CodeCraft] Skip: No ${packageType} ${gigVolume}GB package for ${codecraftNetwork}. Available: ${available}`)
            return { success: false, error: `No ${packageType} package found for ${gigVolume}GB on ${codecraftNetwork}`, failureKind: 'refused' }
        }

        // ── Phone Normalization ─────────────────────────────────────────────
        const normalizedPhone = normalizePhone(phoneNumber)

        const requestBody = {
            recipient_number: normalizedPhone,
            gig: String(gigVolume),       // CodeCraft uses actual GB number directly
            network: codecraftNetwork,
        }

        console.log(`[CodeCraft] Request payload:`, sanitizeForLog(requestBody))

        // ── HTTP Fetch with 3-retry logic ───────────────────────────────────
        let response: Response | null = null
        let attempt = 0
        const maxAttempts = 3
        let lastError: Error | null = null
        // Whole-call budget across all attempts. A stalled supplier would otherwise
        // burn maxAttempts x the per-attempt timeout plus backoff, overrunning the
        // caller's function limit and getting killed before it can report failure.
        const fulfillDeadline = Date.now() + 25_000

        while (attempt < maxAttempts) {
            attempt++
            try {
                response = await fetch(endpoint, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Accept': 'application/json',
                        'x-api-key': CODECRAFT_API_KEY,
                    },
                    body: JSON.stringify(requestBody),
                    // Bound the call. Without this a supplier that accepts the TCP
                    // connection and then stalls (never answering, never resetting) leaves
                    // fetch pending forever: the retry loop below never runs and the whole
                    // serverless function is killed mid-order, stranding the row in
                    // 'processing'. A timeout turns that hang into a retriable failure.
                    signal: AbortSignal.timeout(Math.max(2_000, fulfillDeadline - Date.now())),
                })

                // Rate limiting — do not retry, return so caller can queue
                if (response.status === 429) {
                    console.warn(`[CodeCraft] Rate limited (HTTP 429). Order ${orderId} kept pending.`)
                    return { success: false, error: 'Supplier Rate Limited (429)', isRateLimited: true, failureKind: lastError ? 'unknown' : 'refused' }
                }

                break // Successful HTTP connection — handle response outside loop

            } catch (err: any) {
                lastError = err
                console.error(`[CodeCraft] Fetch error on attempt ${attempt}:`, err.message)
                if (Date.now() >= fulfillDeadline) {
                    console.warn(`[codecraft] Fulfillment budget exhausted after attempt ${attempt} — giving up so the caller can report a failure.`)
                    break
                }
                if (attempt < maxAttempts) {
                    const delay = 2000 * attempt // 2s, 4s
                    console.log(`[CodeCraft] Retrying in ${delay}ms...`)
                    await new Promise(res => setTimeout(res, delay))
                }
            }
        }

        if (!response) {
            console.error(`[CodeCraft] All ${maxAttempts} fetch attempts failed for order ${orderId}.`)
            recordFailure()
            return { success: false, error: lastError?.message || 'Persistent network error connecting to CodeCraft', failureKind: 'unknown' }
        }

        // ── Attempt JSON Parse ──────────────────────────────────────────────
        const data = await parseJsonSafe(response, '[CodeCraft]')
        if (!data) {
            recordFailure()
            return { success: false, error: `Supplier returned unexpected response format (HTTP ${response.status})`, failureKind: 'unknown' }
        }
        console.log(`[CodeCraft] API response received`, { status: response.status, ok: response.ok })

        // ── Resilient Success Detection ─────────────────────────────────────
        // reference_id is always at top level — never nested
        // 100 = admin wallet low, 101 = out of stock, 102 = agent not found,
        // 103 = price not found, 402 = insufficient wallet, 409 = duplicate reference,
        // 422 = invalid/unverified number, 500 = system error, 502 = upstream/SOAP failure,
        // 503 = BigTime service unavailable, 555 = network not found
        // ALL non-success → keep order pending
        const isSuccess = response.ok && isStatus200(data) && data.reference_id
        if (isSuccess) {
            recordSuccess()
            return {
                success: true,
                reference: data.reference_id,
                transactionId: data.reference_id,
                apiResponse: sanitizeForLog(data),
            }
        }

        // Any failure: log reason code but NEVER mark order as failed
        const reasonCode = data.status
        const reasonMsg = data.message || 'Unknown error'

        // ── Upstream Provider Failure Detection ─────────────────────────────
        // CodeCraft proxies each network to its own upstream provider. When THAT
        // leg fails, CodeCraft still answers 200-shaped JSON with an undocumented
        // code (512 observed for Telecel) plus a nested provider_response and the
        // upstream's own http_code. Critically, a reference_id is echoed back even
        // though no order was created on their side (status_regular.php returns 404
        // for it) and no wallet deduction occurs — so the order is safe to retry.
        //
        // These MUST be reported distinctly: the nested message is often
        // "Invalid or missing API key", which refers to CodeCraft's upstream
        // credential, NOT ours. Surfacing it raw sends admins hunting for a
        // problem with CODECRAFT_API_KEY that does not exist.
        const upstream = isUpstreamProviderFailure(data)
        if (upstream) {
            recordFailure() // back off — the whole network channel is down at the supplier
            const detail = data.provider_response?.error || reasonMsg
            console.error(
                `[CodeCraft] Order ${orderId} — SUPPLIER-SIDE ${codecraftNetwork} provider failure. ` +
                `Code: ${reasonCode}, upstream HTTP: ${data.http_code ?? 'n/a'} — ${detail}. ` +
                `No order created at CodeCraft (safe to retry). Order kept pending.`
            )
            return {
                success: false,
                error: `[${reasonCode}] CodeCraft's upstream ${codecraftNetwork} provider rejected the order (upstream HTTP ${data.http_code ?? 'n/a'}): ${detail}. This is a supplier-side outage — our API key is fine and no order was created.`,
                apiResponse: sanitizeForLog(data),
                failureKind: lastError ? 'unknown' : 'refused',
            }
        }

        console.warn(`[CodeCraft] Order ${orderId} not fulfilled. Code: ${reasonCode} — ${reasonMsg}. Order kept pending.`)

        // ONLY open circuit breaker for actual supplier infrastructure/system failures,
        // NOT for user/validation errors (422 unverified number) or funding errors
        // (100 admin wallet low, 101 out of stock, 402 insufficient wallet)
        const INFRA_FAILURE_CODES = [500, 502, 503, 555]
        if (response.status >= 500 || INFRA_FAILURE_CODES.includes(Number(reasonCode))) {
            recordFailure()
        }
        // Codes that mean CodeCraft turned the order away without creating it. 409
        // (duplicate), 500 and 502 are left 'unknown': each can follow an order that
        // did go through, so moving to another supplier could deliver twice.
        const REFUSAL_CODES = [100, 101, 102, 103, 402, 422, 503, 555]
        // ...and only when no earlier attempt in this call errored mid-flight, since
        // there is no idempotency key to stop that one having landed.
        const failureKind: SupplierFailureKind =
            response.status < 500 && !lastError && REFUSAL_CODES.includes(Number(reasonCode)) ? 'refused' : 'unknown'
        return {
            success: false,
            error: `[${reasonCode}] ${reasonMsg}`,
            apiResponse: sanitizeForLog(data),
            failureKind,
        }

    } catch (error: any) {
        recordFailure()
        console.error(`[CodeCraft] Exception during fulfillOrder for ${orderId}:`, error.message)
        return { success: false, error: error.message || 'Unexpected exception', failureKind: 'unknown' }
    }
}

// ─── Order Status Check ────────────────────────────────────────────────────────
/**
 * Check the status of an existing CodeCraft order.
 * GET /status_regular.php?reference_id=...  (orders_agent)
 * GET /status_bigtime.php?reference_id=...  (special_offers_orders)
 * GET /status_console.php?reference_id=...  (console orders)
 */
export async function checkOrderStatus(
    referenceId: string,
    packageType: 'regular' | 'bigtime' | 'console'
): Promise<StatusResponse> {

    if (!checkCircuit()) return { success: false, status: 'pending', message: 'Service unavailable (circuit open)' }
    if (!CODECRAFT_API_KEY) return { success: false, status: 'pending', message: 'API key not configured' }

    const statusPath =
        packageType === 'bigtime' ? 'status_bigtime.php'
            : packageType === 'console' ? 'status_console.php'
                : 'status_regular.php'
    const endpoint = `${CODECRAFT_API_BASE_URL}/${statusPath}?reference_id=${encodeURIComponent(referenceId)}`

    try {
        const response = await fetch(endpoint, {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'x-api-key': CODECRAFT_API_KEY,
            },
            // The reconciliation cron calls this once per order, serially. One hung
            // request would otherwise eat the whole run and starve every order behind it.
            signal: AbortSignal.timeout(10_000),
        })

        const rawText = await response.text()
        let data: any
        try {
            data = JSON.parse(rawText)
        } catch (e) {
            console.error(`[CodeCraft Status] Non-JSON response (HTTP ${response.status}):`, rawText.slice(0, 300))
            recordFailure()
            return { success: false, status: 'pending', message: `Unexpected response format (HTTP ${response.status})` }
        }

        if (response.ok && isStatus200(data) && data.success !== false) {
            recordSuccess()
            return {
                success: true,
                status: mapOrderStatus(data.data?.order_status),
                message: data.message,
                data: data.data,
            }
        }

        if (response.status >= 500 || data.status === 500 || data.status === 502 || data.status === 503) {
            recordFailure()
        }
        return { success: false, status: 'pending', message: data.message || 'Failed to check status' }

    } catch (error) {
        recordFailure()
        return { success: false, status: 'pending', message: 'Connection error during status check' }
    }
}

// ─── Bulk Order Status ─────────────────────────────────────────────────────────
/**
 * Paginated status listing for the authenticated agent's orders.
 * GET /status_bulk.php  (regular)  |  GET /status_bigtime_bulk.php  (BigTime)
 * Max 100 orders per request.
 */
export async function checkBulkOrderStatus(
    packageType: 'regular' | 'bigtime',
    page = 1,
    limit = 100
): Promise<{
    success: boolean
    orders: any[]
    pagination?: any
    message?: string
}> {
    if (!CODECRAFT_API_KEY) return { success: false, orders: [], message: 'API key not configured' }

    const path = packageType === 'bigtime' ? 'status_bigtime_bulk.php' : 'status_bulk.php'
    const safeLimit = Math.min(Math.max(limit, 1), 100)
    const endpoint = `${CODECRAFT_API_BASE_URL}/${path}?page=${page}&limit=${safeLimit}`

    try {
        const response = await fetch(endpoint, {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'x-api-key': CODECRAFT_API_KEY,
            },
        })

        const data = await parseJsonSafe(response, '[CodeCraft BulkStatus]')
        if (!data) return { success: false, orders: [], message: `Unexpected response format (HTTP ${response.status})` }

        if (response.ok && isStatus200(data) && data.success !== false) {
            return {
                success: true,
                orders: data.data?.orders || [],
                pagination: data.data?.pagination,
                message: data.message,
            }
        }

        return { success: false, orders: [], message: data.message || 'Failed to fetch bulk status' }
    } catch (error: any) {
        return { success: false, orders: [], message: error.message || 'Connection error during bulk status check' }
    }
}

// ─── Phone Verification ────────────────────────────────────────────────────────
/**
 * POST /verify-phone.php — check whether a number exists in the beneficiary list.
 * Does not create an order and does not deduct wallet balance.
 * Rate limit: 100 HTTP requests per minute (a bulk call of 100 numbers counts as one).
 */
export async function verifyPhoneNumber(phoneNumber: string): Promise<{
    success: boolean
    verified: boolean
    isRateLimited?: boolean
    message?: string
}> {
    if (!CODECRAFT_API_KEY) return { success: false, verified: false, message: 'API key not configured' }

    try {
        const response = await fetch(`${CODECRAFT_API_BASE_URL}/verify-phone.php`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'x-api-key': CODECRAFT_API_KEY,
            },
            body: JSON.stringify({ phone_number: normalizePhone(phoneNumber) }),
        })

        if (response.status === 429) {
            return { success: false, verified: false, isRateLimited: true, message: 'Rate limit exceeded (100 requests/minute)' }
        }

        const data = await parseJsonSafe(response, '[CodeCraft VerifyPhone]')
        if (!data) return { success: false, verified: false, message: `Unexpected response format (HTTP ${response.status})` }

        // 200 = verified, 422 = valid number but not in beneficiary list
        return {
            success: isStatus200(data),
            verified: data.data?.verified === true,
            message: data.data?.message || data.message,
        }
    } catch (error: any) {
        return { success: false, verified: false, message: error.message || 'Connection error during phone verification' }
    }
}

/**
 * Bulk variant of verifyPhoneNumber — 1 to 100 numbers per request.
 */
export async function verifyPhoneNumbers(phoneNumbers: string[]): Promise<{
    success: boolean
    summary?: { total: number; verified: number; unverified: number; invalid: number }
    results: any[]
    isRateLimited?: boolean
    message?: string
}> {
    if (!CODECRAFT_API_KEY) return { success: false, results: [], message: 'API key not configured' }
    if (phoneNumbers.length < 1 || phoneNumbers.length > 100) {
        return { success: false, results: [], message: 'Bulk verification accepts between 1 and 100 numbers' }
    }

    try {
        const response = await fetch(`${CODECRAFT_API_BASE_URL}/verify-phone.php`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'x-api-key': CODECRAFT_API_KEY,
            },
            body: JSON.stringify({ phone_numbers: phoneNumbers.map(normalizePhone) }),
        })

        if (response.status === 429) {
            return { success: false, results: [], isRateLimited: true, message: 'Rate limit exceeded (100 requests/minute)' }
        }

        const data = await parseJsonSafe(response, '[CodeCraft VerifyPhone Bulk]')
        if (!data) return { success: false, results: [], message: `Unexpected response format (HTTP ${response.status})` }

        return {
            success: isStatus200(data),
            summary: data.data?.summary,
            results: data.data?.results || [],
            message: data.message,
        }
    } catch (error: any) {
        return { success: false, results: [], message: error.message || 'Connection error during bulk verification' }
    }
}

// ─── Cancel Pending MTN EXCEL Order ────────────────────────────────────────────
/**
 * POST /cancel_mtn.php — cancel a pending MTN EXCEL order and refund the wallet.
 * Only orders whose current status is "Pending" are eligible.
 */
export async function cancelPendingMtnOrder(referenceId: string): Promise<{
    success: boolean
    cancelledOrders?: number
    refundAmount?: number
    newWallet?: number
    message?: string
}> {
    if (!CODECRAFT_API_KEY) return { success: false, message: 'API key not configured' }

    try {
        const response = await fetch(`${CODECRAFT_API_BASE_URL}/cancel_mtn.php`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'x-api-key': CODECRAFT_API_KEY,
            },
            body: JSON.stringify({ reference_id: referenceId }),
        })

        const data = await parseJsonSafe(response, '[CodeCraft CancelMTN]')
        if (!data) return { success: false, message: `Unexpected response format (HTTP ${response.status})` }

        if (response.ok && isStatus200(data) && data.success !== false) {
            return {
                success: true,
                cancelledOrders: Number(data.data?.cancelled_orders ?? 0),
                refundAmount: Number(data.data?.refund_amount ?? 0),
                newWallet: Number(data.data?.new_wallet ?? 0),
                message: data.message,
            }
        }

        // 404 = no eligible pending orders, 422 = not an MTN order
        return { success: false, message: `[${data.status}] ${data.message || 'Cancellation failed'}` }
    } catch (error: any) {
        return { success: false, message: error.message || 'Connection error during cancellation' }
    }
}

// ─── Console Balance ───────────────────────────────────────────────────────────
/**
 * GET /console_balance.php — active console status, remaining package balance
 * and total used package for the authenticated agent.
 */
export async function fetchConsoleBalance(): Promise<{
    success: boolean
    consoleStatus?: string
    balance?: number
    usedPackage?: number
    error?: string
}> {
    if (!CODECRAFT_API_KEY) return { success: false, error: 'API key not configured' }

    try {
        const response = await fetch(`${CODECRAFT_API_BASE_URL}/console_balance.php`, {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'x-api-key': CODECRAFT_API_KEY,
            },
        })

        const data = await parseJsonSafe(response, '[CodeCraft ConsoleBalance]')
        if (!data) return { success: false, error: `Unexpected response format (HTTP ${response.status})` }

        if (response.ok && isStatus200(data) && data.success !== false) {
            return {
                success: true,
                consoleStatus: data.data?.console_status,
                balance: Number(data.data?.balance ?? 0) || 0,
                usedPackage: Number(data.data?.used_package ?? 0) || 0,
            }
        }

        // 404 = no active console account
        return { success: false, error: data.message || 'Failed to fetch console balance' }
    } catch (error: any) {
        return { success: false, error: error.message }
    }
}

function mapOrderStatus(orderStatus: string): 'pending' | 'processing' | 'completed' | 'failed' {
    const normalized = (orderStatus || '').trim().toLowerCase()
    const COMPLETED_STATUSES = ['delivered', 'success', 'completed', 'crediting successful', 'credited']
    const FAILED_STATUSES = ['failed', 'rejected', 'reversed', 'cancelled']
    if (COMPLETED_STATUSES.includes(normalized)) return 'completed'
    if (FAILED_STATUSES.includes(normalized)) return 'failed'
    return 'processing'
}

// ─── Balance Fetch ─────────────────────────────────────────────────────────────
/**
 * Fetch live CodeCraft wallet balance.
 * GET /wallet.php → { status: 200, message: "Successful", data: { wallet: 10.00 } }
 */
export async function fetchSupplierBalance(): Promise<{
    success: boolean
    balance?: number
    currency?: string
    error?: string
}> {
    try {
        const response = await fetch(`${CODECRAFT_API_BASE_URL}/wallet.php`, {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'x-api-key': CODECRAFT_API_KEY,
            },
        })

        const data = await parseJsonSafe(response, '[CodeCraft Balance]')
        if (!data) return { success: false, error: `Unexpected response format (HTTP ${response.status})` }
        console.log('[CodeCraft Balance] API response received', { status: response.status, ok: response.ok })

        if (response.ok && isStatus200(data)) {
            const balance = parseFloat(data.data?.wallet ?? 0) || 0
            return { success: true, balance, currency: 'GHS' }
        }

        return { success: false, error: data.message || data.error || 'Failed to fetch balance' }

    } catch (error: any) {
        console.error('[CodeCraft Balance] Error:', error)
        return { success: false, error: error.message }
    }
}
