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

    const upper = sender.toUpperCase()
    const squashed = upper.replace(/\s+/g, '')

    for (const word of BLOCKED_SUBSTRINGS) {
        if (squashed.includes(word)) {
            return {
                ok: false,
                error: `Sender ID cannot contain "${word}" — the networks reject names that look like a telco or a data service. Use your business name instead.`,
            }
        }
    }

    for (const word of BLOCKED_WORDS) {
        if (upper.split(/[^A-Z0-9]+/).includes(word)) {
            return {
                ok: false,
                error: `Sender ID cannot contain "${word}" — the networks reject names that look like a telco. Use your business name instead.`,
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
