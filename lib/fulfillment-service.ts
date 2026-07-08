import { createServerClient } from '@/lib/supabase'
import { sanitizeForLog } from '@/lib/safe-log'

// Universal Fulfillment Service with DataKazina API Integration

const DATAKAZINA_API_KEY = process.env.DATAKAZINA_API_KEY || ''
const DATAKAZINA_API_BASE_URL = process.env.DATAKAZINA_API_BASE_URL || 'https://reseller.dakazinabusinessconsult.com/api/v1'

// Circuit breaker state
let circuitState: 'closed' | 'open' | 'half-open' = 'closed'
let failureCount = 0
let lastFailureTime: number | null = null
const FAILURE_THRESHOLD = 5
const RECOVERY_TIMEOUT = 60000 // 1 minute

interface FulfillmentResponse {
    success: boolean
    reference?: string
    transactionId?: string
    error?: string
    apiResponse?: any
    isRateLimited?: boolean
}

interface StatusResponse {
    success: boolean
    status: 'pending' | 'processing' | 'completed' | 'failed'
    message?: string
    data?: any
}

// DataKazina network IDs (verified against live /fetch-data-packages feed).
// NOTE: this account has NO network_id 3. MTN data is sold as "MTN EXPRESS" = network_id 6.
const NETWORK_IDS: Record<string, number> = {
    'MTN': 6,
    'Telecel': 2,
    'AT-iShare': 1,
    'AT-BigTime': 4,
    'EXPRESS MTN': 6,
}

// Cache for bundle mappings (will be populated from API or Supabase)
// Structure: { [networkId]: { [volume]: packageId } }
let bundleMappingCache: Record<number, Record<string, number>> = {}
let lastBundleFetch: number | null = null
const BUNDLE_CACHE_DURATION = 3600000 // 1 hour

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
        console.log('[DataKazina] Circuit breaker opened')
    }
}

/**
 * Fetch available data packages from DataKazina and build bundle mapping for all networks.
 * Uses Supabase as a persistent shared cache to prevent 429s during cold starts.
 */
export async function fetchAllBundleMappings(): Promise<Record<number, Record<string, number>>> {
    const now = Date.now()
    const BUNDLE_MAP_KEY = 'datakazina_bundle_map'

    // 1. Memory Cache Check (Fastest Path - same container)
    if (Object.keys(bundleMappingCache).length > 0 && lastBundleFetch && (now - lastBundleFetch) < BUNDLE_CACHE_DURATION) {
        return bundleMappingCache
    }

    const supabase = createServerClient()

    try {
        // 2. Persistent Cache Check (Supabase - cross-instance)
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
                console.error('[DataKazina] Failed to parse stored bundle map')
            }
        }

        // Use stored map if fresh (< 1 hour)
        if (storedMap?.mappings && storedMap?.fetched_at) {
            const fetchedAt = new Date(storedMap.fetched_at).getTime()
            if (now - fetchedAt < BUNDLE_CACHE_DURATION) {
                console.log('[DataKazina] Using fresh persistent cache from Supabase')
                bundleMappingCache = storedMap.mappings
                lastBundleFetch = fetchedAt
                return bundleMappingCache
            }
        }

        // 3. API Fetch (Slow Path)
        console.log('[DataKazina] Persistent cache stale or missing. Fetching from API...')
        const response = await fetch(`${DATAKAZINA_API_BASE_URL}/fetch-data-packages`, {
            method: 'GET',
            headers: { 'x-api-key': DATAKAZINA_API_KEY },
        })

        // If 429 or other API error, fallback to STALE persistent cache
        if (!response.ok) {
            console.warn(`[DataKazina] API Error ${response.status}. Falling back to stale persistent cache.`)
            if (storedMap?.mappings) {
                bundleMappingCache = storedMap.mappings
                lastBundleFetch = now // Temporarily treat as fresh to prevent immediate loops
                return bundleMappingCache
            }
            throw new Error(`Failed to fetch packages and no cache available (Status: ${response.status})`)
        }

        // Safety check: if the response is HTML (e.g. redirect/error page), handle gracefully
        const contentType = response.headers.get('content-type') || ''
        if (!contentType.includes('application/json')) {
            console.error(`[DataKazina] Non-JSON response (HTTP ${response.status}) from fetch-data-packages.`)
            if (storedMap?.mappings) {
                bundleMappingCache = storedMap.mappings
                lastBundleFetch = now
                return bundleMappingCache
            }
            throw new Error(`Supplier returned unexpected response format (HTTP ${response.status})`)
        }

        const data = await response.json()
        const newMappings: Record<number, Record<string, number>> = {}

        if (Array.isArray(data)) {
            data.forEach((pkg: any) => {
                if (!newMappings[pkg.network_id]) newMappings[pkg.network_id] = {}
                newMappings[pkg.network_id][pkg.volumeGB] = pkg.id
            })
        }

        // 4. Update Both Caches
        bundleMappingCache = newMappings
        lastBundleFetch = now

        await (supabase.from('admin_settings') as any).upsert({
            key: BUNDLE_MAP_KEY,
            value: {
                mappings: newMappings,
                fetched_at: new Date().toISOString()
            }
        }, { onConflict: 'key' })

        console.log('[DataKazina] Persistent bundle cache updated successfully')
        return newMappings
    } catch (error) {
        console.error('[DataKazina] Error in fetchAllBundleMappings:', error)
        return bundleMappingCache
    }
}

