import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { createHash } from 'crypto'
import { LRUCache } from 'lru-cache'
import { Ratelimit } from '@upstash/ratelimit'
import { Redis } from '@upstash/redis'
import { createServerClient } from '@/lib/supabase'
import { parseAllowedRoles } from '@/lib/role-parser'

/** Which family of endpoints a key may reach. See the v2 migration for why. */
export type ApiKeyKind = 'standard' | 'commission'

export interface ApiAuthResult {
    userId: string
    apiKeyId: string
    userRole: string
    keyPrefix: string
    keyKind: ApiKeyKind
    supabase: ReturnType<typeof createServerClient>
}

export interface ValidateApiKeyOptions {
    /**
     * Reject the request unless the key is of this kind. v1 routes pass nothing and
     * accept either, which keeps every existing integration working: their keys are
     * all 'standard' anyway, and a partner who later adds a commission key does not
     * suddenly find it rejected by a v1 route they were never told about.
     */
    kind?: ApiKeyKind
    /**
     * Pass 'v2' to additionally honour the api_v2_enabled kill switch. v1 routes omit
     * it and remain governed only by api_feature_enabled, so turning v2 off cannot
     * strand an existing integrator.
     */
    version?: 'v1' | 'v2'
}

interface CachedAuth {
    apiKeyId: string
    userId: string
    userRole: string
    keyPrefix: string
    // Must be cached alongside the rest: the cache is keyed on the key itself, so a
    // hit that dropped the kind would hand a commission key to a standard-only route.
    keyKind: ApiKeyKind
}

// Skip bcrypt (~100ms) for the same key within 60 seconds
const validatedKeyCache = new LRUCache<string, CachedAuth>({
    max: 5_000,
    ttl: 60_000,
})

// Timing-safe dummy hash to prevent prefix enumeration
const DUMMY_HASH = bcrypt.hashSync('___not_a_real_api_key___', 10)

function fingerprintKey(fullKey: string): string {
    return createHash('sha256').update(fullKey).digest('hex')
}

/** Tag a Commission Services key carries. Standard keys keep the original kf_live_. */
export const COMMISSION_KEY_TAG = 'kf_cs_live_'

/**
 * How many leading characters of a key are stored as its searchable prefix.
 *
 * Standard keys are 'kf_live_' (8) plus 8 hex = 16, and there are live keys in the
 * database stored at exactly that length, so 16 cannot change. Commission keys carry
 * a longer tag, and slicing them at 16 would leave only 5 random characters — about
 * a million values, close enough to collide against a UNIQUE constraint once a few
 * thousand keys exist. Taking the tag plus 8 hex gives both kinds the same 4-billion
 * space regardless of how long the tag is.
 */
function prefixLengthFor(fullKey: string): number {
    return fullKey.startsWith(COMMISSION_KEY_TAG) ? COMMISSION_KEY_TAG.length + 8 : 16
}

function normaliseKind(raw: unknown): ApiKeyKind {
    return raw === 'commission' ? 'commission' : 'standard'
}

const KIND_LABEL: Record<ApiKeyKind, string> = {
    standard:   'Standard API key',
    commission: 'Commission Services key',
}

/**
 * Validates the API key from the Authorization header.
 * Returns ApiAuthResult on success, NextResponse (error) on failure.
 *
 * Steps: extract key → cache hit → prefix lookup → status check →
 *        bcrypt verify → kind gate → feature flag → role check → populate cache
 */
