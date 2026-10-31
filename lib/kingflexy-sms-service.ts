/**
 * KingFlexy SMS v2 — the sending provider behind Customer SMS.
 *
 * Authenticates with the SMS key (KINGFLEXY_SMS_KEY, kf_sms_live_), which is a
 * DIFFERENT key from KINGFLEXY_COMMISSION_KEY (kf_cs_live_, bills and airtime)
 * and from KINGFLEXY_API_KEY (kf_live_, v1 data). Their docs return 403 for the
 * wrong key type, which reads like an outage unless you know to check.
 *
 * Two things make this worth a dedicated module rather than another arm in
 * lib/sms-service.ts:
 *
 *  - It sends in BULK. One call carries up to 10,000 recipients, where Moolre
 *    and Hubtel are one call per person. A 5,000-customer campaign becomes a
 *    handful of requests instead of five thousand.
 *  - It reports per-recipient delivery, which neither of the others do, so a
 *    campaign can finally say who actually received the message.
 *
 * The retry/deadline/breaker shape is copied from lib/kingflexy-airtime-service.ts,
 * which already solved the stalled-supplier problem for this same host.
 */

const KF_SMS_KEY = process.env.KINGFLEXY_SMS_KEY || ''
const KF_V2_URL = process.env.KINGFLEXY_API_V2_URL || 'https://api.kingflexygh.com/api/v2'

/** Their documented ceiling for a single call. */
export const KF_MAX_RECIPIENTS_PER_CALL = 10_000

/** At or below this they dispatch inline and the response carries real counts. */
export const KF_INLINE_RECIPIENTS = 500

// ─── Circuit Breaker ─────────────────────────────────────────────────────────
// Separate from the airtime and utility breakers: SMS failing must not stop
// bills going out, and vice versa.
let circuitState: 'closed' | 'open' | 'half-open' = 'closed'
let failureCount = 0
let lastFailureTime: number | null = null
const FAILURE_THRESHOLD = 5
const RECOVERY_TIMEOUT = 60_000

function checkCircuit(): boolean {
    if (circuitState === 'closed') return true
    if (circuitState === 'open') {
        if (lastFailureTime && Date.now() - lastFailureTime > RECOVERY_TIMEOUT) {
            circuitState = 'half-open'
            return true
        }
        return false
    }
    return true
}

function recordSuccess() {
    failureCount = 0
    circuitState = 'closed'
}

function recordFailure() {
    failureCount++
    lastFailureTime = Date.now()
    if (failureCount >= FAILURE_THRESHOLD) {
        circuitState = 'open'
        console.log('[KingFlexySMS] Circuit breaker OPENED')
    }
}

/**
 * Whether this deployment can send through KingFlexy at all.
 *
 * Customer SMS keys off this rather than the global gateway toggle: a shop
 * sends under its OWN sender ID, and Moolre rejects any sender not registered
 * on the platform's Moolre account (ASMS07), so per-shop senders can only ever
 * work here.
 */
export function isKingFlexySmsConfigured(): boolean {
    return KF_SMS_KEY.startsWith('kf_sms_live_')
}

interface KfResponse {
    ok: boolean
    status: number
    data: any
    transportError?: string
}

/**
 * One HTTP call with a whole-call budget across retries.
 *
 * Retries cover TRANSPORT failures only. A 400 (bad sender), 402 (out of
 * credits) or 403 (wrong key) is an answer, and repeating it just burns the
 * rate limit that 429 is already warning about.
 */
async function kfRequest(
    method: 'GET' | 'POST',
    path: string,
    body?: any,
    budgetMs = 30_000
): Promise<KfResponse> {
    const deadline = Date.now() + budgetMs
    const maxAttempts = 3
    let lastError: Error | null = null

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const res = await fetch(`${KF_V2_URL}${path}`, {
                method,
                headers: {
                    Accept: 'application/json',
                    // No "Bearer" prefix — their API takes the raw key.
                    Authorization: KF_SMS_KEY,
                    ...(body ? { 'Content-Type': 'application/json' } : {}),
                },
                ...(body ? { body: JSON.stringify(body) } : {}),
                // Without this a provider that accepts the connection and then
                // stalls leaves fetch pending forever and the retry never runs.
                signal: AbortSignal.timeout(Math.max(2_000, deadline - Date.now())),
            })

            const raw = await res.text()
            let data: any = null
            try {
                data = raw ? JSON.parse(raw) : null
            } catch {
                console.error(`[KingFlexySMS] Non-JSON response (HTTP ${res.status}):`, raw.slice(0, 300))
                if (res.status >= 500) recordFailure()
                return { ok: false, status: res.status, data: null, transportError: `Unexpected response format (HTTP ${res.status})` }
            }

            if (res.status >= 500) {
                recordFailure()
                if (attempt < maxAttempts && Date.now() < deadline) {
                    await new Promise(r => setTimeout(r, 2000 * attempt))
                    continue
                }
            } else {
                recordSuccess()
            }

            return { ok: res.ok, status: res.status, data }
        } catch (err: any) {
            lastError = err
            console.error(`[KingFlexySMS] ${method} ${path} attempt ${attempt} failed:`, err?.message)
            if (Date.now() >= deadline) break
            if (attempt < maxAttempts) await new Promise(r => setTimeout(r, 2000 * attempt))
        }
    }

    recordFailure()
    return { ok: false, status: 0, data: null, transportError: lastError?.message || 'Could not reach KingFlexy' }
}

