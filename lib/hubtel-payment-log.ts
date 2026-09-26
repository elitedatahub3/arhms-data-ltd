/**
 * Durable record of Hubtel payment attempts — the source for /admin/hubtel-payments.
 *
 * Before this existed, a payment's outcome only ever reached stdout. The Receive-Money
 * webhook returned early on any ResponseCode other than '0000', so a payment the customer
 * cancelled, or that timed out, or that Hubtel rejected, produced NO record at all. An
 * admin asking "did this go through?" had nothing to look at.
 *
 * Every write here is FAIL-OPEN, the same stance as lib/hubtel-prompt-limit.ts: a log
 * table must never be able to break a payment. Errors are printed and swallowed.
 *
 * Shape: one row per attempt, keyed by client_reference and upserted, so the initiate row
 * is later updated in place by the callback / cron status check / USSD fulfilment rather
 * than accumulating one row per event. `stage` records which interaction last touched it.
 */
import { createServerClient } from '@/lib/supabase'

export type HubtelLogStatus = 'pending' | 'success' | 'failed'
export type HubtelLogStage = 'initiate' | 'callback' | 'status_check' | 'fulfill'

/**
 * Derives the business flow from the reference prefix. These are the same prefixes the
 * webhook router in app/api/webhooks/hubtel/route.ts switches on, so keep the two in step.
 */
export function flowFromReference(reference: string): string {
    const ref = reference || ''
    // USSD- must be tested before RC-/DATA-: a USSD sale is 'USSD-RC-…' or
    // 'USSD-DATA-…' and belongs to the USSD flow, not the web voucher or data flow.
    // (startsWith is anchored, so these could not actually collide — the ordering is
    // for the reader, and for whoever loosens one of these tests later.)
    if (ref.startsWith('USSD-')) return 'ussd'
    // A dashboard purchase of a USSD short code. Filed under 'ussd' because that is
    // the sweep that settles it, and an operator looking for a USSD payment problem
    // looks in one place.
    if (ref.startsWith('ussd_activation_')) return 'ussd'
    // Must be tested before SHOP-: 'AFA-SHOP-…' does not start with 'SHOP-', so it
    // fell through to 'unknown' and dropped out of the admin filter entirely.
    if (ref.startsWith('AFA-SHOP-')) return 'afa'
    if (ref.startsWith('SHOP-')) return 'shop'
    if (ref.startsWith('RC-')) return 'results_checker'
    if (ref.startsWith('DATA-')) return 'data'
    if (ref.startsWith('BOOST-')) return 'boost'
    // Two distinct airtime flows: 'ATP-' is money coming IN for a direct-pay airtime
    // purchase, 'AIR-' is one Commission Services top-up leg going OUT. Order matters
    // only in that neither prefix may shadow the other — they deliberately differ.
    if (ref.startsWith('ATP-')) return 'airtime_pay'
    if (ref.startsWith('AIR-')) return 'airtime'
    // Utilities split the same way: 'UTIL-' is money coming IN for a bill payment,
    // 'UTLB-' is the Commission Services bill payment going OUT.
    if (ref.startsWith('UTIL-')) return 'utility_pay'
    if (ref.startsWith('UTLB-')) return 'utility'
    if (ref.startsWith('agent_upgrade_')) return 'agent_upgrade'
    if (ref.startsWith('dealer_sub_')) return 'dealer_subscription'
    if (ref.startsWith('WAL-')) return 'wallet'
    return 'unknown'
}

/** Every flow this table can record — also drives the admin page's filter dropdown. */
export const HUBTEL_LOG_FLOWS = [
    'wallet',
    'shop',
    'afa',
    'data',
    'results_checker',
    'boost',
    'agent_upgrade',
    'dealer_subscription',
    'ussd',
    'airtime',
    'airtime_pay',
    'utility',
    'utility_pay',
    'unknown',
] as const

interface UpsertFields {
    flow?: string
    status?: HubtelLogStatus
    stage?: HubtelLogStage
    amount?: number | null
    channel?: string | null
    payerMsisdn?: string | null
    customerName?: string | null
    transactionId?: string | null
    responseCode?: string | null
    message?: string | null
    userId?: string | null
    rawInitiate?: unknown
    rawCallback?: unknown
}

/**
 * Upserts on client_reference. Only fields explicitly supplied are written, so a callback
 * arriving with no channel does not wipe the channel the initiate row already recorded.
 */
