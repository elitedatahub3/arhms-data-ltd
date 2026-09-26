/**
 * Paying for Customer SMS — the unlock and the credit bundles.
 *
 * Both are one-time mobile money purchases with the same shape, so the whole
 * flow lives here once: mint a reference, leave a pending wallet_payments row,
 * push a prompt to the handset, and let that gateway's webhook settle it through
 * lib/payments.ts. Modelled on app/api/shop/ussd/activate/route.ts, including the
 * Paystack OTP step Telecel and AirtelTigo require.
 */

import { NextResponse } from 'next/server'
import { createRouteHandlerClient } from '@/lib/supabase-server'
import { generateReferenceCode } from '@/lib/utils'
import { initiatePayment as hubtelInitiatePayment, HUBTEL_CHANNEL_MAP } from '@/lib/hubtel-payment-service'
import {
    chargeMobileMoney as paystackChargeMobileMoney,
    submitOtp as paystackSubmitOtp,
    paystackMomoProviderFor,
} from '@/lib/paystack-momo-service'
import { resolveProviderForScope, SCOPE_SETTING_KEY } from '@/lib/payment-provider'
import { resolveSubAgentContext, type SubAgentContext } from '@/lib/sub-agents'
import { resolveSmsAccount, type SmsAccount } from '@/lib/sms/customer-sms'

export const SMS_PROVIDER_KEY = SCOPE_SETTING_KEY.sms

export const SMS_UNLOCK_PRICE_KEYS = [
    'sms_unlock_price_customer',
    'sms_unlock_price_agent',
    'sms_unlock_price_dealer',
    'sms_unlock_price_sub',
] as const

/**
 * Sub-agents are priced on their membership, not their role: a sub's users.role
 * is 'customer', so without this they would land on the customer tier by
 * accident rather than by decision.
 */
export function unlockPriceKeyForRole(role: string, isSub: boolean): string {
    if (isSub) return 'sms_unlock_price_sub'
    if (role === 'dealer' || role === 'dealership') return 'sms_unlock_price_dealer'
    if (role === 'agent') return 'sms_unlock_price_agent'
    return 'sms_unlock_price_customer'
}

const DEFAULT_UNLOCK_PRICE = 10

export const SMS_DISABLED_MESSAGE = 'Customer SMS is temporarily unavailable. Please try again later.'

/**
 * The master switch, read the way the rest of the app reads its booleans.
 *
 * Fails OPEN on a missing row, unlike the USSD switch: the seed migration ships
 * the key as 'true', so an absent row means an older database rather than a
 * deliberate shutdown, and closing there would hide the feature from everyone
 * the moment it deployed ahead of the migration.
 */
export function isCustomerSmsEnabled(settings: Record<string, any>): boolean {
    const raw = settings?.sms_customer_enabled
    if (raw === undefined || raw === null || raw === '') return true
    return String(raw).replace(/^"+|"+$/g, '').trim().toLowerCase() !== 'false'
}

export interface SmsContext {
    authUser: any
    supabaseAdmin: any
    account: SmsAccount
    shop: any
    role: string
    sub: SubAgentContext
    settingsMap: Record<string, any>
    unlockPrice: number
    /** Which portal the caller is in, so redirects and notifications land right. */
    portal: 'shop' | 'sub'
}

/**
 * Everything an SMS route needs about the caller, resolved once.
 *
 * The account row is created on first sight (locked), so every later query has
 * something to join against even before anybody has paid.
 */
export async function loadSmsContext(): Promise<SmsContext | { error: string; status: number }> {
    const supabase = await createRouteHandlerClient()
    const { data: { user: authUser }, error: authError } = await supabase.auth.getUser()
    if (authError || !authUser) return { error: 'Unauthorized', status: 401 }

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
        .maybeSingle()

    // The caller's OWN shop, never their upline's: a sub messaging "my customers"
    // means the people who bought from the sub.
    const { data: shop } = await supabaseAdmin
        .from('shop_profiles')
        .select('id, shop_name, approval_status, is_active')
        .eq('owner_id', authUser.id)
        .maybeSingle()

    const { data: settings } = await supabaseAdmin
        .from('admin_settings')
        .select('key, value')
        .in('key', [...SMS_UNLOCK_PRICE_KEYS, 'sms_customer_enabled', 'sms_inline_send_max', 'sms_pool_senders', SMS_PROVIDER_KEY])

    const settingsMap: Record<string, any> = {}
    for (const row of (settings || [])) settingsMap[(row as any).key] = (row as any).value

    const sub = await resolveSubAgentContext(supabaseAdmin, authUser.id)
    const role = (dbUser as any)?.role || 'customer'

    const account = await resolveSmsAccount(supabaseAdmin, authUser.id, (shop as any)?.id ?? null)
    if (!account) return { error: 'Could not load your SMS account', status: 500 }

    const priceKey = unlockPriceKeyForRole(role, sub.isSub)
    const rawPrice = settingsMap[priceKey]
    const unlockPrice = rawPrice !== undefined && rawPrice !== ''
        ? Number(String(rawPrice).replace(/^"+|"+$/g, ''))
        : DEFAULT_UNLOCK_PRICE

    return {
        authUser,
        supabaseAdmin,
        account,
        shop,
        role,
        sub,
        settingsMap,
        unlockPrice,
        portal: sub.isSub ? 'sub' : 'shop',
    }
}

