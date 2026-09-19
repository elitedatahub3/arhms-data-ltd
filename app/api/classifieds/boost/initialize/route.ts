import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { verifyAuth } from '@/lib/classifieds-auth'
import { getListingById } from '@/lib/classifieds-queries'
import { generateReferenceCode } from '@/lib/utils'
import { initiatePayment, MOOLRE_PAYMENT_CHANNEL_MAP } from '@/lib/moolre-payment-service'
import { initiatePayment as payswitchInitiatePayment, PAYSWITCH_CHANNEL_MAP } from '@/lib/payswitch-payment-service'
import { assignPayswitchTransactionId } from '@/lib/payswitch-reference'
import { paystackMomoProviderFor } from '@/lib/paystack-momo-service'
import {
    startPaystackMomoCharge,
    submitPaystackMomoOtp,
    assertOwnPendingPayment,
    type MomoChargeResult,
} from '@/lib/paystack-momo-checkout'
import { resolveProviderForScope, type PaymentProvider } from '@/lib/payment-provider'
import type { Database } from '@/types/supabase'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || ''

const TIER_DAYS: Record<string, number> = {
    '7d': 7,
    '14d': 14,
    '21d': 21,
    '30d': 30,
    '60d': 60,
    '90d': 90,
}

export async function POST(request: NextRequest) {
    try {
        const authHeader = request.headers.get('authorization')
        const token = authHeader?.replace('Bearer ', '')
        const userId = await verifyAuth(token)

        if (!userId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const body = await request.json()
        const { listing_id, tier, phone, network, otpCode, reference: existingRef } = body

        if (!listing_id || !tier) {
            return NextResponse.json({ error: 'Missing listing_id or tier' }, { status: 400 })
        }

        if (!TIER_DAYS[tier]) {
            return NextResponse.json(
                { error: 'Invalid tier. Valid values: 7d, 14d, 21d, 30d, 60d, 90d' },
                { status: 400 }
            )
        }

        // Verify listing exists and belongs to this seller
        const listing = await getListingById(listing_id)
        if (!listing) {
            return NextResponse.json({ error: 'Listing not found' }, { status: 404 })
        }
        if (listing.seller_id !== userId) {
            return NextResponse.json({ error: 'You can only boost your own listings' }, { status: 403 })
        }

        const supabase = createClient<Database>(supabaseUrl, supabaseServiceKey)

        // Fetch boost fee and active payment provider from admin settings
        const { data: settingsRows } = await supabase
            .from('admin_settings')
            .select('key, value')
            .in('key', [`classifieds_boost_fee_${tier}`, 'active_payment_provider_classifieds'])

        const settingsMap: Record<string, string> = {}
        for (const row of (settingsRows || [])) {
            settingsMap[(row as any).key] = String((row as any).value || '')
        }

        const boostFee = parseFloat(settingsMap[`classifieds_boost_fee_${tier}`] || '0')
        if (boostFee <= 0) {
            return NextResponse.json(
                { error: 'Boost pricing not configured by admin' },
                { status: 400 }
            )
        }

        // Hubtel is deliberately not offered here — this flow has no Hubtel branch,
        // so SCOPE_PROVIDERS['classifieds'] excludes it and it resolves to the fallback.
        const provider: PaymentProvider = resolveProviderForScope(
            settingsMap['active_payment_provider_classifieds'],
            'classifieds'
        )

        // Validate provider-specific inputs
        if (provider === 'moolre' && !existingRef) {
            if (!phone || !network || !MOOLRE_PAYMENT_CHANNEL_MAP[network]) {
                return NextResponse.json(
                    { error: 'Valid phone number and network are required for Moolre payments' },
                    { status: 400 }
                )
            }
        }

        if (provider === 'payswitch') {
            if (!phone || !network || !PAYSWITCH_CHANNEL_MAP[network]) {
                return NextResponse.json(
                    { error: 'Valid phone number and network are required for PaySwitch payments' },
                    { status: 400 }
                )
            }
        }

        if (provider === 'paystack') {
            if (!process.env.PAYSTACK_SECRET_KEY) {
                return NextResponse.json(
                    { error: 'Payment gateway is not configured. Please contact support.' },
                    { status: 503 }
                )
            }
            if (!process.env.NEXT_PUBLIC_APP_URL) {
                return NextResponse.json(
                    { error: 'App URL is not configured for payment callbacks. Please contact support.' },
                    { status: 503 }
                )
            }
        }

        // Get seller email (needed for Paystack)
        let sellerEmail: string | null = null
        if (provider === 'paystack') {
            const { data: userRow } = await supabase
                .from('users' as any)
                .select('email')
                .eq('id', userId)
                .single()
            sellerEmail = (userRow as any)?.email || null
            if (!sellerEmail) {
                return NextResponse.json(
                    { error: 'Account email is required for Paystack. Please update your profile.' },
                    { status: 400 }
                )
            }
        }

        // Get or reuse reference
        const reference = existingRef || `BOOST-${generateReferenceCode()}`
        let paymentId: string | null = null

        // Get user's wallet_id (required for wallet_payments table)
        const { data: walletRow } = await supabase
            .from('wallets' as any)
            .select('id')
            .eq('user_id', userId)
            .single()

        if (!walletRow) {
            return NextResponse.json(
                { error: 'Wallet not found. Please contact support.' },
                { status: 500 }
            )
        }

        const walletId = (walletRow as any).id

        if (existingRef) {
            const { data: existing } = await supabase
                .from('wallet_payments' as any)
                .select('id')
                .eq('reference', existingRef)
                .single()
            if (existing) paymentId = (existing as any).id
        }

        // Create wallet_payments record if not exists (reuse reference for Moolre OTP retry)
        if (!paymentId) {
            const { data: paymentRow, error: paymentInsertError } = await supabase
                .from('wallet_payments' as any)
                .insert({
                    user_id: userId,
                    wallet_id: walletId,
                    amount: boostFee,
                    fee: 0,
                    total_amount: boostFee,
                    reference,
                    provider,
                    status: 'pending',
                    metadata: {
                        type: 'listing_boost',
                        listing_id,
                        tier,
                    },
                })
                .select()
                .single()

            if (paymentInsertError) {
                // Handle unique constraint violation (race condition: reference already exists)
                if ((paymentInsertError as any).code === '23505') {
                    const { data: existingPayment } = await supabase
                        .from('wallet_payments' as any)
                        .select('id')
                        .eq('reference', reference)
                        .single()
                    if (existingPayment) {
                        paymentId = (existingPayment as any).id
                    } else {
                        console.error('[BoostInit] Race condition: payment not found after unique constraint:', reference)
                        return NextResponse.json(
                            { error: 'Reference conflict. Please try again.' },
                            { status: 500 }
                        )
                    }
                } else {
                    console.error('[BoostInit] Failed to create payment record:', paymentInsertError?.message)
                    return NextResponse.json(
                        { error: 'Failed to create payment record. Please try again.' },
                        { status: 500 }
                    )
                }
            } else if (!paymentRow) {
                console.error('[BoostInit] Insert succeeded but no row returned')
                return NextResponse.json(
                    { error: 'Failed to create payment record. Please try again.' },
                    { status: 500 }
                )
            } else {
                paymentId = (paymentRow as any).id
            }
        }

        // ── PAYSTACK ──────────────────────────────────────────────────────────
        if (provider === 'paystack') {
            let paystackData: any
            try {
                const paystackRes = await fetch('https://api.paystack.co/transaction/initialize', {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        email: sellerEmail,
                        amount: Math.round(boostFee * 100), // pesewas
                        reference,
                        callback_url: `${process.env.NEXT_PUBLIC_APP_URL}/classifieds/seller/dashboard?boost_ref=${reference}`,
                        metadata: {
                            user_id: userId,
                            type: 'listing_boost',
                            listing_id,
                            tier,
                        },
                    }),
                })
                paystackData = await paystackRes.json()
            } catch (fetchErr: any) {
                console.error('[BoostInit] Paystack fetch error:', fetchErr.message)
                await supabase.from('wallet_payments' as any).update({ status: 'failed' }).eq('id', paymentId)
                return NextResponse.json({ error: 'Could not reach Paystack. Please try again.' }, { status: 502 })
            }

            if (!paystackData.status || !paystackData.data?.authorization_url) {
                await supabase.from('wallet_payments' as any).update({ status: 'failed' }).eq('id', paymentId)
                return NextResponse.json(
                    { error: paystackData.message || 'Paystack rejected the request. Please try again.' },
                    { status: 500 }
                )
            }

            return NextResponse.json({
                success: true,
                gateway: 'paystack',
                authorization_url: paystackData.data.authorization_url,
                reference,
            })
        }

        // ── PAYSTACK MOBILE MONEY ─────────────────────────────────────────────
        if (provider === 'paystack_momo') {
            if (!phone || !network || !paystackMomoProviderFor(network)) {
                return NextResponse.json({ error: 'Valid phone number and network are required' }, { status: 400 })
            }

            const finish = async (result: MomoChargeResult) => {
                if (!result.ok) {
                    if (result.safeToMarkFailed && !existingRef) {
                        await supabase.from('wallet_payments' as any)
                            .update({ status: 'failed' })
                            .eq('id', paymentId)
                            .eq('status', 'pending')
                    }
                    return NextResponse.json(result.body, { status: result.httpStatus })
                }
                if (result.outcome === 'paid') {
                    const { processBoostPayment } = await import('@/lib/classifieds-payments')
                    await processBoostPayment(reference, {
                        reference,
                        amount: Math.round(boostFee * 100),
                    })
                }
                return NextResponse.json(result.body)
            }

            // This route authenticates by bearer token, not cookies, so the ownership
            // check gets the userId verifyAuth already resolved.
            if (otpCode && existingRef) {
                if (!await assertOwnPendingPayment(supabase, existingRef, userId)) {
                    return NextResponse.json({ error: 'That payment is no longer waiting for a code' }, { status: 404 })
                }
                return finish(await submitPaystackMomoOtp({ reference: existingRef, otp: String(otpCode), payerPhone: phone }))
            }

            return finish(await startPaystackMomoCharge({
                reference,
                amountGhs: boostFee,
                payerPhone: phone,
                network,
                metadata: { user_id: userId, kind: 'listing_boost', listing_id: listing.id, tier },
                userId,
            }))
        }

        // ── PAYSWITCH ─────────────────────────────────────────────────────────
        if (provider === 'payswitch') {
            const { transactionId, error: txIdError } = await assignPayswitchTransactionId(supabase, { id: paymentId! })
            if (!transactionId) {
                console.error('[BoostInit] PaySwitch transaction id error:', txIdError)
                if (!existingRef) {
                    await supabase.from('wallet_payments' as any).update({ status: 'failed' }).eq('id', paymentId)
                }
                return NextResponse.json({ error: 'Could not start the payment. Please try again.' }, { status: 500 })
            }

            const payswitchResponse = await payswitchInitiatePayment({
                amount: boostFee,
                payerPhone: phone,
                network,
                transactionId,
                description: `ARHMS Listing Boost - ${tier}`,
            })

            if (!payswitchResponse.success) {
                console.error('[BoostInit] PaySwitch error:', payswitchResponse.error)
                if (!existingRef) {
                    await supabase.from('wallet_payments' as any).update({ status: 'failed' }).eq('id', paymentId)
                }
                return NextResponse.json({ error: payswitchResponse.error || 'Failed to initialize payment' }, { status: 500 })
            }

            return NextResponse.json({
                success: true,
                gateway: 'payswitch',
                reference,
                message: 'Payment prompt sent to your phone. Please approve to complete the boost.',
            })
        }

        // ── MOOLRE ────────────────────────────────────────────────────────────
        const channelId = MOOLRE_PAYMENT_CHANNEL_MAP[network]
        const moolreResponse = await initiatePayment({
            amount: boostFee,
            payerPhone: phone,
            channel: channelId,
            externalRef: reference,
            otpCode,
        })

        if (!moolreResponse.success) {
            console.error('[BoostInit] Moolre error:', moolreResponse.error)
            if (!existingRef) {
                await supabase.from('wallet_payments' as any).update({ status: 'failed' }).eq('id', paymentId)
            }
            return NextResponse.json({ error: moolreResponse.error || 'Failed to initialize payment' }, { status: 500 })
        }

        if (moolreResponse.otpRequired || moolreResponse.status === '200_OTP_REQ') {
            return NextResponse.json({
                success: true,
                gateway: 'moolre',
                otpRequired: true,
                reference,
                message: 'OTP is required. Please enter the code sent to your phone.',
            })
        }

        return NextResponse.json({
            success: true,
            gateway: 'moolre',
            reference,
            message: 'Payment prompt sent to your phone. Please approve to complete the boost.',
        })

    } catch (error: any) {
        console.error('[BoostInit] Unhandled error:', error?.message)
        return NextResponse.json({ error: `Server error: ${error?.message || 'unknown'}` }, { status: 500 })
    }
}
