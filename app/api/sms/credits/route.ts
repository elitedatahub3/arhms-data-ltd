import { NextResponse } from 'next/server'
import { loadSmsContext } from '@/lib/sms/sms-purchase'

/**
 * The credit bundles on sale, plus the caller's current balance.
 *
 * Prices come from the sms_credit_bundles table rather than a constant so admin
 * can retune them without a deploy.
 */
export async function GET() {
    try {
        const ctx = await loadSmsContext()
        if ('error' in ctx) return NextResponse.json({ error: ctx.error }, { status: ctx.status })

        const { supabaseAdmin, account } = ctx

        const { data: bundles } = await supabaseAdmin
            .from('sms_credit_bundles')
            .select('id, name, credits, price')
            .eq('is_active', true)
            .order('sort_order', { ascending: true })

        const { data: purchases } = await supabaseAdmin
            .from('sms_credit_purchases')
            .select('id, credits, amount, status, created_at')
            .eq('account_id', account.id)
            .order('created_at', { ascending: false })
            .limit(10)

        return NextResponse.json({
            success: true,
            credits: account.credits,
            totalPurchased: account.total_purchased,
            totalUsed: account.total_used,
            accountStatus: account.status,
            bundles: (bundles || []).map((b: any) => ({
                ...b,
                price: Number(b.price),
                // Shown on the card so the discount on the bigger bundles is
                // visible rather than something the buyer has to work out.
                pricePerSms: b.credits > 0 ? Number(b.price) / b.credits : 0,
            })),
            recentPurchases: purchases || [],
        })
    } catch (error: any) {
        console.error('[SmsCredits] GET error:', error)
        return NextResponse.json({ error: 'Failed to load SMS credit bundles' }, { status: 500 })
    }
}
