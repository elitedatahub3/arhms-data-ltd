import { createServerClient } from '@supabase/ssr'
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { Redis } from '@upstash/redis'
import { Ratelimit } from '@upstash/ratelimit'

// ============================================================
// STRICT CORS ALLOWLIST - Only these origins are trusted.
// NEVER add a wildcard (*) here. Never reflect the raw Origin.
// ============================================================
const STATIC_ALLOWED_ORIGINS = [
    'https://www.dataking.qzz.io',
    'https://dataking.qzz.io',
    'https://marketplace.dataking.qzz.io',
    'http://localhost:3000',
    'http://localhost:8081',
    'http://marketplace.localhost:3000',
] as const

function normalizeOrigin(value?: string | null): string | null {
    if (!value) return null
    try {
        return new URL(value).origin
    } catch {
        return null
    }
}

const envAllowedOrigins = [
    normalizeOrigin(process.env.NEXT_PUBLIC_APP_URL),
    normalizeOrigin(process.env.NEXT_PUBLIC_SITE_URL),
    process.env.VERCEL_PROJECT_PRODUCTION_URL
        ? normalizeOrigin(`https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`)
        : null,
].filter((origin): origin is string => Boolean(origin))

const ALLOWED_ORIGINS: ReadonlySet<string> = new Set([
    ...STATIC_ALLOWED_ORIGINS,
    ...envAllowedOrigins,
])

// ============================================================
// UPSTASH REDIS CLIENT & RATE LIMITERS
// Lazy-initialized with try-catch so a missing/malformed env var
// does NOT crash the middleware module on load (MIDDLEWARE_INVOCATION_FAILED).
// If Redis is unavailable, rate limiting is skipped (fail-open).
// ============================================================
let redis: Redis | null = null
try {
    redis = Redis.fromEnv()
} catch (e) {
    console.error('[Middleware] Redis init failed — rate limiting disabled:', e)
}

const rateLimiters = redis ? {
    // ── Developer API v1 (keyed by key prefix, not IP) ─────────
    apiV1Purchase: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(20, '60 s') }),
    apiV1Bulk:     new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(10, '60 s') }),
    apiV1General:  new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(60, '60 s') }),
    // ── Auth routes ────────────────────────────────────────────
    login: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(5, '10 m') }),
    signup: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(3, '1 h') }),
    forgotPassword: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(3, '1 h') }),
    sendOtp: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(3, '15 m') }),
    confirmOtp: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(10, '15 m') }),
    completeProfile: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(5, '10 m') }),
    // ── Admin routes (broad) ───────────────────────────────────
    adminProcessWithdrawal: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(5, '1 m') }),
    admin: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(30, '1 m') }),
    adminSettings: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(10, '1 m') }),
    supplierBalance: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(10, '1 m') }),
    // ── Orders & Purchases ─────────────────────────────────────
    airtimeCreate: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(5, '1 m') }),
    ordersPurchase: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(5, '1 m') }),
    ordersBulk: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(3, '1 m') }),
    // Open to every logged-in user, and each call consumes shared Agent Portal quota
    mtnRegCheck: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(5, '1 m') }),
    // Admin-only, but each call fans out to up to 50 Eazy Data lookups
    up2uCheck: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(10, '1 m') }),
    // ── Payments ──────────────────────────────────────────────
    paymentsInitialize: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(30, '1 m') }),
    paymentsVerify: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(30, '1 m') }),
    // ── Shop ──────────────────────────────────────────────────
    shopValidateAccount: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(5, '1 m') }),
    // Keyed by IP, and storefront buyers are guests on mobile data — carrier NAT puts
    // many unrelated customers behind one address, so this has to clear a whole
    // neighbourhood of shoppers, not one person's retries.
    shopInitialize: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(30, '1 m') }),
    shopVerifyOrder: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(20, '1 m') }),
    shopPricing: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(20, '1 m') }),
    shopWithdraw: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(3, '1 h') }),
    shopAnnouncements: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(5, '1 m') }),
    shopAlerts: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(5, '1 m') }),
    shopLookupOrders: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(20, '1 m') }),
    shopMyOrders: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(60, '1 m') }),
    // ── Webhooks ──────────────────────────────────────────────
    webhook: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(20, '1 m') }),
    // ── User actions ──────────────────────────────────────────
    user: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(60, '1 m') }),
    userUpgrade: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(3, '1 h') }),
    dealerClaim: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(2, '24 h') }),
    dealerSubscribe: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(3, '1 h') }),
    afaRegistration: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(2, '1 h') }),
    agentDowngrade: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(2, '1 h') }),
    updateProfile: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(5, '10 m') }),
    deleteAccount: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(1, '24 h') }),
    airtimeHistory: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(60, '1 m') }),
    // ── Support & Cron ────────────────────────────────────────
    supportChat: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(10, '1 m') }),
    cron: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(10, '1 m') }),
    // ── Marketplace (classifieds → marketplace subdomain) ─────
    marketplaceSearch: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(30, '1 m') }),
    marketplaceFeed: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(60, '1 m') }),
    marketplaceListingWrite: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(10, '1 h') }),
    marketplaceContactReveal: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(20, '1 m') }),
    marketplaceBoostInit: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(10, '1 m') }),
    marketplaceReport: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(5, '1 h') }),
    marketplaceMessages: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(30, '1 m') }),
    marketplaceUpload: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(20, '1 h') }),
    // ── General catch-all ─────────────────────────────────────
    general: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(100, '1 m') }),
} : null

