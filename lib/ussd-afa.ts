/**
 * AFA registration over USSD — what is on offer, at what price, and how the caller's
 * answers are read.
 *
 * The caller answers five short screens (name, Ghana Card number, date of birth, region,
 * town) and then chooses which number to register. The ID type is always Ghana Card, and
 * the occupation is 'Farmer', exactly as on the storefront. Every answer goes through the
 * same rules the web forms use (lib/afa-validation.ts), so a USSD application cannot
 * reach the admin queue in a shape the dashboard would have refused.
 *
 * EDGE-SAFE. app/api/hubtel/interact runs on the edge runtime: only pure modules and
 * PostgREST reads in here.
 */
import { ID_PATTERNS, MIN_AFA_AGE, VALID_REGIONS, ageFromDob, maskIdNumber } from '@/lib/afa-validation'
import { resolveAfaApiPrice, resolveAfaCostPrice } from '@/lib/afa-pricing'
import { computeShopProfit } from '@/lib/shop-profit'

export const AFA_ITEM_NAME = 'AFA Registration'

/** The applicant, as collected over USSD. `phone` is the number being registered. */
export interface UssdAfaForm {
    full_name: string
    id_number: string
    /** ISO yyyy-mm-dd. */
    date_of_birth: string
    region: string
    location: string
    phone: string
}

/**
 * One flat shape rather than a discriminated union: the project does not compile in strict
 * mode, where `if (!parsed.ok)` does not narrow a union. `ok` says which field to read.
 */
export interface Parsed<T> {
    ok: boolean
    value?: T
    error?: string
}

/** Regions shown per screen. Sixteen regions at 8 a page keeps each under ~160 characters. */
export const REGION_PAGE_SIZE = 8

// ── Offer ───────────────────────────────────────────────────────────────────────

/**
 * Whether this session can sell AFA right now, and at what price.
 *
 *   shop    — the owner's own price, which must clear what the owner pays (or, for a sub's
 *             shop, the upline's price). Needs the admin's storefront AFA switch, exactly
 *             like the storefront.
 *   member  — the platform price for the member's role (the admin-set API price for an API
 *             user), what the dashboard charges. A sub-agent member is NOT offered AFA: their
 *             purchase runs through process_sub_afa_order, which is not installed in the
 *             database, so a sale could be paid for and never fulfilled.
 *   house   — never; the house code has not sold AFA.
 */
export async function loadAfaOffer(db: any, sessionData: any): Promise<{ price: number } | null> {
    if (sessionData.mode === 'member') {
        const member = sessionData.member
        if (!member || member.sub) return null
        const result = member.isApiUser
            ? await resolveAfaApiPrice(db, member.role)
            : await resolveAfaCostPrice(db, member.role)
        return result.ok && result.price && result.price > 0 ? { price: result.price } : null
    }

    if (sessionData.mode === 'shop' && sessionData.shopId && sessionData.ownerId) {
        const [{ data: toggle }, { data: pricing }] = await Promise.all([
            db.from('admin_settings').select('value').eq('key', 'storefront_afa_enabled').maybeSingle(),
            db.from('shop_afa_pricing').select('selling_price').eq('shop_id', sessionData.shopId).maybeSingle(),
        ])
        if (toggle?.value !== 'true') return null

        const price = Number(pricing?.selling_price)
        if (!(price > 0)) return null

        // A price at or below what the owner pays is not for sale: nobody would earn on it.
        const split = await computeShopProfit(db, { kind: 'afa', ownerId: sessionData.ownerId, unitPrice: price })
        if (!split || split.totalMargin <= 0) return null

        return { price }
    }

    return null
}

// ── Reading the caller's answers ────────────────────────────────────────────────

