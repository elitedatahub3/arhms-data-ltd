import { NextResponse } from 'next/server'
import { loadSmsContext } from '@/lib/sms/sms-purchase'
import { normalizeGhanaPhone } from '@/lib/sms-service'
import { fetchAllRows } from '@/lib/supabase-pagination'

/**
 * "Import from my orders" — pulls every distinct number that has bought from
 * the caller's OWN shop into their customer list.
 *
 * Own shop only, and that is the whole point for a sub-agent: shop_id resolves
 * off shop_profiles.owner_id = the caller, so a sub gets their storefront's
 * buyers and never their upline Lead's.
 *
 * Safe to press repeatedly — the upsert ignores numbers already on the list, so
 * the second press only brings in customers who bought since the first.
 */
export async function POST() {
    try {
        const ctx = await loadSmsContext()
        if ('error' in ctx) return NextResponse.json({ error: ctx.error }, { status: ctx.status })

        const { supabaseAdmin, account, shop } = ctx

        if (!shop) {
            return NextResponse.json({ error: 'You need a shop before you can import its customers' }, { status: 400 })
        }

        // PostgREST caps a response at 1000 rows; a busy shop passes that fast.
        const { data: orders, error: ordersError } = await fetchAllRows<{ guest_phone: string }>(() =>
            supabaseAdmin
                .from('shop_orders')
                .select('id, guest_phone')
                .eq('shop_id', shop.id)
                .not('guest_phone', 'is', null)
                .order('id', { ascending: true })
        )

        if (ordersError) {
            console.error('[SmsImportOrders] shop_orders query failed:', ordersError)
            return NextResponse.json({ error: 'Could not read your orders' }, { status: 500 })
        }

        const phones = new Set<string>()
        for (const row of orders) {
            const phone = normalizeGhanaPhone(String(row.guest_phone || ''))
            if (phone) phones.add(phone)
        }

        if (!phones.size) {
            return NextResponse.json({
                success: true,
                found: 0,
                added: 0,
                message: 'No customer numbers found in your orders yet',
            })
        }

        const rows = [...phones].map(phone => ({
            account_id: account.id,
            phone,
            source: 'order',
        }))

        // Chunked so a shop with tens of thousands of buyers does not send one
        // enormous request body.
        const CHUNK = 1000
        let added = 0
        for (let i = 0; i < rows.length; i += CHUNK) {
            const { data: inserted, error } = await (supabaseAdmin.from('sms_contacts') as any)
                .upsert(rows.slice(i, i + CHUNK), { onConflict: 'account_id,phone', ignoreDuplicates: true })
                .select('id')

            if (error) {
                console.error('[SmsImportOrders] upsert failed:', error)
                return NextResponse.json(
                    { error: 'Import stopped part-way. Press import again to finish.', added },
                    { status: 500 }
                )
            }
            added += (inserted || []).length
        }

        return NextResponse.json({
            success: true,
            found: phones.size,
            added,
            message: added
                ? `${added} new customer${added === 1 ? '' : 's'} imported from your orders`
                : 'Your customer list is already up to date with your orders',
        })
    } catch (error: any) {
        console.error('[SmsImportOrders] Error:', error)
        return NextResponse.json({ error: error.message || 'Failed to import customers' }, { status: 500 })
    }
}
