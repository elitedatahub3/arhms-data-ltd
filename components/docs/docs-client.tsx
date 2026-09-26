'use client'

/**
 * The public developer documentation at /docs.
 *
 * Every endpoint, description, sample body and snippet comes from lib/api-docs.ts —
 * the same catalogue the key-management screen renders — so the two can never tell a
 * partner different things. Nothing about an endpoint is written in this file.
 *
 * Colours are tokens throughout (scripts/check-theme-scope.js enforces it), so the
 * page follows the viewer's light/dark choice like the rest of the app.
 */
import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import {
    AlertTriangle,
    ArrowRight,
    Check,
    Copy,
    Gauge,
    KeyRound,
    Lightbulb,
    Menu,
    Braces,
    GraduationCap,
    IdCard,
    Package,
    Phone,
    Radio,
    Receipt,
    ShieldAlert,
    Signal,
    Wallet,
} from 'lucide-react'
import { ThemeToggle } from '@/components/ui/theme-toggle'
import { cn } from '@/lib/utils'
import {
    type DocGroup,
    type Endpoint,
    type Lang,
    BASE,
    COMMISSION_ENDPOINTS,
    COMMISSION_KEY_SAMPLE,
    LANGS,
    STANDARD_ENDPOINTS,
    DOC_GROUPS,
    STANDARD_KEY_SAMPLE,
    WEBHOOK_EVENTS,
    snippetsFor,
} from '@/lib/api-docs'

// ─── Static reference content ────────────────────────────────────────────────

// Mirrors DEFAULT_LIMITS in lib/api-auth.ts. Admins can tune these per bucket via the
// api_rate_limits setting, which is why the page calls them defaults.
const RATE_LIMITS: { bucket: string; endpoints: string; perMinute: number }[] = [
    { bucket: 'Purchase',    endpoints: 'data/purchase, airtime/purchase, results-checker/purchase, afa/register', perMinute: 20 },
    { bucket: 'Bulk',        endpoints: 'data/bulk', perMinute: 10 },
    { bucket: 'Balance',     endpoints: 'wallet/balance, packages, catalogues', perMinute: 60 },
    { bucket: 'Status',      endpoints: 'orders/{reference}', perMinute: 60 },
    { bucket: 'Billers',     endpoints: 'utilities/billers', perMinute: 30 },
    { bucket: 'Lookup',      endpoints: 'utilities/lookup', perMinute: 10 },
    { bucket: 'Pay',         endpoints: 'utilities/pay', perMinute: 6 },
    { bucket: 'Bill orders', endpoints: 'utilities/orders/{reference}', perMinute: 30 },
    { bucket: 'Commission',  endpoints: 'commission/balance, commission/transactions', perMinute: 30 },
]

// The statuses actually returned across app/api/v2 and lib/api-auth.ts, with the
// messages quoted from the code so a partner can match on what they will really see.
const ERROR_CODES: { code: number; name: string; when: string; action: string }[] = [
    { code: 400, name: 'Bad Request',          when: 'A field is missing or malformed — an invalid phone number, an unknown network, an amount outside the biller\'s range.', action: 'Fix the request. The message names the field. Retrying unchanged will fail again.' },
    { code: 401, name: 'Unauthorized',         when: '"Missing Authorization header" or "Invalid API key".', action: 'Send the key in the Authorization header, on arhmsgh.com (not www).' },
    { code: 402, name: 'Payment Required',     when: '"Insufficient wallet balance. Top up your wallet and retry."', action: 'Top up from the dashboard. Nothing was charged.' },
    { code: 403, name: 'Forbidden',            when: 'The key is pending approval or revoked, the account is suspended, the role is not allowed, or a standard key was sent to a Commission endpoint (or vice versa).', action: 'Read the message — it says which. Pending keys need admin approval.' },
    { code: 404, name: 'Not Found',            when: 'No order with that reference, or no such utility account.', action: 'Check the reference. For bills, poll with the reference from the /pay response.' },
    { code: 409, name: 'Conflict',             when: 'The reference belongs to a different API key, the same bill payment was sent twice within 30 seconds, or a result checker type is out of stock. (Resending your OWN reference is not an error — it returns the original order.)', action: 'Use a fresh reference. The original order is unaffected and nothing was charged.' },
    { code: 429, name: 'Too Many Requests',    when: '"Rate limit exceeded for this endpoint."', action: 'Wait for the number of seconds in the Retry-After header, then retry.' },
    { code: 500, name: 'Internal Server Error', when: 'Something failed on our side.', action: 'Check the order status before retrying a purchase — it may have gone through.' },
    { code: 503, name: 'Service Unavailable',  when: 'The API, v2, or a product (e.g. utility bills) is switched off.', action: 'Retry later. This is deliberate, not an outage on your side.' },
]

