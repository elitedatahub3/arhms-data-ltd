/**
 * Customer SMS rules that have no server dependencies.
 *
 * Split out of lib/sms/customer-sms.ts so the dashboard can import them: that
 * file pulls in the SMS provider layer, which must never end up in a client
 * bundle. The compose box and the sender ID form run exactly the same checks
 * the routes do by importing from here.
 */

// ============================================================
// SEGMENTS
// ============================================================

// GSM 03.38 basic set. Anything outside it (and its extension table) forces the
// whole message into UCS-2, which more than halves what fits in one segment —
// a single curly quote pasted from Word is the usual culprit.
const GSM7_BASIC =
    '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
    '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà'

// These cost two GSM-7 characters each: an escape byte plus the character.
const GSM7_EXTENDED = '^{}\\[~]|€'

export interface SegmentInfo {
    segments: number
    /** Characters counted the way the encoding charges for them. */
    length: number
    encoding: 'GSM-7' | 'UCS-2'
    /** How many more characters fit before another segment is charged. */
    remaining: number
}

/**
 * Prices a message in SMS segments.
 *
 * The dashboard's cost estimate and the send route's credit debit both call
 * this, so what the owner is quoted is exactly what they are charged.
 */
export function countSegments(message: string): SegmentInfo {
    const text = message ?? ''

    let gsmLength = 0
    let isGsm = true

    for (const char of text) {
        if (GSM7_BASIC.includes(char)) {
            gsmLength += 1
        } else if (GSM7_EXTENDED.includes(char)) {
            gsmLength += 2
        } else {
            isGsm = false
            break
        }
    }

    if (isGsm) {
        const single = 160
        const multi = 153
        const segments = gsmLength <= single ? 1 : Math.ceil(gsmLength / multi)
        const capacity = segments === 1 ? single : segments * multi
        return { segments: Math.max(1, segments), length: gsmLength, encoding: 'GSM-7', remaining: capacity - gsmLength }
    }

    // UCS-2 is billed per UTF-16 code unit, so an emoji outside the BMP costs
    // two — which is why this counts .length rather than iterating characters.
    const unitLength = text.length
    const single = 70
    const multi = 67
    const segments = unitLength <= single ? 1 : Math.ceil(unitLength / multi)
    const capacity = segments === 1 ? single : segments * multi
    return { segments: Math.max(1, segments), length: unitLength, encoding: 'UCS-2', remaining: capacity - unitLength }
}

export const SMS_MESSAGE_MIN = 3
export const SMS_MESSAGE_MAX = 1000

// ============================================================
// SENDER IDs
// ============================================================

export const SENDER_ID_MIN = 3
export const SENDER_ID_MAX = 11

/**
 * Words the networks refuse outright, because a sender ID carrying them reads
 * as if the telco itself sent the message. Matched anywhere in the name: the
 * point of the rule is that "MTNDATAHUB" is exactly what people try first.
 */
const BLOCKED_SUBSTRINGS = [
    'DATA', 'BUNDLE', 'TELECEL', 'VODAFONE', 'AIRTELTIGO', 'AIRTEL',
    'TIGO', 'MTN', 'MOMO', 'MOBILEMONEY',
    // Banks and payment rails: a message "from" one of these is the classic
    // phishing opener, and the networks refuse them for the same reason.
    'BANK', 'ECOBANK', 'STANBIC', 'ABSA', 'FIDELITY', 'CALBANK', 'ZENITH',
    'HUBTEL', 'PAYSTACK', 'EXPRESSPAY', 'ZEEPAY', 'GHIPSS',
]

/**
 * Short words that would otherwise swallow innocent names — blocking "GLO" as a
 * substring would reject "Global Shop", so these only match as whole words.
 */
const BLOCKED_WORDS = ['GLO', 'AT', 'GCB', 'UBA', 'CBG', 'ADB', 'ECG', 'GRA', 'SSNIT', 'NHIS', 'NCA']

/** Shown in the request form, so the owner reads them before typing a name. */
export const SENDER_ID_TIPS = [
    'Use your real business name — the networks check it against your Ghana Card and business details.',
    'Do not put DATA, BUNDLE, MOMO, BANK or any network, bank or government name (MTN, Telecel, GCB, ECG, GRA…) in it. Names like these are rejected outright.',
    `Keep it to ${SENDER_ID_MAX} characters or fewer — letters, numbers and spaces only.`,
    'Approval is done by the networks, not by us, so it can take a few working days.',
]

