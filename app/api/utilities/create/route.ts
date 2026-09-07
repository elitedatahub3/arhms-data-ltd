import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { createRouteHandlerClient } from '@/lib/supabase-server'
import { generateReferenceCode } from '@/lib/utils'
import { waitUntil } from '@vercel/functions'
import { sendPushToUser, sendPushToAdmins } from '@/lib/web-push'
import { buildUtilityIntent, utilitySettingKeys, isUtilitySurfaceOpen, utilitySurfaceSettingKeys, UTILITY_LAUNCH_KEY } from '@/lib/utility-order-intent'
import { triggerUtilityFulfillment, buildUtilityClientReference } from '@/lib/utility-fulfillment-dispatcher'

/**
 * Wallet-funded utility bill payment.
 *
 * Mirrors app/api/airtime/create/route.ts step for step — validate, price
 * server-side, guard against duplicates, deduct atomically, record the order, then
 * dispatch in the background. The one addition is buildUtilityIntent(), which
 * re-verifies the account with the provider before the wallet is touched; see
 * lib/utility-order-intent.ts for why that cannot be skipped.
 */
export async function POST(request: NextRequest) {
    try {
        const supabaseUserClient = await createRouteHandlerClient()
        const { data: { user: authUser }, error: authError } = await supabaseUserClient.auth.getUser()

        if (authError || !authUser) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const userId = authUser.id
        const supabase = createServerClient() as any

        let body: any
        try {
            body = await request.json()
        } catch {
            return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
        }

        const { service, accountNumber, amount, phone, email, referenceCode: clientReferenceCode } = body

        if (typeof service !== 'string') {
            return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
        }

        // ── Load the user and this service's settings ─────────────────────────
        const [userResult, settingsResult] = await Promise.all([
            supabase.from('users').select('role, first_name, last_name, email, phone_number').eq('id', userId).single(),
            ...utilitySurfaceSettingKeys(),
            supabase.from('admin_settings').select('key, value').in('key', [...utilitySettingKeys(service), UTILITY_LAUNCH_KEY]),
        ])

        if (userResult.error || !userResult.data) {
            return NextResponse.json({ error: 'User not found' }, { status: 404 })
        }

        const userData = userResult.data
        const userRole: 'agent' | 'customer' = userData.role === 'agent' ? 'agent' : 'customer'

        const settings: Record<string, string> = {}
        for (const row of (settingsResult.data || [])) settings[row.key] = row.value

        if (!isUtilitySurfaceOpen('dashboard', userData.role, settings)) {
            return NextResponse.json({ error: 'Bill payments are not available yet.' }, { status: 403 })
        }

        // ── Validate + verify + price (all server-side) ───────────────────────
        const built = await buildUtilityIntent({ service, accountNumber, amount, phone, email }, settings, userRole)
        if (!built.ok) {
            return NextResponse.json({ error: built.error }, { status: built.status })
        }
        const intent = built.intent

        // ── Idempotency ───────────────────────────────────────────────────────
        // Same two guards as airtime: a 30-second window catches a double-tap, and an
        // explicit client reference catches a retried request.
        const thirtySecondsAgo = new Date(Date.now() - 30000).toISOString()
        const { data: recentOrder } = await supabase
            .from('utility_orders')
            .select('id, reference_code')
            .eq('user_id', userId)
            .eq('service', intent.service)
            .eq('account_number', intent.accountNumber)
            .eq('total_paid', intent.totalPaid)
            .gte('created_at', thirtySecondsAgo)
            .maybeSingle()

        if (recentOrder) {
            return NextResponse.json({
                error: 'Duplicate payment detected. Please wait 30 seconds before repeating the same payment.',
                isDuplicate: true,
            }, { status: 409 })
        }

        if (clientReferenceCode) {
            const { data: existingOrder } = await supabase
                .from('utility_orders')
                .select('id, reference_code, status')
                .eq('reference_code', clientReferenceCode)
                .maybeSingle()

            if (existingOrder) {
                return NextResponse.json({
                    success: true,
                    isDuplicate: true,
                    order: { id: existingOrder.id, reference_code: existingOrder.reference_code, status: existingOrder.status },
                })
            }
        }

        // ── Atomic wallet deduction ───────────────────────────────────────────
        const { data: deductResult, error: deductError } = await supabase.rpc('deduct_wallet_balance', {
            p_user_id: userId,
            p_amount: intent.totalPaid,
        })

        if (deductError) {
            if (deductError.message?.includes('INSUFFICIENT_BALANCE')) {
                return NextResponse.json({ error: 'Insufficient balance. Please top up your wallet.' }, { status: 400 })
            }
            console.error('[Utility] Wallet deduction error:', deductError)
            return NextResponse.json({ error: 'Failed to process payment' }, { status: 500 })
        }

        const walletRow = deductResult?.[0] || deductResult
        const walletId = walletRow?.wallet_id
        const newBalance = walletRow?.new_balance

        if (!walletId) {
            return NextResponse.json({ error: 'Wallet not found' }, { status: 404 })
        }

        const referenceCode = clientReferenceCode || `UTIL-${generateReferenceCode()}`

        // ── Create the order ──────────────────────────────────────────────────
        const { data: order, error: orderError } = await supabase
            .from('utility_orders')
            .insert({
                user_id: userId,
                user_role: userRole,
                service: intent.service,
                account_number: intent.accountNumber,
                account_name: intent.accountName,
                destination: intent.destination,
                customer_phone: intent.customerPhone,
                customer_email: intent.customerEmail,
                session_id: intent.sessionId,
                bill_amount: intent.billAmount,
                fee_rate: intent.feeRate,
                fee_amount: intent.feeAmount,
                total_paid: intent.totalPaid,
                payment_method: 'wallet',
                payment_status: 'paid',
                status: 'pending',
                reference_code: referenceCode,
                client_reference: buildUtilityClientReference(referenceCode),
            })
            .select()
            .single()

        if (orderError || !order) {
            console.error('[Utility] Order creation error:', orderError)
            // Put the money straight back — nothing was bought.
            await supabase.rpc('credit_wallet_balance', { p_user_id: userId, p_amount: intent.totalPaid })
                .catch((e: any) => console.error('[Utility] CRITICAL: refund after failed insert failed:', e))
            return NextResponse.json({ error: 'Failed to create the bill payment' }, { status: 500 })
        }

        // ── Auto-payment ──────────────────────────────────────────────────────
        // Deferred rather than awaited: Hubtel can take several seconds and the
        // customer should not sit on a spinner. The order is already recorded, the
        // page polls for the change, and if auto-payment is off it waits for an admin.
        waitUntil(triggerUtilityFulfillment(order.id))

        // ── Wallet transaction record (fire-and-forget) ───────────────────────
        // `source` is behind a CHECK that only allows payment/refund/admin/purchase/
        // referral — see supabase/migrations/20260813_referral_bonuses.sql.
        supabase.from('wallet_transactions').insert({
            wallet_id: walletId,
            user_id: userId,
            type: 'debit',
            amount: intent.totalPaid,
            description: `${intent.label} bill: GHS ${intent.billAmount.toFixed(2)} for ${intent.accountNumber}`,
            reference: referenceCode,
            source: 'purchase',
            status: 'completed',
        }).then(() => {}).catch((e: any) => console.error('[Utility] Tx insert error:', e))

        // ── In-app notification (fire-and-forget) ─────────────────────────────
        supabase.from('notifications').insert({
            user_id: userId,
            title: `${intent.label} Payment Placed`,
            message: `GHS ${intent.billAmount.toFixed(2)} for ${intent.label} account ${intent.accountNumber} is pending. Ref: ${referenceCode}`,
            type: 'order_update',
            action_url: '/dashboard/utilities',
        }).then(() => {}).catch((e: any) => console.error('[Utility] Notification error:', e))

        await sendPushToUser(userId, {
            title: `${intent.label} Payment Placed`,
            body: `GHS ${intent.billAmount.toFixed(2)} for ${intent.accountNumber} is pending.`,
            url: '/dashboard/utilities',
        }).catch(() => {})

        await sendPushToAdmins({
            title: `New ${intent.label} Bill Payment`,
            body: `${`${userData.first_name || ''} ${userData.last_name || ''}`.trim() || 'User'} · GHS ${intent.billAmount.toFixed(2)} → ${intent.accountNumber}${intent.accountName ? ` (${intent.accountName})` : ''}`,
            url: '/admin/utilities',
        }).catch(() => {})

        return NextResponse.json({
            success: true,
            order: {
                id: order.id,
                reference_code: referenceCode,
                status: 'pending',
                service: intent.service,
                service_label: intent.label,
                account_number: intent.accountNumber,
                account_name: intent.accountName,
                bill_amount: intent.billAmount,
                fee_amount: intent.feeAmount,
                total_paid: intent.totalPaid,
                new_balance: newBalance,
            },
        })
    } catch (error) {
        console.error('[Utility] Unexpected error:', error)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
