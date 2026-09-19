/**
 * The single source of truth for what the public API offers.
 *
 * Lives here rather than in a page because two places render it now: the key
 * management screen at /dashboard/developer-api and the public docs at /docs. The
 * previous hand-written snippets in that page had already drifted between languages
 * once; a second copy across two routes would drift again, and the docs are the copy
 * a partner actually integrates against.
 */
import {
    Activity,
    Clock,
    Coins,
    GraduationCap,
    IdCard,
    Package,
    Phone,
    Receipt,
    ShoppingCart,
    Wallet,
    Zap,
} from 'lucide-react'

export type Lang = 'curl' | 'javascript' | 'nodejs' | 'python' | 'php'
export type KeyKind = 'standard' | 'commission'

export const LANGS: { id: Lang; label: string }[] = [
    { id: 'curl',       label: 'cURL'       },
    { id: 'javascript', label: 'JavaScript' },
    { id: 'nodejs',     label: 'Node.js'    },
    { id: 'python',     label: 'Python'     },
    { id: 'php',        label: 'PHP'        },
]

// Apex, NOT www. www.arhmsgh.com answers every /api request with a 307 to the apex,
// and a cross-host redirect makes clients drop the Authorization header -- curl and
// axios both do, by design. A partner copying a www sample gets 401 no matter how
// valid their key is, with nothing in the response to explain why. Verified:
//   > Host: www.arhmsgh.com   Authorization: <key>   -> 307
//   > Host: arhmsgh.com       (no Authorization)     -> 401
export const BASE = 'https://arhmsgh.com'
export const STANDARD_KEY_SAMPLE   = 'kf_live_your_api_key_here'
export const COMMISSION_KEY_SAMPLE = 'kf_cs_live_your_commission_key_here'

/**
 * Which section of the public docs an endpoint belongs to.
 *
 * Grouped by PRODUCT, not by key kind. A partner arrives wanting to sell airtime, not
 * wanting "the standard key endpoints" — and the key each one needs is stated on the
 * section itself. The dashboard still splits by key kind, because there the tabs ARE
 * the two keys you manage.
 */
export type DocGroup =
    | 'data'
    | 'airtime'
    | 'results-checker'
    | 'afa'
    | 'account'
    | 'utility-bills'

export interface Endpoint {
    icon: React.ElementType
    group: DocGroup
    method: 'GET' | 'POST'
    path: string
    label: string
    desc: string
    body?: Record<string, any>
    query?: string
    /** Which key the snippet should show in the Authorization header. */
    keyKind?: KeyKind
}

/**
 * Env-var names the snippets read the key from.
 *
 * The samples deliberately do NOT show a literal key. Copying a doc snippet verbatim
 * is the most common way a key ends up committed to git — where deleting the line
 * later does not remove it from history — or, in a bundled frontend, inlined into
 * JavaScript served to every visitor. Showing the variable is the same amount of
 * typing and fails safe.
 */
export const ENV_VAR: Record<KeyKind, string> = {
    standard:   'ARHMS_API_KEY',
    commission: 'ARHMS_COMMISSION_KEY',
}

// Snippets are generated from the method, path and body rather than written out
// five times per endpoint. The previous hand-written version ran to 250 lines for
// four endpoints; there are sixteen now, and the copies had already drifted.
export function snippetsFor(ep: Endpoint): Record<Lang, string> {
    const url = `${BASE}${ep.path}${ep.query ? `?${ep.query}` : ''}`
    const ENV = ENV_VAR[ep.keyKind ?? 'standard']
    const json = ep.body ? JSON.stringify(ep.body, null, 2) : null
    const compact = ep.body ? JSON.stringify(ep.body) : null

    return {
        curl: ep.body
            ? `curl -X POST ${url} \\\n  -H "Authorization: $${ENV}" \\\n  -H "Content-Type: application/json" \\\n  -d '${compact}'`
            : `curl -X GET "${url}" \\\n  -H "Authorization: $${ENV}"`,

        // Marked server-side deliberately: /api/v2 sends Access-Control-Allow-Origin: *,
        // so this call SUCCEEDS from a browser and looks correct — while shipping the
        // key to everyone who opens DevTools.
        javascript: ep.body
            ? `// Server-side only — never from browser code.\nconst res = await fetch('${url}', {\n  method: 'POST',\n  headers: {\n    'Authorization': process.env.${ENV},\n    'Content-Type': 'application/json'\n  },\n  body: JSON.stringify(${json})\n})\nconst data = await res.json()`
            : `// Server-side only — never from browser code.\nconst res = await fetch('${url}', {\n  headers: { 'Authorization': process.env.${ENV} }\n})\nconst data = await res.json()`,

        nodejs: ep.body
            ? `const axios = require('axios')\n\nconst { data } = await axios.post(\n  '${url}',\n  ${json?.split('\n').join('\n  ')},\n  { headers: { Authorization: process.env.${ENV} } }\n)`
            : `const axios = require('axios')\n\nconst { data } = await axios.get(\n  '${url}',\n  { headers: { Authorization: process.env.${ENV} } }\n)`,

        python: ep.body
            ? `import os, requests\n\nres = requests.post(\n    '${url}',\n    headers={'Authorization': os.environ['${ENV}']},\n    json=${json?.replace(/true/g, 'True').replace(/false/g, 'False').split('\n').join('\n    ')}\n)\nprint(res.json())`
            : `import os, requests\n\nres = requests.get(\n    '${url}',\n    headers={'Authorization': os.environ['${ENV}']}\n)\nprint(res.json())`,

        php: ep.body
            ? `$ch = curl_init('${url}');\ncurl_setopt_array($ch, [\n  CURLOPT_RETURNTRANSFER => true,\n  CURLOPT_POST => true,\n  CURLOPT_HTTPHEADER => ['Authorization: ' . getenv('${ENV}'), 'Content-Type: application/json'],\n  CURLOPT_POSTFIELDS => '${compact}',\n]);\n$response = curl_exec($ch);\ncurl_close($ch);\necho $response;`
            : `$ch = curl_init('${url}');\ncurl_setopt_array($ch, [\n  CURLOPT_RETURNTRANSFER => true,\n  CURLOPT_HTTPHEADER => ['Authorization: ' . getenv('${ENV}')],\n]);\n$response = curl_exec($ch);\ncurl_close($ch);\necho $response;`,
    }
}

