/**
 * Settles one storefront (SHOP-) payment from the ledger, whatever rail collected it.
 *
 * Shared by the reconciliation cron and the admin "retry settle" action, so both
 * ask the gateway the same question and settle through the same processor. Every
 * branch is safe to repeat: processShopOrder is idempotent on the reference and
 * writes the ledger outcome itself.
 *
 * The order of questions matters:
 *   1. Does an order already exist?  Local, cheap, and the usual answer.
 *   2. What does the gateway say?    Only the gateway can say "paid".
 *   3. Has it been pending too long? Only then is it declared failed.
 * A payment is never failed because something on OUR side is missing.
 */

import { createServerClient } from '@/lib/supabase'
import {
    getShopMeta,
    markShopPaymentSettled,
    markShopPaymentFailed,
    expectedShopPaidPesewas,
    type ShopLedgerRow,
} from '@/lib/shop-meta-store'
import { verifyTransaction } from '@/lib/paystack-momo-service'
import { clearPaystackMomoPending } from '@/lib/paystack-momo-checkout'

export type ShopReconcileOutcome =
    | 'already_settled'
    | 'settled'
    | 'paid_issue'
    | 'failed'
    | 'pending'
    | 'skipped'

export type ShopReconcileResult = {
    outcome: ShopReconcileOutcome
    provider: string | null
    detail?: string
}

type GatewayAnswer =
    | { state: 'paid'; amountPesewas: number; detail?: string }
    | { state: 'failed'; detail?: string }
    | { state: 'pending'; detail?: string }
    | { state: 'unsupported' }

export async function reconcileShopPayment(
    row: Pick<ShopLedgerRow, 'reference' | 'provider' | 'created_at' | 'metadata'>,
    options: { failureCutoffMs: number; abandonAfterMs: number }
): Promise<ShopReconcileResult> {
    const db: any = createServerClient()
    const reference = row.reference

    // 1. Already an order: the webhook or the buyer's poll got there first.
    const { data: existing } = await db
        .from('shop_orders')
        .select('id')
        .eq('paystack_reference', reference)
        .maybeSingle()
    if (existing) {
        await markShopPaymentSettled(reference)
        await clearPaystackMomoPending(reference)
        return { outcome: 'already_settled', provider: row.provider }
    }

    const metadata = row.metadata ?? (await getShopMeta<any>(reference))
    const provider: string | null = row.provider ?? metadata?.provider ?? null
    const ageMs = Date.now() - new Date(row.created_at).getTime()

    // 2. Ask the gateway.
    const answer = await askGateway(reference, provider, metadata)

    if (answer.state === 'paid') {
        if (!metadata?.shop_id) {
            // Cannot happen while the ledger row exists (it IS the metadata), but
            // never guess an order into existence.
            return { outcome: 'paid_issue', provider, detail: 'Paid but the order details are gone' }
        }
        const { processShopOrder } = await import('@/lib/shop-order-processor')
        const result = await processShopOrder(
            reference,
            metadata,
            answer.amountPesewas,
            metadata.slug ?? metadata.shop_slug
        )
        if (result.success) {
            await clearPaystackMomoPending(reference)
            return { outcome: 'settled', provider }
        }
        return { outcome: 'paid_issue', provider, detail: result.error }
    }

    if (answer.state === 'failed' && ageMs > options.failureCutoffMs) {
        await markShopPaymentFailed(reference, answer.detail || 'Declined or abandoned at the gateway')
        await clearPaystackMomoPending(reference)
        return { outcome: 'failed', provider, detail: answer.detail }
    }

    // 3. Pending (or a rail this sweep cannot ask) for longer than anyone waits.
    if (ageMs > options.abandonAfterMs) {
        const why = answer.state === 'unsupported'
            ? `No order after ${Math.round(options.abandonAfterMs / 3600000)}h; ${provider ?? 'unknown'} is not verifiable here`
            : `No completed payment after ${Math.round(options.abandonAfterMs / 3600000)}h`
        // A late settle (its own webhook or sweep) still flips this to settled:
        // markShopPaymentSettled does not care what the status was.
        await markShopPaymentFailed(reference, why)
        await clearPaystackMomoPending(reference)
        return { outcome: 'failed', provider, detail: why }
    }

    return {
        outcome: answer.state === 'unsupported' ? 'skipped' : 'pending',
        provider,
        detail: 'detail' in answer ? answer.detail : undefined,
    }
}

async function askGateway(reference: string, provider: string | null, metadata: any): Promise<GatewayAnswer> {
    switch (provider) {
        case 'paystack_momo':
        case 'paystack': {
            const v = await verifyTransaction(reference)
            if (v.outcome === 'paid') {
                return { state: 'paid', amountPesewas: v.amountPesewas ?? expectedShopPaidPesewas(metadata) }
            }
            if (v.outcome === 'failed') return { state: 'failed', detail: `Paystack: ${v.rawStatus ?? 'failed'}` }
            return { state: 'pending', detail: v.message ?? undefined }
        }
        case 'moolre': {
            const { checkPaymentStatus } = await import('@/lib/moolre-payment-service')
            const r = await checkPaymentStatus(reference)
            // txstatus: 1 paid, 2 failed, 0/3 pending (same mapping as /api/shop/verify).
            if (r.success && Number(r.txstatus) === 1) {
                // Moolre reports status only, no amount.
                return { state: 'paid', amountPesewas: expectedShopPaidPesewas(metadata) }
            }
            if (r.success && Number(r.txstatus) === 2) return { state: 'failed', detail: 'Moolre: failed' }
            return { state: 'pending', detail: r.error }
        }
        case 'hubtel': {
            const { checkPaymentStatus } = await import('@/lib/hubtel-payment-service')
            const r = await checkPaymentStatus(reference)
            const status = String(r.status ?? '').toLowerCase()
            if (r.success && status === 'paid') {
                const amount = Number(r.amount)
                return {
                    state: 'paid',
                    amountPesewas: Number.isFinite(amount) && amount > 0
                        ? Math.round(amount * 100)
                        : expectedShopPaidPesewas(metadata),
                }
            }
            if (r.success && (status === 'unpaid' || status === 'refunded')) {
                return { state: 'failed', detail: `Hubtel: ${r.status}` }
            }
            return { state: 'pending', detail: r.error }
        }
        default:
            // PaySwitch needs its own transaction id, which verify-payswitch-payments
            // resolves and settles. Here it is only watched for an order appearing.
            return { state: 'unsupported' }
    }
}
