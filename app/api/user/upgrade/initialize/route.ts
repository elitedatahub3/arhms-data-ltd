import { createRouteHandlerClient } from '@/lib/supabase-server'
import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'
import { generateReferenceCode } from '@/lib/utils'
import { initiatePayment, MOOLRE_PAYMENT_CHANNEL_MAP } from '@/lib/moolre-payment-service'
import { initiatePayment as hubtelInitiatePayment, HUBTEL_CHANNEL_MAP } from '@/lib/hubtel-payment-service'
import { initiatePayment as payswitchInitiatePayment, PAYSWITCH_CHANNEL_MAP } from '@/lib/payswitch-payment-service'
import { assignPayswitchTransactionId } from '@/lib/payswitch-reference'
import { resolveProviderForScope, isPaymentProvider, type PaymentProvider } from '@/lib/payment-provider'
import { paystackMomoProviderFor } from '@/lib/paystack-momo-service'
import {
    startPaystackMomoCharge,
    submitPaystackMomoOtp,
    assertOwnPendingPayment,
    type MomoChargeResult,
} from '@/lib/paystack-momo-checkout'

export async function POST(request: Request) {
    try {
        const cookieStore = await cookies()
        const supabase = await createRouteHandlerClient()
        const { data: { user: authUser }, error: authError } = await supabase.auth.getUser()

        if (authError || !authUser) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const {
            plan = '30d',
            phone,
            network,
            otpCode,
            reference: existingRef,
            provider: bodyProvider,
            paymentMethod,
        } = await request.json().catch(() => ({}));

        // Paying from the ARHMS wallet settles server-side, so there is no handset
        // prompt to approve and the role flips immediately. The gateway validation
        // below asks for a phone + network that this path never needs.
        const isWalletPayment = paymentMethod === 'wallet'

        const { data: dbUser } = await supabase
            .from('users')
            .select('role')
            .eq('id', authUser.id)
            .single()

        if (!dbUser || (dbUser.role !== 'customer' && dbUser.role !== 'agent')) {
            return NextResponse.json(
                { error: 'Membership upgrades are only available for customers and existing agents' },
                { status: 400 }
            )
        }

        const { createClient } = await import('@supabase/supabase-js')
        const supabaseAdmin = createClient(
            process.env.NEXT_PUBLIC_SUPABASE_URL!,
            process.env.SUPABASE_SERVICE_ROLE_KEY!,
            { auth: { autoRefreshToken: false, persistSession: false } }
        )

        const { data: settings } = await supabaseAdmin
            .from('admin_settings')
            .select('key, value')
            .in('key', [
                'agent_upgrade_price_3d',
                'agent_upgrade_price_14d',
                'agent_upgrade_price_30d',
                'agent_upgrade_price_permanent',
                'agent_plan_enabled_3d',
                'agent_plan_enabled_14d',
                'agent_plan_enabled_30d',
                'agent_plan_enabled_permanent',
                'active_payment_provider_web',
            ])

        const settingsMap: Record<string, any> = {}
        for (const row of (settings || [])) settingsMap[row.key] = row.value

        // Admins can switch individual plans off. Only block new checkouts — a
        // Moolre OTP submit (existingRef set) belongs to a checkout already started.
        const requestedPlan = ['3d', '14d', 'permanent'].includes(plan) ? plan : '30d'
        if (!existingRef && settingsMap[`agent_plan_enabled_${requestedPlan}`] === 'false') {
            return NextResponse.json(
                { error: 'This plan is currently unavailable. Please choose another plan.' },
                { status: 400 }
            )
        }

        // Provider resolution: body takes priority (frontend toggle), fall back to admin setting.
        // The admin setting is the only source of truth. The body used to win, which
        // let a client pick the gateway that collects its own payment — and once a
        // gateway exists that the UI has not been taught to drive, that is a request
        // shaped for one rail being charged on another. Logged rather than rejected
        // so an older client keeps working instead of failing at checkout.
        if (bodyProvider && isPaymentProvider(bodyProvider)) {
            const resolved = resolveProviderForScope(settingsMap.active_payment_provider_web, 'web')
            if (bodyProvider !== resolved) {
                console.warn(
                    `[UpgradeInitialize] Ignoring client-supplied provider '${bodyProvider}'; using '${resolved}' from active_payment_provider_web.`
                )
            }
        }
        const provider: PaymentProvider = resolveProviderForScope(
            settingsMap.active_payment_provider_web,
            'web'
        )

        // For Moolre: phone + network are required
        if (!isWalletPayment && provider === 'moolre') {
            const channelId = phone && MOOLRE_PAYMENT_CHANNEL_MAP[network]
            if (!phone || !network || !channelId) {
                return NextResponse.json({ error: 'Phone number and network are required' }, { status: 400 })
            }
        }

        // For Hubtel: phone + network are required
        if (!isWalletPayment && provider === 'hubtel') {
            if (!phone || !network || !HUBTEL_CHANNEL_MAP[network]) {
                return NextResponse.json({ error: 'Phone number and network are required for Hubtel payment' }, { status: 400 })
            }
        }

        // For PaySwitch: phone + network are required
        if (!isWalletPayment && provider === 'payswitch') {
            if (!phone || !network || !PAYSWITCH_CHANNEL_MAP[network]) {
                return NextResponse.json({ error: 'Phone number and network are required for PaySwitch payment' }, { status: 400 })
            }
        }

        const getPrice = (key: string, def: number) => {
            const val = settingsMap[key]
            return val !== undefined ? Number(val) : def
        }

        let upgradePrice = 100
        let planLabel = 'Agent Status'

        if (plan === '3d') {
            upgradePrice = getPrice('agent_upgrade_price_3d', 9.99)
            planLabel = '3 Days Agent Pass'
        } else if (plan === '14d') {
            upgradePrice = getPrice('agent_upgrade_price_14d', 49.99)
            planLabel = '14 Days Agent Pass'
        } else if (plan === 'permanent') {
            upgradePrice = getPrice('agent_upgrade_price_permanent', 149.99)
            planLabel = 'Permanent Agent Pass'
        } else {
            upgradePrice = getPrice('agent_upgrade_price_30d', 99.99)
            planLabel = '30 Days Agent Pass'
        }

        const totalAmount = upgradePrice
        const reference = existingRef || `agent_upgrade_${generateReferenceCode()}`
        const planDays = plan === 'permanent' ? null : (plan === '3d' ? 3 : (plan === '14d' ? 14 : 30))

        // ── WALLET BRANCH ────────────────────────────────────────────────────────
        // Settles entirely server-side: no gateway call, no handset prompt, no
        // polling. Returns with the role already changed.
        if (isWalletPayment) {
            const upgradeMetadata = {
                user_id: authUser.id,
                upgrade_type: 'agent',
                plan_type: plan,
                plan_days: planDays,
                plan_label: planLabel,
                base_amount: upgradePrice,
                fee: 0,
                paid_from: 'wallet',
            }

            // Atomic: the RPC only deducts when the balance covers it, so two
            // concurrent upgrade attempts cannot both succeed on one balance.
            const { data: deductResult, error: deductError } = await (supabaseAdmin as any)
                .rpc('deduct_wallet_balance', { p_user_id: authUser.id, p_amount: upgradePrice })

            if (deductError) {
                if (deductError.message?.includes('INSUFFICIENT_BALANCE')) {
                    return NextResponse.json(
                        { error: `Insufficient wallet balance. You need GHS ${upgradePrice.toFixed(2)} to upgrade.` },
                        { status: 400 }
                    )
                }
                console.error('[UpgradeInit] Wallet deduction error:', deductError)
                return NextResponse.json({ error: 'Failed to process wallet payment' }, { status: 500 })
            }

            const walletRow = deductResult?.[0] || deductResult
            const walletId = walletRow?.wallet_id
            if (!walletId) {
                return NextResponse.json({ error: 'Wallet not found' }, { status: 404 })
            }

            // Refunds the debit whenever anything after it fails — the money has
            // already left the balance by this point.
            const refund = async (why: string) => {
                console.error(`[UpgradeInit] Refunding wallet upgrade (${why}):`, reference)
                const { error: refundError } = await (supabaseAdmin as any)
                    .rpc('credit_wallet_balance', { p_user_id: authUser.id, p_amount: upgradePrice })
                if (refundError) {
                    console.error('CRITICAL: upgrade refund RPC failed for', reference, refundError)
                }
            }

            // processCompletedUpgradePayment is driven off a wallet_payments row —
            // reused rather than reimplemented so the expiry maths, the extend-vs-new
            // distinction, the notification and the SMS stay in exactly one place.
            const { error: paymentInsertError } = await (supabaseAdmin.from('wallet_payments') as any)
                .insert({
                    user_id: authUser.id,
                    wallet_id: walletId,
                    amount: upgradePrice,
                    fee: 0,
                    total_amount: upgradePrice,
                    reference,
                    provider: 'wallet',
                    status: 'pending',
                    metadata: upgradeMetadata,
                })

            if (paymentInsertError) {
                console.error('[UpgradeInit] wallet_payments insert failed:', paymentInsertError)
                await refund('payment record insert failed')
                return NextResponse.json({ error: 'Failed to record upgrade payment' }, { status: 500 })
            }

            ;(supabaseAdmin.from('wallet_transactions') as any).insert({
                wallet_id: walletId,
                user_id: authUser.id,
                type: 'debit',
                amount: upgradePrice,
                description: `Agent upgrade: ${planLabel}`,
                reference,
                source: 'purchase',
                status: 'completed',
            }).then(({ error }: any) => {
                if (error) console.error('[UpgradeInit] wallet_transactions insert failed:', error)
            })

            const { processCompletedUpgradePayment } = await import('@/lib/payments')
            const result = await processCompletedUpgradePayment(reference, {
                reference,
                amount: Math.round(upgradePrice * 100),
                metadata: upgradeMetadata,
            })

            if (!result?.success) {
                console.error('[UpgradeInit] Upgrade processing failed:', result?.error)
                await (supabaseAdmin.from('wallet_payments') as any)
                    .update({ status: 'failed' })
                    .eq('reference', reference)
                await refund('upgrade processing failed')
                return NextResponse.json(
                    { error: result?.error || 'Failed to activate upgrade. Your wallet has been refunded.' },
                    { status: 500 }
                )
            }

            return NextResponse.json({
                success: true,
                gateway: 'wallet',
                activated: true,
                reference,
                message: `${planLabel} activated. Welcome aboard!`,
            })
        }

        const { data: wallet } = await supabaseAdmin
            .from('wallets')
            .select('id')
            .eq('user_id', authUser.id)
            .single()

        if (!wallet) throw new Error('User wallet not found')

        const { error: paymentError } = await (supabaseAdmin.from('wallet_payments') as any)
            .insert({
                user_id: authUser.id,
                wallet_id: (wallet as any).id,
                amount: upgradePrice,
                fee: 0,
                total_amount: upgradePrice,
                reference,
                provider,
                status: 'pending',
                metadata: {
                    user_id: authUser.id,
                    upgrade_type: 'agent',
                    plan_type: plan,
                    plan_days: planDays,
                    plan_label: planLabel,
                    base_amount: upgradePrice,
                    fee: 0,
                },
            })

        if (!existingRef && paymentError) {
            console.error('[UpgradeInit] Database error:', paymentError)
            throw new Error('Failed to record payment attempt')
        }

        // ── PAYSTACK BRANCH ──────────────────────────────────────────────────────
        if (provider === 'paystack') {
            const { data: userProfile } = await supabaseAdmin
                .from('users')
                .select('email')
                .eq('id', authUser.id)
                .single()

            const paystackRes = await fetch('https://api.paystack.co/transaction/initialize', {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    email: (userProfile as any)?.email,
                    amount: Math.round(upgradePrice * 100), // kobo
                    reference,
                    callback_url: `${process.env.NEXT_PUBLIC_APP_URL}/dashboard/upgrade?reference=${reference}`,
                    metadata: {
                        upgrade_type: 'agent',
                        plan_type: plan,
                        plan_days: planDays,
                        plan_label: planLabel,
                    },
                }),
            })

            const paystackData = await paystackRes.json()

            if (!paystackData.status) {
                console.error('[UpgradeInit] Paystack init failed:', paystackData)
                await (supabaseAdmin.from('wallet_payments') as any).update({ status: 'failed' }).eq('reference', reference)
                return NextResponse.json({ error: 'Payment gateway error' }, { status: 500 })
            }

            return NextResponse.json({
                success: true,
                gateway: 'paystack',
                authorization_url: paystackData.data.authorization_url,
                reference,
            })
        }

        // ── PAYSTACK MOBILE MONEY BRANCH ────────────────────────────────────────
        if (provider === 'paystack_momo') {
            if (!phone || !network || !paystackMomoProviderFor(network)) {
                return NextResponse.json({ error: 'Valid phone number and network are required' }, { status: 400 })
            }

            const finish = async (result: MomoChargeResult) => {
                if (!result.ok) {
                    if (result.safeToMarkFailed && !existingRef) {
                        await (supabaseAdmin.from('wallet_payments') as any)
                            .update({ status: 'failed' })
                            .eq('reference', reference)
                            .eq('status', 'pending')
                    }
                    return NextResponse.json(result.body, { status: result.httpStatus })
                }
                if (result.outcome === 'paid') {
                    const { processCompletedUpgradePayment } = await import('@/lib/payments')
                    await processCompletedUpgradePayment(reference, {
                        reference,
                        amount: Math.round(totalAmount * 100),
                        metadata: { upgrade_type: 'agent' },
                    })
                }
                return NextResponse.json(result.body)
            }

            if (otpCode && existingRef) {
                if (!await assertOwnPendingPayment(supabaseAdmin, existingRef, authUser.id)) {
                    return NextResponse.json({ error: 'That payment is no longer waiting for a code' }, { status: 404 })
                }
                return finish(await submitPaystackMomoOtp({ reference: existingRef, otp: String(otpCode), payerPhone: phone }))
            }

            return finish(await startPaystackMomoCharge({
                reference,
                amountGhs: totalAmount,
                payerPhone: phone,
                network,
                metadata: { user_id: authUser.id, upgrade_type: 'agent', kind: 'agent_upgrade' },
                userId: authUser.id,
            }))
        }

        // ── HUBTEL BRANCH ───────────────────────────────────────────────────────
        if (provider === 'hubtel') {
            const hubtelChannel = HUBTEL_CHANNEL_MAP[network]
            const hubtelResponse = await hubtelInitiatePayment({
                amount: totalAmount,
                payerPhone: phone,
                channel: hubtelChannel,
                clientReference: reference,
                description: `ARHMS Agent Upgrade - ${planLabel}`,
                userId: authUser.id,
            })

            if (!hubtelResponse.success) {
                throw new Error(hubtelResponse.error || 'Failed to initialize Hubtel payment')
            }

            return NextResponse.json({
                success: true,
                gateway: 'hubtel',
                reference,
                message: 'Payment prompt sent to your phone. Please approve to continue.',
            })
        }

        // ── PAYSWITCH BRANCH ───────────────────────────────────────────────
        if (provider === 'payswitch') {
            const { transactionId, error: txIdError } = await assignPayswitchTransactionId(supabaseAdmin, { reference })
            if (!transactionId) {
                console.error('[UpgradeInit] PaySwitch transaction id error:', txIdError)
                await (supabaseAdmin.from('wallet_payments') as any).update({ status: 'failed' }).eq('reference', reference)
                throw new Error('Could not start the payment. Please try again.')
            }

            const payswitchResponse = await payswitchInitiatePayment({
                amount: totalAmount,
                payerPhone: phone,
                network,
                transactionId,
                description: `ARHMS Agent Upgrade - ${planLabel}`,
            })

            if (!payswitchResponse.success) {
                await (supabaseAdmin.from('wallet_payments') as any).update({ status: 'failed' }).eq('reference', reference)
                throw new Error(payswitchResponse.error || 'Failed to initialize PaySwitch payment')
            }

            return NextResponse.json({
                success: true,
                gateway: 'payswitch',
                reference,
                message: 'Payment prompt sent to your phone. Please approve to continue.',
            })
        }

        // ── MOOLRE BRANCH ──────────────────────────────────────────────────
        const channelId = MOOLRE_PAYMENT_CHANNEL_MAP[network]

        let moolreResponse = await initiatePayment({
            amount: totalAmount,
            payerPhone: phone,
            channel: channelId,
            externalRef: reference,
            otpCode,
        })

        if (moolreResponse.success && String(moolreResponse.status) === '1' && otpCode) {
            console.log('[UpgradeInit] OTP verified successfully. Sending follow-up payment request.')
            moolreResponse = await initiatePayment({
                amount: totalAmount,
                payerPhone: phone,
                channel: channelId,
                externalRef: reference,
            })
        }

        if (!moolreResponse.success) {
            throw new Error(moolreResponse.error || 'Failed to initialize payment')
        }

        if (moolreResponse.status === '200_OTP_REQ') {
            return NextResponse.json({
                success: true,
                gateway: 'moolre',
                otpRequired: true,
                reference,
                message: 'OTP is required to complete this payment. Please enter the code sent to your phone.',
            })
        }

        return NextResponse.json({
            success: true,
            gateway: 'moolre',
            reference,
            message: 'Payment prompt sent to your phone. Please approve to continue.',
        })
    } catch (error: any) {
        console.error('Error initializing agent upgrade:', error)
        return NextResponse.json(
            { error: error.message || 'Failed to initialize upgrade' },
            { status: 500 }
        )
    }
}
