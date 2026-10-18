/**
 * Test: confirmation SMS for main-site orders bought over USSD
 *
 * The rule (the SMS Platform's "Use my sender ID for order confirmations"): a main-site order is
 * confirmed to the recipient from the HOUSE sender by default — it must always work — but when the
 * BUYER has switched that on, from the buyer's OWN approved sender ID, paid from the buyer's SMS
 * credits. Whenever the buyer's sender cannot be used the house message goes out instead, so a
 * recipient is never left without a confirmation.
 *
 * lib/sms/platform-order-sms.ts implements the rule; what USSD has to get right is that every order
 * it places reaches it as the BUYER'S order. This runs the real code for the three USSD paths that
 * confirm to a recipient, end to end:
 *
 *   data      settleMemberUssdOrder -> purchaseDataWithWallet -> triggerFulfillment
 *   airtime   settleUssdAirtimeOrder -> processAirtimeDirectOrder
 *   AFA       settleMemberUssdOrder -> process_afa_order, then the applicant is confirmed
 *
 * with the real sendPlatformOrderSms in each, through every case that matters: the switch off, on,
 * no approved sender, out of credits, a network that refuses, a replay, and a SHOP order (which must
 * never use the buyer's sender). The gateways, the database and the supplier are stubbed.
 *
 * Run (CommonJS is required for the require() hook below):
 *
 *   TS_NODE_COMPILER_OPTIONS='{"module":"commonjs","moduleResolution":"node"}' \
 *     npx ts-node --transpile-only scripts/test-ussd-confirmation-sms.ts
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
let smsBalance = 100
let idCounter = 0

function builder(table: string) {
    const q: any = { op: 'select', filters: [] as Array<(r: Row) => boolean>, payload: null, head: false, limit: Infinity }
    const run = async () => {
        const rows = (tables[table] = tables[table] || [])
        const matched = rows.filter((r) => q.filters.every((f: any) => f(r)))
        if (q.op === 'insert') {
            const added = [].concat(q.payload).map((p: any) => ({ id: `${table}-${++idCounter}`, ...p }))
            rows.push(...added)
            return { data: added, error: null }
        }
        if (q.op === 'update') { matched.forEach((r) => Object.assign(r, q.payload)); return { data: matched, error: null } }
        if (q.op === 'delete') { tables[table] = rows.filter((r) => !matched.includes(r)); return { data: matched, error: null } }
        if (q.head) return { data: null, count: matched.length, error: null }
        return { data: matched.slice(0, q.limit), error: null }
    }
    const api: any = {
        select(_c?: string, opts?: any) { if (opts?.head) q.head = true; return api },
        insert(p: any) { q.op = 'insert'; q.payload = p; return api },
        update(p: any) { q.op = 'update'; q.payload = p; return api },
        delete() { q.op = 'delete'; return api },
        eq(c: string, v: any) { q.filters.push((r: Row) => r[c] === v); return api },
        in(c: string, vs: any[]) { q.filters.push((r: Row) => vs.includes(r[c])); return api },
        not() { return api },
        is(c: string, v: any) { q.filters.push((r: Row) => (r[c] ?? null) === v); return api },
        // metadata->>purchase_claimed_at.is.null,metadata->>purchase_claimed_at.lt.<iso>
        or(expr: string) {
            const lt = expr.match(/purchase_claimed_at\.lt\.(.+)$/)?.[1]
            q.filters.push((r: Row) => {
                const at = r.metadata?.purchase_claimed_at
                return at == null || (lt !== undefined && String(at) < lt)
            })
            return api
        },
        order() { return api },
        limit(n: number) { q.limit = n; return api },
        single: async () => { const r = await run(); const row = r.data?.[0]; return row ? { data: row, error: null } : { data: null, error: { code: 'PGRST116' } } },
        maybeSingle: async () => { const r = await run(); return { data: r.data?.[0] ?? null, error: null } },
        then(res: any, rej: any) { return run().then(res, rej) },
        catch(fn: any) { return run().catch(fn) },
    }
    return api
}

const db: any = {
    from: (t: string) => builder(t),
    rpc: async (name: string, args: any) => {
        if (name === 'debit_sms_credits') {
            if (smsBalance < args.p_amount) return { data: null, error: { message: 'INSUFFICIENT_CREDITS' } }
            smsBalance -= args.p_amount
            return { data: null, error: null }
        }
        if (name === 'credit_sms_credits') { smsBalance += args.p_amount; return { data: null, error: null } }
        if (name === 'deduct_wallet_balance') return { data: [{ wallet_id: 'w1', new_balance: 50 }], error: null }
        return { data: null, error: null }
    },
}

// ── What went out, and the knobs ────────────────────────────────────────────────
const house: Array<{ via: string; recipient: string; message: string }> = []
const own: Array<{ sender: string; recipient: string; message: string }> = []
let gateway: 'kingflexy' | 'moolre' = 'kingflexy'
let kingflexyConfigured = true
let dispatchSent = 1
let senders: Array<{ type: string; sender: string; isDefault?: boolean }> = []

const originalLoad = (Module as any)._load
;(Module as any)._load = function (request: string, parent: unknown, isMain: boolean) {
    if (request === '@/lib/supabase') return { createServerClient: () => db }
    if (request === '@/lib/sms-service') {
        const noop = async () => {}
        return {
            normalizeGhanaPhone: (phone: string) => {
                let p = phone.replace(/\s+/g, '').replace(/-/g, '').replace(/\+/g, '')
                if (p.startsWith('0') && p.length === 10) p = '233' + p.slice(1)
                if (!p.startsWith('233') || p.length !== 12) return null
                return p
            },
            getActiveSmsProvider: async () => gateway,
            // The house sender, however a caller reaches it.
            sendSMS: async (o: any) => { house.push({ via: 'sendSMS', recipient: o.recipient, message: o.message }); return { success: true } },
            sendMtnOrderReceivedSMS: async (to: string, d: any) => { house.push({ via: 'data', recipient: to, message: `received ${d.network} ${d.size}` }); return { success: true } },
            sendAtInstantDeliverySMS: async (to: string, d: any) => { house.push({ via: 'data-at', recipient: to, message: `instant ${d.network} ${d.size}` }); return { success: true } },
            sendAirtimeBeneficiarySMS: async (to: string, amount: number) => { house.push({ via: 'airtime', recipient: to, message: `airtime ${amount}` }); return { success: true } },
            sendAirtimeCompletedSMS: noop,
            sendAdminAgentOrderAlert: noop,
        }
    }
    if (request === '@/lib/kingflexy-sms-service') return { isKingFlexySmsConfigured: () => kingflexyConfigured }
    if (request === '@/lib/sms/customer-sms') {
        return {
            getAllowedSenders: async () => senders,
            // Where a message goes out under the buyer's own sender.
            dispatchCampaignBatch: async (_db: any, campaignId: string) => {
                const campaign = (tables.sms_campaigns || []).find((c) => c.id === campaignId)
                const message = (tables.sms_messages || []).find((m) => m.campaign_id === campaignId)
                if (dispatchSent > 0 && campaign && message) own.push({ sender: campaign.sender_used, recipient: message.recipient, message: campaign.message })
                return { sent: dispatchSent }
            },
            settleCampaignIfDone: async () => {},
        }
    }
    if (request === '@/lib/web-push') return { sendPushToUser: async () => {}, sendPushToAdmins: async () => {} }
    if (request === '@/lib/email-service') return { sendAdminNewOrderAlert: async () => {}, sendOrderSuccessEmail: async () => {} }
    if (request === '@/lib/shop-service') return { syncShopOrderStatus: async () => {}, creditShopRcProfit: async () => ({ credited: true }) }
    if (request === '@/lib/order-update-fallback') {
        return { updateOrderWithColumnFallback: async (_db: any, table: string, where: any, update: any) => { await db.from(table).update(update).eq(where.column, where.value) } }
    }
    if (request === '@/lib/supplier-router') {
        return {
            fulfillWithFallback: async () => ({ status: 'placed', supplier: { id: 'dakazina' }, result: { success: true, transactionId: 'T1', apiResponse: {} }, attempts: [], fellBack: false, reference: 'R1' }),
            ordersStamp: () => ({}), optionalStampKeys: () => [], failureReason: () => '', describeAttempts: () => '',
        }
    }
    if (request === '@/lib/airtime-fulfillment-dispatcher') return { triggerAirtimeFulfillment: async () => ({ dispatched: true }) }
    if (request === '@/lib/payments') {
        return {
            // The credit step: claims the pending payment, as the real one does.
            processCompletedWalletPayment: async (reference: string) => {
                const row = (tables.wallet_payments || []).find((r) => r.reference === reference)
                if (!row) return { success: false, error: 'Payment not found' }
                if (row.status === 'pending') row.status = 'completed'
                return { success: true }
            },
        }
    }
    if (request === '@/lib/vouchers/checkout') return { purchaseWithWallet: async () => ({}) }
    if (request === '@/lib/afa/checkout') return { notifyAdminsOfAfaApplication: async () => {} }
    if (request.startsWith('@/')) return originalLoad.apply(this, [path.join(REPO_ROOT, request.slice(2)), parent, isMain])
    return originalLoad.apply(this, [request, parent, isMain])
}

/* eslint-disable @typescript-eslint/no-var-requires */
const { settleMemberUssdOrder, findMemberPayment } = require('@/lib/ussd-member-settle')
const { settleUssdAirtimeOrder, findUssdAirtimePayment } = require('@/lib/ussd-airtime-settle')
const { triggerFulfillment } = require('@/lib/order-fulfillment-dispatcher')
const { sendPlatformOrderSms } = require('@/lib/sms/platform-order-sms')
/* eslint-enable @typescript-eslint/no-var-requires */

