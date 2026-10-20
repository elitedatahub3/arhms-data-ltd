/**
 * Test: buying airtime through the USSD menu (app/api/hubtel/interact, lib/ussd-airtime.ts)
 *
 * Drives the real POST handler as a registered (main-site) user, with an in-memory Supabase and a
 * stubbed Paystack. Pins:
 *
 *   - Airtime is listed for main-site users only — never for a shop's menu, never for a stranger —
 *     and switches off with ussd_airtime_enabled='false';
 *   - the network is read off the number (MTN, Telecel, AirtelTigo -> "AT", including 098 on MTN),
 *     and "1" means the caller's own number;
 *   - the beneficiary receives EXACTLY the amount typed and the fee goes on top, at the agent or
 *     customer rate from the website's own settings, inside the website's minimum and maximum;
 *   - confirming records one pending payment in the shape processAirtimeDirectOrder reads, then
 *     charges exactly the total under the same USSD-AIR- reference;
 *   - a fee changed between the total being shown and confirming is refused — nothing is charged.
 *
 * No network, no database.
 *
 * Run (CommonJS is required for the require() hook below):
 *
 *   TS_NODE_COMPILER_OPTIONS='{"module":"commonjs","moduleResolution":"node"}' \
 *     npx ts-node --transpile-only scripts/test-ussd-airtime.ts
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

type Row = Record<string, any>
let tables: Record<string, Row[]> = {}

function builder(table: string) {
    const q: any = { op: 'select', filters: [] as Array<(r: Row) => boolean>, payload: null, limit: Infinity }
    const run = async () => {
        const rows = (tables[table] = tables[table] || [])
        const matched = rows.filter((r) => q.filters.every((f: any) => f(r)))
        if (q.op === 'insert') {
            const added = [].concat(q.payload).map((p: any, i: number) => ({ id: `${table}-${rows.length + i + 1}`, ...p }))
            rows.push(...added)
            return { data: added, error: null }
        }
        if (q.op === 'upsert') {
            const p = { ...q.payload }
            const key = table === 'hubtel_sessions' ? 'session_id' : 'id'
            const at = rows.findIndex((r) => r[key] === p[key])
            if (at >= 0) rows[at] = { ...rows[at], ...p }; else rows.push(p)
            return { data: [p], error: null }
        }
        if (q.op === 'update') { matched.forEach((r) => Object.assign(r, q.payload)); return { data: matched, error: null } }
        if (q.op === 'delete') { tables[table] = rows.filter((r) => !matched.includes(r)); return { data: matched, error: null } }
        return { data: matched.slice(0, q.limit), error: null }
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
        order() { return api },
        limit(n: number) { q.limit = n; return api },
        single: async () => { const r = await run(); const row = r.data[0]; return row ? { data: row, error: null } : { data: null, error: { code: 'PGRST116' } } },
        maybeSingle: async () => { const r = await run(); return { data: r.data[0] ?? null, error: null } },
        then(res: any, rej: any) { return run().then(res, rej) },
    }
    return api
}
const stubDb = { from: (t: string) => builder(t), rpc: async () => ({ data: null, error: null }) }

const background: Promise<unknown>[] = []
const chargeCalls: any[] = []
const originalLoad = (Module as any)._load
;(Module as any)._load = function (request: string, parent: unknown, isMain: boolean) {
    if (request === '@supabase/supabase-js') return { createClient: () => stubDb }
    if (request === '@vercel/functions') return { waitUntil: (p: Promise<unknown>) => { background.push(p) } }
    if (request.startsWith('@/')) return originalLoad.apply(this, [path.join(REPO_ROOT, request.slice(2)), parent, isMain])
    return originalLoad.apply(this, [request, parent, isMain])
}
;(globalThis as any).fetch = async (url: string, init: any) => {
    chargeCalls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null })
    return new Response(JSON.stringify({ status: true, message: 'ok', data: { status: 'pay_offline', reference: 'x', display_text: 'Approve' } }), { status: 200 })
}

// ── Fixtures ────────────────────────────────────────────────────────────────────
const AMA = '233201234567'      // an AGENT (fee 3%) on Telecel, so her charge is made inside the session
const BEA = '233551234567'      // a CUSTOMER (fee 5%), no wallet yet
function seed(settings: Row[] = []) {
    tables = {
        admin_settings: [
            { key: 'ussd_enabled', value: 'true' },
            { key: 'airtime_fee_mtn_customer', value: '5' }, { key: 'airtime_fee_mtn_agent', value: '3' },
            { key: 'airtime_fee_telecel_customer', value: '5' }, { key: 'airtime_fee_telecel_agent', value: '3' },
            { key: 'airtime_fee_at_customer', value: '5' }, { key: 'airtime_fee_at_agent', value: '3' },
            { key: 'airtime_min_amount', value: '1' }, { key: 'airtime_max_amount', value: '500' },
            { key: 'airtime_enabled_mtn', value: 'true' }, { key: 'airtime_enabled_telecel', value: 'true' }, { key: 'airtime_enabled_at', value: 'true' },
            ...settings,
        ],
        hubtel_sessions: [],
        users: [
            { id: 'u-ama', first_name: 'Ama', phone_number: '0201234567', role: 'agent', status: 'active' },
            { id: 'u-bea', first_name: 'Bea', phone_number: '0551234567', role: 'customer', status: 'active' },
        ],
        sub_agents: [],
        wallets: [{ id: 'w-ama', user_id: 'u-ama' }],
        wallet_payments: [],
        shop_profiles: [{ id: 'sh1', shop_name: 'Kofi Store', owner_id: 'u-kofi', ussd_code: 'KOFI', ussd_status: 'active', approval_status: 'approved', is_active: true, utilities_enabled: true }],
        data_packages: [], results_checker_types: [], shop_afa_pricing: [],
    }
    chargeCalls.length = 0
}
function loadRoute() {
    const p = require.resolve(path.join(REPO_ROOT, 'app/api/hubtel/interact/route.ts'))
    delete require.cache[p]
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require(p) as { POST: (req: Request) => Promise<Response> }
}
async function call(route: ReturnType<typeof loadRoute>, body: Record<string, unknown>) {
    const res = await route.POST(new Request('https://arhmsgh.test/api/hubtel/interact', { method: 'POST', body: JSON.stringify(body) }))
    const json: any = await res.json()
    await Promise.allSettled(background.splice(0).filter(Boolean).map((p) => Promise.race([p, new Promise((r) => setTimeout(r, 50))])))
    return json
}
const dial = (r: any, mobile: string, sid: string) => call(r, { Type: 'Initiation', SessionId: sid, Mobile: mobile, Operator: 'telecel' })
const say = (r: any, mobile: string, sid: string, text: string) => call(r, { Type: 'Response', SessionId: sid, Mobile: mobile, Message: text, Operator: 'telecel' })

let passed = 0
let failed = 0
function check(name: string, ok: boolean, detail = '') {
    if (ok) { console.log(`  PASS  ${name}`); passed++ } else { console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ''}`); failed++ }
}

/** Dial in, pick Buy Airtime (4 on a main-site menu that also lists AFA), and enter `phone`. */
async function toAmount(r: any, mobile: string, sid: string, phone: string) {
    await dial(r, mobile, sid)
    await say(r, mobile, sid, '4')
    return say(r, mobile, sid, phone)
}