/**
 * Main fulfillment function for any network
 */
export async function fulfillOrder(
    network: string,
    phoneNumber: string,
    dataSize: string,
    orderId: string
): Promise<FulfillmentResponse> {
    if (!checkCircuit()) return { success: false, error: 'Service temporarily unavailable' }
    if (!DATAKAZINA_API_KEY) return { success: false, error: 'API key not configured' }

    try {
        const mappings = await fetchAllBundleMappings()
        const networkId = NETWORK_IDS[network]

        if (!networkId) {
            console.log(`[DataKazina] Skip: Unsupported network ${network}`)
            return { success: false, error: `Unsupported network: ${network}` }
        }

        const networkMappings = mappings[networkId]
        if (!networkMappings) {
            console.log(`[DataKazina] Skip: No mappings found for network ${network} (ID: ${networkId})`)
            return { success: false, error: `No packages found for network: ${network}` }
        }

        // --- SIZE NORMALIZATION ---
        // The mapped bundleId is used purely as an availability/stock check; the actual purchase
        // request sends network_id + numeric shared_bundle. Try exact match first, then normalized.
        let bundleId = networkMappings[dataSize]

        if (!bundleId) {
            const numericSize = dataSize.replace(/[^0-9]/g, '')
            bundleId = networkMappings[numericSize] || networkMappings[numericSize + 'GB'] || networkMappings[numericSize + ' GB']

            if (bundleId) {
                console.log(`[DataKazina] Normalized size "${dataSize}" to "${numericSize}" (Found ID: ${bundleId})`)
            }
        }

        if (!bundleId) {
            console.log(`[DataKazina] Skip: Unsupported size "${dataSize}" for ${network}. Available: ${Object.keys(networkMappings).join(', ')}`)
            return {
                success: false,
                error: `Unsupported data size: ${dataSize} for ${network}.`
            }
        }

        // Extract volume value to send as the actual shared_bundle (as requested by supplier)
        const sizeMatch = dataSize.match(/[\d.]+/)
        const volumeValue = sizeMatch ? sizeMatch[0] : null

        if (!volumeValue || isNaN(Number(volumeValue))) {
            console.log(`[DataKazina] Skip: Could not extract numeric volume from "${dataSize}"`)
            return { success: false, error: `Invalid data size format: ${dataSize}. Number expected.` }
        }

        const volumeNumber = Number(volumeValue)

        console.log(`[DataKazina] Fulfillment Start: Order ${orderId} | Network: ${network} (${networkId}) | Size: ${dataSize} (Vol: ${volumeNumber})`)
        // ---------------------------

        // Normalize phone number
        let normalizedPhone = phoneNumber
        if (normalizedPhone.startsWith('233')) normalizedPhone = '0' + normalizedPhone.slice(3)
        else if (!normalizedPhone.startsWith('0')) normalizedPhone = '0' + normalizedPhone

        const requestBody: Record<string, any> = {
            recipient_msisdn: normalizedPhone,
            network_id: networkId,
            shared_bundle: volumeNumber, // send the numeric volume, e.g. 15 for "15GB"
            incoming_api_ref: orderId,
        }

        console.log(`[DataKazina] Request payload:`, sanitizeForLog(requestBody))

        let response: Response | null = null;
        let attempt = 0;
        const maxAttempts = 3;
        let lastError: Error | null = null;

        while (attempt < maxAttempts) {
            attempt++;
            try {
                response = await fetch(`${DATAKAZINA_API_BASE_URL}/buy-data-package`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Accept': 'application/json',
                        'x-api-key': DATAKAZINA_API_KEY,
                    },
                    body: JSON.stringify(requestBody),
                });

                // Handle WAF 429 Too Many Requests (Cloudflare/Nginx limits)
                if (response.status === 429) {
                    console.warn(`[DataKazina Fulfillment] Rate limited (HTTP 429). Queueing order...`);
                    // IMPORTANT: Do not retry here. Immediately return so the caller can queue it asynchronously.
                    return { success: false, error: 'Supplier Rate Limited (429)', isRateLimited: true };
                }

                // If we get here and it's not a 429, we break out of the retry loop.
                // We'll handle the response (success or failure) outside the loop.
                break;

            } catch (err: any) {
                lastError = err;
                console.error(`[DataKazina Fulfillment] Network/Fetch error on attempt ${attempt}:`, err.message);

                if (attempt < maxAttempts) {
                    // Wait a bit before retrying network failures
                    const delay = 2000 * attempt; // Exponential-ish backoff: 2s, 4s
                    console.log(`[DataKazina Fulfillment] Retrying in ${delay}ms...`);
                    await new Promise(res => setTimeout(res, delay));
                }
            }
        }

        if (!response) {
            // All attempts failed due to network errors
            console.error(`[DataKazina Fulfillment] All ${maxAttempts} fetch attempts failed.`);
            recordFailure();
            return { success: false, error: lastError?.message || 'Persistent network error connecting to supplier' };
        }

        // Safety check: if the response is HTML (e.g. redirect/error page), handle gracefully
        const contentType = response.headers.get('content-type') || ''
        if (!contentType.includes('application/json')) {
            const rawText = await response.text()
            console.error(`[DataKazina Fulfillment] Non-JSON response (HTTP ${response.status}):`, rawText.slice(0, 300))
            recordFailure()
            return { success: false, error: `Supplier returned unexpected response (HTTP ${response.status})` }
        }

        const data = await response.json()
        console.log(`[DataKazina] API response received`, { status: response.status, ok: response.ok })

        // Ensure we catch false positives where success is true but it's an error message
        const isFalsePositive = data.success && data.message &&
            (data.message.toLowerCase().includes('not available') ||
                data.message.toLowerCase().includes('failed') ||
                data.message.toLowerCase().includes('error'))

        if (response.ok && data.success && !isFalsePositive) {
            recordSuccess()
            const responseData = Array.isArray(data.data) ? data.data[0] : data.data
            return {
                success: true,
                reference: responseData?.reference || orderId,
                transactionId: responseData?.transaction_code || responseData?.transaction_id,
                apiResponse: sanitizeForLog(data),
            }
        }

        recordFailure()
        return {
            success: false,
            error: data.message || data.error || 'Fulfillment failed',
            apiResponse: sanitizeForLog(data),
        }
    } catch (error: any) {
        recordFailure()
        return { success: false, error: error.message || 'Connection error' }
    }
}

