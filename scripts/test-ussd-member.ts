/**
 * Test: USSD for registered users — no short code, their own prices
 *
 * Drives the real POST handler of app/api/hubtel/interact with an in-memory Supabase,
 * stubbed waitUntil and a stubbed Paystack, and pins what matters:
 *
 *   - a number that belongs to an account is NEVER asked for a short code;
 *   - a number that does not is asked, exactly as before;
 *   - anything that stops us recognising the caller (slow lookup, kill switch, Hubtel
 *     rollback rail, a number shared by two accounts, a suspended account) falls back
 *     to the short-code screen instead of a dropped call;
 *   - the member's menu quotes THEIR price (an agent's, not the customer's);
 *   - confirming records the order as a pending wallet payment BEFORE the charge goes
 *     out, carrying everything settlement needs.
 *
 * No network, no database.
 *
 * Run (CommonJS is required for the require() hook below):
 *
 *   TS_NODE_COMPILER_OPTIONS='{"module":"commonjs","moduleResolution":"node"}' \
 *     npx ts-node --transpile-only scripts/test-ussd-member.ts
 *
 * Exit code: 0 = all pass, 1 = any fail
 */
import Module from 'module'
import path from 'path'

const REPO_ROOT = path.resolve(__dirname, '..')
process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://stub.local'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'stub'
process.env.PAYSTACK_SECRET_KEY = 'sk_test_stub'

// ── In-memory Supabase ──────────────────────────────────────────────────────────
type Row = Record<string, any>
let tables: Record<string, Row[]> = {}
let delays: Record<string, number> = {}

function builder(table: string) {
    const q: any = { op: 'select', filters: [] as Array<(r: Row) => boolean>, payload: null, limit: Infinity, order: null }
    const run = async () => {
        if (delays[table]) await new Promise((r) => setTimeout(r, delays[table]))
        const rows = (tables[table] = tables[table] || [])
        const matched = rows.filter((r) => q.filters.every((f: any) => f(r)))
        if (q.op === 'insert') { const added = [].concat(q.payload).map((p: any) => ({ ...p })); rows.push(...added); return { data: added, error: null } }
        if (q.op === 'upsert') {
            const p = { ...q.payload }
            const key = table === 'hubtel_sessions' ? 'session_id' : 'id'
            const at = rows.findIndex((r) => r[key] === p[key])
            if (at >= 0) rows[at] = { ...rows[at], ...p }; else rows.push(p)
            return { data: [p], error: null }
        }
        if (q.op === 'update') { matched.forEach((r) => Object.assign(r, q.payload)); return { data: matched, error: null } }
        if (q.op === 'delete') { tables[table] = rows.filter((r) => !matched.includes(r)); return { data: matched, error: null } }
        let out = matched.slice(0, q.limit)
        if (q.order) out = out.slice().sort((a, b) => (a[q.order] > b[q.order] ? 1 : -1))
        return { data: out, error: null }
    }
    const api: any = {
        select() { return api },
        insert(p: any) { q.op = 'insert'; q.payload = p; return api },
        upsert(p: any) { q.op = 'upsert'; q.payload = p; return api },
        update(p: any) { q.op = 'update'; q.payload = p; return api },
        delete() { q.op = 'delete'; return api },
        eq(c: string, v: any) { q.filters.push((r: Row) => r[c] === v); return api },
        in(c: string, vs: any[]) { q.filters.push((r: Row) => vs.includes(r[c])); return api },
        not() { return api },
        is(c: string, v: any) { q.filters.push((r: Row) => (r[c] ?? null) === v); return api },
        order(c: string) { q.order = c; return api },
        limit(n: number) { q.limit = n; return api },
        single: async () => { const r = await run(); const row = r.data[0]; return row ? { data: row, error: null } : { data: null, error: { code: 'PGRST116' } } },
        maybeSingle: async () => { const r = await run(); return { data: r.data[0] ?? null, error: null } },
        then(res: any, rej: any) { return run().then(res, rej) },
    }
    return api
}
const stubDb = { from: (t: string) => builder(t), rpc: async () => ({ data: null, error: null }) }

