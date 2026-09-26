import { createRouteHandlerClient } from '@/lib/supabase-server'
import { NextResponse } from 'next/server'
import { generateReferenceCode } from '@/lib/utils'
import { initiatePayment as hubtelInitiatePayment, HUBTEL_CHANNEL_MAP } from '@/lib/hubtel-payment-service'
import {
    chargeMobileMoney as paystackChargeMobileMoney,
    submitOtp as paystackSubmitOtp,
    paystackMomoProviderFor,
} from '@/lib/paystack-momo-service'
import { resolveProviderForScope, SCOPE_SETTING_KEY } from '@/lib/payment-provider'
import { resolveSubAgentContext, type SubAgentContext } from '@/lib/sub-agents'
import { isUssdEnabled, USSD_ENABLED_KEY, USSD_UNAVAILABLE_MESSAGE } from '@/lib/ussd-availability'

/**
 * USSD short-code activation â€” a one-time, lifetime purchase.
 *
 * Modelled on /api/user/upgrade/initialize: the wallet branch settles entirely
 * server-side, while the gateway branch leaves a pending `wallet_payments` row
 * that the gateway's webhook settles through processCompletedUssdActivation.
 *
 * Mobile money goes through Paystack, matching the rest of the USSD stack: the
 * dial-in service moved to Paystack Mobile Money and this purchase followed it.
 * The gateway comes from the 'ussd' payment scope, the same registry the web and shop
 * scopes use - selecting 'hubtel' there puts both this route and the
 * dial-in service back on the old gateway, from the admin settings page and with no
 * deploy.
 *
 * The reference is prefixed `ussd_activation_` (not `SHOPUSSD-`) so it routes
 * through the webhooks' existing wallet_payments lookup, which already does the
 * idempotency and paid-amount checks for every `*_upgrade_`-style purchase.
 */

/**
 * admin_settings key naming which gateway collects. Shared with the dial-in service.
 *
 * The old ussd_payment_provider key is gone: USSD is a payment scope now, resolved
 * through lib/payment-provider.ts like every other area of the app. The fallback
 * lives in SCOPE_FALLBACK_PROVIDER there and is 'paystack_momo' rather than the
 * global Moolre default, for the reason that used to be written here â€” this switch
 * does not decide WHETHER to take money, only which gateway takes it, so a missing
 * row must route to the live gateway rather than strand a paying customer on a
 * retired one, or on one with no USSD branch at all.
 */
const USSD_PROVIDER_KEY = SCOPE_SETTING_KEY.ussd

const PRICE_KEYS = [
    'ussd_activation_price_customer',
    'ussd_activation_price_agent',
    'ussd_activation_price_dealer',
    'ussd_activation_price_sub',
] as const

/**
 * Sub-agents are priced on their membership, not their role: a sub's users.role
 * is 'customer', so without this they would pay the most expensive tier.
 */
function priceKeyForRole(role: string, isSub: boolean): string {
    if (isSub) return 'ussd_activation_price_sub'
    if (role === 'dealer' || role === 'dealership') return 'ussd_activation_price_dealer'
    if (role === 'agent') return 'ussd_activation_price_agent'
    return 'ussd_activation_price_customer'
}

const DEFAULT_PRICE: Record<string, number> = {
    ussd_activation_price_customer: 50,
    ussd_activation_price_agent: 40,
    ussd_activation_price_dealer: 30,
    ussd_activation_price_sub: 40,
}

