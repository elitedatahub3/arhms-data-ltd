/**
 * Back-pay uplines for Results Checker sales their sub-agents made before the
 * profit split existed (lib/shop-profit.ts, migration 20261018010000).
 *
 * Until then a sub's checker sale paid the sub the whole margin and every upline
 * nothing. This lists each completed sub-shop checker order with what each upline
 * is owed, and — only with --apply — pays it. The subs' past earnings are left
 * alone: this only adds what the uplines never got.
 *
 * Amounts use each upline's CURRENT price, because the price at the time of sale
 * was never recorded. Read the list before applying it.
 *
 * Safe to run repeatedly: each leg is paid under `<reference>:up1` / `:up2`, the
 * same references live settlement uses, so a leg already paid (by a previous run,
 * or by settlement after the fix) is reported and skipped.
 *
 * Run (lists only):
 *   TS_NODE_COMPILER_OPTIONS='{"module":"commonjs","moduleResolution":"node"}' \
 *     npx ts-node --transpile-only scripts/backfill-upline-rc-profit.ts
 * Pay, after an admin has approved the list:
 *   ... scripts/backfill-upline-rc-profit.ts --apply
 */
import fs from 'fs'
import Module from 'module'
import path from 'path'

const REPO_ROOT = path.resolve(__dirname, '..')

// Same env loading as scripts/diagnose-paystack-ussd.ts — no dotenv dependency.
for (const file of ['.env.local', '.env']) {
    const p = path.join(REPO_ROOT, file)
    if (!fs.existsSync(p)) continue
    for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
    }
}

// Resolve the '@/' alias by hand (tsconfig paths have no baseUrl).
const originalLoad = (Module as any)._load
;(Module as any)._load = function (request: string, parent: unknown, isMain: boolean) {
    if (request.startsWith('@/')) {
        return originalLoad.apply(this, [path.join(REPO_ROOT, request.slice(2)), parent, isMain])
    }
    return originalLoad.apply(this, [request, parent, isMain])
}

/* eslint-disable @typescript-eslint/no-var-requires */
const { createServerClient } = require('@/lib/supabase')
const { computeShopProfit } = require('@/lib/shop-profit')
const { creditShopRcProfit } = require('@/lib/shop-service')
/* eslint-enable @typescript-eslint/no-var-requires */

const APPLY = process.argv.includes('--apply')

async function main() {
    const db = createServerClient() as any

    const { data: subs } = await db.from('sub_agents').select('user_id')
    const subUserIds = new Set<string>((subs || []).map((s: any) => s.user_id))

    const { data: shops } = await db.from('shop_profiles').select('id, owner_id, shop_name')
    const shopById = new Map<string, any>((shops || []).map((s: any) => [s.id, s]))

    const { data: orders, error } = await db
        .from('results_checker_orders')
        .select('id, reference_code, shop_id, type_id, type_name, quantity, unit_price, status, created_at')
        .eq('status', 'completed')
        .not('shop_id', 'is', null)
        .order('created_at', { ascending: true })
    if (error) throw error

    const subOrders = (orders || []).filter((o: any) => {
        const shop = shopById.get(o.shop_id)
        return shop && subUserIds.has(shop.owner_id)
    })

    console.log(`${subOrders.length} completed checker order(s) sold by sub-agent shops.\n`)
    console.log('date       | reference              | type    | qty | sold  | upline (leg)                 | owed  | status')
    console.log('-'.repeat(118))

    let owed = 0
    let paid = 0
    let skipped = 0

    for (const o of subOrders) {
        const seller = shopById.get(o.shop_id)
        const split = await computeShopProfit(db, {
            kind: 'rc',
            ownerId: seller.owner_id,
            itemId: o.type_id,
            unitPrice: Number(o.unit_price),
            qty: Number(o.quantity) || 1,
        })
        if (!split || split.ancestors.length === 0) {
            console.log(`${o.created_at.slice(0, 10)} | ${o.reference_code.padEnd(22)} | ${String(o.type_name).padEnd(7)} | no upline price today — skipped`)
            continue
        }

        for (let i = 0; i < split.ancestors.length; i++) {
            const leg = split.ancestors[i]
            if (!(leg.profit > 0)) continue
            const reference = `${o.reference_code}:up${i + 1}`
            const upline = shopById.get(leg.shopId)

            const { data: existing } = await db
                .from('shop_wallet_transactions')
                .select('id')
                .eq('reference', reference)
                .eq('type', 'profit')
                .maybeSingle()

            let status = existing ? 'already paid' : APPLY ? 'PAID' : 'owed'
            if (!existing) {
                owed += leg.profit
                if (APPLY) {
                    const result = await creditShopRcProfit({
                        ownerId: leg.ownerId,
                        amount: leg.profit,
                        description: `Back-pay: sub-agent RC sale ${o.type_name} x${o.quantity}`,
                        reference,
                    })
                    if (result.credited) paid += leg.profit
                    else status = `NOT PAID (${result.reason})`
                }
            } else {
                skipped++
            }

            console.log(
                `${o.created_at.slice(0, 10)} | ${o.reference_code.padEnd(22)} | ${String(o.type_name).padEnd(7)} | ` +
                `${String(o.quantity).padStart(3)} | ${String(o.unit_price).padStart(5)} | ` +
                `${String(upline?.shop_name ?? leg.shopId).slice(0, 22).padEnd(22)} (up${i + 1}) | ` +
                `${leg.profit.toFixed(2).padStart(5)} | ${status}`
            )
        }
    }

    console.log('-'.repeat(118))
    console.log(`Owed to uplines: GHS ${owed.toFixed(2)}  ·  legs already paid: ${skipped}`)
    if (APPLY) console.log(`Paid this run:   GHS ${paid.toFixed(2)}`)
    else console.log('Nothing was paid. Re-run with --apply once an admin has approved this list.')
}

main().catch((err) => {
    console.error(err)
    process.exit(1)
})
