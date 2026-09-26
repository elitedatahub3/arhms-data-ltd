/**
 * Proves the utility markup split never overcharges a customer.
 *
 * The one rule that matters is a TOTAL: platform fee plus every reseller margin
 * must never exceed utility_total_markup_cap_percent. That is easy to state and
 * easy to get wrong once a sub-agent chain is involved, because the levels are
 * configured independently and none of them can see the others.
 *
 * Pure and offline — the database is a fake, so this makes no network calls and
 * touches nothing. Run:
 *
 *   npx tsx --env-file=.env.local scripts/check-utility-markup.ts
 *
 * The env file is only needed because importing the pricing module pulls in the
 * Supabase client transitively; nothing here reads it.
 */
import { computeUtilityMarkup, headroomFor } from '../lib/utility-shop-pricing'

// ─── Fake database ───────────────────────────────────────────────────────────
// Mimics only the query shapes the code under test actually uses: a settings
// lookup by key, a shop lookup by id, and the two sub_agents reads that
// resolveSubAgentChain() walks.

interface FakeShop { id: string; owner_id: string; utility_fee_percent: number }

function makeDb(opts: {
    settings: Record<string, string>
    shops: FakeShop[]
    /** userId -> upline shopId */
    uplineOf: Record<string, string>
}) {
    const shopById = new Map(opts.shops.map(s => [s.id, s]))

    const result = (data: any) => ({
        select() { return this },
        eq() { return this },
        in() { return this },
        maybeSingle: async () => ({ data }),
        single: async () => ({ data }),
    })

    return {
        from(table: string) {
            const self: any = {
                _table: table,
                _key: null as string | null,
                _id: null as string | null,
                _userId: null as string | null,
                select() { return self },
                in() { return self },
                eq(col: string, val: string) {
                    if (col === 'key') self._key = val
                    if (col === 'id') self._id = val
                    if (col === 'user_id') self._userId = val
                    return self
                },
                async maybeSingle() {
                    if (table === 'admin_settings') {
                        const v = opts.settings[self._key as string]
                        return { data: v === undefined ? null : { value: v } }
                    }
                    if (table === 'shop_profiles') {
                        return { data: shopById.get(self._id as string) ?? null }
                    }
                    if (table === 'sub_agents') {
                        const upline = opts.uplineOf[self._userId as string]
                        return { data: upline ? { upline_shop_id: upline, id: 'm-' + self._userId } : null }
                    }
                    return { data: null }
                },
                async single() { return self.maybeSingle() },
            }
            return self
        },
    }
}

// ─── Harness ─────────────────────────────────────────────────────────────────
let failures = 0
function check(name: string, actual: unknown, expected: unknown) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected)
    if (a === e) { console.log(`  PASS  ${name}`) }
    else { failures++; console.log(`  FAIL  ${name}\n          expected ${e}\n          actual   ${a}`) }
}

const SETTINGS = {
    utility_total_markup_cap_percent: '5',
    utility_fee_dstv_customer: '2',
    utility_fee_dstv_agent: '1',
}

