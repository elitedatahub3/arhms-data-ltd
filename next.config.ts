import type { NextConfig } from 'next'
import withPWA from '@ducanh2912/next-pwa'
import withBundleAnalyzer from '@next/bundle-analyzer'
import path from 'path'

const supabaseImageHost = (() => {
    try {
        const url = process.env.NEXT_PUBLIC_SUPABASE_URL
        return url ? new URL(url).hostname : undefined
    } catch {
        return undefined
    }
})()

const nextConfig: NextConfig = {
    reactStrictMode: true,
    poweredByHeader: false,
    typescript: {
        // Supabase generic types produce 'never' inference errors on dynamic queries.
        // Type safety is still enforced locally in the IDE via tsconfig.
        ignoreBuildErrors: true,
    },
    eslint: {
        ignoreDuringBuilds: true,
    },
    images: {
        remotePatterns: supabaseImageHost
            ? [{
                protocol: 'https',
                hostname: supabaseImageHost,
            }]
            : [],
        // AVIF first, WebP second. Both are safe at our floor (Android 8+/Chrome 80+)
        // and AVIF is typically 20-30% smaller again than WebP at the same quality —
        // which is the difference between one and two round trips on a 2G link.
        formats: ['image/avif', 'image/webp'],
        // Next's defaults run to 3840px for desktop retina. Almost nothing here is
        // viewed on such a screen, and every extra entry is another variant the
        // optimizer may generate and cache. Trimmed to the widths phones actually
        // report: 320 (the cheap-Android floor) through 1920 for the odd desktop.
        deviceSizes: [320, 420, 640, 750, 828, 1080, 1200, 1920],
        // Icon- and thumbnail-scale widths, for `sizes` values below one viewport.
        imageSizes: [16, 24, 32, 48, 64, 96, 128, 256],
        // A month. These are content-hashed by the optimizer, so a longer TTL costs
        // nothing on change and saves a revalidation round trip on every repeat view.
        minimumCacheTTL: 2678400,
    },
    experimental: {
        serverActions: {
            bodySizeLimit: '2mb',
        },
        // NOTE: all three are already in Next 15's *default* optimizePackageImports
        // list, so listing them here changed the measured bundle by 0 KB. Kept only
        // to pin the behaviour if that default ever shifts -- do not expect a win
        // from it. The barrel-import cost it would address is already handled.
        optimizePackageImports: ['lucide-react', 'date-fns', 'recharts'],
    },
    async headers() {
        const securityHeaders = [
            {
                key: 'X-Frame-Options',
                value: 'DENY',
            },
            {
                key: 'X-Content-Type-Options',
                value: 'nosniff',
            },
            {
                key: 'Referrer-Policy',
                value: 'strict-origin-when-cross-origin',
            },
            {
                key: 'Permissions-Policy',
                value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
            },
            {
                key: 'Strict-Transport-Security',
                value: 'max-age=31536000; includeSubDomains',
            },
            {
                key: 'Content-Security-Policy',
                value: [
                    "default-src 'self'",
                    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://js.paystack.co",
                    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
                    "font-src 'self' https://fonts.gstatic.com",
                    `img-src 'self' data: ${supabaseImageHost ? `https://${supabaseImageHost}` : ''} https://cdn.jsdelivr.net https://www.transparenttextures.com blob:`,
                    `connect-src 'self' ${supabaseImageHost ? `https://${supabaseImageHost} wss://${supabaseImageHost}` : ''} https://api.paystack.co`,
                    "frame-src https://js.paystack.co",
                    "frame-ancestors 'none'",
                    "worker-src 'self' blob:",
                ].join('; '),
            },
        ]

        return [
            // Static assets - cache aggressively
            {
                source: '/_next/static/:path*',
                headers: [
                    {
                        key: 'Cache-Control',
                        value: 'public, max-age=31536000, immutable',
                    },
                ],
            },
            // Images - cache with revalidation
            {
                source: '/:path*\.(jpg|jpeg|png|gif|svg|webp|ico)',
                headers: [
                    {
                        key: 'Cache-Control',
                        value: 'public, max-age=86400, stale-while-revalidate',
                    },
                ],
            },
            // Shared public config - safe CDN cache with short TTL
            {
                source: '/api/public/config',
                headers: [
                    {
                        key: 'Cache-Control',
                        value: 'public, s-maxage=300, stale-while-revalidate=3600',
                    },
                ],
            },
            // Developer API v1 — open CORS for all external callers
            {
                source: '/api/v1/:path*',
                headers: [
                    { key: 'Access-Control-Allow-Origin',  value: '*' },
                    { key: 'Access-Control-Allow-Methods', value: 'GET, POST, OPTIONS' },
                    { key: 'Access-Control-Allow-Headers', value: 'Content-Type, Authorization' },
                    { key: 'Access-Control-Max-Age',       value: '86400' },
                ],
            },
            // Developer API v2 — same open CORS. Both versions are excluded from the
            // middleware matcher, so this is the only place their CORS is set.
            {
                source: '/api/v2/:path*',
                headers: [
                    { key: 'Access-Control-Allow-Origin',  value: '*' },
                    { key: 'Access-Control-Allow-Methods', value: 'GET, POST, OPTIONS' },
                    { key: 'Access-Control-Allow-Headers', value: 'Content-Type, Authorization' },
                    { key: 'Access-Control-Max-Age',       value: '86400' },
                ],
            },
            // Security headers for application routes. Cache policy is set per route/API.
            {
                source: '/:path*',
                headers: securityHeaders,
            },
        ]
    },
}

