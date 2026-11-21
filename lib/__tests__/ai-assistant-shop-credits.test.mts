// Run: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buyCreditPack, payForShopAnswer } from '../ai-assistant/shop-credits.ts'

/** Fake Supabase client: settings, shops, purchases (UNIQUE reference), shop credits, question counts, wallet RPCs. */
function fakeDb(opts: { balance?: number; credits?: number; freeUsed?: number; settings?: Record<string, string>; failAdd?: boolean } = {}) {
    const state = {
        wallet: opts.balance ?? 50,
        credits: opts.credits ?? 0,
        purchases: [] as any[],
        ledger: [] as any[],
        rpc: [] as string[],
    }
    const settings = opts.settings ?? {}
    const shops = [{ id: 's1', owner_id: 'owner' }]

    function table(name: string) {
        const filters: [string, any][] = []
        let patch: any = null
        const match = (r: any) => filters.every(([c, v]) => r[c] === v)
        const q: any = {
            select: (_c?: string, o?: any) => {
                if (name === 'ai_shop_questions' && o?.head) {
                    return { eq: () => ({ eq: () => ({ gte: () => Promise.resolve({ count: opts.freeUsed ?? 0 }) }) }) }
                }
                return q
            },
            in: (_c: string, keys: string[]) => Promise.resolve({ data: keys.filter(k => k in settings).map(k => ({ key: k, value: settings[k] })) }),
            eq: (c: string, v: any) => {
                filters.push([c, v])
                if (patch) {
                    return {
                        eq: (c2: string, v2: any) => { filters.push([c2, v2]); return { then: (res: any) => { state.purchases.filter(match).forEach(r => Object.assign(r, patch)); res({ error: null }) } } },
                    }
                }
                return q
            },
            maybeSingle: () => {
                if (name === 'shop_profiles') return Promise.resolve({ data: shops.find(match) ?? null })
                if (name === 'ai_usage_purchases') return Promise.resolve({ data: state.purchases.find(match) ?? null })
                if (name === 'ai_shop_credits') return Promise.resolve({ data: { balance: state.credits } })
                return Promise.resolve({ data: null })
            },
            insert: (row: any) => {
                if (name === 'ai_usage_purchases') {
                    if (state.purchases.some(p => p.reference === row.reference)) return Promise.resolve({ error: { code: '23505' } })
                    state.purchases.push({ ...row })
                } else if (name === 'wallet_transactions') state.ledger.push(row)
                return Promise.resolve({ error: null })
            },
            update: (p: any) => { patch = p; return q },
        }
        return q
    }

    const db = {
        from: table,
        rpc: (fn: string, args: any) => {
            state.rpc.push(fn)
            if (fn === 'deduct_wallet_balance') {
                if (state.wallet < args.p_amount) return Promise.resolve({ data: null, error: { message: 'INSUFFICIENT_BALANCE' } })
                state.wallet -= args.p_amount
                return Promise.resolve({ data: [{ wallet_id: 'w1', new_balance: state.wallet }], error: null })
            }
            if (fn === 'credit_wallet_balance') { state.wallet += args.p_amount; return Promise.resolve({ error: null }) }
            if (fn === 'add_shop_credits') {
                if (opts.failAdd) return Promise.resolve({ data: null, error: { message: 'boom' } })
                state.credits += args.p_credits
                return Promise.resolve({ data: state.credits, error: null })
            }
            if (fn === 'consume_shop_credit') {
                if (state.credits <= 0) return Promise.resolve({ data: false, error: null })
                state.credits -= 1
                return Promise.resolve({ data: true, error: null })
            }
            return Promise.resolve({ data: null, error: { message: 'unknown' } })
        },
    }
    return { db, state }
}

const KEY = '3f2b9c1e-1111-2222-3333-444455556666'

test('buying the Starter pack charges GHS 5 once and adds 50 credits', async () => {
    const { db, state } = fakeDb({ balance: 20 })
    const r = await buyCreditPack(db, { userId: 'owner', packId: 'starter', idempotencyKey: KEY })
    assert.deepEqual(r, { ok: true, credits: 50, amount: 5, balance: 50 })
    assert.equal(state.wallet, 15)
    assert.equal(state.purchases[0].status, 'paid')
    assert.equal(state.ledger[0].description, 'Shop assistant credits: Starter (50)')
    const again = await buyCreditPack(db, { userId: 'owner', packId: 'starter', idempotencyKey: KEY })
    assert.equal((again as any).alreadyPaid, true)
    assert.equal(state.wallet, 15)
    assert.equal(state.credits, 50)
})

test('pack price and credits come from admin settings', async () => {
    const settings = { ai_shop_credit_packs: JSON.stringify([{ id: 'mini', name: 'Mini', credits: 20, price: 2 }]) }
    const { db, state } = fakeDb({ balance: 20, settings })
    assert.equal((await buyCreditPack(db, { userId: 'owner', packId: 'starter', idempotencyKey: KEY })).ok, false)
    const r = await buyCreditPack(db, { userId: 'owner', packId: 'mini', idempotencyKey: 'aaaaaaaa-1111-2222-3333-444455556666' })
    assert.deepEqual(r, { ok: true, credits: 20, amount: 2, balance: 20 })
    assert.equal(state.wallet, 18)
})

test('a non-owner cannot buy; a low wallet is not charged', async () => {
    const a = fakeDb()
    assert.equal((await buyCreditPack(a.db, { userId: 'stranger', packId: 'starter', idempotencyKey: KEY }) as any).code, 'forbidden')
    assert.deepEqual(a.state.rpc, [])
    const b = fakeDb({ balance: 3 })
    const r = await buyCreditPack(b.db, { userId: 'owner', packId: 'starter', idempotencyKey: KEY })
    assert.equal((r as any).code, 'insufficient')
    assert.equal(b.state.wallet, 3)
    assert.equal(b.state.credits, 0)
})

test('if adding the credits fails, the wallet is refunded', async () => {
    const { db, state } = fakeDb({ balance: 20, failAdd: true })
    const r = await buyCreditPack(db, { userId: 'owner', packId: 'starter', idempotencyKey: KEY })
    assert.equal(r.ok, false)
    assert.equal(state.wallet, 20)
    assert.deepEqual(state.rpc, ['deduct_wallet_balance', 'add_shop_credits', 'credit_wallet_balance'])
})

test('payForShopAnswer: visitor free, shop free monthly, bought credit, then wait', async () => {
    const free = { shopId: 's1', visitorFreePerDay: 3, freeMonthly: 50 }
    assert.equal(await payForShopAnswer(fakeDb().db, { ...free, visitorUsedToday: 0 }), 'visitor_free')
    assert.equal(await payForShopAnswer(fakeDb({ freeUsed: 10 }).db, { ...free, visitorUsedToday: 3 }), 'shop_free')
    const withCredit = fakeDb({ freeUsed: 50, credits: 1 })
    assert.equal(await payForShopAnswer(withCredit.db, { ...free, visitorUsedToday: 3 }), 'shop_credit')
    assert.equal(withCredit.state.credits, 0)
    assert.equal(await payForShopAnswer(withCredit.db, { ...free, visitorUsedToday: 3 }), null)
})