async function main() {
    console.log('\nUtility markup split — cap is 5% TOTAL on a GHS 100 bill\n')

    // 1. No shop: a dashboard sale is platform fee only.
    {
        const db = makeDb({ settings: SETTINGS, shops: [], uplineOf: {} })
        const m = await computeUtilityMarkup(db, { shopId: null, service: 'dstv', ownerRole: 'customer', billAmount: 100 })
        check('dashboard sale takes platform fee only', [m.totalPercent, m.totalFee, m.legs.length], [2, 2, 0])
    }

    // 2. Lone shop inside the budget.
    {
        const db = makeDb({
            settings: SETTINGS,
            shops: [{ id: 'shopA', owner_id: 'userA', utility_fee_percent: 3 }],
            uplineOf: {},
        })
        const m = await computeUtilityMarkup(db, { shopId: 'shopA', service: 'dstv', ownerRole: 'customer', billAmount: 100 })
        check('shop 3% + platform 2% = 5% exactly', [m.platformPercent, m.resellerPercent, m.totalPercent, m.trimmed], [2, 3, 5, false])
        check('customer pays GHS 5 on a GHS 100 bill', m.totalFee, 5)
    }

    // 3. Shop asks for more than the budget allows — trimmed to the cap.
    {
        const db = makeDb({
            settings: SETTINGS,
            shops: [{ id: 'shopA', owner_id: 'userA', utility_fee_percent: 5 }],
            uplineOf: {},
        })
        const m = await computeUtilityMarkup(db, { shopId: 'shopA', service: 'dstv', ownerRole: 'customer', billAmount: 100 })
        check('shop wanting 5% is trimmed to 3%', [m.resellerPercent, m.totalPercent, m.trimmed], [3, 5, true])
    }

    // 4. Sub-agent under a Lead: both paid, cap still holds.
    {
        const db = makeDb({
            settings: SETTINGS,
            shops: [
                { id: 'shopSub', owner_id: 'userSub', utility_fee_percent: 2 },
                { id: 'shopLead', owner_id: 'userLead', utility_fee_percent: 1 },
            ],
            uplineOf: { userSub: 'shopLead' },
        })
        const m = await computeUtilityMarkup(db, { shopId: 'shopSub', service: 'dstv', ownerRole: 'customer', billAmount: 100 })
        check('sub 2% + lead 1% + platform 2% = 5%', m.totalPercent, 5)
        check('two legs, selling shop first', m.legs.map(l => [l.shopId, l.percent]), [['shopSub', 2], ['shopLead', 1]])
    }

    // 5. Chain configured over the cap: the FURTHEST level absorbs the loss.
    {
        const db = makeDb({
            settings: SETTINGS,
            shops: [
                { id: 'shopSub', owner_id: 'userSub', utility_fee_percent: 3 },
                { id: 'shopLead', owner_id: 'userLead', utility_fee_percent: 3 },
            ],
            uplineOf: { userSub: 'shopLead' },
        })
        const m = await computeUtilityMarkup(db, { shopId: 'shopSub', service: 'dstv', ownerRole: 'customer', billAmount: 100 })
        check('never exceeds the cap', m.totalPercent, 5)
        check('selling shop keeps its 3%, lead trimmed to 0%', m.legs.map(l => [l.shopId, l.percent]), [['shopSub', 3]])
        check('trimming is reported', m.trimmed, true)
    }

    // 6. Agent-owned shop: lower platform fee leaves more room for the shop.
    {
        const db = makeDb({
            settings: SETTINGS,
            shops: [{ id: 'shopA', owner_id: 'userA', utility_fee_percent: 4 }],
            uplineOf: {},
        })
        const m = await computeUtilityMarkup(db, { shopId: 'shopA', service: 'dstv', ownerRole: 'agent', billAmount: 100 })
        check('agent platform fee 1% leaves 4% for the shop', [m.platformPercent, m.resellerPercent, m.totalPercent, m.trimmed], [1, 4, 5, false])
    }

    // 7. headroomFor is what the pricing screen shows.
    {
        const db = makeDb({
            settings: SETTINGS,
            shops: [
                { id: 'shopSub', owner_id: 'userSub', utility_fee_percent: 0 },
                { id: 'shopLead', owner_id: 'userLead', utility_fee_percent: 2 },
            ],
            uplineOf: { userSub: 'shopLead' },
        })
        const h = await headroomFor(db, 'shopSub', 'dstv', 'customer')
        check('sub under a 2% lead has 1% of room', [h.cap, h.platform, h.upline, h.headroom], [5, 2, 2, 1])
    }

    // 8. Upline already using the whole budget.
    {
        const db = makeDb({
            settings: SETTINGS,
            shops: [
                { id: 'shopSub', owner_id: 'userSub', utility_fee_percent: 0 },
                { id: 'shopLead', owner_id: 'userLead', utility_fee_percent: 5 },
            ],
            uplineOf: { userSub: 'shopLead' },
        })
        const h = await headroomFor(db, 'shopSub', 'dstv', 'customer')
        check('headroom floors at 0, never negative', h.headroom, 0)
    }

    // 9. Rounding: a cap breach by fractions of a pesewa is still a breach.
    {
        const db = makeDb({
            settings: { ...SETTINGS, utility_fee_dstv_customer: '2.5' },
            shops: [{ id: 'shopA', owner_id: 'userA', utility_fee_percent: 2.5 }],
            uplineOf: {},
        })
        const m = await computeUtilityMarkup(db, { shopId: 'shopA', service: 'dstv', ownerRole: 'customer', billAmount: 33.33 })
        check('fractional percentages still total the cap', m.totalPercent, 5)

        // Each leg is rounded to a pesewa and the total is their SUM, not the whole
        // percentage rounded once. On GHS 33.33 that is 0.83 + 0.83 = 1.66 rather
        // than 1.67, and the difference matters: computing the total independently
        // would leave a pesewa belonging to nobody, and paying it to someone would
        // put the customer a pesewa over the cap. Under is safe, over is not.
        const legSum = Math.round((m.platformAmount + m.resellerAmount) * 100) / 100
        check('total charged equals the sum of the parts', m.totalFee, legSum)
        check('never rounds above the cap', m.totalFee <= 33.33 * 0.05, true)
    }

    console.log(failures === 0
        ? `\n  All checks passed. A customer can never be charged more than the cap.\n`
        : `\n  ${failures} FAILED\n`)
    process.exit(failures === 0 ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(1) })
