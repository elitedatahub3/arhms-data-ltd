// Run: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isCreditPaymentReference, resolveCreditPackForOwner, settleCreditPackPayment } from '../ai-assistant/shop-credits.ts'

/** Fake client: one wallet_payments row, credits RPC, wallet refund RPC, inserts recorded. */
function fakeDb(opts: { status?: string; userId?: string; meta?: any; failAdd?: boolean } = {}) {
    const state = {
        payment: {
            id: 'p1',
            reference: 'AICPAY-1',
            user_id: opts.userId ?? 'owner',
            status: opts.status ?? 'pending',
            amount: 5,
            total_amount: 5.1,
            metadata: opts.meta ?? { kind: 'ai_shop_credits', shop_id: 's1', pack: { id: 'starter', name: 'Starter', credits: 50, price: 5 } },
        } as any,
        credits: 0,
        wallet: 0,
        inserts: [] as { table: string; row: any }[],
    }
    function table(name: string) {
        const f: Record<string, any> = {}
        let patch: any = null
        const q: any = {
            select: () => q,
            eq: (c: string, v: any) => { f[c] = v; return q },
            update: (p: any) => { patch = p; return q },
            insert: (row: any) => { state.inserts.push({ table: name, row }); return Promise.resolve({ error: null }) },
            maybeSingle: () => {
                if (name !== 'wallet_payments') return Promise.resolve({ data: null })
                const p = state.payment
                const hit = Object.entries(f).every(([c, v]) => p[c] === v)
                if (patch) {
                    if (!hit) return Promise.resolve({ data: null, error: null })
                    Object.assign(p, patch)
                    return Promise.resolve({ data: p, error: null })
                }
                return Promise.resolve({ data: hit ? p : null })
            },
        }
        return q
    }
    const db = {
        from: table,
        rpc: (fn: string, a: any) => {
            if (fn === 'add_shop_credits') {
                if (opts.failAdd) return Promise.resolve({ error: { message: 'boom' } })
                state.credits += a.p_credits
                return Promise.resolve({ data: state.credits, error: null })
            }
            if (fn === 'credit_wallet_balance') { state.wallet += a.p_amount; return Promise.resolve({ error: null }) }
            return Promise.resolve({ error: { message: 'unknown' } })
        },
    }
    return { db, state }
}

test('AICPAY- references are recognised; others are not', () => {
    assert.equal(isCreditPaymentReference('AICPAY-abc'), true)
    assert.equal(isCreditPaymentReference('AICRED-abc'), false)
    assert.equal(isCreditPaymentReference('BUNPAY-abc'), false)
    assert.equal(isCreditPaymentReference(null), false)
})

test('a confirmed payment adds the credits once, records revenue, and never touches the wallet', async () => {
    const { db, state } = fakeDb()
    const first = await settleCreditPackPayment(db, 'AICPAY-1')
    assert.equal(first.success, true)
    assert.equal(first.order?.credits, 50)
    assert.equal(state.credits, 50)
    assert.equal(state.wallet, 0)
    const purchase = state.inserts.find(i => i.table === 'ai_usage_purchases')?.row
    assert.equal(purchase.method, 'momo')
    assert.equal(purchase.amount, 5)
    assert.equal(purchase.status, 'paid')

    // Webhook + poller + cron all fire: only the first adds credits.
    const again = await settleCreditPackPayment(db, 'AICPAY-1')
    assert.equal(again.success, true)
    assert.equal(again.alreadyProcessed, true)
    assert.equal(state.credits, 50)
})

test('the page poll for another user is refused', async () => {
    const { db, state } = fakeDb()
    const r = await settleCreditPackPayment(db, 'AICPAY-1', 'someone-else')
    assert.equal(r.success, false)
    assert.equal(state.credits, 0)
    assert.equal(state.payment.status, 'pending')
})

test('malformed metadata adds nothing', async () => {
    const { db, state } = fakeDb({ meta: { kind: 'bundle_order', shop_id: 's1', pack: { credits: 50 } } })
    const r = await settleCreditPackPayment(db, 'AICPAY-1')
    assert.equal(r.success, false)
    assert.equal(state.credits, 0)
    assert.equal(state.payment.status, 'pending')
})

test('if the credits cannot be added after payment, everything paid goes to the wallet', async () => {
    const { db, state } = fakeDb({ failAdd: true })
    const r = await settleCreditPackPayment(db, 'AICPAY-1')
    assert.equal(r.success, false)
    assert.equal(r.refunded, true)
    assert.equal(state.wallet, 5.1)
    assert.ok(state.inserts.some(i => i.table === 'notifications' && /returned to your wallet/.test(i.row.message)))
})

test('resolveCreditPackForOwner: only the owner, only enabled paid packs', async () => {
    const settings: Record<string, string> = {
        ai_shop_credit_packs: JSON.stringify([
            { id: 'starter', name: 'Starter', credits: 50, price: 5, enabled: true },
            { id: 'off', name: 'Off', credits: 10, price: 1, enabled: false },
            { id: 'gift', name: 'Gift', credits: 5, price: 0, enabled: true },
        ]),
    }
    const db = {
        from: (name: string) => {
            const f: Record<string, any> = {}
            const q: any = {
                select: () => q,
                eq: (c: string, v: any) => { f[c] = v; return q },
                in: (_c: string, keys: string[]) => Promise.resolve({ data: keys.filter(k => k in settings).map(k => ({ key: k, value: settings[k] })) }),
                maybeSingle: () => Promise.resolve({ data: name === 'shop_profiles' && f.owner_id === 'owner' ? { id: 's1', owner_id: 'owner' } : null }),
            }
            return q
        },
    }
    const ok = await resolveCreditPackForOwner(db, 'owner', 'starter')
    assert.equal(ok.ok, true)
    assert.equal((ok as any).pack.price, 5)
    assert.equal((await resolveCreditPackForOwner(db, 'stranger', 'starter')).ok, false)
    assert.equal((await resolveCreditPackForOwner(db, 'owner', 'off')).ok, false)
    assert.equal((await resolveCreditPackForOwner(db, 'owner', 'gift')).ok, false)
})
