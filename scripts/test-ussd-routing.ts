/**
 * Test: a paid USSD bill reaches the bill payer from BOTH settlement routes
 * (app/api/webhooks/paystack and app/api/cron/verify-paystack-momo-payments)
 *
 * The cost of getting this wrong is quiet and expensive. A USSD- reference that is not
 * recognised as a bill falls through to the wallet top-up path, which credits the account of
 * record's wallet — for a shop sale, the SHOP OWNER's — and the bill is never paid. And the
 * webhook is currently not delivering at all, so the 5-minute sweep settles everything; its
 * routing is the one that matters day to day.
 *
 * Both routes are driven for real, with signed requests / the cron secret, an in-memory
 * database and every unrelated collaborator replaced by an inert stub. What is real:
 * the route handlers, lib/ussd-utility-settle, lib/ussd-member-settle, lib/ussd-reference.
 *
 * Run (CommonJS is required for the require() hook below):
 *
 *   TS_NODE_COMPILER_OPTIONS='{"module":"commonjs","moduleResolution":"node"}' \
 *     npx ts-node --transpile-only scripts/test-ussd-routing.ts
 *
 * Exit code: 0 = all pass, 1 = any fail
 */
import crypto from 'crypto'
import Module from 'module'
import path from 'path'

const REPO_ROOT = path.resolve(__dirname, '..')
process.env.PAYSTACK_SECRET_KEY = 'sk_test_routing'
process.env.CRON_SECRET = 'cron-secret'
process.env.UPSTASH_REDIS_REST_URL = 'http://stub.local'
process.env.UPSTASH_REDIS_REST_TOKEN = 'stub'

// ── In-memory database (eq/in honoured; time and pattern filters accept everything) ──
type Row = Record<string, any>
let tables: Record<string, Row[]> = {}

function builder(table: string) {
    const q: any = { op: 'select', filters: [] as Array<(r: Row) => boolean>, payload: null, head: false, limit: Infinity }
    const run = async () => {
        const rows = (tables[table] = tables[table] || [])
        const matched = rows.filter((r) => q.filters.every((f: any) => f(r)))
        if (q.op === 'update') { matched.forEach((r) => Object.assign(r, q.payload)); return { data: matched, error: null } }
        if (q.op === 'delete') { tables[table] = rows.filter((r) => !matched.includes(r)); return { data: matched, error: null } }
        if (q.head) return { data: null, count: matched.length, error: null }
        return { data: matched.slice(0, q.limit), error: null }
    }
    const api: any = {
        select(_c?: string, opts?: any) { if (opts?.head) q.head = true; return api },
        update(p: any) { q.op = 'update'; q.payload = p; return api },
        delete() { q.op = 'delete'; return api },
        insert() { return api },
        upsert() { return api }, // the webhook's heartbeat write
        eq(c: string, v: any) { q.filters.push((r: Row) => r[c] === v); return api },
        in(c: string, vs: any[]) { q.filters.push((r: Row) => vs.includes(r[c])); return api },
        lt() { return api }, gt() { return api }, gte() { return api }, lte() { return api },
        like() { return api }, not() { return api }, is() { return api }, or() { return api },
        order() { return api },
        limit(n: number) { q.limit = n; return api },
        single: async () => { const r = await run(); return { data: r.data?.[0] ?? null, error: null } },
        maybeSingle: async () => { const r = await run(); return { data: r.data?.[0] ?? null, error: null } },
        then(res: any, rej: any) { return run().then(res, rej) },
    }
    return api
}
const db: any = { from: (t: string) => builder(t), rpc: async () => ({ data: null, error: null }) }

// ── What settlement did ─────────────────────────────────────────────────────────
const calls = { bill: [] as string[], topup: [] as string[], logged: [] as any[], sms: [] as string[] }
let verifyAmountPesewas = 5150

/** A module whose every export is an inert async function — for collaborators this test is not about. */
const inert = () => new Proxy({}, { get: (_t, prop) => (prop === '__esModule' ? false : async () => ({})) })

const REAL = new Set([
    '@/lib/ussd-utility-settle', '@/lib/ussd-utility-sms', '@/lib/ussd-member-settle', '@/lib/ussd-member',
    '@/lib/ussd-reference', '@/lib/ussd-settle', '@/lib/ussd-afa',
    // The two routes under test.
    '@/app/api/webhooks/paystack/route', '@/app/api/cron/verify-paystack-momo-payments/route',
])

