import { NextRequest, NextResponse } from 'next/server'
import { waitUntil } from '@vercel/functions'
import { createServerClient } from '@/lib/supabase'
import { createRouteHandlerClient } from '@/lib/supabase-server'
import { generateReferenceCode } from '@/lib/utils'
import { sendPushToAdmins } from '@/lib/web-push'
import { resolveBundleTier } from '@/lib/bundle-pricing'
import { buildBundleIntent, bundleOrderColumns, isBundlesDashboardOpen, loadBundleSettings } from '@/lib/bundle-order-intent'
import { triggerBundleDispatch, BUNDLES_ADMIN_PATH } from '@/lib/bundle-dispatcher'
import { BUNDLES_USER_PATH } from '@/lib/bundle-order-completion'

/**
 * Wallet-funded Standard Bundle purchase.
 *
 * Same steps as app/api/utilities/create/route.ts: price server-side, guard against
 * duplicates, deduct atomically, record the order, dispatch in the background.
 */
export async function POST(request: NextRequest) {
    try {
        const userClient = await createRouteHandlerClient()
        const { data: { user }, error: authError } = await userClient.auth.getUser()
        if (authError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

        let body: any
        try {
            body = await request.json()
        } catch {
            return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
        }

        const userId = user.id
        const supabase = createServerClient() as any

        const [settings, userResult] = await Promise.all([
            loadBundleSettings(supabase),
            supabase.from('users').select('*').eq('id', userId).single(),
        ])
        if (userResult.error || !userResult.data) return NextResponse.json({ error: 'User not found' }, { status: 404 })
        const userRow = userResult.data

        if (!isBundlesDashboardOpen(settings)) {
            return NextResponse.json({ error: 'Standard Bundles are not available right now.' }, { status: 403 })
        }

        const built = await buildBundleIntent(
            { network: body?.network, bundleKey: body?.bundleKey, phone: body?.phone },
            settings,
            resolveBundleTier(userRow)
        )
        if (!built.ok) return NextResponse.json({ error: built.error }, { status: built.status })
        const intent = built.intent

        // ── Idempotency ───────────────────────────────────────────────────────
        const clientReference = typeof body?.referenceCode === 'string' && /^BNDL-[A-Za-z0-9-]{6,60}$/.test(body.referenceCode)
            ? body.referenceCode
            : null

        if (clientReference) {
            const { data: existing } = await supabase
                .from('bundle_orders')
                .select('id, reference_code, status, user_id')
                .eq('reference_code', clientReference)
                .maybeSingle()
            if (existing) {
                if (existing.user_id !== userId) return NextResponse.json({ error: 'Reference already used' }, { status: 409 })
                return NextResponse.json({ success: true, isDuplicate: true, order: { id: existing.id, reference_code: existing.reference_code, status: existing.status } })
            }
        }

        // A double-tap: same bundle to the same number within 30 seconds.
        const { data: recent } = await supabase
            .from('bundle_orders')
            .select('id')
            .eq('user_id', userId)
            .eq('beneficiary_phone', intent.phone)
            .eq('bundle_label', intent.bundle.size)
            .eq('network', intent.network)
            .gte('created_at', new Date(Date.now() - 30_000).toISOString())
            .limit(1)
        if (recent?.length) {
            return NextResponse.json({
                error: 'You just bought this bundle for this number. Wait 30 seconds before buying it again.',
                isDuplicate: true,
            }, { status: 409 })
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
            console.error('[Bundles] Wallet deduction error:', deductError)
            return NextResponse.json({ error: 'Failed to process payment' }, { status: 500 })
        }
        const walletRow = deductResult?.[0] || deductResult
        const walletId = walletRow?.wallet_id
        const newBalance = walletRow?.new_balance
        if (!walletId) return NextResponse.json({ error: 'Wallet not found' }, { status: 404 })

        const referenceCode = clientReference || `BNDL-${generateReferenceCode()}`

        const { data: order, error: orderError } = await supabase
            .from('bundle_orders')
            .insert({
                user_id: userId,
                user_role: userRow.role,
                ...bundleOrderColumns(intent),
                reference_code: referenceCode,
                status: 'pending',
                payment_method: 'wallet',
                payment_status: 'paid',
                source: 'dashboard',
            })
            .select()
            .single()

        if (orderError || !order) {
            console.error('[Bundles] Order insert error:', orderError)
            const { error: creditError } = await supabase.rpc('credit_wallet_balance', { p_user_id: userId, p_amount: intent.totalPaid })
            if (creditError) console.error('[Bundles] CRITICAL: refund after failed insert failed:', creditError)
            return NextResponse.json({ error: 'Failed to create the order. You have not been charged.' }, { status: 500 })
        }

        waitUntil(triggerBundleDispatch(order.id))

        // `source` is behind a CHECK: payment/refund/admin/purchase/referral only.
        const { error: txError } = await supabase.from('wallet_transactions').insert({
            wallet_id: walletId,
            user_id: userId,
            type: 'debit',
            amount: intent.totalPaid,
            description: `${intent.label} bundle to ${intent.phone}`,
            reference: referenceCode,
            source: 'purchase',
            status: 'completed',
        })
        if (txError) console.error('[Bundles] Wallet tx insert error:', txError.message)

        const { error: notifyError } = await supabase.from('notifications').insert({
            user_id: userId,
            title: 'Bundle Order Placed',
            message: `${intent.label} for ${intent.phone} is on its way. Ref: ${referenceCode}`,
            type: 'order_update',
            action_url: BUNDLES_USER_PATH,
        })
        if (notifyError) console.error('[Bundles] Notification error:', notifyError.message)

        waitUntil(sendPushToAdmins({
            title: 'New Standard Bundle order',
            body: `${`${userRow.first_name || ''} ${userRow.last_name || ''}`.trim() || 'User'} · ${intent.label} → ${intent.phone} · GHS ${intent.totalPaid.toFixed(2)}`,
            url: BUNDLES_ADMIN_PATH,
        }).catch(() => {}))

        return NextResponse.json({
            success: true,
            order: {
                id: order.id,
                reference_code: referenceCode,
                status: 'pending',
                network: intent.network,
                bundle: intent.bundle.size,
                beneficiary_phone: intent.phone,
                total_paid: intent.totalPaid,
                new_balance: newBalance,
            },
        })
    } catch (error) {
        console.error('[Bundles] Unexpected error:', error)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
