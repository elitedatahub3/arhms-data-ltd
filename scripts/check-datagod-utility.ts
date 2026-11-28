/**
 * Offline checks for lib/datagod-utility-service.ts — the part of the Datagod bill
 * integration where a mistake costs money: which /pay failures are refundable, the
 * ECG meter-token pick, and the single PRICE_CHANGED retry.
 *
 * Run:  npx tsx --env-file=.env.local scripts/check-datagod-utility.ts
 *
 * fetch is mocked; no network calls are made and no money moves.
 */
process.env.DATAGOD_COMMISSION_KEY = 'dg2_live_offline_check'

let failures = 0
function check(name: string, actual: unknown, expected: unknown) {
    const a = JSON.stringify(actual)
    const e = JSON.stringify(expected)
    if (a === e) console.log(`  ok   ${name}`)
    else {
        failures++
        console.error(`  FAIL ${name}\n       expected ${e}\n       actual   ${a}`)
    }
}

const err = (status: number, message: string) => ({
    ok: false, status, data: { success: false, error: { code: status, message } },
})

type Route = (body: any) => { status: number; json: any }
let routes: Record<string, Route[]> = {}
let calls: { path: string; body: any }[] = []

;(globalThis as any).fetch = async (url: string, init: any) => {
    const path = new URL(url).pathname.replace(/^\/v2/, '')
    const key = `${init?.method || 'GET'} ${path.startsWith('/utilities/orders/') ? '/utilities/orders/*' : path}`
    const body = init?.body ? JSON.parse(init.body) : undefined
    calls.push({ path: key, body })
    const queue = routes[key]
    if (!queue?.length) throw new Error(`unexpected call ${key}`)
    const r = (queue.length > 1 ? queue.shift()! : queue[0])(body)
    return new Response(JSON.stringify(r.json), { status: r.status, headers: { 'content-type': 'application/json' } })
}

