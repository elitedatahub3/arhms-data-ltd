/**
 * Pure helpers for ARHMS AI (no imports, so node --test can load them directly).
 * Covered by lib/__tests__/ai-assistant-helpers.test.mts.
 */

export type AssistantMode = 'off' | 'admins' | 'all'

export const DEFAULT_DAILY_LIMIT = 30
export const MAX_MESSAGE_CHARS = 500

/** admin_settings.ai_assistant_mode → mode. Anything unknown is 'off'. */
export function parseAssistantMode(raw: unknown): AssistantMode {
    const v = String(raw ?? '').trim().toLowerCase()
    return v === 'admins' || v === 'all' ? v : 'off'
}

/** admin_settings.ai_assistant_daily_limit → messages per user per day (1..500). */
export function parseDailyLimit(raw: unknown): number {
    const n = parseInt(String(raw ?? ''), 10)
    if (!Number.isFinite(n)) return DEFAULT_DAILY_LIMIT
    return Math.min(Math.max(n, 1), 500)
}

/**
 * Who may open ARHMS AI. Sub-agents are always excluded: their dashboard is
 * branded as their upline's shop, so an "ARHMS AI" assistant would break that.
 */
export function canUseAssistant(mode: AssistantMode, role: string | null | undefined, isSubAgent: boolean): boolean {
    if (isSubAgent) return false
    if (mode === 'all') return true
    if (mode === 'admins') return role === 'admin' || role === 'sub-admin'
    return false
}

/** Start of the current day in Ghana (Africa/Accra is UTC+0, no DST). */
export function dayStartIso(now: Date = new Date()): string {
    const d = new Date(now)
    d.setUTCHours(0, 0, 0, 0)
    return d.toISOString()
}

/** Any common Ghana number format → 0XXXXXXXXX, or null if it isn't one. */
export function normaliseGhanaPhone(raw: unknown): string | null {
    const digits = String(raw ?? '').replace(/\D/g, '')
    if (/^0\d{9}$/.test(digits)) return digits
    if (/^233\d{9}$/.test(digits)) return '0' + digits.slice(3)
    return null
}

/** Both ways a number is stored in orders (0XXXXXXXXX and 233XXXXXXXXX). */
export function phoneVariants(raw: unknown): string[] {
    const local = normaliseGhanaPhone(raw)
    return local ? [local, '233' + local.slice(1)] : []
}

/** Link that opens the buy-data page with the package's purchase sheet open. */
export function buildBuyLink(network: string, packageId: string, phone: string | null): string {
    const params = new URLSearchParams({ network, package: packageId })
    if (phone) params.set('phone', phone)
    return `/dashboard/data-packages?${params.toString()}`
}

export interface HiddenNetworks {
    mashup: boolean
    express: boolean
    standard: boolean
}

/** Mirrors the network filter on app/dashboard/data-packages/page.tsx. */
export function isNetworkVisible(network: string, hidden: HiddenNetworks): boolean {
    if (network === 'Special MTN Mashup') return !hidden.mashup
    if (network === 'EXPRESS MTN') return !hidden.express
    if (network === 'MTN') return !hidden.standard
    return true
}

/** Trimmed message, or null when it is empty, not text, or too long. */
export function cleanUserMessage(raw: unknown): string | null {
    if (typeof raw !== 'string') return null
    const text = raw.trim()
    if (!text || text.length > MAX_MESSAGE_CHARS) return null
    return text
}

// ── Surfaces ──────────────────────────────────────────────────────────────────

/** Where ARHMS AI runs. Only 'dashboard' is live; the others land in later phases. */
export type AssistantSurface = 'dashboard' | 'home' | 'storefront' | 'admin' | 'whatsapp'

export const SURFACE_LIMITS: Record<AssistantSurface, { maxRounds: number; maxTokens: number }> = {
    dashboard: { maxRounds: 6, maxTokens: 2000 },
    home: { maxRounds: 5, maxTokens: 1500 },
    storefront: { maxRounds: 5, maxTokens: 1500 },
    admin: { maxRounds: 12, maxTokens: 2500 },
    whatsapp: { maxRounds: 4, maxTokens: 600 },
}

export const ASSISTANT_MODELS = ['deepseek-chat', 'deepseek-reasoner'] as const
export type AssistantModel = (typeof ASSISTANT_MODELS)[number]
export const DEFAULT_ASSISTANT_MODEL: AssistantModel = 'deepseek-chat'

