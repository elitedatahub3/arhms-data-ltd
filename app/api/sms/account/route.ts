import { NextResponse } from 'next/server'
import { loadSmsContext, smsBlockReason, isCustomerSmsEnabled, SMS_DISABLED_MESSAGE } from '@/lib/sms/sms-purchase'
import { getAllowedSenders } from '@/lib/sms/customer-sms'

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
        const blockedReason = enabled ? smsBlockReason(shop, sub) : SMS_DISABLED_MESSAGE

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

        return NextResponse.json({
            success: true,
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
