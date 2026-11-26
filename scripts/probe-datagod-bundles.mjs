// Read-only probe of Datagod v2 Standard Bundles. Charges nothing.
//
//   DATAGOD_COMMISSION_KEY=dg2_live_... node scripts/probe-datagod-bundles.mjs [MTN|Telecel|AT] [reference]
//
// Prints the raw catalog response (tokens shortened) so the field names read by
// lib/datagod-bundles-service.ts normaliseCatalog() can be checked against reality.
// With a reference, also prints GET /bundles/orders/{reference}.
const key = process.env.DATAGOD_COMMISSION_KEY
const base = (process.env.DATAGOD_API_V2_URL || 'https://api.datagod.store/v2').replace(/\/+$/, '')
const network = process.argv[2] || 'MTN'
const reference = process.argv[3]

if (!key) {
    console.error('Set DATAGOD_COMMISSION_KEY first.')
    process.exit(1)
}

const shorten = (_k, v) => (typeof v === 'string' && v.length > 40 && /token/i.test(_k) ? `${v.slice(0, 12)}…(${v.length} chars)` : v)

async function get(path) {
    const res = await fetch(`${base}${path}`, { headers: { Authorization: key, Accept: 'application/json' } })
    const text = await res.text()
    let body
    try { body = JSON.parse(text) } catch { body = text.slice(0, 500) }
    console.log(`\nGET ${path} -> HTTP ${res.status}`)
    console.log(JSON.stringify(body, shorten, 2).slice(0, 6000))
}

await get(`/bundles/catalog?network=${encodeURIComponent(network)}`)
if (reference) await get(`/bundles/orders/${encodeURIComponent(reference)}`)
