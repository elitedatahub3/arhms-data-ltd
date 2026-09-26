// @ts-nocheck
/**
 * Paystack Mobile Money (USSD channel) Diagnostic
 * Run with: npx tsx scripts/diagnose-paystack-ussd.ts [--charge 0241234567 MTN]
 *
 * Two jobs:
 *
 *  1. Confirm the secret key works and that Mobile Money is actually enabled on
 *     this Paystack business (default). A key that authenticates fine for hosted
 *     checkout can still refuse a mobile_money charge, which is the failure mode
 *     that matters here and the one you do NOT want to discover from a customer.
 *
 *  2. With --charge, run ONE real debit at GHS 0.10 against a live MSISDN and
 *     print the raw response. This is the only way to learn what each Ghanaian
 *     network actually answers: the docs publish 'pay_offline' for MTN, but
 *     Telecel and AirtelTigo have historically returned 'send_otp', and
 *     mapChargeStatus() in lib/paystack-momo-service.ts has to be checked against
 *     reality before go-live. Getting it wrong strands the customer on a screen
 *     asking for an OTP that never arrives — or releases the session while the
 *     network is still waiting for one.
 *
 * Prints no secrets — only key length, mode and status lines.
 */

import * as fs from 'fs'
import * as path from 'path'

// Deliberately no dotenv: it isn't a dependency of this project, and a diagnostic
// you have to install something to run is a diagnostic nobody runs.
for (const file of ['.env.local', '.env']) {
    const p = path.join(__dirname, '..', file)
    if (!fs.existsSync(p)) continue
    for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
    }
}

const sep = '─'.repeat(64)
const BASE = 'https://api.paystack.co'
const KEY = process.env.PAYSTACK_SECRET_KEY

/**
 * The same spellings NETWORK_ALIASES accepts in lib/paystack-momo-service.ts, kept
 * literal so the script has no imports. If you add an alias there, add it here —
 * `--charge <msisdn> AT` is the regression test that the two agree, and the app
 * silently stops charging AirtelTigo when they do not.
 */
const PROVIDER_MAP = {
    MTN: 'mtn',
    Telecel: 'vod',
    Vodafone: 'vod',
    AirtelTigo: 'atl',
    AT: 'atl',
    ATL: 'atl',
}

