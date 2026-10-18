/**
 * Test: paying utility bills through the USSD menu (app/api/hubtel/interact)
 *
 * Drives the real POST handler through the whole conversation with an in-memory Supabase, a
 * stubbed Paystack, and a stubbed Node-side bill service (/api/ussd/utilities — tested on its
 * own in test-ussd-utilities-server.ts). Pins:
 *
 *   - bills are OFF the menu unless the admin has switched them on, the website has launched
 *     them, the shop accepts them and the Hubtel rollback rail is not in use;
 *   - menu numbering follows what is actually on offer (3 = Utilities when there is no AFA,
 *     4 when there is), and the number typed is read back through the same list;
 *   - ECG asks for the linked phone, the TV bills do not; Ghana Water is not offered;
 *   - the price and account holder shown on the confirm screen are the server's, and the
 *     charge is exactly that total;
 *   - nothing is charged unless the payment record was made first;
 *   - wrong accounts are re-asked (three strikes ends the session), amounts are re-asked,
 *     and an unreachable bill service never charges anyone.
 *
 * No network, no database.
 *
 * Run (CommonJS is required for the require() hook below):
 *
 *   TS_NODE_COMPILER_OPTIONS='{"module":"commonjs","moduleResolution":"node"}' \
 *     npx ts-node --transpile-only scripts/test-ussd-utilities.ts
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
const originalLoad = (Module as any)._load
;(Module as any)._load = function (request: string, parent: unknown, isMain: boolean) {
    if (request === '@supabase/supabase-js') return { createClient: () => stubDb }
    if (request === '@vercel/functions') return { waitUntil: (p: Promise<unknown>) => { background.push(p) } }
    if (request.startsWith('@/')) return originalLoad.apply(this, [path.join(REPO_ROOT, request.slice(2)), parent, isMain])
    return originalLoad.apply(this, [request, parent, isMain])
}

// ── The two outbound services: the Node-side bill service, and Paystack ────────
interface ApiCall { body: any; token: string | null }
const apiCalls: ApiCall[] = []
const chargeCalls: any[] = []
let quoteHandler: (body: any) => any = () => ({ ok: false, field: 'fatal', error: 'no stub' })
let createHandler: (body: any) => any = () => ({ ok: true, amount: 0 })
let apiThrows = false

;(globalThis as any).fetch = async (url: string, init: any) => {
    if (String(url).endsWith('/api/ussd/utilities')) {
        if (apiThrows) throw new Error('connect ECONNREFUSED')
        const body = JSON.parse(init.body)
        apiCalls.push({ body, token: init.headers['x-ussd-internal'] ?? null })
        const out = body.action === 'quote' ? quoteHandler(body) : createHandler(body)
        return new Response(JSON.stringify(out), { status: 200 })
    }
    chargeCalls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null })
    return new Response(JSON.stringify({ status: true, message: 'ok', data: { status: 'pay_offline', reference: 'x', display_text: 'Approve' } }), { status: 200 })
}

const STRANGER = '233201234567' // Telecel: its charge is made inside the session, so we can see it
const MEMBER_PHONE = '233241234567'

const goodQuote = (over: Row = {}) => ({
    ok: true,
    quote: { token: 'signed.token', label: 'ECG Prepaid', accountNumber: '94415486839', accountName: 'KOFI MENSAH', billAmount: 50, fee: 1.5, total: 51.5, ...over },
})

function seed(opts: { settings?: Row[]; shopUtilities?: boolean; afa?: boolean } = {}) {
    const { settings = [], shopUtilities = true, afa = false } = opts
    tables = {
        admin_settings: [
            { key: 'ussd_enabled', value: 'true' },
            { key: 'ussd_utilities_enabled', value: 'true' },
            { key: 'utility_public_launch', value: 'true' },
            { key: 'storefront_afa_enabled', value: afa ? 'true' : 'false' },
            { key: 'afa_price_customer', value: '30' }, { key: 'afa_price_agent', value: '25' }, { key: 'afa_price_dealer', value: '22' },
            ...settings,
        ],
        hubtel_sessions: [],
        users: [
            { id: 'u-ama', first_name: 'Ama', phone_number: '0241234567', role: 'agent', status: 'active' },
            { id: 'u-kofi', first_name: 'Kofi', phone_number: '0500000001', role: 'customer', status: 'active' },
        ],
        sub_agents: [],
        wallets: [{ id: 'w-ama', user_id: 'u-ama' }],
        wallet_payments: [],
        shop_profiles: [{ id: 'sh1', shop_name: 'Kofi Store', owner_id: 'u-kofi', ussd_code: 'KOFI', ussd_status: 'active', approval_status: 'approved', is_active: true, utilities_enabled: shopUtilities }],
        shop_afa_pricing: afa ? [{ shop_id: 'sh1', selling_price: 40 }] : [],
        data_packages: [], results_checker_types: [],
    }
    apiCalls.length = 0
    chargeCalls.length = 0
    quoteHandler = () => goodQuote()
    createHandler = () => ({ ok: true, amount: 51.5 })
    apiThrows = false
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
const dial = (r: any, mobile: string, sid: string, operator = 'telecel') => call(r, { Type: 'Initiation', SessionId: sid, Mobile: mobile, Operator: operator })
const say = (r: any, mobile: string, sid: string, text: string, operator = 'telecel') => call(r, { Type: 'Response', SessionId: sid, Mobile: mobile, Message: text, Operator: operator })

let passed = 0
let failed = 0
function check(name: string, ok: boolean, detail = '') {
    if (ok) { console.log(`  PASS  ${name}`); passed++ } else { console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ''}`); failed++ }
}

async function menuFor(opts: Parameters<typeof seed>[0], who: 'shop' | 'member' = 'shop') {
    seed(opts)
    const r = loadRoute()
    if (who === 'member') return (await dial(r, MEMBER_PHONE, 'm', 'mtn')).Message as string
    await dial(r, STRANGER, 'm')
    return (await say(r, STRANGER, 'm', 'kofi')).Message as string
}

async function toConfirm(r: any, sid = 'f1') {
    await dial(r, STRANGER, sid); await say(r, STRANGER, sid, 'kofi')
    await say(r, STRANGER, sid, '3')              // Utilities (no AFA in this setup)
    await say(r, STRANGER, sid, '1')              // ECG
    await say(r, STRANGER, sid, '94415486839')    // meter
    await say(r, STRANGER, sid, '1')              // own phone
    return say(r, STRANGER, sid, '50')            // amount -> quote -> confirm screen
}

async function main() {
    console.error = () => {}
    console.warn = () => {}

    // ── Listing ─────────────────────────────────────────────────────────────────
    let menu = await menuFor({})
    check('a shop that accepts bills lists Utilities as 3 when there is no AFA', /3\. Utilities/.test(menu) && !/AFA/.test(menu), menu)

    menu = await menuFor({ afa: true })
    check('with AFA too, AFA is 3 and Utilities is 4', /3\. AFA Registration/.test(menu) && /4\. Utilities/.test(menu), menu)

    menu = await menuFor({ settings: [{ key: 'ussd_utilities_enabled', value: 'false' }] })
    check("OFF by default / switched off: ussd_utilities_enabled='false' hides it", !/Utilities/.test(menu), menu)

    seed(); tables.admin_settings = tables.admin_settings.filter((s) => s.key !== 'ussd_utilities_enabled')
    let r = loadRoute(); await dial(r, STRANGER, 'm'); menu = (await say(r, STRANGER, 'm', 'kofi')).Message
    check('…and an absent row means off (bills are the one USSD service that is not on by default)', !/Utilities/.test(menu), menu)

    menu = await menuFor({ settings: [{ key: 'utility_public_launch', value: 'false' }] })
    check("the website's launch switch off hides it", !/Utilities/.test(menu), menu)

    menu = await menuFor({ shopUtilities: false })
    check('a shop that does not accept bills does not list them', !/Utilities/.test(menu), menu)

    menu = await menuFor({ settings: [{ key: 'active_payment_provider_ussd', value: 'hubtel' }] })
    check('the Hubtel rollback rail never lists them', !/Utilities/.test(menu), menu)

    menu = await menuFor({}, 'member')
    check('a registered user (AFA listed for them) sees AFA as 3 and "Pay Utility" as 4',
        menu.endsWith('3. AFA Registration\n4. Pay Utility') && /^Welcome to ARHMSTECH\nChoose a Service:/.test(menu), JSON.stringify(menu))

    menu = await menuFor({ settings: [{ key: 'ussd_afa_enabled', value: 'false' }] }, 'member')
    check('…and with AFA switched off, "Pay Utility" moves up to 3', /3\. Pay Utility/.test(menu) && !/AFA/.test(menu), menu)

    // ── The conversation ────────────────────────────────────────────────────────
    seed(); r = loadRoute()
    await dial(r, STRANGER, 'f1'); await say(r, STRANGER, 'f1', 'kofi')
    let out = await say(r, STRANGER, 'f1', '3')
    check('choosing Utilities shows the four bills, not Ghana Water', /1\. ECG Prepaid/.test(out.Message) && /2\. DSTV/.test(out.Message) && /3\. GOtv/.test(out.Message) && /4\. StarTimes/.test(out.Message) && !/Water/.test(out.Message), out.Message)
    out = await say(r, STRANGER, 'f1', '9')
    check('a bad choice is refused and the list shown again', /Invalid selection/.test(out.Message) && /ECG Prepaid/.test(out.Message), out.Message)
    out = await say(r, STRANGER, 'f1', '1')
    check('ECG asks for the meter number', /ECG meter number/.test(out.Message), out.Message)
    out = await say(r, STRANGER, 'f1', '12')
    check('a too-short number is refused before any network call', /Invalid number/.test(out.Message) && apiCalls.length === 0, out.Message)
    out = await say(r, STRANGER, 'f1', '94415486839')
    check('ECG then asks for the linked phone (the lookup is by phone)', /phone number linked/.test(out.Message), out.Message)
    out = await say(r, STRANGER, 'f1', '555')
    check('a bad phone is refused', /Invalid number/.test(out.Message), out.Message)
    out = await say(r, STRANGER, 'f1', '1')
    check('"1" means the caller\'s own number, then the amount is asked', /amount in GHS/.test(out.Message), out.Message)
    out = await say(r, STRANGER, 'f1', 'abc')
    check('a non-number amount is refused before any network call', /Enter an amount/.test(out.Message) && apiCalls.length === 0, out.Message)

    out = await say(r, STRANGER, 'f1', '50')
    const q = apiCalls[0]
    check('the amount is sent to the bill service for pricing, naming the session — not a user or wallet',
        apiCalls.length === 1 && q.body.action === 'quote' && q.body.sessionId === 'f1' && q.body.service === 'ecg' && q.body.accountNumber === '94415486839'
        && q.body.phone === '0201234567' && q.body.amount === 50 && !('userId' in q.body) && !('walletId' in q.body), JSON.stringify(q?.body))
    check('  …authenticated with the internal token (a SHA-256 hex digest, not the raw key)', /^[0-9a-f]{64}$/.test(q?.token || '') && q.token !== 'stub', q?.token || '')
    check('the confirm screen shows the server\'s account holder and total',
        /Confirm ECG Prepaid/.test(out.Message) && /94415486839/.test(out.Message) && /KOFI MENSAH/.test(out.Message) && /Bill GHS 50\n/.test(out.Message)
        && /Fee GHS 1\.5\n/.test(out.Message) && /Total GHS 51\.5\n/.test(out.Message), out.Message)
    check('  …and fits one screen', out.Message.length <= 160, `${out.Message.length}`)
    check('  …nothing is charged yet', chargeCalls.length === 0)

    out = await say(r, STRANGER, 'f1', '1')
    const create = apiCalls[1]
    check('confirming first records the payment, quoting the signed token and a USSD-UTIL- reference',
        apiCalls.length === 2 && create.body.action === 'create' && /^USSD-UTIL-/.test(create.body.reference) && create.body.token === 'signed.token' && create.body.sessionId === 'f1', JSON.stringify(create?.body))
    const charge = chargeCalls.find((c) => c.body?.reference)
    check('  …then charges exactly the server total (GHS 51.50) under that same reference',
        !!charge && charge.body.reference === create.body.reference && Number(charge.body.amount) === 5150, JSON.stringify(charge?.body))
    check('  …tagged as a bill', charge?.body?.metadata?.order_type === 'util' && charge?.body?.metadata?.shop_id === 'sh1', JSON.stringify(charge?.body?.metadata))
    check('  …and a shop bill creates no wallet payment from the edge (the Node side owns that record)', tables.wallet_payments.length === 0)

    // A TV bill skips the phone.
    seed(); r = loadRoute(); quoteHandler = () => goodQuote({ label: 'DSTV', accountNumber: '4012345678', accountName: 'ABENA OWUSU' })
    await dial(r, STRANGER, 'f2'); await say(r, STRANGER, 'f2', 'kofi'); await say(r, STRANGER, 'f2', '3'); await say(r, STRANGER, 'f2', '2')
    out = await say(r, STRANGER, 'f2', '4012345678')
    check('a TV bill goes straight from the account to the amount (no phone)', /amount in GHS/.test(out.Message), out.Message)
    out = await say(r, STRANGER, 'f2', '0')
    check('0 at the amount returns to the account for a TV bill', /DSTV smartcard/.test(out.Message), out.Message)

    seed(); r = loadRoute()
    await dial(r, STRANGER, 'f3'); await say(r, STRANGER, 'f3', 'kofi'); await say(r, STRANGER, 'f3', '3'); await say(r, STRANGER, 'f3', '1')
    await say(r, STRANGER, 'f3', '94415486839'); await say(r, STRANGER, 'f3', '1')
    out = await say(r, STRANGER, 'f3', '0')
    check('0 at the amount returns to the linked phone for ECG', /phone number linked/.test(out.Message), out.Message)

    // ── The bill service says no ────────────────────────────────────────────────
    seed(); r = loadRoute(); quoteHandler = () => ({ ok: false, field: 'amount', error: 'Minimum is GHS 10.00.' })
    await dial(r, STRANGER, 'g1'); await say(r, STRANGER, 'g1', 'kofi'); await say(r, STRANGER, 'g1', '3'); await say(r, STRANGER, 'g1', '1')
    await say(r, STRANGER, 'g1', '94415486839'); await say(r, STRANGER, 'g1', '1')
    out = await say(r, STRANGER, 'g1', '5')
    check('an amount the server rejects is re-asked with the reason', /Minimum is GHS 10/.test(out.Message) && /amount in GHS/.test(out.Message), out.Message)

    seed(); r = loadRoute(); quoteHandler = () => ({ ok: false, field: 'account', error: 'That meter could not be found.' })
    await dial(r, STRANGER, 'g2'); await say(r, STRANGER, 'g2', 'kofi'); await say(r, STRANGER, 'g2', '3'); await say(r, STRANGER, 'g2', '1')
    await say(r, STRANGER, 'g2', '94415486839'); await say(r, STRANGER, 'g2', '1')
    out = await say(r, STRANGER, 'g2', '50')
    check('an account the server cannot verify sends the caller back to re-enter it', /could not be found/.test(out.Message) && /ECG meter number/.test(out.Message), out.Message)
    await say(r, STRANGER, 'g2', '94415486839'); await say(r, STRANGER, 'g2', '1')
    out = await say(r, STRANGER, 'g2', '50')
    check('  …a second miss does the same', /ECG meter number/.test(out.Message), out.Message)
    await say(r, STRANGER, 'g2', '94415486839'); await say(r, STRANGER, 'g2', '1')
    out = await say(r, STRANGER, 'g2', '50')
    check('  …a third ends the session (no probing meters from a keypad)', out.Type === 'Release' && /could not verify/i.test(out.Message), JSON.stringify(out))
    check('  …and nothing was charged or recorded', chargeCalls.length === 0 && tables.wallet_payments.length === 0)

    seed(); r = loadRoute(); quoteHandler = () => ({ ok: false, field: 'fatal', error: 'Bill payments are not available yet.' })
    await dial(r, STRANGER, 'g3'); await say(r, STRANGER, 'g3', 'kofi'); await say(r, STRANGER, 'g3', '3'); await say(r, STRANGER, 'g3', '2')
    await say(r, STRANGER, 'g3', '4012345678')
    out = await say(r, STRANGER, 'g3', '50')
    check('a "not available" answer ends the session with the reason', out.Type === 'Release' && /not available yet/.test(out.Message), JSON.stringify(out))

    seed(); r = loadRoute(); apiThrows = true
    await dial(r, STRANGER, 'g4'); await say(r, STRANGER, 'g4', 'kofi'); await say(r, STRANGER, 'g4', '3'); await say(r, STRANGER, 'g4', '2')
    await say(r, STRANGER, 'g4', '4012345678')
    out = await say(r, STRANGER, 'g4', '50')
    check('an unreachable bill service is "try again", never a charge', /could not reach/i.test(out.Message) && chargeCalls.length === 0, out.Message)

    // ── Nothing is charged unless the record was made ───────────────────────────
    seed(); r = loadRoute(); await toConfirm(r, 'h1')
    createHandler = () => ({ ok: false, field: 'fatal', error: 'That quote has expired. Please dial again.' })
    out = await say(r, STRANGER, 'h1', '1')
    check('if the payment record cannot be made, the caller is NOT charged', out.Type === 'Release' && /busy|try/i.test(out.Message) && chargeCalls.length === 0, JSON.stringify({ out, charges: chargeCalls.length }))

    seed({ settings: [{ key: 'active_payment_provider_ussd', value: 'hubtel' }] }); r = loadRoute(); await toConfirm(r, 'h2').catch(() => {})
    // (the menu does not list bills on the rollback rail; reach the step directly to prove confirm refuses too)
    tables.hubtel_sessions = [{ session_id: 'h3', mobile: STRANGER, current_step: 'confirm', data: { mode: 'shop', shopId: 'sh1', orderType: 'util', selectedPrice: 51.5, itemName: 'ECG Prepaid', operator: 'telecel', util: { service: 'ecg', quote: { token: 't' } } } }]
    out = await say(r, STRANGER, 'h3', '1')
    check('a session already at confirm when the admin moves to the rollback rail is refused, uncharged', out.Type === 'Release' && /unavailable/i.test(out.Message) && chargeCalls.length === 0, JSON.stringify(out))

    // ── A registered user ───────────────────────────────────────────────────────
    seed(); r = loadRoute(); quoteHandler = () => goodQuote({ total: 50.26, fee: 0.26 }); createHandler = () => ({ ok: true, amount: 50.26 })
    await dial(r, MEMBER_PHONE, 'k1', 'mtn')
    out = await say(r, MEMBER_PHONE, 'k1', '4', 'mtn') // 3 is AFA for a registered user
    check('a registered user reaches the bill list too', /ECG Prepaid/.test(out.Message), out.Message)
    await say(r, MEMBER_PHONE, 'k1', '1', 'mtn'); await say(r, MEMBER_PHONE, 'k1', '94415486839', 'mtn'); await say(r, MEMBER_PHONE, 'k1', '1', 'mtn')
    out = await say(r, MEMBER_PHONE, 'k1', '50', 'mtn')
    check("…and sees their own total (50.26)", /Total GHS 50\.26/.test(out.Message), out.Message)
    out = await say(r, MEMBER_PHONE, 'k1', '1', 'mtn')
    check('…confirming records the payment through the bill service, not as a wallet top-up',
        apiCalls.some((c) => c.body.action === 'create' && /^USSD-UTIL-/.test(c.body.reference)) && tables.wallet_payments.length === 0, j(apiCalls.map((c) => c.body.action)))

    console.log(`\n${passed} passed, ${failed} failed`)
    process.exit(failed === 0 ? 0 : 1)
}
const j = (x: unknown) => JSON.stringify(x)

main().catch((e) => { console.error(e); process.exit(1) })
