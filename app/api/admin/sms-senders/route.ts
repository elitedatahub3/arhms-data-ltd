import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { validateAdminAccess } from '@/lib/auth-utils'
import { sendSenderIdApprovedSMS, sendSenderIdRejectedSMS } from '@/lib/sms-service'

/**
 * Admin queue for Customer SMS sender IDs.
 *
 * pending   → a shop asked for a name; nobody has reviewed it
 * submitted → admin has handed it to the provider / networks
 * approved  → the network accepted it; the shop can now send under it
 * rejected  → refused, with a reason the shop sees and can act on
 */

const STATUSES = ['pending', 'submitted', 'approved', 'rejected'] as const
type SenderStatus = typeof STATUSES[number]

/** Which moves an admin may make from each state. */
const TRANSITIONS: Record<SenderStatus, SenderStatus[]> = {
    pending: ['submitted', 'approved', 'rejected'],
    submitted: ['approved', 'rejected'],
    // Approval can be withdrawn if a network later revokes the name.
    approved: ['rejected'],
    rejected: [],
}

export async function GET(request: NextRequest) {
    try {
        const authResult = await validateAdminAccess(false, request)
        if (authResult.error) {
            return NextResponse.json({ error: authResult.error }, { status: authResult.status })
        }

        const supabase = createServerClient()
        const status = new URL(request.url).searchParams.get('status')

        let query = (supabase as any)
            .from('sms_sender_ids')
            .select(`
                id, sender, business_name, ghana_card_url, status, rejection_reason,
                submitted_at, approved_at, created_at,
                account:sms_accounts!inner(id, user_id, shop_id, status,
                    user:users(first_name, last_name, email, phone_number),
                    shop:shop_profiles(shop_name, shop_slug))
            `)
            .order('created_at', { ascending: true })
            .limit(200)

        if (status && (STATUSES as readonly string[]).includes(status)) query = query.eq('status', status)

        const { data, error } = await query
        if (error) {
            console.error('[AdminSmsSenders] query failed:', error)
            return NextResponse.json({ error: 'Failed to load sender IDs' }, { status: 500 })
        }

        // Head counts for the tab badges, so a reviewer sees the queue depth.
        const counts: Record<string, number> = {}
        await Promise.all(STATUSES.map(async (s) => {
            const { count } = await (supabase as any)
                .from('sms_sender_ids')
                .select('id', { count: 'exact', head: true })
                .eq('status', s)
            counts[s] = count ?? 0
        }))

        return NextResponse.json({ success: true, senders: data || [], counts })
    } catch (error: any) {
        console.error('[AdminSmsSenders] GET error:', error)
        return NextResponse.json({ error: 'Failed to load sender IDs' }, { status: 500 })
    }
}