export async function checkOrderStatus(transactionId: string): Promise<StatusResponse> {
    if (!checkCircuit()) return { success: false, status: 'pending', message: 'Service unavailable' }
    if (!DATAKAZINA_API_KEY) return { success: false, status: 'pending', message: 'API not configured' }

    try {
        const response = await fetch(`${DATAKAZINA_API_BASE_URL}/fetch-single-transaction`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': DATAKAZINA_API_KEY,
            },
            body: JSON.stringify({ transaction_id: transactionId }),
        })

        // Safety check: if the response is HTML (e.g. redirect/error page), handle gracefully
        const contentType = response.headers.get('content-type') || ''
        if (!contentType.includes('application/json')) {
            console.error(`[DataKazina Status] Non-JSON response (HTTP ${response.status})`)
            recordFailure()
            return { success: false, status: 'pending', message: `Supplier returned unexpected response (HTTP ${response.status})` }
        }

        const data = await response.json()

        if (response.ok && data.success) {
            recordSuccess()
            return {
                success: true,
                status: mapStatus(data.data?.status),
                message: data.message,
                data: data.data,
            }
        }

        recordFailure()
        return { success: false, status: 'pending', message: data.message || 'Failed to check status' }
    } catch (error) {
        recordFailure()
        return { success: false, status: 'pending', message: 'Connection error' }
    }
}

