/**
 * Test: AFA registration on USSD
 *
 * Two layers. The answer parsers (lib/ussd-afa.ts) are exercised directly, then the real
 * POST handler of app/api/hubtel/interact is driven through the whole flow with an
 * in-memory Supabase, a stubbed waitUntil and a stubbed Paystack. Pins:
 *
 *   - AFA is listed only where it can be sold: a shop that has priced it with the storefront
 *     switch on, or a registered user who is not a sub-agent; never on the house code, never
 *     on the Hubtel rollback rail, never when the admin has turned it off;
 *   - every question rejects what the web form would reject (name, Ghana Card, date of birth,
 *     region, town) and re-asks with the reason;
 *   - the price is the shop owner's price, or for a registered user the platform price for
 *     their role;
 *   - a shop sale is charged under a USSD-AFA- reference; a registered user's is recorded as
 *     a pending wallet payment carrying the applicant.
 *
 * No network, no database.
 *
 * Run (CommonJS is required for the require() hook below):
 *
 *   TS_NODE_COMPILER_OPTIONS='{"module":"commonjs","moduleResolution":"node"}' \
 *     npx ts-node --transpile-only scripts/test-ussd-afa.ts
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

// eslint-disable-next-line @typescript-eslint/no-var-requires
const afa = require('@/lib/ussd-afa')

// ── Fixtures ────────────────────────────────────────────────────────────────────
const MEMBER_PHONE = '233241234567'
const STRANGER = '233201234567' // Telecel: its charge is made inside the session, so we can see it
function seed(opts: { shopPrice?: number | null; storefront?: string; extraSettings?: Row[]; sub?: boolean } = {}) {
    const { shopPrice = 40, storefront = 'true', extraSettings = [], sub = false } = opts
    tables = {
        admin_settings: [
            { key: 'ussd_enabled', value: 'true' },
            { key: 'storefront_afa_enabled', value: storefront },
            { key: 'afa_price_customer', value: '30' },
            { key: 'afa_price_agent', value: '25' },
            { key: 'afa_price_dealer', value: '22' },
            ...extraSettings,
        ],
        hubtel_sessions: [],
        users: [
            { id: 'u-ama', first_name: 'Ama', phone_number: '0241234567', role: 'agent', status: 'active' },
            { id: 'u-kofi', first_name: 'Kofi', phone_number: '0500000001', role: 'customer', status: 'active' },
        ],
        sub_agents: sub ? [{ id: 'm1', user_id: 'u-ama', upline_shop_id: 'sh1', status: 'active' }] : [],
        wallets: [{ id: 'w-ama', user_id: 'u-ama' }],
        wallet_payments: [],
        shop_profiles: [{ id: 'sh1', shop_name: 'Kofi Store', owner_id: 'u-kofi', ussd_code: 'KOFI', ussd_status: 'active', approval_status: 'approved', is_active: true }],
        shop_afa_pricing: shopPrice == null ? [] : [{ shop_id: 'sh1', selling_price: shopPrice }],
        data_packages: [], results_checker_types: [],
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
    const res = await route.POST(new Request('http://x', { method: 'POST', body: JSON.stringify(body) }))
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

async function main() {
    // ── The parsers ─────────────────────────────────────────────────────────────
    check('name: two words accepted', afa.parseFullName('  Kwame   Mensah ').value === 'Kwame Mensah')
    check('name: one word refused', afa.parseFullName('Kwame').ok === false)
    check('name: non-ASCII refused (Hubtel throws on it)', afa.parseFullName('Kwame Mensahé').ok === false)
    check('name: digits refused', afa.parseFullName('Kwame M3nsah').ok === false)

    check('card: full form accepted', afa.parseGhanaCard('GHA-123456789-0').value === 'GHA-123456789-0')
    check('card: digits only accepted and formatted', afa.parseGhanaCard('1234567890').value === 'GHA-123456789-0')
    check('card: lower case + no dashes accepted', afa.parseGhanaCard('gha1234567890').value === 'GHA-123456789-0')
    check('card: 11 digits refused (not silently truncated)', afa.parseGhanaCard('12345678901').ok === false)
    check('card: 9 digits refused', afa.parseGhanaCard('123456789').ok === false)
    check('card: letters refused', afa.parseGhanaCard('GHA-12345678A-0').ok === false)

    const thisYear = new Date().getFullYear()
    check('dob: DDMMYYYY accepted', afa.parseDateOfBirth('15031990').value === '1990-03-15')
    check('dob: separators accepted', afa.parseDateOfBirth('15/03/1990').value === '1990-03-15')
    check('dob: 31 Feb refused', afa.parseDateOfBirth('31022000').ok === false)
    check('dob: future date refused', afa.parseDateOfBirth('01012099').ok === false)
    check('dob: under 18 refused', afa.parseDateOfBirth(`0101${thisYear - 10}`).ok === false)
    check('dob: over 110 refused', afa.parseDateOfBirth('01011800').ok === false)
    check('dob: wrong shape refused', afa.parseDateOfBirth('1990').ok === false)

    check('town: accepted', afa.parseTown(' Kumasi ').value === 'Kumasi')
    check('town: single character refused', afa.parseTown('K').ok === false)
    check('region: page 1 starts at Greater Accra and ends at Upper East', afa.regionFromChoice('1', 0) === 'Greater Accra' && afa.regionFromChoice('8', 0) === 'Upper East')
    check('region: page 2 numbering restarts at 1 (Upper West ... Western North)', afa.regionFromChoice('1', 1) === 'Upper West' && afa.regionFromChoice('8', 1) === 'Western North')
    check('region: out of range refused', afa.regionFromChoice('9', 0) === null && afa.regionFromChoice('0', 0) === null)
    check('region menus fit one screen', [0, 1].every((p) => afa.renderRegionMenu(p).length < 160), `${afa.renderRegionMenu(0).length}/${afa.renderRegionMenu(1).length}`)
    check('every region is reachable', (() => {
        const seen = new Set<string>()
        for (let page = 0; page <= afa.lastRegionPage(); page++) for (let n = 1; n <= afa.REGION_PAGE_SIZE; n++) {
            const r = afa.regionFromChoice(String(n), page); if (r) seen.add(r)
        }
        return seen.size === 16
    })())

    // ── When AFA is listed ──────────────────────────────────────────────────────
    seed(); let r = loadRoute()
    await dial(r, STRANGER, 'a1')
    let out = await say(r, STRANGER, 'a1', 'kofi')
    check('a shop that has priced AFA lists it', /3\. AFA Registration/.test(out.Message), out.Message)

    seed({ shopPrice: null }); r = loadRoute()
    await dial(r, STRANGER, 'a2'); out = await say(r, STRANGER, 'a2', 'kofi')
    check('a shop that has NOT priced AFA does not list it', !/AFA/.test(out.Message), out.Message)

    seed({ storefront: 'false' }); r = loadRoute()
    await dial(r, STRANGER, 'a3'); out = await say(r, STRANGER, 'a3', 'kofi')
    check('the storefront AFA switch off hides it', !/AFA/.test(out.Message), out.Message)

    seed({ extraSettings: [{ key: 'ussd_afa_enabled', value: 'false' }] }); r = loadRoute()
    await dial(r, STRANGER, 'a4'); out = await say(r, STRANGER, 'a4', 'kofi')
    check("kill switch ussd_afa_enabled='false' hides it", !/AFA/.test(out.Message), out.Message)

    seed({ extraSettings: [{ key: 'active_payment_provider_ussd', value: 'hubtel' }] }); r = loadRoute()
    await dial(r, STRANGER, 'a5'); out = await say(r, STRANGER, 'a5', 'kofi')
    check('the Hubtel rollback rail never lists it (it cannot fulfil AFA)', !/AFA/.test(out.Message), out.Message)

    seed(); r = loadRoute()
    out = await dial(r, MEMBER_PHONE, 'a6', 'mtn')
    check('a registered user sees it', /3\. AFA Registration/.test(out.Message), out.Message)

    seed({ sub: true }); r = loadRoute()
    out = await dial(r, MEMBER_PHONE, 'a7', 'mtn')
    check('a sub-agent member does NOT (process_sub_afa_order is not installed)', !/AFA/.test(out.Message), out.Message)

    // ── A shop sale, start to finish ────────────────────────────────────────────
    seed(); r = loadRoute()
    await dial(r, STRANGER, 'b1'); await say(r, STRANGER, 'b1', 'kofi')
    out = await say(r, STRANGER, 'b1', '3')
    check('choosing AFA asks for the full name', /Enter full name/.test(out.Message), out.Message)
    out = await say(r, STRANGER, 'b1', 'Kwame')
    check('a one-word name is refused and re-asked', /first and last name/.test(out.Message) && /Enter full name/.test(out.Message), out.Message)
    out = await say(r, STRANGER, 'b1', 'Kwame Mensah')
    check('a good name moves on to the Ghana Card', /Ghana Card/.test(out.Message), out.Message)
    out = await say(r, STRANGER, 'b1', '12345')
    check('a bad card number is refused and re-asked', /Invalid Ghana Card/.test(out.Message), out.Message)
    out = await say(r, STRANGER, 'b1', 'GHA-123456789-0')
    check('a good card moves on to the date of birth', /date of birth/i.test(out.Message), out.Message)
    out = await say(r, STRANGER, 'b1', `0101${thisYear - 10}`)
    check('an under-18 date is refused', /18 or older/.test(out.Message), out.Message)
    out = await say(r, STRANGER, 'b1', '15031990')
    check('a good date shows the first page of regions', /Select Region/.test(out.Message) && /99\. Next/.test(out.Message) && /1\. Greater Accra/.test(out.Message), out.Message)
    out = await say(r, STRANGER, 'b1', '99')
    check('Next shows the second page, numbering from 1', /Select Region/.test(out.Message) && /1\. /.test(out.Message) && /88\. Prev/.test(out.Message) && !/99\. Next/.test(out.Message), out.Message)
    out = await say(r, STRANGER, 'b1', '1')
    check('picking a region asks for the town', /town or/i.test(out.Message), out.Message)
    out = await say(r, STRANGER, 'b1', 'Kumasi')
    check('the town is followed by the number to register', /number to register/i.test(out.Message), out.Message)
    out = await say(r, STRANGER, 'b1', '0')
    check('0 at the number step goes back to the town (not the service menu)', /town or/i.test(out.Message), out.Message)
    out = await say(r, STRANGER, 'b1', 'Kumasi')
    out = await say(r, STRANGER, 'b1', '1')
    check('the confirm screen shows name, the SHOP price and the number — but not the ID',
        /Confirm AFA Registration/.test(out.Message) && /Kwame Mensah/.test(out.Message) && /GHS 40\n/.test(out.Message) && /Number: 0201234567/.test(out.Message) && !/GHA-/.test(out.Message),
        out.Message)
    check('  …and it fits one screen', out.Message.length < 160, `${out.Message.length}`)

    out = await say(r, STRANGER, 'b1', '1')
    const charge = chargeCalls.find((c) => c.body?.reference)
    check('confirm charges GHS 40 under a USSD-AFA- reference',
        !!charge && /^USSD-AFA-/.test(charge.body.reference) && Number(charge.body.amount) === 4000, JSON.stringify(charge?.body))
    check('  …tagged as an afa order for the shop', charge?.body?.metadata?.order_type === 'afa' && charge?.body?.metadata?.shop_id === 'sh1', JSON.stringify(charge?.body?.metadata))
    const sess = tables.hubtel_sessions.find((s) => s.session_id === 'b1')
    check('  …and the session keeps the applicant for fulfilment',
        sess?.data?.orderType === 'afa' && sess?.data?.afaForm?.full_name === 'Kwame Mensah' && sess?.data?.afaForm?.id_number === 'GHA-123456789-0'
        && sess?.data?.afaForm?.date_of_birth === '1990-03-15' && sess?.data?.afaForm?.location === 'Kumasi' && sess?.data?.afaForm?.phone === '0201234567'
        && typeof sess?.data?.afaForm?.region === 'string', JSON.stringify(sess?.data?.afaForm))
    check('  …a shop sale writes no wallet payment (the caller has no account)', tables.wallet_payments.length === 0)

    // ── A registered user's sale ────────────────────────────────────────────────
    seed(); r = loadRoute()
    await dial(r, MEMBER_PHONE, 'c1', 'mtn')
    out = await say(r, MEMBER_PHONE, 'c1', '3', 'mtn')
    check('a member can start an AFA registration', /Enter full name/.test(out.Message), out.Message)
    for (const answer of ['Ama Boateng', '1234567890', '15031990', '1', 'Accra']) out = await say(r, MEMBER_PHONE, 'c1', answer, 'mtn')
    out = await say(r, MEMBER_PHONE, 'c1', '1', 'mtn')
    check("the member's confirm screen quotes the AGENT price (25), not the customer's 30", /GHS 25\n/.test(out.Message), out.Message)
    out = await say(r, MEMBER_PHONE, 'c1', '1', 'mtn')
    const pay = tables.wallet_payments[0]
    check('confirm records ONE pending wallet payment at the agent price',
        tables.wallet_payments.length === 1 && pay.user_id === 'u-ama' && pay.status === 'pending' && Number(pay.amount) === 25 && /^USSD-AFA-/.test(pay.reference), JSON.stringify(pay))
    check('  …carrying the applicant for settlement',
        pay?.metadata?.kind === 'ussd_member' && pay.metadata.order_type === 'afa' && pay.metadata.afa?.full_name === 'Ama Boateng'
        && pay.metadata.afa?.id_number === 'GHA-123456789-0' && pay.metadata.afa?.phone === '0241234567', JSON.stringify(pay?.metadata))

    console.log(`\n${passed} passed, ${failed} failed`)
    process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