export async function PATCH(request: NextRequest) {
    try {
        const authResult = await validateAdminAccess(false, request)
        if (authResult.error) {
            return NextResponse.json({ error: authResult.error }, { status: authResult.status })
        }
        const adminUser = authResult.user!

        const body: any = await request.json().catch(() => ({}))
        const { id, status, reason } = body

        if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })
        if (!(STATUSES as readonly string[]).includes(status)) {
            return NextResponse.json({ error: `status must be one of: ${STATUSES.join(', ')}` }, { status: 400 })
        }

        const rejectionReason = String(reason || '').trim()
        if (status === 'rejected' && !rejectionReason) {
            // The shop can only fix a rejection it understands.
            return NextResponse.json({ error: 'Give the shop a reason for the rejection' }, { status: 400 })
        }

        const supabase = createServerClient()

        const { data: existing } = await (supabase as any)
            .from('sms_sender_ids')
            .select('id, sender, status, account_id, account:sms_accounts(user_id)')
            .eq('id', id)
            .maybeSingle()

        if (!existing) return NextResponse.json({ error: 'Sender ID not found' }, { status: 404 })

        const from = existing.status as SenderStatus
        if (!TRANSITIONS[from].includes(status)) {
            return NextResponse.json({ error: `Cannot move a sender ID from ${from} to ${status}` }, { status: 400 })
        }

        const now = new Date().toISOString()
        const patch: Record<string, any> = { status, updated_at: now }
        if (status === 'submitted') patch.submitted_at = now
        if (status === 'approved') {
            patch.approved_at = now
            patch.approved_by = adminUser.id
            patch.rejection_reason = null
        }
        if (status === 'rejected') patch.rejection_reason = rejectionReason

        // Conditional on the status read above, so two reviewers acting at once
        // cannot both apply a transition.
        const { data: updated, error } = await (supabase as any)
            .from('sms_sender_ids')
            .update(patch)
            .eq('id', id)
            .eq('status', from)
            .select('id')
            .maybeSingle()

        if (error) {
            // Approving or submitting claims the name globally; the partial unique
            // index refuses it if another account already holds it.
            if (error.code === '23505') {
                return NextResponse.json(
                    { error: 'Another business already holds this sender ID. Reject this request with that reason.' },
                    { status: 409 }
                )
            }
            console.error('[AdminSmsSenders] update failed:', error)
            return NextResponse.json({ error: 'Could not update the sender ID' }, { status: 500 })
        }
        if (!updated) {
            return NextResponse.json({ error: 'This sender ID was changed by someone else. Refresh and try again.' }, { status: 409 })
        }

        const userId = existing.account?.user_id

        // First approved name becomes the account's default, so the shop can send
        // straight away without having to pick one.
        if (status === 'approved') {
            const { data: hasDefault } = await (supabase as any)
                .from('sms_sender_ids')
                .select('id')
                .eq('account_id', existing.account_id)
                .eq('status', 'approved')
                .eq('is_default', true)
                .maybeSingle()

            if (!hasDefault) {
                await (supabase as any).from('sms_sender_ids').update({ is_default: true }).eq('id', id)
                await (supabase as any)
                    .from('sms_accounts')
                    .update({ default_sender: existing.sender, updated_at: now })
                    .eq('id', existing.account_id)
            }
        }

        // Withdrawing an approval must also stop it being the default sender.
        if (status === 'rejected' && from === 'approved') {
            await (supabase as any).from('sms_sender_ids').update({ is_default: false }).eq('id', id)
            await (supabase as any)
                .from('sms_accounts')
                .update({ default_sender: null, updated_at: now })
                .eq('id', existing.account_id)
                .eq('default_sender', existing.sender)
        }

        if (userId && (status === 'approved' || status === 'rejected')) {
            const { data: subRow } = await (supabase as any)
                .from('sub_agents')
                .select('id')
                .eq('user_id', userId)
                .maybeSingle()

            await (supabase as any).from('notifications').insert({
                user_id: userId,
                title: status === 'approved' ? 'Sender ID Approved ✅' : 'Sender ID Not Approved',
                message: status === 'approved'
                    ? `Your sender ID "${existing.sender}" is approved. Your customer SMS will now arrive from ${existing.sender}.`
                    : `Your sender ID "${existing.sender}" was not approved. Reason: ${rejectionReason}`,
                type: 'system',
                action_url: subRow ? '/dashboard/sub/sms?tab=senders' : '/dashboard/shop/sms?tab=senders',
            })

            try {
                const { data: user } = await (supabase as any)
                    .from('users')
                    .select('phone_number')
                    .eq('id', userId)
                    .maybeSingle()
                const phone = user?.phone_number
                if (phone) {
                    if (status === 'approved') await sendSenderIdApprovedSMS(phone, existing.sender)
                    else await sendSenderIdRejectedSMS(phone, existing.sender, rejectionReason)
                }
            } catch (smsError) {
                console.error('[AdminSmsSenders] notification SMS failed:', smsError)
            }
        }

        return NextResponse.json({ success: true })
    } catch (error: any) {
        console.error('[AdminSmsSenders] PATCH error:', error)
        return NextResponse.json({ error: error.message || 'Failed to update sender ID' }, { status: 500 })
    }
}
