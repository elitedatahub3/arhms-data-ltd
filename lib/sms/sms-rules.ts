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
]

/**
 * Short words that would otherwise swallow innocent names — blocking "GLO" as a
 * substring would reject "Global Shop", so these only match as whole words.
 */
const BLOCKED_WORDS = ['GLO', 'AT']

/** Shown in the request form, so the owner reads them before typing a name. */
export const SENDER_ID_TIPS = [
    'Use your real business name — the networks check it against your Ghana Card and business details.',
    'Do not put DATA, BUNDLE, MOMO or any network name (MTN, Telecel, AirtelTigo) in it. Names like these are rejected outright.',
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

    const blocked = findBlockedSenderWord(sender)
    if (blocked) {
        return {
            ok: false,
            error: `Sender ID cannot contain "${blocked}" — the networks reject names that look like a telco or a data service. Use your business name instead.`,
        }
    }

    return { ok: true }
}

/** The telco/data word a sender name carries, or null if it carries none. */
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
// MESSAGE CONTENT
// ============================================================

/**
 * Wording that only a network or Mobile Money ever sends. A shop SMS carrying
 * it is a fake alert — "Your Account has been credited with 1 GB" or "Payment
 * made for GHS 20.00 … Transaction ID: …" — used to convince a buyer they were
 * paid or delivered to when they were not. Each pattern is specific to an
 * alert's own phrasing, so ordinary promos ("Buy 1GB MTN data for GHS 5,
 * valid 30 days") still pass.
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

export interface MessageContentCheck {
    ok: boolean
    error?: string
    /** Which kind of alert it imitated, for logs. */
    matched?: string
}

/**
 * Refuses messages written to look like a network or Mobile Money alert.
 * Runs in the compose box (so the owner sees why) and in the send route (so
 * the rule holds whatever the client does).
 */
export function checkMessageContent(message: string): MessageContentCheck {
    // Zero-width characters are the usual way to slip a phrase past a filter.
    const text = (message ?? '').replace(/[​-‍⁠﻿]/g, '').replace(/\s+/g, ' ')
    for (const { label, re } of SPOOFED_ALERT_PATTERNS) {
        if (re.test(text)) {
            return {
                ok: false,
                matched: label,
                error: `This message looks like ${label} from MTN or Mobile Money. Customer SMS cannot imitate network or Mobile Money alerts — write it as a message from your shop.`,
            }
        }
    }
    return { ok: true }
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