// ── The three USSD orders ───────────────────────────────────────────────────────
const BUYER = 'u-buyer'
const RECIPIENT = '0551234567'          // somebody else's number: the confirmation goes to THEM
const OWN_SENDER = 'MyBrand'

interface Setup { toggle: boolean | 'absent'; accountStatus?: string; ownSender?: boolean; credits?: number }

function seedAccount(s: Setup) {
    tables.sms_accounts = s.toggle === 'absent' ? [] : [{ id: 'acc1', user_id: BUYER, status: s.accountStatus ?? 'active', platform_order_sms_enabled: s.toggle === true }]
    senders = s.ownSender === false ? [{ type: 'house', sender: 'ArhmsTech', isDefault: true }] : [{ type: 'house', sender: 'ArhmsTech' }, { type: 'own', sender: OWN_SENDER, isDefault: true }]
    smsBalance = s.credits ?? 100
}

function seedCommon(s: Setup) {
    tables = {
        users: [{ id: BUYER, role: 'agent', status: 'active', email: 'b@x.com', first_name: 'Ama', last_name: 'B' }],
        sub_agents: [],
        wallets: [{ id: 'w1', user_id: BUYER }],
        wallet_payments: [], orders: [], airtime_orders: [], mtn_fulfillment_tracking: [], notifications: [], wallet_transactions: [],
        phone_blacklist: [], sms_campaigns: [], sms_messages: [], afa_orders: [],
        admin_settings: [{ key: 'afa_price_customer', value: '30' }, { key: 'afa_price_agent', value: '25' }, { key: 'afa_price_dealer', value: '22' }],
        data_packages: [{ id: 'p1', network: 'MTN', size: '1GB', price: 10, agent_price: 8, dealer_price: 7, cost_price: 5, is_available: true }],
    }
    house.length = 0; own.length = 0
    seedAccount(s)
}

