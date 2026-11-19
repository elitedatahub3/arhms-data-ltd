// Run: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chargeUsageReset } from '../ai-assistant/usage-reset.ts'

/**
 * Minimal fake of the Supabase client: admin_settings, shop_profiles,
 * ai_usage_purchases (UNIQUE reference), wallet_transactions, and the two wallet RPCs.
 */
function fakeDb(opts: { balance?: number; settings?: Record<string, string>; shops?: any[]; failMarkPaid?: boolean } = {}) {
    const state = {
        balance: opts.balance ?? 20,
        purchases: [] as any[],
        ledger: [] as any[],
        rpcCalls: [] as string[],
    }
    const settings = opts.settings ?? { ai_dashboard_monthly_limit: '100', ai_dashboard_reset_price: '5', ai_shop_monthly_limit: '300', ai_shop_reset_price: '7' }
    const shops = opts.shops ?? []

    function table(name: string) {
        const filters: [string, any][] = []
        let pendingUpdate: any = null
        const q: any = {
            select: () => q,
            in: (_c: string, keys: string[]) => {
                if (name === 'admin_settings') return Promise.resolve({ data: keys.filter(k => k in settings).map(k => ({ key: k, value: settings[k] })) })
                return q
            },
            eq: (c: string, v: any) => { filters.push([c, v]); return q.__maybeRunUpdate() },
            __match: (row: any) => filters.every(([c, v]) => row[c] === v),
            __maybeRunUpdate: () => {
                if (!pendingUpdate) return q
                // Update resolves when awaited; apply on each eq so chained eqs filter.
                return {
                    ...q,
                    eq: (c: string, v: any) => { filters.push([c, v]); return q.__maybeRunUpdate() },
                    then: (res: any) => {
                        if (name === 'ai_usage_purchases' && pendingUpdate.status === 'paid' && opts.failMarkPaid) return res({ error: { message: 'db down' } })
                        for (const r of state.purchases) if (q.__match(r)) Object.assign(r, pendingUpdate)
                        return res({ error: null })
                    },
                }
            },
            maybeSingle: () => {
                const rows = name === 'shop_profiles' ? shops : name === 'ai_usage_purchases' ? state.purchases : []
                return Promise.resolve({ data: rows.find(r => q.__match(r)) ?? null })
            },
            insert: (row: any) => {
                if (name === 'ai_usage_purchases') {
                    if (state.purchases.some(p => p.reference === row.reference)) return Promise.resolve({ error: { code: '23505', message: 'duplicate' } })
                    state.purchases.push({ ...row })
                } else if (name === 'wallet_transactions') state.ledger.push(row)
                return Promise.resolve({ error: null })
            },
            update: (patch: any) => { pendingUpdate = patch; return q },
        }
        return q
    }

    const db = {
        from: table,
        rpc: (fn: string, args: any) => {
            state.rpcCalls.push(fn)
            if (fn === 'deduct_wallet_balance') {
                if (state.balance < args.p_amount) return Promise.resolve({ data: null, error: { message: 'INSUFFICIENT_BALANCE' } })
                state.balance -= args.p_amount
                return Promise.resolve({ data: [{ wallet_id: 'w1', new_balance: state.balance }], error: null })
            }
            if (fn === 'credit_wallet_balance') {
                state.balance += args.p_amount
                return Promise.resolve({ data: null, error: null })
            }
            return Promise.resolve({ data: null, error: { message: 'unknown rpc' } })
        },
    }
    return { db, state }
}

const KEY = '3f2b9c1e-1111-2222-3333-444455556666'

test('dashboard reset charges the admin price once and adds the admin limit', async () => {
    const { db, state } = fakeDb({ balance: 20 })
    const r = await chargeUsageReset(db, { userId: 'u1', scope: 'dashboard', idempotencyKey: KEY })
    assert.deepEqual(r, { ok: true, questionsAdded: 100, amount: 5, newBalance: 15 })
    assert.equal(state.balance, 15)
    assert.equal(state.purchases[0].status, 'paid')
    assert.equal(state.ledger.length, 1)
    assert.equal(state.ledger[0].source, 'purchase')
    assert.equal(state.ledger[0].type, 'debit')
})

test('a double tap with the same key charges only once', async () => {
    const { db, state } = fakeDb({ balance: 20 })
    await chargeUsageReset(db, { userId: 'u1', scope: 'dashboard', idempotencyKey: KEY })
    const again = await chargeUsageReset(db, { userId: 'u1', scope: 'dashboard', idempotencyKey: KEY })
    assert.equal(again.ok, true)
    assert.equal((again as any).alreadyPaid, true)
    assert.equal(state.balance, 15)
    assert.equal(state.purchases.length, 1)
})

test('insufficient balance: nothing charged, purchase marked failed', async () => {
    const { db, state } = fakeDb({ balance: 3 })
    const r = await chargeUsageReset(db, { userId: 'u1', scope: 'dashboard', idempotencyKey: KEY })
    assert.equal(r.ok, false)
    assert.equal((r as any).code, 'insufficient')
    assert.equal((r as any).price, 5)
    assert.equal(state.balance, 3)
    assert.equal(state.purchases[0].status, 'failed')
})

test('price comes from settings, not the caller', async () => {
    const { db, state } = fakeDb({ balance: 20, settings: { ai_dashboard_reset_price: '2.5', ai_dashboard_monthly_limit: '40' } })
    const r = await chargeUsageReset(db, { userId: 'u1', scope: 'dashboard', idempotencyKey: KEY, ...({ amount: 0.01 } as any) })
    assert.deepEqual(r, { ok: true, questionsAdded: 40, amount: 2.5, newBalance: 17.5 })
    assert.equal(state.balance, 17.5)
})

test('shop reset: owner pays GHS 7; a non-owner is refused and not charged', async () => {
    const shops = [{ id: 's1', owner_id: 'owner' }]
    const a = fakeDb({ balance: 20, shops })
    const ok = await chargeUsageReset(a.db, { userId: 'owner', scope: 'shop', shopId: 's1', idempotencyKey: KEY })
    assert.equal(ok.ok, true)
    assert.equal((ok as any).amount, 7)
    assert.equal(a.state.purchases[0].shop_id, 's1')

    const b = fakeDb({ balance: 20, shops })
    const no = await chargeUsageReset(b.db, { userId: 'stranger', scope: 'shop', shopId: 's1', idempotencyKey: KEY })
    assert.equal((no as any).code, 'forbidden')
    assert.equal(b.state.balance, 20)
    assert.deepEqual(b.state.rpcCalls, [])
})

test('if marking paid fails after charging, the wallet is refunded', async () => {
    const { db, state } = fakeDb({ balance: 20, failMarkPaid: true })
    const r = await chargeUsageReset(db, { userId: 'u1', scope: 'dashboard', idempotencyKey: KEY })
    assert.equal(r.ok, false)
    assert.equal(state.balance, 20)
    assert.deepEqual(state.rpcCalls, ['deduct_wallet_balance', 'credit_wallet_balance'])
})

test('bad idempotency key or scope is rejected before any money moves', async () => {
    const { db, state } = fakeDb()
    assert.equal((await chargeUsageReset(db, { userId: 'u1', scope: 'dashboard', idempotencyKey: 'x' })).ok, false)
    assert.equal((await chargeUsageReset(db, { userId: 'u1', scope: 'weird' as any, idempotencyKey: KEY })).ok, false)
    assert.deepEqual(state.rpcCalls, [])
})