const WEBHOOK_SAMPLE = `POST https://your-app.com/webhooks/arhms
X-Arhms-Event: data.completed
X-Arhms-Signature: sha256=<hmac>

{
  "event": "data.completed",
  "reference": "order_001",
  "order_id": "6faea706-…",
  "status": "completed",
  "network": "MTN",
  "size": "1GB",
  "recipient": "0551617309",
  "price": 4.5,
  "sent_at": "2026-09-17T03:31:16.058Z"
}`

const WEBHOOK_VERIFY = `const crypto = require('crypto')

// Hash the RAW body, before any JSON parsing.
const expected = 'sha256=' + crypto
  .createHmac('sha256', process.env.ARHMS_WEBHOOK_SECRET)
  .update(rawBody, 'utf8')
  .digest('hex')

const ok = crypto.timingSafeEqual(
  Buffer.from(expected),
  Buffer.from(req.headers['x-arhms-signature'])
)`

const SUCCESS_ENVELOPE = `{
  "success": true,
  "data": { ... },
  "meta": {
    "timestamp": "2026-09-12T10:30:00.000Z",
    "version": "v2"
  }
}`

const ERROR_ENVELOPE = `{
  "success": false,
  "error": {
    "code": 402,
    "message": "Insufficient wallet balance. Top up your wallet and retry."
  }
}`

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Stable anchor for an endpoint, e.g. "post-api-v2-data-purchase". */
function anchorFor(ep: Endpoint): string {
    // The order-status samples carry an example reference in the path; the anchor
    // should name the route, not the example.
    const path = ep.path
        .replace(/\/orders\/[^/]+$/, '/orders/reference')
    return `${ep.method}-${path}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

/** Descriptions mark field names with backticks; render those as inline code. */
function RichText({ text }: { text: string }) {
    const parts = text.split('`')
    return (
        <>
            {parts.map((part, i) =>
                i % 2 === 1
                    ? <code key={i} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em] text-foreground">{part}</code>
                    : <span key={i}>{part}</span>
            )}
        </>
    )
}

function CopyButton({ value, label = 'Copy', className }: { value: string; label?: string; className?: string }) {
    const [copied, setCopied] = useState(false)

    const copy = async () => {
        try {
            await navigator.clipboard.writeText(value)
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
        } catch {
            // Clipboard can be blocked (insecure context, permissions). The text is
            // still on screen to select by hand, so there is nothing to recover.
        }
    }

    return (
        <button
            type="button"
            onClick={copy}
            aria-label={copied ? 'Copied' : label}
            className={cn(
                'inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 py-1 text-xs font-semibold text-foreground transition hover:border-border-strong',
                className
            )}
        >
            {copied ? <Check className="h-3.5 w-3.5 text-accent-solid" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? 'Copied' : label}
        </button>
    )
}

function CodeBlock({ code, label }: { code: string; label?: string }) {
    return (
        <div className="overflow-hidden rounded-xl border border-border bg-surface-2">
            <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label ?? 'Example'}</span>
                <CopyButton value={code} />
            </div>
            <pre className="overflow-x-auto p-4 text-[13px] leading-relaxed text-foreground">
                <code className="font-mono">{code}</code>
            </pre>
        </div>
    )
}

function MethodBadge({ method }: { method: Endpoint['method'] }) {
    return (
        <span
            className={cn(
                'inline-flex w-12 shrink-0 justify-center rounded-md px-1.5 py-0.5 font-mono text-[11px] font-bold',
                method === 'GET'
                    ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
                    : 'bg-accent-soft text-accent-solid'
            )}
        >
            {method}
        </span>
    )
}