/** ASCII only: what is typed here is echoed back through Hubtel, which throws on anything else. */
const NAME_CHARS = /^[A-Za-z][A-Za-z .'-]*$/

export function parseFullName(input: string): Parsed<string> {
    const value = String(input ?? '').trim().replace(/\s+/g, ' ')
    if (!NAME_CHARS.test(value) || value.length > 60) {
        return { ok: false, error: 'Use letters A-Z only.' }
    }
    if (value.split(' ').filter(Boolean).length < 2) {
        return { ok: false, error: 'Enter first and last name.' }
    }
    return { ok: true, value }
}

/** Accepts 'GHA-123456789-0', 'gha123456789-0' or just the ten digits. */
export function parseGhanaCard(input: string): Parsed<string> {
    const raw = String(input ?? '').toUpperCase().replace(/\s+/g, '')
    const rest = raw.replace(/^GHA-?/, '')
    // Exactly ten digits: maskIdNumber() truncates, so a longer entry would otherwise be
    // quietly accepted as a card number the applicant never typed.
    if (!/^[\d-]+$/.test(rest) || rest.replace(/\D/g, '').length !== 10) {
        return { ok: false, error: 'Invalid Ghana Card number.' }
    }
    const masked = maskIdNumber('Ghana Card', rest)
    if (!ID_PATTERNS['Ghana Card'].test(masked)) return { ok: false, error: 'Invalid Ghana Card number.' }
    return { ok: true, value: masked }
}

/** DDMMYYYY (separators allowed) -> ISO date, for a real date of someone aged 18 to 110. */
export function parseDateOfBirth(input: string, now: Date = new Date()): Parsed<string> {
    const m = String(input ?? '').trim().match(/^(\d{2})[/\-. ]?(\d{2})[/\-. ]?(\d{4})$/)
    if (!m) return { ok: false, error: 'Use DDMMYYYY, e.g. 15031990.' }
    const [dd, mm, yyyy] = [Number(m[1]), Number(m[2]), Number(m[3])]
    const iso = `${m[3]}-${m[2]}-${m[1]}`
    const d = new Date(Date.UTC(yyyy, mm - 1, dd))
    const real = d.getUTCFullYear() === yyyy && d.getUTCMonth() === mm - 1 && d.getUTCDate() === dd
    if (!real || d.getTime() > now.getTime()) return { ok: false, error: 'That date is not valid.' }
    const age = ageFromDob(iso)
    if (age === null || age > 110) return { ok: false, error: 'That date is not valid.' }
    if (age < MIN_AFA_AGE) return { ok: false, error: `Applicant must be ${MIN_AFA_AGE} or older.` }
    return { ok: true, value: iso }
}

export function parseTown(input: string): Parsed<string> {
    const value = String(input ?? '').trim().replace(/\s+/g, ' ')
    if (value.length < 2 || value.length > 60 || !/^[A-Za-z0-9][A-Za-z0-9 .,'/-]*$/.test(value)) {
        return { ok: false, error: 'Use letters and numbers only.' }
    }
    return { ok: true, value }
}

/** `choice` is the number the caller typed on the given page of the region list. */
export function regionFromChoice(choice: string, page: number): string | null {
    const n = parseInt(choice, 10)
    if (!Number.isInteger(n) || n < 1 || n > REGION_PAGE_SIZE) return null
    return VALID_REGIONS[page * REGION_PAGE_SIZE + n - 1] ?? null
}

// ── Screens ─────────────────────────────────────────────────────────────────────

export const AFA_NAME_PROMPT = 'AFA Registration\nEnter full name (as on Ghana Card):'
export const AFA_CARD_PROMPT = 'Enter Ghana Card number\n(e.g. GHA-123456789-0):'
export const AFA_DOB_PROMPT = 'Enter date of birth\nas DDMMYYYY (e.g. 15031990):'
export const AFA_TOWN_PROMPT = 'Enter your town or\nlocation:'
export const AFA_PHONE_PROMPT = 'Enter the number to register:\n(or send 1 for your own number)'

export function renderRegionMenu(page: number): string {
    const lastPage = Math.ceil(VALID_REGIONS.length / REGION_PAGE_SIZE) - 1
    const start = page * REGION_PAGE_SIZE
    let msg = 'Select Region:\n'
    VALID_REGIONS.slice(start, start + REGION_PAGE_SIZE).forEach((r, i) => {
        msg += `${i + 1}. ${r}\n`
    })
    if (page < lastPage) msg += '99. Next\n'
    if (page > 0) msg += '88. Prev\n'
    msg += '0. Back'
    return msg
}

export function lastRegionPage(): number {
    return Math.ceil(VALID_REGIONS.length / REGION_PAGE_SIZE) - 1
}
