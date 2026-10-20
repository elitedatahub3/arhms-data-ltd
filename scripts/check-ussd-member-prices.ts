/**
 * Read-only check: for real accounts, does the USSD member menu quote exactly what
 * the dashboard would charge?
 *
 * Picks one account of each kind (customer, agent, dealer, sub-agent, API user where
 * present), recognises it by phone the way the USSD dial-in does, builds its bundle and
 * checker lists, and compares every bundle price with resolveDataPrice() — the function
 * the wallet purchase charges with. Writes nothing.
 *
 * Run:
 *   TS_NODE_COMPILER_OPTIONS='{"module":"commonjs","moduleResolution":"node"}' \
 *     npx ts-node --transpile-only scripts/check-ussd-member-prices.ts
 */
import fs from 'fs'
import Module from 'module'
import path from 'path'

const REPO_ROOT = path.resolve(__dirname, '..')
for (const file of ['.env.local', '.env']) {
    const p = path.join(REPO_ROOT, file)
    if (!fs.existsSync(p)) continue
    for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
    }
}
const originalLoad = (Module as any)._load
;(Module as any)._load = function (request: string, parent: unknown, isMain: boolean) {
    if (request.startsWith('@/')) return originalLoad.apply(this, [path.join(REPO_ROOT, request.slice(2)), parent, isMain])
    return originalLoad.apply(this, [request, parent, isMain])
}

/* eslint-disable @typescript-eslint/no-var-requires */
const { createServerClient } = require('@/lib/supabase')
const { findMemberByPhone, loadMemberBundles, loadMemberCheckers, phoneVariants } = require('@/lib/ussd-member')
const { resolveDataPrice } = require('@/lib/data-order-pricing')
/* eslint-enable @typescript-eslint/no-var-requires */

async function main() {
    const db = createServerClient() as any
    let failed = 0

    const { data: subs } = await db.from('sub_agents').select('user_id').eq('status', 'active').limit(1)
    const picks: Array<{ label: string; filter: (q: any) => any }> = [
        { label: 'customer', filter: (q) => q.eq('role', 'customer') },
        { label: 'agent', filter: (q) => q.eq('role', 'agent') },
        { label: 'dealer', filter: (q) => q.eq('role', 'dealer') },
        { label: 'api user', filter: (q) => q.eq('is_api_user', true) },
        ...(subs?.[0] ? [{ label: 'sub-agent', filter: (q: any) => q.eq('id', subs[0].user_id) }] : []),
    ]

    for (const pick of picks) {
        const { data: users } = await pick.filter(
            db.from('users').select('id, phone_number, role').not('phone_number', 'is', null).eq('status', 'active')
        ).limit(5)
        const user = (users || []).find((u: any) => phoneVariants(u.phone_number).length > 0)
        if (!user) { console.log(`- ${pick.label}: no account to test`); continue }

        // Dial in as the international form Hubtel sends.
        const msisdn = `233${phoneVariants(user.phone_number)[0].slice(1)}`
        const member = await findMemberByPhone(db, msisdn)
        if (!member || member.userId !== user.id) {
            console.log(`  FAIL  ${pick.label}: not recognised by phone (shared number or inactive?)`)
            failed++
            continue
        }

        const [bundles, checkers] = await Promise.all([loadMemberBundles(db, member), loadMemberCheckers(db, member)])
        const { data: packages } = await db.from('data_packages').select('*').in('id', bundles.map((b: any) => b.id))
        const pkgById = new Map((packages || []).map((p: any) => [p.id, p]))

        let mismatches = 0
        for (const b of bundles) {
            const r = await resolveDataPrice(db, user.id, pkgById.get(b.id))
            if (!r.ok || Number(r.data.price) !== Number(b.price)) {
                mismatches++
                if (mismatches <= 3) console.log(`          ${b.network} ${b.size}: menu ${b.price}, dashboard ${r.ok ? r.data.price : r.error}`)
            }
        }
        const ok = mismatches === 0
        if (!ok) failed++
        console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${pick.label} (${member.role}${member.sub ? ', sub' : ''}${member.isApiUser ? ', api' : ''}): ` +
            `${bundles.length} bundles all match the dashboard price${ok ? '' : ` — ${mismatches} mismatch(es)`}; ${checkers.length} checkers` +
            (checkers[0] ? ` (e.g. ${checkers[0].name} GHS ${checkers[0].price})` : ''))
    }

    // A number nobody owns must not be recognised.
    const stranger = await findMemberByPhone(db, '233209999999')
    console.log(`  ${stranger ? 'FAIL' : 'PASS'}  an unknown number is not a member`)
    if (stranger) failed++

    process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
