/**
 * Tells an API partner their order reached a terminal state.
 *
 * Commission orders settle asynchronously — Hubtel may answer immediately, or minutes
 * later via a callback, or not at all until the reconciliation cron sweeps. Without
 * this a partner has to poll GET /api/v2/orders/:reference on every order they ever
 * placed, which is both slow for them and expensive for us.
 *
 * Fired from the same completion hook as the commission credit, so it cannot fire for
 * an order that did not actually finish.
 */
import { createHmac, timingSafeEqual } from 'crypto'
import { waitUntil } from '@vercel/functions'
import { createServerClient } from '@/lib/supabase'

type Supabase = ReturnType<typeof createServerClient>

const TIMEOUT_MS = 8_000
const ATTEMPTS = 3

export interface WebhookPayload {
    event: string
    reference: string
    order_id: string
    status: string
    [key: string]: any
}

/**
 * Signature over the exact bytes sent, so a receiver can verify without re-serialising
 * — key order and whitespace would otherwise have to match ours exactly.
 */
export function signWebhookBody(body: string, secret: string): string {
    return `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`
}

/** For a partner's own use, and for our tests. Constant-time by construction. */
export function verifyWebhookSignature(body: string, secret: string, header: string): boolean {
    const expected = Buffer.from(signWebhookBody(body, secret))
    const actual = Buffer.from(String(header || ''))
    if (expected.length !== actual.length) return false
    return timingSafeEqual(expected, actual)
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Never throws. A partner's endpoint being down is their problem to notice, not a
 * reason to fail an order that already settled.
 */
export async function deliverApiWebhook(params: {
    apiKeyId: string | null | undefined
    payload: WebhookPayload
    supabase?: Supabase
}): Promise<void> {
    const { apiKeyId, payload } = params
    if (!apiKeyId) return

    const supabase = (params.supabase || createServerClient()) as any

    try {
        const { data: key } = await supabase
            .from('api_keys')
            .select('webhook_url, webhook_secret')
            .eq('id', apiKeyId)
            .maybeSingle()

        if (!key?.webhook_url || !key?.webhook_secret) return

        const body = JSON.stringify({ ...payload, sent_at: new Date().toISOString() })
        const signature = signWebhookBody(body, key.webhook_secret)

        for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
            // A fresh controller per attempt: an AbortSignal that has already fired
            // stays aborted, so reusing one would make every retry fail instantly.
            const controller = new AbortController()
            const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

            try {
                const response = await fetch(key.webhook_url, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Arhms-Signature': signature,
                        'X-Arhms-Event': payload.event,
                    },
                    body,
                    signal: controller.signal,
                })

                if (response.ok) return

                // 4xx is the partner rejecting the payload — retrying an argument we
                // will keep losing just burns their rate limit. 5xx and timeouts are
                // worth another go.
                if (response.status >= 400 && response.status < 500) {
                    console.error(`[ApiWebhook] ${payload.reference}: endpoint returned ${response.status}, not retrying.`)
                    return
                }

                console.error(`[ApiWebhook] ${payload.reference}: attempt ${attempt} returned ${response.status}.`)
            } catch (e: any) {
                console.error(`[ApiWebhook] ${payload.reference}: attempt ${attempt} failed —`, e?.message || e)
            } finally {
                clearTimeout(timer)
            }

            if (attempt < ATTEMPTS) await sleep(500 * 2 ** (attempt - 1))
        }

        console.error(`[ApiWebhook] ${payload.reference}: gave up after ${ATTEMPTS} attempts.`)
    } catch (e) {
        console.error('[ApiWebhook] Unexpected error:', e)
    }
}

/**
 * Hands delivery to the platform so the caller returns immediately.
 *
 * Three attempts with backoff can run to ~25 seconds, and the biggest caller is the
 * Hubtel callback handler: awaiting it there would risk Hubtel timing out and
 * redelivering the callback, turning one settlement into several. waitUntil keeps the
 * function alive for the work without holding the response.
 *
 * Outside a request context waitUntil throws, so the fallback awaits instead — which
 * is correct for a script or a test, where nothing is waiting on latency anyway.
 */
export async function queueApiWebhook(params: {
    apiKeyId: string | null | undefined
    payload: WebhookPayload
    supabase?: Supabase
}): Promise<void> {
    if (!params.apiKeyId) return

    try {
        waitUntil(deliverApiWebhook(params))
    } catch {
        await deliverApiWebhook(params)
    }
}
