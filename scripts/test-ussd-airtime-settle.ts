/**
 * Test: what happens after airtime is paid for over USSD
 * (lib/ussd-airtime-settle.ts, plus the two hooks that text the payer:
 * lib/airtime-fulfillment-dispatcher.ts and lib/airtime-order-completion.ts)
 *
 * The caller hung up the moment the MoMo prompt was sent. Airtime has no automatic refund — an
 * order the provider refuses is left "pending" for an admin, and the dispatcher tells nobody
 * else — so without these texts a caller whose top-up never arrived would hear nothing. Pins:
 *
 *   - a USSD airtime payment is recognised by its RECORD (kind + channel + prefix) and nothing
 *     else is: a bill, a data order or a top-up must never be mistaken for one;
 *   - it settles through the website's processAirtimeDirectOrder, never buys airtime the MoMo
 *     payment did not cover, and is a no-op on a repeat delivery;
 *   - an order held for an admin texts the payer "taking longer than expected" ONCE, however many
 *     times the order is re-dispatched; a final failure and a completion text them too — except
 *     that a payer who is also the beneficiary is not texted twice for a completion;
 *   - every text is ASCII, one SMS long, and never prints the full phone number.
 *
 * No network, no database.
 *
 * Run (CommonJS is required for the require() hook below):
 *
 *   TS_NODE_COMPILER_OPTIONS='{"module":"commonjs","moduleResolution":"node"}' \
 *     npx ts-node --transpile-only scripts/test-ussd-airtime-settle.ts
 *
 * Exit code: 0 = all pass, 1 = any fail
 */
import Module from 'module'
import path from 'path'

const REPO_ROOT = path.resolve(__dirname, '..')

type Row = Record<string, any>
let tables: Record<string, Row[]> = {}

function builder(table: string) {
    const q: any = { op: 'select', filters: [] as Array<(r: Row) => boolean>, payload: null }
    const run = async () => {
        const rows = (tables[table] = tables[table] || [])
        const matched = rows.filter((r) => q.filters.every((f: any) => f(r)))
        if (q.op === 'update') { matched.forEach((r) => Object.assign(r, q.payload)); return { data: matched, error: null } }
        if (q.op === 'insert') {
            const added = [].concat(q.payload).map((p: any, i: number) => ({ id: `${table}-${rows.length + i + 1}`, ...p }))
            rows.push(...added)
            return { data: added, error: null }
        }
        return { data: matched, error: null }
    }
    const api: any = {
        select() { return api },
        update(p: any) { q.op = 'update'; q.payload = p; return api },
        insert(p: any) { q.op = 'insert'; q.payload = p; return api },
        eq(c: string, v: any) { q.filters.push((r: Row) => r[c] === v); return api },
        in(c: string, vs: any[]) { q.filters.push((r: Row) => vs.includes(r[c])); return api },
        // The one shape the code uses: metadata->>delayed_sms_at.is.null
        or(expr: string) {
            const key = expr.match(/metadata->>(\w+)\.is\.null/)?.[1]
            if (key) q.filters.push((r: Row) => r.metadata?.[key] == null)
            return api
        },
        single: async () => { const r = await run(); return { data: r.data[0] ?? null, error: null } },
        maybeSingle: async () => { const r = await run(); return { data: r.data[0] ?? null, error: null } },
        then(res: any, rej: any) { return run().then(res, rej) },
        catch(fn: any) { return run().catch(fn) },
    }
    return api
}
const db: any = { from: (t: string) => builder(t), rpc: async () => ({ error: null }) }

const sms: Array<{ recipient: string; message: string }> = []
const adminPushes: string[] = []
let settleResult: any = { success: true }
const settleCalls: Array<{ reference: string; userId?: string }> = []
let purchaseResult: any = { success: false, error: 'Insufficient wallet balance', knownUnpaid: true }

