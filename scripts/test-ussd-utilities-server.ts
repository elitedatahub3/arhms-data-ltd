/**
 * Test: the Node-side utility bill route behind USSD (lib/ussd-utilities-server.ts)
 *
 * This is where a bill is priced and its payment recorded, so it is where money is decided.
 * Pins:
 *
 *   - only the edge USSD route can call it (the internal token), and a quote cannot be forged,
 *     altered or reused after it expires;
 *   - the account of record comes from the SESSION: a shop sale is the shop owner's, a
 *     registered user's is their own — a request cannot name another wallet;
 *   - the price is the website's: the platform fee plus the shop's mark-up (and its upline's)
 *     inside the admin's total cap, quoted exactly as /api/utilities/gateway-init would;
 *   - every switch the website obeys is obeyed here, plus USSD's own, which is OFF by default;
 *   - cheap checks name the answer to ask for again; a provider that will not verify an account,
 *     or hangs, ends in "try again" with nothing charged;
 *   - confirming records one pending wallet payment of exactly the quote, once, and refuses
 *     anything stale, tampered, or for another session.
 *
 * No network, no database: the provider, Supabase and the Hubtel payment service are stubbed.
 *
 * Run (CommonJS is required for the require() hook below):
 *
 *   TS_NODE_COMPILER_OPTIONS='{"module":"commonjs","moduleResolution":"node"}' \
 *     npx ts-node --transpile-only scripts/test-ussd-utilities-server.ts
 *
 * Exit code: 0 = all pass, 1 = any fail
 */
import Module from 'module'
import path from 'path'

const REPO_ROOT = path.resolve(__dirname, '..')
process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub-service-key'

type Row = Record<string, any>
let tables: Record<string, Row[]> = {}

function builder(table: string) {
    const q: any = { op: 'select', filters: [] as Array<(r: Row) => boolean>, payload: null }
    const run = async () => {
        const rows = (tables[table] = tables[table] || [])
        const matched = rows.filter((r) => q.filters.every((f: any) => f(r)))
        if (q.op === 'insert') {
            const added = [].concat(q.payload).map((p: any, i: number) => ({ id: `${table}-${rows.length + i + 1}`, ...p }))
            rows.push(...added)
            return { data: added, error: null }
        }
        return { data: matched, error: null }
    }
    const api: any = {
        select() { return api },
        insert(p: any) { q.op = 'insert'; q.payload = p; return api },
        eq(c: string, v: any) { q.filters.push((r: Row) => r[c] === v); return api },
        in(c: string, vs: any[]) { q.filters.push((r: Row) => vs.includes(r[c])); return api },
        single: async () => { const r = await run(); return { data: r.data[0] ?? null, error: null } },
        maybeSingle: async () => { const r = await run(); return { data: r.data[0] ?? null, error: null } },
        then(res: any, rej: any) { return run().then(res, rej) },
    }
    return api
}
const db = { from: (t: string) => builder(t) }

type Lookup = (params: any) => Promise<any>
let lookup: Lookup = async () => ({ success: false, error: 'no stub' })
const lookupCalls: any[] = []

