import { NextResponse } from 'next/server'
import { loadSmsContext, smsBlockReason, isCustomerSmsEnabled, SMS_DISABLED_MESSAGE } from '@/lib/sms/sms-purchase'
import { getAllowedSenders } from '@/lib/sms/customer-sms'
import { getSmsBusiness, countSentToday, dailyLimitFor, senderCapFor, getStats30d } from '@/lib/sms/platform'

/**
 * Everything the Customer SMS home screen renders from, in one call.
 *
 * Shaped like the USSD activation GET: every reason the caller might be blocked
 * comes back as a `reason` string, so the page renders the real explanation
 * instead of guessing which gate failed.
 */
export async function GET() {
    try {
        const ctx = await loadSmsContext()
        if ('error' in ctx) return NextResponse.json({ error: ctx.error }, { status: ctx.status })

        const { supabaseAdmin, account, shop, role, sub, settingsMap, unlockPrice, portal } = ctx

        const enabled = isCustomerSmsEnabled(settingsMap)
        const blockedReason = enabled ? smsBlockReason(shop, sub, ctx.userStatus) : SMS_DISABLED_MESSAGE

        // loadSmsContext selects a fixed column list, so the toggles are read here.
        const { data: toggles } = await supabaseAdmin
            .from('sms_accounts')
            .select('order_sms_data_enabled, order_sms_airtime_enabled, last_order_sms_skip, last_order_sms_skip_at')
            .eq('id', account.id)
            .maybeSingle()

        Object.assign(account as any, toggles || {})

        const { data: senderRows } = await supabaseAdmin
            .from('sms_sender_ids')
            .select('id, sender, status, rejection_reason, is_default, created_at')
            .eq('account_id', account.id)
            .order('created_at', { ascending: false })

        const allowedSenders = account.status === 'active'
            ? await getAllowedSenders(supabaseAdmin, account.id)
            : []

        // Head count only: "All my customers · N" in the compose box.
        const { count: contactCount } = await supabaseAdmin
            .from('sms_contacts')
            .select('id', { count: 'exact', head: true })
            .eq('account_id', account.id)
            .eq('opted_out', false)

        const [business, sentToday, stats30d] = await Promise.all([
            getSmsBusiness(supabaseAdmin, account.id),
            countSentToday(supabaseAdmin, account.id),
            getStats30d(supabaseAdmin, account.id),
        ])

        return NextResponse.json({
            success: true,
            mode: ctx.mode,
            businessStatus: business?.status ?? null,
            dailyLimit: dailyLimitFor(ctx.mode, settingsMap),
            sentToday,
            stats30d,
            senderCap: senderCapFor(ctx.mode, settingsMap),
            // The page hides the whole feature on this rather than selling
            // something that cannot be used.
            enabled,
            eligible: !blockedReason,
            reason: blockedReason,
            hasShop: !!shop,
            shopName: shop?.shop_name ?? null,
            contactCount: contactCount ?? 0,
            isSub: sub.isSub,
            portal,
            role,
            unlockPrice,
            orderSms: {
                data: !!(account as any).order_sms_data_enabled,
                airtime: !!(account as any).order_sms_airtime_enabled,
                lastSkip: (account as any).last_order_sms_skip || null,
                lastSkipAt: (account as any).last_order_sms_skip_at || null,
            },
            account: {
                status: account.status,
                credits: account.credits,
                totalPurchased: account.total_purchased,
                totalUsed: account.total_used,
                defaultSender: account.default_sender,
            },
            senderIds: senderRows || [],
            allowedSenders,
        })
    } catch (error: any) {
        console.error('[SmsAccount] GET error:', error)
        return NextResponse.json({ error: 'Failed to load your SMS account' }, { status: 500 })
    }
}

/**
 * Switches the shop's order confirmation SMS on or off.
 *
 * body: { data?: boolean, airtime?: boolean }
 */
export async function PATCH(request: Request) {
    try {
        const ctx = await loadSmsContext()
        if ('error' in ctx) return NextResponse.json({ error: ctx.error }, { status: ctx.status })

        const { supabaseAdmin, account } = ctx

        if (account.status !== 'active') {
            return NextResponse.json({ error: 'Unlock Customer SMS before switching order confirmations on' }, { status: 403 })
        }

        const body: any = await request.json().catch(() => ({}))
        const patch: Record<string, any> = {}
        if (typeof body.data === 'boolean') patch.order_sms_data_enabled = body.data
        if (typeof body.airtime === 'boolean') patch.order_sms_airtime_enabled = body.airtime

        if (!Object.keys(patch).length) {
            return NextResponse.json({ error: 'Nothing to change' }, { status: 400 })
        }

        // Switching ON without an approved sender would look like it worked and
        // then silently send nothing, so it is refused with the reason.
        if (patch.order_sms_data_enabled || patch.order_sms_airtime_enabled) {
            const allowed = await getAllowedSenders(supabaseAdmin, account.id)
            if (!allowed.some(s => s.type === 'own')) {
                return NextResponse.json(
                    { error: 'You need an approved sender ID before your shop can send order confirmations' },
                    { status: 400 }
                )
            }
        }

        patch.updated_at = new Date().toISOString()

        const { error } = await (supabaseAdmin.from('sms_accounts') as any)
            .update(patch)
            .eq('id', account.id)

        if (error) {
            console.error('[SmsAccount] PATCH failed:', error)
            return NextResponse.json({ error: 'Could not save that setting' }, { status: 500 })
        }

        return NextResponse.json({ success: true })
    } catch (error: any) {
        console.error('[SmsAccount] PATCH error:', error)
        return NextResponse.json({ error: 'Failed to update your settings' }, { status: 500 })
    }
}