// Extract subdomain from request (e.g., 'marketplace' from 'marketplace.arhmsgh.com')
function getSubdomain(request: NextRequest): string | null {
    const host = request.headers.get('x-forwarded-host') || request.headers.get('host') || ''
    const parts = host.split('.')

    // localhost or IP-based access
    if (parts.length === 1 || host.includes('localhost') || host.includes('vercel.app') || host.includes('127.0.0.1')) {
        const localMatch = host.match(/^(\w+)\.localhost/) || host.match(/^(\w+)-\w+\.vercel\.app/)
        return localMatch ? localMatch[1] : null
    }

    // Standard domain (arhmsgh.com, www.arhmsgh.com, marketplace.arhmsgh.com or qzz.io equivalents)
    if (host.endsWith('arhmsgh.com') || host.endsWith('qzz.io')) {
        // marketplace.arhmsgh.com / marketplace.dataking.qzz.io -> 'marketplace'
        // www.arhmsgh.com, www.dataking.qzz.io -> null
        if (parts.length > 2 && parts[0] !== 'www') {
            return parts[0]
        }
        return null
    }

    return null
}

// Per-user memo cookies for the dashboard's UX redirects (see the dashboard guard).
const PHONE_OK_COOKIE = 'arhms_phone_ok'
const SUB_CHECK_COOKIE = 'arhms_sub_chk'

// Helper to add cache-prevention headers
function addNoCacheHeaders(response: NextResponse) {
    response.headers.set('Cache-Control', 'no-store, no-cache, max-age=0, must-revalidate, proxy-revalidate')
    response.headers.set('Pragma', 'no-cache')
    response.headers.set('Expires', '0')
    return response
}

// Returns a consistent 429 response with Retry-After and no-cache headers.
function rateLimitExceeded(retryAfter: number): NextResponse {
    const response = NextResponse.json(
        { error: 'Too many requests. Please try again later.' },
        { status: 429 }
    )
    response.headers.set('Retry-After', retryAfter.toString())
    return addNoCacheHeaders(response)
}

// Extracts the real client IP from Vercel/proxy headers.
// x-forwarded-for is the most reliable source on Vercel.
// CAVEAT (SEC-017): x-forwarded-for can be spoofed by clients if not stripped by the upstream proxy. 
// Vercel properly overwrites/appends the real IP, but relying solely on IP for hard security guarantees is discouraged.
function getIP(request: NextRequest): string {
    return request.headers.get('x-forwarded-for')?.split(',')[0].trim()
        ?? (request as any).ip
        ?? '127.0.0.1'
}

// Sets CORS headers ONLY for explicitly allowlisted origins.
// Never reflects the raw origin. Never uses wildcard with credentials.
// Requests with NO Origin header are same-site by definition and are never
// blocked by the CORS guard below (the guard only fires when origin is truthy).
function isTrustedOrigin(request: NextRequest, origin: string | null): boolean {
    if (!origin) return false
    // Static allowlist + env-derived origins
    if (ALLOWED_ORIGINS.has(origin) || origin === request.nextUrl.origin) return true
    // x-forwarded-host check: Vercel proxy may normalize the host so the Origin
    // header matches the forwarded host rather than nextUrl.origin.
    const forwardedHost = request.headers.get('x-forwarded-host')
    const forwardedProto = request.headers.get('x-forwarded-proto') ?? 'https'
    if (forwardedHost) {
        const derivedOrigin = normalizeOrigin(`${forwardedProto}://${forwardedHost}`)
        if (derivedOrigin && origin === derivedOrigin) return true
    }
    return false
}

function setCORSHeaders(response: NextResponse, request: NextRequest, origin: string | null): NextResponse {
    if (origin && isTrustedOrigin(request, origin)) {
        response.headers.set('Access-Control-Allow-Origin', origin)
        response.headers.set('Access-Control-Allow-Credentials', 'true')
        response.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
        response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With')
        response.headers.set('Vary', 'Origin')
    }
    // For untrusted/missing origins: emit NO Access-Control-* headers at all.
    return response
}

