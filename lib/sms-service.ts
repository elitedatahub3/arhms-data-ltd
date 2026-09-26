import { createServerClient } from '@/lib/supabase'
import { sendHubtelSMS } from '@/lib/hubtel-sms-service'

// ============================================================
// Moolre SMS Service — https://api.moolre.com
// Auth:    X-API-VASKEY header
// Payload: { type, senderid, messages: [{ recipient, message, ref }] }
// ============================================================

interface SMSOptions {
    recipient: string
    message: string
    sender?: string
}

interface SMSResult {
    success: boolean
    messageId?: string
    error?: string
}

const MOOLRE_URL = 'https://api.moolre.com/open/sms/send'

function normalizeGhanaPhone(phone: string): string | null {
    let p = phone.replace(/\s+/g, '').replace(/-/g, '').replace(/\+/g, '')
    if (p.startsWith('0') && p.length === 10) p = '233' + p.slice(1)
    if (!p.startsWith('233') || p.length !== 12) return null
    return p
}

// ============================================================
// CORE SEND FUNCTION
// ============================================================

export async function sendSMS(options: SMSOptions): Promise<SMSResult> {
    if (process.env.SMS_ENABLED === 'false') {
        return { success: true, messageId: 'sms_disabled' }
    }

    // Determine active provider from admin_settings (falls back to 'moolre')
    const provider = await getActiveSmsProvider()

    if (provider === 'hubtel') {
        return sendHubtelSMS(options)
    }

    return sendMoolreSMS(options)
}

// ============================================================
// PROVIDER ROUTING HELPER
// ============================================================

/**
 * Reads the active SMS provider from the admin_settings table.
 * Returns 'hubtel' | 'moolre'. Defaults to 'moolre' on any error.
 */
async function getActiveSmsProvider(): Promise<'hubtel' | 'moolre'> {
    try {
        const supabase = createServerClient()
        const { data } = await supabase
            .from('admin_settings')
            .select('value')
            .eq('key', 'active_sms_provider')
            .single()
        if (data && (data as any).value === 'hubtel') return 'hubtel'
    } catch {
        // Silently fall back to moolre on DB error
    }
    return 'moolre'
}

// ============================================================
// MOOLRE SEND (internal)
// ============================================================

