import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { checkPaymentStatus as moolreCheckPaymentStatus } from '@/lib/moolre-payment-service'
import { checkPaymentStatus as hubtelCheckPaymentStatus } from '@/lib/hubtel-payment-service'
import { checkPaymentStatus as payswitchCheckPaymentStatus } from '@/lib/payswitch-payment-service'
import { verifyTransaction } from '@/lib/paystack-momo-service'
import { isBundlePaymentReference, processBundleDirectOrder } from '@/lib/bundle-order-payments'

export const dynamic = 'force-dynamic'

/**
 * GET /api/shop/bundles/status?ref=BUNPAY-…&slug=
 *
 * The storefront buyer's poll for a Standard Bundle Direct Pay. The buyer is a
 * guest, so /api/payments/verify (session-bound) cannot serve them. Settlement
 * still goes through processBundleDirectOrder, shared with every webhook and
 * cron, so whichever path sees the payment first creates the order once.
 *
 * Returns { payment: pending|paid|failed, order: {status, …} | null }.
 */
export async function GET(request: NextRequest) {
    const ref = request.nextUrl.searchParams.get('ref') || ''
    const slug = (request.nextUrl.searchParams.get('slug') || '').trim()
    if (!isBundlePaymentReference(ref) || ref.length > 80 || !slug) {
        return NextResponse.json({ error: 'invalid_ref' }, { status: 400 })
    }

    const db = createServerClient() as any
    const [{ data: payment }, { data: shop }] = await Promise.all([
        db.from('wallet_payments').select('id, status, provider, provider_reference, metadata, created_at').eq('reference', ref).maybeSingle(),
        db.from('shop_profiles').select('id').eq('shop_slug', slug).maybeSingle(),
    ])
    // Only this shop's own storefront payments: a reference alone reveals nothing else.
    if (!payment || !shop || payment.metadata?.shop_id !== shop.id) {
        return NextResponse.json({ error: 'not_found' }, { status: 404 })
    }

    const readOrder = async () => {
        const { data } = await db.from('bundle_orders')
            .select('reference_code, network, bundle_label, beneficiary_phone, total_paid, status, fulfillment_note, created_at')
            .eq('reference_code', ref).maybeSingle()
        return data || null
    }

    if (payment.status === 'completed') return NextResponse.json({ payment: 'paid', order: await readOrder() })
    if (payment.status === 'failed') return NextResponse.json({ payment: 'failed', order: null })

    // Pending: ask the gateway that collected. Give the webhook a short head start.
    const ageMs = Date.now() - new Date(payment.created_at).getTime()
    if (ageMs < 10_000) return NextResponse.json({ payment: 'pending', order: null })

    let outcome: 'paid' | 'failed' | 'pending' = 'pending'
    try {
        switch (payment.provider) {
            case 'paystack':
                break // hosted card: the webhook / sweep settles it
            case 'paystack_momo': {
                const v = await verifyTransaction(ref)
                outcome = v.outcome === 'paid' ? 'paid' : v.outcome === 'failed' ? 'failed' : 'pending'
                break
            }
            case 'hubtel': {
                const h = await hubtelCheckPaymentStatus(ref)
                if (h.success && h.status === 'Paid') outcome = 'paid'
                else if (h.success && h.status && h.status !== 'Unpaid') outcome = 'failed'
                break
            }
            case 'payswitch': {
                const p = await payswitchCheckPaymentStatus(String(payment.provider_reference || ''))
                if (p.success && p.outcome === 'paid') outcome = 'paid'
                else if (p.success && p.outcome === 'failed') outcome = 'failed'
                break
            }
            default: {
                const m = await moolreCheckPaymentStatus(ref)
                if (m.success && m.txstatus === 1) outcome = 'paid'
                else if (m.success && m.txstatus === 2) outcome = 'failed'
            }
        }
    } catch (e) {
        console.error('[shop/bundles/status] gateway check failed:', ref, e)
    }

    if (outcome === 'failed') {
        await db.from('wallet_payments').update({ status: 'failed' }).eq('id', payment.id).eq('status', 'pending')
        return NextResponse.json({ payment: 'failed', order: null })
    }
    if (outcome === 'paid') {
        await processBundleDirectOrder(ref)
        return NextResponse.json({ payment: 'paid', order: await readOrder() })
    }
    return NextResponse.json({ payment: 'pending', order: null })
}
