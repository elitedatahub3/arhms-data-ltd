/**
 * Personal greetings for admin SMS broadcasts: "Hi Derrick! BIG NEWS - ...".
 *
 * A broadcast message may carry a {name} placeholder; each recipient's copy has
 * it swapped for their own first name. Pure and dependency-free so the admin
 * page can render the same preview the processor sends.
 */

export const NAME_TOKEN = '{name}'
export const GREETING_PREFIX = `Hi ${NAME_TOKEN}! `
/** Used when a recipient has no usable name, so the text reads "Hi there!". */
export const FALLBACK_NAME = 'there'

/** Drops accents ("É" -> "E") first, then anything still outside printable ASCII. */
function toAscii(raw: string | null | undefined): string {
    return String(raw ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\x20-\x7E]/g, '')
}

/**
 * First word of a name, title-cased and ASCII-only ("derrick kofi" -> "Derrick").
 * ASCII-only because some gateways (Hubtel) choke on anything else.
 */
export function greetName(raw: string | null | undefined): string {
    const ascii = toAscii(raw).trim()
    const first = ascii.split(/\s+/)[0] || ''
    if (!/[A-Za-z0-9]/.test(first)) return FALLBACK_NAME
    return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase()
}

/** Whole shop name kept as written, ASCII-only — "Hi Kofi Data Hub!". */
export function greetShopName(raw: string | null | undefined): string {
    const ascii = toAscii(raw).replace(/\s+/g, ' ').trim()
    return /[A-Za-z0-9]/.test(ascii) ? ascii : FALLBACK_NAME
}

export function hasNameToken(message: string): boolean {
    return message.includes(NAME_TOKEN)
}

/**
 * The message a recipient receives. Jobs queued before greet_name existed fall
 * back to their first_name.
 */
export function renderBroadcast(
    message: string,
    recipient: { greet_name?: string | null; first_name?: string | null }
): string {
    if (!hasNameToken(message)) return message
    const name = recipient.greet_name || greetName(recipient.first_name)
    return message.split(NAME_TOKEN).join(name)
}
