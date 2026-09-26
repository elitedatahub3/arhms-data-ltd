import { NextRequest, NextResponse } from 'next/server'
import { createRouteHandlerClient } from '@/lib/supabase-server'
import { cookies } from 'next/headers'
import { getShopMeta } from '@/lib/shop-meta-store'
import { checkPaymentStatus } from '@/lib/moolre-payment-service'
import { verifyTransaction } from '@/lib/paystack-momo-service'
import { clearPaystackMomoPending } from '@/lib/paystack-momo-checkout'

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

    try {
        // The metadata read moves ABOVE the status check, because the metadata is what
        // names the gateway that collected. Asking Moolre about a Paystack reference
        // returns "unknown" forever, and the storefront's 40x3s poll then tells a
        // guest to wait on money that is already in.
        const metadata = await getShopMeta<any>(ref)
        if (!metadata) {
            console.error('[Shop Verify] Metadata not found for:', ref)
            if (isInline) return NextResponse.json({ success: false, error: 'payment_error' }, { status: 400 })
            return NextResponse.redirect(new URL(`/shop/${slug}?error=payment_error`, request.url))
        }

        if (metadata?.provider === 'paystack_momo') {
            const verified = await verifyTransaction(ref)

            if (verified.outcome === 'failed') {
                if (isInline) return NextResponse.json({ success: false, status: 'failed' })
                return NextResponse.redirect(new URL(`/shop/${slug}?error=payment_failed`, request.url))
            }
            if (verified.outcome !== 'paid') {
                if (isInline) return NextResponse.json({ success: true, status: 'pending' })
                return NextResponse.redirect(new URL(`/shop/${slug}?error=payment_pending`, request.url))
            }
        } else {
            const moolreResponse = await checkPaymentStatus(ref)

            if (!moolreResponse.success || moolreResponse.txstatus === null) {
                console.error('[Shop Verify] Moolre check failed:', moolreResponse.error)
                if (isInline) return NextResponse.json({ success: true, status: 'pending', error: 'Payment check failed temporarily' })
                return NextResponse.redirect(new URL(`/shop/${slug}?error=payment_error`, request.url))
            }

            if (moolreResponse.txstatus === 0 || moolreResponse.txstatus === 3) {
                if (isInline) return NextResponse.json({ success: true, status: 'pending' })
                return NextResponse.redirect(new URL(`/shop/${slug}?error=payment_pending`, request.url))
            }

            if (moolreResponse.txstatus === 2) {
                if (isInline) return NextResponse.json({ success: false, status: 'failed' })
                return NextResponse.redirect(new URL(`/shop/${slug}?error=payment_failed`, request.url))
            }
        }

        // 3. Process the order using the shared logic (Idempotent)
        const { processShopOrder } = await import('@/lib/shop-order-processor')
        const paidAmountPesewas = Math.round(Number(metadata.selling_price || metadata.airtime_amount) * 100) + Math.round(Number(metadata.fee_amount || metadata.paystack_fee || 0) * 100)

        const result = await processShopOrder(
            ref,
            metadata,
            paidAmountPesewas,
            slug!
        )

        if (!result.success) {
            const errorType = result.error === 'Payment amount mismatch' ? 'payment_mismatch' : 'payment_error'
            if (isInline) return NextResponse.json({ success: false, error: errorType }, { status: 400 })
            return NextResponse.redirect(new URL(`/shop/${slug}?error=${errorType}`, request.url))
        }

        // Settled here, so the sweep has nothing left to do with it.
        await clearPaystackMomoPending(ref)

        if (isInline) return NextResponse.json({ success: true, status: 'completed' })
        return NextResponse.redirect(new URL(`/shop/${slug}/success?ref=${ref}`, request.url))

    } catch (error) {
        console.error('[Shop Verify] Error:', error)
        if (isInline) return NextResponse.json({ success: false, error: 'server_error' }, { status: 500 })
        return NextResponse.redirect(new URL(`/shop/${slug}?error=server_error`, request.url))
    }
}

