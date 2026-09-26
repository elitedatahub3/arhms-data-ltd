import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createClient } from '@supabase/supabase-js'
import { calculatePaystackFee, generateReferenceCode } from '@/lib/utils'
import { initiatePayment, MOOLRE_PAYMENT_CHANNEL_MAP } from '@/lib/moolre-payment-service'
import { initiatePayment as hubtelInitiatePayment, HUBTEL_CHANNEL_MAP, calculateHubtelFee, toHubtelMsisdn } from '@/lib/hubtel-payment-service'
import { checkHubtelPromptLimit, recordHubtelPrompt } from '@/lib/hubtel-prompt-limit'
import { initiatePayment as payswitchInitiatePayment, PAYSWITCH_CHANNEL_MAP } from '@/lib/payswitch-payment-service'
import { assignPayswitchTransactionId } from '@/lib/payswitch-reference'
import { resolveProviderForScope, type PaymentProvider } from '@/lib/payment-provider'
import { WEB_FEE_SETTING_KEYS, resolveWebFeePercent } from '@/lib/gateway-fees'
import { paystackMomoProviderFor } from '@/lib/paystack-momo-service'
import {
    startPaystackMomoCharge,
    submitPaystackMomoOtp,
    assertOwnPendingPayment,
    type MomoChargeResult,
} from '@/lib/paystack-momo-checkout'

// Build admin client safely — returns null with an error string if env vars are missing
function buildAdminClient(): { client: ReturnType<typeof createClient> | null; error: string | null } {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!url) return { client: null, error: 'NEXT_PUBLIC_SUPABASE_URL is not set on server' }
    if (!key) return { client: null, error: 'SUPABASE_SERVICE_ROLE_KEY is not set on server' }
    return {
        client: createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } }),
        error: null,
    }
}

