/**
 * Test: settling a registered user's USSD order (lib/ussd-member-settle.ts)
 *
 * This is the money path: the payment webhook and the 5-minute reconciliation sweep can
 * both settle the same payment, together or apart, and a member must end up with the
 * wallet credited ONCE, the item bought ONCE, and no false "we could not complete your
 * order" text. Pins:
 *
 *   - the row keeps its order metadata after the credit (processCompletedWalletPayment
 *     overwrites metadata with what it is given; losing `kind` made the next settlement
 *     treat the payment as a shop/house order and deliver the item a second time);
 *   - two simultaneous settlements buy once (the atomic claim);
 *   - a webhook retry after success, or after a failed purchase, does nothing more;
 *   - a failed purchase leaves the money in the wallet and sends exactly one SMS;
 *   - a failure that is really a lost race (the order exists) sends no SMS at all;
 *   - an underpayment credits nothing;
 *   - a claim from a settlement that died is retaken, a fresh one is not.
 *
 * No network, no database: the wallet credit, both purchase paths and SMS are stubbed,
 * and a small in-memory Supabase honours the claim's conditional UPDATE atomically.
 *
 * Run (CommonJS is required for the require() hook below):
 *
 *   TS_NODE_COMPILER_OPTIONS='{"module":"commonjs","moduleResolution":"node"}' \
 *     npx ts-node --transpile-only scripts/test-ussd-member-settle.ts
 *
 * Exit code: 0 = all pass, 1 = any fail
 */
import Module from 'module'
import path from 'path'

const REPO_ROOT = path.resolve(__dirname, '..')

type Row = Record<string, any>
let tables: Record<string, Row[]> = {}
const counters = { credits: 0, dataBuys: 0, rcBuys: 0, sms: [] as string[], rcArgs: [] as any[] }
let dataBuyResult: { ok: boolean; error?: string } = { ok: true }
/** Makes the claim's conditional UPDATE error, as if the filter or connection failed. */
let failClaimQuery = false

// ── In-memory Supabase: select/eq/maybeSingle, and the claim's update/eq/or/select ──
function builder(table: string) {
    let op = 'select'
    let payload: any = null
    const filters: Array<(r: Row) => boolean> = []
    const api: any = {
        select() { return api },
        update(p: any) { op = 'update'; payload = p; return api },
        eq(c: string, v: any) { filters.push((r) => r[c] === v); return api },
        // The one shape the code uses:
        //   metadata->>purchase_claimed_at.is.null,metadata->>purchase_claimed_at.lt.<iso>
        or(expr: string) {
            const lt = expr.match(/purchase_claimed_at\.lt\.(.+)$/)?.[1]
            filters.push((r) => {
                const at = r.metadata?.purchase_claimed_at
                return at == null || (lt !== undefined && String(at) < lt)
            })
            return api
        },
        maybeSingle: async () => ({ data: (tables[table] || []).find((r) => filters.every((f) => f(r))) ?? null, error: null }),
        // Evaluated and applied in one synchronous block — atomic, like a single UPDATE.
        then(res: any, rej: any) {
            if (op === 'update' && failClaimQuery) return Promise.resolve({ data: null, error: { message: 'stubbed claim failure' } }).then(res, rej)
            const rows = (tables[table] || []).filter((r) => filters.every((f) => f(r)))
            if (op === 'update') rows.forEach((r) => Object.assign(r, payload))
            return Promise.resolve({ data: rows, error: null }).then(res, rej)
        },
    }
    return api
}
const db = { from: (t: string) => builder(t) }