async function sendMoolreSMS(options: SMSOptions): Promise<SMSResult> {
    const apiKey = process.env.MOOLRE_API_KEY
    const senderId = (process.env.MOOLRE_SENDER_ID || 'ArhmsTech').trim()

    if (!apiKey || apiKey.trim() === '') {
        console.error('[SMS] MOOLRE_API_KEY not set')
        return { success: false, error: 'MOOLRE_API_KEY not configured' }
    }

    const recipient = normalizeGhanaPhone(options.recipient)
    if (!recipient) {
        console.error('[SMS] Invalid phone number:', options.recipient)
        return { success: false, error: 'Invalid phone number format. Use 0XXXXXXXXX or 233XXXXXXXXX' }
    }

    const payload = {
        type: 1,
        senderid: options.sender || senderId,
        messages: [
            {
                recipient,
                message: options.message,
                ref: `ref_${Date.now()}`,
            }
        ]
    }

    console.log('[SMS] Sending to:', recipient)

    try {
        const response = await fetch(MOOLRE_URL, {
            method: 'POST',
            headers: {
                'X-API-VASKEY': apiKey,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
        })

        const text = await response.text()
        let data: any

        try {
            data = JSON.parse(text)
        } catch {
            console.error('[SMS] Non-JSON response:', text.substring(0, 200))
            return { success: false, error: 'Invalid response from Moolre' }
        }

        console.log('[SMS] Moolre response:', response.status, JSON.stringify(data))

        if (data.status === 1 || data.code === 'SMS01') {
            return { success: true, messageId: data.data?.id || data.reference || 'sent' }
        }

        console.error('[SMS] Failed:', data.code, data.message)
        return { success: false, error: `${data.code}: ${data.message}` }

    } catch (err: any) {
        console.error('[SMS] Exception:', err.message)
        return { success: false, error: err.message }
    }
}

// ============================================================
// SPECIFIC SMS TEMPLATES
// ============================================================

export async function sendStatusUpdateSMS(
    phoneNumber: string,
    details: { referenceCode: string; status: string }
) {
    return { success: true, messageId: 'disabled', error: undefined }
}

export async function sendWalletTopupSuccessSMS(
    phoneNumber: string,
    details: { amount: number; newBalance: number }
) {
    return sendSMS({
        recipient: phoneNumber,
        message: `Hello! You have added GH${details.amount.toFixed(2)} to your Flexy-Wallet. Your Flexy-Wallet is now GH${details.newBalance.toFixed(2)}\n\nARHMSGh`,
    })
}

export async function sendWelcomeSMS(phoneNumber: string, firstName: string) {
    return { success: true, messageId: 'disabled', error: undefined }
}

export async function sendDealerUpgradeSuccessSMS(
    phoneNumber: string,
    firstName: string,
    expiryDate: string
) {
    const date = new Date(expiryDate)
    const day = date.getDate()
    const month = date.toLocaleString('default', { month: 'long' })
    const year = date.getFullYear()
    const suffix = ['th', 'st', 'nd', 'rd'][((day % 100) > 10 && (day % 100) < 20) ? 0 : (day % 10 < 4) ? day % 10 : 0]

    return sendSMS({
        recipient: phoneNumber,
        message: `Congratulations ${firstName}! You have been upgraded to Dealer on ARHMSGh. You now enjoy exclusive Dealer prices valid until ${month} ${day}${suffix}, ${year}. Login to start selling!\n\nARHMSGh`,
    })
}

export async function sendAgentUpgradeSuccessSMS(
    phoneNumber: string,
    firstName: string,
    planDays: string,
    remainingDays: number,
    expiryDate: string
) {
    return sendSMS({
        recipient: phoneNumber,
        message: `Congratulation ${firstName}! Your Agent membership has been activated for ${planDays}. You now have access to our cheapest Agent prices. Login to enjoy!\n\nARHMSGh`,
    })
}

export async function sendPermanentAgentUpgradeSuccessSMS(phoneNumber: string) {
    return sendSMS({
        recipient: phoneNumber,
        message: `Congratulations! Your Agent membership is now PERMANENT. You have lifetime access to premium agent benefits. Thank you for choosing ARHMSGh.`,
    })
}

export async function sendAgentExtensionSuccessSMS(
    phoneNumber: string,
    expiryDate: string | Date
) {
    const date = new Date(expiryDate)
    const day = date.getDate()
    const month = date.toLocaleString('default', { month: 'long' })
    const year = date.getFullYear()
    const suffix = ['th', 'st', 'nd', 'rd'][((day % 100) > 10 && (day % 100) < 20) ? 0 : (day % 10 < 4) ? day % 10 : 0]

    return sendSMS({
        recipient: phoneNumber,
        message: `Congratulations! Your Agent membership has been extended until ${month} ${day}${suffix}, ${year}\n\nARHMSGh`,
    })
}

export async function sendAdminAgentOrderAlert() {
    return { success: true, messageId: 'disabled', error: undefined }
}

export async function sendAgentRenewalReminderSMS(phoneNumber: string, firstName: string) {
    return { success: true, messageId: 'disabled', error: undefined }
}

export async function sendAgentExpiryNotificationSMS(phoneNumber: string, firstName: string) {
    return sendSMS({
        recipient: phoneNumber,
        message: `Dear valued customer, your Agent membership has expired. You can renew your subscription anytime to continue enjoying agent benefits thank you.\n\nARHMSGh`,
    })
}

export async function sendOrderRefundSMS(
    phoneNumber: string,
    recipientNumber: string,
    refundAmount: number,
    newBalance: number
) {
    const displayNumber = recipientNumber.replace(/^233/, '0')

    return sendSMS({
        recipient: phoneNumber,
        message: `Your order for ${displayNumber} has been refunded. Refund: GH${refundAmount.toFixed(2)}. New Flexy-wallet balance: GH${newBalance.toFixed(2)} thank you.\n\nARHMSGh`,
    })
}

// Sent ONCE at order time when an MTN number must be verified/enabled first
// (Agent Portal whitelist gate). The order stays pending and auto-delivers after
// verification (up to 2 weeks). Do NOT call this from the retry cron — it would spam the
// customer every few minutes. No delivery time is quoted — we cannot promise one.
export async function sendMtnVerificationPendingSMS(
    recipientNumber: string,
    details: { network: string; size: string }
) {
    const displayNumber = recipientNumber.replace(/^233/, '0')

    return sendSMS({
        recipient: recipientNumber,
        message: `Your ${details.network} number ${displayNumber} is being registered for the first time. This can take up to 2 weeks, after which your ${details.size} data will be delivered automatically. Thank you.\n\nARHMSGh`,
    })
}

// Sent ONCE at order time for MTN orders that were handed to a supplier. Tells the
// recipient the order is on its way without quoting a delivery time — MTN bundles are
// not instant and we cannot guarantee a window. Do NOT call this from the retry cron
// — it would spam the customer.
export async function sendMtnOrderReceivedSMS(
    recipientNumber: string,
    details: { network: string; size: string }
) {
    const displayNumber = recipientNumber.replace(/^233/, '0')

    return sendSMS({
        recipient: recipientNumber,
        message: `Your ${details.network} ${details.size} data order for ${displayNumber} has been received and is being processed. Thank you.\n\nARHMSGh`,
    })
}

// Sent ONCE at order time for AirtelTigo orders (no verification gate — they
// deliver quickly). Reassures the recipient that delivery is instant.
export async function sendAtInstantDeliverySMS(
    recipientNumber: string,
    details: { network: string; size: string }
) {
    const displayNumber = recipientNumber.replace(/^233/, '0')

    return sendSMS({
        recipient: recipientNumber,
        message: `Your ${details.network} ${details.size} data order for ${displayNumber} has been received and will be delivered instantly. Thank you.\n\nARHMSGh`,
    })
}

export async function sendOrderFailedSMS(
    phoneNumber: string,
    recipientNumber: string,
    details: { network: string; size: string }
) {
    const displayNumber = recipientNumber.replace(/^233/, '0')

    return sendSMS({
        recipient: phoneNumber,
        message: `Your ${details.network} ${details.size} order for ${displayNumber} could not be completed and has been marked failed. Please contact support for assistance.\n\nARHMSGh`,
    })
}

// ============================================================
// SHOP ALERT SMS
// ============================================================

export async function sendShopPricingApprovedSMS(phoneNumber: string, firstName: string) {
    return sendSMS({
        recipient: phoneNumber,
        message: `${firstName} Great news! Your shop pricing has been approved. Your prices are now live. Visit ARHMSgh.com/dashboard/shop\n\nARHMSGh`,
    })
}

export async function sendShopPricingRejectedSMS(phoneNumber: string, firstName: string, reason: string) {
    return sendSMS({
        recipient: phoneNumber,
        message: `${firstName} Your shop pricing was not approved. Reason: ${reason}. Please log in and resubmit.\n\nARHMSGh`,
    })
}

export async function sendShopProfileApprovedSMS(phoneNumber: string, shopName: string) {
    return sendSMS({
        recipient: phoneNumber,
        message: `Congrats! Your shop "${shopName}" has been approved. You can now set your prices and go live. ARHMSgh.com\n\nARHMSGh`,
    })
}

export async function sendShopProfileRejectedSMS(phoneNumber: string, firstName: string, reason: string) {
    return sendSMS({
        recipient: phoneNumber,
        message: `${firstName} Your shop application was not approved. Reason: ${reason}. Log in to update your profile. ARHMSgh.com\n\nARHMSGh`,
    })
}

export async function sendUssdActivationSMS(
    phoneNumber: string,
    shortCode: string,
    dialCode: string
) {
    return sendSMS({
        recipient: phoneNumber,
        message: `Your USSD short code is ${shortCode}. Customers with no internet can dial ${dialCode} and enter ${shortCode} to buy from your shop.\n\nARHMSGh`,
    })
}

export async function sendShopWithdrawalProcessedSMS(
    phoneNumber: string,
    firstName: string,
    netAmount: number,
    network: string,
    momoNumber: string
) {
    return sendSMS({
        recipient: phoneNumber,
        message: `${firstName} Your Net Payout of GH${netAmount.toFixed(2)} has been successfully sent to your ${network} number ${momoNumber}. Thank you for selling with ARHMSGh.`,
    })
}

export async function sendShopWithdrawalRejectedSMS(phoneNumber: string, firstName: string) {
    return sendSMS({
        recipient: phoneNumber,
        message: `${firstName} Your withdrawal request was rejected. Please log in to your dashboard to update your payment details and resubmit. ARHMSGh`,
    })
}

// ============================================================
// AIRTIME SMS
// ============================================================

export async function sendAirtimeBeneficiarySMS(
    beneficiaryPhone: string,
    airtimeAmount: number
): Promise<SMSResult> {
    return sendSMS({
        recipient: beneficiaryPhone,
        message: `Your order for GH ${airtimeAmount.toFixed(2)} airtime has been received and is being processed. You will receive the confirmation sms very soon.\n\nARHMSGh`,
    })
}

export async function sendAdminAirtimeAlertSMS(
    adminPhones: string[],
    details: {
        source: string
        receiver: string
        amount: number | string
        network: string
        orderType?: 'airtime' | 'mashup'
        bundlePreference?: 'balanced' | 'data' | 'voice'
    }
): Promise<void> {
    const amount = typeof details.amount === 'string' ? parseFloat(details.amount) : details.amount
    const isMashup = details.orderType === 'mashup'
    const prefCode = isMashup && details.bundlePreference
        ? ({ balanced: 'B', data: 'D', voice: 'V' })[details.bundlePreference] || 'B'
        : null

    const message = isMashup
        ? `NEW MASHUP ORDER:\nSource: ${details.source}\nReceiver: ${details.receiver}\nAmount: GH ${amount.toFixed(2)}\nNetwork: ${details.network}\nPref: ${prefCode} Focus`
        : `NEW AIRTIME ORDER:\nSource: ${details.source}\nReceiver: ${details.receiver}\nAmount: GH ${amount.toFixed(2)}\nNetwork: ${details.network}`

    await Promise.allSettled(adminPhones.map(phone => sendSMS({ recipient: phone, message })))
}

export async function sendAirtimeCompletedSMS(beneficiaryPhone: string, amount: number): Promise<void> {
    await sendSMS({
        recipient: beneficiaryPhone,
        message: `Dear customer, your airtime order of GH${amount.toFixed(2)} has been credited successfully. Kindly dial *124# to check your balance thank you.\n\nARHMSGh`,
    })
}

// ============================================================
// USSD RESULT CHECKER SMS
// ============================================================

export async function sendResultCheckerUSSDSMS(
    recipientPhone: string,
    details: { checkerName: string; pin: string; serialNumber: string }
): Promise<SMSResult> {
    return sendSMS({
        recipient: recipientPhone,
        message:
            `ARHMS DATA LTD\n` +
            `Your ${details.checkerName} Result Checker is ready!\n\n` +
            `PIN: ${details.pin}\n` +
            `Serial: ${details.serialNumber}\n\n` +
            `Visit waecdirect.org to check your results.\n\nARHMSGh`,
    })
}
