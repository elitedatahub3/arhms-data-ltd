import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'crypto'
import { createServerClient } from '@/lib/supabase'
import { sendSMS } from '@/lib/sms-service'
import { validateGhanaianPhone } from '@/lib/phone-validation'

/**
 * Login-less seller entry point (phone-first).
 *
 * Takes only a phone number and, depending on whether that phone already owns
 * an account, returns one of three `mode`s the client acts on:
 *   - 'signin'         → existing seller: a magic-link token_hash to consume via
 *                        verifyOtp (does NOT touch their password).
 *   - 'login_required' → the phone belongs to a non-seller account; the client
 *                        sends them to normal login instead of silently taking
 *                        over a buyer account.
 *   - 'created'        → new phone: an invisible seller account is provisioned
 *                        and one-time credentials are returned for
 *                        signInWithPassword.
 *
 * The phone is NOT ownership-verified (product decision) — we limit the blast
 * radius by only auto-signing-in accounts already flagged is_seller.
 */
export async function POST(request: NextRequest) {
    try {
        const body = await request.json().catch(() => ({}))
        const { phone_number } = body ?? {}

        // 1. Validate + normalize the Ghana phone number
        const validation = validateGhanaianPhone(phone_number || '')
        if (!validation.isValid) {
            return NextResponse.json(
                { error: validation.error || 'Invalid phone number' },
                { status: 400 }
            )
        }
        const normalized = validation.normalizedNumber // 0XXXXXXXXX

        const supabase = createServerClient()

        // 2. Resolve the account by phone (UNIQUE), covering BOTH real-email and
        //    pseudo-email sellers. phone_number is stored in the same 0… form.
        const { data: existing } = await supabase
            .from('users')
            .select('id, email, is_seller, first_name')
            .eq('phone_number', normalized)
            .maybeSingle()

        if (existing) {
            // Non-seller account owns this phone → don't hijack it without any
            // verification; hand off to normal login.
            if (!existing.is_seller) {
                return NextResponse.json({ mode: 'login_required' }, { status: 200 })
            }

            // Existing seller → mint a session WITHOUT rotating their password.
            const { data: link, error: linkErr } = await supabase.auth.admin.generateLink({
                type: 'magiclink',
                email: existing.email,
            })

            if (linkErr || !link?.properties?.hashed_token) {
                console.error('[QuickStart] generateLink error:', linkErr?.message)
                return NextResponse.json({ error: 'Could not start seller session' }, { status: 500 })
            }

            return NextResponse.json(
                { mode: 'signin', token_hash: link.properties.hashed_token },
                { status: 200 }
            )
        }

        // 3. New phone → provision an invisible seller account.
        const intl = '233' + normalized.slice(1) // 233XXXXXXXXX
        const pseudoEmail = `seller_${intl}@sellers.arhmsgh.com`
        const password = `${randomUUID()}${randomUUID()}`

        let userId: string | null = null
        let firstName = 'Seller'

        const { data: created, error: createErr } = await supabase.auth.admin.createUser({
            email: pseudoEmail,
            password,
            email_confirm: true,
            user_metadata: { first_name: 'Seller', phone_number: normalized },
        })

        if (createErr || !created?.user) {
            // Handle a race where the account was created between the lookup and now
            const { data: raced } = await supabase
                .from('users')
                .select('id, first_name')
                .eq('email', pseudoEmail)
                .maybeSingle()

            if (raced?.id) {
                userId = raced.id
                firstName = raced.first_name || 'Seller'
                await supabase.auth.admin.updateUserById(userId, { password })
            } else {
                console.error('[QuickStart] createUser error:', createErr?.message)
                return NextResponse.json({ error: 'Could not create seller account' }, { status: 500 })
            }
        } else {
            userId = created.user.id
        }

        // Mark seller + store phone on the public.users row
        const { error: sellerErr } = await supabase
            .from('users')
            .update({ is_seller: true, phone_number: normalized })
            .eq('id', userId)

        if (sellerErr) {
            console.error('[QuickStart] Failed to set is_seller:', sellerErr.message)
            return NextResponse.json({ error: 'Could not enable seller status' }, { status: 500 })
        }

        // Welcome SMS (non-fatal, new sellers only)
        const welcomeMessage = `Welcome ${firstName}! 🎉 You are now a seller on ARHMS MARKETPLACE. Start posting items to reach buyers. Visit: arhmsgh.com`
        const smsResult = await sendSMS({ recipient: normalized, message: welcomeMessage })
        if (!smsResult.success) {
            console.warn('[QuickStart] SMS failed (seller still enabled):', smsResult.error)
        }

        // Hand back one-time credentials for the client to sign in with
        return NextResponse.json({ mode: 'created', email: pseudoEmail, password }, { status: 200 })
    } catch (error: any) {
        console.error('[QuickStart] Exception:', error?.message)
        return NextResponse.json(
            { error: error?.message || 'Failed to start selling' },
            { status: 500 }
        )
    }
}
