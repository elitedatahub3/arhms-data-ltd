/**
 * Theme-scope guard.
 *
 * The app has three theming layers and they must not blur into each other:
 *   L0  :root / .dark          may declare everything
 *   L1  .theme-*               may declare the accent channel ONLY
 *   L2  --brand-color          per-shop runtime hex; input to L1, never read directly
 *
 * Historically all three wrote to overlapping places, which is why the app could
 * not decide whether it was blue, gold, or per-shop coloured. These checks keep
 * that from coming back.
 *
 * Usage:
 *   node scripts/check-theme-scope.js            # report only, exit 0
 *   node scripts/check-theme-scope.js --strict   # fail the build on any violation
 *
 * Report mode is the default on purpose: the migration lands over several
 * phases, so the violations below are known and are burned down as each phase
 * ships. Flip package.json to --strict once Phase 3 is merged.
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const STRICT = process.argv.includes('--strict')

/** The only custom properties an L1 sub-theme may declare. */
const ACCENT_CHANNEL = new Set([
    '--accent-solid',
    '--accent-strong',
    '--accent-soft',
    '--accent-softer',
    '--accent-contrast',
    '--accent-ring',
    '--gradient-accent',
    '--glow-accent',
    '--primary',
    '--ring',
])

/** Network + partner brand hexes. These belong in lib/networks.tsx, nowhere else. */
const NETWORK_HEXES = [
    '#FFCC00', '#FFCE00', '#E30613', '#ED1C24', '#E60000',
    '#0056B3', '#6f42c1', '#F97316', '#da291c', '#2463eb', '#25D366',
]

/**
 * Dealer chrome is frozen by product decision: the dealer role keeps its exact
 * purple identity through the whole modernization. These strings must survive
 * verbatim in lib/roles.ts.
 */
const DEALER_FROZEN = [
    "color: '#7C3AED'",
    'from-[#6b21a8] to-[#4c1d95]',
    'from-purple-800 to-indigo-900',
    'from-purple-600 to-indigo-800',
    'bg-violet-500/15',
]

const violations = []
const report = (rule, file, line, msg) => violations.push({ rule, file, line, msg })

/** Recursively collect files with the given extensions, skipping build output. */
function walk(dir, exts, out) {
    out = out || []
    const SKIP = new Set(['node_modules', '.next', '.git', 'out', 'public', 'dist'])
    for (const entry of fs.readdirSync(dir)) {
        if (SKIP.has(entry)) continue
        const full = path.join(dir, entry)
        if (fs.statSync(full).isDirectory()) walk(full, exts, out)
        else if (exts.some((e) => entry.endsWith(e))) out.push(full)
    }
    return out
}

const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/')

// -- Check 1: .theme-* blocks may only declare the accent channel -----------
{
    const cssPath = path.join(ROOT, 'app', 'globals.css')
    const lines = fs.readFileSync(cssPath, 'utf8').split('\n')

    // Only police blocks that set custom properties directly on the theme scope,
    // not descendant helpers like `.theme-shop .some-helper`.
    let depth = 0
    let inThemeBlock = false
    let blockSelector = ''

    lines.forEach((raw, i) => {
        const line = raw.trim()
        const opens = (raw.match(/\{/g) || []).length
        const closes = (raw.match(/\}/g) || []).length

        if (depth === 0 && /^\.theme-[\w-]+(\.\w+)*\s*\{/.test(line)) {
            inThemeBlock = true
            blockSelector = line.replace(/\s*\{.*/, '')
        }

        if (inThemeBlock) {
            const decl = line.match(/^(--[\w-]+)\s*:/)
            if (decl && !ACCENT_CHANNEL.has(decl[1])) {
                report(
                    'theme-scope',
                    rel(cssPath),
                    i + 1,
                    blockSelector + ' declares ' + decl[1] + ', which is outside the accent channel',
                )
            }
        }

        depth += opens - closes
        if (depth <= 0) {
            inThemeBlock = false
            depth = 0
        }
    })
}

// -- Check 2: --brand-color is write-only outside lib/brand-theme.ts --------
{
    const ALLOWED = new Set(['lib/brand-theme.ts'])
    for (const file of walk(ROOT, ['.tsx', '.ts'])) {
        const r = rel(file)
        if (ALLOWED.has(r) || r.startsWith('scripts/')) continue
        fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
            if (line.includes('var(--brand-color)')) {
                report('brand-color-read', r, i + 1, 'reads var(--brand-color) directly; use the accent tokens instead')
            }
        })
    }
}

// -- Check 3: network hexes live only in lib/networks.ts --------------------
{
    const ALLOWED = new Set(['lib/networks.ts', 'lib/networks.tsx'])
    const pattern = new RegExp(NETWORK_HEXES.join('|'), 'i')
    for (const file of walk(ROOT, ['.tsx', '.ts', '.css'])) {
        const r = rel(file)
        if (ALLOWED.has(r) || r.startsWith('scripts/')) continue
        fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
            const hit = line.match(pattern)
            if (hit) {
                report('network-hex', r, i + 1, 'hardcodes network colour ' + hit[0] + '; import it from lib/networks.ts')
            }
        })
    }
}

// -- Check 4: dealer chrome is frozen ---------------------------------------
// ALWAYS fatal, in report mode too. It guards a product decision, not a
// migration step, so there is no phase in which breaking it is expected.
let dealerBroken = false
{
    const roles = fs.readFileSync(path.join(ROOT, 'lib', 'roles.ts'), 'utf8')
    for (const frozen of DEALER_FROZEN) {
        if (!roles.includes(frozen)) {
            dealerBroken = true
            report('dealer-frozen', 'lib/roles.ts', 0, 'dealer chrome changed: expected to find ' + JSON.stringify(frozen))
        }
    }
}

// -- Output -----------------------------------------------------------------
if (violations.length === 0) {
    console.log('check-theme-scope: clean')
    process.exit(0)
}

const byRule = violations.reduce((acc, v) => {
    if (!acc[v.rule]) acc[v.rule] = []
    acc[v.rule].push(v)
    return acc
}, {})

for (const rule of Object.keys(byRule)) {
    const items = byRule[rule]
    console.log('\n' + rule + ' (' + items.length + ')')
    for (const v of items.slice(0, 20)) {
        console.log('  ' + v.file + (v.line ? ':' + v.line : '') + ' - ' + v.msg)
    }
    if (items.length > 20) console.log('  ... and ' + (items.length - 20) + ' more')
}

if (dealerBroken) {
    console.error('\nFAIL: dealer chrome is frozen and must not change.')
    process.exit(1)
}

if (STRICT) {
    console.error('\nFAIL: ' + violations.length + ' theme-scope violation(s).')
    process.exit(1)
}

console.log(
    '\n' + violations.length + ' known violation(s) - reporting only. ' +
    'These are burned down by Phases 1-3; re-run with --strict to enforce.',
)
process.exit(0)