/**
 * Every event we will POST to a registered endpoint.
 *
 * Defined here because the dashboard's Webhooks tab and the public docs both list
 * them, and a partner switching on `event` cannot afford the two to disagree.
 */
export const WEBHOOK_EVENTS: { event: string; when: string; keyKind: KeyKind }[] = [
    { event: 'data.completed',     when: 'The supplier delivered the bundle to the recipient.',        keyKind: 'standard' },
    { event: 'data.failed',        when: 'The supplier could not deliver it. Check your wallet — a refund is manual.', keyKind: 'standard' },
    { event: 'airtime.completed',  when: 'The network confirmed the top-up reached the beneficiary.', keyKind: 'standard' },
    { event: 'airtime.failed',     when: 'The provider refused or could not deliver it.',             keyKind: 'standard' },
    { event: 'afa.completed',      when: 'An agent filed the AFA registration with MTN.',             keyKind: 'standard' },
    { event: 'afa.failed',         when: 'The registration could not be completed.',                  keyKind: 'standard' },
    { event: 'utility.completed',  when: 'The biller accepted the payment.',                          keyKind: 'commission' },
    { event: 'utility.failed',     when: 'The biller rejected it; nothing was delivered.',            keyKind: 'commission' },
    { event: 'utility.refunded',   when: 'A failed bill payment was credited back to your wallet.',   keyKind: 'commission' },
]

/**
 * Product sections, in the order the docs present them: what most partners integrate
 * first, then the rarer ones, then the account plumbing.
 */
export const DOC_GROUPS: { id: DocGroup; title: string; lead: string }[] = [
    { id: 'data',            title: 'Data Bundles',       lead: 'Standard key. Orders are charged to your main wallet at your role pricing.' },
    { id: 'airtime',         title: 'Airtime',            lead: 'Standard key. MTN, Telecel and AT, priced with your ordinary role fee.' },
    { id: 'results-checker', title: 'Results Checker',    lead: 'Standard key. WAEC and BECE PINs, sold from stock we hold and returned in the response.' },
    { id: 'afa',             title: 'AFA Registration',   lead: 'Standard key. An agent files each registration by hand, so it settles in hours rather than seconds.' },
    { id: 'account',         title: 'Account & Orders',   lead: 'Standard key. Your wallet balance, and the status of any order you have placed.' },
    { id: 'utility-bills',   title: 'Utility Bills',      lead: 'Commission Services key. Pay bills at face value and earn a share of the commission. A Standard key here returns 403.' },
]

