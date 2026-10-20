/**
 * Test: a USSD buyer who is NOT a main-site user (a shop's short-code caller) is texted
 * from the SHOP's sender ID — AFA receipt, utility-bill notices, result-checker voucher —
 * and from the house sender only when the shop cannot carry it.
 *
 * Pins (lib/sms/order-confirmations.ts: sendShopOrHouseSms, lib/ussd-utility-sms.ts):
 *   - shop with an approved sender + credits -> one text under the shop's sender, credits
 *     debited, a campaign row, and NOTHING from the house;
 *   - no sms account / suspended / no approved sender / out of credits / gateway cannot
 *     carry it / provider rejects -> the house fallback fires exactly once;
 *   - a replay (same order + kind) never texts twice, from either route;
 *   - these notices ignore the data/airtime owner switches;
 *   - utility notices: a shop bill goes via the shop, a house/member bill via the house only,
 *     and each event (processing, completed) is its own text;
 *   - the shop text drops the house "ARHMS:" lead.
 *
 * No network, no database. Run:
 *   TS_NODE_COMPILER_OPTIONS='{"module":"commonjs","moduleResolution":"node"}' \
 *     npx ts-node --transpile-only scripts/test-ussd-shop-sender-sms.ts
 */
import Module from 'module'
import path from 'path'

const REPO_ROOT = path.resolve(__dirname, '..')
type Row = Record<string, any>
let tables: Record<string, Row[]> = {}
let credits = 0
let gateway = 'kingflexy'
let providerSends = 1
let allowed: any[] = []
const houseSms: Array<{ recipient: string; message: string }> = []
const shopSent: Array<{ sender: string; message: string; recipient: string }> = []