export async function middleware(request: NextRequest) {
    const origin = request.headers.get('origin')
    const pathname = request.nextUrl.pathname
    const subdomain = getSubdomain(request)
    const isMarketplace = subdomain === 'marketplace'

    // === HUBTEL WEBHOOK BYPASS ===
    // Hubtel USSD webhooks (/api/hubtel/*) are unsigned and don't have auth credentials.
    // Skip all middleware checks for them to eliminate latency.
    if (pathname.startsWith('/api/hubtel')) {
        return NextResponse.next({ request: { headers: request.headers } })
    }

    // === MARKETPLACE SUBDOMAIN ROUTING ===
    // marketplace.arhmsgh.com serves the classifieds app (app/classifieds/*).
    // Auth routes (/auth/*) redirect to the main domain (centralized auth).
    // Only the bare root is rewritten to /classifieds so the landing URL stays
    // clean; every in-app link is an absolute /classifieds/... path that falls
    // through untouched — those pages are served directly AND the classifieds
    // route guards further below still run. API routes and static assets also
    // fall through to their real locations.
    if (isMarketplace && pathname.startsWith('/auth')) {
        const mainDomainUrl = new URL(pathname + request.nextUrl.search, process.env.NEXT_PUBLIC_APP_URL || 'https://arhmsgh.com')
        return NextResponse.redirect(mainDomainUrl)
    }

    if (isMarketplace && pathname === '/') {
        const rewriteUrl = new URL('/classifieds', request.url)
        return NextResponse.rewrite(rewriteUrl, {
            request: {
                headers: new Headers({
                    ...Object.fromEntries(request.headers),
                    'x-subdomain': 'marketplace',
                }),
            },
        })
    }

    // === REFERRAL LINK CAPTURE ===
    // ?ref=CODE is stashed into a cookie and stripped from the URL, ABOVE every
    // guard below. This is the ONLY place in the app that writes this cookie.
    //
    // It has to run first, for three reasons:
    //   * An already-signed-in visitor tapping a friend's link is bounced to
    //     /dashboard by the /auth/* guard further down. Capturing here means the
    //     code survives that bounce instead of being silently eaten.
    //   * Google OAuth loses query params entirely — Supabase matches redirectTo
    //     against an allow-list, so a query string breaks the exact match (see the
    //     mkt_oauth_next cookie in components/google-sign-in-button.tsx). A
    //     first-party cookie is the established workaround in this codebase.
    //   * /auth/signup is statically prerendered, so the page reads this cookie via
    //     document.cookie rather than useSearchParams — which would force a
    //     Suspense boundary and change the build output.
    //
    // Redirecting to the same URL minus ?ref also stops a user who re-shares the
    // page they landed on from leaking someone else's code.
    //
    // Not httpOnly: the signup page reads it to render "Referred by X". A user can
    // therefore forge it, but all that does is attribute THEMSELVES to a referrer
    // of their choosing — identical to typing a code into the form. Zero privilege.
    //
    // The name is duplicated from REFERRAL_COOKIE in lib/referrals.ts rather than
    // imported: that module pulls in node:crypto for IP hashing, which must not be
    // dragged into the edge middleware bundle.
    const refParam = request.nextUrl.searchParams.get('ref')
    if (refParam && !pathname.startsWith('/api') && /^[A-Z0-9]{5,24}$/i.test(refParam)) {
        const cleanUrl = new URL(request.url)
        cleanUrl.searchParams.delete('ref')
        const stash = NextResponse.redirect(cleanUrl)
        stash.cookies.set('arhms_ref', refParam.toUpperCase(), {
            path: '/',
            maxAge: 60 * 60 * 24 * 30,
            sameSite: 'lax',
            httpOnly: false,
            secure: process.env.NODE_ENV === 'production',
            // Shared across subdomains in prod, mirroring the auth cookie domain in
            // lib/supabase.ts, so a link opened on marketplace.arhmsgh.com still
            // attributes when the user signs up on www.arhmsgh.com.
            ...(request.nextUrl.hostname.endsWith('arhmsgh.com')
                ? { domain: '.arhmsgh.com' }
                : {}),
        })
        return addNoCacheHeaders(stash)
    }

    // === CORS PREFLIGHT HANDLER ===
    // /api/v1/* is excluded from the middleware matcher — CORS handled via next.config.ts headers.
    if (request.method === 'OPTIONS') {
        if (isTrustedOrigin(request, origin)) {
            const preflightResponse = new NextResponse(null, { status: 204 })
            return addNoCacheHeaders(setCORSHeaders(preflightResponse, request, origin))
        } else {
            return new NextResponse(null, { status: 403 })
        }
    }

    // === ORIGIN ENFORCEMENT FOR API ROUTES ===
    // For cross-origin requests (Origin header present) to API routes,
    // block the request if origin is not in the allowlist.
    if (origin && pathname.startsWith('/api') && !isTrustedOrigin(request, origin)) {
        console.warn(`[CORS] Blocked request from untrusted origin: ${origin} → ${pathname}`)
        return new NextResponse(
            JSON.stringify({ error: 'CORS: Origin not allowed' }),
            { status: 403, headers: { 'Content-Type': 'application/json' } }
        )
    }

    let res = NextResponse.next({
        request: { headers: request.headers },
    })

    const supabase = createServerClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        {
            cookies: {
                getAll() {
                    return request.cookies.getAll()
                },
                setAll(cookiesToSet) {
                    cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
                    res = NextResponse.next({ request })
                    cookiesToSet.forEach(({ name, value, options }) =>
                        res.cookies.set(name, value, options)
                    )
                },
            },
        }
    )


    let authUser: { id: string } | null = null

    // === ANONYMOUS FAST PATH ===
    // supabase.auth.getUser() is a network round-trip to the Supabase auth
    // server on EVERY matched request — including logged-out visitors opening
    // /auth/login or /auth/signup, and including Next's Link prefetches. That
    // round-trip is what makes tapping "Login"/"Get Started" on the landing
    // page feel unresponsive on slow mobile connections.
    //
    // Supabase stores the session in `sb-<project-ref>-auth-token` cookies
    // (chunked as `...auth-token.0`, `.1` when large). No such cookie means
    // there is no session to validate, so getUser() can only ever return null —
    // skipping it is behaviour-preserving, not a weakened check. Every guard
    // below still runs against `authUser === null` exactly as before.
    const hasAuthCookie = request.cookies
        .getAll()
        .some(cookie => /^sb-.+-auth-token(\.\d+)?$/.test(cookie.name))

    if (hasAuthCookie) {
        try {
            // Add 10 second timeout to prevent hanging (increased for slow connections)
            const timeout = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Session timeout')), 10000)
            )

            // getClaims() rather than getUser(): with asymmetric JWT signing keys
            // it verifies the token locally against the cached JWKS — no round
            // trip to the auth server on every page tap and every Link prefetch.
            // On a project still using a symmetric secret it falls back to the
            // same network check getUser() made, so it is never weaker. It also
            // refreshes an expired session through the cookie adapter above,
            // exactly as getUser() did. Only `.id` is read downstream.
            const claimsPromise = supabase.auth.getClaims()

            const { data } = await Promise.race([
                claimsPromise,
                timeout
            ]) as any

            const sub = data?.claims?.sub
            authUser = sub ? { id: sub as string } : null
        } catch (error) {
            console.error('Middleware session error:', error)
            // On error or timeout, treat as no session
            authUser = null
        }
    }

    // === RATE LIMITING ===
    // Runs AFTER supabase.auth.getUser() so authUser.id is available for
    // user/admin-keyed limits. Runs BEFORE role checks to guard the
    // expensive database query.
    // OPTIONS preflights are already short-circuited above — safe.
    try {
        const ip = getIP(request)
        let limiter: Ratelimit | null | undefined = null
        let identifier: string = ip

        if (pathname === '/api/cron/sync-moolre-withdrawals') {
            limiter = null // Excluded entirely; protected by CRON_SECRET only
        } else if (pathname === '/api/shop/validate-account') {
            limiter = rateLimiters?.shopValidateAccount
            identifier = authUser?.id ? `${authUser.id}-${ip}` : ip
        } else if (pathname === '/api/admin/process-withdrawal') {
            limiter = rateLimiters?.adminProcessWithdrawal
            identifier = authUser?.id ? `${authUser.id}-${ip}` : ip
        } else if (pathname === '/api/auth/login') {
            limiter = rateLimiters?.login
            identifier = ip
        } else if (pathname === '/api/auth/signup') {
            limiter = rateLimiters?.signup
            identifier = ip
        } else if (pathname === '/api/auth/forgot-password') {
            limiter = rateLimiters?.forgotPassword
            identifier = ip
        } else if (pathname === '/api/auth/verify-phone/send-otp') {
            limiter = rateLimiters?.sendOtp
            identifier = ip
        } else if (pathname === '/api/auth/verify-phone/confirm-otp') {
            limiter = rateLimiters?.confirmOtp
            identifier = ip
        } else if (pathname === '/api/auth/complete-profile') {
            limiter = rateLimiters?.completeProfile
            identifier = authUser?.id ?? ip
        } else if (pathname === '/api/admin/get-prices') {
            limiter = rateLimiters?.general
            identifier = authUser?.id ? `${authUser.id}-${ip}` : ip
        } else if (pathname === '/api/admin/up2u-check') {
            // Must sit above the /api/admin catch-all or it never matches
            limiter = rateLimiters?.up2uCheck
            identifier = authUser?.id ? `${authUser.id}-${ip}` : ip
        } else if (pathname.startsWith('/api/admin')) {
            limiter = rateLimiters?.admin
            identifier = authUser?.id ?? ip
        } else if (pathname === '/api/shop/initialize') {
            limiter = rateLimiters?.shopInitialize
            identifier = ip
        } else if (pathname === '/api/shop/afa/initialize') {
            // Guest AFA checkout writes applicant PII (name, ID number, DOB)
            // on every call, before any payment is taken, so it needs the
            // same per-IP ceiling as the data-bundle checkout.
            limiter = rateLimiters?.shopInitialize
            identifier = ip
        } else if (pathname === '/api/webhooks/paystack' || pathname === '/api/webhooks/payswitch') {
            // PaySwitch callbacks carry no signature, so the route re-queries the
            // gateway before crediting. Rate limiting keeps a flood of forged
            // callbacks from turning into a flood of outbound status checks.
            limiter = rateLimiters?.webhook
            identifier = ip
        } else if (pathname === '/api/airtime/create') {
            limiter = rateLimiters?.airtimeCreate
            identifier = authUser?.id ? `${authUser.id}-${ip}` : ip
        } else if (pathname === '/api/orders/purchase') {
            limiter = rateLimiters?.ordersPurchase
            identifier = authUser?.id ? `${authUser.id}-${ip}` : ip
        } else if (pathname === '/api/orders/bulk-purchase') {
            limiter = rateLimiters?.ordersBulk
            identifier = authUser?.id ? `${authUser.id}-${ip}` : ip
        } else if (pathname === '/api/mtn/check-registration') {
            limiter = rateLimiters?.mtnRegCheck
            identifier = authUser?.id ? `${authUser.id}-${ip}` : ip
        } else if (pathname === '/api/payments/initialize') {
            limiter = rateLimiters?.paymentsInitialize
            identifier = ip
        } else if (pathname === '/api/payments/verify') {
            limiter = rateLimiters?.paymentsVerify
            identifier = ip
        } else if (pathname === '/api/shop/verify') {
            limiter = rateLimiters?.shopVerifyOrder
            identifier = ip
        } else if (pathname === '/api/shop/afa/verify') {
            limiter = rateLimiters?.shopVerifyOrder
            identifier = ip
        } else if (pathname === '/api/user/upgrade/initialize') {
            limiter = rateLimiters?.userUpgrade
            identifier = authUser?.id ? `${authUser.id}-${ip}` : ip
        } else if (pathname === '/api/user/upgrade/verify') {
            limiter = rateLimiters?.userUpgrade
            identifier = authUser?.id ? `${authUser.id}-${ip}` : ip
        } else if (pathname === '/api/shop/pricing') {
            limiter = rateLimiters?.shopPricing
            identifier = authUser?.id ? `${authUser.id}-${ip}` : ip
        } else if (pathname === '/api/shop/afa-pricing') {
            limiter = rateLimiters?.shopPricing
            identifier = authUser?.id ? `${authUser.id}-${ip}` : ip
        } else if (pathname === '/api/shop/withdraw') {
            limiter = rateLimiters?.shopWithdraw
            identifier = authUser?.id ? `${authUser.id}-${ip}` : ip
        } else if (pathname === '/api/shop/announcements') {
            limiter = rateLimiters?.shopAnnouncements
            identifier = authUser?.id ? `${authUser.id}-${ip}` : ip
        } else if (pathname === '/api/shop/alerts') {
            limiter = rateLimiters?.shopAlerts
            identifier = authUser?.id ? `${authUser.id}-${ip}` : ip
        } else if (pathname === '/api/users/update-profile') {
            limiter = rateLimiters?.updateProfile
            identifier = authUser?.id ? `${authUser.id}-${ip}` : ip
        } else if (pathname === '/api/users/delete-account') {
            limiter = rateLimiters?.deleteAccount
            identifier = authUser?.id ? `${authUser.id}-${ip}` : ip
        } else if (pathname === '/api/dashboard/sub/rc') {
            // Buying vouchers is ordinary repeat work for a sub, so this takes
            // the general shop ceiling rather than the hourly AFA one.
            limiter = rateLimiters?.shopPricing
            identifier = authUser?.id ?? ip
        } else if (pathname === '/api/dashboard/sub/afa') {
            // Same ceiling as the dashboard form, but keyed on the user: a sub
            // registering several walk-ins from one shop is normal traffic, and
            // the IP-only key would throttle their whole shop.
            limiter = rateLimiters?.afaRegistration
            identifier = authUser?.id ?? ip
        } else if (pathname === '/api/user/afa-registration') {
            limiter = rateLimiters?.afaRegistration
            identifier = ip
        } else if (pathname === '/api/agent/downgrade') {
            limiter = rateLimiters?.agentDowngrade
            identifier = authUser?.id ? `${authUser.id}-${ip}` : ip
        } else if (pathname === '/api/user/claim-dealer') {
            limiter = rateLimiters?.dealerClaim
            identifier = authUser?.id ? `${authUser.id}-${ip}` : ip
        } else if (pathname === '/api/user/dealer-subscribe') {
            limiter = rateLimiters?.dealerSubscribe
            identifier = authUser?.id ? `${authUser.id}-${ip}` : ip
        } else if (pathname === '/api/admin-settings') {
            limiter = rateLimiters?.adminSettings
            identifier = authUser?.id ? `${authUser.id}-${ip}` : ip
        } else if (pathname === '/api/shop/lookup-orders') {
            limiter = rateLimiters?.shopLookupOrders
            identifier = ip
        } else if (pathname === '/api/shop/my-orders') {
            limiter = rateLimiters?.shopMyOrders
            identifier = authUser?.id ? `${authUser.id}-${ip}` : ip
        } else if (pathname === '/api/airtime/history') {
            limiter = rateLimiters?.airtimeHistory
            identifier = authUser?.id ? `${authUser.id}-${ip}` : ip
        } else if (pathname.startsWith('/api/admin/supplier-balance')) {
            limiter = rateLimiters?.supplierBalance
            identifier = authUser?.id ? `${authUser.id}-${ip}` : ip
        } else if (pathname === '/api/support-chat') {
            limiter = rateLimiters?.supportChat
            identifier = ip
        } else if (pathname.startsWith('/api/cron')) {
            limiter = rateLimiters?.cron
            identifier = ip
        } else if (pathname.startsWith('/api/user')) {
            limiter = rateLimiters?.user
            identifier = authUser?.id ?? ip
        } else if (pathname.startsWith('/api')) {
            limiter = rateLimiters?.general
            identifier = ip
        }

        if (limiter) {
            const { success, reset } = await limiter.limit(identifier)
            if (!success) {
                const retryAfter = Math.ceil((reset - Date.now()) / 1000)
                return rateLimitExceeded(Math.max(1, retryAfter))
            }
        }
    } catch (error) {
        // Fail open — never block legitimate users due to Redis downtime.
        console.error('[RateLimiter] Redis error, failing open:', error)
    }

    // Protected dashboard routes
    // The portal PWA manifest must stay publicly fetchable — browsers request it
    // to evaluate installability and may do so without credentials. The route
    // itself returns a neutral manifest when there's no session.
    if (pathname.startsWith('/dashboard') && pathname !== '/dashboard/sub/manifest.webmanifest') {
        if (!authUser) {
            // Sub-agents use the de-branded portal login, not the main ARHMS login.
            const loginPath = pathname.startsWith('/dashboard/sub') ? '/portal/login' : '/auth/login'
            return addNoCacheHeaders(NextResponse.redirect(new URL(loginPath, request.url)))
        }

        // Phone verification guard — redirect if phone not set or not verified.
        // SKIP if the user just completed verification (cookie set by confirm-otp / send-otp bypass).
        // This prevents a race condition where the DB write hasn't propagated yet.
        const justVerified = request.cookies.get('phone_just_verified')?.value === '1'

        // This check and the sub-agent one below used to hit the database on every
        // dashboard tap AND every Link prefetch — two extra round trips before the
        // page could start. Both are UX redirects, not security boundaries (RLS and
        // the route handlers enforce access), so:
        //  * prefetches skip them — the real navigation re-runs middleware without
        //    the prefetch header, so the redirect still happens when it matters;
        //  * a pass is remembered in a per-user cookie. Forging it only lets a user
        //    skip their own profile-completion prompt.
        const isPrefetch =
            request.headers.get('next-router-prefetch') === '1' ||
            request.headers.get('purpose') === 'prefetch'
        const phoneAlreadyOk = request.cookies.get(PHONE_OK_COOKIE)?.value === authUser.id

        if (!justVerified && !isPrefetch && !phoneAlreadyOk) {
            try {
                const phoneTimeout = new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('Phone check timeout')), 5000)
                )
                const phoneQuery = supabase
                    .from('users')
                    .select('phone_number, phone_verified')
                    .eq('id', authUser.id)
                    .single()

                const { data: userStatus } = await Promise.race([phoneQuery, phoneTimeout]) as any

                if (userStatus) {
                    // Google/OAuth signups do NOT arrive with an empty phone — the signup
                    // trigger stores a synthetic placeholder, 'oauth_<id-prefix>' (see
                    // supabase/triggers.sql). Checking only for empty therefore let every
                    // OAuth user straight through, and they reached the dashboard with a
                    // placeholder saved as their phone number. That breaks anything keyed
                    // on a real MSISDN: Hubtel payments, SMS, order notifications.
                    const phone = String(userStatus.phone_number || '')
                    const isPlaceholder = phone === '' || phone.startsWith('oauth_')

                    if (isPlaceholder) {
                        return addNoCacheHeaders(NextResponse.redirect(new URL('/auth/complete-profile', request.url)))
                    }
                    // phone_verified check removed to allow users to go straight to dashboard
                    res.cookies.set(PHONE_OK_COOKIE, authUser.id, {
                        path: '/',
                        maxAge: 60 * 60 * 24,
                        httpOnly: true,
                        sameSite: 'lax',
                        secure: process.env.NODE_ENV === 'production',
                    })
                }
            } catch (error) {
                // Fail open — never block dashboard access due to infra issues
                console.error('[Middleware] Phone verification check failed, failing open:', error)
            }
        }

        // Sub-agents land on their own de-branded dashboard, not the main buyer
        // dashboard. Only the exact /dashboard landing is redirected (their home);
        // other /dashboard/* pages stay reachable, and /dashboard/sub is exempt so
        // there is no redirect loop. Fails open on any error/timeout.
        if (pathname === '/dashboard' && !isPrefetch) {
            // Only a negative result is cached ("<userId>:0", ten minutes). A cached
            // positive would outlive a sub-agent's removal and bounce them between
            // here and /dashboard/sub, whose layout sends non-subs back. Sub-agents
            // live on /dashboard/sub, so re-checking their rare visits costs nothing.
            const notSubCached = request.cookies.get(SUB_CHECK_COOKIE)?.value === `${authUser.id}:0`

            if (!notSubCached) {
                try {
                    const subTimeout = new Promise((_, reject) =>
                        setTimeout(() => reject(new Error('Sub check timeout')), 5000)
                    )
                    const subQuery = supabase
                        .from('sub_agents')
                        .select('id')
                        .eq('user_id', authUser.id)
                        .maybeSingle()

                    const { data: sub } = await Promise.race([subQuery, subTimeout]) as any

                    if (sub) {
                        return addNoCacheHeaders(NextResponse.redirect(new URL('/dashboard/sub', request.url)))
                    }
                    res.cookies.set(SUB_CHECK_COOKIE, `${authUser.id}:0`, {
                        path: '/',
                        maxAge: 60 * 10,
                        httpOnly: true,
                        sameSite: 'lax',
                        secure: process.env.NODE_ENV === 'production',
                    })
                } catch (error) {
                    console.error('[Middleware] Sub-agent check failed, failing open:', error)
                }
            }
        }
    }

    // Protected admin routes (UI and API)
    const isAdminUI = pathname.startsWith('/admin')
    const isAdminAPI = pathname.startsWith('/api/admin')

    // Whitelisted admin endpoints accessible to all authenticated users
    const adminPublicEndpoints = ['/api/admin/get-prices', '/api/admin-settings']
    const isAdminPublicEndpoint = adminPublicEndpoints.some(ep => pathname === ep)

    if ((isAdminUI || isAdminAPI) && !isAdminPublicEndpoint) {
        if (!authUser) {
            if (isAdminAPI) return addNoCacheHeaders(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }))
            return addNoCacheHeaders(NextResponse.redirect(new URL('/auth/login', request.url)))
        }

        try {
            // Add 8 second timeout to role check
            const timeout = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Role check timeout')), 8000)
            )

            const roleQuery = supabase
                .from('users')
                .select('role')
                .eq('id', authUser.id)
                .single()

            const { data: user } = await Promise.race([
                roleQuery,
                timeout
            ]) as any

            if (!user || (user.role !== 'admin' && user.role !== 'sub-admin')) {
                if (isAdminAPI) return addNoCacheHeaders(NextResponse.json({ error: 'Forbidden' }, { status: 403 }))
                return addNoCacheHeaders(NextResponse.redirect(new URL('/dashboard', request.url)))
            }

            // Strict Sub-Admin Lockdown
            if (user.role === 'sub-admin') {
                const isOrderPath = pathname.includes('/admin/orders')

                if (!isOrderPath) {
                    console.warn(`[MiddlewareAudit] Sub-admin ${authUser.id} blocked from ${pathname}`)

                    if (isAdminAPI) {
                        return addNoCacheHeaders(NextResponse.json({ error: 'Forbidden' }, { status: 403 }))
                    }

                    return addNoCacheHeaders(NextResponse.redirect(new URL('/admin/orders', request.url)))
                }
            }
        } catch (error) {
            console.error('Middleware role check error:', error)
            if (isAdminAPI) return addNoCacheHeaders(NextResponse.json({ error: 'Internal server error' }, { status: 500 }))
            return addNoCacheHeaders(NextResponse.redirect(new URL('/dashboard', request.url)))
        }
    }

    // === CLASSIFIEDS ROUTE GUARDS ===
    if (pathname.startsWith('/classifieds')) {
        // Public routes: /classifieds and /classifieds/[id]
        if (pathname === '/classifieds' || /^\/classifieds\/[^\/]+$/.test(pathname)) {
            return addNoCacheHeaders(setCORSHeaders(res, request, origin))
        }

        // Seller-only routes: /classifieds/seller/*
        if (pathname.startsWith('/classifieds/seller')) {
            // The seller phone login page is itself a login screen — logged-out
            // users MUST be able to reach it (otherwise it loops back here).
            if (pathname === '/classifieds/seller/login') {
                return addNoCacheHeaders(setCORSHeaders(res, request, origin))
            }
            if (!authUser) {
                return addNoCacheHeaders(NextResponse.redirect(new URL(`/classifieds/auth/login?redirect=${encodeURIComponent(pathname)}`, request.url)))
            }
            // TODO: Check if user has is_seller flag in Phase 2
            return addNoCacheHeaders(setCORSHeaders(res, request, origin))
        }

        // Buyer-only routes: /classifieds/buyer/*
        if (pathname.startsWith('/classifieds/buyer')) {
            if (!authUser) {
                return addNoCacheHeaders(NextResponse.redirect(new URL(`/classifieds/auth/login?redirect=${encodeURIComponent(pathname)}`, request.url)))
            }
            return addNoCacheHeaders(setCORSHeaders(res, request, origin))
        }

        // Admin-only routes: /classifieds/admin/*
        if (pathname.startsWith('/classifieds/admin')) {
            if (!authUser) {
                return addNoCacheHeaders(NextResponse.redirect(new URL('/auth/login', request.url)))
            }
            // Check if user is admin
            try {
                const timeout = new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('Role check timeout')), 8000)
                )

                const roleQuery = supabase
                    .from('users')
                    .select('role')
                    .eq('id', authUser.id)
                    .single()

                const { data: user } = await Promise.race([
                    roleQuery,
                    timeout
                ]) as any

                if (!user || !['admin', 'sub-admin'].includes(user.role)) {
                    return addNoCacheHeaders(NextResponse.redirect(new URL('/classifieds', request.url)))
                }
            } catch (error) {
                console.error('Classifieds admin role check error:', error)
                return addNoCacheHeaders(NextResponse.redirect(new URL('/classifieds', request.url)))
            }
            return addNoCacheHeaders(setCORSHeaders(res, request, origin))
        }
    }

    // === AUTH PAGE GUARDS ===
    if (pathname.startsWith('/auth')) {
        // These routes must always be allowed through regardless of session state:
        // - /auth/callback: OAuth handler that CREATES the session (no session exists yet)
        // - /auth/verify-phone: Immediately follows callback; session cookie may not propagate
        //   in time for the middleware to see it. The page handles auth client-side via useAuth().
        // - /auth/phone-setup: Dedicated phone collection page for new Google sign-up users;
        //   user is authenticated but hasn't completed setup yet.
        if (pathname.startsWith('/auth/callback') || pathname.startsWith('/auth/verify-phone') || pathname.startsWith('/auth/phone-setup')) {
            return addNoCacheHeaders(setCORSHeaders(res, request, origin))
        }

        // These pages require an active session
        const authRequiredPaths = ['/auth/complete-profile']
        const needsAuth = authRequiredPaths.some(p => pathname.startsWith(p))

        if (needsAuth) {
            // Redirect unauthenticated users to login
            if (!authUser) {
                return addNoCacheHeaders(NextResponse.redirect(new URL('/auth/login', request.url)))
            }
        } else if (authUser) {
            // All other /auth/* pages: redirect authenticated users to dashboard
            return addNoCacheHeaders(NextResponse.redirect(new URL('/dashboard', request.url)))
        }
    }

    return addNoCacheHeaders(setCORSHeaders(res, request, origin))
}

export const config = {
    matcher: [
        // Exclude static files and the developer API (/api/v1, /api/v2). Their CORS is
        // set in next.config.ts and their auth is the API key, checked in the route
        // handlers. Running the middleware over them would reject any browser-side
        // call from a partner's own domain via the origin allowlist below, and charge
        // every server-to-server request for a Supabase session lookup it never uses.
        '/((?!_next/static|_next/image|favicon.ico|api/v1|api/v2|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff|woff2)$).*)'
    ],
}