async function loadContext() {
    const supabase = await createRouteHandlerClient()
    const { data: { user: authUser }, error: authError } = await supabase.auth.getUser()
    if (authError || !authUser) return { error: 'Unauthorized' as const, status: 401 }

    const { createClient } = await import('@supabase/supabase-js')
    const supabaseAdmin = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!,
        { auth: { autoRefreshToken: false, persistSession: false } }
    )

    const { data: dbUser } = await supabaseAdmin
        .from('users')
        .select('role')
        .eq('id', authUser.id)
        .single()

    const { data: shop } = await supabaseAdmin
        .from('shop_profiles')
        .select('id, shop_name, approval_status, is_active, ussd_status, ussd_code')
        .eq('owner_id', authUser.id)
        .maybeSingle()

    const { data: settings } = await supabaseAdmin
        .from('admin_settings')
        .select('key, value')
        .in('key', [...PRICE_KEYS, 'ussd_dial_code', USSD_ENABLED_KEY, USSD_PROVIDER_KEY])

    const settingsMap: Record<string, any> = {}
    for (const row of (settings || [])) settingsMap[row.key] = row.value

    // Membership + the upline's live eligibility. A sub whose Lead has lapsed
    // could not sell through the code, so they must not be sold one.
    const sub = await resolveSubAgentContext(supabaseAdmin, authUser.id)

    const role = (dbUser as any)?.role || 'customer'
    const priceKey = priceKeyForRole(role, sub.isSub)
    const raw = settingsMap[priceKey]
    const price = raw !== undefined && raw !== '' ? Number(raw) : DEFAULT_PRICE[priceKey]

    return { authUser, supabaseAdmin, shop: shop as any, role, price, settingsMap, sub }
}

/**
 * The reason a caller cannot activate right now, or null when they can.
 *
 * A sub is gated on their OWN membership only. Deliberately NOT gated on the
 * upline's canOwnSubNetwork() eligibility: almost every live Lead is role
 * 'customer' with no dealer subscription, yet their networks sell every day â€”
 * the sub's storefront applies no such check either, so enforcing it at the
 * short-code till would block paying subs for a state they cannot fix.
 */
function activationBlockReason(shop: any, sub: SubAgentContext): string | null {
    if (!shop) return 'You need a shop before you can activate a short code'
    if (shop.approval_status !== 'approved') return 'Your shop must be approved before activating a short code'
    if (sub.isSub && sub.status !== 'active') {
        return sub.status === 'suspended'
            ? 'Your sub-agent account is suspended. Contact your Lead to be reinstated.'
            : 'Your account is still awaiting approval from your Lead'
    }
    return null
}

/**
 * Turns a Paystack charge (or OTP) outcome into the response the activation panel
 * understands, settling inline when Paystack says the money is already in.
 *
 * Inline settlement is safe: processCompletedUssdActivation() is idempotent on the
 * wallet_payments status transition, so the webhook arriving afterwards is a no-op.
 * It is worth doing because a 'success' on the charge call means the buyer is
 * watching a spinner for money that has already left their wallet.
 *
 * Anything that is not a decline stays pending on purpose. A charge we could not
 * classify may still come good, and the webhook plus the reconciliation sweep in
 * /api/cron/verify-paystack-momo-payments both settle from that pending row.
 */
async function respondToPaystackOutcome(params: {
    supabaseAdmin: any
    charge: { outcome: string; displayText: string | null; message: string | null }
    reference: string
    price: number
    metadata: Record<string, any>
    dialCode: string
}) {
    const { supabaseAdmin, charge, reference, price, metadata, dialCode } = params

    if (charge.outcome === 'failed') {
        await (supabaseAdmin.from('wallet_payments') as any)
            .update({ status: 'failed', updated_at: new Date().toISOString() })
            .eq('reference', reference)
            .eq('status', 'pending')
        return NextResponse.json(
            { error: charge.message || 'The charge was declined. Please try again.' },
            { status: 502 }
        )
    }

    if (charge.outcome === 'otp') {
        return NextResponse.json({
            success: true,
            gateway: 'paystack',
            otpRequired: true,
            reference,
            message: charge.displayText || 'Enter the one-time code sent to your phone.',
        })
    }

    if (charge.outcome === 'paid') {
        const { processCompletedUssdActivation } = await import('@/lib/payments')
        const result = await processCompletedUssdActivation(reference, {
            reference,
            amount: Math.round(price * 100),
            metadata,
        })

        if (result?.success && (result as any).shortCode) {
            return NextResponse.json({
                success: true,
                gateway: 'paystack',
                activated: true,
                reference,
                shortCode: (result as any).shortCode,
                dialCode,
                message: `Your USSD short code is ${(result as any).shortCode}.`,
            })
        }

        // Paid, but we could not finish it here. Left pending deliberately so the
        // webhook and the sweep can, and reported as a normal prompt so the page
        // keeps polling rather than telling the buyer their money vanished.
        console.error('[UssdActivate] Inline settlement failed for a paid charge:', reference, result?.error)
    }

    return NextResponse.json({
        success: true,
        gateway: 'paystack',
        reference,
        message: charge.displayText || 'Payment prompt sent to your phone. Please approve to continue.',
    })
}