/**
 * Catches the configuration mistakes that look like provider outages.
 *
 * The precise reason is logged, never returned: the caller shows this to a shop
 * owner, and "KINGFLEXY_SMS_KEY is not configured" means nothing to them.
 */
function configError(): string | null {
    if (!KF_SMS_KEY) {
        console.error('[KingFlexySMS] KINGFLEXY_SMS_KEY is not configured.')
        return 'SMS sending is not available right now'
    }
    if (!KF_SMS_KEY.startsWith('kf_sms_live_')) {
        console.error('[KingFlexySMS] KINGFLEXY_SMS_KEY does not look like an SMS key (expected the kf_sms_live_ prefix). The commission and data keys are rejected with 403 here.')
        return 'SMS sending is not available right now'
    }
    if (!checkCircuit()) {
        console.error('[KingFlexySMS] Circuit breaker is open; refusing to call.')
        return 'SMS provider is temporarily unavailable'
    }
    return null
}

// ─── Sender spelling ─────────────────────────────────────────────────────────
// KingFlexy matches the sender EXACTLY, and the networks register names
// without spaces: a shop that asked for "AMINEX HUB" is live there as
// "AMINEXHUB", and sending the spaced form comes back 400 "Sender ID is not
// approved for your account" for every recipient. So the name we hold is
// translated to KingFlexy's own spelling before each send.
const SENDERS_TTL_MS = 5 * 60_000
let registeredSendersCache: { at: number; senders: string[] } | null = null

function senderKey(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9]/g, '')
}

async function resolveKingFlexySender(sender: string): Promise<string> {
    if (!registeredSendersCache || Date.now() - registeredSendersCache.at > SENDERS_TTL_MS) {
        const list = await fetchKingFlexySenders()
        // A failed lookup is not cached, and the send goes out as stored.
        if (list.ok) registeredSendersCache = { at: Date.now(), senders: list.senders.map(s => s.sender) }
    }
    const registered = registeredSendersCache?.senders ?? []
    if (registered.includes(sender)) return sender

    const key = senderKey(sender)
    return registered.find(s => senderKey(s) === key) ?? sender
}

export interface KfBulkResult {
    ok: boolean
    /** Their campaign id — our handle for delivery reports later. */
    campaignId?: string
    status?: string
    sent: number
    failed: number
    /** Their remaining credit balance, for the platform's own monitoring. */
    balance?: number
    error?: string
    /** True on 402: the PLATFORM's KingFlexy credits are exhausted, not the shop's. */
    outOfCredits?: boolean
}

/**
 * Sends one message to many recipients in a single call.
 *
 * `reference` is their idempotency key: the same value returns the original
 * campaign instead of sending twice. We pass our own campaign id plus the batch
 * offset, so a retried tick cannot double-send or double-charge.
 */
export async function sendKingFlexyBulkSMS(params: {
    message: string
    recipients: string[]
    sender?: string
    reference?: string
}): Promise<KfBulkResult> {
    const configIssue = configError()
    if (configIssue) return { ok: false, sent: 0, failed: params.recipients.length, error: configIssue }

    if (!params.recipients.length) return { ok: true, sent: 0, failed: 0 }
    if (params.recipients.length > KF_MAX_RECIPIENTS_PER_CALL) {
        return { ok: false, sent: 0, failed: params.recipients.length, error: `A single call carries at most ${KF_MAX_RECIPIENTS_PER_CALL} recipients` }
    }

    const sender = params.sender ? await resolveKingFlexySender(params.sender) : undefined

    const res = await kfRequest('POST', '/sms/send', {
        message: params.message,
        recipients: params.recipients,
        ...(sender ? { sender } : {}),
        ...(params.reference ? { reference: params.reference } : {}),
    })

    if (!res.ok) {
        const message = res.data?.error || res.data?.message || res.transportError || 'Send failed'

        // 402 is the platform's own KingFlexy balance, NOT the shop's credits.
        // The shop already paid us; the caller must not bill them for our
        // supplier running dry, so it is reported separately.
        if (res.status === 402) {
            console.error('[KingFlexySMS] PLATFORM OUT OF CREDITS at KingFlexy — top up at kingflexygh.com/dashboard/sms/credits')
            return { ok: false, sent: 0, failed: params.recipients.length, error: message, outOfCredits: true }
        }
        if (res.status === 400) {
            // Nearly always the sender ID: it must be registered on OUR
            // KingFlexy account, not merely approved in our own admin.
            console.error('[KingFlexySMS] Rejected (400):', message, '— sender:', sender, sender !== params.sender ? `(stored as "${params.sender}")` : '')
            // A name registered since the list was cached should not wait out the TTL.
            registeredSendersCache = null
        }
        if (res.status === 403) {
            console.error('[KingFlexySMS] 403 — wrong key type or account suspended at KingFlexy.')
        }

        return { ok: false, sent: 0, failed: params.recipients.length, error: message }
    }

    const data = res.data?.data ?? res.data ?? {}
    // A queued campaign reports no counts yet; treat the whole batch as away,
    // since their queue owns it now and the delivery report will correct us.
    const queued = data.status === 'queued' || data.status === 'processing'

    return {
        ok: true,
        campaignId: data.campaignId,
        status: data.status,
        sent: queued ? params.recipients.length : Number(data.sent ?? params.recipients.length),
        failed: queued ? 0 : Number(data.failed ?? 0),
        balance: typeof data.balance === 'number' ? data.balance : undefined,
    }
}

