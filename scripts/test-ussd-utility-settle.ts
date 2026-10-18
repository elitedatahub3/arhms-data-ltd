/**
 * Test: what happens after a USSD bill is paid for
 * (lib/ussd-utility-settle.ts, lib/ussd-utility-sms.ts, and the hook in
 * lib/utility-order-completion.ts)
 *
 * The caller hung up the moment the MoMo prompt was sent, so nothing they see tells them how
 * the bill ended. Pins:
 *
 *   - a USSD bill payment is recognised by its payment RECORD (kind + channel), and nothing
 *     else is: a data order, a top-up or a web bill must never be mistaken for one;
 *   - it settles through processUtilityDirectOrder exactly once however many times the webhook
 *     and the sweep call, and never pays a bill the MoMo payment did not cover;
 *   - the caller is texted: "received" only while the bill is still in flight, and the final
 *     outcome (paid / refunded / failed) exactly once, from the one place a bill's state changes;
 *   - a refunded SHOP sale says the money went back to the shop and names it, because that is
 *     where it went; a registered user's says their wallet;
 *   - every text is ASCII, one SMS long, and never prints the full account number.
 *
 * No network, no database.
 *
 * Run (CommonJS is required for the require() hook below):
 *
 *   TS_NODE_COMPILER_OPTIONS='{"module":"commonjs","moduleResolution":"node"}' \
 *     npx ts-node --transpile-only scripts/test-ussd-utility-settle.ts
 *
 * Exit code: 0 = all pass, 1 = any fail
 */
import Module from 'module'
import path from 'path'

const REPO_ROOT = path.resolve(__dirname, '..')

type Row = Record<string, any>
let tables: Record<string, Row[]> = {}
const rpcCalls: Array<{ name: string; args: any }> = []

function builder(table: string) {
    const q: any = { op: 'select', filters: [] as Array<(r: Row) => boolean>, payload: null }
    const run = async () => {
        const rows = (tables[table] = tables[table] || [])
        const matched = rows.filter((r) => q.filters.every((f: any) => f(r)))
        if (q.op === 'update') { matched.forEach((r) => Object.assign(r, q.payload)); return { data: matched, error: null } }
        if (q.op === 'insert') { rows.push(...[].concat(q.payload).map((p: any) => ({ ...p }))); return { data: null, error: null } }
        return { data: matched, error: null }
    }
    const api: any = {
        select() { return api },
        update(p: any) { q.op = 'update'; q.payload = p; return api },
        insert(p: any) { q.op = 'insert'; q.payload = p; return api },
        eq(c: string, v: any) { q.filters.push((r: Row) => r[c] === v); return api },
        single: async () => { const r = await run(); return { data: r.data[0] ?? null, error: null } },
        maybeSingle: async () => { const r = await run(); return { data: r.data[0] ?? null, error: null } },
        then(res: any, rej: any) { return run().then(res, rej) },
        catch(fn: any) { return run().catch(fn) },
    }
    return api
}
const db: any = {
    from: (t: string) => builder(t),
    rpc: async (name: string, args: any) => { rpcCalls.push({ name, args }); return { error: null } },
}

const sms: Array<{ recipient: string; message: string }> = []
let settleResult: any = { success: true, order: { status: 'pending' } }
const settleCalls: Array<{ reference: string; userId?: string }> = []