export async function validateApiKey(
    request: NextRequest,
    options: ValidateApiKeyOptions = {}
): Promise<ApiAuthResult | NextResponse> {
    const supabase = createServerClient()

    const authHeader = request.headers.get('authorization')
    if (!authHeader?.trim()) {
        console.error('[API Auth] FAIL: No Authorization header. Headers present:', [...request.headers.keys()].join(', '))
        return apiError(401, 'Missing Authorization header. Format: Authorization: <api_key>')
    }

    let fullKey = authHeader.trim()
    if (/^Bearer\s+/i.test(fullKey)) fullKey = fullKey.replace(/^Bearer\s+/i, '').trim()

    if (fullKey.length < 20) return apiError(401, 'Invalid API key format')

    // Cache hit — skip DB + bcrypt. The kind gate still runs: it is an authorisation
    // decision about this request, not a property of the cached identity.
    const fingerprint = fingerprintKey(fullKey)
    const cached = validatedKeyCache.get(fingerprint)
    if (cached) {
        const denied = enforceKind(cached.keyKind, options.kind)
        if (denied) return denied
        return { ...cached, supabase }
    }

    const keyPrefix = fullKey.substring(0, prefixLengthFor(fullKey))
    console.error(`[API Auth] Looking up key prefix: ${keyPrefix}`)

    const { data: keyRow, error: keyError } = await (supabase
        .from('api_keys') as any)
        .select('id, user_id, key_hash, status, kind')
        .eq('key_prefix', keyPrefix)
        .maybeSingle()

    if (keyError || !keyRow) {
        console.error(`[API Auth] FAIL: key lookup — error=${keyError?.message ?? 'none'} found=${!!keyRow} prefix=${keyPrefix}`)
        await bcrypt.compare(fullKey, DUMMY_HASH) // equalise timing
        return apiError(401, 'Invalid API key')
    }

    console.error(`[API Auth] Key found — status=${keyRow.status}`)
    if (keyRow.status === 'pending') return apiError(403, 'API key pending admin approval')
    if (keyRow.status === 'revoked') return apiError(403, 'API key has been revoked')

    const isValid = await bcrypt.compare(fullKey, keyRow.key_hash)
    if (!isValid) return apiError(401, 'Invalid API key')

    const keyKind = normaliseKind(keyRow.kind)
    const denied = enforceKind(keyKind, options.kind)
    if (denied) return denied

    // Feature toggle + role check
    const { data: settingsRows } = await (supabase
        .from('admin_settings') as any)
        .select('key, value')
        .in('key', [
            'api_feature_enabled', 'api_allowed_roles',
            'api_commission_enabled', 'api_commission_allowed_roles',
            'api_v2_enabled',
        ])

    const settings: Record<string, any> = {}
    ;((settingsRows as any[]) || []).forEach((s: any) => { settings[s.key] = s.value })

    const isOff = (v: any) => v === 'false' || v === false

    if (isOff(settings['api_feature_enabled'])) {
        return apiError(503, 'Developer API is currently disabled')
    }

    if (options.version === 'v2' && isOff(settings['api_v2_enabled'])) {
        return apiError(503, 'Developer API v2 is currently disabled')
    }

    // Commission services carry their own kill switch. Bill payments and airtime are
    // irreversible in a way a data order is not, so they must be closeable without
    // taking the data API down with them.
    if (keyKind === 'commission' && isOff(settings['api_commission_enabled'])) {
        return apiError(503, 'Commission Services API is currently disabled')
    }

    const { data: userData } = await supabase
        .from('users')
        .select('role, status')
        .eq('id', keyRow.user_id)
        .single()

    if (!userData) return apiError(401, 'User account not found')

    const userRole = (userData as any).role as string
    const userStatus = (userData as any).status as string

    if (userStatus !== 'active') return apiError(403, 'Your account is suspended or inactive')

    const allowedRoles = keyKind === 'commission'
        ? parseAllowedRoles(settings['api_commission_allowed_roles'])
        : parseAllowedRoles(settings['api_allowed_roles'])

    if (!allowedRoles.includes(userRole)) {
        return apiError(403, `API access requires an agent or dealer account. Your current role: ${userRole}`)
        return apiError(403, `${KIND_LABEL[keyKind]} access requires agent status. Your current role: ${userRole}`)
    }

    // Cache valid auth for 60s
    validatedKeyCache.set(fingerprint, {
        apiKeyId: keyRow.id, userId: keyRow.user_id, userRole, keyPrefix, keyKind,
    })

    // Fire-and-forget: update last_used_at
    ;(supabase.from('api_keys') as any)
        .update({ last_used_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('id', keyRow.id)
        .then(() => {}).catch(() => {})

    return { userId: keyRow.user_id, apiKeyId: keyRow.id, userRole, keyPrefix, keyKind, supabase }
}

function enforceKind(actual: ApiKeyKind, required?: ApiKeyKind): NextResponse | null {
    if (!required || actual === required) return null
    return apiError(403, `This endpoint requires a ${KIND_LABEL[required]}. You sent a ${KIND_LABEL[actual]}.`)
}

export function apiSuccess(data: any, meta?: Record<string, any>): NextResponse {
    return NextResponse.json({
        success: true,
        data,
        meta: { timestamp: new Date().toISOString(), version: 'v1', ...meta },
    })
}

/** As apiSuccess, but stamped v2. Kept separate so v1's contract cannot drift. */
export function apiSuccessV2(data: any, meta?: Record<string, any>): NextResponse {
    return NextResponse.json({
        success: true,
        data,
        meta: { timestamp: new Date().toISOString(), version: 'v2', ...meta },
    })
}

export function apiError(code: number, message: string): NextResponse {
    return NextResponse.json(
        { success: false, error: { code, message } },
        { status: code }
    )
}

export function logApiRequest(params: {
    apiKeyId: string | null
    userId: string | null
    endpoint: string
    method: string
    statusCode: number
    responseTimeMs: number
    ip: string | null
    errorMessage?: string
}): void {
    const supabase = createServerClient()
    ;(supabase.from('api_logs') as any)
        .insert({
            api_key_id:       params.apiKeyId,
            user_id:          params.userId,
            endpoint:         params.endpoint,
            method:           params.method,
            status_code:      params.statusCode,
            response_time_ms: params.responseTimeMs,
            ip_address:       params.ip,
            error_message:    params.errorMessage || null,
        })
        .then(() => {}).catch((e: any) => console.error('[API Log]', e.message))
}

export function isApiError(result: ApiAuthResult | NextResponse): result is NextResponse {
    return result instanceof NextResponse
}

export function getClientIp(request: NextRequest): string | null {
    return (
        request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
        request.headers.get('x-real-ip') ||
        request.headers.get('cf-connecting-ip') ||
        null
    )
}

// ─── Rate limiting ───────────────────────────────────────────────────────────
// This lives in the route layer, not the middleware, deliberately.
//
// middleware.ts declares apiV1Purchase/apiV1Bulk/apiV1General limiters that have
// never fired a single time: its matcher excludes `api/v1`, so the middleware is
// never invoked for those paths. v2 is excluded from the matcher for the same
// reason (open CORS, no session cookie to read), so putting the limits here is the
// only place they actually run — and keying on the API key rather than the IP is
// more correct anyway, since a partner's whole server farm shares one address.

export type RateLimitBucket =
    | 'purchase' | 'bulk' | 'balance' | 'status' | 'commission'
    | 'billers' | 'lookup' | 'pay' | 'orders'

const DEFAULT_LIMITS: Record<RateLimitBucket, number> = {
    // Data API
    purchase:   20,
    bulk:       10,
    balance:    60,
    status:     60,
    commission: 30,
    // Commission Services — the published per-endpoint limits. `lookup` and `pay`
    // are deliberately tight: a lookup is a paid third-party call that would also
    // enumerate strangers' names if scanned, and a payment cannot be recalled.
    billers:    30,
    lookup:     10,
    pay:         6,
    orders:     30,
}

let rateLimitRedis: Redis | null = null
try {
    rateLimitRedis = Redis.fromEnv()
} catch (e) {
    console.error('[API Auth] Redis init failed — v2 rate limiting disabled:', e)
}

const limiterCache = new Map<string, Ratelimit>()

function limiterFor(bucket: RateLimitBucket, perMinute: number): Ratelimit | null {
    if (!rateLimitRedis) return null
    const cacheKey = `${bucket}:${perMinute}`
    let limiter = limiterCache.get(cacheKey)
    if (!limiter) {
        limiter = new Ratelimit({
            redis: rateLimitRedis,
            limiter: Ratelimit.slidingWindow(perMinute, '60 s'),
            prefix: `rl:apiv2:${bucket}`,
        })
        limiterCache.set(cacheKey, limiter)
    }
    return limiter
}

/** Admin-tunable overrides from the api_rate_limits setting, cached for a minute. */
let limitsCache: { at: number; value: Partial<Record<RateLimitBucket, number>> } | null = null

async function configuredLimits(
    supabase: ReturnType<typeof createServerClient>
): Promise<Partial<Record<RateLimitBucket, number>>> {
    if (limitsCache && Date.now() - limitsCache.at < 60_000) return limitsCache.value

    let value: Partial<Record<RateLimitBucket, number>> = {}
    try {
        const { data } = await (supabase.from('admin_settings') as any)
            .select('value')
            .eq('key', 'api_rate_limits')
            .maybeSingle()

        const raw = (data as any)?.value
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
        if (parsed && typeof parsed === 'object') {
            for (const bucket of Object.keys(DEFAULT_LIMITS) as RateLimitBucket[]) {
                const n = Number(parsed[bucket])
                if (Number.isFinite(n) && n > 0) value[bucket] = n
            }
        }
    } catch {
        // Malformed JSON in a settings row must not close the API. Defaults apply.
    }

    limitsCache = { at: Date.now(), value }
    return value
}

/**
 * Returns a 429 response when the caller is over their limit, or null to proceed.
 *
 * Fails OPEN, matching every other limiter in the codebase: a throw from .limit()
 * means Upstash is unreachable or out of quota, not that this caller misbehaved, and
 * an outage there must not take paid endpoints down with it.
 */
export async function enforceRateLimit(
    auth: ApiAuthResult,
    bucket: RateLimitBucket
): Promise<NextResponse | null> {
    try {
        const overrides = await configuredLimits(auth.supabase)
        const perMinute = overrides[bucket] ?? DEFAULT_LIMITS[bucket]
        const limiter = limiterFor(bucket, perMinute)
        if (!limiter) return null

        const { success, reset } = await limiter.limit(auth.keyPrefix)
        if (success) return null

        const retryAfter = Math.max(1, Math.ceil((reset - Date.now()) / 1000))
        const response = apiError(429, `Rate limit exceeded for this endpoint. Limit: ${perMinute} requests per minute.`)
        response.headers.set('Retry-After', String(retryAfter))
        return response
    } catch (e) {
        console.error('[API Auth] Rate limit check failed (allowing request):', e)
        return null
    }
}
