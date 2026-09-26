/**
 * Proves the commission credit pays exactly once.
 *
 * The property worth testing is not "does it add money" — it is "does a callback
 * racing the reconciliation cron add it twice". finalizeUtilityOrder is reachable
 * from three directions at the same moment, so this drives creditCommissionForOrder
 * concurrently AND sequentially against a real order and asserts the wallet moved
 * once.
 *
 * Usage — needs a COMPLETED bill payment placed with a Commission Services key:
 *
 *   npx tsx --env-file=.env.local scripts/check-commission-earning.ts <order-id>
 *
 * Unlike check-utility-normalizer.ts this one really does touch the database, and it
 * writes: it moves the commission wallet. Point it at a test order.
 *
 * Pass --reset to clear commission_credited_at and the ledger row first, so the same
 * order can be re-tested. It does NOT reverse the wallet balance — the delta this
 * prints is what matters, not the absolute figure.
 */
import { createServerClient } from '../lib/supabase'
import { creditCommissionForOrder, commissionSharePercent } from '../lib/commission-earning'

function fail(message: string): never {
    console.error(`\n  FAIL  ${message}\n`)
    process.exit(1)
}

async function main() {
    const [, , orderId, ...rest] = process.argv
    const reset = rest.includes('--reset')

    if (!orderId) fail('Pass the utility order id as the first argument.')

    const supabase = createServerClient() as any

    const { data: order } = await supabase
        .from('utility_orders')
        .select('*')
        .eq('id', orderId)
        .maybeSingle()

    if (!order) fail(`No utility order with id ${orderId}.`)

    const pct = await commissionSharePercent(supabase)

    console.log(`\n  Order       ${order.reference_code}`)
    console.log(`  Status      ${order.status}`)
    console.log(`  Key         ${order.api_key_id ?? '(none — placed outside the API)'}`)
    console.log(`  Bill        GHS ${Number(order.bill_amount).toFixed(2)}`)
    console.log(`  Provider    ${order.commission == null ? '(not reported yet)' : `GHS ${Number(order.commission).toFixed(4)}`}`)
    console.log(`  Share       ${pct}%`)

    if (!order.api_key_id) {
        fail('This order has no api_key_id, so it can never earn. Place one through /api/v2/utilities/pay with a commission key.')
    }
    if (order.status !== 'completed') {
        console.warn(`  NOTE        status is "${order.status}"; the real callers only credit on "completed".`)
    }
    if (order.commission == null) {
        console.warn('  NOTE        no provider commission recorded, so nothing should be credited yet.')
    }

    if (reset) {
        await supabase.from('utility_orders').update({ commission_credited_at: null }).eq('id', orderId)
        await supabase.from('commission_transactions').delete().eq('source', 'utility').eq('order_id', orderId)
        console.log('  Reset       cleared the latch and any existing ledger row.')
    }

    const readWallet = async (): Promise<number> => {
        const { data } = await supabase
            .from('commission_wallets')
            .select('balance')
            .eq('owner_id', order.user_id)
            .maybeSingle()
        return Number(data?.balance ?? 0)
    }

    const countLedger = async (): Promise<number> => {
        const { count } = await supabase
            .from('commission_transactions')
            .select('id', { count: 'exact', head: true })
            .eq('source', 'utility')
            .eq('order_id', orderId)
        return count ?? 0
    }

    const before = await readWallet()
    console.log(`\n  Balance before  GHS ${before.toFixed(2)}`)

    // Concurrent: the callback-vs-cron race the latch exists for.
    await Promise.all([
        creditCommissionForOrder({ orderId }),
        creditCommissionForOrder({ orderId }),
        creditCommissionForOrder({ orderId }),
    ])

    // Sequential: a later retry must not top it up again either.
    await creditCommissionForOrder({ orderId })

    const after = await readWallet()
    const rows = await countLedger()
    const delta = Number((after - before).toFixed(2))

    console.log(`  Balance after   GHS ${after.toFixed(2)}`)
    console.log(`  Credited        GHS ${delta.toFixed(2)}`)
    console.log(`  Ledger rows     ${rows}`)

    if (rows > 1) fail(`Paid ${rows} times. The commission_credited_at latch is not holding.`)

    if (rows === 0 && delta === 0) {
        console.log('\n  OK    Nothing credited — expected when the key is not a commission key,')
        console.log('        the provider commission is not in yet, the share is zero, or the')
        console.log('        order was already paid without --reset.\n')
        return
    }

    if (rows !== 1) fail(`Expected exactly 1 ledger row, found ${rows}.`)

    const { data: tx } = await supabase
        .from('commission_transactions')
        .select('amount, description')
        .eq('source', 'utility')
        .eq('order_id', orderId)
        .maybeSingle()

    if (Math.abs(Number(tx.amount) - delta) > 0.005) {
        fail(`Ledger says GHS ${Number(tx.amount).toFixed(2)} but the wallet moved GHS ${delta.toFixed(2)}.`)
    }

    // The whole point of the share-of-commission model: it can never exceed what the
    // provider paid us.
    const providerCommission = Number(order.commission)
    if (Number.isFinite(providerCommission) && delta > providerCommission + 0.005) {
        fail(`Paid GHS ${delta.toFixed(2)} but Hubtel only paid us GHS ${providerCommission.toFixed(4)}.`)
    }

    const expected = Math.round((providerCommission * (pct / 100) + Number.EPSILON) * 100) / 100
    if (Number.isFinite(expected) && Math.abs(expected - delta) > 0.005) {
        fail(`Expected ${pct}% of GHS ${providerCommission.toFixed(4)} = GHS ${expected.toFixed(2)}, got GHS ${delta.toFixed(2)}.`)
    }

    console.log(`\n  PASS  Four calls, one payment of GHS ${delta.toFixed(2)}.`)
    console.log(`        "${tx.description}"\n`)
}

main().catch(err => {
    console.error(err)
    process.exit(1)
})
