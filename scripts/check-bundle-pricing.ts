/**
 * Proves Standard Bundle pricing never sells below KingFlexy's catalog price and
 * puts each buyer on the right markup tier.
 *
 * Pure and offline. Run:
 *
 *   npx tsx scripts/check-bundle-pricing.ts
 */
import { bundleKey, parseMarkupSettings, priceBundle, resolveBundleTier } from '../lib/bundle-pricing'

let failures = 0
function check(name: string, actual: unknown, expected: unknown) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected)
    if (!ok) failures++
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      expected ${JSON.stringify(expected)}\n      actual   ${JSON.stringify(actual)}`}`)
}

const markup = parseMarkupSettings({
    bundles_markup_percent_customer: '5',
    bundles_markup_percent_agent: '2',
    bundles_markup_percent_dealer: '1',
    bundles_markup_percent_api: '2',
    bundles_markup_min_ghs: '0',
})

// ── Arithmetic ──────────────────────────────────────────────────────────────
check('customer 5% on 9.60', priceBundle(9.6, 'customer', markup), { cost: 9.6, markup: 0.48, total: 10.08 })
check('agent 2% on 9.60', priceBundle(9.6, 'agent', markup), { cost: 9.6, markup: 0.2, total: 9.8 })
// 0.49 * 1% = 0.0049 -> rounds UP to a whole pesewa, never down to 0.
check('dealer 1% on 0.49 rounds up', priceBundle(0.49, 'dealer', markup), { cost: 0.49, markup: 0.01, total: 0.5 })
// Float noise must not ceil an exact amount up a pesewa.
check('no float creep at 0%', priceBundle(15.99, 'customer', parseMarkupSettings({ bundles_markup_percent_customer: '0' })), { cost: 15.99, markup: 0, total: 15.99 })

const withMin = parseMarkupSettings({ bundles_markup_percent_customer: '1', bundles_markup_min_ghs: '0.20' })
check('minimum markup wins on a cheap bundle', priceBundle(0.99, 'customer', withMin), { cost: 0.99, markup: 0.2, total: 1.19 })
check('percent wins on a dear bundle', priceBundle(396.68, 'customer', withMin), { cost: 396.68, markup: 3.97, total: 400.65 })

// ── Never below cost ────────────────────────────────────────────────────────
let belowCost = 0
let fractional = 0
for (let pesewas = 1; pesewas <= 50_000; pesewas += 7) {
    const cost = pesewas / 100
    for (const tier of ['customer', 'agent', 'dealer', 'api'] as const) {
        const p = priceBundle(cost, tier, markup)
        if (p.total < cost) belowCost++
        // x * 100 is not exact in floating point, so compare within a tolerance.
        if (Math.abs(p.total * 100 - Math.round(p.total * 100)) > 1e-6) fractional++
    }
}
check('never below cost (sweep)', belowCost, 0)
check('always whole pesewas (sweep)', fractional, 0)

// ── Settings parsing ────────────────────────────────────────────────────────
// A blank or garbage tier falls back to the customer markup, never to 0.
const sparse = parseMarkupSettings({ bundles_markup_percent_customer: '4', bundles_markup_percent_agent: 'abc' })
check('garbage tier falls back to customer', sparse.percent.agent, 4)
check('missing tier falls back to customer', sparse.percent.api, 4)
check('nothing set defaults to 5%', parseMarkupSettings({}).percent.customer, 5)
check('negative rejected', parseMarkupSettings({ bundles_markup_percent_customer: '-3' }).percent.customer, 5)

// ── Tier resolution ─────────────────────────────────────────────────────────
const now = new Date('2026-10-26T12:00:00Z')
check('api user beats dealer', resolveBundleTier({ role: 'dealer', is_api_user: true }, now), 'api')
check('active dealer', resolveBundleTier({ role: 'dealer', dealer_expires_at: '2026-11-01T00:00:00Z' }, now), 'dealer')
check('lapsed dealer is a customer', resolveBundleTier({ role: 'dealer', dealer_expires_at: '2026-10-01T00:00:00Z' }, now), 'customer')
check('lifetime agent', resolveBundleTier({ role: 'agent', agent_expires_at: null }, now), 'agent')
check('lapsed agent is a customer', resolveBundleTier({ role: 'agent', agent_expires_at: '2026-10-25T00:00:00Z' }, now), 'customer')
check('admin buys as customer', resolveBundleTier({ role: 'admin' }, now), 'customer')

// ── Keys ────────────────────────────────────────────────────────────────────
check('pack key', bundleKey({ packId: 'P1', value: 'x', amount: 9.6 }), 'p:P1')
check('value key carries amount', bundleKey({ packId: null, value: 'abc', amount: 20 }), 'v:20.00:abc')

console.log(failures ? `\n${failures} FAILED` : '\nAll bundle pricing checks passed.')
process.exit(failures ? 1 : 0)
