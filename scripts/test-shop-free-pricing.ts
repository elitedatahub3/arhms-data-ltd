/**
 * Test: shop profit with owner-set (uncapped) prices
 *
 * The GHS 10 / 5 profit cap is gone, so a shop can sell at cost + 25 or more.
 * This pins the arithmetic every money path relies on:
 *   - ownerCostPrice() picks the same cost the pricing save, checkout and
 *     settlement all use (dealer → agent → base, a role price only when > 0);
 *   - profit = selling − cost, to the pesewa, with nothing clamped;
 *   - a sub-agent chain still splits a large margin with no pesewa lost.
 *
 * Pure arithmetic, no database.
 *
 * Run: npx tsx scripts/test-shop-free-pricing.ts
 *
 * Exit code: 0 = all pass, 1 = any fail
 */

import { ownerCostPrice, MAX_SHOP_PROFIT_GHS } from '@/lib/shop-price-limits'
import { splitChainProfit, type ChainLevel } from '@/lib/pricing/chain-cost'

let failures = 0
const check = (name: string, actual: unknown, expected: unknown) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected)
    if (!ok) failures++
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`)
}

const profit = (selling: number, cost: number) => Math.round((selling - cost) * 100) / 100

// A package as data_packages returns it — numerics often arrive as strings.
const pkg = { price: '12.00', agent_price: '10.50', dealer_price: '9.80' }

// ===== cost ladder =====
check('customer pays base price', ownerCostPrice(pkg, 'customer'), 12)
check('agent pays agent_price', ownerCostPrice(pkg, 'agent'), 10.5)
check('dealer pays dealer_price', ownerCostPrice(pkg, 'dealer'), 9.8)
check('unknown role falls back to base', ownerCostPrice(pkg, null), 12)
check('agent with agent_price 0 pays base, not 0',
    ownerCostPrice({ price: 12, agent_price: 0 }, 'agent'), 12)
check('dealer with no dealer_price pays base',
    ownerCostPrice({ price: 12, agent_price: 10.5, dealer_price: null }, 'dealer'), 12)

// ===== profit is not clamped =====
check('agent at cost + 25 keeps all 25', profit(35.5, ownerCostPrice(pkg, 'agent')), 25)
check('customer-role at cost + 40 keeps all 40', profit(52, ownerCostPrice(pkg, 'customer')), 40)
check('dealer profit is off dealer cost', profit(20, ownerCostPrice(pkg, 'dealer')), 10.2)
check('float noise rounds to the pesewa', profit(10.5 + 0.1 + 0.2, 10.5), 0.3)
check('sanity limit is GHS 1000', MAX_SHOP_PROFIT_GHS, 1000)

// ===== sub-agent chain with a big parent margin =====
// Root agent sells at cost 10.50 + 30 = 40.50 and wholesales to its sub at 30.
// The sub retails at 45. Legs: sub 15, root 30 − 10.50 = 19.50.
const level = (wholesale: number | null, cost: number | null, n: string): ChainLevel => ({
    shopId: `shop-${n}`, ownerId: `owner-${n}`, depth: 0, isSub: false, wholesale, cost,
})
const split = splitChainProfit(45, [level(30, 10.5, 'root')])
check('sub leg', split?.sellerProfit, 15)
check('root leg', split?.ancestorProfits, [19.5])
check('legs sum to selling − root cost', split?.totalMargin, profit(45, 10.5))

console.log(failures === 0 ? '\nAll passed' : `\n${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