async function placeData(s: Setup) {
    seedCommon(s)
    const REF = 'USSD-DATA-TESTREF-0001'
    tables.wallet_payments = [{
        id: 'wp1', user_id: BUYER, reference: REF, amount: 8, total_amount: 8, status: 'pending',
        metadata: { kind: 'ussd_member', channel: 'ussd', order_type: 'data', package_id: 'p1', item_name: 'MTN 1GB', recipient: RECIPIENT, payer_msisdn: '233201234567', session_id: 's1' },
    }]
    const payment = await findMemberPayment(db, REF)
    return settleMemberUssdOrder(db, { payment, reference: REF, amountPaid: 8 })
}

async function placeAirtime(s: Setup) {
    seedCommon(s)
    const REF = 'USSD-AIR-TESTREF-0001'
    tables.wallet_payments = [{
        id: 'wp1', user_id: BUYER, reference: REF, amount: 10.3, total_amount: 10.3, status: 'pending',
        metadata: {
            kind: 'airtime_order', channel: 'ussd', role: 'agent', network: 'MTN', beneficiary_phone: RECIPIENT, airtime_amount: 10,
            fee_rate: 3, fee_amount: 0.3, use_exact_amount: true, type: 'airtime', payer_msisdn: '233201234567', session_id: 's1',
        },
    }]
    const payment = await findUssdAirtimePayment(db, REF)
    return settleUssdAirtimeOrder(db, { payment, reference: REF, amountPaid: 10.3 })
}