async function main() {
    console.error = () => {}
    console.warn = () => {}

    // ── Listing ─────────────────────────────────────────────────────────────────
    seed(); let r = loadRoute()
    let out = await dial(r, AMA, 'l1')
    check('a main-site user sees Buy Airtime after AFA', out.Message.startsWith('Welcome to ARHMSTECH\nChoose a Service:\n1. Data Bundles\n2. Waec Results Checker\n3. AFA Registration\n4. Buy Airtime'), JSON.stringify(out.Message))

    seed([{ key: 'ussd_airtime_enabled', value: 'false' }]); r = loadRoute()
    out = await dial(r, AMA, 'l2')
    check("the kill switch ussd_airtime_enabled='false' takes it off", !/Airtime/.test(out.Message), out.Message)

    seed([{ key: 'ussd_afa_enabled', value: 'false' }]); r = loadRoute()
    out = await dial(r, AMA, 'l3')
    check('with AFA off, Buy Airtime moves up to 3', /3\. Buy Airtime/.test(out.Message) && !/AFA/.test(out.Message), out.Message)

    seed([{ key: 'storefront_afa_enabled', value: 'true' }]); r = loadRoute()
    await dial(r, '233209999999', 'l4')
    out = await say(r, '233209999999', 'l4', 'kofi')
    check("a shop's menu never lists airtime", !/Airtime/.test(out.Message) && /Welcome to Kofi Store/.test(out.Message), out.Message)

    seed(); r = loadRoute()
    out = await dial(r, '233209999999', 'l5')
    check('a stranger is asked for a short code, not offered airtime', /short code/i.test(out.Message) && !/Airtime/.test(out.Message), out.Message)

    // ── The number and its network ──────────────────────────────────────────────
    seed(); r = loadRoute()
    out = await toAmount(r, AMA, 'n1', '1')
    check('"1" is the caller\'s own number, and its network is read off it (Telecel)', /^Telecel 0201234567\nEnter airtime amount/.test(out.Message), out.Message)

    for (const [phone, want] of [['0241234567', 'MTN'], ['0981234567', 'MTN'], ['0271234567', 'AT'], ['0561234567', 'AT'], ['233501234567', 'Telecel']] as const) {
        seed(); r = loadRoute()
        out = await toAmount(r, AMA, `n-${phone}`, phone)
        check(`${phone} is ${want}`, new RegExp(`^${want} 0\\d{9}\\nEnter airtime amount`).test(out.Message), out.Message)
    }

    seed(); r = loadRoute()
    out = await toAmount(r, AMA, 'n2', '0121234567')
    check('a number that is not a Ghana mobile is refused and re-asked', /Invalid number/.test(out.Message) && /number to top up/i.test(out.Message), out.Message)
    out = await say(r, AMA, 'n2', '024123')
    check('a short number is refused', /Invalid number/.test(out.Message), out.Message)

    // ── The amount and the fee ──────────────────────────────────────────────────
    seed(); r = loadRoute()
    await toAmount(r, AMA, 'a1', '0241234567')
    out = await say(r, AMA, 'a1', 'abc')
    check('a non-number amount is refused', /Enter an amount/.test(out.Message), out.Message)
    out = await say(r, AMA, 'a1', '10.567')
    check('more than two decimals is refused', /Enter an amount/.test(out.Message), out.Message)
    out = await say(r, AMA, 'a1', '0.5')
    check('under the minimum is refused with the limit, and re-asked', /Minimum is GHS 1\.00/.test(out.Message) && /airtime amount/i.test(out.Message), out.Message)
    out = await say(r, AMA, 'a1', '600')
    check('over the maximum is refused with the limit', /Maximum is GHS 500\.00/.test(out.Message), out.Message)

    out = await say(r, AMA, 'a1', '10')
    check('an AGENT pays the agent fee (3% of 10 = 0.30): beneficiary gets exactly 10, total 10.30',
        /Confirm Airtime/.test(out.Message) && /MTN 0241234567/.test(out.Message) && /Airtime GHS 10\n/.test(out.Message) && /Fee GHS 0\.3\n/.test(out.Message) && /Total GHS 10\.3\n/.test(out.Message), out.Message)
    check('  …and the confirm screen fits one screen', out.Message.length <= 160, `${out.Message.length}`)

    seed(); r = loadRoute()
    await toAmount(r, BEA, 'a2', '1')
    out = await say(r, BEA, 'a2', '10')
    check('a CUSTOMER pays the customer fee (5% of 10 = 0.50): total 10.50', /Fee GHS 0\.5\n/.test(out.Message) && /Total GHS 10\.5\n/.test(out.Message), out.Message)

    seed([{ key: 'airtime_min_amount', value: '0.2' }]); r = loadRoute()
    await toAmount(r, AMA, 'a3', '0241234567')
    out = await say(r, AMA, 'a3', '0.5')
    check('an admin minimum below the provider\'s GHS 1 is raised to GHS 1 (it would be refused after payment)', /Minimum is GHS 1\.00/.test(out.Message), out.Message)

    seed([{ key: 'airtime_enabled_mtn', value: 'false' }]); r = loadRoute()
    await toAmount(r, AMA, 'a4', '0241234567')
    out = await say(r, AMA, 'a4', '10')
    check('a network the admin switched off is refused', /MTN airtime is unavailable/.test(out.Message), out.Message)

    seed(); r = loadRoute()
    await toAmount(r, AMA, 'a5', '0241234567')
    out = await say(r, AMA, 'a5', '2.5')
    check('decimal amounts work (2.50 + 3% = 0.08 -> 2.58)', /Airtime GHS 2\.5\n/.test(out.Message) && /Fee GHS 0\.08\n/.test(out.Message) && /Total GHS 2\.58\n/.test(out.Message), out.Message)

    out = await say(r, AMA, 'a5', '0')
    check('0 at the confirm screen cancels, with nothing charged', /cancelled/i.test(out.Message) && chargeCalls.length === 0 && tables.wallet_payments.length === 0, out.Message)

    seed(); r = loadRoute()
    await toAmount(r, AMA, 'b1', '0241234567')
    out = await say(r, AMA, 'b1', '0')
    check('0 at the amount returns to the number', /number to top up/i.test(out.Message), out.Message)

    // ── Confirming ──────────────────────────────────────────────────────────────
    seed(); r = loadRoute()
    await toAmount(r, AMA, 'c1', '0241234567')
    await say(r, AMA, 'c1', '10')
    out = await say(r, AMA, 'c1', '1')
    const pay = tables.wallet_payments[0]
    check('confirm records ONE pending payment of exactly the total, for the member, under a USSD-AIR- reference',
        tables.wallet_payments.length === 1 && pay.user_id === 'u-ama' && pay.wallet_id === 'w-ama' && pay.status === 'pending'
        && pay.amount === 10.3 && pay.total_amount === 10.3 && pay.fee === 0 && pay.provider === 'paystack_momo' && /^USSD-AIR-/.test(pay.reference), JSON.stringify(pay))
    check('  …in the shape processAirtimeDirectOrder reads (what /api/airtime/gateway-init writes)',
        pay?.metadata.kind === 'airtime_order' && pay.metadata.beneficiary_phone === '0241234567' && pay.metadata.network === 'MTN'
        && pay.metadata.airtime_amount === 10 && pay.metadata.fee_rate === 3 && pay.metadata.fee_amount === 0.3 && pay.metadata.use_exact_amount === true
        && pay.metadata.type === 'airtime' && pay.metadata.role === 'agent' && pay.metadata.user_id === 'u-ama', JSON.stringify(pay?.metadata))
    check('  …tagged as USSD, with the payer to text', pay?.metadata.channel === 'ussd' && pay.metadata.session_id === 'c1' && pay.metadata.payer_msisdn === '0201234567', JSON.stringify(pay?.metadata))
    const charge = chargeCalls.find((c) => c.body?.reference)
    check('  …then charges exactly GHS 10.30 under the same reference, tagged as airtime',
        !!charge && charge.body.reference === pay.reference && Number(charge.body.amount) === 1030 && charge.body.metadata.order_type === 'air', JSON.stringify(charge?.body))

    seed(); r = loadRoute()
    await toAmount(r, BEA, 'c2', '1')
    await say(r, BEA, 'c2', '10'); await say(r, BEA, 'c2', '1')
    check('a member with no wallet gets one', tables.wallets.some((w) => w.user_id === 'u-bea') && tables.wallet_payments[0]?.wallet_id === tables.wallets.find((w) => w.user_id === 'u-bea')?.id, JSON.stringify(tables.wallets))

    // The price moves between the screen and the confirm.
    seed(); r = loadRoute()
    await toAmount(r, AMA, 'd1', '0241234567')
    await say(r, AMA, 'd1', '10')
    tables.admin_settings.find((s) => s.key === 'airtime_fee_mtn_agent')!.value = '4'
    out = await say(r, AMA, 'd1', '1')
    check('a fee changed after the total was shown is refused at confirm: nothing recorded, nothing charged',
        out.Type === 'Release' && tables.wallet_payments.length === 0 && chargeCalls.length === 0, JSON.stringify({ out, rows: tables.wallet_payments.length, charges: chargeCalls.length }))

    // Rollback rail.
    seed(); r = loadRoute()
    await toAmount(r, AMA, 'e1', '0241234567')
    await say(r, AMA, 'e1', '10')
    tables.admin_settings.push({ key: 'active_payment_provider_ussd', value: 'hubtel' })
    r = loadRoute()
    out = await say(r, AMA, 'e1', '1')
    check('a session at confirm when the admin moves USSD to the Hubtel rollback rail is refused, uncharged',
        out.Type === 'Release' && /unavailable/i.test(out.Message) && chargeCalls.length === 0 && tables.wallet_payments.length === 0, JSON.stringify(out))

    // A stale or half-built session must not reach the charge.
    seed(); r = loadRoute()
    tables.hubtel_sessions = [{ session_id: 'f1', mobile: AMA, current_step: 'confirm', data: { mode: 'member', member: { userId: 'u-ama', role: 'agent' }, orderType: 'air', selectedPrice: 10.3, itemName: 'MTN Airtime', operator: 'telecel', air: {} } }]
    out = await say(r, AMA, 'f1', '1')
    check('a session at confirm with no number to top up is refused, uncharged', out.Type === 'Release' && chargeCalls.length === 0 && tables.wallet_payments.length === 0, JSON.stringify(out))

    // The constant that keeps the edge copy honest.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const edge = require('@/lib/ussd-airtime')
    let real: number | null = null
    let importError = ''
    try { real = require('@/lib/kingflexy-airtime-service').MIN_DELIVERABLE_AIRTIME_GHS } catch (e: any) { importError = e?.message || String(e) }
    // Fails if the real constant cannot be read: comparing the edge copy to itself would prove nothing.
    check("the edge copy of the provider's minimum equals MIN_DELIVERABLE_AIRTIME_GHS", real !== null && edge.MIN_AIRTIME_GHS === real, `edge=${edge.MIN_AIRTIME_GHS} real=${real} ${importError}`)

    console.log(`\n${passed} passed, ${failed} failed`)
    process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => { process.stderr.write(`${e?.stack || e}\n`); process.exit(1) })
