/**
 * Test: fulfilling an AFA registration sold through a shop's USSD menu
 * (lib/ussd-afa-fulfillment.ts)
 *
 * Runs once the caller's MoMo payment is confirmed, from the Paystack webhook and from the
 * reconciliation sweep — which can both arrive for the same payment. Pins:
 *
 *   - the order lands in the admin queue exactly as a storefront AFA order does
 *     (source 'storefront', paid, status pending), with the applicant's details;
 *   - the shop is credited price − what the OWNER pays, and on a sub-agent's sale each upline
 *     is credited its own spread under its own reference — nothing invented, nothing lost;
 *   - the price is re-read from the database, never taken from the session, and an
 *     underpayment creates nothing;
 *   - a second delivery (retry, or the sweep after the webhook) changes nothing, and losing
 *     the insert race to the unique reference is a success that credits nothing twice;
 *   - a paid sale at or below cost is still registered (the caller has paid) but credits no one.
 *
 * No network, no database: Supabase, SMS, the admin alert and the wallet credit are stubbed.
 *
 * Run (CommonJS is required for the require() hook below):
 *
 *   TS_NODE_COMPILER_OPTIONS='{"module":"commonjs","moduleResolution":"node"}' \
 *     npx ts-node --transpile-only scripts/test-ussd-afa-fulfil.ts
 *
 * Exit code: 0 = all pass, 1 = any fail
 */
import Module from 'module'
import path from 'path'

const REPO_ROOT = path.resolve(__dirname, '..')
process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://stub.local'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub'

type Row = Record<string, any>
let tables: Record<string, Row[]> = {}
let insertError: Record<string, { code?: string; message: string } | null> = {}

function builder(table: string) {
    const q: any = { op: 'select', filters: [] as Array<(r: Row) => boolean>, payload: null }
    const run = async () => {
        const rows = (tables[table] = tables[table] || [])
        const matched = rows.filter((r) => q.filters.every((f: any) => f(r)))
        if (q.op === 'insert') {
            if (insertError[table]) return { data: null, error: insertError[table] }
            const added = [].concat(q.payload).map((p: any) => ({ id: `${table}-${rows.length + 1}`, ...p }))
            rows.push(...added)
            return { data: added, error: null }
        }
        if (q.op === 'delete') { tables[table] = rows.filter((r) => !matched.includes(r)); return { data: matched, error: null } }
        return { data: matched, error: null }
    }
    const api: any = {
        select() { return api },
        insert(p: any) { q.op = 'insert'; q.payload = p; return api },
        delete() { q.op = 'delete'; return api },
        eq(c: string, v: any) { q.filters.push((r: Row) => r[c] === v); return api },
        in(c: string, vs: any[]) { q.filters.push((r: Row) => vs.includes(r[c])); return api },
        single: async () => { const r = await run(); return r.error ? r : { data: r.data[0] ?? null, error: null } },
        maybeSingle: async () => { const r = await run(); return r.error ? r : { data: r.data[0] ?? null, error: null } },
        then(res: any, rej: any) { return run().then(res, rej) },
    }
    return api
}
const db = { from: (t: string) => builder(t) }

const credits: Array<{ ownerId: string; amount: number; reference: string }> = []
const sms: Array<{ recipient: string; message: string }> = []
let adminAlerts = 0

