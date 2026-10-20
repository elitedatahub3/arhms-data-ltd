import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { purchaseWithWallet } from '@/lib/vouchers/checkout'
import { isApiUserRow } from '@/lib/api-pricing'

export async function POST(request: NextRequest) {
    try {
        const supabase = await createRouteClient()
        
        // Ensure user is authenticated
        const { data: { session }, error: authError } = await supabase.auth.getSession()
        if (authError || !session) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        // Parse request body
        const body = await request.json()
        const { typeId, quantity, customerName, customerEmail, customerPhone } = body

        if (!typeId || !quantity || quantity <= 0) {
            return NextResponse.json({ error: 'Invalid request payload' }, { status: 400 })
        }

        // Get user profile for role
        const { data: userProfile, error: profileError } = await supabase
            .from('users')
            // '*' so a database without is_api_user still works (lib/api-pricing.ts).
            .select('*')
            .eq('id', session.user.id)
            .single()

        if (profileError || !userProfile) {
            return NextResponse.json({ error: 'User profile not found' }, { status: 404 })
        }

        const userRole = (userProfile as any).role || 'customer'
        const email = customerEmail || session.user.email || (userProfile as any).email
        const name = customerName || (userProfile as any).first_name || 'Customer'

        // Execute Wallet Purchase
        const result = await purchaseWithWallet({
            userId: session.user.id,
            userRole,
            typeId,
            quantity,
            customerName: name,
            customerEmail: email,
            customerPhone,
            // API users pay the admin-set API price when the type has one.
            apiPricing: isApiUserRow(userProfile),
        })

        return NextResponse.json({ success: true, data: result })

    } catch (error: any) {
        console.error('[WalletPurchase] Error:', error)
        
        // Standardize error responses
        if (error.message === 'PRODUCT_NOT_AVAILABLE') {
            return NextResponse.json({ error: 'This voucher is currently unavailable' }, { status: 400 })
        }
        if (error.message === 'INSUFFICIENT_BALANCE') {
            return NextResponse.json({ error: 'Insufficient wallet balance for this transaction' }, { status: 400 })
        }
        if (error.message === 'ORDER_CREATION_FAILED') {
            return NextResponse.json({ error: 'Could not create your order. Your wallet has been refunded.' }, { status: 500 })
        }
        if (error.message === 'INSUFFICIENT_INVENTORY') {
            return NextResponse.json({ error: 'Not enough vouchers in stock to fulfill this request' }, { status: 400 })
        }
        if (error.message === 'PRICING_ERROR_UNIT_BELOW_COST') {
            return NextResponse.json({ error: 'Pricing error. Please contact support.' }, { status: 500 })
        }

        return NextResponse.json({ error: 'Failed to process purchase' }, { status: 500 })
    }
}