export interface SenderIdCheck {
    ok: boolean
    error?: string
}

/**
 * Validates a requested sender ID against the rules the networks apply.
 *
 * Called both in the request form (so the owner is told before submitting) and
 * in the route (so the rule holds regardless of the client).
 */
export function validateSenderId(name: string): SenderIdCheck {
    const sender = (name ?? '').trim()

    if (sender.length < SENDER_ID_MIN) {
        return { ok: false, error: `Sender ID must be at least ${SENDER_ID_MIN} characters` }
    }
    if (sender.length > SENDER_ID_MAX) {
        return { ok: false, error: `Sender ID must be ${SENDER_ID_MAX} characters or fewer` }
    }
    if (!/^[A-Za-z0-9 ]+$/.test(sender)) {
        return { ok: false, error: 'Sender ID can only contain letters, numbers and spaces' }
    }
    if (!/[A-Za-z]/.test(sender)) {
        return { ok: false, error: 'Sender ID must contain at least one letter — the networks reject all-number names' }
    }

    const upper = sender.toUpperCase()
    const squashed = upper.replace(/\s+/g, '')

    for (const word of BLOCKED_SUBSTRINGS) {
        if (squashed.includes(word)) {
            return {
                ok: false,
                error: `Sender ID cannot contain "${word}" — the networks reject names that look like a telco, a bank or a data service. Use your business name instead.`,
            }
        }
    }

    for (const word of BLOCKED_WORDS) {
        if (upper.split(/[^A-Z0-9]+/).includes(word)) {
            return {
                ok: false,
                error: `Sender ID cannot contain "${word}" — the networks reject names that look like a telco, a bank or a government body. Use your business name instead.`,
            }
        }
    }

    return { ok: true }
}

/**
 * The blocked word a sender name carries, or null if it carries none. The same
 * rule validateSenderId applies at request time, re-run at send time against
 * names that predate it or were set by hand.
 */
export function findBlockedSenderWord(name: string): string | null {
    const upper = (name ?? '').trim().toUpperCase()
    const squashed = upper.replace(/\s+/g, '')
    for (const word of BLOCKED_SUBSTRINGS) {
        if (squashed.includes(word)) return word
    }
    const words = upper.split(/[^A-Z0-9]+/)
    for (const word of BLOCKED_WORDS) {
        if (words.includes(word)) return word
    }
    return null
}

// ============================================================
// RECIPIENTS
// ============================================================

/**
 * The Lead's own sub-agents, offered as a group they never have to maintain.
 *
 * Virtual on purpose: membership is read at send time from sub_agents, so a sub
 * who joined this morning is included and one suspended yesterday is not,
 * without anybody editing a list.
 */
export const SUB_AGENTS_GROUP_ID = 'system:sub-agents'

// ============================================================
// MODES & CONTENT
// ============================================================

/**
 * Platform Mode is where every account starts. Business Mode is earned by an
 * approved business registration and is what allows links in messages.
 */
export type SmsMode = 'platform' | 'business'

// Explicit schemes and www. always count. A bare domain counts only with a TLD
// people actually use in links, so "GHS 5.00" or "Mr.Ofori" is not a URL.
const URL_PATTERN =
    /(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|gh|io|co|me|ly|xyz|info|biz|link|app|site|online|shop|store|top|click|live|to|gl|cc|ws)\b(?:\/\S*)?/i

/**
 * Scam patterns refused in every mode. These are the scripts that circulate in
 * Ghana — "wrong transfer, send it back", "your MoMo is blocked", "send me your
 * PIN" — and a sender ID on our account delivering one is our problem too.
 *
 * Deliberately narrow: an ordinary OTP ("Your code is 1234. Do not share it")
 * must pass, since that is the commonest thing the SMS API is used for.
 */