/**
 * Model for a surface: admin_settings ai_model_<surface> if it is a known model,
 * else the AI_ASSISTANT_MODEL env fallback, else deepseek-chat.
 */
export function resolveAssistantModel(setting: unknown, envFallback?: string | null): string {
    const v = String(setting ?? '').trim()
    if ((ASSISTANT_MODELS as readonly string[]).includes(v)) return v
    const env = String(envFallback ?? '').trim()
    return env || DEFAULT_ASSISTANT_MODEL
}

/** Staff check used by the tool dispatcher, independent of which tools were offered. */
export function isStaffRole(role: unknown): boolean {
    return role === 'admin' || role === 'sub-admin'
}

// ── Knowledge base search ────────────────────────────────────────────────────

/** Escape LIKE wildcards so a crafted query cannot match the whole table. */
export function escapeLike(raw: string): string {
    return raw.replace(/[\\%_]/g, ch => '\\' + ch)
}

const STOP_WORDS = new Set([
    'the', 'and', 'for', 'how', 'what', 'why', 'when', 'where', 'can', 'you', 'your', 'are', 'was',
    'did', 'does', 'not', 'with', 'from', 'this', 'that', 'have', 'has', 'my', 'me', 'is', 'it', 'do',
    'i', 'a', 'an', 'to', 'of', 'in', 'on', 'or', 'please', 'want', 'need', 'help',
])

/**
 * Query → up to 5 lowercase letter/digit words worth searching for. Only [a-z0-9]
 * survive, so the words are also safe inside a PostgREST or() filter string.
 */
export function knowledgeSearchTerms(raw: unknown): string[] {
    const words = String(raw ?? '').toLowerCase().match(/[a-z0-9]+/g) || []
    const out: string[] = []
    for (const raw of words) {
        if (raw.length < 3 || STOP_WORDS.has(raw)) continue
        // Plural -> singular so "keys" finds "Key" (matching is by substring).
        const w = raw.length > 3 && raw.endsWith('s') && !raw.endsWith('ss') ? raw.slice(0, -1) : raw
        if (out.includes(w)) continue
        out.push(w)
        if (out.length === 6) break
    }
    return out
}

export interface KnowledgeRow {
    id: string
    category: string
    question: string
    answer: string
}

/** Best rows first by how many terms they contain (question hits count double). */
export function rankKnowledge<T extends KnowledgeRow>(rows: T[], terms: string[], limit = 5): T[] {
    const score = (r: T) => {
        const q = r.question.toLowerCase()
        const rest = `${r.answer} ${r.category}`.toLowerCase()
        let s = 0
        for (const t of terms) {
            if (q.includes(t)) s += 2
            if (rest.includes(t)) s += 1
        }
        return s
    }
    return rows
        .map(r => ({ r, s: score(r) }))
        .filter(x => x.s > 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, limit)
        .map(x => x.r)
}

// ── Abuse and cost limits ────────────────────────────────────────────────────

/** Messages one user may send in any 60 seconds (on top of the daily cap). */
export const BURST_LIMIT_PER_MINUTE = 6
export const DEFAULT_GLOBAL_DAILY_LIMIT = 3000

/** admin_settings.ai_assistant_global_daily_limit → questions per day across ALL users (1..100000). */
export function parseGlobalDailyLimit(raw: unknown): number {
    const n = parseInt(String(raw ?? ''), 10)
    if (!Number.isFinite(n)) return DEFAULT_GLOBAL_DAILY_LIMIT
    return Math.min(Math.max(n, 1), 100000)
}

// ── Secret redaction on the way out ──────────────────────────────────────────

const SECRET_PATTERNS: RegExp[] = [
    /sk-[A-Za-z0-9_-]{16,}/g, // DeepSeek / OpenAI style API keys
    /sb_(?:secret|publishable)_[A-Za-z0-9_-]{10,}/g, // Supabase keys
    /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, // JWTs (service-role keys, sessions)
    /\b[0-9a-fA-F]{32,}\b/g, // long hex secrets (order ids are dashed UUIDs, unaffected)
]

export function redactSecrets(text: string): string {
    let out = text
    for (const re of SECRET_PATTERNS) out = out.replace(re, '[hidden]')
    return out
}

/**
 * Streaming redactor: text arrives in small deltas, so a key can be split across
 * two of them. Everything up to the last whitespace is redacted and released;
 * the unfinished last word is held back until more text (or flush) arrives.
 */