const originalLoad = (Module as any)._load
;(Module as any)._load = function (request: string, parent: unknown, isMain: boolean) {
    if (request === '@/lib/hubtel-sms-service') {
        return { sendHubtelSMS: async (p: any) => { sms.push({ recipient: p.recipient, message: p.message }); return { success: true } } }
    }
    if (request === '@/lib/utility-order-payments') {
        return { processUtilityDirectOrder: async (reference: string, userId?: string) => { settleCalls.push({ reference, userId }); return typeof settleResult === 'function' ? settleResult() : settleResult } }
    }
    // For the finalizeUtilityOrder hook: its collaborators, none of which matter here.
    if (request === '@/lib/supabase') return { createServerClient: () => db }
    if (request === '@/lib/web-push') return { sendPushToUser: async () => {} }
    if (request === '@/lib/commission-earning') return { creditCommissionForOrder: async () => {} }
    if (request === '@/lib/utility-shop-earning') return { creditResellersForOrder: async () => {} }
    if (request === '@/lib/api-webhook') return { queueApiWebhook: async () => {} }
    if (request === '@/lib/hubtel-payment-service') {
        return { getDispatcher: () => undefined, buildHubtelBasicAuth: () => '', toHubtelMsisdn: (s: string) => s, describeHubtelNetworkFailure: () => '' }
    }
    if (request.startsWith('@/')) return originalLoad.apply(this, [path.join(REPO_ROOT, request.slice(2)), parent, isMain])
    return originalLoad.apply(this, [request, parent, isMain])
}

/* eslint-disable @typescript-eslint/no-var-requires */
const { findUssdUtilityPayment, settleUssdUtilityOrder } = require('@/lib/ussd-utility-settle')
const { composeUtilitySms, smsUssdUtilityPayer } = require('@/lib/ussd-utility-sms')
const { finalizeUtilityOrder } = require('@/lib/utility-order-completion')
/* eslint-enable @typescript-eslint/no-var-requires */

const REF = 'USSD-UTIL-ABCDEF-123456'
const shopMeta = {
    kind: 'utility_order', channel: 'ussd', service: 'ecg', account_number: '94415486839', bill_amount: 50,
    shop_id: 'sh1', shop_name: 'Kofi Store', payer_msisdn: '233201234567', session_id: 's1',
}
const memberMeta = { kind: 'utility_order', channel: 'ussd', service: 'dstv', account_number: '4012345678', bill_amount: 100, payer_msisdn: '233241234567', session_id: 's2' }

function seed(meta: Row = shopMeta, status = 'pending') {
    tables = {
        wallet_payments: [{ id: 'wp1', user_id: 'u-kofi', reference: REF, total_amount: 51.5, status, metadata: meta }],
        utility_orders: [],
    }
    sms.length = 0
    settleCalls.length = 0
    rpcCalls.length = 0
    settleResult = { success: true, order: { status: 'pending' } }
}

