/**
 * Hubtel Programmable SMS Service
 *
 * Sends SMS messages via the Hubtel SMS API.
 * API Docs: https://developers.hubtel.com/docs/business/api_documentation/messaging_apis/programmable_sms
 *
 * Endpoint: POST https://sms.hubtel.com/v1/messages/send
 * Auth:     Basic Auth (base64(HUBTEL_CLIENT_ID:HUBTEL_CLIENT_SECRET))
 *
 * NOTE: Uses the same HUBTEL_CLIENT_ID and HUBTEL_CLIENT_SECRET as the payment service.
 * NOTE: Does NOT require IP whitelisting — no proxy needed (unlike the payment API).
 * NOTE: SMS credits are funded separately from the MoMo collection account.
 *
 * Response status codes (HTTP 201, body.status field):
 *   0   = request submitted successfully
 *   1   = invalid destination address
 *   2   = invalid source address (Sender ID issue)
 *   12  = payment required — fund your SMS account
 */

export interface HubtelSMSResult {
    success: boolean
    messageId?: string
    error?: string
}

// Auth is passed via query params per the user's Hubtel dashboard
// const HUBTEL_SMS_URL = 'https://sms.hubtel.com/v1/messages/send'

/**
 * Normalizes a Ghana phone number to the format expected by the Hubtel SMS API.
 * Input:  0XXXXXXXXX or +233XXXXXXXXX or 233XXXXXXXXX
 * Output: 233XXXXXXXXX (no + prefix)
 */
function normalizeGhanaPhoneForHubtel(phone: string): string | null {
    let p = phone.replace(/\s+/g, '').replace(/-/g, '').replace(/\+/g, '')
    if (p.startsWith('0') && p.length === 10) {
        p = '233' + p.slice(1)
    }
    if (!p.startsWith('233') || p.length !== 12) {
        return null
    }
    return p
}

/**
 * Sends a single SMS via the Hubtel Programmable SMS API.
 * On success, returns { success: true, messageId: '...' }.
 * On failure, returns { success: false, error: '...' }.
 */
export async function sendHubtelSMS(options: {
    recipient: string
    message: string
    /**
     * Per-send sender ID. Customer SMS sends under the shop's own approved
     * brand name; without this the message would silently go out as ARHMS and
     * the shop owner would have paid for someone else's branding.
     */
    sender?: string
}): Promise<HubtelSMSResult> {
    const senderId = (options.sender || process.env.HUBTEL_SMS_SENDER_ID || 'ARHMS').trim()

    const clientId = process.env.HUBTEL_SMS_CLIENT_ID || process.env.HUBTEL_CLIENT_ID
    const clientSecret = process.env.HUBTEL_SMS_CLIENT_SECRET || process.env.HUBTEL_CLIENT_SECRET

    if (!clientId || !clientSecret) {
        const msg = '[HubtelSMS] HUBTEL_SMS_CLIENT_ID or HUBTEL_SMS_CLIENT_SECRET is not configured.'
        console.error(msg)
        return { success: false, error: msg }
    }

    const recipient = normalizeGhanaPhoneForHubtel(options.recipient)
    if (!recipient) {
        console.error('[HubtelSMS] Invalid phone number:', options.recipient)
        return { success: false, error: 'Invalid phone number format. Use 0XXXXXXXXX or 233XXXXXXXXX' }
    }

    console.log(`[HubtelSMS] Sending to: ${recipient} via Hubtel (using ClientID: ${clientId.substring(0,4)}...)`)

    try {
        const url = new URL('https://sms.hubtel.com/v1/messages/send')
        url.searchParams.append('clientid', clientId)
        url.searchParams.append('clientsecret', clientSecret)
        url.searchParams.append('from', senderId)
        url.searchParams.append('to', recipient)
        url.searchParams.append('content', options.message)

        const response = await fetch(url.toString(), {
            method: 'GET',
            headers: {
                Accept: 'application/json',
            },
        })

        const text = await response.text()
        let data: any

        try {
            data = JSON.parse(text)
        } catch {
            console.error('[HubtelSMS] Non-JSON response (HTTP', response.status, '):', text.substring(0, 200))
            return { success: false, error: `Hubtel SMS API returned an invalid response (HTTP ${response.status})` }
        }

        console.log('[HubtelSMS] Response:', response.status, JSON.stringify(data))

        // HTTP 200 or 201 with body.status === 0 = success
        if ((response.status === 200 || response.status === 201) && data.status === 0) {
            return {
                success: true,
                messageId: data.messageId || 'sent',
            }
        }

        // Known error status codes from Hubtel SMS API
        const errorDescriptions: Record<number, string> = {
            1: 'Invalid destination address (bad recipient number)',
            2: 'Invalid source address (Sender ID issue — check HUBTEL_SMS_SENDER_ID)',
            3: 'Message body too long',
            4: 'Message not routable on Hubtel gateway',
            5: 'Invalid delivery time specified',
            6: 'Message content rejected or invalid',
            12: 'Payment required — please fund your Hubtel SMS API account',
        }

        const description = errorDescriptions[data.status]
            ?? data.statusDescription
            ?? `Unknown error (status ${data.status})`

        console.error('[HubtelSMS] Failed:', data.status, description)
        return { success: false, error: description }

    } catch (err: any) {
        console.error('[HubtelSMS] Network exception:', err.message)
        return { success: false, error: err.message }
    }
}
