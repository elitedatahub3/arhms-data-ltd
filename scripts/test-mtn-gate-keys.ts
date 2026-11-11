/**
 * Test: which MTN registration gate switch governs each surface.
 *
 * Pins that the 'api' switch (admin "API Users") is OFF until its own row is written:
 * the legacy single switch must never turn the developer API's gate on.
 *
 * Run:
 *   TS_NODE_COMPILER_OPTIONS='{"module":"commonjs","moduleResolution":"node"}' \
 *     npx ts-node --transpile-only scripts/test-mtn-gate-keys.ts
 */
import { resolveGateEnabled as resolve, ALL_MTN_GATE_KEYS, MTN_GATE_KEYS } from '../lib/mtn-gate-keys'

let failed = 0
function check(name: string, ok: boolean) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`)
    if (!ok) failed++
}

check('legacy switch on, no API row: API gate stays OFF', resolve({ mtn_registration_gate_enabled: 'true' }, 'api') === false)
check('API row true: API gate ON', resolve({ mtn_registration_gate_api_enabled: 'true' }, 'api') === true)
check('API row false wins over legacy on', resolve({ mtn_registration_gate_api_enabled: 'false', mtn_registration_gate_enabled: 'true' }, 'api') === false)
check('JSONB boolean true counts as on', resolve({ mtn_registration_gate_api_enabled: true }, 'api') === true)
check('site still falls back to the legacy switch', resolve({ mtn_registration_gate_enabled: 'true' }, 'site') === true)
check('shop still falls back to the legacy switch', resolve({ mtn_registration_gate_enabled: 'true' }, 'shop') === true)
check('API site/shop switches do not leak into each other', resolve({ mtn_registration_gate_site_enabled: 'true', mtn_registration_gate_shop_enabled: 'true' }, 'api') === false)
check('batched key list includes the API key', ALL_MTN_GATE_KEYS.includes(MTN_GATE_KEYS.api))

console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