function mapStatus(status: string): 'pending' | 'processing' | 'completed' | 'failed' {
    const s = (status || '').toLowerCase()
    if (['success', 'completed', 'delivered'].includes(s)) return 'completed'
    if (['failed', 'error', 'rejected'].includes(s)) return 'failed'
    return 'processing'
}

export async function fetchSupplierBalance(): Promise<{ success: boolean; balance?: number; currency?: string; error?: string }> {
    try {
        // Note: API key is required even though the docs example shows empty headers
        const response = await fetch(`${DATAKAZINA_API_BASE_URL}/check-console-balance`, {
            method: 'GET',
            headers: { 'x-api-key': DATAKAZINA_API_KEY },
        })

        // Safety check: if the response is HTML (e.g. redirect/error page), handle gracefully
        const contentType = response.headers.get('content-type') || ''
        if (!contentType.includes('application/json')) {
            const rawText = await response.text()
            console.error('[DataKazina Balance] Non-JSON response (HTTP', response.status, '):', rawText.slice(0, 300))
            return { success: false, error: `Supplier returned unexpected response (HTTP ${response.status})` }
        }

        const data = await response.json()
        console.log('[DataKazina Balance] API response received', { status: response.status, ok: response.ok })

        if (response.ok) {
            let balance = 0
            let currency = 'GHS'

            // DataKazina actual response: { "Wallet Balance": "444.10", ... }
            if (data['Wallet Balance'] !== undefined) {
                balance = parseFloat(data['Wallet Balance']) || 0
            }
            // Structure 1: { success: true, data: { balance, currency } }
            else if (data.data?.balance !== undefined) {
                balance = parseFloat(data.data.balance) || 0
                currency = data.data.currency || 'GHS'
            }
            // Structure 2: { balance, currency } directly
            else if (data.balance !== undefined) {
                balance = parseFloat(data.balance) || 0
                currency = data.currency || 'GHS'
            }
            // Structure 3: { data: balance_value }
            else if (typeof data.data === 'number') {
                balance = parseFloat(data.data) || 0
            }

            return { success: true, balance, currency }
        }

        return { success: false, error: data.message || data.error || 'Failed to fetch balance' }
    } catch (error: any) {
        console.error('[DataKazina Balance] Error:', error)
        return { success: false, error: error.message }
    }
}