/**
 * Why this caller cannot use Customer SMS at all, or null when they can.
 *
 * A sub is gated on their own membership only — the same call the USSD till
 * makes, and for the same reason: their upline's subscription state is
 * something the sub cannot fix and does not stop them trading elsewhere.
 */
export function smsBlockReason(shop: any, sub: SubAgentContext): string | null {
    if (!shop) return 'You need a shop before you can send SMS to customers'
    if (shop.approval_status !== 'approved') return 'Your shop must be approved before you can send SMS'
    if (sub.isSub && sub.status !== 'active') {
        return sub.status === 'suspended'
            ? 'Your sub-agent account is suspended. Contact your Lead to be reinstated.'
            : 'Your account is still awaiting approval from your Lead'
    }
    return null
}

export type SmsPurchaseKind = 'sms_unlock' | 'sms_credits'

export interface StartPurchaseParams {
    ctx: SmsContext
    kind: SmsPurchaseKind
    amount: number
    /** Payer's handset details — mobile money is the only way to pay for this. */
    phone: string
    network: string
    /** Merged into the wallet_payments metadata the settle handlers read. */
    extraMetadata?: Record<string, any>
    /** Runs after the pending row exists and before the gateway is called. */
    beforeCharge?: (reference: string) => Promise<{ ok: boolean; error?: string }>
    description: string
}

/**
 * Starts a Customer SMS purchase and returns the response for the caller.
 *
 * The reference is always minted here. The USSD route's reasoning applies
 * unchanged: a client-supplied reference could only ever collide with somebody
 * else's payment, and the OTP step resolves its own reference from the caller's
 * pending row instead.
 */