const originalLoad = (Module as any)._load
;(Module as any)._load = function (request: string, parent: unknown, isMain: boolean) {
    if (request === '@supabase/supabase-js') return { createClient: () => db }
    if (request === '@/lib/shop-service') {
        return { creditShopRcProfit: async (p: any) => { credits.push({ ownerId: p.ownerId, amount: p.amount, reference: p.reference }); return { credited: true } } }
    }
    if (request === '@/lib/sms-service') {
        return { sendSMS: async (p: any) => { sms.push({ recipient: p.recipient, message: p.message }); return { success: true } } }
    }
    if (request === '@/lib/afa/checkout') {
        return { notifyAdminsOfAfaApplication: async () => { adminAlerts++ } }
    }
    if (request.startsWith('@/')) return originalLoad.apply(this, [path.join(REPO_ROOT, request.slice(2)), parent, isMain])
    return originalLoad.apply(this, [request, parent, isMain])
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { fulfillUSSDAFABySession } = require('@/lib/ussd-afa-fulfillment')

const REF = 'USSD-AFA-TEST-0001'
const FORM = {
    full_name: 'Kwame Mensah', id_number: 'GHA-123456789-0', date_of_birth: '1990-03-15',
    region: 'Ashanti', location: 'Kumasi', phone: '0201234567',
}

/**
 * Lead shop sh1 (owner u-kofi, role `ownerRole`) prices AFA at `leadPrice`.
 * Sub shop s2 (owner u-sub) sits under it and prices at `subPrice`.
 * Platform AFA: customer 30, agent 25, dealer 22.
 */
function seed(opts: { ownerRole?: string; leadPrice?: number; subPrice?: number; sessionShop?: string; noSession?: boolean } = {}) {
    const { ownerRole = 'customer', leadPrice = 40, subPrice = 45, sessionShop = 'sh1', noSession = false } = opts
    tables = {
        admin_settings: [
            { key: 'afa_price_customer', value: '30' }, { key: 'afa_price_agent', value: '25' }, { key: 'afa_price_dealer', value: '22' },
        ],
        users: [{ id: 'u-kofi', role: ownerRole }, { id: 'u-sub', role: 'customer' }],
        shop_profiles: [
            { id: 'sh1', shop_name: 'Kofi Store', owner_id: 'u-kofi' },
            { id: 's2', shop_name: 'Sub Store', owner_id: 'u-sub' },
        ],
        sub_agents: [{ id: 'm1', user_id: 'u-sub', upline_shop_id: 'sh1' }],
        shop_afa_pricing: [{ shop_id: 'sh1', selling_price: leadPrice }, { shop_id: 's2', selling_price: subPrice }],
        hubtel_sessions: noSession ? [] : [{
            session_id: 'sess1', mobile: '233201234567',
            data: { mode: 'shop', shopId: sessionShop, afaForm: FORM, orderType: 'afa', payerMsisdn: '0201234567' },
        }],
        afa_orders: [],
    }
    credits.length = 0; sms.length = 0; adminAlerts = 0; insertError = {}
}

async function fulfil(amountPaid: number) {
    const deferredWork: Array<() => Promise<void>> = []
    const result = await fulfillUSSDAFABySession({ sessionId: 'sess1', referenceCode: REF, amountPaid, deferredWork })
    for (const task of deferredWork) await task()
    return result
}

let passed = 0
let failed = 0
function check(name: string, ok: boolean, detail = '') {
    if (ok) { console.log(`  PASS  ${name}`); passed++ } else { console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ''}`); failed++ }
}
const legs = () => credits.map((c) => `${c.ownerId}:${c.amount}:${c.reference}`)

async function main() {
    console.error = () => {}
    console.warn = () => {}
    console.log = ((orig) => (...a: any[]) => { if (typeof a[0] === 'string' && a[0].startsWith('[USSD-AFA')) return; orig(...a) })(console.log)

    // A Lead's sale.
    seed()
    let r = await fulfil(40)
    let order = tables.afa_orders[0]
    check('a paid sale is registered', r.success && tables.afa_orders.length === 1)
    check('  …as a paid storefront-style order waiting for an admin',
        order?.payment_status === 'completed' && order?.status === 'pending' && order?.source === 'storefront' && order?.user_id === null && order?.reference_code === REF,
        JSON.stringify(order))
    check('  …with the applicant and a Ghana Card ID type',
        order?.full_name === 'Kwame Mensah' && order?.id_type === 'Ghana Card' && order?.id_number === 'GHA-123456789-0' && order?.ghana_card === 'GHA-123456789-0'
        && order?.date_of_birth === '1990-03-15' && order?.region === 'Ashanti' && order?.location === 'Kumasi' && order?.phone === '0201234567' && order?.occupation === 'Farmer')
    check('  …priced from the database, with the shop attributed', Number(order?.payment_amount) === 40 && order?.shop_id === 'sh1' && order?.shop_name === 'Kofi Store')
    check('  …the shop is credited price − owner cost (40 − 30 = 10), once', Number(order?.shop_markup) === 10 && Number(order?.cost_price) === 30 && JSON.stringify(legs()) === JSON.stringify([`u-kofi:10:${REF}`]), JSON.stringify(legs()))
    check('  …the admins are alerted, the caller is texted, the session is cleared',
        adminAlerts === 1 && sms.length === 1 && sms[0].recipient === '0201234567' && /received/.test(sms[0].message) && tables.hubtel_sessions.length === 0,
        `alerts=${adminAlerts} sms=${JSON.stringify(sms)} sessions=${tables.hubtel_sessions.length}`)
    check('  …and the SMS is ASCII', /^[\x20-\x7E]+$/.test(sms[0]?.message || ''))

    // Second delivery.
    seed(); await fulfil(40); credits.length = 0; adminAlerts = 0; sms.length = 0
    tables.hubtel_sessions = [] // the webhook cleaned it up; the sweep arrives later
    r = await fulfil(40)
    check('a second delivery (sweep after webhook) changes nothing', r.success && tables.afa_orders.length === 1 && credits.length === 0 && adminAlerts === 0 && sms.length === 0, `orders=${tables.afa_orders.length} credits=${credits.length}`)

    // Price is the database's.
    seed(); r = await fulfil(39)
    check('an underpayment creates nothing', !r.success && tables.afa_orders.length === 0 && credits.length === 0, JSON.stringify(r))

    seed({ leadPrice: 60 }); r = await fulfil(40)
    check("the session's idea of the price is irrelevant — the shop's CURRENT price (60) is what must be paid", !r.success && tables.afa_orders.length === 0, JSON.stringify(r))

    // A sub-agent's sale: each level keeps its own spread.
    seed({ sessionShop: 's2' }); r = await fulfil(45)
    order = tables.afa_orders[0]
    check("a sub-agent's sale splits up the chain: sub 5, Lead 10", r.success && Number(order?.shop_markup) === 5 && Number(order?.cost_price) === 40 && Number(order?.parent_profit) === 10 && order?.parent_shop_id === 'sh1', JSON.stringify(order))
    check('  …each leg credited under its own reference',
        JSON.stringify(legs()) === JSON.stringify([`u-sub:5:${REF}`, `u-kofi:10:${REF}:up1`]), JSON.stringify(legs()))
    check('  …and legs + the root cost add up to the price (5 + 10 + 30 = 45)', 5 + 10 + 30 === 45 && Number(order.shop_markup) + Number(order.parent_profit) + 30 === Number(order.payment_amount))

    // A dealer Lead pays less, so earns more.
    seed({ ownerRole: 'dealer' }); r = await fulfil(40)
    check("a dealer Lead's cost is the dealer price (22): profit 18", Number(tables.afa_orders[0]?.shop_markup) === 18 && Number(tables.afa_orders[0]?.cost_price) === 22, JSON.stringify(tables.afa_orders[0]))

    // Lost race.
    seed(); insertError = { afa_orders: { code: '23505', message: 'duplicate key value violates unique constraint afa_orders_reference_code_unique' } }
    r = await fulfil(40)
    check('losing the insert to another settlement is a success that credits nothing', r.success && credits.length === 0 && adminAlerts === 0 && sms.length === 0, JSON.stringify(legs()))

    seed(); insertError = { afa_orders: { code: '50000', message: 'boom' } }
    r = await fulfil(40)
    check('any other insert failure is reported, not swallowed', !r.success && credits.length === 0, JSON.stringify(r))

    // At or below cost.
    seed({ leadPrice: 30 }); r = await fulfil(30)
    check('a paid sale at cost is still registered, but credits no one',
        r.success && tables.afa_orders.length === 1 && Number(tables.afa_orders[0].shop_markup) === 0 && credits.length === 0, JSON.stringify({ r, credits }))

    // Missing session.
    seed({ noSession: true }); r = await fulfil(40)
    check('no session and no existing order is an error (the sweep will retry)', !r.success && tables.afa_orders.length === 0, JSON.stringify(r))

    console.log(`\n${passed} passed, ${failed} failed`)
    process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