const originalLoad = (Module as any)._load
;(Module as any)._load = function (request: string, parent: unknown, isMain: boolean) {
    if (request === '@/lib/airtime-order-payments') {
        return { processAirtimeDirectOrder: async (reference: string, userId?: string) => { settleCalls.push({ reference, userId }); return typeof settleResult === 'function' ? settleResult() : settleResult } }
    }
    if (request === '@/lib/airtime-provider') {
        return { purchaseAirtime: async () => purchaseResult, AIRTIME_PROVIDER: 'kingflexy' }
    }
    if (request === '@/lib/supabase') return { createServerClient: () => db }
    if (request === '@/lib/web-push') {
        return { sendPushToUser: async () => {}, sendPushToAdmins: async (p: any) => { adminPushes.push(p.title) } }
    }
    if (request === '@/lib/api-webhook') return { queueApiWebhook: async () => {} }
    // The platform's house sender: what the payer notices go through.
    if (request === '@/lib/sms-service') {
        return {
            sendSMS: async (p: any) => { sms.push({ recipient: p.recipient, message: p.message }); return { success: true } },
            sendAirtimeCompletedSMS: async () => {},
        }
    }
    if (request === '@/lib/sms/platform-order-sms') return { sendPlatformOrderSms: async () => {} }
    if (request === '@/lib/sms/order-confirmations') return { sendShopOrderConfirmation: async () => ({ sent: false, skipped: 'stub' }) }
    if (request.startsWith('@/')) return originalLoad.apply(this, [path.join(REPO_ROOT, request.slice(2)), parent, isMain])
    return originalLoad.apply(this, [request, parent, isMain])
}

/* eslint-disable @typescript-eslint/no-var-requires */
const { findUssdAirtimePayment, settleUssdAirtimeOrder, composeAirtimeSms, smsUssdAirtimePayer } = require('@/lib/ussd-airtime-settle')
const { finalizeAirtimeOrder } = require('@/lib/airtime-order-completion')
const { triggerAirtimeFulfillment } = require('@/lib/airtime-fulfillment-dispatcher')
/* eslint-enable @typescript-eslint/no-var-requires */

const REF = 'USSD-AIR-ABCDEF-123456'
const meta = {
    kind: 'airtime_order', channel: 'ussd', network: 'MTN', beneficiary_phone: '0241234567', airtime_amount: 10,
    fee_amount: 0.3, payer_msisdn: '233201234567', session_id: 's1', role: 'agent',
}

function seed(m: Row = meta, status = 'pending') {
    tables = {
        wallet_payments: [{ id: 'wp1', user_id: 'u-ama', reference: REF, total_amount: 10.3, status, metadata: { ...m } }],
        airtime_orders: [],
        admin_settings: [{ key: 'airtime_auto_fulfillment_enabled', value: 'true' }, { key: 'airtime_auto_mtn', value: 'true' }],
        airtime_fulfillment_legs: [],
    }
    sms.length = 0; adminPushes.length = 0; settleCalls.length = 0
    settleResult = { success: true }
    purchaseResult = { success: false, error: 'Insufficient wallet balance', knownUnpaid: true }
}
const order = (over: Row = {}) => ({
    id: 'o1', user_id: 'u-ama', status: 'pending', type: 'airtime', network: 'MTN', beneficiary_phone: '0241234567',
    airtime_amount: 10, total_paid: 10.3, reference_code: REF, ...over,
})