function SectionHeading({ id, index, icon: Icon, title, lead }: {
    id: string
    index: number
    icon: React.ElementType
    title: string
    lead?: string
}) {
    return (
        <div id={id} className="scroll-mt-24">
            <div className="flex items-center gap-3">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent-soft text-xs font-bold text-accent-solid">
                    {index}
                </span>
                <h2 className="flex items-center gap-2 text-xl font-black tracking-tight text-foreground sm:text-2xl">
                    <Icon className="h-5 w-5 text-muted-foreground" />
                    {title}
                </h2>
            </div>
            {lead && <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">{lead}</p>}
        </div>
    )
}

function EndpointCard({ ep, lang, onLang }: { ep: Endpoint; lang: Lang; onLang: (l: Lang) => void }) {
    const snippets = useMemo(() => snippetsFor(ep), [ep])
    const Icon = ep.icon

    return (
        <article id={anchorFor(ep)} className="scroll-mt-24 rounded-2xl border border-border bg-card p-4 sm:p-5">
            <div className="flex items-start gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-muted">
                    <Icon className="h-[18px] w-[18px] text-foreground" />
                </div>
                <div className="min-w-0 flex-1">
                    <h3 className="font-bold text-foreground">{ep.label}</h3>
                    <div className="mt-1 flex min-w-0 items-center gap-2">
                        <MethodBadge method={ep.method} />
                        <code className="min-w-0 truncate font-mono text-[13px] text-foreground">{ep.path}</code>
                    </div>
                </div>
            </div>

            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                <RichText text={ep.desc} />
            </p>

            {ep.query && (
                <p className="mt-2 text-xs text-muted-foreground">
                    Query: <code className="rounded bg-muted px-1 py-0.5 font-mono text-foreground">?{ep.query}</code>
                </p>
            )}

            <div className="mt-4">
                {/* One language choice for the whole page: a partner writing Python
                    wants Python on every card, not to re-pick it sixteen times. */}
                <div className="mb-2 flex gap-1 overflow-x-auto pb-1" role="tablist" aria-label="Snippet language">
                    {LANGS.map(l => (
                        <button
                            key={l.id}
                            type="button"
                            role="tab"
                            aria-selected={lang === l.id}
                            onClick={() => onLang(l.id)}
                            className={cn(
                                'shrink-0 rounded-lg px-2.5 py-1 text-xs font-semibold transition',
                                lang === l.id
                                    ? 'bg-primary text-primary-foreground'
                                    : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                            )}
                        >
                            {l.label}
                        </button>
                    ))}
                </div>
                <CodeBlock code={snippets[lang]} label={LANGS.find(l => l.id === lang)?.label} />
            </div>
        </article>
    )
}

// ─── Page ────────────────────────────────────────────────────────────────────

const ALL_ENDPOINTS = [...STANDARD_ENDPOINTS, ...COMMISSION_ENDPOINTS]

const GROUP_ICON: Record<DocGroup, React.ElementType> = {
    'data':            Package,
    'airtime':         Phone,
    'results-checker': GraduationCap,
    'afa':             IdCard,
    'account':         Wallet,
    'utility-bills':   Receipt,
}

/**
 * The sidebar, flat and grouped by product.
 *
 * It used to list two headings — Standard API and Commission Services — with all
 * sixteen endpoints nested beneath them, which made the nav twenty-four rows long and
 * sorted by a detail (which key signs the request) rather than by what the reader came
 * to build. Each product section states its own key instead.
 */
const SECTIONS: { id: string; title: string; icon: React.ElementType; group?: DocGroup }[] = [
    { id: 'authentication',  title: 'Authentication',        icon: KeyRound },
    { id: 'response-format', title: 'Response Format',       icon: Braces },
    { id: 'rate-limits',     title: 'Rate Limits',           icon: Gauge },
    ...DOC_GROUPS.map(g => ({ id: g.id, title: g.title, icon: GROUP_ICON[g.id], group: g.id })),
    { id: 'webhooks',        title: 'Webhooks',              icon: Radio },
    { id: 'networks',        title: 'Networks',              icon: Signal },
    { id: 'error-codes',     title: 'Error Codes',           icon: AlertTriangle },
    { id: 'tips',            title: 'Tips & Recommendations', icon: Lightbulb },
]

const LANG_STORAGE_KEY = 'arhms-docs-lang'

export default function DocsClient() {
    const [lang, setLang] = useState<Lang>('curl')
    const [active, setActive] = useState<string>(SECTIONS[0].id)
    const [mobileNavOpen, setMobileNavOpen] = useState(false)

    // Remember the language between visits. Storage can throw (private mode, blocked
    // site data), and the page must work identically without it.
    useEffect(() => {
        try {
            const saved = localStorage.getItem(LANG_STORAGE_KEY) as Lang | null
            if (saved && LANGS.some(l => l.id === saved)) setLang(saved)
        } catch { /* default stays */ }
    }, [])

    const chooseLang = (l: Lang) => {
        setLang(l)
        try { localStorage.setItem(LANG_STORAGE_KEY, l) } catch { /* not persisted */ }
    }

    // Scroll-spy: highlight the section whose heading most recently crossed the upper
    // third of the viewport.
    useEffect(() => {
        const headings = SECTIONS
            .map(s => document.getElementById(s.id))
            .filter((el): el is HTMLElement => !!el)

        const observer = new IntersectionObserver(
            entries => {
                const visible = entries
                    .filter(e => e.isIntersecting)
                    .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
                if (visible[0]) setActive(visible[0].target.id)
            },
            { rootMargin: '-80px 0px -60% 0px' }
        )
        headings.forEach(h => observer.observe(h))
        return () => observer.disconnect()
    }, [])

    const nav = (
        <nav aria-label="Documentation sections" className="space-y-0.5">
            {SECTIONS.map(s => {
                const Icon = s.icon
                return (
                    <a
                        key={s.id}
                        href={`#${s.id}`}
                        onClick={() => setMobileNavOpen(false)}
                        className={cn(
                            'flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition',
                            active === s.id
                                ? 'bg-accent-soft text-accent-solid'
                                : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                        )}
                    >
                        <Icon className="h-4 w-4 shrink-0" />
                        {s.title}
                    </a>
                )
            })}
        </nav>
    )

    return (
        <div className="min-h-screen bg-background text-foreground">
            {/* Top bar */}
            <header className="sticky top-0 z-40 border-b border-border bg-background/90 backdrop-blur">
                <div className="mx-auto flex h-14 max-w-7xl items-center justify-between gap-3 px-4 sm:px-6">
                    <div className="flex min-w-0 items-center gap-2">
                        <button
                            type="button"
                            onClick={() => setMobileNavOpen(o => !o)}
                            className="rounded-lg p-1.5 text-foreground hover:bg-muted lg:hidden"
                            aria-label="Toggle sections"
                            aria-expanded={mobileNavOpen}
                        >
                            <Menu className="h-5 w-5" />
                        </button>
                        <Link href="/" className="truncate text-sm font-black tracking-tight text-foreground">
                            ARHMSGH
                        </Link>
                        <span className="hidden text-sm text-muted-foreground sm:inline">/ Developer API</span>
                    </div>
                    <div className="flex items-center gap-2">
                        <Link
                            href="/dashboard/developer-api"
                            className="hidden rounded-lg bg-primary px-3 py-1.5 text-xs font-bold text-primary-foreground transition hover:bg-accent-strong sm:inline-flex"
                        >
                            Get API key
                        </Link>
                        <ThemeToggle />
                    </div>
                </div>
                {mobileNavOpen && (
                    <div className="max-h-[70vh] overflow-y-auto border-t border-border bg-background px-4 py-3 lg:hidden">
                        {nav}
                    </div>
                )}
            </header>

            {/* Hero */}
            <section className="bg-gradient-to-br from-accent-solid to-accent-strong text-accent-contrast">
                <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6 sm:py-14">
                    <span className="inline-flex items-center gap-1.5 rounded-full border border-accent-contrast/20 bg-background/10 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide">
                        v2 · REST · JSON
                    </span>
                    <h1 className="mt-4 text-3xl font-black tracking-tight sm:text-5xl">
                        ARHMSGH <span className="opacity-80">Developer API</span>
                    </h1>
                    <p className="mt-3 max-w-2xl text-sm leading-relaxed opacity-90 sm:text-base">
                        Sell data bundles, airtime, result checkers, AFA registrations and utility bills from your
                        own app — charged to your ARHMSGH wallet at your agent pricing.
                    </p>

                    <div className="mt-6 grid max-w-2xl gap-3">
                        <div className="flex min-w-0 items-center gap-3 rounded-xl border border-accent-contrast/20 bg-background/10 px-3 py-2.5">
                            <span className="shrink-0 text-xs font-semibold opacity-80">Base URL</span>
                            <code className="min-w-0 flex-1 truncate font-mono text-sm font-bold">{BASE}</code>
                            <CopyButton value={BASE} />
                        </div>
                        <div className="flex min-w-0 items-center gap-3 rounded-xl border border-accent-contrast/20 bg-background/10 px-3 py-2.5">
                            <code className="min-w-0 flex-1 truncate font-mono text-sm">
                                Authorization: {STANDARD_KEY_SAMPLE}
                            </code>
                            <CopyButton value={`Authorization: ${STANDARD_KEY_SAMPLE}`} />
                        </div>
                    </div>

                    <div className="mt-6 flex flex-wrap gap-2">
                        <Link
                            href="/dashboard/developer-api"
                            className="inline-flex items-center gap-1.5 rounded-xl bg-background px-4 py-2.5 text-sm font-bold text-foreground transition hover:opacity-90"
                        >
                            Get your API key <ArrowRight className="h-4 w-4" />
                        </Link>
                        <a
                            href="#data"
                            className="inline-flex items-center gap-1.5 rounded-xl border border-accent-contrast/30 px-4 py-2.5 text-sm font-bold transition hover:bg-background/10"
                        >
                            Browse endpoints
                        </a>
                    </div>
                </div>
            </section>

            {/* Notice */}
            <div className="border-b border-amber-200 bg-amber-50 dark:border-amber-900/50 dark:bg-amber-950/20">
                <div className="mx-auto flex max-w-7xl items-start gap-2 px-4 py-3 text-xs text-amber-900 dark:text-amber-200 sm:px-6 sm:text-sm">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    <p>
                        <strong>Ghana networks only.</strong> This API serves MTN, Telecel and AT (AirtelTigo) Ghana
                        numbers in the 0XXXXXXXXX format. International numbers and other networks are not supported.
                    </p>
                </div>
            </div>

            <div className="mx-auto flex max-w-7xl gap-8 px-4 py-8 sm:px-6 lg:py-12">
                {/* Sidebar */}
                <aside className="sticky top-20 hidden h-[calc(100vh-6rem)] w-60 shrink-0 overflow-y-auto pb-6 lg:block">
                    <p className="mb-2 px-3 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">On this page</p>
                    {nav}
                    <Link
                        href="/dashboard/developer-api"
                        className="mt-4 flex items-center justify-center gap-1.5 rounded-xl bg-primary px-3 py-2.5 text-sm font-bold text-primary-foreground transition hover:bg-accent-strong"
                    >
                        Get API key <ArrowRight className="h-4 w-4" />
                    </Link>
                </aside>

                {/* Content */}
                <main className="min-w-0 flex-1 space-y-14">
                    {/* 1. Authentication */}
                    <section className="space-y-4">
                        <SectionHeading
                            id="authentication" index={1} icon={KeyRound} title="Authentication"
                            lead="Every request carries your API key in the Authorization header. There is no OAuth flow and no request signing."
                        />
                        <CodeBlock label="Header" code={`Authorization: ${STANDARD_KEY_SAMPLE}`} />
                        <p className="text-sm text-muted-foreground">
                            A <code className="rounded bg-muted px-1 py-0.5 font-mono text-foreground">Bearer</code> prefix
                            is also accepted, so <code className="rounded bg-muted px-1 py-0.5 font-mono text-foreground">Authorization: Bearer {'<key>'}</code> works too.
                        </p>

                        <div className="grid gap-3 sm:grid-cols-2">
                            <div className="rounded-2xl border border-border bg-card p-4">
                                <p className="font-bold text-foreground">Standard key</p>
                                <code className="mt-1 block truncate font-mono text-xs text-accent-solid">{STANDARD_KEY_SAMPLE}</code>
                                <p className="mt-2 text-sm text-muted-foreground">
                                    Data, airtime, result checkers, AFA, wallet and order status. Charged to your main wallet.
                                </p>
                            </div>
                            <div className="rounded-2xl border border-border bg-card p-4">
                                <p className="font-bold text-foreground">Commission Services key</p>
                                <code className="mt-1 block truncate font-mono text-xs text-accent-solid">{COMMISSION_KEY_SAMPLE}</code>
                                <p className="mt-2 text-sm text-muted-foreground">
                                    Utility bills and commission earnings. Pay at face value and earn a share of the fee.
                                </p>
                            </div>
                        </div>

                        <div className="rounded-2xl border border-border bg-card p-4">
                            <p className="font-bold text-foreground">Getting a key</p>
                            <ol className="mt-3 space-y-2 text-sm text-muted-foreground">
                                {[
                                    'Log in and open Dashboard → Developer API. An agent plan is required — customer accounts cannot use the API.',
                                    'Generate a Standard or Commission Services key.',
                                    'Copy it immediately. It is shown once and stored only as a hash — it cannot be shown again.',
                                    'New keys wait for admin approval. Until then, requests return 403 "API key pending admin approval".',
                                ].map((step, i) => (
                                    <li key={i} className="flex gap-3">
                                        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[11px] font-bold text-accent-solid">
                                            {i + 1}
                                        </span>
                                        <span>{step}</span>
                                    </li>
                                ))}
                            </ol>
                        </div>

                        <div className="flex gap-3 rounded-2xl border border-red-200 bg-red-50 p-4 dark:border-red-900/50 dark:bg-red-950/20">
                            <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-red-600 dark:text-red-400" />
                            <div className="text-sm text-red-800 dark:text-red-200">
                                <p className="font-bold">Call the API from your server only.</p>
                                <p className="mt-1">
                                    The API allows requests from any origin, so a call from browser JavaScript will succeed —
                                    and hand your key to anyone who opens DevTools. Keep the key in an environment variable
                                    on your backend. Use <code className="font-mono">arhmsgh.com</code>, never{' '}
                                    <code className="font-mono">www.arhmsgh.com</code>: the www host redirects, and the
                                    redirect drops your Authorization header.
                                </p>
                            </div>
                        </div>
                    </section>

                    {/* 2. Response format */}
                    <section className="space-y-4">
                        <SectionHeading
                            id="response-format" index={2} icon={Braces} title="Response Format"
                            lead="Every response is JSON with the same envelope. Check success first, then read data or error."
                        />
                        <div className="grid gap-3 lg:grid-cols-2">
                            <CodeBlock label="Success" code={SUCCESS_ENVELOPE} />
                            <CodeBlock label="Error" code={ERROR_ENVELOPE} />
                        </div>
                        <p className="text-sm text-muted-foreground">
                            The HTTP status always matches <code className="rounded bg-muted px-1 py-0.5 font-mono text-foreground">error.code</code>,
                            so you can branch on either.
                        </p>
                    </section>

                    {/* 3. Rate limits */}
                    <section className="space-y-4">
                        <SectionHeading
                            id="rate-limits" index={3} icon={Gauge} title="Rate Limits"
                            lead="Limits are per API key, per endpoint group, over a sliding 60-second window. Exceeding one returns 429 with a Retry-After header."
                        />
                        <div className="overflow-x-auto rounded-2xl border border-border bg-card">
                            <table className="w-full min-w-[520px] text-left text-sm">
                                <thead className="border-b border-border bg-muted">
                                    <tr>
                                        <th className="px-4 py-2.5 font-semibold text-foreground">Group</th>
                                        <th className="px-4 py-2.5 font-semibold text-foreground">Endpoints</th>
                                        <th className="px-4 py-2.5 text-right font-semibold text-foreground">Requests / min</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {RATE_LIMITS.map(r => (
                                        <tr key={r.bucket} className="border-b border-border last:border-0">
                                            <td className="px-4 py-2.5 font-medium text-foreground">{r.bucket}</td>
                                            <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground">{r.endpoints}</td>
                                            <td className="px-4 py-2.5 text-right font-bold text-foreground">{r.perMinute}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                        <p className="text-sm text-muted-foreground">
                            These are defaults and may be adjusted. Bill lookups and payments are deliberately tight: a
                            lookup is a paid provider call, and a payment cannot be recalled.
                        </p>
                    </section>

                    {/* 4 & 5. Endpoints */}
                    {DOC_GROUPS.map((g, i) => (
                        <section key={g.id} className="space-y-4">
                            <SectionHeading
                                id={g.id} index={4 + i} icon={GROUP_ICON[g.id]} title={g.title} lead={g.lead}
                            />
                            <div className="space-y-4">
                                {ALL_ENDPOINTS.filter(ep => ep.group === g.id).map(ep => (
                                    <EndpointCard key={anchorFor(ep)} ep={ep} lang={lang} onLang={chooseLang} />
                                ))}
                            </div>
                        </section>
                    ))}

{/* 6. Webhooks */}
                    <section className="space-y-4">
                        <SectionHeading
                            id="webhooks" index={10} icon={Radio} title="Webhooks"
                            lead="Register an HTTPS endpoint and we POST to it when an order settles, so you do not have to poll every order you place."
                        />
                        <p className="text-sm text-muted-foreground">
                            Register it in your dashboard under Developer API → Webhooks. Each key kind has its own
                            endpoint and its own signing secret, shown once when you save.
                        </p>

                        <div className="overflow-x-auto rounded-2xl border border-border bg-card">
                            <table className="w-full min-w-[520px] text-left text-sm">
                                <thead className="border-b border-border bg-muted">
                                    <tr>
                                        <th className="px-4 py-2.5 font-semibold text-foreground">Event</th>
                                        <th className="px-4 py-2.5 font-semibold text-foreground">Key</th>
                                        <th className="px-4 py-2.5 font-semibold text-foreground">Fires when</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {WEBHOOK_EVENTS.map(e => (
                                        <tr key={e.event} className="border-b border-border last:border-0">
                                            <td className="px-4 py-2.5 font-mono text-xs font-bold text-foreground">{e.event}</td>
                                            <td className="px-4 py-2.5 text-xs text-muted-foreground">{e.keyKind === 'commission' ? 'Commission' : 'Standard'}</td>
                                            <td className="px-4 py-2.5 text-muted-foreground">{e.when}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>

                        <div className="grid gap-3 lg:grid-cols-2">
                            <CodeBlock label="What we send" code={WEBHOOK_SAMPLE} />
                            <CodeBlock label="Verify the signature (Node)" code={WEBHOOK_VERIFY} />
                        </div>

                        <p className="text-sm text-muted-foreground">
                            Hash the <strong>raw</strong> body, before any JSON parsing — re-serialising changes the
                            bytes and the signature will not match. Respond 2xx as soon as you have stored the event
                            and do your own work afterwards. We retry three times with backoff on a timeout or 5xx; a
                            4xx is treated as a permanent rejection and is not retried.
                        </p>
                        <p className="text-sm text-muted-foreground">
                            Airtime and bill events are sent the instant the order settles. Data and AFA events are
                            swept within about a minute. A webhook is a convenience, not a guarantee — if your endpoint
                            was unreachable for every retry, the order status is still authoritative at
                            <code className="mx-1 rounded bg-muted px-1 py-0.5 font-mono text-foreground">GET /api/v2/orders/{'{reference}'}</code>.
                        </p>
                    </section>


                    {/* 11. Networks */}
                    <section className="space-y-4">
                        <SectionHeading
                            id="networks" index={11} icon={Signal} title="Networks"
                            lead="Ghana only. Send local numbers in 0XXXXXXXXX form — 233XXXXXXXXX is also accepted and normalised."
                        />
                        <div className="grid gap-3 sm:grid-cols-3">
                            {[
                                { name: 'MTN',     value: 'MTN',     prefixes: '024, 025, 053, 054, 055, 059' },
                                { name: 'Telecel', value: 'Telecel', prefixes: '020, 050 (formerly Vodafone)' },
                                { name: 'AT',      value: 'AT',      prefixes: '026, 027, 056, 057 (AirtelTigo)' },
                            ].map(n => (
                                <div key={n.name} className="rounded-2xl border border-border bg-card p-4">
                                    <p className="font-bold text-foreground">{n.name}</p>
                                    <code className="mt-1 block font-mono text-xs text-accent-solid">network: "{n.value}"</code>
                                    <p className="mt-2 text-xs text-muted-foreground">{n.prefixes}</p>
                                </div>
                            ))}
                        </div>
                        <p className="text-sm text-muted-foreground">
                            Pass the value exactly as shown — the API matches it, not the brand name. International
                            numbers and other networks are rejected. Which bundle sizes exist per network changes, so
                            read <code className="rounded bg-muted px-1 py-0.5 font-mono text-foreground">/api/v2/packages</code>{' '}
                            rather than hardcoding a list.
                        </p>
                    </section>

                    {/* 12. Error codes */}
                    <section className="space-y-4">
                        <SectionHeading
                            id="error-codes" index={12} icon={AlertTriangle} title="Error Codes"
                            lead="The error message is written to be read — it usually says exactly what to change."
                        />
                        <div className="space-y-2">
                            {ERROR_CODES.map(e => (
                                <div key={e.code} className="flex gap-3 rounded-2xl border border-border bg-card p-4">
                                    <span className={cn(
                                        'flex h-8 w-12 shrink-0 items-center justify-center rounded-lg font-mono text-sm font-bold',
                                        e.code >= 500
                                            ? 'bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300'
                                            : 'bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300'
                                    )}>
                                        {e.code}
                                    </span>
                                    <div className="min-w-0 text-sm">
                                        <p className="font-bold text-foreground">{e.name}</p>
                                        <p className="mt-0.5 text-muted-foreground">{e.when}</p>
                                        <p className="mt-1 text-foreground"><span className="font-semibold">Do:</span> {e.action}</p>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </section>

                    {/* 13. Tips */}
                    <section className="space-y-4">
                        <SectionHeading id="tips" index={13} icon={Lightbulb} title="Tips & Recommendations" />
                        <div className="grid gap-3 sm:grid-cols-2">
                            {[
                                { title: 'Always send a reference', body: 'Your reference is the idempotency key. If a request times out, send it again with the same reference — you get the existing order back instead of being charged twice.' },
                                { title: 'Poll, don\'t assume', body: 'A purchase response means the order was accepted, not delivered. Poll the order status endpoint until it reaches completed or failed.' },
                                { title: 'Read catalogues, don\'t hardcode', body: 'Packages, billers, checker types and AFA fields change. Fetch them and cache for a few minutes rather than baking values into your app.' },
                                { title: 'Verify before you pay a bill', body: 'Call utilities/lookup and show the account name to your customer first. A mistyped digit pays someone else, and bill payments cannot be reversed.' },
                                { title: 'Keep the key server-side', body: 'Store it in an environment variable, never in frontend code or a git repository. If it leaks, revoke it from the dashboard and generate a new one.' },
                                { title: 'Back off on 429', body: 'Honour the Retry-After header. Retrying in a tight loop only extends the window you are locked out for.' },
                            ].map(t => (
                                <div key={t.title} className="rounded-2xl border border-border bg-card p-4">
                                    <p className="font-bold text-foreground">{t.title}</p>
                                    <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{t.body}</p>
                                </div>
                            ))}
                        </div>
                    </section>

                    <footer className="border-t border-border pt-6 text-sm text-muted-foreground">
                        Questions about the API? Reach us from your{' '}
                        <Link href="/dashboard/developer-api" className="font-semibold text-accent-solid underline-offset-2 hover:underline">
                            developer dashboard
                        </Link>.
                    </footer>
                </main>
            </div>
        </div>
    )
}