export async function POST(request: NextRequest) {
    // ── Step 0: Maintenance mode ──────────────────────────────────────────────
    if (process.env.NEXT_PUBLIC_PAYMENT_MAINTENANCE_MODE === 'true') {
        return NextResponse.json(
            { error: 'Payment system is currently under maintenance. Please try again later.' },
            { status: 503 }
        )
    }

    // ── Step 1: Build admin client (checks env vars without throwing) ─────────
    const { client, error: adminError } = buildAdminClient()
    if (!client) {
        console.error('[WalletInit] Admin client error:', adminError)
        return NextResponse.json(
            { error: 'Server configuration error. Please contact support. (DB)' },
            { status: 503 }
        )
    }
    const supabaseAdmin = client as any

    try {
        // ── Step 2: Parse request body ────────────────────────────────────────
        let body: any
        try {
            body = await request.json()
        } catch {
            return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
        }
        // bodyProvider is any PaymentProvider a stale tab may still be sending; it is
        // logged and ignored — see the provider resolution below.
        const { amount, phone, network, otpCode, reference: existingRef, provider: bodyProvider } = body

        // ── Step 3: Validate amount ───────────────────────────────────────────
        const MAX_TOPUP_AMOUNT = Number(process.env.MAX_WALLET_TOPUP_AMOUNT) || 10000
        if (!amount || typeof amount !== 'number' || amount < 5 || amount > MAX_TOPUP_AMOUNT) {
            return NextResponse.json(
                { error: `Amount must be between GHS 5 and GHS ${MAX_TOPUP_AMOUNT.toLocaleString()}` },
                { status: 400 }
            )
        }

        // ── Step 4: Authenticate user ─────────────────────────────────────────
        const supabase = await createRouteClient()
        const { data: { user: authUser }, error: authError } = await supabase.auth.getUser()
        if (!authUser) {
            console.error('[WalletInit] Auth failed:', authError?.message)
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }
        const userId = authUser.id

        // ── Step 5: Load user profile + settings ──────────────────────────────
        const [{ data: user }, { data: userRoleData }, { data: feeData }] = await Promise.all([
            supabaseAdmin.from('users' as any).select('email').eq('id', userId).single(),
            supabaseAdmin.from('users' as any).select('role').eq('id', userId).single(),
            supabaseAdmin.from('admin_settings' as any).select('key, value').in('key', [
                ...WEB_FEE_SETTING_KEYS,
                'active_payment_provider_web',
            ]),
        ])

        const settingsMap: Record<string, any> = {}
        for (const row of ((feeData as any[]) || [])) settingsMap[row.key] = row.value

        // Provider resolution: the admin setting is the ONLY source of truth.
        //
        // The body used to win here, left over from a frontend provider toggle that no
        // longer exists (the wallet UI states the provider is admin-chosen). That made
        // the setting unenforceable: a page loaded before an admin switched providers
        // keeps the old value in React state and forces it on every subsequent payment.
        // When a provider is switched off *because it is broken*, those stale tabs keep
        // hitting the dead gateway and the switch appears to do nothing.
        //
        // Matches how /api/vouchers/gateway-init and /api/orders/gateway-init already
        // resolve the gateway.
        const provider: PaymentProvider = resolveProviderForScope(settingsMap.active_payment_provider_web, 'web')

        if (bodyProvider && bodyProvider !== provider) {
            console.warn(
                `[WalletInit] Ignoring client-supplied provider "${bodyProvider}" — admin setting is "${provider}". ` +
                'Likely a stale tab opened before the provider was changed.'
            )
        }
        console.log('[WalletInit] provider:', provider, '| userId:', userId)

        // ── Step 6: Validate provider-specific inputs ─────────────────────────
        if (provider === 'moolre' && (!phone || !network || !MOOLRE_PAYMENT_CHANNEL_MAP[network])) {
            return NextResponse.json({ error: 'Valid phone number and network are required' }, { status: 400 })
        }

        if (provider === 'hubtel' && (!phone || !network || !HUBTEL_CHANNEL_MAP[network])) {
            return NextResponse.json({ error: 'Valid phone number and network are required for Hubtel payment' }, { status: 400 })
        }

        if (provider === 'payswitch' && (!phone || !network || !PAYSWITCH_CHANNEL_MAP[network])) {
            return NextResponse.json({ error: 'Valid phone number and network are required for PaySwitch payment' }, { status: 400 })
        }

        if (provider === 'paystack_momo' && (!phone || !network || !paystackMomoProviderFor(network))) {
            return NextResponse.json({ error: 'Valid phone number and network are required for mobile money payment' }, { status: 400 })
        }

        if (provider === 'paystack') {
            if (!process.env.PAYSTACK_SECRET_KEY) {
                console.error('[WalletInit] PAYSTACK_SECRET_KEY missing on Vercel!')
                return NextResponse.json(
                    { error: 'Payment gateway is not configured on this server. Please contact support.' },
                    { status: 503 }
                )
            }
            if (!process.env.NEXT_PUBLIC_APP_URL) {
                console.error('[WalletInit] NEXT_PUBLIC_APP_URL missing on Vercel!')
                return NextResponse.json(
                    { error: 'App URL is not configured on this server. Please contact support.' },
                    { status: 503 }
                )
            }
        }

        // ── Step 7: Get or create wallet ──────────────────────────────────────
        let { data: wallet } = await (supabaseAdmin.from('wallets' as any))
            .select('id')
            .eq('user_id', userId)
            .single()

        if (!wallet) {
            const { data: newWallet, error: walletError } = await (supabaseAdmin.from('wallets' as any))
                .insert({ user_id: userId })
                .select()
                .single()
            if (walletError || !newWallet) {
                console.error('[WalletInit] Wallet create failed:', walletError?.message)
                return NextResponse.json({ error: 'Failed to initialize wallet. Please try again.' }, { status: 500 })
            }
            wallet = newWallet
        }

        // ── Step 8: Calculate fees ────────────────────────────────────────────
        let fee: number
        let totalAmount: number

        if (provider === 'hubtel') {
            // Hubtel: fixed 1.8% fee (or from HUBTEL_FEE_PERCENT env var)
            const hubtelFees = calculateHubtelFee(amount)
            fee = hubtelFees.fee
            totalAmount = hubtelFees.total
        } else {
            // Paystack / Paystack MoMo / Moolre: admin-configured percent, resolved
            // through the shared ladder so this and the settlement side cannot drift.
            const feePercent = resolveWebFeePercent(settingsMap, {
                role: (userRoleData as any)?.role,
                provider,
            })
            fee = calculatePaystackFee(amount, feePercent)
            totalAmount = amount + fee
        }

        const reference = existingRef || `WAL-${generateReferenceCode()}`
        let paymentId: string | null = null

        // ── Step 9: Find or create wallet_payments record ─────────────────────
        if (existingRef) {
            const { data: existingPayment } = await (supabaseAdmin.from('wallet_payments' as any))
                .select('id')
                .eq('reference', existingRef)
                .single()
            if (existingPayment) paymentId = (existingPayment as any).id
        }

        if (!paymentId) {
            const { data: payment, error: paymentError } = await (supabaseAdmin.from('wallet_payments' as any))
                .insert({
                    user_id: userId,
                    wallet_id: (wallet as any).id,
                    amount,
                    fee,
                    total_amount: totalAmount,
                    reference,
                    provider,
                    status: 'pending',
                    metadata: { user_id: userId, amount, fee },
                })
                .select()
                .single()

            if (paymentError || !payment) {
                console.error('[WalletInit] wallet_payments insert error:', paymentError?.message, paymentError?.code)
                return NextResponse.json(
                    { error: `Failed to create payment record: ${paymentError?.message || 'unknown error'}` },
                    { status: 500 }
                )
            }
            paymentId = (payment as any).id
        }

        /**
         * Turns a MoMo charge result into this route's response.
         *
         * The `safeToMarkFailed` guard is the important part. A duplicate-reference
         * refusal and a thrown fetch both leave a charge that may exist, and a row
         * stamped 'failed' can never be settled afterwards — the webhook and every
         * processor act only on the pending -> completed transition. Marking those
         * failed is how money gets taken for nothing delivered.
         */
        const finishWalletMomo = async (result: MomoChargeResult) => {
            if (!result.ok) {
                if (result.safeToMarkFailed && !existingRef) {
                    await (supabaseAdmin.from('wallet_payments' as any))
                        .update({ status: 'failed', updated_at: new Date().toISOString() })
                        .eq('id', paymentId)
                        .eq('status', 'pending')
                }
                return NextResponse.json(result.body, { status: result.httpStatus })
            }

            if (result.outcome === 'paid') {
                // Idempotent, so a webhook arriving afterwards is a no-op. Worth doing
                // because 'success' on the charge means the money has already left the
                // customer's wallet while they watch a spinner.
                const { processCompletedWalletPayment } = await import('@/lib/payments')
                await processCompletedWalletPayment(
                    reference,
                    { reference, amount: Math.round(totalAmount * 100), metadata: { user_id: userId } },
                    userId
                )
            }
            return NextResponse.json(result.body)
        }

        // ── Step 10a0: PAYSTACK MOBILE MONEY ──────────────────────────────────
        // The Charge API, not transaction/initialize: the prompt goes straight to the
        // handset and there is no page to redirect to. Modelled on
        // /api/shop/ussd/activate, which has collected this way since USSD activation
        // moved to Paystack.
        if (provider === 'paystack_momo') {
            // An OTP finishes the charge that already exists. Nothing new is minted —
            // Paystack refuses a second charge on the same reference, and re-sending
            // one is how a customer ends up paying twice.
            if (otpCode && existingRef) {
                if (!await assertOwnPendingPayment(supabaseAdmin, existingRef, userId)) {
                    return NextResponse.json(
                        { error: 'That payment is no longer waiting for a code' },
                        { status: 404 }
                    )
                }
                const otpResult = await submitPaystackMomoOtp({ reference: existingRef, otp: String(otpCode), payerPhone: phone })
                return finishWalletMomo(otpResult)
            }

            const charge = await startPaystackMomoCharge({
                reference,
                amountGhs: totalAmount,
                payerPhone: phone,
                network,
                email: (user as any)?.email,
                metadata: { user_id: userId, amount, fee, kind: 'wallet_topup' },
                userId,
            })
            return finishWalletMomo(charge)
        }

        // ── Step 10a: PAYSTACK ────────────────────────────────────────────────
        if (provider === 'paystack') {
            const userEmail = (user as any)?.email
            if (!userEmail) {
                console.error('[WalletInit] No email for userId:', userId)
                return NextResponse.json(
                    { error: 'Account email is required for Paystack. Please update your profile.' },
                    { status: 400 }
                )
            }

            let paystackData: any
            try {
                const paystackRes = await fetch('https://api.paystack.co/transaction/initialize', {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        email: userEmail,
                        amount: Math.round(totalAmount * 100), // pesewas
                        reference,
                        callback_url: `${process.env.NEXT_PUBLIC_APP_URL}/dashboard/wallet?reference=${reference}`,
                        metadata: { user_id: userId, amount, fee, type: 'wallet_topup' },
                    }),
                })
                paystackData = await paystackRes.json()
                console.log('[WalletInit] Paystack HTTP:', paystackRes.status, '| status:', paystackData.status, '| message:', paystackData.message)
            } catch (fetchErr: any) {
                console.error('[WalletInit] Paystack fetch error:', fetchErr.message)
                await (supabaseAdmin.from('wallet_payments' as any)).update({ status: 'failed' }).eq('id', paymentId)
                return NextResponse.json({ error: 'Could not reach Paystack. Please try again.' }, { status: 502 })
            }

            if (!paystackData.status || !paystackData.data?.authorization_url) {
                await (supabaseAdmin.from('wallet_payments' as any)).update({ status: 'failed' }).eq('id', paymentId)
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

        // ── Step 10b: HUBTEL ──────────────────────────────────────────────────
        if (provider === 'hubtel') {
            // Use the phone number submitted by the user, falling back to the profile number.
            const { data: profileForPhone } = await (supabaseAdmin.from('users' as any))
                .select('phone_number')
                .eq('id', userId)
                .single()

            const registeredPhone = (profileForPhone as any)?.phone_number
            const submittedMsisdn = toHubtelMsisdn(phone || '')
            const payerPhone = submittedMsisdn || registeredPhone

            if (!payerPhone) {
                return NextResponse.json(
                    { error: 'No phone number found. Please enter a Mobile Money number.' },
                    { status: 400 }
                )
            }

            // Applies to trusted numbers too — see lib/hubtel-prompt-limit.ts.
            const promptLimit = await checkHubtelPromptLimit(payerPhone)
            if (!promptLimit.allowed) {
                if (!existingRef) {
                    await (supabaseAdmin.from('wallet_payments' as any)).update({ status: 'failed' }).eq('id', paymentId)
                }
                return NextResponse.json({ error: promptLimit.error }, { status: 429 })
            }

            // Record who actually pays, so the webhook can attribute usage stats.
            await (supabaseAdmin.from('wallet_payments' as any))
                .update({ metadata: { user_id: userId, amount, fee, payer_msisdn: toHubtelMsisdn(payerPhone) } })
                .eq('id', paymentId)

            const hubtelChannel = HUBTEL_CHANNEL_MAP[network]
            const hubtelResponse = await hubtelInitiatePayment({
                amount: totalAmount,
                payerPhone,   // registered number, or an OTP-verified alternate
                channel: hubtelChannel,
                clientReference: reference,
                description: 'ARHMS Wallet Top-up',
                userId,
            })

            if (!hubtelResponse.success) {
                console.error('[WalletInit] Hubtel error:', hubtelResponse.error)
                if (!existingRef) {
                    await (supabaseAdmin.from('wallet_payments' as any)).update({ status: 'failed' }).eq('id', paymentId)
                }
                return NextResponse.json({ error: hubtelResponse.error || 'Failed to initialize Hubtel payment' }, { status: 500 })
            }

            // Only now has a prompt actually gone to the handset.
            await recordHubtelPrompt(payerPhone)

            return NextResponse.json({
                success: true,
                gateway: 'hubtel',
                reference,
                message: 'Payment prompt sent to your phone. Please approve to complete top-up.',
            })
        }

        // ── Step 10c: PAYSWITCH ───────────────────────────────────────────────
        if (provider === 'payswitch') {
            // TheTeller identifies the payment by a 12-digit numeric id, not by our
            // reference. Claim one on the payment row first: the unique index makes
            // the write itself the guarantee that no two payments share a gateway id.
            const { transactionId, error: txIdError } = await assignPayswitchTransactionId(supabaseAdmin, { id: paymentId! })
            if (!transactionId) {
                console.error('[WalletInit] PaySwitch transaction id error:', txIdError)
                if (!existingRef) {
                    await (supabaseAdmin.from('wallet_payments' as any)).update({ status: 'failed' }).eq('id', paymentId)
                }
                return NextResponse.json({ error: 'Could not start the payment. Please try again.' }, { status: 500 })
            }

            const payswitchResponse = await payswitchInitiatePayment({
                amount: totalAmount,
                payerPhone: phone,
                network,
                transactionId,
                description: 'ARHMS Wallet Top-up',
            })

            // Kept for support triage — the gateway's own words about this attempt.
            // Read-modify-write, not a replace: on the existingRef retry path this
            // metadata already carries the status-check throttle counters, and
            // clobbering them would hand the payment a fresh polling budget.
            const { data: currentPayment } = await (supabaseAdmin.from('wallet_payments' as any))
                .select('metadata')
                .eq('id', paymentId)
                .single()

            await (supabaseAdmin.from('wallet_payments' as any))
                .update({
                    metadata: {
                        ...(((currentPayment as any)?.metadata) || {}),
                        user_id: userId,
                        amount,
                        fee,
                        payswitch: { transaction_id: transactionId, initiate: payswitchResponse.raw ?? null },
                    },
                })
                .eq('id', paymentId)

            if (!payswitchResponse.success) {
                console.error('[WalletInit] PaySwitch error:', payswitchResponse.error)
                if (!existingRef) {
                    await (supabaseAdmin.from('wallet_payments' as any)).update({ status: 'failed' }).eq('id', paymentId)
                }
                return NextResponse.json({ error: payswitchResponse.error || 'Failed to initialize PaySwitch payment' }, { status: 500 })
            }

            return NextResponse.json({
                success: true,
                gateway: 'payswitch',
                reference,
                message: 'Payment prompt sent to your phone. Please approve to complete top-up.',
            })
        }

        // ── Step 10d: MOOLRE ──────────────────────────────────────────────────
        const channelId = MOOLRE_PAYMENT_CHANNEL_MAP[network]
        let moolreResponse = await initiatePayment({
            amount: totalAmount,
            payerPhone: phone,
            channel: channelId,
            externalRef: reference,
            otpCode,
        })

        if (moolreResponse.success && String(moolreResponse.status) === '1' && otpCode) {
            moolreResponse = await initiatePayment({ amount: totalAmount, payerPhone: phone, channel: channelId, externalRef: reference })
        }

        if (!moolreResponse.success) {
            console.error('[WalletInit] Moolre error:', moolreResponse.error)
            if (!existingRef) {
                await (supabaseAdmin.from('wallet_payments' as any)).update({ status: 'failed' }).eq('id', paymentId)
            }
            return NextResponse.json({ error: moolreResponse.error || 'Failed to initialize payment' }, { status: 500 })
        }

        if (moolreResponse.status === '200_OTP_REQ') {
            return NextResponse.json({
                success: true, gateway: 'moolre', otpRequired: true, reference,
                message: 'OTP is required to complete this payment. Please enter the code sent to your phone.',
            })
        }

        return NextResponse.json({
            success: true, gateway: 'moolre', reference,
            message: 'Payment prompt sent to your phone. Please approve to complete top-up.',
        })

    } catch (error: any) {
        console.error('[WalletInit] Unhandled exception at step:', error?.message, error?.stack?.split('\n')[1])
        return NextResponse.json({ error: `Server error: ${error?.message || 'unknown'}` }, { status: 500 })
    }
}