/**
 * Finishes a charge that answered 'send_otp' â€” Telecel and AirtelTigo ask the payer
 * to type a code rather than approve a prompt.
 *
 * The reference arrives from the client, so it is resolved against THIS caller's own
 * pending activation row before Paystack is told anything. Without that check the
 * endpoint would happily submit codes against a stranger's charge.
 */
async function submitActivationOtp(params: {
    supabaseAdmin: any
    userId: string
    reference: string
    otp: string
    dialCode: string
}) {
    const { supabaseAdmin, userId, reference, otp, dialCode } = params

    if (!reference || !otp) {
        return NextResponse.json({ error: 'Enter the code you were sent' }, { status: 400 })
    }

    const { data: payment } = await supabaseAdmin
        .from('wallet_payments')
        .select('reference, total_amount, metadata')
        .eq('reference', reference)
        .eq('user_id', userId)
        .eq('status', 'pending')
        .maybeSingle()

    if (!payment) {
        return NextResponse.json({ error: 'That payment is no longer waiting for a code' }, { status: 404 })
    }

    const result = await paystackSubmitOtp({ reference, otp })

    return respondToPaystackOutcome({
        supabaseAdmin,
        charge: result,
        reference,
        price: Number((payment as any).total_amount),
        metadata: ((payment as any).metadata || {}) as Record<string, any>,
        dialCode,
    })
}
/** Lets the dashboard show the caller's price and activation state without exposing prices publicly. */
export async function GET() {
    try {
        const ctx = await loadContext()
        if ('error' in ctx) return NextResponse.json({ error: ctx.error }, { status: ctx.status })

        const { shop, role, price, settingsMap, sub } = ctx
        const ussdEnabled = isUssdEnabled(settingsMap)
        // The master switch outranks every per-shop gate: while USSD is off there
        // is nothing to sell and nothing to dial, so it is the reason we give.
        const blockedReason = ussdEnabled ? activationBlockReason(shop, sub) : USSD_UNAVAILABLE_MESSAGE

        return NextResponse.json({
            success: true,
            // Callers hide the whole feature on this, rather than rendering a
            // purchase page for a service that cannot be used.
            ussdEnabled,
            hasShop: !!shop,
            eligible: !blockedReason,
            // Lets the portal explain the block instead of guessing at
            // "awaiting approval", which is only one of several reasons.
            reason: blockedReason,
            isSub: sub.isSub,
            status: shop?.ussd_status || 'inactive',
            shortCode: shop?.ussd_code || null,
            dialCode: settingsMap.ussd_dial_code || '',
            role,
            price,
        })
    } catch (error: any) {
        console.error('[UssdActivate] GET error:', error)
        return NextResponse.json({ error: 'Failed to load activation details' }, { status: 500 })
    }
}