const FRAUD_PATTERNS: { pattern: RegExp; label: string }[] = [
    { pattern: /\b(?:send|share|give|tell|provide|reply with|forward)\s+(?:it\s+|me\s+|us\s+)?(?:your|the)\s+(?:momo\s+|mobile money\s+|bank\s+|atm\s+|card\s+)?(?:pin|otp|password|secret code|verification code)\b/i, label: 'asks for a PIN or code' },
    { pattern: /\b(?:momo|mobile money|wallet|sim)\b[^.!?\n]{0,30}\b(?:has been|is|was|will be)\s+(?:blocked|suspended|frozen|deactivated)\b/i, label: 'claims a MoMo account is blocked' },
    { pattern: /\b(?:wrong(?:ly)?|mistaken(?:ly)?|by mistake)\b[^.!?\n]{0,60}\b(?:send (?:it |the money )?back|refund|reverse|return (?:it|the money))\b/i, label: 'asks for a "wrong transfer" refund' },
    { pattern: /\byou(?:'ve| have)? won\b[^.!?\n]{0,60}\b(?:promo|lottery|draw|prize|jackpot|cash)\b/i, label: 'claims a prize' },
    { pattern: /\b(?:verify|confirm|update|reactivate|unblock)\s+your\s+(?:momo|mobile money|bank|wallet)\b/i, label: 'asks to verify a MoMo or bank account' },
]

// "Do not share your PIN" is the warning, not the scam. Checked by hand rather
// than with a lookbehind, which older Safari cannot parse — this file ships to
// the browser.
const NEGATION_BEFORE = /\b(?:not|never|don't|dont|won't)\s*$/i

function findFraud(text: string): string | null {
    for (const { pattern, label } of FRAUD_PATTERNS) {
        const match = pattern.exec(text)
        if (!match) continue
        const before = text.slice(Math.max(0, match.index - 15), match.index)
        if (NEGATION_BEFORE.test(before)) continue
        return label
    }
    return null
}

/**
 * Wording that only a network or Mobile Money ever sends. A message carrying it
 * is a fake alert — "Your Account has been credited with 1 GB" or "Payment made
 * for GHS 20.00 … Transaction ID: …" — used to convince a buyer they were paid
 * or delivered to when they were not. Each pattern is specific to an alert's own
 * phrasing, so ordinary promos ("Buy 1GB MTN data for GHS 5, valid 30 days")
 * still pass. Refused in every mode, like the scam scripts above.
 */
const CEDI = String.raw`(?:gh\s*(?:s|c|₵|¢)|₵|¢|cedis?)`
const SPOOFED_ALERT_PATTERNS: { label: string; re: RegExp }[] = [
    { label: 'an account-credited alert', re: /\b(?:account|wallet|line|number)\s+has\s+been\s+credited\b/i },
    { label: 'a data/money credit alert', re: new RegExp(String.raw`\bcredited\s+with\s+(?:${CEDI}\s*)?[\d.,]+\s*(?:gb|mb|${CEDI})?`, 'i') },
    { label: 'a Mobile Money payment alert', re: new RegExp(String.raw`\bpayment\s+(?:made|received|sent)\s+(?:for|of)\s+${CEDI}`, 'i') },
    { label: 'a Mobile Money receipt', re: new RegExp(String.raw`\b(?:you\s+have\s+)?received\s+${CEDI}\s*[\d.,]+\s+from\b`, 'i') },
    { label: 'a balance notice', re: new RegExp(String.raw`\b(?:current|available|new)\s+balance\s*(?:is|:)?\s*${CEDI}`, 'i') },
    { label: 'a transaction ID', re: /\b(?:financial\s+)?transaction\s+id\s*[:#.]?\s*\d{6,}/i },
    { label: 'a Mobile Money charge line', re: new RegExp(String.raw`\b(?:fee|tax)\s+charged\s*:?\s*${CEDI}`, 'i') },
    { label: 'a Mobile Money cash alert', re: /\bcash\s*[- ]?(?:in|out)\s+(?:received|of|made|successful)\b/i },
    { label: 'a link to the MoMo app', re: /mtnmymomo|momo\s*app/i },
]

function findSpoofedAlert(text: string): string | null {
    // Zero-width characters are the usual way to slip a phrase past a filter.
    const normalised = text.replace(/[​-‍⁠﻿]/g, '').replace(/\s+/g, ' ')
    for (const { label, re } of SPOOFED_ALERT_PATTERNS) {
        if (re.test(normalised)) return label
    }
    return null
}

export interface ContentCheck {
    ok: boolean
    error?: string
    /** Set when the only problem is a link, so the UI can point at Business Mode. */
    needsBusinessMode?: boolean
    /** Which network/MoMo alert the message imitated, for logs and the admin alert. */
    spoofedAlert?: string
}

/**
 * Message content rules by mode.
 *
 * Called by the compose box (as a hint) and by the send path (as the gate),
 * for dashboard and API sends alike.
 */
export function checkMessageContent(message: string, mode: SmsMode): ContentCheck {
    const text = message ?? ''

    const spoofed = findSpoofedAlert(text)
    if (spoofed) {
        return {
            ok: false,
            spoofedAlert: spoofed,
            error: `This message looks like ${spoofed} from MTN or Mobile Money. SMS cannot imitate network or Mobile Money alerts — write it as a message from your business.`,
        }
    }

    const fraud = findFraud(text)
    if (fraud) {
        return { ok: false, error: `This message looks like a scam (it ${fraud}) and cannot be sent. Contact support if this is a mistake.` }
    }

    if (mode !== 'business' && URL_PATTERN.test(text)) {
        return {
            ok: false,
            needsBusinessMode: true,
            error: 'Links are only allowed in Business Mode. Remove the link, or register your business to unlock links.',
        }
    }

    return { ok: true }
}

// ============================================================
// BUSINESS REGISTRATION
// ============================================================

export const BUSINESS_NAME_MIN = 2
export const BUSINESS_NAME_MAX = 120
export const BUSINESS_DESCRIPTION_MIN = 10
export const BUSINESS_DESCRIPTION_MAX = 2000

const GHANA_CARD_PATTERN = /^GHA-(\d{9})-(\d)$/

/** GHA-123456789-0, typed with any spacing or case. */
export function normaliseGhanaCard(raw: string): string | null {
    const compact = String(raw ?? '').toUpperCase().replace(/\s+/g, '')
    const withDashes = /^GHA\d{10}$/.test(compact) ? `GHA-${compact.slice(3, 12)}-${compact.slice(12)}` : compact
    return GHANA_CARD_PATTERN.test(withDashes) ? withDashes : null
}

/** The four digits that are kept: the last three of the number plus the check digit. */
export function ghanaCardLast4(card: string): string | null {
    const match = GHANA_CARD_PATTERN.exec(card)
    return match ? `${match[1].slice(-3)}${match[2]}` : null
}

/** 1234 → GHA-*****123-4, the only form the card is ever shown in again. */
export function maskGhanaCard(last4: string | null | undefined): string | null {
    if (!last4 || !/^\d{4}$/.test(last4)) return null
    return `GHA-*****${last4.slice(0, 3)}-${last4.slice(3)}`
}

/** 0244123456, +233 24 412 3456 or 233244123456 → 233244123456. */
export function normaliseWhatsApp(raw: string): string | null {
    const digits = String(raw ?? '').replace(/\D/g, '')
    if (/^233\d{9}$/.test(digits)) return digits
    if (/^0\d{9}$/.test(digits)) return `233${digits.slice(1)}`
    return null
}

/** "https://Shop.com/about" → "shop.com". Null when it is not a plausible domain. */
export function normaliseDomain(raw: string): string | null {
    const trimmed = String(raw ?? '').trim().toLowerCase()
    if (!trimmed) return null
    const host = trimmed.replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[/?#]/)[0]
    return /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/.test(host) ? host : null
}

export interface BusinessInput {
    businessName: string
    description: string
    domain: string
    ghanaCard: string
    whatsapp: string
}

/**
 * What stops a registration from being SUBMITTED. A draft may be saved with
 * gaps; only the name is required for that.
 */
export function businessSubmitErrors(input: BusinessInput): string[] {
    const errors: string[] = []
    const name = (input.businessName ?? '').trim()
    const description = (input.description ?? '').trim()
    if (name.length < BUSINESS_NAME_MIN || name.length > BUSINESS_NAME_MAX) errors.push(`Business name must be ${BUSINESS_NAME_MIN}–${BUSINESS_NAME_MAX} characters`)
    if (description.length < BUSINESS_DESCRIPTION_MIN || description.length > BUSINESS_DESCRIPTION_MAX) errors.push(`Description must be ${BUSINESS_DESCRIPTION_MIN}–${BUSINESS_DESCRIPTION_MAX} characters`)
    if (!normaliseDomain(input.domain)) errors.push('Enter your business website or domain')
    if (!normaliseGhanaCard(input.ghanaCard)) errors.push('Enter a valid Ghana Card number (GHA-XXXXXXXXX-X)')
    if (!normaliseWhatsApp(input.whatsapp)) errors.push('Enter a valid WhatsApp number (e.g. 233244123456)')
    return errors
}
