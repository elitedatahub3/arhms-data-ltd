/**
 * The two 2G gates `measure-bundles.js` does not cover.
 * Run with: node scripts/perf-gates.js [--json out.json]
 *
 * Bundle size is only one of the three things a 2G connection pays for. The other
 * two are invisible in the build output:
 *
 *   1. How much HTML is prerendered. A route that renders on demand costs a
 *      Ghana -> dub1 round trip (300-800ms RTT, ~1.5-3s if the connection is cold)
 *      before its first byte. A prerendered route is served from the edge POP.
 *      One `unstable_noStore()` anywhere in the root layout takes this to zero for
 *      the entire app, silently — `next build` does not flag it, and `revalidate`
 *      exports stay in the source looking like they work.
 *
 *   2. What the service worker precaches. Every byte here is downloaded on the
 *      first visit, in the background, competing with the page the user is
 *      actually waiting for over the same ~5 KB/s pipe.
 *
 * Both are one number each, and both regress without anyone noticing, so they get
 * a script rather than a note in a doc.
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const NEXT_DIR = path.join(ROOT, '.next')

function parseArgs() {
    const args = process.argv.slice(2)
    const out = { json: null }
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--json') out.json = args[++i]
    }
    return out
}

function mb(bytes) {
    return (bytes / 1048576).toFixed(2)
}

function walk(dir, acc = []) {
    let entries
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
        return acc
    }
    for (const entry of entries) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full, acc)
        else acc.push(full)
    }
    return acc
}

/**
 * Prerendered HTML written by `next build`, plus the manifest that lists which
 * dynamic routes are ISR-eligible. Zero HTML files means every route in the app
 * renders on demand.
 */
function measureStatic() {
    const htmlFiles = walk(path.join(NEXT_DIR, 'server', 'app')).filter(f => f.endsWith('.html'))

    let isrRoutes = []
    try {
        const manifest = JSON.parse(fs.readFileSync(path.join(NEXT_DIR, 'prerender-manifest.json'), 'utf8'))
        isrRoutes = Object.keys(manifest.dynamicRoutes || {})
    } catch {
        // No manifest at all is itself the finding — nothing is prerendered.
    }

    return {
        htmlCount: htmlFiles.length,
        htmlRoutes: htmlFiles
            .map(f => path.relative(path.join(NEXT_DIR, 'server', 'app'), f).replace(/\\/g, '/'))
            .sort(),
        isrRoutes: isrRoutes.sort(),
    }
}

/**
 * The generated service worker's precache manifest, resolved back to real files
 * so the total is actual bytes on the wire rather than an entry count.
 */
function measurePrecache() {
    const swPath = path.join(ROOT, 'public', 'sw.js')
    let source
    try {
        source = fs.readFileSync(swPath, 'utf8')
    } catch {
        return null
    }

    // Workbox inlines the manifest as {url:"...",revision:"..."} object literals.
    const entries = source.match(/\{url:"[^"]+",revision:[^}]*\}/g) || []

    let total = 0
    let missing = 0
    const byKind = {}

    for (const entry of entries) {
        const url = entry.match(/url:"([^"]+)"/)[1]
        // `/_next/<rest>` on the wire lives at `.next/<rest>` on disk; everything
        // else is served straight out of public/.
        const file = url.startsWith('/_next/')
            ? path.join(NEXT_DIR, url.slice('/_next/'.length))
            : path.join(ROOT, 'public', url.replace(/^\//, ''))

        let size = 0
        try {
            size = fs.statSync(file).size
        } catch {
            missing++
        }
        total += size

        const kind = url.startsWith('/_next/static/chunks') ? 'js chunks'
            : url.startsWith('/_next/static/css') ? 'css'
            : url.startsWith('/_next/static/media') ? 'media'
            : url.startsWith('/_next/') ? 'other build output'
            : 'public/'
        byKind[kind] = byKind[kind] || { count: 0, bytes: 0 }
        byKind[kind].count++
        byKind[kind].bytes += size
    }

    return { count: entries.length, bytes: total, missing, byKind }
}

function main() {
    const { json } = parseArgs()

    if (!fs.existsSync(NEXT_DIR)) {
        console.error('No .next directory — run `npm run build` first.')
        process.exit(1)
    }

    const staticGate = measureStatic()
    const precache = measurePrecache()

    console.log('\nPrerendered HTML')
    console.log(`  ${staticGate.htmlCount} file(s) under .next/server/app`)
    if (staticGate.htmlCount === 0) {
        console.log('  -> Nothing is statically generated. Every route costs an origin')
        console.log('     round trip. Usual cause: noStore()/cookies() reached from the')
        console.log('     root layout, which forces the whole app dynamic.')
    }
    if (staticGate.isrRoutes.length) {
        console.log(`  ISR-eligible dynamic routes: ${staticGate.isrRoutes.join(', ')}`)
    }

    console.log('\nService worker precache')
    if (!precache) {
        console.log('  public/sw.js not found — build with the PWA plugin enabled.')
    } else {
        console.log(`  ${precache.count} entries = ${mb(precache.bytes)} MB downloaded on first visit`)
        for (const [kind, v] of Object.entries(precache.byKind).sort((a, b) => b[1].bytes - a[1].bytes)) {
            console.log(`    ${String(kind).padEnd(18)} ${String(v.count).padStart(4)}  ${mb(v.bytes).padStart(6)} MB`)
        }
        if (precache.missing) {
            console.log(`  (${precache.missing} entries had no file on disk and counted as 0)`)
        }
    }
    console.log('')

    if (json) {
        const out = { measuredAt: new Date().toISOString(), static: staticGate, precache }
        fs.mkdirSync(path.dirname(path.resolve(json)), { recursive: true })
        fs.writeFileSync(path.resolve(json), JSON.stringify(out, null, 2))
        console.log(`Wrote ${json}\n`)
    }
}

main()