let passed = 0
let failed = 0
function check(name: string, ok: boolean, detail = '') {
    if (ok) { console.log(`  PASS  ${name}`); passed++ } else { console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ''}`); failed++ }
}

async function main() {
    console.error = () => {}
    console.log = ((orig) => (...a: any[]) => { if (typeof a[0] === 'string' && a[0].startsWith('[Ussd')) return; orig(...a) })(console.log)

    // ── Recognition ─────────────────────────────────────────────────────────────
    seed()
    check('a USSD bill payment is recognised by its record', (await findUssdUtilityPayment(db, REF))?.id === 'wp1')
    check('a reference without the USSD-UTIL- prefix is not', (await findUssdUtilityPayment(db, 'UTIL-WEB-1')) === null && (await findUssdUtilityPayment(db, 'USSD-DATA-ABCDEF-1')) === null)
    seed({ ...shopMeta, channel: 'web' })
    check('a bill record that is not a USSD one is not', (await findUssdUtilityPayment(db, REF)) === null)
    seed({ kind: 'ussd_member', channel: 'ussd' })
    check('a member data/checker/AFA payment is not mistaken for a bill', (await findUssdUtilityPayment(db, REF)) === null)
    seed({ kind: 'wallet_topup' })
    check('an ordinary top-up is not', (await findUssdUtilityPayment(db, REF)) === null)
    tables.wallet_payments = []
    check('a reference with no record is not', (await findUssdUtilityPayment(db, REF)) === null)

    // ── Settlement ──────────────────────────────────────────────────────────────
    seed()
    let payment = await findUssdUtilityPayment(db, REF)
    let r = await settleUssdUtilityOrder(db, { payment, reference: REF, amountPaid: 51.5 })
    check('a covered payment is settled through the website\'s bill payer, for the account of record', r.success && settleCalls.length === 1 && settleCalls[0].reference === REF && settleCalls[0].userId === 'u-kofi', JSON.stringify({ r, settleCalls }))
    check('  …and a bill still in flight gets one "received" text to the payer', sms.length === 1 && sms[0].recipient === '233201234567' && /received GHS 51\.50/.test(sms[0].message), JSON.stringify(sms))

    seed(); payment = await findUssdUtilityPayment(db, REF); settleResult = { success: true, order: { status: 'completed' } }
    r = await settleUssdUtilityOrder(db, { payment, reference: REF, amountPaid: 51.5 })
    check('a bill that completed immediately sends NO "received" text (the final one is sent when it finalises)', r.success && sms.length === 0, JSON.stringify(sms))

    seed(); payment = await findUssdUtilityPayment(db, REF); settleResult = { success: true, order: { status: 'refunded' } }
    r = await settleUssdUtilityOrder(db, { payment, reference: REF, amountPaid: 51.5 })
    check('…nor one refunded immediately', r.success && sms.length === 0)

    seed(); payment = await findUssdUtilityPayment(db, REF); settleResult = { success: true, alreadyProcessed: true }
    r = await settleUssdUtilityOrder(db, { payment, reference: REF, amountPaid: 51.5 })
    check('a repeat delivery (webhook then sweep) is a no-op: no text, still success', r.success && r.alreadyProcessed === true && sms.length === 0)

    seed(); payment = await findUssdUtilityPayment(db, REF)
    r = await settleUssdUtilityOrder(db, { payment, reference: REF, amountPaid: 40 })
    check('an UNDERPAYMENT pays nothing', !r.success && settleCalls.length === 0 && sms.length === 0, JSON.stringify(r))
    r = await settleUssdUtilityOrder(db, { payment, reference: REF, amountPaid: 51.46 })
    check('…but pesewa rounding (within 5p) is tolerated', r.success && settleCalls.length === 1)

    // The bill payer fails.
    seed(); payment = await findUssdUtilityPayment(db, REF)
    settleResult = () => { tables.wallet_payments[0].status = 'completed'; return { success: false, error: 'Could not create the bill payment order' } }
    r = await settleUssdUtilityOrder(db, { payment, reference: REF, amountPaid: 51.5 })
    check('if the money was taken but the order could not be made, the payer is told it failed', !r.success && sms.length === 1 && /could not be completed/.test(sms[0].message), JSON.stringify({ r, sms }))

    seed(); payment = await findUssdUtilityPayment(db, REF); settleResult = { success: false, error: 'Payment not found' }
    r = await settleUssdUtilityOrder(db, { payment, reference: REF, amountPaid: 51.5 })
    check('…but a failure BEFORE the claim (nothing taken) sends no text', !r.success && sms.length === 0, JSON.stringify(sms))

    // ── The words ───────────────────────────────────────────────────────────────
    const all = (['processing', 'completed', 'refunded', 'failed'] as const).flatMap((e) => [
        [`shop/${e}`, composeUtilitySms(e, shopMeta, 51.5, REF)],
        [`member/${e}`, composeUtilitySms(e, memberMeta, 100.5, REF)],
    ]) as Array<[string, string]>
    for (const [name, text] of all) {
        check(`${name}: ASCII, one SMS, never the full account number`,
            /^[\x20-\x7E]+$/.test(text) && text.length <= 160 && !text.includes('94415486839') && !text.includes('4012345678') && text.includes('****'),
            `${text.length}: ${text}`)
    }
    const refundedShop = composeUtilitySms('refunded', shopMeta, 51.5, REF)
    const refundedMember = composeUtilitySms('refunded', memberMeta, 100.5, REF)
    check("a refunded SHOP sale says the money went back to the shop, by name — that is where it went", /refunded to Kofi Store/.test(refundedShop) && /contact them/i.test(refundedShop), refundedShop)
    check("a refunded registered-user payment says their own wallet", /returned to your ARHMS wallet/.test(refundedMember) && !/contact them/i.test(refundedMember), refundedMember)
    check('a paid bill reports the BILL amount (what reached the meter), not the total charged', /GHS 50\.00/.test(composeUtilitySms('completed', shopMeta, 51.5, REF)))

    // ── The sender ──────────────────────────────────────────────────────────────
    seed()
    await smsUssdUtilityPayer(db, { reference: REF, event: 'completed' })
    check('the payer is texted at the number they paid from', sms.length === 1 && sms[0].recipient === '233201234567')
    seed(); await smsUssdUtilityPayer(db, { reference: 'UTIL-WEB-1', event: 'completed' })
    check('a web bill reference is ignored', sms.length === 0)
    seed({ ...shopMeta, channel: 'web' }); await smsUssdUtilityPayer(db, { reference: REF, event: 'completed' })
    check('a payment that is not a USSD one is ignored', sms.length === 0)
    seed({ ...shopMeta, payer_msisdn: undefined }); await smsUssdUtilityPayer(db, { reference: REF, event: 'completed' })
    check('a record with no payer number sends nothing (and does not throw)', sms.length === 0)

    // ── The one place a bill\'s state changes ───────────────────────────────────
    const order = (over: Row = {}) => ({ id: 'o1', user_id: 'u-kofi', service: 'ecg', account_number: '94415486839', bill_amount: 50, total_paid: 51.5, reference_code: REF, payment_status: 'paid', ...over })

    seed()
    tables.utility_orders = [order()]
    await finalizeUtilityOrder({ orderId: 'o1', status: 'completed', existingOrder: order() })
    check('a bill that completes texts the payer once', sms.length === 1 && /paid successfully/.test(sms[0].message), JSON.stringify(sms))

    seed(); tables.utility_orders = [order()]
    await finalizeUtilityOrder({ orderId: 'o1', status: 'failed', note: 'KingFlexy rejected it: Insufficient wallet balance.', refund: true, existingOrder: order() })
    check('a bill refused by the provider is refunded to the account of record AND the payer is told it went to the shop',
        rpcCalls.some((c) => c.name === 'credit_wallet_balance' && c.args.p_user_id === 'u-kofi' && c.args.p_amount === 51.5)
        && sms.length === 1 && /refunded to Kofi Store/.test(sms[0].message), JSON.stringify({ rpcCalls, sms }))

    seed(); tables.utility_orders = [order()]
    await finalizeUtilityOrder({ orderId: 'o1', status: 'failed', note: 'Timed out; may or may not have been paid.', refund: false, existingOrder: order() })
    check('a bill left failed WITHOUT a refund (state unknown) says the team is checking, and does not claim a refund', sms.length === 1 && /checking it/.test(sms[0].message) && !/refund/i.test(sms[0].message) && rpcCalls.length === 0, JSON.stringify({ sms, rpcCalls }))

    seed(); tables.utility_orders = [order({ reference_code: 'UTIL-WEB-0001' })]
    await finalizeUtilityOrder({ orderId: 'o1', status: 'completed', existingOrder: order({ reference_code: 'UTIL-WEB-0001' }) })
    check('a website bill is untouched by all this: no text', sms.length === 0)

    seed(); tables.utility_orders = [order()]
    await finalizeUtilityOrder({ orderId: 'o1', status: 'processing', existingOrder: order() })
    check('an interim "processing" update texts nobody (the "received" text covers it)', sms.length === 0)

    console.log(`\n${passed} passed, ${failed} failed`)
    process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