function headers() {
    return {
        Authorization: `Bearer ${KEY}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
    }
}

async function probeConfig() {
    console.log(sep)
    console.log('1. CONFIGURATION')
    console.log(sep)

    if (!KEY) {
        console.log('  PAYSTACK_SECRET_KEY  ❌ MISSING')
        return false
    }
    const mode = KEY.startsWith('sk_live') ? 'LIVE' : KEY.startsWith('sk_test') ? 'TEST' : 'UNKNOWN'
    console.log(`  PAYSTACK_SECRET_KEY  ✅ set (${KEY.length} chars, ${mode})`)
    if (mode === 'UNKNOWN') {
        console.log('     ⚠ Key does not start with sk_live_ or sk_test_ — is this a public key?')
    }
    if (mode === 'TEST') {
        console.log('     ⚠ Test keys do not push real MoMo prompts. --charge will not ring a handset.')
    }
    return true
}

async function probeAuth() {
    console.log('')
    console.log(sep)
    console.log('2. AUTHENTICATION & CURRENCY')
    console.log(sep)
    try {
        const res = await fetch(`${BASE}/balance`, { headers: headers(), signal: AbortSignal.timeout(15000) })
        const json = await res.json()
        if (!res.ok || json.status === false) {
            console.log(`  ❌ HTTP ${res.status}: ${json?.message ?? 'no message'}`)
            return false
        }
        console.log(`  ✅ Key authenticates (HTTP ${res.status})`)
        const balances = Array.isArray(json.data) ? json.data : []
        const currencies = balances.map((b) => b.currency)
        console.log(`  Settlement currencies: ${currencies.join(', ') || '(none reported)'}`)
        if (!currencies.includes('GHS')) {
            console.log('     ❌ No GHS balance. A Ghana mobile_money charge will be refused.')
            console.log('        This must be a Ghana-registered Paystack business.')
            return false
        }
        return true
    } catch (err) {
        console.log(`  ❌ Could not reach Paystack: ${err?.message}`)
        return false
    }
}

/**
 * Asks Paystack which mobile money providers this business may charge, without
 * moving money. A mobile_money charge on a business that has not been enabled for
 * it fails with a message that reads like a validation error, so check explicitly.
 */
async function probeChannels() {
    console.log('')
    console.log(sep)
    console.log('3. MOBILE MONEY AVAILABILITY')
    console.log(sep)
    try {
        const res = await fetch(`${BASE}/bank?currency=GHS&type=mobile_money`, {
            headers: headers(),
            signal: AbortSignal.timeout(15000),
        })
        const json = await res.json()
        if (!res.ok || json.status === false) {
            console.log(`  ⚠ HTTP ${res.status}: ${json?.message ?? 'no message'}`)
            return
        }
        const providers = (json.data || []).map((b) => `${b.name} (${b.code})`)
        if (!providers.length) {
            console.log('  ❌ Paystack lists no Ghana mobile money providers for this account.')
            return
        }
        console.log(`  ✅ ${providers.length} provider(s) available:`)
        for (const p of providers) console.log(`     • ${p}`)
        console.log('')
        console.log('  Our map (the codes below must appear above):')
        for (const [network, code] of Object.entries(PROVIDER_MAP)) {
            if (network === 'AT') continue
            console.log(`     ${network.padEnd(11)} -> ${code}`)
        }
    } catch (err) {
        console.log(`  ⚠ Channel probe failed: ${err?.message}`)
    }
}

async function doCharge(msisdn, network) {
    const provider = PROVIDER_MAP[network]
    console.log('')
    console.log(sep)
    console.log('4. LIVE CHARGE — GHS 0.10')
    console.log(sep)

    if (!provider) {
        console.log(`  ❌ Unknown network "${network}". Use one of: ${Object.keys(PROVIDER_MAP).join(', ')}`)
        return
    }

    const reference = `USSD-DIAG-${Date.now().toString(36).toUpperCase()}`
    console.log(`  MSISDN:    ${msisdn}`)
    console.log(`  Network:   ${network} -> provider "${provider}"`)
    console.log(`  Reference: ${reference}`)
    console.log('')

    const started = Date.now()
    try {
        const res = await fetch(`${BASE}/charge`, {
            method: 'POST',
            headers: headers(),
            body: JSON.stringify({
                email: `${msisdn.replace(/\D/g, '')}@ussd.arhmsgh.com`,
                amount: 10, // 10 pesewas = GHS 0.10
                currency: 'GHS',
                reference,
                mobile_money: { phone: msisdn, provider },
                metadata: { channel: 'ussd', diagnostic: true },
            }),
            signal: AbortSignal.timeout(30000),
        })
        const json = await res.json()
        console.log(`  HTTP ${res.status} in ${Date.now() - started}ms`)
        console.log('')
        console.log('  RAW RESPONSE:')
        console.log(JSON.stringify(json, null, 2).split('\n').map((l) => `    ${l}`).join('\n'))
        console.log('')

        const status = json?.data?.status
        console.log(`  >>> data.status = ${JSON.stringify(status)}`)
        console.log('  Compare against mapChargeStatus() in lib/paystack-momo-service.ts:')
        console.log("     'success'                                     -> paid")
        console.log("     'send_otp'                                    -> otp   (needs the awaiting_otp screen)")
        console.log("     'pay_offline'|'pending'|'ongoing'|'processing' -> pending")
        console.log('     anything else                                 -> failed  <-- check this is right!')
        console.log('')
        console.log(`  Poll it:  npx tsx scripts/diagnose-paystack-ussd.ts --verify ${reference}`)
    } catch (err) {
        console.log(`  ❌ Charge threw after ${Date.now() - started}ms: ${err?.message}`)
        console.log('     NOTE: a throw here does NOT mean no charge happened. Verify the')
        console.log(`     reference before assuming the customer was not debited: ${reference}`)
    }
}

async function doVerify(reference) {
    console.log('')
    console.log(sep)
    console.log(`5. VERIFY ${reference}`)
    console.log(sep)
    try {
        const res = await fetch(`${BASE}/transaction/verify/${encodeURIComponent(reference)}`, {
            headers: headers(),
            signal: AbortSignal.timeout(20000),
        })
        const json = await res.json()
        console.log(`  HTTP ${res.status}`)
        console.log(`  status:           ${json?.data?.status}`)
        console.log(`  amount (pesewas): ${json?.data?.amount}`)
        console.log(`  gateway_response: ${json?.data?.gateway_response}`)
    } catch (err) {
        console.log(`  ❌ Verify failed: ${err?.message}`)
    }
}

async function main() {
    console.log('')
    console.log('ARHMS — Paystack Mobile Money (USSD) diagnostic')
    console.log('')

    const args = process.argv.slice(2)
    const chargeIdx = args.indexOf('--charge')
    const verifyIdx = args.indexOf('--verify')

    if (!(await probeConfig())) return
    if (!(await probeAuth())) return
    await probeChannels()

    if (chargeIdx !== -1) {
        const msisdn = args[chargeIdx + 1]
        const network = args[chargeIdx + 2] || 'MTN'
        if (!msisdn) {
            console.log('')
            console.log('  ❌ --charge needs an MSISDN, e.g. --charge 0241234567 MTN')
            return
        }
        await doCharge(msisdn, network)
    }

    if (verifyIdx !== -1) {
        const reference = args[verifyIdx + 1]
        if (reference) await doVerify(reference)
    }

    if (chargeIdx === -1 && verifyIdx === -1) {
        console.log('')
        console.log(sep)
        console.log('  No money moved. To learn the real status value for a network:')
        console.log('    npx tsx scripts/diagnose-paystack-ussd.ts --charge 0241234567 MTN')
        console.log(sep)
    }
    console.log('')
}

main()