export async function POST(request: Request) {
    try {
        const ctx = await loadContext()
        if ('error' in ctx) return NextResponse.json({ error: ctx.error }, { status: ctx.status })

        const { authUser, supabaseAdmin, shop, price, settingsMap, sub } = ctx

        // 503, not 400: nothing is wrong with the request or the caller â€” the
        // service is switched off, and it may well be back.
        if (!isUssdEnabled(settingsMap)) {
            return NextResponse.json({ error: USSD_UNAVAILABLE_MESSAGE }, { status: 503 })
        }

        const blockedReason = activationBlockReason(shop, sub)
        if (blockedReason) {
            // A sub blocked on membership is a 403 (they may not trade at all);
            // a missing/unapproved shop is a 400 (fix the shop and come back).
            const status = sub.isSub && shop && shop.approval_status === 'approved' ? 403 : 400
            return NextResponse.json({ error: blockedReason }, { status })
        }
        if (shop.ussd_status === 'active') {
            return NextResponse.json({ error: 'Your short code is already active' }, { status: 400 })
        }
        if (!(price > 0)) {
            return NextResponse.json({ error: 'Activation is not available right now. Please contact support.' }, { status: 503 })
        }

        const body: any = await request.json().catch(() => ({}))
        const { phone, network, paymentMethod, otp, reference: submittedReference } = body

        const gateway = resolveProviderForScope(settingsMap[USSD_PROVIDER_KEY], 'ussd')

        // â”€â”€ OTP SUBMISSION â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        // Handled before anything is minted: this finishes a charge that already
        // exists rather than starting a new one.
        if (otp) {
            if (gateway !== 'paystack_momo') {
                return NextResponse.json(
                    { error: 'This payment method does not use a one-time code' },
                    { status: 400 }
                )
            }
            return submitActivationOtp({
                supabaseAdmin,
                userId: authUser.id,
                reference: String(submittedReference || ''),
                otp: String(otp),
                dialCode: settingsMap.ussd_dial_code || '',
            })
        }

        const isWalletPayment = paymentMethod === 'wallet'

        // Each gateway spells the networks differently, so the form's value is
        // checked against the one that will actually be charged.
        const paystackProvider = paystackMomoProviderFor(network)
        const networkSupported = gateway === 'paystack_momo'
            ? !!paystackProvider
            : !!(network && HUBTEL_CHANNEL_MAP[network])

        if (!isWalletPayment && (!phone || !network || !networkSupported)) {
            return NextResponse.json({ error: 'Phone number and network are required' }, { status: 400 })
        }

        // Always minted server-side. The upgrade route this was modelled on accepts
        // a client reference to resubmit after an OTP step; here the OTP branch above
        // resolves its own reference from the caller's pending row instead, so a
        // client-supplied one could only ever collide with someone else's payment.
        const reference = `ussd_activation_${generateReferenceCode()}`

        const activationMetadata = {
            user_id: authUser.id,
            upgrade_type: 'ussd_activation',
            shop_id: shop.id,
            shop_name: shop.shop_name,
            base_amount: price,
            fee: 0,
        }

        // â”€â”€ WALLET BRANCH â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        if (isWalletPayment) {
            // Atomic: the RPC only deducts when the balance covers it, so two
            // concurrent attempts cannot both succeed on one balance.
            const { data: deductResult, error: deductError } = await (supabaseAdmin as any)
                .rpc('deduct_wallet_balance', { p_user_id: authUser.id, p_amount: price })

            if (deductError) {
                if (deductError.message?.includes('INSUFFICIENT_BALANCE')) {
                    return NextResponse.json(
                        { error: `Insufficient wallet balance. You need GHS ${price.toFixed(2)} to activate.` },
                        { status: 400 }
                    )
                }
                console.error('[UssdActivate] Wallet deduction error:', deductError)
                return NextResponse.json({ error: 'Failed to process wallet payment' }, { status: 500 })
            }

            const walletRow = deductResult?.[0] || deductResult
            const walletId = walletRow?.wallet_id
            if (!walletId) {
                return NextResponse.json({ error: 'Wallet not found' }, { status: 404 })
            }

            // The money has already left the balance by this point, so anything
            // that fails after the debit must put it back.
            const refund = async (why: string) => {
                console.error(`[UssdActivate] Refunding wallet activation (${why}):`, reference)
                const { error: refundError } = await (supabaseAdmin as any)
                    .rpc('credit_wallet_balance', { p_user_id: authUser.id, p_amount: price })
                if (refundError) {
                    console.error('CRITICAL: activation refund RPC failed for', reference, refundError)
                }
            }

            const { error: paymentInsertError } = await (supabaseAdmin.from('wallet_payments') as any)
                .insert({
                    user_id: authUser.id,
                    wallet_id: walletId,
                    amount: price,
                    fee: 0,
                    total_amount: price,
                    reference,
                    provider: 'wallet',
                    status: 'pending',
                    metadata: { ...activationMetadata, paid_from: 'wallet' },
                })

            if (paymentInsertError) {
                console.error('[UssdActivate] wallet_payments insert failed:', paymentInsertError)
                await refund('payment record insert failed')
                return NextResponse.json({ error: 'Failed to record activation payment' }, { status: 500 })
            }

            ;(supabaseAdmin.from('wallet_transactions') as any).insert({
                wallet_id: walletId,
                user_id: authUser.id,
                type: 'debit',
                amount: price,
                description: 'USSD short code activation (lifetime)',
                reference,
                source: 'purchase',
                status: 'completed',
            }).then(({ error }: any) => {
                if (error) console.error('[UssdActivate] wallet_transactions insert failed:', error)
            })

            const { processCompletedUssdActivation } = await import('@/lib/payments')
            const result = await processCompletedUssdActivation(reference, {
                reference,
                amount: Math.round(price * 100),
                metadata: { ...activationMetadata, paid_from: 'wallet' },
            })

            if (!result?.success) {
                console.error('[UssdActivate] Activation processing failed:', result?.error)
                await (supabaseAdmin.from('wallet_payments') as any)
                    .update({ status: 'failed' })
                    .eq('reference', reference)
                await refund('activation processing failed')
                return NextResponse.json(
                    { error: result?.error || 'Failed to activate your short code. Your wallet has been refunded.' },
                    { status: 500 }
                )
            }

            return NextResponse.json({
                success: true,
                gateway: 'wallet',
                activated: true,
                reference,
                shortCode: result.shortCode,
                dialCode: settingsMap.ussd_dial_code || '',
                message: `Your USSD short code is ${result.shortCode}.`,
            })
        }

        // â”€â”€ MOBILE MONEY BRANCH â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        // Whichever gateway collects, the shape is the same: a pending
        // wallet_payments row minted here, settled by that gateway's webhook through
        // processCompletedUssdActivation.
        //
        // Deliberately ignores active_payment_provider_web. This purchase only ever
        // collects a phone + network, so routing it to a card gateway would strand
        // the buyer on a checkout page they never asked for.
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
                amount: price,
                fee: 0,
                total_amount: price,
                reference,
                // The row has to name its own gateway: the reconciliation sweeps are
                // scoped by provider, so a mislabelled row is one nothing recovers.
                provider: gateway,
                status: 'pending',
                metadata: activationMetadata,
            })

        if (paymentError) {
            console.error('[UssdActivate] Database error:', paymentError)
            throw new Error('Failed to record payment attempt')
        }

        // â”€â”€ PAYSTACK (default) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        // The Charge API, not transaction/initialize. Everywhere else in the app
        // Paystack means a hosted checkout page the browser is redirected to; here we
        // debit the handset directly and the buyer approves on their phone, exactly as
        // the dial-in service does.
        if (gateway === 'paystack_momo') {
            const charge = await paystackChargeMobileMoney({
                reference,
                amountGhs: price,
                payerMsisdn: phone,
                provider: paystackProvider!,
                // Unlike a USSD caller, this buyer has an account â€” booking the charge
                // against their real email groups it with the rest of their payments in
                // Paystack's dashboard instead of behind a synthetic address.
                email: authUser.email || undefined,
                metadata: activationMetadata,
            })

            return respondToPaystackOutcome({
                supabaseAdmin,
                charge,
                reference,
                price,
                metadata: activationMetadata,
                dialCode: settingsMap.ussd_dial_code || '',
            })
        }

        // â”€â”€ HUBTEL (rollback path) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        // Reached only when the USSD payment scope explicitly names Hubtel. Kept
        // working so the switch is a real way back, not a label.
        const hubtelResponse = await hubtelInitiatePayment({
            amount: price,
            payerPhone: phone,
            channel: HUBTEL_CHANNEL_MAP[network],
            clientReference: reference,
            // toHubtelSafeText sanitises this, but keeping it ASCII at the source
            // avoids the failure mode where a bad Description makes the call throw
            // `terminated` after the payment has already gone live.
            description: 'ARHMS USSD Short Code Activation',
            userId: authUser.id,
        })

        if (!hubtelResponse.success) {
            await (supabaseAdmin.from('wallet_payments') as any).update({ status: 'failed' }).eq('reference', reference)
            throw new Error(hubtelResponse.error || 'Failed to initialize Hubtel payment')
        }

        return NextResponse.json({
            success: true,
            gateway: 'hubtel',
            reference,
            message: 'Payment prompt sent to your phone. Please approve to continue.',
        })
    } catch (error: any) {
        console.error('[UssdActivate] Error:', error)
        return NextResponse.json(
            { error: error.message || 'Failed to start activation' },
            { status: 500 }
        )
    }
}