export const STANDARD_ENDPOINTS: Endpoint[] = [
    {
        icon: Package, method: 'GET', path: '/api/v2/packages', group: 'data', label: 'List packages',
        desc: 'Every available bundle with your role-specific price. Call this first — it is the only way to know which network/size pairs exist.',
        query: 'network=MTN',
    },
    {
        icon: ShoppingCart, method: 'POST', path: '/api/v2/data/purchase', group: 'data', label: 'Buy a bundle',
        desc: 'Charges your wallet atomically. `reference` is your idempotency key — sending the same one twice returns the existing order without charging again.',
        body: { network: 'MTN', volume_gb: 5, recipient: '0551617309', reference: 'order_001' },
    },
    {
        icon: Zap, method: 'POST', path: '/api/v2/data/bulk', group: 'data', label: 'Buy up to 100',
        desc: 'Every order is validated and priced before the wallet is touched, so a bad entry costs nothing.',
        body: { orders: [
            { network: 'MTN', volume_gb: 5, recipient: '0551617309', reference: 'b_001' },
            { network: 'Telecel', volume_gb: 2, recipient: '0201234567', reference: 'b_002' },
        ] },
    },
    {
        icon: Phone, method: 'POST', path: '/api/v2/airtime/purchase', group: 'airtime', label: 'Send airtime',
        desc: 'Networks: MTN, Telecel, AT. Priced with your ordinary role fee, same as the dashboard. Set `use_exact_amount` to charge the fee on top instead of taking it out of the amount. The provider will not send less than GHS 1.00, and by default the fee comes OUT of `amount` — so send at least GHS 1.06, or set `use_exact_amount` and send 1.00.',
        body: { network: 'MTN', amount: 10, recipient: '0551617309', reference: 'air_001' },
    },
    {
        icon: GraduationCap, method: 'GET', path: '/api/v2/results-checker/types', group: 'results-checker', label: 'Checker catalogue',
        desc: 'WAEC and BECE checkers with your role price, bulk tiers and live stock. Vouchers are sold from stock we hold, so `available: 0` means a purchase will fail rather than back-order.',
    },
    {
        icon: GraduationCap, method: 'POST', path: '/api/v2/results-checker/purchase', group: 'results-checker', label: 'Buy checkers',
        desc: 'Settles immediately — the PINs are in the response, no polling. Up to 50 per request. Out of stock returns 409 and your wallet is untouched.',
        body: { type_id: 'a3f1c2d4-5e6f-7081-92a3-b4c5d6e7f809', quantity: 2, reference: 'rc_001' },
    },
    {
        icon: IdCard, method: 'GET', path: '/api/v2/afa/pricing', group: 'afa', label: 'AFA price & fields',
        desc: 'What a registration costs you, plus the accepted ID types with their formats and the valid regions. Build your form from this rather than hardcoding the lists.',
    },
    {
        icon: IdCard, method: 'POST', path: '/api/v2/afa/register', group: 'afa', label: 'Register AFA',
        desc: 'MTN AFA 30-day registration. Charges your wallet and files the application — there is no upstream API, an agent completes it by hand, so `status` stays pending until then. Applicant must be 18+ and the id_number must match the id_type format.',
        body: {
            full_name: 'Kwame Mensah', phone: '0551617309',
            id_type: 'Ghana Card', id_number: 'GHA-123456789-0', date_of_birth: '1996-04-12',
            region: 'Ashanti', location: 'Kumasi', reference: 'afa_001',
        },
    },
    {
        icon: Wallet, method: 'GET', path: '/api/v2/wallet/balance', group: 'account', label: 'Wallet balance',
        desc: 'Your spending balance in GHS. Top up from the dashboard wallet page.',
    },
    {
        icon: Clock, method: 'GET', path: '/api/v2/orders/order_001', group: 'account', label: 'Order status',
        desc: 'Data, airtime, AFA and result checker orders — the `type` field says which you got. Bill payments have their own endpoint on the Commission API tab. Status flows pending → processing → completed | failed; a completed checker order returns its PINs again.',
    },
]

export const COMMISSION_ENDPOINTS: Endpoint[] = [
    {
        icon: Package, method: 'GET', path: '/api/v2/utilities/billers', group: 'utility-bills', label: 'Biller catalogue',
        desc: 'Every biller, including ones an admin has switched off, so your picker can grey them out instead of guessing. Read min_amount / max_amount from here rather than hardcoding them.',
        keyKind: 'commission',
    },
    {
        icon: Receipt, method: 'GET', path: '/api/v2/utilities/lookup', group: 'utility-bills', label: 'Verify an account',
        desc: 'Resolves a smartcard, IUC or meter number to the customer name. Show it back to your user before charging — a mistyped digit belongs to somebody else. ECG answers a phone number with a list of meters in `meters`; every other biller fills `account_name` instead. 404 = no such account, 502 = provider unreachable, retry.',
        query: 'biller=dstv&account=7041234567',
        keyKind: 'commission',
    },
    {
        icon: Receipt, method: 'POST', path: '/api/v2/utilities/pay', group: 'utility-bills', label: 'Pay a bill',
        desc: 'Billers: ecg, ghana_water, dstv, gotv, startimes. ECG and Ghana Water need `phone`; Ghana Water also needs `email` for its receipt. For ECG, `account` is the specific meter from lookup. The account is re-verified server-side before any money moves.',
        body: { biller: 'dstv', account: '7041234567', amount: 65.00, reference: 'bill_dstv_7041234567_01' },
        keyKind: 'commission',
    },
    {
        icon: Clock, method: 'GET', path: '/api/v2/utilities/orders/UTIL-DSTV-3f9a2b1c4d5e6f70', group: 'utility-bills', label: 'Bill status',
        desc: 'Poll with the reference from the /pay RESPONSE — ours, not the one you sent. commission_earned stays null until the order completes.',
        keyKind: 'commission',
    },
    {
        icon: Coins, method: 'GET', path: '/api/v2/commission/balance', group: 'utility-bills', label: 'Commission balance',
        desc: 'What you have earned. Separate from your spending wallet.',
        keyKind: 'commission',
    },
    {
        icon: Activity, method: 'GET', path: '/api/v2/commission/transactions', group: 'utility-bills', label: 'Earnings statement',
        desc: 'One row per bill payment that paid a commission. Paged — pass ?page= and ?limit= (max 100).',
        keyKind: 'commission',
    },
]
