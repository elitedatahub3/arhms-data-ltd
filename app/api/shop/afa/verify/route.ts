import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { Redis } from '@upstash/redis'
import { checkPaymentStatus } from '@/lib/moolre-payment-service'
import { verifyTransaction } from '@/lib/paystack-momo-service'
import { isPaystackMomoPending, clearPaystackMomoPending } from '@/lib/paystack-momo-checkout'
import { finalizeAfaShopOrder, failAfaShopOrder } from '@/lib/afa/checkout'

let redis: Redis | null = null
try { redis = Redis.fromEnv() } catch (_) {}

/**
 * Browser poll for a storefront AFA registration payment.
 *
 * Mirrors /api/shop/rc/verify. Settlement itself lives in finalizeAfaShopOrder,
 * shared with the payment webhooks — in practice the webhook usually wins the
 * race and this call just reports the already-settled state.
 */
export async function GET(request: NextRequest) {
    const { searchParams } = new URL(request.url)
    const ref = searchParams.get('ref')
    const slug = searchParams.get('slug')

    if (!ref || !slug) {
        return NextResponse.json({ success: false, error: 'ref and slug are required' }, { status: 400 })
    }

    if (!ref.startsWith('AFA-SHOP-') || ref.length > 60) {
        return NextResponse.json({ success: false, error: 'invalid_ref' }, { status: 400 })
    }

    try {
        const db = createServerClient() as any

        // Already settled (usually by the webhook) — report and stop polling.
        const { data: existing } = await db
            .from('afa_orders')
            .select('payment_status')
            .eq('reference_code', ref)
            .maybeSingle()

        if (existing?.payment_status === 'completed') {
            return NextResponse.json({ success: true, status: 'completed' })
        }
        if (existing?.payment_status === 'failed') {
            return NextResponse.json({ success: false, status: 'failed', message: 'Payment was not completed.' })
        }

        // Ask whichever gateway actually collected. The pending marker is what says
        // this was the Paystack MoMo rail; Moolre cannot answer for a reference it
        // never issued, and would leave the guest polling on money already in.
        if (await isPaystackMomoPending(ref)) {
            const verified = await verifyTransaction(ref)

            if (verified.outcome === 'failed') {
                await failAfaShopOrder(ref)
                await clearPaystackMomoPending(ref)
                return NextResponse.json({ success: false, status: 'failed', message: 'Payment was not completed.' })
            }
            if (verified.outcome !== 'paid') {
                return NextResponse.json({ success: true, status: 'pending' })
            }
        } else {
            const moolreResponse = await checkPaymentStatus(ref)

            if (!moolreResponse.success || moolreResponse.txstatus === null) {
                return NextResponse.json({ success: true, status: 'pending' })
            }

            // Pending / processing
            if (moolreResponse.txstatus === 0 || moolreResponse.txstatus === 3) {
                return NextResponse.json({ success: true, status: 'pending' })
            }

            // Failed / cancelled
            if (moolreResponse.txstatus === 2) {
                await failAfaShopOrder(ref)
                return NextResponse.json({ success: false, status: 'failed', message: 'Payment was not completed.' })
            }
        }

        // Paid — settle through the shared path.
        //
        // Moolre's status endpoint confirms success but does not echo the amount
        // back (see CheckPaymentStatusResult), so there is nothing to cross-check
        // against here and we settle for the order's own total. The amount guard
        // in finalizeAfaShopOrder has teeth on the webhook path, where the
        // gateway does report what was actually charged.
        const { data: order } = await db
            .from('afa_orders')
            .select('payment_amount')
            .eq('reference_code', ref)
            .maybeSingle()

        if (!order) {
            return NextResponse.json(
                { success: false, status: 'error', error: 'Order not found' },
                { status: 500 }
            )
        }
        const paidKobo = Math.round(Number(order.payment_amount) * 100)

        try {
            const result = await finalizeAfaShopOrder({ reference: ref, paidAmountKobo: paidKobo })
            if (!result.success) {
                return NextResponse.json(
                    { success: false, status: 'error', error: 'Failed to finalize registration' },
                    { status: 500 }
                )
            }
        } catch (err: any) {
            if (err?.message === 'AMOUNT_MISMATCH') {
                console.error('[shop/afa/verify] Amount mismatch on', ref)
                return NextResponse.json(
                    { success: false, status: 'error', error: 'Payment amount did not match the order.' },
                    { status: 400 }
                )
            }
            throw err
        }

        try {
            if (redis) {
                await redis.del(`shop:afa:meta:${ref}`)
                await redis.del(`shop:afa:orderid:${ref}`)
            }
        } catch (_) {}

        return NextResponse.json({ success: true, status: 'completed' })

    } catch (error: any) {
        console.error('[shop/afa/verify]', error)
        return NextResponse.json({ success: false, status: 'error', error: 'Internal server error' }, { status: 500 })
    }
}