const originalLoad = (Module as any)._load
;(Module as any)._load = function (request: string, parent: unknown, isMain: boolean) {
    if (request === '@/lib/payments') {
        return {
            // Mirrors the real one: claims pending→completed once, and WRITES the metadata it is given.
            processCompletedWalletPayment: async (reference: string, providerMetadata: any) => {
                const row = (tables.wallet_payments || []).find((r) => r.reference === reference)
                if (!row) return { success: false, error: 'Payment not found' }
                if (row.status !== 'pending') return { success: true, alreadyProcessed: true }
                row.status = 'completed'
                row.metadata = providerMetadata || row.metadata
                counters.credits++
                return { success: true }
            },
        }
    }
    if (request === '@/lib/wallet-data-purchase') {
        return {
            purchaseDataWithWallet: async (p: any) => {
                await Promise.resolve() // let a concurrent settlement interleave
                counters.dataBuys++
                if (!dataBuyResult.ok) return { ok: false, error: dataBuyResult.error, status: 400 }
                const existing = (tables.orders || []).find((o) => o.reference_code === p.referenceCode)
                if (existing) return { ok: true, isDuplicate: true, order: existing }
                const order = { id: `o${counters.dataBuys}`, reference_code: p.referenceCode, status: 'pending' }
                ;(tables.orders = tables.orders || []).push(order)
                return { ok: true, isDuplicate: false, order }
            },
        }
    }
    if (request === '@/lib/vouchers/checkout') {
        return { purchaseWithWallet: async (p: any) => { counters.rcBuys++; counters.rcArgs.push(p); return { order: {}, vouchers: [] } } }
    }
    if (request === '@/lib/hubtel-sms-service') {
        return { sendHubtelSMS: async (p: any) => { counters.sms.push(p.message); return { success: true } } }
    }
    if (request.startsWith('@/')) return originalLoad.apply(this, [path.join(REPO_ROOT, request.slice(2)), parent, isMain])
    return originalLoad.apply(this, [request, parent, isMain])
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { settleMemberUssdOrder, findMemberPayment } = require('@/lib/ussd-member-settle')

const REF = 'USSD-DATA-TEST-0001'
function seed(overrides: Row = {}, extraTables: Record<string, Row[]> = {}) {
    tables = {
        wallet_payments: [{
            id: 'wp1', user_id: 'u1', reference: REF, amount: 8, status: 'pending',
            metadata: {
                kind: 'ussd_member', channel: 'ussd', order_type: 'data', package_id: 'p1', type_id: null,
                item_name: 'MTN 1GB', recipient: '0241234567', payer_msisdn: '0241234567', session_id: 's1',
            },
            ...overrides,
        }],
        orders: [],
        results_checker_orders: [],
        ...extraTables,
    }
    counters.credits = 0; counters.dataBuys = 0; counters.rcBuys = 0; counters.sms = []; counters.rcArgs = []
    dataBuyResult = { ok: true }
}
const settle = async (amountPaid = 8) => {
    const payment = await findMemberPayment(db, REF)
    return settleMemberUssdOrder(db, { payment, reference: REF, amountPaid })
}

let passed = 0
let failed = 0
function check(name: string, ok: boolean, detail = '') {
    if (ok) { console.log(`  PASS  ${name}`); passed++ } else { console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ''}`); failed++ }
}
const quiet = console.error
const state = () => JSON.stringify({ ...counters, row: tables.wallet_payments?.[0]?.status })

async function main() {
    console.error = () => {}
    console.log = ((orig) => (...a: any[]) => { if (typeof a[0] === 'string' && a[0].startsWith('[UssdMember]')) return; orig(...a) })(console.log)

    // Normal settlement.
    failClaimQuery = false
    seed()
    let r = await settle()
    check('settlement credits the wallet once and buys once', r.success && counters.credits === 1 && counters.dataBuys === 1 && counters.sms.length === 0, state())
    check('  …and the row STILL identifies as a member order afterwards (metadata not wiped)',
        (await findMemberPayment(db, REF)) !== null && tables.wallet_payments[0].metadata.package_id === 'p1', JSON.stringify(tables.wallet_payments[0].metadata))

    // Webhook retry after success.
    r = await settle()
    check('a repeat delivery after success buys nothing more', r.success && counters.credits === 1 && counters.dataBuys === 1, state())

    // Webhook and sweep together.
    seed()
    const [a, b] = await Promise.all([settle(), settle()])
    check('two simultaneous settlements buy ONCE and credit ONCE', a.success && b.success && counters.dataBuys === 1 && counters.credits === 1 && counters.sms.length === 0, state())

    // Purchase fails after the credit.
    seed(); dataBuyResult = { ok: false, error: 'Package not found' }
    r = await settle()
    check('a failed purchase keeps the money in the wallet and tells the member (one SMS)',
        r.success && r.creditedOnly === true && counters.credits === 1 && counters.sms.length === 1 && /safe in your ARHMS wallet/.test(counters.sms[0]), state())
    check('  …the SMS is ASCII and fits one message', /^[\x20-\x7E]+$/.test(counters.sms[0]) && counters.sms[0].length <= 160, `${counters.sms[0].length} chars`)
    r = await settle()
    check('  …a webhook retry does not buy again or text a second time', counters.dataBuys === 1 && counters.sms.length === 1, state())

    // A "failure" that is really a lost race.
    seed({}, { orders: [{ id: 'oX', reference_code: REF, status: 'pending' }] })
    dataBuyResult = { ok: false, error: 'Failed to create order' }
    r = await settle()
    check('a failure when the order already exists is a lost race: success, no SMS', r.success && !r.creditedOnly && counters.sms.length === 0, state())

    // The claim query failing must not strand a paid order, nor wipe the order off the row.
    // (When the claim succeeds it rewrites the whole metadata, which would hide a credit
    // step that overwrote it — so this is the case that pins the credit step itself.)
    seed(); failClaimQuery = true
    r = await settle()
    check('if the claim query errors the order is still bought, once', r.success && counters.dataBuys === 1 && counters.credits === 1, state())
    check('  …and the row still identifies as a member order (credit step must not wipe metadata)',
        (await findMemberPayment(db, REF)) !== null && tables.wallet_payments[0].metadata.package_id === 'p1',
        JSON.stringify(tables.wallet_payments[0].metadata))
    failClaimQuery = false

    // Underpayment.
    seed()
    r = await settle(5)
    check('an underpayment credits nothing and buys nothing', !r.success && counters.credits === 0 && counters.dataBuys === 0, state())

    // Claims.
    seed({ status: 'completed', metadata: { ...tables.wallet_payments?.[0]?.metadata, kind: 'ussd_member', order_type: 'data', package_id: 'p1', recipient: '0241234567', purchase_claimed_at: new Date(Date.now() - 10_000).toISOString() } })
    r = await settle()
    check('a fresh claim (10s old) is respected — no second attempt', r.success && counters.dataBuys === 0, state())

    seed({ status: 'completed', metadata: { kind: 'ussd_member', order_type: 'data', package_id: 'p1', recipient: '0241234567', purchase_claimed_at: new Date(Date.now() - 10 * 60_000).toISOString() } })
    r = await settle()
    check('a stale claim (10 min old, the settler died) is retaken and the order is placed', r.success && counters.dataBuys === 1, state())

    // Result checker routing.
    seed({ metadata: { kind: 'ussd_member', order_type: 'rc', type_id: 't1', item_name: 'BECE', recipient: '0241234567', payer_msisdn: '0241234567', session_id: 's1' } },
        { users: [{ id: 'u1', role: 'agent', first_name: 'Ama', email: 'a@x.com' }], sub_agents: [] })
    ;(tables as any).users = [{ id: 'u1', role: 'agent', first_name: 'Ama', email: 'a@x.com' }]
    // the stub db has no users/sub_agents readers beyond maybeSingle on arrays
    r = await settle()
    check('a result-checker order buys through the wallet checker purchase, keyed on the USSD reference',
        r.success && counters.rcBuys === 1 && counters.rcArgs[0]?.typeId === 't1' && counters.rcArgs[0]?.referenceCode === REF && counters.rcArgs[0]?.quantity === 1,
        state() + ' ' + JSON.stringify(counters.rcArgs[0]))

    // A plain wallet top-up is not a member order.
    seed({ metadata: { kind: 'wallet_topup' } })
    check('an ordinary top-up is not mistaken for a member order', (await findMemberPayment(db, REF)) === null)

    console.error = quiet
    console.log(`\n${passed} passed, ${failed} failed`)
    process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