// ── Module hooks ────────────────────────────────────────────────────────────────
const background: Promise<unknown>[] = []
const chargeCalls: any[] = []
const originalLoad = (Module as any)._load
;(Module as any)._load = function (request: string, parent: unknown, isMain: boolean) {
    if (request === '@supabase/supabase-js') return { createClient: () => stubDb }
    if (request === '@vercel/functions') return { waitUntil: (p: Promise<unknown>) => { background.push(p) } }
    if (request.startsWith('@/')) return originalLoad.apply(this, [path.join(REPO_ROOT, request.slice(2)), parent, isMain])
    return originalLoad.apply(this, [request, parent, isMain])
}
// Paystack: every charge is accepted as pending. Anything else is not expected here.
;(globalThis as any).fetch = async (url: string, init: any) => {
    chargeCalls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null })
    return new Response(JSON.stringify({ status: true, message: 'ok', data: { status: 'pay_offline', reference: 'x', display_text: 'Approve' } }), { status: 200 })
}

// ── Fixtures ────────────────────────────────────────────────────────────────────
const MEMBER_PHONE = '233241234567'
const USERS = {
    ama: { id: 'u-ama', first_name: 'Ama', phone_number: '0241234567', role: 'agent', status: 'active' },
    twin1: { id: 'u-t1', first_name: 'T1', phone_number: '0201111111', role: 'customer', status: 'active' },
    twin2: { id: 'u-t2', first_name: 'T2', phone_number: '+233201111111', role: 'customer', status: 'active' },
    frozen: { id: 'u-fz', first_name: 'Fz', phone_number: '0551111111', role: 'customer', status: 'suspended' },
}
function seed(extra: Record<string, Row[]> = {}, settings: Row[] = []) {
    tables = {
        admin_settings: [{ key: 'ussd_enabled', value: 'true' }, ...settings],
        hubtel_sessions: [],
        users: Object.values(USERS).map((u) => ({ ...u })),
        sub_agents: [],
        wallets: [{ id: 'w-ama', user_id: 'u-ama' }],
        wallet_payments: [],
        data_packages: [
            { id: 'p1', network: 'MTN', size: '1GB', price: 10, agent_price: 8, dealer_price: 7, is_available: true, sort_order: 1 },
            { id: 'p2', network: 'MTN', size: '2GB', price: 20, agent_price: 16, dealer_price: 14, is_available: true, sort_order: 2 },
        ],
        results_checker_types: [
            { id: 't1', name: 'BECE', customer_price: 20, agent_price: 18, dealer_price: 17, cost_price: 7, is_active: true, display_order: 1, bulk_pricing: [] },
        ],
        ...extra,
    }
    delays = {}
    chargeCalls.length = 0
}

function loadRoute() {
    const p = require.resolve(path.join(REPO_ROOT, 'app/api/hubtel/interact/route.ts'))
    delete require.cache[p] // the route memoizes its flags per instance
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require(p) as { POST: (req: Request) => Promise<Response> }
}

async function call(route: ReturnType<typeof loadRoute>, body: Record<string, unknown>) {
    const res = await route.POST(new Request('http://x', { method: 'POST', body: JSON.stringify({ Operator: 'mtn', ...body }) }))
    const json: any = await res.json()
    await Promise.allSettled(background.splice(0).filter(Boolean).map((p) => Promise.race([p, new Promise((r) => setTimeout(r, 50))])))
    return json
}