export function createSecretRedactor() {
    let pending = ''
    return {
        push(delta: string): string {
            pending += delta
            const cut = Math.max(pending.lastIndexOf(' '), pending.lastIndexOf('\n'), pending.lastIndexOf('\t'))
            // Release a very long unbroken run too, so the reply never stalls.
            if (cut < 0) {
                if (pending.length < 400) return ''
                const out = redactSecrets(pending)
                pending = ''
                return out
            }
            const ready = pending.slice(0, cut + 1)
            pending = pending.slice(cut + 1)
            return redactSecrets(ready)
        },
        flush(): string {
            const out = redactSecrets(pending)
            pending = ''
            return out
        },
    }
}

// ── Site index search (lib/ai-assistant/site-index.json) ─────────────────────

export interface SiteChunk {
    id: number
    surface: 'dashboard' | 'storefront'
    path: string
    menu: string | null
    heading: string
    text: string
}

/**
 * Best page-text chunks for the terms. Menu names and headings weigh most (they
 * say WHERE something is), then the page path, then body text.
 */
export function rankSiteChunks(chunks: SiteChunk[], terms: string[], surface: SiteChunk['surface'], limit = 4): SiteChunk[] {
    if (!terms.length) return []
    const scored: { c: SiteChunk; s: number }[] = []
    for (const c of chunks) {
        if (c.surface !== surface) continue
        const head = `${c.menu || ''} ${c.heading || ''}`.toLowerCase()
        const path = c.path.toLowerCase()
        const body = c.text.toLowerCase()
        let s = 0
        let hits = 0
        for (const t of terms) {
            let hit = false
            if (head.includes(t)) { s += 3; hit = true }
            if (path.includes(t)) { s += 2; hit = true }
            if (body.includes(t)) { s += 1; hit = true }
            if (hit) hits++
        }
        // Reward chunks that match more of the question's words.
        if (s > 0) scored.push({ c, s: s + hits * 2 })
    }
    return scored.sort((a, b) => b.s - a.s).slice(0, limit).map(x => x.c)
}

// ── Monthly limits with paid resets (owner, 2026-11-18) ──────────────────────
// Dashboard users and shops get a monthly question allowance set by the admin.
// When it is used up, paying the reset price (GHS 5 user / GHS 7 shop) adds
// another full allowance for the rest of that month.

export type UsageScope = 'dashboard' | 'shop'

export const USAGE_DEFAULTS: Record<UsageScope, { limit: number; price: number }> = {
    dashboard: { limit: 100, price: 5 },
    shop: { limit: 300, price: 7 },
}

export const USAGE_SETTING_KEYS: Record<UsageScope, { limit: string; price: string }> = {
    dashboard: { limit: 'ai_dashboard_monthly_limit', price: 'ai_dashboard_reset_price' },
    shop: { limit: 'ai_shop_monthly_limit', price: 'ai_shop_reset_price' },
}

/** Ghana time is UTC+0: "2026-11" for any moment in November 2026. */
export function currentMonthKey(now: Date = new Date()): string {
    return now.toISOString().slice(0, 7)
}

export function monthStartIso(now: Date = new Date()): string {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString()
}

/** Monthly question allowance from admin_settings (1..100000). */
export function parseMonthlyLimit(raw: unknown, fallback: number): number {
    const n = parseInt(String(raw ?? ''), 10)
    if (!Number.isFinite(n)) return fallback
    return Math.min(Math.max(n, 1), 100000)
}

/** Reset price in GHS from admin_settings (0..1000, 2 decimals). */
export function parseResetPrice(raw: unknown, fallback: number): number {
    const n = parseFloat(String(raw ?? ''))
    if (!Number.isFinite(n) || n < 0) return fallback
    return Math.round(Math.min(n, 1000) * 100) / 100
}

/** This month's allowance: the base plus everything added by paid resets. */
export function monthlyAllowance(base: number, paidQuestionsAdded: number[]): number {
    return base + paidQuestionsAdded.reduce((sum, n) => sum + (n > 0 ? n : 0), 0)
}

/** How much to top up so the wallet covers the reset (never below the top-up minimum). */
export function topUpAmountFor(price: number, balance: number, minTopUp = 5): number {
    const short = Math.ceil((price - Math.max(balance, 0)) * 100) / 100
    return Math.max(minTopUp, short)
}

/** Client idempotency key for a reset: letters, digits and dashes only. */
export function isValidIdempotencyKey(raw: unknown): raw is string {
    return typeof raw === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(raw)
}

