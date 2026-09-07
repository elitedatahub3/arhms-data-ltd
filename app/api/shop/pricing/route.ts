import { NextResponse } from 'next/server'
import { createRouteHandlerClient } from '@/lib/supabase-server'
import { cookies } from 'next/headers'
import { createServerClient } from '@/lib/supabase'

export async function GET() {
    try {
        const supabaseAuth = await createRouteHandlerClient()
        const { data: { user: authUser } } = await supabaseAuth.auth.getUser()
        
        if (!authUser) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const supabase = createServerClient()
        const { data, error } = await supabase
            .from('admin_settings')
            .select('key, value')
            .in('key', [
                'airtime_fee_mtn_customer', 'airtime_fee_mtn_agent',
                'airtime_fee_telecel_customer', 'airtime_fee_telecel_agent',
                'airtime_fee_at_customer', 'airtime_fee_at_agent'
            ])

        if (error) throw error

        const settings: Record<string, string> = {}
        for (const row of (data as any) || []) settings[row.key] = String(row.value)

        return NextResponse.json(settings)
    } catch (err: any) {
        console.error('Settings API Error:', err)
        return NextResponse.json({ error: 'Failed to fetch settings' }, { status: 500 })
    }
}

export async function POST(req: Request) {
    try {
        const supabase = await createRouteHandlerClient()
        
        // Ensure user is authenticated
        const { data: { user: authUser } } = await supabase.auth.getUser()
        if (!authUser) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const body = await req.json()
        const { shopId, items, airtimeFees } = body

        if (!shopId) {
            return NextResponse.json({ error: 'Invalid payload' }, { status: 400 })
        }

        // Verify shop ownership
        const { data: shopProfile, error: shopError } = await supabase
            .from('shop_profiles')
            .select('owner_id')
            .eq('id', shopId)
            .single()

        if (shopError || !shopProfile || shopProfile.owner_id !== authUser.id) {
            return NextResponse.json({ error: 'Unauthorized to modify this shop' }, { status: 403 })
        }

        const { data: userData } = await supabase.from('users').select('role').eq('id', shopProfile.owner_id).single()
        const userRole = userData?.role || 'customer'
        const maxDataProfit = userRole === 'agent' ? 10 : 5

        // Fetch Admin Settings to properly calculate Airtime caps (Bypassing RLS via Service Role)
        const adminDb = createServerClient()
        const { data: adminSettingsData } = await adminDb.from('admin_settings').select('key, value')
        const adminSettings: Record<string, string> = {}
        for (const row of (adminSettingsData as any) || []) adminSettings[row.key] = String(row.value)

        // A sub-agent's data prices are bounded by their upline's, not by the
        // role-based cap below. This route would let them out of that bound
        // entirely — /dashboard/shop/pricing is reachable from the sub portal —
        // so send them to the screen that enforces it. Airtime fees fall
        // through: those are mirrored from the parent, not bounded by them.
        if (items && Array.isArray(items) && items.length > 0) {
            const { data: subMembership } = await adminDb
                .from('sub_agents')
                .select('id')
                .eq('user_id', authUser.id)
                .maybeSingle()

            if (subMembership) {
                return NextResponse.json(
                    { error: 'Set your data prices from your own Pricing page, where your upline’s price is the floor.' },
                    { status: 403 }
                )
            }
        }

        // Strict Backend Validation for Data Packages
        if (items && Array.isArray(items)) {
            for (const item of items) {
                if (item.profit_margin === undefined || item.profit_margin === null) {
                    return NextResponse.json({ error: 'Missing profit margin' }, { status: 400 })
                }
                if (item.profit_margin <= 0) {
                    return NextResponse.json({ error: 'Profit must be more than 0' }, { status: 400 })
                }
                if (item.profit_margin > maxDataProfit) {
                    return NextResponse.json({ error: `Profit cannot exceed GHS ${maxDataProfit.toFixed(2)}` }, { status: 400 })
                }
                
                if (!item.package_id || !item.selling_price) {
                    return NextResponse.json({ error: 'Invalid payload format' }, { status: 400 })
                }
                
                item.shop_id = shopId
            }

            // Carry each package's wholesale price across the rewrite.
            //
            // shop_pricing.sub_price is what this shop charges its sub-agents,
            // set on a different screen (/api/shop/sub-pricing). Clearing the
            // rows would drop it on every retail save, silently wiping the
            // whole downline's cost basis.
            //
            // It has to survive a delete-and-reinsert rather than becoming an
            // upsert: protect_shop_pricing_updates() raises 'profit_margin
            // cannot be changed after creation' on any UPDATE that moves
            // profit_margin, and re-pricing always moves it. Replacing the row
            // is what has always sidestepped that.
            // Service role, deliberately. shop_pricing's only write policy is
            // shop_pricing_admin_write, USING (is_admin()) — owners get
            // shop_pricing_owner_read and nothing more. Under the request-scoped
            // client a shop owner's DELETE silently matched zero rows (RLS hides
            // them rather than erroring) and the INSERT was refused outright, which
            // is the "Failed to insert pricing data" every non-admin owner hit.
            //
            // Authorisation is not weakened by this: ownership is proved above
            // against shop_profiles.owner_id and a mismatch already 403s, which is
            // the same check the missing policy would have made.
            const { data: existingPricing } = await adminDb
                .from('shop_pricing')
                .select('*')
                .eq('shop_id', shopId)

            const previousRows = (existingPricing as any[]) || []

            const wholesaleByPackage = new Map<string, number>(
                previousRows
                    .filter((row: any) => row.sub_price != null)
                    .map((row: any) => [row.package_id, Number(row.sub_price)])
            )

            for (const item of items) {
                const kept = wholesaleByPackage.get(item.package_id)
                if (kept != null) item.sub_price = kept
            }

            // Clear existing pricing to prevent duplicates
            const { error: deleteError } = await adminDb
                .from('shop_pricing')
                .delete()
                .eq('shop_id', shopId)

            if (deleteError) {
                console.error('[ShopPricing] delete failed:', shopId, deleteError.message)
                return NextResponse.json({ error: 'Failed to clear previous pricing data' }, { status: 500 })
            }

            // Insert new pricing capturing profit_margin explicitly if elements exist
            if (items.length > 0) {
                const { error: insertError } = await (adminDb as any)
                    .from('shop_pricing')
                    .insert(items)

                if (insertError) {
                    // The delete has already committed — these are two statements, not
                    // a transaction — so failing here without putting the old rows
                    // back would leave the shop with no pricing at all and its
                    // storefront unable to sell. Restore what was there.
                    console.error('[ShopPricing] insert failed:', shopId, insertError.message)
                    let restored = false
                    if (previousRows.length > 0) {
                        const { error: restoreError } = await (adminDb as any)
                            .from('shop_pricing')
                            .insert(previousRows)
                        restored = !restoreError
                        if (restoreError) {
                            console.error('[ShopPricing] RESTORE FAILED, shop left with no pricing:', shopId, restoreError.message)
                        }
                    }
                    return NextResponse.json(
                        {
                            error: restored || previousRows.length === 0
                                ? `Could not save pricing: ${insertError.message}`
                                : `Could not save pricing and the previous prices could not be restored: ${insertError.message}. Contact support before selling.`,
                        },
                        { status: 500 }
                    )
                }
            }
        }

        // Secure Airtime Fee calculations & clamping strictly bounding at MAX 10% including admin baseline
        let airtimeUpdates: any = {}
        if (airtimeFees) {
            for (const net of ['mtn', 'telecel', 'at']) {
                if (airtimeFees[net] !== undefined) {
                    let fee = parseFloat(airtimeFees[net])
                    if (isNaN(fee) || fee < 0) fee = 0

                    const adminFeeKey = `airtime_fee_${net}_${userRole}`
                    const baseAdminFeeString = adminSettings[adminFeeKey] || '0'
                    const baseAdminFee = parseFloat(baseAdminFeeString)

                    const maxAllowedFee = Math.max(0, 10 - baseAdminFee)
                    if (fee > maxAllowedFee) fee = maxAllowedFee

                    airtimeUpdates[`airtime_fee_${net}`] = fee
                }
            }
        }

        // Only enforce go-live guard when items are submitted
        if (items !== undefined) {
            const hasValidPrice = Array.isArray(items) && items.some(
                (item: any) => typeof item.selling_price === 'number' && item.selling_price > 0
            )
            if (!hasValidPrice) {
                return NextResponse.json(
                    { error: 'At least one item must have a valid price before your shop can go live.' },
                    { status: 400 }
                )
            }
        }

        // Instantly make the shop live and save the new airtime prices inline
        const profileUpdates = {
            pricing_status: 'approved',
            approval_status: 'approved',
            is_active: true,
            pricing_submitted_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            ...airtimeUpdates
        }

        const { error: updateError } = await (adminDb as any)
            .from('shop_profiles')
            .update(profileUpdates)
            .eq('id', shopId)

        if (updateError) {
            return NextResponse.json({ error: 'Pricing saved but failed to update shop status' }, { status: 500 })
        }

        return NextResponse.json({ success: true })
    } catch (err: any) {
        console.error('Pricing API Error:', err)
        return NextResponse.json({ error: err.message || 'Internal server error' }, { status: 500 })
    }
}
