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
    dashboard: { maxRounds: 5, maxTokens: 2000 },
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
    for (const w of words) {
        if (w.length < 3 || STOP_WORDS.has(w) || out.includes(w)) continue
        out.push(w)
        if (out.length === 5) break
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