const originalLoad = (Module as any)._load
;(Module as any)._load = function (request: string, parent: unknown, isMain: boolean) {
    // The Hubtel payment service pulls in a proxy library; nothing here needs it.
    if (request === '@/lib/hubtel-payment-service') {
        return { getDispatcher: () => undefined, buildHubtelBasicAuth: () => '', toHubtelMsisdn: (s: string) => s, describeHubtelNetworkFailure: () => '' }
    }
    if (request === '@/lib/utility-provider') {
        return { queryUtilityAccount: async (p: any) => { lookupCalls.push(p); return lookup(p) } }
    }
    if (request.startsWith('@/')) return originalLoad.apply(this, [path.join(REPO_ROOT, request.slice(2)), parent, isMain])
    return originalLoad.apply(this, [request, parent, isMain])
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const srv = require('@/lib/ussd-utilities-server')
const { handleQuote, handleCreate, signQuote, verifyQuote, internalTokenValid, expectedInternalToken } = srv

const ECG_OK: Lookup = async () => ({
    success: true,
    accountName: 'KOFI MENSAH',
    meters: [{ meterNumber: '94415486839', label: 'KOFI MENSAH (94415486839)', balance: 0 }],
})

function seed(settingsOverride: Record<string, string> = {}, over: { shopUtilities?: boolean; memberStatus?: string; noWallet?: boolean } = {}) {
    const settings: Record<string, string> = {
        ussd_utilities_enabled: 'true', utility_public_launch: 'true',
        utility_dashboard_enabled: 'true', utility_storefront_enabled: 'true',
        utility_enabled_ecg: 'true', utility_enabled_dstv: 'true',
        utility_fee_ecg_customer: '1', utility_fee_ecg_agent: '0.52', utility_fee_dstv_customer: '0.5', utility_fee_dstv_agent: '0.5',
        utility_min_amount_ecg: '10', utility_max_amount_ecg: '1000', utility_min_amount_dstv: '1', utility_max_amount_dstv: '1000',
        utility_total_markup_cap_percent: '10',
        ...settingsOverride,
    }
    tables = {
        admin_settings: Object.entries(settings).filter(([, v]) => v !== '__absent__').map(([key, value]) => ({ key, value })),
        users: [
            { id: 'u-kofi', role: 'customer', status: 'active' },
            { id: 'u-sub', role: 'customer', status: 'active' },
            { id: 'u-ama', role: 'agent', status: over.memberStatus ?? 'active' },
        ],
        shop_profiles: [
            { id: 'sh1', shop_name: 'Kofi Store', owner_id: 'u-kofi', utilities_enabled: over.shopUtilities ?? true, utility_fee_percent: 2, approval_status: 'approved', is_active: true },
            { id: 's2', shop_name: 'Sub Store', owner_id: 'u-sub', utilities_enabled: true, utility_fee_percent: 1, approval_status: 'approved', is_active: true },
        ],
        sub_agents: [{ id: 'm1', user_id: 'u-sub', upline_shop_id: 'sh1' }],
        hubtel_sessions: [
            { session_id: 'S-SHOP', mobile: '233201234567', data: { mode: 'shop', shopId: 'sh1' } },
            { session_id: 'S-SUB', mobile: '233201234567', data: { mode: 'shop', shopId: 's2' } },
            { session_id: 'S-MEMBER', mobile: '233241234567', data: { mode: 'member', member: { userId: 'u-ama' } } },
            { session_id: 'S-HOUSE', mobile: '233201234567', data: { mode: 'platform' } },
        ],
        wallets: over.noWallet ? [] : [{ id: 'w-kofi', user_id: 'u-kofi' }, { id: 'w-ama', user_id: 'u-ama' }],
        wallet_payments: [],
    }
    lookup = ECG_OK
    lookupCalls.length = 0
}

const ECG = { action: 'quote', service: 'ecg', accountNumber: '94415486839', phone: '0201234567', amount: 50 }

let passed = 0
let failed = 0
function check(name: string, ok: boolean, detail = '') {
    if (ok) { console.log(`  PASS  ${name}`); passed++ } else { console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ''}`); failed++ }
}
const j = (x: unknown) => JSON.stringify(x)

async function main() {
    console.error = () => {}
    console.warn = () => {}

    // ── Who may call, and the quote's signature ─────────────────────────────────
    check('the edge route\'s token is accepted', internalTokenValid(expectedInternalToken()))
    check('no token, a wrong token and a truncated token are refused', !internalTokenValid(null) && !internalTokenValid('x') && !internalTokenValid(expectedInternalToken().slice(1)))

    const payload = { v: 1, sid: 'S', uid: 'u', exp: Date.now() + 60_000, subtotal: 10, metadata: { a: 1 } }
    const token = signQuote(payload)
    check('a signed quote verifies and round-trips', j(verifyQuote(token)) === j(payload))
    const [body, sig] = token.split('.')
    const forged = Buffer.from(JSON.stringify({ ...payload, subtotal: 1 }), 'utf8').toString('base64url')
    check('a quote with an altered amount is rejected', verifyQuote(`${forged}.${sig}`) === null)
    check('a quote with a replaced signature is rejected', verifyQuote(`${body}.${sig.slice(0, -2)}xx`) === null)
    check('an expired quote is rejected', verifyQuote(signQuote({ ...payload, exp: Date.now() - 1 })) === null)
    check('garbage is rejected', verifyQuote('nonsense') === null && verifyQuote(undefined) === null)

    // ── Pricing: a shop sale ────────────────────────────────────────────────────
    seed()
    let r = await handleQuote(db, { ...ECG, sessionId: 'S-SHOP' })
    check('a shop sale quotes bill + platform fee + shop mark-up (50 + 0.50 + 1.00 = 51.50)',
        r.ok && r.quote.total === 51.5 && r.quote.billAmount === 50 && r.quote.fee === 1.5, j(r))
    check('  …shows the account holder from the provider', r.quote?.accountName === 'KOFI MENSAH' && r.quote?.label === 'ECG Prepaid')
    const qp = verifyQuote(r.quote?.token)
    check('  …the signed quote names the SHOP OWNER as the account of record',
        qp?.uid === 'u-kofi' && qp?.sid === 'S-SHOP' && qp?.subtotal === 51.5 && qp?.metadata.user_id === 'u-kofi' && qp?.metadata.role === 'customer', j(qp))
    check('  …and snapshots the reseller split for settlement',
        qp?.metadata.shop_id === 'sh1' && qp?.metadata.reseller_fee_amount === 1 && j(qp?.metadata.reseller_split) === j([{ shop_id: 'sh1', owner_id: 'u-kofi', percent: 2, amount: 1 }]), j(qp?.metadata))
    check('  …tagged as a USSD payment with the payer to text', qp?.metadata.kind === 'utility_order' && qp?.metadata.channel === 'ussd' && qp?.metadata.payer_msisdn === '233201234567' && qp?.metadata.session_id === 'S-SHOP')
    check('  …in the shape processUtilityDirectOrder reads',
        qp?.metadata.service === 'ecg' && qp?.metadata.account_number === '94415486839' && qp?.metadata.bill_amount === 50 && qp?.metadata.fee_amount === 0.5 && qp?.metadata.customer_phone === '0201234567')
    check('  …one provider call', lookupCalls.length === 1, `${lookupCalls.length}`)

    // A sub-agent's shop pays its upline too.
    seed(); r = await handleQuote(db, { ...ECG, sessionId: 'S-SUB' })
    const sp = verifyQuote(r.quote?.token)
    check("a sub-agent's shop sale adds its own mark-up AND its upline's (1% + 2% of 50 = 1.50): total 52.00",
        r.ok && r.quote.total === 52 && j(sp?.metadata.reseller_split.map((l: any) => [l.shop_id, l.amount])) === j([['s2', 0.5], ['sh1', 1]]) && sp?.metadata.reseller_fee_amount === 1.5, j(sp?.metadata.reseller_split))

    // The admin's total cap trims the furthest reseller first.
    seed({ utility_total_markup_cap_percent: '2' }); r = await handleQuote(db, { ...ECG, sessionId: 'S-SUB' })
    check('inside a 2% total cap (1% platform) only 1% is left for resellers: the sub keeps its 1%, the upline gets 0',
        r.ok && r.quote.total === 51 && verifyQuote(r.quote.token)?.metadata.reseller_split.length === 1, j(r.quote))

    // ── Pricing: a registered user ──────────────────────────────────────────────
    seed(); r = await handleQuote(db, { ...ECG, sessionId: 'S-MEMBER' })
    const mp = verifyQuote(r.quote?.token)
    check("a registered agent pays the AGENT fee (0.52% of 50 = 0.26): total 50.26, no shop mark-up",
        r.ok && r.quote.total === 50.26 && r.quote.fee === 0.26 && !mp?.metadata.shop_id && mp?.metadata.reseller_fee_amount === undefined, j(r.quote))
    check('  …account of record is the member themselves', mp?.uid === 'u-ama' && mp?.metadata.role === 'agent' && mp?.metadata.user_id === 'u-ama')

    // TV bill needs no phone.
    seed(); lookup = async () => ({ success: true, accountName: 'ABENA OWUSU' })
    r = await handleQuote(db, { action: 'quote', sessionId: 'S-SHOP', service: 'dstv', accountNumber: '4012345678', amount: 100 })
    check('a TV bill needs no phone and quotes 100 + 0.50 + 2.00 = 102.50', r.ok && r.quote.total === 102.5 && r.quote.accountName === 'ABENA OWUSU', j(r))

    // ── Switches ────────────────────────────────────────────────────────────────
    seed({ ussd_utilities_enabled: '__absent__' }); r = await handleQuote(db, { ...ECG, sessionId: 'S-SHOP' })
    check('OFF by default: without ussd_utilities_enabled nothing is quoted', !r.ok && r.field === 'fatal' && /USSD/.test(r.error) && lookupCalls.length === 0, j(r))
    seed({ ussd_utilities_enabled: 'false' }); r = await handleQuote(db, { ...ECG, sessionId: 'S-SHOP' })
    check("…and 'false' is off too", !r.ok && r.field === 'fatal')
    seed({ utility_public_launch: 'false' }); r = await handleQuote(db, { ...ECG, sessionId: 'S-SHOP' })
    check("the website's master launch switch applies (a customer owner cannot sell bills before launch)", !r.ok && r.field === 'fatal', j(r))
    seed({ utility_storefront_enabled: 'false' }); r = await handleQuote(db, { ...ECG, sessionId: 'S-SHOP' })
    const rm = await handleQuote(db, { ...ECG, sessionId: 'S-MEMBER' })
    check('closing storefront bills stops shop sales but not registered users (separate surfaces)', !r.ok && rm.ok, j({ shop: r, member: rm.ok }))
    seed({}, { shopUtilities: false }); r = await handleQuote(db, { ...ECG, sessionId: 'S-SHOP' })
    check('a shop that does not accept bills cannot sell them', !r.ok && r.field === 'fatal')
    seed({}, { memberStatus: 'suspended' }); r = await handleQuote(db, { ...ECG, sessionId: 'S-MEMBER' })
    check('a suspended member cannot', !r.ok && r.field === 'fatal')
    seed(); r = await handleQuote(db, { ...ECG, sessionId: 'S-HOUSE' })
    check('the house code has no account of record, so it cannot', !r.ok && r.field === 'fatal')
    r = await handleQuote(db, { ...ECG, sessionId: 'S-MISSING' })
    check('an unknown session cannot', !r.ok && r.field === 'fatal')
    seed(); r = await handleQuote(db, { ...ECG, sessionId: 'S-SHOP', service: 'ghanawater' })
    check('Ghana Water is not sold over USSD', !r.ok && r.field === 'fatal' && lookupCalls.length === 0)
    seed({ utility_enabled_ecg: 'false' }); r = await handleQuote(db, { ...ECG, sessionId: 'S-SHOP' })
    check('a service the admin turned off is refused with the website\'s message', !r.ok && /unavailable/i.test(r.error), j(r))

    // ── Cheap checks name the answer to re-ask ──────────────────────────────────
    seed()
    r = await handleQuote(db, { ...ECG, sessionId: 'S-SHOP', accountNumber: '12' })
    check('a malformed account is the ACCOUNT to re-ask, without a provider call', !r.ok && r.field === 'account' && lookupCalls.length === 0, j(r))
    r = await handleQuote(db, { ...ECG, sessionId: 'S-SHOP', phone: '123' })
    check('ECG with a bad phone is the PHONE to re-ask', !r.ok && r.field === 'phone' && lookupCalls.length === 0, j(r))
    r = await handleQuote(db, { ...ECG, sessionId: 'S-SHOP', amount: 5 })
    check('an amount under the admin minimum is the AMOUNT to re-ask (ECG min 10)', !r.ok && r.field === 'amount' && /10\.00/.test(r.error) && lookupCalls.length === 0, j(r))
    r = await handleQuote(db, { ...ECG, sessionId: 'S-SHOP', amount: 5000 })
    check('an amount over the maximum likewise (max 1000)', !r.ok && r.field === 'amount' && /1000\.00/.test(r.error), j(r))
    r = await handleQuote(db, { ...ECG, sessionId: 'S-SHOP', amount: 'abc' })
    check('a non-number amount is refused', !r.ok && r.field === 'amount')

    // ── The provider ────────────────────────────────────────────────────────────
    seed(); lookup = async () => ({ success: false, error: 'That meter could not be found.' })
    r = await handleQuote(db, { ...ECG, sessionId: 'S-SHOP' })
    check("a meter the provider rejects: its message, back to the account", !r.ok && r.field === 'account' && /could not be found/.test(r.error), j(r))

    seed(); lookup = async () => ({ success: true, accountName: 'SOMEONE ELSE', meters: [{ meterNumber: '11111111', label: 'SOMEONE ELSE (11111111)', balance: 0 }] })
    r = await handleQuote(db, { ...ECG, sessionId: 'S-SHOP' })
    check('an ECG meter not linked to that phone is refused (no first-time "unlinked" payment over USSD)', !r.ok && r.field === 'account' && /not linked/.test(r.error), j(r))

    seed(); lookup = () => new Promise(() => {}) // never answers
    const t0 = Date.now()
    r = await handleQuote(db, { ...ECG, sessionId: 'S-SHOP' })
    const waited = Date.now() - t0
    check('a provider that hangs ends in "try again" within ~5s, with nothing recorded',
        !r.ok && r.field === 'account' && /could not verify/i.test(r.error) && waited < 5600 && waited > 4800 && tables.wallet_payments.length === 0, `${waited}ms ${j(r)}`)

    // ── create ──────────────────────────────────────────────────────────────────
    seed()
    const quoted = await handleQuote(db, { ...ECG, sessionId: 'S-SHOP' })
    const REF = 'USSD-UTIL-ABC123-XYZ789'
    let c = await handleCreate(db, { sessionId: 'S-SHOP', reference: REF, token: quoted.quote.token })
    const row = tables.wallet_payments[0]
    check('confirming records ONE pending payment of exactly the quote', c.ok && c.amount === 51.5 && tables.wallet_payments.length === 1 && row.status === 'pending' && row.amount === 51.5 && row.total_amount === 51.5 && row.fee === 0, j({ c, row }))
    check('  …for the account of record, on the Paystack MoMo rail, under the USSD reference',
        row.user_id === 'u-kofi' && row.wallet_id === 'w-kofi' && row.provider === 'paystack_momo' && row.reference === REF)
    check('  …carrying the order for processUtilityDirectOrder', row.metadata.kind === 'utility_order' && row.metadata.service === 'ecg' && row.metadata.channel === 'ussd' && row.metadata.shop_id === 'sh1')

    c = await handleCreate(db, { sessionId: 'S-SHOP', reference: REF, token: quoted.quote.token })
    check('a repeated confirm finds the row it made and records nothing more', c.ok && c.amount === 51.5 && tables.wallet_payments.length === 1, j(c))

    seed({}, { noWallet: true })
    const q2 = await handleQuote(db, { ...ECG, sessionId: 'S-SHOP' })
    c = await handleCreate(db, { sessionId: 'S-SHOP', reference: 'USSD-UTIL-NEW000-AAA111', token: q2.quote.token })
    check('an owner who never had a wallet gets one', c.ok && tables.wallets.length === 1 && tables.wallet_payments[0].wallet_id === tables.wallets[0].id, j(tables.wallets))

    seed()
    const q3 = await handleQuote(db, { ...ECG, sessionId: 'S-SHOP' })
    c = await handleCreate(db, { sessionId: 'S-MEMBER', reference: REF, token: q3.quote.token })
    check("a quote cannot be used from a different session", !c.ok && c.field === 'fatal' && tables.wallet_payments.length === 0)
    c = await handleCreate(db, { sessionId: 'S-SHOP', reference: 'WRONG-PREFIX-1', token: q3.quote.token })
    check('a reference that is not a USSD-UTIL- reference is refused', !c.ok && tables.wallet_payments.length === 0)
    c = await handleCreate(db, { sessionId: 'S-SHOP', reference: REF, token: q3.quote.token.slice(0, -3) + 'abc' })
    check('a tampered quote is refused', !c.ok && tables.wallet_payments.length === 0)
    const [b3] = q3.quote.token.split('.')
    const expired = signQuote({ ...JSON.parse(Buffer.from(b3, 'base64url').toString()), exp: Date.now() - 1 })
    c = await handleCreate(db, { sessionId: 'S-SHOP', reference: REF, token: expired })
    check('an expired quote is refused ("please dial again")', !c.ok && /expired/.test(c.error) && tables.wallet_payments.length === 0, j(c))

    tables.admin_settings = tables.admin_settings.filter((s) => s.key !== 'ussd_utilities_enabled')
    c = await handleCreate(db, { sessionId: 'S-SHOP', reference: REF, token: q3.quote.token })
    check('switching utilities off between the quote and the confirm stops the payment', !c.ok && tables.wallet_payments.length === 0, j(c))

    seed()
    const q4 = await handleQuote(db, { ...ECG, sessionId: 'S-SHOP' })
    tables.wallet_payments.push({ id: 'x', reference: REF, user_id: 'someone-else', status: 'pending', amount: 1 })
    c = await handleCreate(db, { sessionId: 'S-SHOP', reference: REF, token: q4.quote.token })
    check("a reference already used by another account is refused", !c.ok && tables.wallet_payments.length === 1, j(c))

    console.log(`\n${passed} passed, ${failed} failed`)
    process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