// ── Guest (storefront) history ───────────────────────────────────────────────

export interface PlainTurn {
    role: 'user' | 'assistant'
    content: string
}

/**
 * Browser-sent history -> alternating plain-text turns that start with the customer
 * and end with the assistant (the new question is appended after). Anything that
 * isn't plain user/assistant text (tool_use, tool_result, images, forged roles) is
 * dropped, so a client can't inject a fake "payment confirmed" tool result.
 */
export function cleanGuestHistory(raw: unknown, maxTurns = 12, maxChars = 500): PlainTurn[] {
    if (!Array.isArray(raw)) return []
    const out: PlainTurn[] = []
    for (const m of raw.slice(-maxTurns)) {
        const role = m?.role === 'assistant' ? 'assistant' : m?.role === 'user' ? 'user' : null
        if (!role || typeof m?.content !== 'string') continue
        const text = m.content.trim().slice(0, maxChars)
        if (!text) continue
        if (!out.length && role === 'assistant') continue
        const prev = out[out.length - 1]
        if (prev && prev.role === role) prev.content = `${prev.content}\n\n${text}`
        else out.push({ role, content: text })
    }
    if (out.length && out[out.length - 1].role === 'user') out.pop()
    return out
}

// ── Hourly / daily limits (clock windows, Ghana time = UTC) ──────────────────
// On top of the monthly allowance. When hit, the user waits; nobody pays.

export const WINDOW_DEFAULTS = {
    dashboardHour: 10,
    dashboardDay: 30,
    visitorHour: 5,
    visitorDay: 15,
}

export const WINDOW_SETTING_KEYS = {
    dashboardHour: 'ai_dashboard_hourly_limit',
    dashboardDay: 'ai_dashboard_daily_limit',
    visitorHour: 'ai_storefront_hourly_limit_per_visitor',
    visitorDay: 'ai_storefront_daily_limit_per_ip',
}

export function hourStartIso(now: Date = new Date()): string {
    const d = new Date(now)
    d.setUTCMinutes(0, 0, 0)
    return d.toISOString()
}

export function nextHourStart(now: Date = new Date()): Date {
    const d = new Date(now)
    d.setUTCMinutes(0, 0, 0)
    d.setUTCHours(d.getUTCHours() + 1)
    return d
}

export function nextDayStart(now: Date = new Date()): Date {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1))
}

/** Admin-set hour/day limit (1..1000). */
export function parseWindowLimit(raw: unknown, fallback: number): number {
    const n = parseInt(String(raw ?? ''), 10)
    if (!Number.isFinite(n)) return fallback
    return Math.min(Math.max(n, 1), 1000)
}

export type WindowCheck =
    | { ok: true; hourLeft: number; dayLeft: number }
    | { ok: false; window: 'hour' | 'day'; resetsAt: string }

/** Day wins when both are used up (waiting for the hour would not help). */
export function checkWindowLimits(p: { usedHour: number; usedDay: number; hourLimit: number; dayLimit: number; now?: Date }): WindowCheck {
    const now = p.now ?? new Date()
    if (p.usedDay >= p.dayLimit) return { ok: false, window: 'day', resetsAt: nextDayStart(now).toISOString() }
    if (p.usedHour >= p.hourLimit) return { ok: false, window: 'hour', resetsAt: nextHourStart(now).toISOString() }
    return { ok: true, hourLeft: p.hourLimit - p.usedHour, dayLeft: p.dayLimit - p.usedDay }
}

/**
 * "at 3:00 PM" when later today (Ghana time); "at midnight" when it is just after
 * midnight but soon (e.g. an hourly block at 11:30 PM); otherwise "tomorrow".
 */
export function formatResetTime(resetsAt: string | Date, now: Date = new Date()): string {
    const t = new Date(resetsAt)
    if (t.toISOString().slice(0, 10) !== now.toISOString().slice(0, 10)) {
        return t.getTime() - now.getTime() <= 6 * 60 * 60 * 1000 ? 'at midnight' : 'tomorrow'
    }
    const h = t.getUTCHours()
    const m = String(t.getUTCMinutes()).padStart(2, '0')
    return `at ${h % 12 === 0 ? 12 : h % 12}:${m} ${h < 12 ? 'AM' : 'PM'}`
}

/** User-facing message for a window block. */
export function windowLimitMessage(window: 'hour' | 'day', resetsAt: string, now: Date = new Date()): string {
    const when = formatResetTime(resetsAt, now)
    return window === 'day'
        ? `You've reached today's limit for ARHMS AI. Try again ${when}.`
        : `You've reached this hour's limit for ARHMS AI. Try again ${when}.`
}

