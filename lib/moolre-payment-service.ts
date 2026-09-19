/**
 * Moolre Payment (Collection) Service
 *
 * Handles Mobile Money direct prompt collections and status checking via the Moolre API.
 * Uses: MOOLRE_TRANSFER_API_USER, MOOLRE_TRANSFER_API_KEY, MOOLRE_ACCOUNT_NUMBER
 */

const MOOLRE_BASE_URL = 'https://api.moolre.com'

export const MOOLRE_PAYMENT_CHANNEL_MAP: Record<string, string> = {
    'MTN': '13',
    'Telecel': '6',
    'AT': '7',
}

export interface InitiatePaymentParams {
    amount: number
    payerPhone: string
    channel: string
    externalRef: string
    otpCode?: string
}

export interface InitiatePaymentResult {
    success: boolean
    status?: string
    txstatus?: number
    otpRequired?: boolean
    error?: string
}

export interface CheckPaymentStatusResult {
    success: boolean
    txstatus: number | null
    transactionid: string | null
    error?: string
}

function getAuthHeaders(): HeadersInit {
    const apiUser = process.env.MOOLRE_TRANSFER_API_USER
    const pubKey = process.env.MOOLRE_TRANSFER_API_KEY

    if (!apiUser || !pubKey) {
        throw new Error(
            '[MoolrePayment] MOOLRE_TRANSFER_API_USER or MOOLRE_TRANSFER_API_KEY is not configured.'
        )
    }

    return {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-API-USER': apiUser,
        'X-API-KEY': pubKey,
    }
}

function getAccountNumber(): string {
    const accountNumber = process.env.MOOLRE_ACCOUNT_NUMBER
    if (!accountNumber) {
        throw new Error('[MoolrePayment] MOOLRE_ACCOUNT_NUMBER is not configured.')
    }
    return accountNumber
}

/**
 * Initiates a MoMo payment prompt.
 */
export async function initiatePayment(params: InitiatePaymentParams): Promise<InitiatePaymentResult> {
    try {
        // Validate OTP format if provided
        if (params.otpCode && !/^\d{4,6}$/.test(params.otpCode)) {
            return {
                success: false,
                error: 'OTP must be 4-6 digits',
            }
        }

        const accountNumber = getAccountNumber()
        const headers = getAuthHeaders()

        const body = {
            type: 1,
            channel: params.channel,
            currency: 'GHS',
            payer: params.payerPhone,
            amount: params.amount,
            externalref: params.externalRef,
            accountnumber: accountNumber,
            ...(params.otpCode && { otpcode: params.otpCode, otp: params.otpCode })
        }

        const response = await fetch(`${MOOLRE_BASE_URL}/open/transact/payment`, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
        })

        const data = await response.json()

        // Log full response to diagnose OTP and other statuses
        console.log('[MoolrePayment] Raw API response:', JSON.stringify(data))

        // Status '0' is an explicit failure from Moolre
        if (!response.ok || String(data.status) === '0') {
            return {
                success: false,
                error: data.message || `Moolre API error (HTTP ${response.status})`,
            }
        }

        // Detect OTP requirement — Moolre can indicate this via:
        //  • data.status === '200_OTP_REQ'  (string status code)
        //  • data.requiresotp === true       (boolean field)
        //  • data.otp_required === true      (boolean field)
        //  • data.code / data.status_code === '200_OTP_REQ'
        //  • data.txstatus === 5             (numeric code)
        //  • data.message containing "OTP"
        const rawStatus = String(data.status ?? '')
        const rawCode = String(data.code ?? data.status_code ?? '')
        const msgText = String(data.message ?? '')
        const txStatusNum = data.txstatus ?? data.data?.txstatus

        const isOtpRequired =
            rawStatus === '200_OTP_REQ' ||
            rawStatus.toUpperCase().includes('OTP') ||
            rawCode === '200_OTP_REQ' ||
            rawCode.toUpperCase().includes('OTP') ||
            data.requiresotp === true ||
            data.requiresotp === 'true' ||
            data.otp_required === true ||
            data.otp_required === 'true' ||
            data.requires_otp === true ||
            data.requires_otp === 'true' ||
            txStatusNum === 5 ||
            /otp/i.test(msgText)

        if (isOtpRequired) {
            return {
                success: true,
                status: '200_OTP_REQ',
                otpRequired: true,
                txstatus: txStatusNum,
            }
        }

        return {
            success: true,
            status: rawStatus || data.status,
            otpRequired: false,
            txstatus: txStatusNum,
        }
    } catch (err: any) {
        console.error('[MoolrePayment] initiatePayment error:', err.message)
        return {
            success: false,
            error: err.message || 'Network error during payment initiation',
        }
    }
}

/**
 * Checks the status of a payment.
 */
export async function checkPaymentStatus(externalRef: string): Promise<CheckPaymentStatusResult> {
    try {
        const accountNumber = getAccountNumber()
        const headers = getAuthHeaders()

        const body = {
            type: 1,
            idtype: '1',
            id: externalRef,
            accountnumber: accountNumber,
        }

        const response = await fetch(`${MOOLRE_BASE_URL}/open/transact/status`, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
        })

        const data = await response.json()

        // Handle possible error response
        if (!response.ok || String(data.status) === '0') {
             return { success: false, txstatus: null, transactionid: null, error: data.message }
        }

        const txstatus = data.txstatus ?? data.data?.txstatus ?? null
        const transactionid = data.transactionid ?? data.data?.transactionid ?? null

        return { success: true, txstatus, transactionid }
    } catch (err: any) {
        console.error('[MoolrePayment] checkPaymentStatus error:', err.message)
        return { success: false, txstatus: null, transactionid: null, error: err.message }
    }
}
