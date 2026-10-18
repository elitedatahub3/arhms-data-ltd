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
const counters = { credits: 0, dataBuys: 0, rcBuys: 0, afaAlerts: 0, sms: [] as string[], rcArgs: [] as any[] }
/** Platform order confirmations: each call to sendPlatformOrderSms, and what its house fallback sent. */
const platformSms: Array<{ userId: any; isShopOrder: boolean; recipient: string; body: string; reference: string; houseSent?: string }> = []
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
        in(c: string, vs: any[]) { filters.push((r) => vs.includes(r[c])); return api },
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
/** What process_afa_order does in this test. */
let afaRpc: { error: null | { code?: string; message: string } } = { error: null }
const rpcCalls: Array<{ name: string; args: any }> = []
const db = {
    from: (t: string) => builder(t),
    rpc: async (name: string, args: any) => { await Promise.resolve(); rpcCalls.push({ name, args }); return { data: null, error: afaRpc.error } },
}

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
    if (request === '@/lib/afa/checkout') {
        return { notifyAdminsOfAfaApplication: async () => { counters.afaAlerts++ } }
    }
    if (request === '@/lib/sms-service') {
        return { sendSMS: async (p: any) => { counters.sms.push(p.message); return { success: true } } }
    }
    if (request === '@/lib/sms/platform-order-sms') {
        // Records the call, then takes the house fallback, which is what the real one does whenever the
        // buyer has not switched their own sender on. Its own-sender behaviour is tested in
        // scripts/test-ussd-confirmation-sms.ts.
        return {
            sendPlatformOrderSms: async (p: any) => {
                const entry: any = { userId: p.userId, isShopOrder: p.isShopOrder, recipient: p.recipient, body: p.body, reference: p.reference }
                platformSms.push(entry)
                const before = counters.sms.length
                await p.houseSend()
                entry.houseSent = counters.sms[before]
                counters.sms.length = before // keep `counters.sms` meaning "failure notices" only
            },
        }
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
    counters.credits = 0; counters.dataBuys = 0; counters.rcBuys = 0; counters.afaAlerts = 0; counters.sms = []; counters.rcArgs = []; platformSms.length = 0
    afaRpc = { error: null }; rpcCalls.length = 0
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

    // ── AFA registration for a registered user ─────────────────────────────────────
    const AFA_FORM = {
        full_name: 'Ama Boateng', id_number: 'GHA-123456789-0', date_of_birth: '1990-03-15',
        region: 'Ashanti', location: 'Kumasi', phone: '0241234567',
    }
    const afaMeta = { kind: 'ussd_member', channel: 'ussd', order_type: 'afa', item_name: 'AFA Registration', recipient: '0241234567', payer_msisdn: '0241234567', session_id: 's1', afa: AFA_FORM }
    const seedAfa = (over: Row = {}, extra: Record<string, Row[]> = {}) => seed(
        { amount: 25, metadata: afaMeta, ...over },
        {
            users: [{ id: 'u1', role: 'agent', is_api_user: false }],
            sub_agents: [],
            afa_orders: [],
            admin_settings: [
                { key: 'afa_price_customer', value: '30' }, { key: 'afa_price_agent', value: '25' }, { key: 'afa_price_dealer', value: '22' },
            ],
            ...extra,
        }
    )

    seedAfa()
    r = await settle(25)
    const call = rpcCalls[0]
    check('an AFA order is placed through process_afa_order at the role price',
        r.success && counters.credits === 1 && rpcCalls.length === 1 && call.name === 'process_afa_order' && call.args.p_user_id === 'u1'
        && Number(call.args.p_amount) === 25 && call.args.p_reference_code === REF, JSON.stringify({ r, rpcCalls }))
    check('  …with the applicant, a Ghana Card ID type and no notes',
        call?.args.p_form_data.full_name === 'Ama Boateng' && call.args.p_form_data.id_type === 'Ghana Card' && call.args.p_form_data.id_number === 'GHA-123456789-0'
        && call.args.p_form_data.date_of_birth === '1990-03-15' && call.args.p_form_data.region === 'Ashanti' && call.args.p_form_data.location === 'Kumasi'
        && call.args.p_form_data.phone === '0241234567' && call.args.p_form_data.notes === null, JSON.stringify(call?.args.p_form_data))
    check('  …the admins are alerted once and no failure SMS is sent', counters.afaAlerts === 1 && counters.sms.length === 0, JSON.stringify({ alerts: counters.afaAlerts, sms: counters.sms }))
    check('  …the applicant is confirmed through the PLATFORM rule (house sender, or the buyer own sender ID when switched on), for the member',
        platformSms.length === 1 && platformSms[0].userId === 'u1' && platformSms[0].isShopOrder === false && platformSms[0].recipient === '0241234567'
        && platformSms[0].reference === `afa:${REF}:received` && /AFA registration for Ama Boateng has been received/.test(platformSms[0].body), JSON.stringify(platformSms))
    const house = platformSms[0]?.houseSent || ''
    check('  …and the house fallback is the platform sender with its signature, ASCII, and not the buyer-sender text',
        house.startsWith('Your AFA registration for Ama Boateng') && house.endsWith('\n\nARHMSGh') && /^[\x20-\x7E\n]+$/.test(house), JSON.stringify(house))

    seedAfa()
    const [af1, af2] = await Promise.all([settle(25), settle(25)])
    check('two simultaneous AFA settlements place ONE order', af1.success && af2.success && rpcCalls.length === 1 && counters.credits === 1 && counters.sms.length === 0, JSON.stringify({ rpc: rpcCalls.length }))

    seedAfa(); afaRpc = { error: { code: '23505', message: 'duplicate key value violates unique constraint "afa_orders_reference_code_unique"' } }
    r = await settle(25)
    check('a duplicate-reference error from the database is a success, not a failure SMS, and no second confirmation', r.success && !r.creditedOnly && counters.sms.length === 0 && platformSms.length === 0, JSON.stringify(r))

    seedAfa({}, { afa_orders: [{ id: 'a1', reference_code: REF, status: 'pending' }] })
    r = await settle(25)
    check('an AFA order that already exists is not placed again, nor confirmed again', r.success && rpcCalls.length === 0 && counters.sms.length === 0 && platformSms.length === 0, JSON.stringify({ rpc: rpcCalls.length }))

    seedAfa(); afaRpc = { error: { message: 'INSUFFICIENT_BALANCE' } }
    r = await settle(25)
    check('an AFA order the wallet cannot cover keeps the money and tells the member (one SMS)', r.success && r.creditedOnly === true && counters.sms.length === 1 && counters.afaAlerts === 0 && platformSms.length === 0, JSON.stringify({ r, sms: counters.sms.length }))

    seedAfa({}, { sub_agents: [{ id: 'm1', user_id: 'u1', upline_shop_id: 'sh1' }] })
    r = await settle(25)
    check('a sub-agent is refused (their RPC is not installed): money kept, one SMS, no order', r.creditedOnly === true && rpcCalls.length === 0 && counters.sms.length === 1 && platformSms.length === 0, JSON.stringify({ r, rpc: rpcCalls.length }))

    seedAfa({}, { admin_settings: [{ key: 'afa_price_customer', value: '30' }, { key: 'afa_price_agent', value: '30' }, { key: 'afa_price_dealer', value: '22' }] })
    r = await settle(25)
    check('if the price rose above what was paid, nothing is charged silently: money kept, one SMS', r.creditedOnly === true && rpcCalls.length === 0 && counters.sms.length === 1 && platformSms.length === 0 && /price changed/.test(r.error || ''), JSON.stringify({ r }))

    seedAfa({ metadata: { ...afaMeta, afa: null } })
    r = await settle(25)
    check('a payment whose applicant details were lost is not guessed at', r.creditedOnly === true && rpcCalls.length === 0 && counters.sms.length === 1, JSON.stringify({ r }))

    // A plain wallet top-up is not a member order.
    seed({ metadata: { kind: 'wallet_topup' } })
    check('an ordinary top-up is not mistaken for a member order', (await findMemberPayment(db, REF)) === null)

    console.error = quiet
    console.log(`\n${passed} passed, ${failed} failed`)
    process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