let passed = 0
let failed = 0
function check(name: string, ok: boolean, detail = '') {
    if (ok) { console.log(`  PASS  ${name}`); passed++ } else { console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ''}`); failed++ }
}

async function main() {
    console.error = () => {}
    console.log = ((orig) => (...a: any[]) => { if (typeof a[0] === 'string' && /^\[(Ussd|Airtime)/.test(a[0])) return; orig(...a) })(console.log)

    // ── Recognition ─────────────────────────────────────────────────────────────
    seed()
    check('a USSD airtime payment is recognised by its record', (await findUssdAirtimePayment(db, REF))?.id === 'wp1')
    check('a website airtime reference (AIRPAY-) is not', (await findUssdAirtimePayment(db, 'AIRPAY-ABC-1')) === null)
    check('nor a USSD bill or data reference', (await findUssdAirtimePayment(db, 'USSD-UTIL-ABCDEF-1')) === null && (await findUssdAirtimePayment(db, 'USSD-DATA-ABCDEF-1')) === null)
    seed({ ...meta, channel: 'web' })
    check('an airtime record that is not a USSD one is not', (await findUssdAirtimePayment(db, REF)) === null)
    seed({ ...meta, kind: 'utility_order' })
    check('a bill record under an airtime-looking reference is not', (await findUssdAirtimePayment(db, REF)) === null)
    seed({ kind: 'ussd_member', channel: 'ussd' })
    check('a member data/checker/AFA payment is not', (await findUssdAirtimePayment(db, REF)) === null)
    tables.wallet_payments = []
    check('a reference with no record is not', (await findUssdAirtimePayment(db, REF)) === null)

    // ── Settlement ──────────────────────────────────────────────────────────────
    seed(); let payment = await findUssdAirtimePayment(db, REF)
    let r = await settleUssdAirtimeOrder(db, { payment, reference: REF, amountPaid: 10.3 })
    check("a covered payment is settled through the website's airtime buyer, for the member", r.success && settleCalls.length === 1 && settleCalls[0].reference === REF && settleCalls[0].userId === 'u-ama', JSON.stringify({ r, settleCalls }))
    check('  …with no extra text (the buyer already texts the beneficiary)', sms.length === 0)

    seed(); payment = await findUssdAirtimePayment(db, REF)
    r = await settleUssdAirtimeOrder(db, { payment, reference: REF, amountPaid: 5 })
    check('an UNDERPAYMENT buys nothing', !r.success && settleCalls.length === 0 && sms.length === 0, JSON.stringify(r))
    r = await settleUssdAirtimeOrder(db, { payment, reference: REF, amountPaid: 10.26 })
    check('…but pesewa rounding (within 5p) is tolerated', r.success && settleCalls.length === 1)

    seed(); payment = await findUssdAirtimePayment(db, REF); settleResult = { success: true, alreadyProcessed: true }
    r = await settleUssdAirtimeOrder(db, { payment, reference: REF, amountPaid: 10.3 })
    check('a repeat delivery (webhook then sweep) is a no-op: success, flagged, no text', r.success && r.alreadyProcessed === true && sms.length === 0)

    seed(); payment = await findUssdAirtimePayment(db, REF)
    settleResult = () => { tables.wallet_payments[0].status = 'completed'; return { success: false, error: 'Could not create the airtime order' } }
    r = await settleUssdAirtimeOrder(db, { payment, reference: REF, amountPaid: 10.3 })
    check('if the money was taken but the order could not be made, the payer is told it went back to their wallet',
        !r.success && sms.length === 1 && /returned to your ARHMS wallet/.test(sms[0].message), JSON.stringify({ r, sms }))

    seed(); payment = await findUssdAirtimePayment(db, REF); settleResult = { success: false, error: 'Payment not found' }
    r = await settleUssdAirtimeOrder(db, { payment, reference: REF, amountPaid: 10.3 })
    check('…but a failure BEFORE the claim (nothing taken) sends no text', !r.success && sms.length === 0)

    // ── The words ───────────────────────────────────────────────────────────────
    for (const event of ['completed', 'delayed', 'failed', 'refunded'] as const) {
        const text = composeAirtimeSms(event, meta, 10.3, REF)
        check(`${event}: ASCII, one SMS, never the full number`, /^[\x20-\x7E]+$/.test(text) && text.length <= 160 && !text.includes('0241234567') && text.includes('****4567'), `${text.length}: ${text}`)
    }
    check('"delayed" does not promise money back', !/refund|returned/i.test(composeAirtimeSms('delayed', meta, 10.3, REF)) && /checking it/.test(composeAirtimeSms('delayed', meta, 10.3, REF)))
    check('"completed" reports the AIRTIME amount sent, not the total charged', /GHS 10\.00 MTN airtime was sent/.test(composeAirtimeSms('completed', meta, 10.3, REF)))

    // ── The sender ──────────────────────────────────────────────────────────────
    seed(); await smsUssdAirtimePayer(db, { reference: REF, event: 'failed' })
    check('the payer is texted at the number they paid from', sms.length === 1 && sms[0].recipient === '233201234567')
    seed(); await smsUssdAirtimePayer(db, { reference: 'AIRPAY-WEB-1', event: 'failed' })
    check('a website airtime reference is ignored', sms.length === 0)
    seed({ ...meta, channel: 'web' }); await smsUssdAirtimePayer(db, { reference: REF, event: 'failed' })
    check('a payment that is not a USSD one is ignored', sms.length === 0)
    seed({ ...meta, payer_msisdn: undefined }); await smsUssdAirtimePayer(db, { reference: REF, event: 'failed' })
    check('a record with no payer number sends nothing (and does not throw)', sms.length === 0)

    seed({ ...meta, payer_msisdn: '233241234567' }); await smsUssdAirtimePayer(db, { reference: REF, event: 'completed' })
    check('a payer who IS the beneficiary is not texted for a completion (the beneficiary text covers it)', sms.length === 0, JSON.stringify(sms))
    seed(); await smsUssdAirtimePayer(db, { reference: REF, event: 'completed' })
    check('…a payer topping up someone else IS', sms.length === 1 && /was sent to \*\*\*\*4567/.test(sms[0].message))
    seed({ ...meta, payer_msisdn: '233241234567' }); await smsUssdAirtimePayer(db, { reference: REF, event: 'failed' })
    check('…but a failure always reaches the payer, even when they are the beneficiary', sms.length === 1)

    seed()
    await smsUssdAirtimePayer(db, { reference: REF, event: 'delayed' })
    await smsUssdAirtimePayer(db, { reference: REF, event: 'delayed' })
    await smsUssdAirtimePayer(db, { reference: REF, event: 'delayed' })
    check('"delayed" is sent ONCE however many times it is asked for (the rescue sweep re-dispatches)', sms.length === 1, `${sms.length}`)
    check('  …and the claim is recorded on the payment', !!tables.wallet_payments[0].metadata.delayed_sms_at && tables.wallet_payments[0].metadata.kind === 'airtime_order')

    // ── The hooks ───────────────────────────────────────────────────────────────
    seed(); tables.airtime_orders = [order()]
    await finalizeAirtimeOrder({ orderId: 'o1', status: 'completed', existingOrder: order({ beneficiary_phone: '0551234567' }) })
    check('a completed top-up for SOMEONE ELSE texts the payer once', sms.length === 1 && /was sent to/.test(sms[0].message), JSON.stringify(sms))

    seed({ ...meta, beneficiary_phone: '0201234567' }); tables.airtime_orders = [order({ beneficiary_phone: '0201234567' })]
    await finalizeAirtimeOrder({ orderId: 'o1', status: 'completed', existingOrder: order({ beneficiary_phone: '0201234567' }) })
    check('a completed top-up to the payer\'s own number texts no extra message from here', sms.length === 0, JSON.stringify(sms))

    seed(); tables.airtime_orders = [order()]
    await finalizeAirtimeOrder({ orderId: 'o1', status: 'failed', note: 'KingFlexy refused.', existingOrder: order() })
    check('a top-up marked failed texts the payer to contact support', sms.length === 1 && /could not be completed/.test(sms[0].message) && /contact support/.test(sms[0].message), JSON.stringify(sms))

    seed(); tables.airtime_orders = [order()]
    await finalizeAirtimeOrder({ orderId: 'o1', status: 'processing', existingOrder: order() })
    check('an interim "processing" update texts nobody', sms.length === 0)

    seed(); tables.airtime_orders = [order({ reference_code: 'GHD-WEB-0001' })]
    await finalizeAirtimeOrder({ orderId: 'o1', status: 'failed', note: 'x', existingOrder: order({ reference_code: 'GHD-WEB-0001' }) })
    check('a website airtime order is untouched by all this: no text', sms.length === 0)

    // The dispatcher: the provider refuses, the order is held for an admin, and the payer is told.
    seed(); tables.airtime_orders = [order()]
    let res = await triggerAirtimeFulfillment('o1')
    check('a top-up the provider REFUSES is held for an admin and the payer is told, once, that it is taking longer',
        res.dispatched === false && adminPushes.length === 1 && sms.length === 1 && /taking longer than expected/.test(sms[0].message) && sms[0].recipient === '233201234567', JSON.stringify({ res, adminPushes, sms }))
    tables.airtime_fulfillment_legs = [] // the rescue sweep dispatches the same order again
    res = await triggerAirtimeFulfillment('o1')
    check('  …and a re-dispatch halts again but does NOT text again', adminPushes.length === 2 && sms.length === 1, JSON.stringify({ adminPushes, sms: sms.length }))

    seed(); tables.airtime_orders = [order({ reference_code: 'GHD-WEB-0002' })]
    await triggerAirtimeFulfillment('o1')
    check('a website order that is refused still alerts the admins but texts no payer', adminPushes.length === 1 && sms.length === 0, JSON.stringify({ adminPushes, sms }))

    console.log(`\n${passed} passed, ${failed} failed`)
    process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => { process.stderr.write(`${e?.stack || e}\n`); process.exit(1) })