const originalLoad = (Module as any)._load
;(Module as any)._load = function (request: string, parent: unknown, isMain: boolean) {
    if (request === '@/lib/supabase') return { createServerClient: () => db }
    if (request === '@/lib/utility-order-payments') {
        return { processUtilityDirectOrder: async (reference: string) => { calls.bill.push(reference); return { success: true, order: { status: 'processing' } } } }
    }
    if (request === '@/lib/payments') {
        return {
            processCompletedWalletPayment: async (reference: string) => { calls.topup.push(reference); return { success: true } },
            isSmsPaymentReference: () => false,
            processCompletedUpgradePayment: async () => {},
            processCompletedDealerSubscription: async () => {},
        }
    }
    if (request === '@/lib/hubtel-payment-log') {
        return {
            logCallback: async (p: any) => { calls.logged.push(p) },
            logStatusCheck: async (p: any) => { calls.logged.push(p) },
            logInitiate: async () => {},
        }
    }
    if (request === '@/lib/hubtel-sms-service') {
        return { sendHubtelSMS: async (p: any) => { calls.sms.push(p.message); return { success: true } } }
    }
    if (request === '@/lib/paystack-momo-service') {
        return { verifyTransaction: async () => ({ outcome: 'paid', amountPesewas: verifyAmountPesewas, raw: {} }) }
    }
    if (request === '@/lib/hubtel-status-throttle') {
        return { claimHubtelStatusCheck: async () => ({ allowed: true }), PAYSTACK_MOMO_CRON_THROTTLE_KEYS: {} }
    }
    if (request === '@/lib/shop-meta-store') {
        return { getShopMeta: async () => null, listPendingShopPayments: async () => [], stampShopPaymentCheck: async () => {} }
    }
    if (request === '@upstash/redis') return { Redis: { fromEnv: () => ({}) } }
    if (request === '@/lib/retired-boost') {
        return { isRetiredBoostReference: () => false, reportRetiredBoostPayment: () => {}, RETIRED_BOOST_MESSAGE: '' }
    }
    if (request.startsWith('@/') && !REAL.has(request)) return inert()
    if (request.startsWith('@/')) return originalLoad.apply(this, [path.join(REPO_ROOT, request.slice(2)), parent, isMain])
    return originalLoad.apply(this, [request, parent, isMain])
}

/* eslint-disable @typescript-eslint/no-var-requires */
const webhook = require('@/app/api/webhooks/paystack/route')
const cron = require('@/app/api/cron/verify-paystack-momo-payments/route')
/* eslint-enable @typescript-eslint/no-var-requires */

const REF = 'USSD-UTIL-ABCDEF-123456'
const billMeta = {
    kind: 'utility_order', channel: 'ussd', service: 'ecg', account_number: '94415486839', bill_amount: 50,
    shop_id: 'sh1', shop_name: 'Kofi Store', payer_msisdn: '233201234567', session_id: 's1',
}

function seed(ref = REF, meta: Row = billMeta, extra: Record<string, Row[]> = {}) {
    tables = {
        wallet_payments: [{ id: 'wp1', user_id: 'u-kofi', wallet_id: 'w1', reference: ref, provider: 'paystack_momo', amount: 51.5, total_amount: 51.5, status: 'pending', metadata: meta, created_at: new Date(Date.now() - 600_000).toISOString() }],
        hubtel_payment_logs: [{ client_reference: ref, flow: 'ussd', status: 'pending', amount: 51.5, created_at: new Date(Date.now() - 600_000).toISOString() }],
        hubtel_sessions: [{ session_id: 's1', mobile: '233201234567', data: {} }],
        ...extra,
    }
    calls.bill.length = 0; calls.topup.length = 0; calls.logged.length = 0; calls.sms.length = 0
    verifyAmountPesewas = 5150
}

async function postWebhook(ref: string, amountPesewas: number, metadata: Row = {}) {
    const body = JSON.stringify({ event: 'charge.success', data: { id: 99, reference: ref, amount: amountPesewas, metadata } })
    const signature = crypto.createHmac('sha512', process.env.PAYSTACK_SECRET_KEY!).update(body).digest('hex')
    const res = await webhook.POST(new Request('https://x.test/api/webhooks/paystack', { method: 'POST', headers: { 'x-paystack-signature': signature }, body }) as any)
    return { status: res.status, json: await res.json() }
}
async function runSweep() {
    const res = await cron.GET(new Request('https://x.test/api/cron/verify-paystack-momo-payments', { headers: { authorization: 'Bearer cron-secret' } }) as any)
    return { status: res.status, json: await res.json() }
}

