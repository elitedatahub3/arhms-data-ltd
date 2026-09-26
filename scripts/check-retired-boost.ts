/**
 * Proves a payment for a retired product can never reach the wallet catch-all.
 *
 * Every payment handler ends in "anything else is a wallet top-up". Classifieds listing
 * boosts (BOOST- references) used to be intercepted above that; the product is gone, and
 * simply deleting the interception would let a confirmed BOOST- payment fall through and
 * credit the payer's wallet. So each handler keeps an explicit guard, and this checks — from
 * the source itself, since the handlers need real gateway signatures to run — that the guard
 * still sits ahead of every wallet-credit call.
 *
 * It also checks the removal stayed complete: no code imports a deleted module, and the
 * deleted directories have not come back.
 *
 * Usage — no environment or database needed:
 *
 *   npx tsx scripts/check-retired-boost.ts
 */
import fs from 'fs'
import path from 'path'
import { isRetiredBoostReference, RETIRED_BOOST_MESSAGE } from '../lib/retired-boost'

let failures = 0
function check(name: string, ok: boolean, detail = '') {
    if (!ok) failures++
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? `\n         ${detail}` : ''}`)
}

const root = path.resolve(__dirname, '..')
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8')

console.log('\nthe guard itself')
check('a BOOST- reference is recognised', isRetiredBoostReference('BOOST-GHD-ABC-123'))
check('a wallet reference is not', !isRetiredBoostReference('WAL-123'))
check('other direct-pay prefixes are not', !isRetiredBoostReference('DATA-1') && !isRetiredBoostReference('UTIL-1') && !isRetiredBoostReference('AIRPAY-1'))
check('the prefix is case-sensitive, as the old routing was', !isRetiredBoostReference('boost-1'))
check('empty and missing references are not', !isRetiredBoostReference('') && !isRetiredBoostReference(null) && !isRetiredBoostReference(undefined))
check('the payer-facing message points to support', /support/i.test(RETIRED_BOOST_MESSAGE))

console.log('\nevery payment handler catches BOOST- before it can credit a wallet')
const HANDLERS = [
    'app/api/webhooks/paystack/route.ts',
    'app/api/webhooks/hubtel/route.ts',
    'app/api/webhooks/moolre/route.ts',
    'app/api/webhooks/payswitch/route.ts',
    'app/api/payments/verify/route.ts',
    'app/api/cron/verify-hubtel-payments/route.ts',
    'app/api/cron/verify-moolre-payments/route.ts',
    'app/api/cron/verify-paystack-momo-payments/route.ts',
    'app/api/cron/verify-payswitch-payments/route.ts',
]
for (const rel of HANDLERS) {
    const src = read(rel)
    // Calls only, not the import line.
    const walletCalls = [...src.matchAll(/(?<!import \{ )processCompletedWalletPayment\(/g)].map(m => m.index!)
    const guards = [...src.matchAll(/isRetiredBoostReference\(/g)].map(m => m.index!)
    // Each wallet call needs a guard somewhere between the previous wallet call and itself.
    let prev = -1
    const unguarded: number[] = []
    for (const call of walletCalls) {
        if (!guards.some(g => g > prev && g < call)) unguarded.push(call)
        prev = call
    }
    check(`${rel}`, guards.length > 0 && walletCalls.length > 0 && unguarded.length === 0,
        `guards: ${guards.length}, wallet calls: ${walletCalls.length}, wallet calls with no guard before them: ${unguarded.length}`)
}

console.log('\nthe removal stayed complete')
for (const rel of ['app/classifieds', 'app/marketplace-domain', 'app/api/classifieds', 'app/api/marketplace',
                   'components/classifieds', 'components/marketplace', 'lib/classifieds-payments.ts']) {
    check(`${rel} is gone`, !fs.existsSync(path.join(root, rel)))
}

const importsDeleted: string[] = []
function walk(dir: string) {
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
        const rel = `${dir}/${entry.name}`
        if (entry.isDirectory()) {
            if (['node_modules', '.next', '.git'].includes(entry.name)) continue
            walk(rel)
        } else if (/\.(ts|tsx)$/.test(entry.name) && rel !== 'scripts/check-retired-boost.ts') {
            if (/@\/(lib\/(classifieds|marketplace)-|components\/(classifieds|marketplace)\/)/.test(read(rel))) importsDeleted.push(rel)
        }
    }
}
for (const dir of ['app', 'components', 'lib', 'hooks', 'contexts', 'scripts']) walk(dir)
check('no source file imports a deleted module', importsDeleted.length === 0, importsDeleted.join(', '))

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`)
process.exit(failures === 0 ? 0 : 1)