async function main() {
    const dg = await import('../lib/datagod-utility-service')

    console.log('classifyDgPayFailure')
    const cases: [number, string, boolean][] = [
        [400, 'INVALID_TOKEN: the verify_token is invalid or expired; nothing was charged. Verify the account again', true],
        [400, 'INVALID_AMOUNT: the amount is outside this biller\'s allowed range or precision; nothing was charged', true],
        [402, 'INSUFFICIENT_BALANCE: wallet balance is too low; nothing was charged.', true],
        [403, 'PHONE_NOT_VERIFIED: verify your account phone number in the dashboard to continue', true],
        [403, 'NOT_AVAILABLE: utility bills are not available on the API right now', true],
        [409, 'VERIFY_AGAIN: this verification can no longer be used; nothing was charged.', true],
        [409, 'PRICE_CHANGED: expected 120.00, current 120.50 (face_amount 120.00, customer_cashback 1.20).', true],
        [409, 'REQUEST_IN_PROGRESS: a request with this reference is still being processed', false],
        [409, 'OUTCOME_UNKNOWN: the outcome of an earlier request with this reference is not confirmed yet.', false],
        [409, 'REFERENCE_REUSED: reference already used for a different order', false],
        [500, 'OUTCOME_UNKNOWN: the outcome of this payment is not confirmed yet.', false],
        [500, 'INTERNAL_ERROR: the payment could not be started; nothing was charged', true],
        [500, 'Order could not be placed', false],
        [503, 'BILLER_UNAVAILABLE: this biller is currently unavailable; nothing was charged', true],
        [503, 'UNAVAILABLE: could not reserve this reference; nothing was charged. Retry with the same reference', true],
        [503, 'This API is currently unavailable', false],
    ]
    for (const [status, message, unpaid] of cases) {
        check(`${status} ${message.slice(0, 40)}`, dg.classifyDgPayFailure(err(status, message)).knownUnpaid, unpaid)
    }
    check('transport error is ambiguous', dg.classifyDgPayFailure({ ok: false, status: 0, data: null, transportError: 'timeout' }).knownUnpaid, false)

    console.log('parsePriceChangedCurrent')
    check('reads current', dg.parsePriceChangedCurrent(err(409, 'PRICE_CHANGED: expected 120.00, current 120.50 (face_amount 120.00)')), 120.5)

    console.log('buildDgLookupBody')
    check('dstv', dg.buildDgLookupBody({ service: 'dstv', accountNumber: '7012345678' }).body, { biller: 'dstv', account: '7012345678' })
    check('ecg list', dg.buildDgLookupBody({ service: 'ecg', accountNumber: 'G1', phone: '0241234567' }).body, { biller: 'ecg', phone: '0241234567' })
    check('ecg add_meter', dg.buildDgLookupBody({ service: 'ecg', accountNumber: '8000000701', phone: '0241234567', addMeter: true }).body,
        { biller: 'ecg', phone: '0241234567', account: '8000000701', add_meter: true })
    check('ghana water', dg.buildDgLookupBody({ service: 'ghanawater', accountNumber: '123456', phone: '0241234567', email: 'a@b.co' }).body,
        { biller: 'ghana_water', account: '123456', phone: '0241234567', email: 'a@b.co' })

    console.log('normaliseDgOrderStatus')
    check('completed + cashback', (({ status, commissionEarned }) => ({ status, commissionEarned }))(dg.normaliseDgOrderStatus({
        ok: true, status: 200, data: { success: true, data: { order: { status: 'completed', cashback: 1.2, face_amount: 120 }, claim: null } },
    })), { status: 'completed', commissionEarned: 1.2 })
    check('claim only = pending', dg.normaliseDgOrderStatus({
        ok: true, status: 200, data: { success: true, data: { order: null, claim: { reference: 'X', state: 'outcome_unknown' } } },
    }).status, 'pending')
    check('404 = notFound, not success', (({ success, notFound }) => ({ success, notFound }))(dg.normaliseDgOrderStatus(err(404, 'Order not found'))), { success: false, notFound: true })

    const okOrder = (ref: string, extra: any = {}) => ({
        status: 201,
        json: { success: true, data: { order: { reference: ref, status: 'pending', face_amount: 120, paid_amount: 120, cashback: 1.2, ...extra } } },
    })

    console.log('payUtilityBillViaDatagod: DSTV happy path')
    routes = {
        'POST /utilities/lookup': [() => ({ status: 200, json: { success: true, data: { customer_name: 'K M', amount_due: 120, verify_token: 'vt_a' } } })],
        'POST /utilities/pay': [b => okOrder(b.reference)],
    }
    calls = []
    let r = await dg.payUtilityBillViaDatagod({ service: 'dstv', accountNumber: '7012345678', amount: 120, reference: 'UTIL-1', maxCost: 122.4 })
    check('success', r.success, true)
    check('pay body', calls.find(c => c.path === 'POST /utilities/pay')?.body, { verify_token: 'vt_a', amount: 120, reference: 'UTIL-1', expected_pay: 120 })
    check('cashback', r.cashback, 1.2)
    check('supplierReference is ours', r.supplierReference, 'UTIL-1')

    console.log('payUtilityBillViaDatagod: ECG picks the matching meter token')
    routes = {
        'POST /utilities/lookup': [() => ({ status: 200, json: { success: true, data: { customer_name: null, amount_due: null, suggested_amount: 0, meters: [
            { meter: '8000000701', name: 'A', outstanding: 0, verify_token: 'vt_701' },
            { meter: '8000000702', name: 'B', outstanding: 0, verify_token: 'vt_702' },
        ] } } })],
        'POST /utilities/pay': [b => okOrder(b.reference)],
    }
    calls = []
    r = await dg.payUtilityBillViaDatagod({ service: 'ecg', accountNumber: '8000000702', phone: '0241234567', amount: 50, reference: 'UTIL-2' })
    check('used meter 702 token', calls.find(c => c.path === 'POST /utilities/pay')?.body?.verify_token, 'vt_702')

    console.log('payUtilityBillViaDatagod: ECG meter not on phone falls back to add_meter')
    routes = {
        'POST /utilities/lookup': [
            () => ({ status: 200, json: { success: true, data: { meters: [{ meter: '1', name: 'A', verify_token: 'vt_1' }] } } }),
            b => ({ status: 200, json: { success: true, data: { customer_name: 'New', verify_token: b.add_meter ? 'vt_direct' : 'wrong' } } }),
        ],
        'POST /utilities/pay': [b => okOrder(b.reference)],
    }
    calls = []
    r = await dg.payUtilityBillViaDatagod({ service: 'ecg', accountNumber: '999999', phone: '0241234567', amount: 50, reference: 'UTIL-3' })
    check('used add_meter token', calls.find(c => c.path === 'POST /utilities/pay')?.body?.verify_token, 'vt_direct')

    console.log('payUtilityBillViaDatagod: PRICE_CHANGED within what the customer paid → one retry')
    let lookups = 0
    routes = {
        'POST /utilities/lookup': [() => ({ status: 200, json: { success: true, data: { customer_name: 'K', verify_token: `vt_${++lookups}` } } })],
        'POST /utilities/pay': [
            () => ({ status: 409, json: err(409, 'PRICE_CHANGED: expected 120.00, current 120.50 (face_amount 120.00, customer_cashback 1.20)').data }),
            b => okOrder(b.reference),
        ],
    }
    calls = []
    r = await dg.payUtilityBillViaDatagod({ service: 'dstv', accountNumber: '7012345678', amount: 120, reference: 'UTIL-4', maxCost: 122.4 })
    const pays = calls.filter(c => c.path === 'POST /utilities/pay')
    check('success after retry', r.success, true)
    check('second pay uses new price + fresh token', { e: pays[1]?.body?.expected_pay, t: pays[1]?.body?.verify_token, ref: pays[1]?.body?.reference }, { e: 120.5, t: 'vt_2', ref: 'UTIL-4' })

    console.log('payUtilityBillViaDatagod: PRICE_CHANGED above what the customer paid → refused, refundable')
    routes = {
        'POST /utilities/lookup': [() => ({ status: 200, json: { success: true, data: { customer_name: 'K', verify_token: 'vt' } } })],
        'POST /utilities/pay': [() => ({ status: 409, json: err(409, 'PRICE_CHANGED: expected 120.00, current 130.00 (x)').data })],
    }
    calls = []
    r = await dg.payUtilityBillViaDatagod({ service: 'dstv', accountNumber: '7012345678', amount: 120, reference: 'UTIL-5', maxCost: 122.4 })
    check('refused + knownUnpaid', { s: r.success, u: r.knownUnpaid, pays: calls.filter(c => c.path === 'POST /utilities/pay').length }, { s: false, u: true, pays: 1 })

    console.log('payUtilityBillViaDatagod: 409 OUTCOME_UNKNOWN is NOT refundable')
    routes = {
        'POST /utilities/lookup': [() => ({ status: 200, json: { success: true, data: { customer_name: 'K', verify_token: 'vt' } } })],
        'POST /utilities/pay': [() => ({ status: 409, json: err(409, 'OUTCOME_UNKNOWN: not confirmed yet').data })],
    }
    r = await dg.payUtilityBillViaDatagod({ service: 'dstv', accountNumber: '7012345678', amount: 120, reference: 'UTIL-6' })
    check('ambiguous', { s: r.success, u: r.knownUnpaid }, { s: false, u: false })

    console.log('payUtilityBillViaDatagod: 402 flags low wallet, refundable')
    routes = {
        'POST /utilities/lookup': [() => ({ status: 200, json: { success: true, data: { customer_name: 'K', verify_token: 'vt' } } })],
        'POST /utilities/pay': [() => ({ status: 402, json: err(402, 'INSUFFICIENT_BALANCE: wallet balance is too low; nothing was charged.').data })],
    }
    r = await dg.payUtilityBillViaDatagod({ service: 'dstv', accountNumber: '7012345678', amount: 120, reference: 'UTIL-7' })
    check('402', { u: r.knownUnpaid, low: r.insufficientBalance }, { u: true, low: true })

    console.log('payUtilityBillViaDatagod: failed lookup sends nothing to /pay')
    routes = { 'POST /utilities/lookup': [() => ({ status: 502, json: err(502, 'LOOKUP_FAILED: the biller could not verify this account').data })] }
    calls = []
    r = await dg.payUtilityBillViaDatagod({ service: 'dstv', accountNumber: '7012345678', amount: 120, reference: 'UTIL-8' })
    check('no pay call, refundable', { pays: calls.filter(c => c.path === 'POST /utilities/pay').length, u: r.knownUnpaid }, { pays: 0, u: true })

    console.log(failures ? `\n${failures} FAILED` : '\nall passed')
    process.exit(failures ? 1 : 0)
}

main().catch(e => { console.error(e); process.exit(1) })
