// Run: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import ts from 'typescript'
import {
    extractUiText,
    isUserText,
    chunkEntries,
    routeFromPageFile,
    surfaceForRoute,
} from '../../scripts/site-extract.mjs'
import { rankSiteChunks, knowledgeSearchTerms, type SiteChunk } from '../ai-assistant/helpers.ts'

const SAMPLE = `
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
// Internal note: supplier is Dakazina — must never appear
const ITEMS = [
    { href: '/dashboard/wallet', label: 'Wallet', icon: Wallet },
    { key: 'x', title: 'Standard API Key', blurb: 'For data and airtime endpoints.' },
]
const ep = { method: 'POST', path: '/api/v2/data/purchase', label: 'Buy a bundle', desc: 'Charges your wallet.' }
export default function Page() {
    const save = () => toast.error('Minimum top-up is GHS 5')
    const later = () => toast.success(\`Sent \${n} messages\`)
    return (
        <div className="flex px-4 text-sm">
            <h1 className="font-bold">Developer API</h1>
            <p>Integrate ARHMS into your own apps.</p>
            <Input placeholder="Enter your endpoint URL" className="w-full" />
            <Button>{loading ? 'Generating…' : 'Generate Standard Key'}</Button>
            <a href="https://evil.example.com/x">Documentation Page</a>
            <span>{'sk-abcdef0123456789abcdef'}</span>
        </div>
    )
}
`

test('extractUiText keeps what users see, in order, with headings', () => {
    const out = extractUiText(ts, SAMPLE, 'page.tsx')
    const texts = out.map(e => e.text)
    assert.ok(texts.includes('Developer API'))
    assert.equal(out.find(e => e.text === 'Developer API')?.heading, true)
    for (const want of [
        'Integrate ARHMS into your own apps.',
        'Enter your endpoint URL',
        'Generating…',
        'Generate Standard Key',
        'Documentation Page',
        'Minimum top-up is GHS 5',
        'Sent … messages',
        'Wallet',
        'Standard API Key',
        'For data and airtime endpoints.',
        'POST /api/v2/data/purchase: Buy a bundle. Charges your wallet.',
    ]) assert.ok(texts.includes(want), `missing: ${want}`)
})

test('extractUiText drops comments, classNames, imports, URLs and secrets', () => {
    const all = extractUiText(ts, SAMPLE, 'page.tsx').map(e => e.text).join(' | ')
    for (const banned of ['Dakazina', 'flex px-4', 'font-bold', 'sonner', '@/components', 'evil.example.com', 'sk-abcdef', '/dashboard/wallet']) {
        assert.ok(!all.includes(banned), `leaked: ${banned}`)
    }
})

test('isUserText filters code-looking strings', () => {
    assert.equal(isUserText('Buy data now'), true)
    assert.equal(isUserText('Wallet'), true)
    assert.equal(isUserText('rounded-xl border p-3'), false)
    assert.equal(isUserText('special_mtn_mashup_hidden'), false)
    assert.equal(isUserText('isLoading'), false)
    assert.equal(isUserText('https://arhmsgh.com'), false)
    assert.equal(isUserText('a => b'), false)
})

test('chunkEntries groups text under headings within the size cap', () => {
    const chunks = chunkEntries(
        [{ heading: true, text: 'Wallet' }, { heading: false, text: 'a'.repeat(400) }, { heading: false, text: 'b'.repeat(400) }],
        { surface: 'dashboard', path: '/dashboard/wallet', menu: 'Wallet' },
        600,
    )
    assert.equal(chunks.length, 2)
    assert.equal(chunks[0].heading, 'Wallet')
    assert.equal(chunks[1].heading, 'Wallet')
})

test('routes and surfaces: admin, api and portal are never indexed', () => {
    assert.equal(routeFromPageFile('app/dashboard/developer-api/page.tsx'), '/dashboard/developer-api')
    assert.equal(routeFromPageFile('app/shop/[shopSlug]/about/page.tsx'), '/shop/about')
    assert.equal(routeFromPageFile('app/page.tsx'), '/')
    assert.equal(surfaceForRoute('/dashboard/wallet'), 'dashboard')
    assert.equal(surfaceForRoute('/shop/about'), 'storefront')
    assert.equal(surfaceForRoute('/admin/users'), null)
    assert.equal(surfaceForRoute('/admin'), null)
    assert.equal(surfaceForRoute('/api/v2/packages'), null)
})

test('rankSiteChunks prefers menu/heading matches and respects the surface', () => {
    const chunks: SiteChunk[] = [
        { id: 1, surface: 'dashboard', path: '/dashboard/wallet', menu: 'Wallet', heading: '', text: 'Top up your wallet with MoMo' },
        { id: 2, surface: 'dashboard', path: '/dashboard/developer-api', menu: 'Developer API', heading: 'Developer API', text: 'Generate Standard Key · Documentation Page' },
        { id: 3, surface: 'storefront', path: '/shop', menu: null, heading: 'Buy', text: 'Generate key' },
    ]
    const r = rankSiteChunks(chunks, knowledgeSearchTerms('how do I get api keys'), 'dashboard')
    assert.equal(r[0].id, 2)
    assert.ok(!r.some(c => c.surface === 'storefront'))
    assert.deepEqual(rankSiteChunks(chunks, [], 'dashboard'), [])
})