let passed = 0
let failed = 0
function check(name: string, ok: boolean, detail = '') {
    if (ok) { console.log(`  PASS  ${name}`); passed++ } else { console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ''}`); failed++ }
}

async function main() {
    console.error = () => {}
    console.warn = () => {}
    console.log = ((orig) => (...a: any[]) => { if (typeof a[0] === 'string' && /^\[(Ussd|Paystack|CronPaystack)/.test(a[0])) return; orig(...a) })(console.log)

    // ── The webhook ─────────────────────────────────────────────────────────────
    seed()
    let r = await postWebhook(REF, 5150, { session_id: 's1', order_type: 'util', payer_msisdn: '233201234567' })
    check('webhook: a USSD bill payment goes to the bill payer, once, and the Paystack call is acknowledged',
        r.status === 200 && r.json.received === true && calls.bill.length === 1 && calls.bill[0] === REF, JSON.stringify({ r, calls }))
    check('webhook: …and is NEVER treated as a wallet top-up (that would credit the shop owner and pay no bill)', calls.topup.length === 0, JSON.stringify(calls.topup))
    check('webhook: …and the session is cleaned up', tables.hubtel_sessions.length === 0)
    check('webhook: …and the delivery is logged as a success', calls.logged.some((l) => l.clientReference === REF && l.status === 'success'), JSON.stringify(calls.logged))

    seed()
    r = await postWebhook(REF, 4000, { session_id: 's1', order_type: 'util' })
    check('webhook: an underpaid bill is NOT paid, and is logged as failed for a human', calls.bill.length === 0 && calls.topup.length === 0 && calls.logged.some((l) => l.status === 'failed'), JSON.stringify({ calls }))

    seed()
    await postWebhook(REF, 5150, { session_id: 's1' }); await postWebhook(REF, 5150, { session_id: 's1' })
    check('webhook: a redelivered webhook asks the bill payer again — which is the idempotent step — and never tops up', calls.bill.length === 2 && calls.topup.length === 0)

    // ── The sweep ───────────────────────────────────────────────────────────────
    seed()
    r = await runSweep()
    check('sweep: a pending USSD bill payment goes to the bill payer', r.status === 200 && calls.bill.includes(REF), JSON.stringify({ status: r.status, bill: calls.bill, topup: calls.topup, json: r.json }))
    check('sweep: …and is NEVER treated as a wallet top-up', calls.topup.length === 0, JSON.stringify(calls.topup))

    seed(); verifyAmountPesewas = 3000
    r = await runSweep()
    check('sweep: an underpaid bill is not paid and not topped up', calls.bill.length === 0 && calls.topup.length === 0, JSON.stringify(calls))

    // The sweep reaches a payment two ways, and either alone must be enough: pending
    // wallet payments (Part A), and pending USSD log rows (Part C1). Isolated so that a
    // regression in one cannot hide behind the other.
    seed(REF, billMeta, { hubtel_payment_logs: [] })
    r = await runSweep()
    check('sweep, pending-payments route ALONE: pays the bill, does not top up', calls.bill.includes(REF) && calls.topup.length === 0, JSON.stringify(calls))

    seed()
    tables.wallet_payments[0].status = 'completed'
    r = await runSweep()
    check('sweep, USSD-log route ALONE: pays the bill, does not top up', calls.bill.includes(REF) && calls.topup.length === 0, JSON.stringify(calls))

    // The control: the harness is not vacuous. An ordinary top-up still goes the old way.
    seed('TOPUP-ABC-1', { kind: 'wallet_topup' }, { hubtel_payment_logs: [] })
    r = await runSweep()
    check('control: an ordinary wallet top-up is still credited as a top-up by the sweep', calls.topup.includes('TOPUP-ABC-1') && calls.bill.length === 0, JSON.stringify(calls))

    seed('UTIL-WEB-0001', { kind: 'utility_order', service: 'ecg' }, { hubtel_payment_logs: [] })
    r = await runSweep()
    check('control: a website bill (UTIL-) is still paid by the sweep as before', calls.bill.includes('UTIL-WEB-0001') && calls.topup.length === 0, JSON.stringify(calls))

    console.log(`\n${passed} passed, ${failed} failed`)
    process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => { process.stderr.write(`${e?.stack || e}\n`); process.exit(1) })