// ── Header usage meter ───────────────────────────────────────────────────────

export interface UsageSnapshot {
    hour: { used: number; limit: number }
    day: { used: number; limit: number }
    month: { used: number; limit: number }
}

const WINDOW_WORD = { hour: "this hour's", day: "today's", month: "this month's" } as const

/**
 * The window closest to running out (highest % used), e.g. "40% of this hour's usage".
 * Ties prefer the shorter window (hour, then day), since it clears soonest.
 */
export function usageMeter(u: UsageSnapshot): { window: 'hour' | 'day' | 'month'; pct: number; label: string } {
    const pct = (w: { used: number; limit: number }) => Math.min(100, Math.max(0, Math.round((w.used / Math.max(w.limit, 1)) * 100)))
    let best: 'hour' | 'day' | 'month' = 'hour'
    for (const w of ['day', 'month'] as const) if (pct(u[w]) > pct(u[best])) best = w
    const p = pct(u[best])
    return { window: best, pct: p, label: `${p}% of ${WINDOW_WORD[best]} usage` }
}

// ── Shop assistant credits (owner's model, 2026-11-21) ───────────────────────
// Customers get free answers per day; after that each answer uses 1 shop credit:
// this month's free credits first, then bought credits (never expire).

export interface CreditPack {
    id: string
    name: string
    credits: number
    price: number
    enabled: boolean
}

export const SHOP_CREDIT_SETTING_KEYS = {
    packs: 'ai_shop_credit_packs',
    freeMonthly: 'ai_shop_free_monthly_credits',
}

export const DEFAULT_CREDIT_PACKS: CreditPack[] = [
    { id: 'starter', name: 'Starter', credits: 50, price: 5, enabled: true },
    { id: 'standard', name: 'Standard', credits: 150, price: 13, enabled: true },
    { id: 'power', name: 'Power', credits: 500, price: 40, enabled: true },
]
export const DEFAULT_FREE_MONTHLY_CREDITS = 50
export const MAX_CREDIT_PACKS = 6

/** admin_settings JSON -> validated packs (bad rows dropped; empty/invalid -> defaults). */
export function parseCreditPacks(raw: unknown): CreditPack[] {
    let list: unknown
    try {
        list = typeof raw === 'string' ? JSON.parse(raw) : raw
    } catch {
        return DEFAULT_CREDIT_PACKS
    }
    if (!Array.isArray(list)) return DEFAULT_CREDIT_PACKS
    const out: CreditPack[] = []
    for (const p of list.slice(0, MAX_CREDIT_PACKS)) {
        const id = String(p?.id ?? '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 24)
        const name = String(p?.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 30)
        const credits = parseInt(String(p?.credits ?? ''), 10)
        const price = parseFloat(String(p?.price ?? ''))
        if (!id || !name || !Number.isFinite(credits) || credits < 1 || credits > 100000) continue
        if (!Number.isFinite(price) || price < 0 || price > 10000) continue
        if (out.some(x => x.id === id)) continue
        out.push({ id, name, credits, price: Math.round(price * 100) / 100, enabled: p?.enabled !== false })
    }
    return out.length ? out : DEFAULT_CREDIT_PACKS
}

export function parseFreeMonthlyCredits(raw: unknown): number {
    const n = parseInt(String(raw ?? ''), 10)
    if (!Number.isFinite(n)) return DEFAULT_FREE_MONTHLY_CREDITS
    return Math.min(Math.max(n, 0), 100000)
}

/**
 * Who pays for the next storefront answer.
 *   'visitor_free' - this customer still has free answers today
 *   'shop_free'    - the shop's free monthly credits
 *   'shop_credit'  - one bought credit (the caller must consume it atomically)
 *   null           - nothing left: the customer waits until tomorrow
 */
export function chooseAnswerPayer(p: {
    visitorUsedToday: number
    visitorFreePerDay: number
    shopFreeUsedThisMonth: number
    shopFreeMonthly: number
    boughtBalance: number
}): 'visitor_free' | 'shop_free' | 'shop_credit' | null {
    if (p.visitorUsedToday < p.visitorFreePerDay) return 'visitor_free'
    if (p.shopFreeUsedThisMonth < p.shopFreeMonthly) return 'shop_free'
    if (p.boughtBalance > 0) return 'shop_credit'
    return null
}