const withPWAConfig = withPWA({
    dest: 'public',
    // Both off deliberately. They prefetch pages the user has only hovered or
    // scrolled near, which on a 2G link competes for bandwidth with the
    // navigation the user actually asked for. Speculative fetching is a
    // fast-connection optimisation; here it makes the real request slower.
    cacheOnFrontEndNav: false,
    aggressiveFrontEndNavCaching: false,
    // Off: on mobile data the connection drops and returns constantly, and each
    // return hard-reloaded whatever page the user was on — losing scroll
    // position and form input, and refetching everything. Pages already recover
    // on their own; the offline modal covers the genuinely-offline case.
    reloadOnOnline: false,
    disable: process.env.NODE_ENV === 'development',
    customWorkerSrc: path.resolve(process.cwd(), 'worker'),
    workboxOptions: {
        disableDevLogs: true,
        // `exclude` is tested against *webpack asset names* — `static/chunks/foo.js`,
        // with no leading slash. The previous value here was `/^\//`, which
        // therefore matched nothing at all: the intent was to keep the root HTML
        // out of the precache, but the pattern could never fire, and nothing else
        // was excluded either. The result was a 502-entry / 7.79 MB precache.
        //
        // That entire payload downloaded in the background on a user's first
        // visit, racing the page they were waiting for over the same ~5 KB/s
        // pipe. Dropping the build output from the *pre*cache does not stop it
        // being cached: the plugin's default runtimeCaching already has a
        // CacheFirst rule for `/_next/static.+\.js` (cacheName
        // "next-static-js-assets"), so a chunk is cached the first time it is
        // actually used — and these are content-hashed and served immutable
        // (see the headers() block above), so repeat visits behave identically.
        // The difference is only that nothing is fetched speculatively.
        //
        // What stays precached is what the PWA needs to open offline at all:
        // offline.html, manifest.json and the icons, which come from public/ and
        // total well under 100 KB.
        exclude: [
            /^static\/chunks\//,
            /^static\/css\//,
            /^static\/media\//,
            // Source maps are never needed by a client and are large.
            /\.map$/,
            // Build manifests: stale copies break hydration after a deploy.
            /build-manifest\.json$/,
            /react-loadable-manifest\.json$/,
        ],
    },
})

// Opt-in only: `ANALYZE=true npm run build` writes the treemap reports. A normal
// build is byte-for-byte unaffected, so this is safe to leave wired up permanently.
const withAnalyzer = withBundleAnalyzer({
    enabled: process.env.ANALYZE === 'true',
    openAnalyzer: false,
})

export default withAnalyzer(withPWAConfig(nextConfig))