let passed = 0
let failed = 0
function check(name: string, ok: boolean, detail = '') {
    if (ok) { console.log(`  PASS  ${name}`); passed++ } else { console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ''}`); failed++ }
}
const init = (route: any, mobile: string, sid: string) => call(route, { Type: 'Initiation', SessionId: sid, Mobile: mobile })
const say = (route: any, mobile: string, sid: string, text: string) => call(route, { Type: 'Response', SessionId: sid, Mobile: mobile, Message: text })

async function main() {
    // ── Who gets the short-code screen ──────────────────────────────────────────
    seed()
    let r = loadRoute()
    let out = await init(r, MEMBER_PHONE, 's1')
    check('registered number skips the short code', /^Welcome back Ama/.test(out.Message) && !/short code/i.test(out.Message), out.Message)
    check('  …and lands on the service menu with data + checker', /1\. Data Bundles/.test(out.Message) && /2\. Result Checker/.test(out.Message))
    const session = tables.hubtel_sessions.find((s) => s.session_id === 's1')
    check('  …and the session is stored as a member at choose_service',
        session?.current_step === 'choose_service' && session?.data?.mode === 'member' && session?.data?.member?.userId === 'u-ama',
        JSON.stringify(session))

    seed(); r = loadRoute()
    out = await init(r, '233209999999', 's2')
    check('unknown number is asked for a short code', /short code/i.test(out.Message), out.Message)

    seed(); r = loadRoute()
    out = await init(r, '0241234567', 's3')
    check('local 0XXXXXXXXX dial-in format is recognised too', /^Welcome back Ama/.test(out.Message), out.Message)

    seed(); r = loadRoute()
    out = await init(r, '233201111111', 's4')
    check('a number shared by two accounts is not guessed — short code', /short code/i.test(out.Message), out.Message)

    seed(); r = loadRoute()
    out = await init(r, '233551111111', 's5')
    check('a suspended account gets the short-code screen', /short code/i.test(out.Message), out.Message)

    seed(); delays = { users: 2500 }; r = loadRoute()
    const t0 = Date.now()
    out = await init(r, MEMBER_PHONE, 's6')
    const took = Date.now() - t0
    check('a slow account lookup falls back to the short code within ~1.5s', /short code/i.test(out.Message) && took < 2200, `${took}ms: ${out.Message}`)

    seed({}, [{ key: 'ussd_member_skip_code', value: 'false' }]); r = loadRoute()
    out = await init(r, MEMBER_PHONE, 's7')
    check("kill switch ussd_member_skip_code='false' brings the short code back", /short code/i.test(out.Message), out.Message)

    seed({}, [{ key: 'active_payment_provider_ussd', value: 'hubtel' }]); r = loadRoute()
    out = await init(r, MEMBER_PHONE, 's8')
    check('the Hubtel rollback rail never skips the short code (wallet settlement is Paystack-only)', /short code/i.test(out.Message), out.Message)

    // ── Prices and the order ────────────────────────────────────────────────────
    seed(); r = loadRoute()
    await init(r, MEMBER_PHONE, 's9')
    out = await say(r, MEMBER_PHONE, 's9', '1')
    check('member picks Data → network list (MTN)', /Select Network/.test(out.Message) && /1\. MTN/.test(out.Message), out.Message)
    out = await say(r, MEMBER_PHONE, 's9', '1')
    check("bundle menu quotes the AGENT's price (8 and 16), not the customer's 10 and 20",
        /1GB - GHS 8\n/.test(out.Message) && /2GB - GHS 16\n/.test(out.Message), out.Message)

    out = await say(r, MEMBER_PHONE, 's9', '1')
    check('choosing a bundle asks for the recipient', /Enter recipient number/.test(out.Message), out.Message)
    out = await say(r, MEMBER_PHONE, 's9', '1') // 1 = own number
    check('recipient step reaches the confirm screen at the agent price', /Confirm Order/.test(out.Message) && /GHS 8\n/.test(out.Message), out.Message)

    out = await say(r, MEMBER_PHONE, 's9', '1') // confirm
    const pay = tables.wallet_payments[0]
    check('confirm records ONE pending wallet payment for the member',
        tables.wallet_payments.length === 1 && pay.user_id === 'u-ama' && pay.wallet_id === 'w-ama' && pay.status === 'pending',
        JSON.stringify(tables.wallet_payments))
    check('  …under the USSD reference, on the Paystack MoMo rail, for the agent price',
        /^USSD-DATA-/.test(pay?.reference) && pay?.provider === 'paystack_momo' && Number(pay?.amount) === 8, JSON.stringify(pay))
    check('  …carrying the order, so settlement works after the session is gone',
        pay?.metadata?.kind === 'ussd_member' && pay.metadata.order_type === 'data' && pay.metadata.package_id === 'p1'
        && pay.metadata.recipient === '0241234567' && pay.metadata.session_id === 's9', JSON.stringify(pay?.metadata))
    check('  …and the caller is told a MoMo prompt is coming', /MoMo prompt/.test(out.Message), out.Message)

    // ── Result checkers ─────────────────────────────────────────────────────────
    seed(); r = loadRoute()
    await init(r, MEMBER_PHONE, 's10')
    out = await say(r, MEMBER_PHONE, 's10', '2')
    check("member's checker list uses their role price (agent 18, not customer 20)", /BECE \(18 GHS\)/.test(out.Message), out.Message)

    // ── A non-member is unchanged ───────────────────────────────────────────────
    seed({ shop_profiles: [{ id: 'sh1', shop_name: 'Kofi Store', owner_id: 'u-kofi', ussd_code: 'KOFI', ussd_status: 'active', approval_status: 'approved', is_active: true }] })
    r = loadRoute()
    await init(r, '233209999999', 's11')
    out = await say(r, '233209999999', 's11', 'kofi')
    check('a non-member still enters a shop code and gets that shop menu', /Welcome to Kofi Store/.test(out.Message), out.Message)

    console.log(`\n${passed} passed, ${failed} failed`)
    process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
