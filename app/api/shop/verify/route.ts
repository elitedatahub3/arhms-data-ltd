import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getShopMeta, expectedShopPaidPesewas } from '@/lib/shop-meta-store'
import { checkPaymentStatus } from '@/lib/moolre-payment-service'
import { verifyTransaction } from '@/lib/paystack-momo-service'
import { clearPaystackMomoPending } from '@/lib/paystack-momo-checkout'

/**
 * The storefront's payment poll (and the hosted-checkout return URL).
 *
 * Statuses the inline poller understands:
 *   completed  - an order exists. Stop and show success.
 *   pending    - keep polling.
 *   processing - the gateway says PAID and the order is being created (or the
 *                details are being recovered). Never shown as a failure.
 *   paid_issue - PAID but the order could not be created yet. The ledger has it
 *                and the cron retries; the buyer gets their reference, not "failed".
 *   failed     - the gateway itself says the payment did not happen.
 *
 * Rule: "failed" only ever comes from the gateway. Nothing missing or broken on
 * our side may tell a buyer whose money moved that their payment failed.
 */
export async function GET(request: NextRequest) {
    const { searchParams } = new URL(request.url)
    const ref = searchParams.get('ref')
    const slug = searchParams.get('slug')

    const isInline = request.headers.get('accept')?.includes('application/json')

    if (!ref || !slug) {
        if (isInline) return NextResponse.json({ success: false, error: 'invalid_ref' }, { status: 400 })
        return NextResponse.redirect(new URL(`/shop/${slug || ''}?error=invalid_ref`, request.url))
    }

    if (!ref.startsWith('SHOP-') || ref.length > 50) {
        if (isInline) return NextResponse.json({ success: false, error: 'invalid_ref' }, { status: 400 })
        return NextResponse.redirect(new URL(`/shop/${slug}?error=invalid_ref`, request.url))
    }

    const respond = (status: 'completed' | 'pending' | 'processing' | 'paid_issue' | 'failed', extra: Record<string, any> = {}) => {
        if (isInline) {
            return NextResponse.json({ success: status !== 'failed', status, reference: ref, ...extra })
        }
        if (status === 'completed') return NextResponse.redirect(new URL(`/shop/${slug}/success?ref=${ref}`, request.url))
        const error = status === 'failed' ? 'payment_failed'
            : status === 'paid_issue' || status === 'processing' ? 'payment_processing'
                : 'payment_pending'
        return NextResponse.redirect(new URL(`/shop/${slug}?error=${error}&ref=${encodeURIComponent(ref)}`, request.url))
    }

    try {
        // 1. Already an order? The webhook or the cron usually gets there first, and
        // this is the only answer that matters to the buyer. Every rail, no gateway call.
        const db: any = createServerClient()
        const { data: existing } = await db
            .from('shop_orders')
            .select('id')
            .eq('paystack_reference', ref)
            .maybeSingle()
        if (existing) {
            await clearPaystackMomoPending(ref)
            return respond('completed')
        }

        // 2. The stored order names the rail that collected it.
        const metadata = await getShopMeta<any>(ref)
        const provider: string | null = metadata?.provider ?? null

        if (!metadata) {
            // Details missing on our side. Ask Paystack anyway (SHOP- refs on the
            // Paystack rails are verifiable without them) but never answer "failed".
            const verified = await verifyTransaction(ref)
            console.error('[Shop Verify] Metadata not found for:', ref, '| Paystack:', verified.rawStatus)
            return respond(verified.outcome === 'paid' ? 'processing' : 'pending')
        }

        // Authoritative amount when the gateway reports one; otherwise rebuilt from the
        // stored order, exactly as processShopOrder re-derives it at settlement.
        let paidAmountPesewas: number | null = null

        if (provider === 'paystack_momo' || provider === 'paystack') {
            const verified = await verifyTransaction(ref)
            // 'abandoned' is not trusted as final here: Paystack can report it while a
            // MoMo prompt is still on the handset. The cron decides after the cutoff.
            if (verified.outcome === 'failed' && verified.rawStatus !== 'abandoned') return respond('failed')
            if (verified.outcome !== 'paid') return respond('pending')
            paidAmountPesewas = verified.amountPesewas
        } else if (provider === 'moolre' || !provider) {
            // No provider on the metadata means a reference initialized before the
            // field existed, which was Moolre.
            const moolreResponse = await checkPaymentStatus(ref)
            if (!moolreResponse.success || moolreResponse.txstatus === null) return respond('pending')
            if (moolreResponse.txstatus === 0 || moolreResponse.txstatus === 3) return respond('pending')
            if (moolreResponse.txstatus === 2) return respond('failed')
        } else {
            // Hubtel and PaySwitch settle by callback (and their sweeps). Asking Moolre
            // about their references, as this route used to, answered "pending"
            // forever even after the order existed. Step 1 catches their orders.
            return respond('pending')
        }

        // 3. Paid. Create the order (idempotent with the webhook and the cron).
        const { processShopOrder } = await import('@/lib/shop-order-processor')
        const result = await processShopOrder(
            ref,
            metadata,
            paidAmountPesewas ?? expectedShopPaidPesewas(metadata),
            slug
        )

        if (!result.success) {
            // The money is in. The ledger has recorded the failure and the cron
            // retries; tell the buyer that, with their reference, and stop polling.
            console.error('[Shop Verify] Paid but order not created:', ref, result.error)
            return respond('paid_issue', { message: result.error })
        }

        await clearPaystackMomoPending(ref)
        return respond('completed')

    } catch (error) {
        // Our failure, not the payment's. Keep the buyer polling.
        console.error('[Shop Verify] Error:', error)
        return respond('pending', { error: 'server_error' })
    }
}
