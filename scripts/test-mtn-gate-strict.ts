/**
 * Test: MTN registration gate — the fail-closed USSD path
 *
 * checkMtnRegistrationStrict() is the one place in the codebase where an
 * unanswerable supplier check STOPS a sale rather than letting it through, so the
 * property worth pinning is the asymmetry itself: every outcome that is not a
 * confirmed "registered" must refuse, while the fail-open batch path it shares its
 * internals with keeps letting those same outcomes past.
 *
 * The two entry points share resolveRegistrationStatuses(), so a regression in that
 * shared helper would silently flip one of them. These cases run both against the
 * same stubbed supplier answers to catch exactly that.
 *
 * Note what is NOT covered here: the public API v1 does not call this module at all.
 * The dashboard does — all three of its purchase routes refuse — but through the
 * fail-open batch path, not the strict one. The import-graph assertions at the end of
 * this file are what pin which surface is which.
 *
 * Stubs the database and the Agent Portal call — no network, no DB.
 *
 * Run (the compiler options are required — tsconfig.json targets the Next.js
 * bundler, and this needs CommonJS for the require() hook below):
 *
 *   TS_NODE_COMPILER_OPTIONS='{"module":"commonjs","moduleResolution":"node"}' \
 *     npx ts-node --transpile-only scripts/test-mtn-gate-strict.ts
 *
 * Exit code: 0 = all pass, 1 = any fail
 */

import Module from 'module'
import path from 'path'

// ── Stubs ────────────────────────────────────────────────────────────────────────
// verifyMtnWhitelist is the upstream call. Intercept it at require() time so the
// module under test can be imported normally, with its real phone validation intact.
//
// The same hook resolves the '@/' alias by hand. tsconfig.json declares paths with
// no baseUrl (the Next.js convention), which tsconfig-paths/register refuses to use,
// so doing it here keeps the test runnable with plain ts-node and no extra setup.

type UpstreamMode = 'allow' | 'deny' | 'fail'
let upstreamMode: UpstreamMode = 'deny'
let upstreamCalls = 0

const REPO_ROOT = path.resolve(__dirname, '..')

const originalLoad = (Module as any)._load
;(Module as any)._load = function (request: string, parent: unknown, isMain: boolean) {
    if (request === '@/lib/agentportal-service') {
        return {
            verifyMtnWhitelist: async (msisdns: string[]) => {
                upstreamCalls++
                if (upstreamMode === 'fail') {
                    return { success: false, allowed: new Set<string>(), error: 'stubbed outage' }
                }
                return {
                    success: true,
                    allowed: upstreamMode === 'allow' ? new Set(msisdns) : new Set<string>(),
                }
            },
        }
    }
    if (request.startsWith('@/')) {
        return originalLoad.apply(this, [path.join(REPO_ROOT, request.slice(2)), parent, isMain])
    }
    return originalLoad.apply(this, [request, parent, isMain])
}

/**
 * Minimal supabase double. Only the three shapes the gate uses:
 *   .from(t).select(c).eq(k, v)      → settings read
 *   .from(t).select(c).in(k, vals)   → cache read
 *   .from(t).upsert(rows, opts)      → cache write
 * Cache always misses, so every case reaches the stubbed upstream.
 */
