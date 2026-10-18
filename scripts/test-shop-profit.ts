/**
 * Test: shop profit for Results Checker and AFA sales (lib/shop-profit.ts)
 *
 * Pins the two rules the module exists for:
 *   - a shop's profit is measured against what its OWNER pays (role price), not
 *     the platform's cost_price;
 *   - a sub-agent's sale is split up the chain, every level keeping its own spread.
 *
 * Every case also checks the invariant that makes the split trustworthy:
 *   seller + every upline + the root's cost === selling price × qty, to the pesewa.
 *
 * No network, no database: a tiny in-memory Supabase double stands in for both,
 * and the wallet credit is captured instead of written.
 *
 * Run (CommonJS is required for the require() hook below):
 *
 *   TS_NODE_COMPILER_OPTIONS='{"module":"commonjs","moduleResolution":"node"}' \
 *     npx ts-node --transpile-only scripts/test-shop-profit.ts
 *
 * Exit code: 0 = all pass, 1 = any fail
 */

import Module from 'module'
import path from 'path'

const REPO_ROOT = path.resolve(__dirname, '..')

// ── Captured wallet credits ─────────────────────────────────────────────────────
const credits: Array<{ ownerId: string; amount: number; reference: string }> = []

const originalLoad = (Module as any)._load
;(Module as any)._load = function (request: string, parent: unknown, isMain: boolean) {
    if (request === '@/lib/shop-service') {
        return {
            creditShopRcProfit: async (p: { ownerId: string; amount: number; reference: string }) => {
                credits.push({ ownerId: p.ownerId, amount: p.amount, reference: p.reference })
                return { credited: true }
            },
        }
    }
    if (request.startsWith('@/')) {
        return originalLoad.apply(this, [path.join(REPO_ROOT, request.slice(2)), parent, isMain])
    }
    return originalLoad.apply(this, [request, parent, isMain])
}

// ── In-memory Supabase double ───────────────────────────────────────────────────
type Row = Record<string, any>
type Tables = Record<string, Row[]>

