import { NextRequest, NextResponse } from 'next/server'
import { createRouteHandlerClient } from '@/lib/supabase-server'
import { cookies } from 'next/headers'
import { validateAfaFormData } from '@/lib/afa-validation'
import { resolveAfaCostPrice, resolveAfaApiPrice } from '@/lib/afa-pricing'
import { isApiUserRow } from '@/lib/api-pricing'

export async function POST(request: NextRequest) {
    try {
        // ── 2A: Authenticate user ──────────────────────────────────
        const cookieStore = await cookies()
        const supabaseUserClient = await createRouteHandlerClient()

        const { data: { user: authUser }, error: authError } = await supabaseUserClient.auth.getUser()

        if (authError || !authUser) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const userId = authUser.id

        // ── Parse request body ────────────────────────────────────
        let body: any
        try {
            body = await request.json()
        } catch {
            return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
        }

        const { referenceCode, formData } = body

        if (!referenceCode || typeof referenceCode !== 'string') {
            return NextResponse.json({ error: 'Missing referenceCode' }, { status: 400 })
        }

        // Finding 8 fix — referenceCode length cap (legitimate UUIDs are 36 chars)
        if (referenceCode.length > 100) {
            return NextResponse.json({ error: 'Invalid reference code.' }, { status: 400 })
        }

        if (!formData || typeof formData !== 'object') {
            return NextResponse.json({ error: 'Missing form data' }, { status: 400 })
        }

        // ── Validate applicant payload ────────────────────────────
        // Required fields, length caps, ID-type and region allowlists, per-type ID
        // format (fail-closed) and the 18+ age check all live in lib/afa-validation
        // so this route and the storefront route cannot drift apart.
        const validationError = validateAfaFormData(formData)
        if (validationError) {
            return NextResponse.json(
                { error: validationError.error },
                { status: validationError.status }
            )
        }

        // ── 2B: Fetch user role ────────────────────────────────────
        const { data: userRow } = await (supabaseUserClient
            .from('users')
            // '*' so a database without is_api_user still works (lib/api-pricing.ts).
            .select('*')
            .eq('id', userId)
            .single() as any)

        const userRole = (userRow as any)?.role || 'customer'

        // ── 2C: Fetch price server-side using service role (bypasses RLS) ──
        // Uses supabaseAdmin so RLS on admin_settings cannot block the read.
        // Mirrors the exact pattern from app/api/user/upgrade/initialize/route.ts.
        const { createClient } = await import('@supabase/supabase-js')
        const supabaseAdmin = createClient(
            process.env.NEXT_PUBLIC_SUPABASE_URL!,
            process.env.SUPABASE_SERVICE_ROLE_KEY!,
            {
                auth: {
                    autoRefreshToken: false,
                    persistSession: false,
                }
            }
        )

        // API users pay the admin-set API price when one is set.
        const priceResult = isApiUserRow(userRow)
            ? await resolveAfaApiPrice(supabaseAdmin, userRole)
            : await resolveAfaCostPrice(supabaseAdmin, userRole)
        if (!priceResult.ok) {
            return NextResponse.json({ error: priceResult.error }, { status: 500 })
        }
        const price = priceResult.price

        // ── 2D: Call atomic RPC ───────────────────────────────────
        const { data: rpcResult, error: rpcError } = await (supabaseUserClient as any).rpc(
            'process_afa_order',
            {
                p_user_id:        userId,
                p_amount:         price,
                p_form_data:      formData,
                p_reference_code: referenceCode,
            }
        )

        // ── 2E: Handle errors ─────────────────────────────────────
        if (rpcError) {
            // Graceful duplicate: unique constraint violation (Postgres code 23505)
            if (
                rpcError.code === '23505' ||
                rpcError.message?.includes('afa_orders_reference_code_unique') ||
                rpcError.message?.includes('duplicate key')
            ) {
                // Ownership enforced via both referenceCode AND userId (Finding 9 fix)
                const { data: existingOrder, error: duplicateError } = await (supabaseUserClient
                    .from('afa_orders')
                    .select('id, status, payment_amount')
                    .eq('reference_code', referenceCode)
                    .eq('user_id', userId)
                    .single() as any)

                // Finding 7 fix — log ownership mismatch instead of silently returning null
                if (duplicateError) {
                    console.warn(
                        '[AFA Registration] Duplicate reference code but no matching order for user:',
                        userId,
                        duplicateError.code
                    )
                }

                return NextResponse.json({
                    success:     true,
                    isDuplicate: true,
                    order_id:    (existingOrder as any)?.id ?? null,
                })
            }

            // Insufficient balance
            if (rpcError.message?.includes('INSUFFICIENT_BALANCE')) {
                return NextResponse.json(
                    { error: 'INSUFFICIENT_BALANCE' },
                    { status: 400 }
                )
            }

            // Wallet not found
            if (rpcError.message?.includes('WALLET_NOT_FOUND')) {
                return NextResponse.json(
                    { error: 'Wallet not found' },
                    { status: 404 }
                )
            }

            console.error('[AFA Registration] RPC error:', rpcError)
            return NextResponse.json(
                { error: 'Failed to process registration' },
                { status: 500 }
            )
        }

        // ── 2F: Send Admin Notification (Asynchronous) ──────────────
        try {
            // Find main admins to notify (excluding sub_admin)
            const { data: adminUsers } = await supabaseUserClient
                .from('users')
                .select('email')
                .eq('role', 'admin')

            // Create a unique set of recipients (DB Admins + Env Fallback)
            const recipients = new Set<string>()
            if (process.env.ADMIN_EMAIL) recipients.add(process.env.ADMIN_EMAIL)

            if (adminUsers) {
                (adminUsers as any[]).forEach(u => {
                    if (u.email) recipients.add(u.email)
                })
            }

            if (recipients.size > 0) {
                const { sendAdminNewAfaApplicationAlert } = await import('@/lib/email-service')
                
                const notifyPromises = Array.from(recipients).map(email => 
                    sendAdminNewAfaApplicationAlert(
                        {
                            applicantName: formData.full_name,
                            phone: formData.phone,
                            region: formData.region
                        },
                        email
                    )
                )
                
                await Promise.allSettled(notifyPromises)
            }
        } catch (emailError) {
            console.error('[AFA Registration] Failed to send admin alert email:', emailError)
        }

        // ── Success ───────────────────────────────────────────────
        return NextResponse.json({
            success:        true,
            order_id:       rpcResult?.order_id,
            transaction_id: rpcResult?.transaction_id,
            new_balance:    rpcResult?.new_balance,
        })
    } catch (error) {
        console.error('[AFA Registration] Unexpected error:', error)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