function makeSupabase(gateEnabledRow: string | null) {
    return {
        from() {
            return {
                select() {
                    return {
                        eq: async () => ({
                            data: gateEnabledRow === null ? [] : [{ key: 'x', value: gateEnabledRow }],
                        }),
                        in: async () => ({ data: [], error: null }),
                    }
                },
                upsert: async () => ({ error: null }),
            }
        },
    }
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const gate = require('@/lib/mtn-registration-gate')
const {
    checkMtnRegistrationStrict,
    checkMtnRegistrationBatch,
    clearGateSettingsCache,
    USSD_NOT_REGISTERED_MESSAGE,
    USSD_REGISTRATION_UNVERIFIABLE_MESSAGE,
} = gate

// A real MTN number, so validateGhanaianPhone accepts it.
const MTN = '0241234567'
/** Telecel prefix — valid Ghanaian number, wrong network for an MTN bundle. */
const TELECEL = '0201234567'

interface Case {
    name: string
    enabled: boolean
    upstream: UpstreamMode
    phone: string
    network: string
    wantBlocked: boolean
    wantReason?: 'unregistered' | 'unverifiable'
    /** What the fail-OPEN batch path must say about the same inputs. */
    wantBatchGated: boolean
}

const cases: Case[] = [
    {
        name: 'gate off → allowed, upstream never called',
        enabled: false, upstream: 'deny', phone: MTN, network: 'MTN',
        wantBlocked: false, wantBatchGated: false,
    },
    {
        name: 'registered → allowed',
        enabled: true, upstream: 'allow', phone: MTN, network: 'MTN',
        wantBlocked: false, wantBatchGated: false,
    },
    {
        name: 'unregistered → REFUSED',
        enabled: true, upstream: 'deny', phone: MTN, network: 'MTN',
        wantBlocked: true, wantReason: 'unregistered', wantBatchGated: true,
    },
    {
        name: 'supplier outage → REFUSED (fail closed; batch stays fail open)',
        enabled: true, upstream: 'fail', phone: MTN, network: 'MTN',
        wantBlocked: true, wantReason: 'unverifiable', wantBatchGated: false,
    },
    {
        name: 'Special MTN Mashup → exempt even when unregistered',
        enabled: true, upstream: 'deny', phone: MTN, network: 'Special MTN Mashup',
        wantBlocked: false, wantBatchGated: false,
    },
    {
        name: 'EXPRESS MTN → exempt even when unregistered',
        enabled: true, upstream: 'deny', phone: MTN, network: 'EXPRESS MTN',
        wantBlocked: false, wantBatchGated: false,
    },
    {
        name: 'Telecel number on an MTN bundle → exempt (mis-typed, not unregistered)',
        enabled: true, upstream: 'deny', phone: TELECEL, network: 'MTN',
        wantBlocked: false, wantBatchGated: false,
    },
]

async function main() {
    let passed = 0
    let failed = 0

    for (const c of cases) {
        upstreamMode = c.upstream
        upstreamCalls = 0
        clearGateSettingsCache()

        // Strict (USSD) path. `enabled` is passed in, so the DB stub is irrelevant here.
        const strict = await checkMtnRegistrationStrict(
            makeSupabase(null), c.phone, c.network, { enabled: c.enabled }
        )
        const strictCalls = upstreamCalls

        // Batch (web) path, same inputs, gate state read from the DB stub instead.
        upstreamCalls = 0
        clearGateSettingsCache()
        const batch = await checkMtnRegistrationBatch(
            makeSupabase(c.enabled ? 'true' : 'false'),
            [{ phoneNumber: c.phone, packageNetwork: c.network }]
        )

        const problems: string[] = []
        if (strict.blocked !== c.wantBlocked) {
            problems.push(`strict.blocked=${strict.blocked}, want ${c.wantBlocked}`)
        }
        if (c.wantReason && strict.reason !== c.wantReason) {
            problems.push(`strict.reason=${strict.reason}, want ${c.wantReason}`)
        }
        const batchGated = batch.unregistered.length > 0
        if (batchGated !== c.wantBatchGated) {
            problems.push(`batch gated=${batchGated}, want ${c.wantBatchGated}`)
        }
        if (!c.enabled && strictCalls !== 0) {
            problems.push(`upstream called ${strictCalls}x while gate off`)
        }

        if (problems.length === 0) {
            console.log(`  PASS  ${c.name}`)
            passed++
        } else {
            console.log(`  FAIL  ${c.name}`)
            for (const p of problems) console.log(`          ${p}`)
            failed++
        }
    }

    // The messages are read off a feature-phone screen and sent through Hubtel, which
    // throws on non-ASCII and truncates past ~160 chars.
    console.log('')
    for (const [name, msg] of [
        ['USSD_NOT_REGISTERED_MESSAGE', USSD_NOT_REGISTERED_MESSAGE],
        ['USSD_REGISTRATION_UNVERIFIABLE_MESSAGE', USSD_REGISTRATION_UNVERIFIABLE_MESSAGE],
    ] as Array<[string, string]>) {
        const ascii = /^[\x20-\x7E]*$/.test(msg)
        if (ascii && msg.length < 160) {
            console.log(`  PASS  ${name} (${msg.length} chars, ASCII)`)
            passed++
        } else {
            console.log(`  FAIL  ${name}: len=${msg.length} ascii=${ascii}`)
            failed++
        }
    }

    // ── Surface wiring ───────────────────────────────────────────────────────────
    // Which routes import this module is a product decision, not an implementation
    // detail: API v1 is ungated ON PURPOSE, and each dashboard purchase route is gated
    // ON PURPOSE. Either is exactly the kind of thing a later refactor flips by
    // accident, and no type error or unit test would catch it — so assert the import
    // graph directly.
    console.log('')
    const fs = require('fs') as typeof import('fs')
    const pathMod = require('path') as typeof import('path')

    const MUST_NOT_GATE = [
        'app/api/v1/data/purchase/route.ts',
        'app/api/v1/data/bulk/route.ts',
        // The page reads the 409 body and shows the dialog. It must not import the gate
        // module itself — that would pull the supplier client into the browser bundle.
        'app/dashboard/data-packages/page.tsx',
    ]
    const MUST_GATE = [
        'app/api/shop/initialize/route.ts',
        'app/api/hubtel/interact/route.ts',
        'app/api/orders/purchase/route.ts',
        'app/api/orders/bulk-purchase/route.ts',
        'app/api/orders/gateway-init/route.ts',
    ]

    /** Real import of the gate module, ignoring the prose in comments about it. */
    const importsGate = (file: string): boolean => {
        const src = fs.readFileSync(pathMod.join(REPO_ROOT, file), 'utf8')
        return /^\s*import\s[\s\S]*?from\s+['"]@\/lib\/mtn-registration-gate['"]/m.test(src)
            || /import\(\s*['"]@\/lib\/mtn-registration-gate['"]/.test(src)
    }

    for (const file of MUST_NOT_GATE) {
        if (importsGate(file)) {
            console.log(`  FAIL  ${file} must NOT import the gate (dashboard/API are ungated)`)
            failed++
        } else {
            console.log(`  PASS  ${file} is ungated`)
            passed++
        }
    }
    for (const file of MUST_GATE) {
        if (importsGate(file)) {
            console.log(`  PASS  ${file} is gated`)
            passed++
        } else {
            console.log(`  FAIL  ${file} must import the gate (storefront/USSD are gated)`)
            failed++
        }
    }

    console.log(`\n${passed} passed, ${failed} failed`)
    process.exit(failed === 0 ? 0 : 1)
}

main()