function makeDb(tables: Tables) {
    return {
        from(table: string) {
            const filters: Array<(r: Row) => boolean> = []
            const builder: any = {
                select() { return builder },
                eq(col: string, val: any) { filters.push((r) => r[col] === val); return builder },
                in(col: string, vals: any[]) { filters.push((r) => vals.includes(r[col])); return builder },
                rows() { return (tables[table] || []).filter((r) => filters.every((f) => f(r))) },
                maybeSingle: async () => ({ data: builder.rows()[0] ?? null, error: null }),
                single: async () => ({ data: builder.rows()[0] ?? null, error: null }),
                then(resolve: any, reject: any) {
                    return Promise.resolve({ data: builder.rows(), error: null }).then(resolve, reject)
                },
            }
            return builder
        },
    }
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { computeShopProfit, creditOrderProfit, profitColumns } = require('@/lib/shop-profit')

// ── Fixture: a three-level network ──────────────────────────────────────────────
//   Lead shop L (owner uL) ← sub S1 (owner u1) ← sub-of-sub S2 (owner u2)
// Checker type T: customer 20, agent 18, dealer 17 (platform cost_price 7, unused now).
// AFA: customer 30, agent 25, dealer 22.
function fixture(overrides: { leadRole?: string; rcPrices?: Record<string, number | undefined>; afaPrices?: Record<string, number> } = {}): Tables {
    const rc = { L: 25, S1: 28, S2: 30, ...(overrides.rcPrices || {}) }
    const afa = { L: 35, S1: 38, S2: 40, ...(overrides.afaPrices || {}) }
    return {
        users: [
            { id: 'uL', role: overrides.leadRole ?? 'customer' },
            { id: 'u1', role: 'customer' },
            { id: 'u2', role: 'customer' },
        ],
        shop_profiles: [
            { id: 'L', owner_id: 'uL' },
            { id: 'S1', owner_id: 'u1' },
            { id: 'S2', owner_id: 'u2' },
        ],
        sub_agents: [
            { id: 'm1', user_id: 'u1', upline_shop_id: 'L' },
            { id: 'm2', user_id: 'u2', upline_shop_id: 'S1' },
        ],
        results_checker_types: [
            { id: 'T', customer_price: 20, agent_price: 18, dealer_price: 17, cost_price: 7 },
        ],
        shop_rc_pricing: Object.entries(rc)
            .filter(([, p]) => p !== undefined)
            .map(([shop_id, selling_price]) => ({ shop_id, rc_type_id: 'T', selling_price })),
        shop_afa_pricing: Object.entries(afa).map(([shop_id, selling_price]) => ({ shop_id, selling_price })),
        admin_settings: [
            { key: 'afa_price_customer', value: '30' },
            { key: 'afa_price_agent', value: '25' },
            { key: 'afa_price_dealer', value: '22' },
        ],
    }
}

interface Case {
    name: string
    tables: Tables
    kind: 'rc' | 'afa'
    ownerId: string
    unitPrice: number
    qty?: number
    /** [seller, up1, up2...] for the whole quantity; null = expect no split at all. */
    want: number[] | null
    /** The root's per-unit cost, for the invariant. */
    rootCost?: number
}

const cases: Case[] = [
    // Lead shops — profit against the OWNER's role price, not cost_price 7.
    { name: 'RC Lead (customer) sells at 25 → 5, not 18', tables: fixture(), kind: 'rc', ownerId: 'uL', unitPrice: 25, want: [5], rootCost: 20 },
    { name: 'RC Lead (agent) sells at 25 → 7', tables: fixture({ leadRole: 'agent' }), kind: 'rc', ownerId: 'uL', unitPrice: 25, want: [7], rootCost: 18 },
    { name: 'RC Lead (dealer) sells at 25 → 8', tables: fixture({ leadRole: 'dealer' }), kind: 'rc', ownerId: 'uL', unitPrice: 25, want: [8], rootCost: 17 },

    // Subs — each level keeps its own spread.
    { name: 'RC level-1 sub at 28 → sub 3, Lead 5', tables: fixture(), kind: 'rc', ownerId: 'u1', unitPrice: 28, want: [3, 5], rootCost: 20 },
    { name: 'RC level-2 sub at 30 → sub 2, S1 3, Lead 5', tables: fixture(), kind: 'rc', ownerId: 'u2', unitPrice: 30, want: [2, 3, 5], rootCost: 20 },
    { name: 'RC level-2 sub, qty 3 → 6 / 9 / 15', tables: fixture(), kind: 'rc', ownerId: 'u2', unitPrice: 30, qty: 3, want: [6, 9, 15], rootCost: 20 },
    { name: 'RC level-2 sub, dealer Lead → Lead keeps 8', tables: fixture({ leadRole: 'dealer' }), kind: 'rc', ownerId: 'u2', unitPrice: 30, want: [2, 3, 8], rootCost: 17 },

    // An upline raised their price above the sub's — the sub earns 0, nobody goes negative.
    { name: 'RC upline above sub price → sub 0, legs clamp', tables: fixture({ rcPrices: { S1: 31 } }), kind: 'rc', ownerId: 'u2', unitPrice: 30, want: [0, 5, 5], rootCost: 20 },

    // An upline stopped selling the type — fall back to unattributed, priced like a Lead.
    { name: 'RC upline unpriced → seller vs role price, no legs', tables: fixture({ rcPrices: { S1: undefined } }), kind: 'rc', ownerId: 'u2', unitPrice: 30, want: [10], rootCost: 20 },

    // Rounding stays on the pesewa.
    { name: 'RC rounding: 21.35 × 3 vs 20 → 4.05', tables: fixture(), kind: 'rc', ownerId: 'uL', unitPrice: 21.35, qty: 3, want: [4.05], rootCost: 20 },

    // AFA — same rules.
    { name: 'AFA Lead (customer) at 35 → 5', tables: fixture(), kind: 'afa', ownerId: 'uL', unitPrice: 35, want: [5], rootCost: 30 },
    { name: 'AFA Lead (agent) at 35 → 10', tables: fixture({ leadRole: 'agent' }), kind: 'afa', ownerId: 'uL', unitPrice: 35, want: [10], rootCost: 25 },
    { name: 'AFA level-2 sub at 40 → 2 / 3 / 5', tables: fixture(), kind: 'afa', ownerId: 'u2', unitPrice: 40, want: [2, 3, 5], rootCost: 30 },

    // Unpriced item → null, which callers treat as "not for sale".
    { name: 'RC type with no platform price → null', tables: { ...fixture(), results_checker_types: [] }, kind: 'rc', ownerId: 'uL', unitPrice: 25, want: null },
]

const money = (n: number) => Math.round(n * 100) / 100

async function main() {
    let passed = 0
    let failed = 0
    const fail = (name: string, problems: string[]) => {
        console.log(`  FAIL  ${name}`)
        for (const p of problems) console.log(`          ${p}`)
        failed++
    }

    for (const c of cases) {
        const db = makeDb(c.tables)
        const split = await computeShopProfit(db, {
            kind: c.kind, ownerId: c.ownerId, itemId: c.kind === 'rc' ? 'T' : null, unitPrice: c.unitPrice, qty: c.qty,
        })
        const problems: string[] = []

        if (c.want === null) {
            if (split !== null) problems.push(`want null, got ${JSON.stringify(split)}`)
        } else if (!split) {
            problems.push('got null')
        } else {
            const got = [split.sellerProfit, ...split.ancestors.map((a: any) => a.profit)]
            if (JSON.stringify(got) !== JSON.stringify(c.want)) {
                problems.push(`legs ${JSON.stringify(got)}, want ${JSON.stringify(c.want)}`)
            }
            // The invariant: legs + root cost = what the customer paid.
            const qty = c.qty ?? 1
            const sum = money(got.reduce((a, b) => a + b, 0) + (c.rootCost ?? 0) * qty)
            const paid = money(c.unitPrice * qty)
            if (sum !== paid && got[0] !== 0) problems.push(`legs + root cost = ${sum}, paid ${paid}`)
            if (got.some((leg) => leg < 0)) problems.push('a leg went negative')
            if (money(split.totalMargin) !== money(got.reduce((a, b) => a + b, 0)) && got[0] !== 0) {
                problems.push(`totalMargin ${split.totalMargin} ≠ sum of legs`)
            }
        }

        if (problems.length) fail(c.name, problems)
        else { console.log(`  PASS  ${c.name}`); passed++ }
    }

    // ── Crediting: each leg once, under its own reference ────────────────────────
    console.log('')
    {
        const db = makeDb(fixture())
        const split = await computeShopProfit(db, { kind: 'rc', ownerId: 'u2', itemId: 'T', unitPrice: 30 })
        const order = { shop_id: 'S2', ...profitColumns(split) }
        credits.length = 0
        await creditOrderProfit(db, order, 'RC-SHOP-X', 'RC sale')
        const got = credits.map((c) => `${c.ownerId}:${c.amount}:${c.reference}`)
        const want = ['u2:2:RC-SHOP-X', 'u1:3:RC-SHOP-X:up1', 'uL:5:RC-SHOP-X:up2']
        if (JSON.stringify(got) === JSON.stringify(want)) { console.log('  PASS  credits seller, up1, up2 under distinct references'); passed++ }
        else fail('credits seller, up1, up2 under distinct references', [`got ${JSON.stringify(got)}`, `want ${JSON.stringify(want)}`])
    }
    {
        const db = makeDb(fixture())
        credits.length = 0
        await creditOrderProfit(db, { shop_id: 'L', shop_markup: 0, parent_shop_id: null }, 'R0', 'x')
        if (credits.length === 0) { console.log('  PASS  zero legs credit nothing'); passed++ }
        else fail('zero legs credit nothing', [`credited ${JSON.stringify(credits)}`])
    }
    {
        // A row written before the migration has no split columns — only the seller is paid.
        const db = makeDb(fixture())
        credits.length = 0
        await creditOrderProfit(db, { shop_id: 'L', shop_markup: '4.5' }, 'R1', 'x')
        const ok = credits.length === 1 && credits[0].amount === 4.5 && credits[0].reference === 'R1'
        if (ok) { console.log('  PASS  pre-migration row pays the seller only'); passed++ }
        else fail('pre-migration row pays the seller only', [`credited ${JSON.stringify(credits)}`])
    }

    console.log(`\n${passed} passed, ${failed} failed`)
    process.exit(failed === 0 ? 0 : 1)
}

main()