async function placeAfa(s: Setup) {
    seedCommon(s)
    const REF = 'USSD-AFA-TESTREF-0001'
    tables.wallet_payments = [{
        id: 'wp1', user_id: BUYER, reference: REF, amount: 25, total_amount: 25, status: 'pending',
        metadata: {
            kind: 'ussd_member', channel: 'ussd', order_type: 'afa', item_name: 'AFA Registration', recipient: RECIPIENT, payer_msisdn: '233201234567', session_id: 's1',
            afa: { full_name: 'Kwame Mensah', id_number: 'GHA-123456789-0', date_of_birth: '1990-03-15', region: 'Ashanti', location: 'Kumasi', phone: RECIPIENT },
        },
    }]
    const payment = await findMemberPayment(db, REF)
    return settleMemberUssdOrder(db, { payment, reference: REF, amountPaid: 25 })
}

const FLOWS = [
    { name: 'data', place: placeData },
    { name: 'airtime', place: placeAirtime },
    { name: 'AFA', place: placeAfa },
] as const

let passed = 0
let failed = 0
function check(name: string, ok: boolean, detail = '') {
    if (ok) { console.log(`  PASS  ${name}`); passed++ } else { console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ''}`); failed++ }
}
const show = () => JSON.stringify({ house, own, smsBalance })
const toRecipient = (list: Array<{ recipient: string }>) => list.every((m) => m.recipient === RECIPIENT || m.recipient === '233551234567')

async function main() {
    console.error = () => {}
    console.warn = () => {}
    console.log = ((orig) => (...a: any[]) => { if (typeof a[0] === 'string' && /^\[(Ussd|Fulfillment|PlatformOrderSms|Airtime)/.test(a[0])) return; orig(...a) })(console.log)

    for (const flow of FLOWS) {
        // 1. The buyer has not switched it on: the house message, and it must work.
        for (const toggle of ['absent', false] as const) {
            gateway = 'kingflexy'; kingflexyConfigured = true; dispatchSent = 1
            const r = await flow.place({ toggle })
            check(`${flow.name}: ${toggle === 'absent' ? 'no SMS account' : 'switch OFF'} -> the HOUSE message reaches the recipient, nothing under a buyer sender, no credits used`,
                r.success && house.length === 1 && own.length === 0 && smsBalance === 100 && toRecipient(house), `${JSON.stringify(r)} ${show()}`)
        }

        // 2. Switched on, own sender approved, gateway able: the buyer's own sender, from their credits.
        gateway = 'kingflexy'; kingflexyConfigured = true; dispatchSent = 1
        let r = await flow.place({ toggle: true })
        check(`${flow.name}: switch ON + approved sender -> sent under the BUYER'S sender ID to the recipient, and NOT from the house`,
            r.success && own.length === 1 && own[0].sender === OWN_SENDER && toRecipient(own) && house.length === 0, `${JSON.stringify(r)} ${show()}`)
        check(`${flow.name}: …paid from the buyer's SMS credits (one segment) and recorded as an order campaign`,
            smsBalance === 99 && tables.sms_campaigns.length === 1 && tables.sms_campaigns[0].source === 'order' && /^porder:/.test(tables.sms_campaigns[0].reference), show())
        check(`${flow.name}: …the text carries no house signature (the sender ID is the signature)`, !/ARHMSGh|ARHMS DATA/.test(own[0]?.message || ''), JSON.stringify(own[0]))

        // 3. Switched on, but they have no approved sender yet.
        r = await flow.place({ toggle: true, ownSender: false })
        check(`${flow.name}: switch ON but no approved sender -> falls back to the HOUSE message, and says why`,
            r.success && house.length === 1 && own.length === 0 && smsBalance === 100 && /no approved sender/i.test(tables.sms_accounts[0].last_platform_order_sms_skip || ''), `${JSON.stringify(r)} ${show()} ${tables.sms_accounts[0].last_platform_order_sms_skip}`)

        // 4. Switched on, out of credits.
        r = await flow.place({ toggle: true, credits: 0 })
        check(`${flow.name}: switch ON but out of credits -> HOUSE message, nothing under their sender, nothing left debited`,
            r.success && house.length === 1 && own.length === 0 && smsBalance === 0 && /ran out of SMS credits/i.test(tables.sms_accounts[0].last_platform_order_sms_skip || ''), `${JSON.stringify(r)} ${show()}`)

        // 5. Switched on, the network refuses their sender.
        dispatchSent = 0
        r = await flow.place({ toggle: true })
        check(`${flow.name}: switch ON but the network refuses the sender -> HOUSE message (the recipient is never left without one)`,
            r.success && house.length === 1 && own.length === 0 && /rejected/i.test(tables.sms_accounts[0].last_platform_order_sms_skip || ''), `${JSON.stringify(r)} ${show()}`)
        dispatchSent = 1

        // 6. Switched on, but the gateway cannot carry an own sender.
        gateway = 'moolre'
        r = await flow.place({ toggle: true })
        check(`${flow.name}: switch ON but the active gateway cannot carry an own sender -> HOUSE message`, r.success && house.length === 1 && own.length === 0, `${JSON.stringify(r)} ${show()}`)
        gateway = 'kingflexy'

        // 7. A suspended SMS account.
        r = await flow.place({ toggle: true, accountStatus: 'suspended' })
        check(`${flow.name}: switch ON but the SMS account is suspended -> HOUSE message`, r.success && house.length === 1 && own.length === 0, `${JSON.stringify(r)} ${show()}`)
    }

    // The confirmation is the BUYER's setting, not the recipient's: another user's switch does nothing.
    gateway = 'kingflexy'
    await placeData({ toggle: 'absent' })
    tables.sms_accounts = [{ id: 'acc-other', user_id: 'someone-else', status: 'active', platform_order_sms_enabled: true }]
    house.length = 0; own.length = 0
    await sendPlatformOrderSms({ userId: BUYER, isShopOrder: false, recipient: RECIPIENT, body: 'x', reference: 'r1', houseSend: async () => { house.push({ via: 'x', recipient: RECIPIENT, message: 'x' }) } })
    check("another user's switch does not capture the buyer's confirmation", house.length === 1 && own.length === 0, show())

    // A replay must not send twice, under any name.
    seedCommon({ toggle: true }); house.length = 0; own.length = 0
    const params = { userId: BUYER, isShopOrder: false, recipient: RECIPIENT, body: 'Your AFA registration was received.', reference: 'afa:USSD-AFA-1:received', houseSend: async () => { house.push({ via: 'x', recipient: RECIPIENT, message: 'house' }) } }
    await sendPlatformOrderSms(params); await sendPlatformOrderSms(params)
    check('a replayed confirmation is sent ONCE under the buyer sender, and never again from the house', own.length === 1 && house.length === 0 && smsBalance === 99, show())

    // A SHOP order is never the buyer's: the shop's own confirmation setting governs it.
    {
        seedCommon({ toggle: true })
        tables.orders = [{ id: 'o-shop', user_id: BUYER, shop_order_id: 'so1', phone_number: RECIPIENT, network: 'MTN', size: '1GB', price: 8, reference_code: 'SHOP-1' }]
        await triggerFulfillment('o-shop', 'MTN', { email: 'b@x.com', name: 'Ama' })
        check('a SHOP data order never uses the buyer sender, even with the switch on: the house path, no credits touched', own.length === 0 && house.length === 1 && smsBalance === 100, show())
    }

    // The data order USSD places is a main-site order in every respect the rule looks at.
    {
        await placeData({ toggle: true })
        const order = tables.orders[0]
        check("the data order a registered user's USSD payment creates belongs to the buyer and is not a shop order",
            !!order && order.user_id === BUYER && !order.shop_order_id && order.phone_number === RECIPIENT && order.status === 'processing', JSON.stringify(order))
    }

    console.log(`\n${passed} passed, ${failed} failed`)
    process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => { process.stderr.write(`${e?.stack || e}\n`); process.exit(1) })