export async function startSmsPurchase(params: StartPurchaseParams) {
    const { ctx, kind, amount, phone, network, extraMetadata, beforeCharge, description } = params
    const { authUser, supabaseAdmin, account, settingsMap, portal } = ctx

    if (!(amount > 0)) {
        return NextResponse.json({ error: 'This purchase is not available right now. Please contact support.' }, { status: 503 })
    }

    const gateway = resolveProviderForScope(settingsMap[SMS_PROVIDER_KEY], 'sms')

    const paystackProvider = paystackMomoProviderFor(network)
    const networkSupported = gateway === 'paystack_momo'
        ? !!paystackProvider
        : !!(network && HUBTEL_CHANNEL_MAP[network])

    if (!phone || !network || !networkSupported) {
        return NextResponse.json({ error: 'Phone number and network are required' }, { status: 400 })
    }

    const prefix = kind === 'sms_unlock' ? 'sms_unlock_' : 'sms_credits_'
    const reference = `${prefix}${generateReferenceCode()}`

    const metadata = {
        user_id: authUser.id,
        upgrade_type: kind,
        sms_account_id: account.id,
        portal,
        base_amount: amount,
        fee: 0,
        ...extraMetadata,
    }

    const { data: wallet } = await supabaseAdmin
        .from('wallets')
        .select('id')
        .eq('user_id', authUser.id)
        .maybeSingle()

    if (!wallet) {
        return NextResponse.json({ error: 'Your wallet could not be found. Please contact support.' }, { status: 404 })
    }

    const { error: paymentError } = await (supabaseAdmin.from('wallet_payments') as any)
        .insert({
            user_id: authUser.id,
            wallet_id: (wallet as any).id,
            amount,
            fee: 0,
            total_amount: amount,
            reference,
            // The row has to name its own gateway: the reconciliation sweeps are
            // scoped by provider, so a mislabelled row is one nothing recovers.
            provider: gateway,
            status: 'pending',
            metadata,
        })

    if (paymentError) {
        console.error('[SmsPurchase] wallet_payments insert failed:', paymentError)
        return NextResponse.json({ error: 'Failed to record payment attempt' }, { status: 500 })
    }

    // The credits purchase writes its own ledger row here, so the settle handler
    // has something to latch onto before any money moves.
    if (beforeCharge) {
        const prepared = await beforeCharge(reference)
        if (!prepared.ok) {
            await (supabaseAdmin.from('wallet_payments') as any).update({ status: 'failed' }).eq('reference', reference)
            return NextResponse.json({ error: prepared.error || 'Could not start this purchase' }, { status: 500 })
        }
    }

    if (gateway === 'paystack_momo') {
        const charge = await paystackChargeMobileMoney({
            reference,
            amountGhs: amount,
            payerMsisdn: phone,
            provider: paystackProvider!,
            email: authUser.email || undefined,
            metadata,
        })

        return respondToSmsCharge({ supabaseAdmin, charge, reference, amount, metadata })
    }

    // ── HUBTEL (rollback path) ───────────────────────────────────────────────
    const hubtelResponse = await hubtelInitiatePayment({
        amount,
        payerPhone: phone,
        channel: HUBTEL_CHANNEL_MAP[network],
        clientReference: reference,
        // Kept ASCII at the source: a non-ASCII Description makes the call throw
        // `terminated` after the payment has already gone live.
        description,
        userId: authUser.id,
    })

    if (!hubtelResponse.success) {
        await (supabaseAdmin.from('wallet_payments') as any).update({ status: 'failed' }).eq('reference', reference)
        return NextResponse.json({ error: hubtelResponse.error || 'Failed to start the payment' }, { status: 502 })
    }

    return NextResponse.json({
        success: true,
        gateway: 'hubtel',
        reference,
        message: 'Payment prompt sent to your phone. Please approve to continue.',
    })
}

/**
 * Turns a Paystack charge (or OTP) outcome into the response the SMS pages
 * understand, settling inline when Paystack says the money is already in.
 *
 * Inline settlement is safe because both settle handlers are idempotent on the
 * wallet_payments transition, so the webhook arriving afterwards is a no-op.
 * Anything that is not an outright decline stays pending on purpose: the webhook
 * and the reconciliation sweep both settle from that pending row.
 */
async function respondToSmsCharge(params: {
    supabaseAdmin: any
    charge: { outcome: string; displayText: string | null; message: string | null }
    reference: string
    amount: number
    metadata: Record<string, any>
}) {
    const { supabaseAdmin, charge, reference, amount, metadata } = params

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
        const { processCompletedSmsPayment } = await import('@/lib/payments')
        const result = await processCompletedSmsPayment(reference, {
            reference,
            amount: Math.round(amount * 100),
            metadata,
        }, metadata)

        if (result?.success) {
            return NextResponse.json({
                success: true,
                gateway: 'paystack',
                completed: true,
                reference,
                message: metadata.upgrade_type === 'sms_unlock'
                    ? 'Customer SMS is now unlocked.'
                    : 'Your SMS credits have been added.',
            })
        }

        // Paid but not finished here. Left pending deliberately so the webhook
        // and the sweep can, and reported as a normal prompt so the page keeps
        // polling rather than telling the buyer their money vanished.
        console.error('[SmsPurchase] Inline settlement failed for a paid charge:', reference, result?.error)
    }

    return NextResponse.json({
        success: true,
        gateway: 'paystack',
        reference,
        message: charge.displayText || 'Payment prompt sent to your phone. Please approve to continue.',
    })
}

/**
 * Finishes a charge that answered 'send_otp' — Telecel and AirtelTigo ask the
 * payer to type a code rather than approve a prompt.
 *
 * The reference arrives from the client, so it is resolved against THIS caller's
 * own pending row before Paystack is told anything. Without that check the
 * endpoint would happily submit codes against a stranger's charge.
 */
export async function submitSmsPurchaseOtp(params: {
    supabaseAdmin: any
    userId: string
    reference: string
    otp: string
}) {
    const { supabaseAdmin, userId, reference, otp } = params

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

    return respondToSmsCharge({
        supabaseAdmin,
        charge: result,
        reference,
        amount: Number((payment as any).total_amount),
        metadata: ((payment as any).metadata || {}) as Record<string, any>,
    })
}