async function upsertLog(clientReference: string, fields: UpsertFields): Promise<void> {
    if (!clientReference) return

    try {
        const row: Record<string, unknown> = {
            client_reference: clientReference,
            updated_at: new Date().toISOString(),
        }

        if (fields.flow !== undefined) row.flow = fields.flow
        if (fields.status !== undefined) row.status = fields.status
        if (fields.stage !== undefined) row.stage = fields.stage
        if (fields.amount !== undefined) row.amount = fields.amount
        if (fields.channel !== undefined) row.channel = fields.channel
        if (fields.payerMsisdn !== undefined) row.payer_msisdn = fields.payerMsisdn
        if (fields.customerName !== undefined) row.customer_name = fields.customerName
        if (fields.transactionId !== undefined) row.transaction_id = fields.transactionId
        if (fields.responseCode !== undefined) row.response_code = fields.responseCode
        if (fields.message !== undefined) row.message = fields.message
        if (fields.userId !== undefined) row.user_id = fields.userId
        if (fields.rawInitiate !== undefined) row.raw_initiate = fields.rawInitiate
        if (fields.rawCallback !== undefined) row.raw_callback = fields.rawCallback

        const db = createServerClient() as any
        const { error } = await db
            .from('hubtel_payment_logs')
            .upsert(row, { onConflict: 'client_reference' })

        if (error) {
            console.error('[HubtelPaymentLog] Upsert failed (non-fatal):', error.message)
        }
    } catch (e) {
        console.error('[HubtelPaymentLog] Could not write log (non-fatal):', e)
    }
}

/**
 * Called from initiatePayment once Hubtel has answered — including when it refused, failed
 * to parse, or could not be reached. `status` is 'pending' when the prompt went out
 * (ResponseCode '0001') and the callback will decide the final outcome.
 */
export async function logInitiate(params: {
    clientReference: string
    status: HubtelLogStatus
    amount?: number | null
    channel?: string | null
    payerMsisdn?: string | null
    customerName?: string | null
    transactionId?: string | null
    responseCode?: string | null
    message?: string | null
    userId?: string | null
    raw?: unknown
}): Promise<void> {
    await upsertLog(params.clientReference, {
        flow: flowFromReference(params.clientReference),
        stage: 'initiate',
        status: params.status,
        amount: params.amount ?? null,
        channel: params.channel ?? null,
        payerMsisdn: params.payerMsisdn ?? null,
        customerName: params.customerName ?? null,
        transactionId: params.transactionId ?? null,
        responseCode: params.responseCode ?? null,
        message: params.message ?? null,
        userId: params.userId ?? null,
        rawInitiate: params.raw ?? null,
    })
}

/**
 * Called from the Receive-Money webhook for EVERY callback, successful or not. This is the
 * only place a genuinely failed payment gets recorded, so it must run before any early
 * return.
 *
 * `message` lets the caller override Hubtel's own text for the cases the webhook drops
 * silently — missing shop metadata, unknown reference, amount mismatch.
 */
export async function logCallback(params: {
    clientReference: string
    responseCode?: string | null
    message?: string | null
    amount?: number | null
    transactionId?: string | null
    payerMsisdn?: string | null
    status?: HubtelLogStatus
    raw?: unknown
}): Promise<void> {
    const status: HubtelLogStatus =
        params.status ?? (params.responseCode === '0000' ? 'success' : 'failed')

    await upsertLog(params.clientReference, {
        flow: flowFromReference(params.clientReference),
        stage: 'callback',
        status,
        amount: params.amount ?? undefined,
        payerMsisdn: params.payerMsisdn ?? undefined,
        transactionId: params.transactionId ?? undefined,
        responseCode: params.responseCode ?? null,
        message: params.message ?? null,
        rawCallback: params.raw ?? null,
    })
}

/**
 * Called from the reconciliation cron. Hubtel's status endpoint answers
 * 'Paid' | 'Unpaid' | 'Refunded'; anything that is not 'Paid' while we are still waiting
 * stays pending until the cron gives up on it, which it reports as 'failed'.
 */
export async function logStatusCheck(params: {
    clientReference: string
    status: HubtelLogStatus
    hubtelStatus?: string | null
    transactionId?: string | null
    amount?: number | null
    message?: string | null
    /** The status endpoint's `data` object — carries externalTransactionId, charges,
     *  amountAfterCharges and paymentMethod, none of which have their own column. */
    raw?: unknown
}): Promise<void> {
    await upsertLog(params.clientReference, {
        flow: flowFromReference(params.clientReference),
        stage: 'status_check',
        status: params.status,
        transactionId: params.transactionId ?? undefined,
        amount: params.amount ?? undefined,
        message: params.message ?? (params.hubtelStatus ? `Hubtel status: ${params.hubtelStatus}` : null),
        rawCallback: params.raw ?? undefined,
    })
}

/**
 * Called from the USSD Service Fulfilment callback. These payments never touch
 * initiatePayment or the Receive-Money webhook — Hubtel collects the money on its side and
 * only tells us at fulfilment time — so this insert is the row's first and only write.
 */
export async function logFulfillment(params: {
    orderId: string
    status: HubtelLogStatus
    amount?: number | null
    payerMsisdn?: string | null
    message?: string | null
    raw?: unknown
}): Promise<void> {
    await upsertLog(params.orderId, {
        flow: 'ussd',
        stage: 'fulfill',
        status: params.status,
        amount: params.amount ?? null,
        payerMsisdn: params.payerMsisdn ?? null,
        message: params.message ?? null,
        rawCallback: params.raw ?? null,
    })
}