/**
 * Single-recipient send, for the platform's own transactional notifications.
 *
 * Just the bulk call with a list of one — their API has no separate endpoint,
 * and this keeps lib/sms-service.ts's provider arms identical in shape.
 */
export async function sendKingFlexySMS(options: {
    recipient: string
    message: string
    sender?: string
}): Promise<{ success: boolean; messageId?: string; error?: string }> {
    const result = await sendKingFlexyBulkSMS({
        message: options.message,
        recipients: [options.recipient],
        sender: options.sender,
    })

    if (!result.ok || result.failed > 0) {
        return { success: false, error: result.error || 'Send failed' }
    }
    return { success: true, messageId: result.campaignId }
}

export type KfMessageStatus = 'queued' | 'sent' | 'delivered' | 'undelivered' | 'failed' | 'expired' | 'rejected'

/**
 * Per-recipient delivery for one of THEIR campaigns, walked to the end.
 *
 * Returned as a map keyed by the 233… number, which is the same form our own
 * sms_messages.recipient is stored in, so callers can match without juggling
 * phone formats.
 */
export async function fetchKingFlexyDeliveryStatuses(
    campaignId: string,
    maxPages = 100
): Promise<Map<string, KfMessageStatus>> {
    const statuses = new Map<string, KfMessageStatus>()
    if (configError()) return statuses

    for (let page = 0; page < maxPages; page++) {
        const res = await kfRequest('GET', `/sms/messages/${encodeURIComponent(campaignId)}?page=${page}`, undefined, 15_000)
        if (!res.ok) {
            console.error('[KingFlexySMS] Delivery fetch failed for', campaignId, res.data?.error || res.transportError)
            break
        }

        const rows = (res.data?.data?.messages ?? res.data?.messages ?? []) as any[]
        for (const row of rows) {
            if (row?.recipient) statuses.set(String(row.recipient), row.status as KfMessageStatus)
        }

        // Their page size is 100; a short page is the last one.
        if (rows.length < 100) break
    }

    return statuses
}

/**
 * Sender IDs this platform account may send under, straight from KingFlexy.
 *
 * A shop's sender ID approved in OUR admin still bounces with a 400 unless it
 * is also registered here, so admin checks this list before approving.
 */
export async function fetchKingFlexySenders(): Promise<{ ok: boolean; senders: { sender: string; type: string; isDefault: boolean }[]; defaultSender?: string; error?: string }> {
    const configIssue = configError()
    if (configIssue) return { ok: false, senders: [], error: configIssue }

    const res = await kfRequest('GET', '/sms/senders', undefined, 15_000)
    if (!res.ok) {
        return { ok: false, senders: [], error: res.data?.error || res.transportError || 'Could not read sender IDs' }
    }

    const data = res.data?.data ?? res.data ?? {}
    return {
        ok: true,
        senders: (data.senders || []) as { sender: string; type: string; isDefault: boolean }[],
        defaultSender: data.defaultSender,
    }
}

/** The platform's remaining KingFlexy SMS credits — what every shop send spends. */
export async function fetchKingFlexyBalance(): Promise<{ ok: boolean; credits?: number; accountStatus?: string; error?: string }> {
    const configIssue = configError()
    if (configIssue) return { ok: false, error: configIssue }

    const res = await kfRequest('GET', '/sms/balance', undefined, 15_000)
    if (!res.ok) {
        return { ok: false, error: res.data?.error || res.transportError || 'Could not read balance' }
    }

    const data = res.data?.data ?? res.data ?? {}
    return { ok: true, credits: Number(data.credits ?? 0), accountStatus: data.accountStatus }
}