function builder(table: string) {
    const q: any = { op: 'select', filters: [] as Array<(r: Row) => boolean>, payload: null }
    const run = async () => {
        const rows = (tables[table] = tables[table] || [])
        const matched = rows.filter((r) => q.filters.every((f: any) => f(r)))
        if (q.op === 'update') { matched.forEach((r) => Object.assign(r, q.payload)); return { data: matched, error: null } }
        if (q.op === 'insert') {
            const added = [].concat(q.payload).map((p: any, i: number) => ({ id: `${table}-${rows.length + i + 1}`, ...p }))
            const ref = added[0]?.reference
            if (table === 'sms_campaigns' && ref && rows.some((r) => r.reference === ref && r.account_id === added[0].account_id)) {
                return { data: null, error: { code: '23505', message: 'dup' } }
            }
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
        limit() { return api },
        single: async () => { const r = await run(); return { data: r.data?.[0] ?? null, error: r.error } },
        maybeSingle: async () => { const r = await run(); return { data: r.data?.[0] ?? null, error: null } },
        then(res: any, rej: any) { return run().then(res, rej) },
    }
    return api
}
const db: any = {
    from: (t: string) => builder(t),
    rpc: async (fn: string, a: any) => {
        if (fn === 'debit_sms_credits') {
            if (credits < a.p_amount) return { error: { message: 'INSUFFICIENT_CREDITS' } }
            credits -= a.p_amount
            return { error: null }
        }
        if (fn === 'credit_sms_credits') { credits += a.p_amount; return { error: null } }
        return { error: null }
    },
}

const originalLoad = (Module as any)._load
;(Module as any)._load = function (request: string, parent: unknown, isMain: boolean) {
    if (request === '@/lib/sms-service') {
        return {
            getActiveSmsProvider: async () => gateway,
            normalizeGhanaPhone: (p: string) => { const d = String(p).replace(/\D/g, ''); return d.startsWith('233') ? d : `233${d.replace(/^0/, '')}` },
            sendSMS: async (p: any) => { houseSms.push({ recipient: p.recipient, message: p.message }); return { success: true } },
        }
    }
    if (request === '@/lib/kingflexy-sms-service') return { isKingFlexySmsConfigured: () => true }
    if (request === '@/lib/sms/sms-rules') return { countSegments: (m: string) => ({ segments: Math.max(1, Math.ceil(m.length / 160)) }) }
    if (request === '@/lib/sms/customer-sms') {
        return {
            getAllowedSenders: async () => allowed,
            dispatchCampaignBatch: async (_db: any, id: string) => {
                const camp = tables.sms_campaigns.find((c) => c.id === id)!
                const msg = tables.sms_messages.find((m) => m.campaign_id === id)!
                if (providerSends === 0) { credits += camp.credits_charged; return { sent: 0 } } // the real dispatcher refunds rejected sends
                shopSent.push({ sender: camp.sender_used, message: camp.message, recipient: msg.recipient })
                return { sent: 1 }
            },
            settleCampaignIfDone: async () => {},
        }
    }
    if (request.startsWith('@/')) return originalLoad.apply(this, [path.join(REPO_ROOT, request.slice(2)), parent, isMain])
    return originalLoad.apply(this, [request, parent, isMain])
}

/* eslint-disable @typescript-eslint/no-var-requires */
const { sendShopOrHouseSms } = require('@/lib/sms/order-confirmations')
const { smsUssdUtilityPayer } = require('@/lib/ussd-utility-sms')
/* eslint-enable @typescript-eslint/no-var-requires */

function seed(over: { account?: Row | null } = {}) {
    tables = {
        shop_profiles: [{ id: 'shop1', owner_id: 'owner1', shop_name: 'Kofi Hub' }],
        sms_accounts: over.account === null ? [] : [{ id: 'acc1', user_id: 'owner1', status: 'active', credits: 10, order_sms_data_enabled: false, order_sms_airtime_enabled: false, ...over.account }],
        sms_campaigns: [], sms_messages: [], sub_agents: [], notifications: [],
    }
    credits = 10; gateway = 'kingflexy'; providerSends = 1
    allowed = [{ type: 'own', isDefault: true, sender: 'KOFIHUB' }]
    houseSms.length = 0; shopSent.length = 0
}

let passed = 0
let failed = 0
function check(name: string, ok: boolean, detail = '') {
    if (ok) { console.log(`  PASS  ${name}`); passed++ } else { console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ''}`); failed++ }
}

const params = (over: Row = {}) => ({
    shopId: 'shop1', orderId: 'ORD1', kind: 'afa', phone: '0241234567',
    message: 'AFA Registration received for AMA. Thank you for choosing Kofi Hub.', details: {}, ...over,
})
const fallback = async () => { houseSms.push({ recipient: '233241234567', message: 'HOUSE' }) }

async function main() {
    console.error = () => {}
    console.log = ((orig) => (...a: any[]) => { if (typeof a[0] === 'string' && /^\[OrderSms/.test(a[0])) return; orig(...a) })(console.log)

    // ── Shop can carry it ────────────────────────────────────────────────────────
    seed()
    let r = await sendShopOrHouseSms(db, params(), fallback)
    check('shop with approved sender + credits -> sent via the SHOP', r.via === 'shop')
    check('...under the shop sender ID, to the buyer (233 form)', shopSent.length === 1 && shopSent[0].sender === 'KOFIHUB' && shopSent[0].recipient === '233241234567')
    check('...nothing from the house', houseSms.length === 0)
    check('...one segment debited from the shop credits', credits === 9)
    check('...recorded as an order campaign', tables.sms_campaigns.length === 1 && tables.sms_campaigns[0].source === 'order')
    check('...ignores the data/airtime switches (both OFF here)', r.via === 'shop')

    // ── Replay ───────────────────────────────────────────────────────────────────
    r = await sendShopOrHouseSms(db, params(), fallback)
    check('a replay sends nothing more: not from the shop, not from the house', r.via === 'none' && shopSent.length === 1 && houseSms.length === 0 && credits === 9)
    r = await sendShopOrHouseSms(db, params({ kind: 'voucher', message: 'PIN 1234' }), fallback)
    check('a different kind for the same order is its own text', r.via === 'shop' && shopSent.length === 2)

    // ── Fallbacks ────────────────────────────────────────────────────────────────
    const fallbackCases: Array<[string, () => void]> = [
        ['no SMS account', () => seed({ account: null })],
        ['suspended SMS account', () => seed({ account: { status: 'suspended' } })],
        ['no approved own sender', () => { seed(); allowed = [{ type: 'pool', sender: 'POOL' }] }],
        ['out of credits', () => { seed(); credits = 0 }],
        ['gateway cannot carry an own sender', () => { seed(); gateway = 'moolre' }],
        ['network rejects the message', () => { seed(); providerSends = 0 }],
    ]
    for (const [name, setup] of fallbackCases) {
        setup()
        const res = await sendShopOrHouseSms(db, params(), fallback)
        check(`${name} -> HOUSE fallback exactly once, nothing under the shop`, res.via === 'house' && houseSms.length === 1 && shopSent.length === 0, JSON.stringify(res))
    }
    seed(); credits = 0
    await sendShopOrHouseSms(db, params(), fallback)
    check('out of credits: nothing left debited', credits === 0)
    seed(); providerSends = 0
    await sendShopOrHouseSms(db, params(), fallback)
    check('provider rejects: the credit is refunded', credits === 10)

    seed()
    const thrower = await sendShopOrHouseSms(db, params({ shopId: '' }), async () => { throw new Error('boom') })
    check('a throwing fallback never escapes', thrower.via === 'house')

    // ── Utility payer notices ───────────────────────────────────────────────────
    const REF = 'USSD-UTIL-ABCDEF-123456'
    const meta = (over: Row = {}) => ({
        kind: 'utility_order', channel: 'ussd', service: 'ecg', account_number: '0123456789', bill_amount: 50,
        payer_msisdn: '233241234567', shop_id: 'shop1', shop_name: 'Kofi Hub', ...over,
    })
    const seedBill = (m: Row) => { seed(); tables.wallet_payments = [{ id: 'wp1', reference: REF, total_amount: 51.5, metadata: m }] }

    seedBill(meta())
    await smsUssdUtilityPayer(db, { reference: REF, event: 'processing' })
    check('shop bill: processing notice goes via the shop sender', shopSent.length === 1 && shopSent[0].sender === 'KOFIHUB' && houseSms.length === 0)
    check('...without the house "ARHMS:" lead', !/^ARHMS/.test(shopSent[0].message) && /received GHS 51\.50/.test(shopSent[0].message))
    await smsUssdUtilityPayer(db, { reference: REF, event: 'completed' })
    check('...the completed notice is its own text', shopSent.length === 2 && /paid successfully/.test(shopSent[1].message))
    await smsUssdUtilityPayer(db, { reference: REF, event: 'completed' })
    check('...a replayed completion is not texted again', shopSent.length === 2 && houseSms.length === 0)

    seedBill(meta())
    credits = 0
    await smsUssdUtilityPayer(db, { reference: REF, event: 'refunded' })
    check('shop bill, shop out of credits -> house fallback with the original wording', houseSms.length === 1 && /^ARHMS:/.test(houseSms[0].message) && /refunded to Kofi Hub/.test(houseSms[0].message))

    seedBill(meta({ shop_id: undefined, shop_name: undefined }))
    await smsUssdUtilityPayer(db, { reference: REF, event: 'completed' })
    check('house/member bill (no shop) -> house sender only, shop untouched', houseSms.length === 1 && shopSent.length === 0 && credits === 10)

    seedBill(meta({ channel: 'web' }))
    await smsUssdUtilityPayer(db, { reference: REF, event: 'completed' })
    check('a non-USSD payment is never texted', houseSms.length === 0 && shopSent.length === 0)

    console.log(`\n${passed} passed, ${failed} failed`)
    process.exit(failed ? 1 : 0)
}
main()
