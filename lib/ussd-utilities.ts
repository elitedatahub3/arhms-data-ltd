/**
 * Utility bills over USSD — the part that runs inside the USSD keypress.
 *
 * Paying a bill needs the KingFlexy account lookup, the biller catalogue and the shop
 * mark-up arithmetic, and all of that imports the Hubtel payment service, which pulls in
 * a proxy library the edge runtime cannot load. app/api/hubtel/interact runs on the edge
 * so that a keypress never pays a cold start, which means none of it can run there.
 *
 * So the edge route only collects the caller's answers and asks a Node-side route
 * (app/api/ussd/utilities) to do the work: price the bill, and later record the pending
 * payment. This file is the edge half — what to ask, how to read the answers, and the
 * call itself. Nothing here decides what a bill costs or whether an account exists.
 *
 * EDGE-SAFE: pure functions plus fetch and Web Crypto.
 */

/**
 * The bills USSD sells. Ghana Water is left out: it needs an email address for the receipt
 * and a single-use provider session, neither of which a keypad conversation can supply.
 */
export const USSD_UTILITY_SERVICES = ['ecg', 'dstv', 'gotv', 'startimes'] as const
export type UssdUtilityService = (typeof USSD_UTILITY_SERVICES)[number]

const LABELS: Record<UssdUtilityService, string> = {
    ecg: 'ECG Prepaid',
    dstv: 'DSTV',
    gotv: 'GOtv',
    startimes: 'StarTimes',
}

const ACCOUNT_PROMPTS: Record<UssdUtilityService, string> = {
    ecg: 'Enter ECG meter number:',
    dstv: 'Enter DSTV smartcard\nnumber:',
    gotv: 'Enter GOtv IUC number:',
    startimes: 'Enter StarTimes account\nnumber:',
}

export const UTIL_SERVICE_PROMPT_LABEL = 'Select bill'
export const UTIL_PHONE_PROMPT = 'Enter the phone number linked\nto the meter:\n(or send 1 for your own number)'
export const UTIL_AMOUNT_PROMPT = 'Enter amount in GHS:'

export function utilityLabel(service: string): string {
    return LABELS[service as UssdUtilityService] ?? service
}

export function accountPrompt(service: string): string {
    return ACCOUNT_PROMPTS[service as UssdUtilityService] ?? 'Enter account number:'
}

export function renderUtilityMenu(): string {
    let msg = 'Select Bill:\n'
    USSD_UTILITY_SERVICES.forEach((s, i) => { msg += `${i + 1}. ${LABELS[s]}\n` })
    return msg + '0. Back'
}

export function serviceFromChoice(choice: string): UssdUtilityService | null {
    const n = parseInt(choice, 10)
    return Number.isInteger(n) && n >= 1 ? USSD_UTILITY_SERVICES[n - 1] ?? null : null
}

// ── Reading the caller's answers ────────────────────────────────────────────────
// Light shape checks only. The server decides whether the account is real and the
// number acceptable; these just stop obvious typos costing a network round trip.

export function readAccountNumber(input: string): { ok: boolean; value?: string; error?: string } {
    const value = String(input ?? '').replace(/\s+/g, '')
    if (!/^[A-Za-z0-9]{6,20}$/.test(value)) return { ok: false, error: 'Invalid number.' }
    return { ok: true, value }
}

export function readAmount(input: string): { ok: boolean; value?: number; error?: string } {
    const raw = String(input ?? '').trim()
    if (!/^\d{1,5}(\.\d{1,2})?$/.test(raw)) return { ok: false, error: 'Enter an amount, e.g. 50.' }
    const value = Number(raw)
    if (!(value > 0)) return { ok: false, error: 'Enter an amount, e.g. 50.' }
    return { ok: true, value }
}

// ── The call to the Node-side route ─────────────────────────────────────────────

export interface UtilityQuote {
    /** Signed by the server: the proof the price below is the one it worked out. */
    token: string
    label: string
    accountNumber: string
    accountName: string | null
    billAmount: number
    /** Platform fee plus the shop's margin, as one figure. */
    fee: number
    /** What the caller will be charged. */
    total: number
}

export interface UtilitiesApiResult {
    ok: boolean
    /** Safe to show on a handset (the caller shortens it to one screen). */
    error?: string
    /** Which answer to ask for again. 'fatal' ends the session. */
    field?: 'account' | 'phone' | 'amount' | 'fatal'
    quote?: UtilityQuote
    amount?: number
}

/**
 * Shared secret between the edge route and the Node route, derived from a key both
 * already hold so that no new environment variable has to exist before this works.
 * Hashing it keeps the service-role key itself off the wire.
 */
export async function internalToken(): Promise<string> {
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
    const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${key}:ussd-internal:v1`))
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

export async function callUtilitiesApi(
    origin: string,
    body: Record<string, unknown>,
    timeoutMs: number
): Promise<UtilitiesApiResult> {
    try {
        const res = await fetch(`${origin}/api/ussd/utilities`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-ussd-internal': await internalToken() },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs),
        })
        return (await res.json()) as UtilitiesApiResult
    } catch (error: any) {
        console.error('[UssdUtilities] Utilities route unreachable:', error?.message)
        return { ok: false, field: 'account', error: 'We could not reach the bill service. Please try again.' }
    }
}
