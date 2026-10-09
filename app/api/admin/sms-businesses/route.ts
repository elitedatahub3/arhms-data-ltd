import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { validateAdminAccess } from '@/lib/auth-utils'
import { maskGhanaCard } from '@/lib/sms/sms-rules'

/**
 * Admin review queue for SMS Platform business registrations.
 *
 * GET   ?status=pending|approved|rejected|draft|all — the registrations, with the owner.
 * PATCH { id, action: 'approve' | 'reject', reason? } — decide a pending one.
 *
 * Approval goes through review_sms_business(), which flips the registration and
 * the account's mode in one transaction.
 */

const STATUSES = ['draft', 'pending', 'approved', 'rejected'] as const

export async function GET(request: NextRequest) {
    try {
        const authResult = await validateAdminAccess(false, request)
        if (authResult.error) return NextResponse.json({ error: authResult.error }, { status: authResult.status })

        const supabase = createServerClient() as any
        const status = new URL(request.url).searchParams.get('status') || 'pending'

        let query = supabase
            .from('sms_businesses')
            .select('id, account_id, business_name, description, domain, ghana_card_last4, whatsapp, status, rejection_reason, submitted_at, reviewed_at, created_at, updated_at, account:sms_accounts!inner(id, user_id, mode, credits, status)')
            .order('submitted_at', { ascending: false, nullsFirst: false })
            .limit(200)

        if ((STATUSES as readonly string[]).includes(status)) query = query.eq('status', status)

        const { data, error } = await query
        if (error) {
            console.error('[AdminSmsBusinesses] GET failed:', error)
            return NextResponse.json({ error: error.code === '42P01' ? 'Run the SMS Platform migration first (20261010000000_sms_platform.sql).' : 'Failed to load registrations' }, { status: 500 })
        }

        const userIds = [...new Set((data || []).map((r: any) => r.account?.user_id).filter(Boolean))]
        const { data: users } = userIds.length
            ? await supabase.from('users').select('id, first_name, last_name, email, phone_number, role').in('id', userIds)
            : { data: [] }
        const byId = new Map<string, any>((users || []).map((u: any) => [u.id, u]))

        // Counts for the filter chips, one head query each.
        const counts: Record<string, number> = {}
        await Promise.all(STATUSES.map(async (s) => {
            const { count } = await supabase.from('sms_businesses').select('id', { count: 'exact', head: true }).eq('status', s)
            counts[s] = count ?? 0
        }))

        return NextResponse.json({
            success: true,
            counts,
            businesses: (data || []).map((r: any) => {
                const { ghana_card_last4, account, ...rest } = r
                return {
                    ...rest,
                    ghana_card_masked: maskGhanaCard(ghana_card_last4),
                    account: { id: account?.id, mode: account?.mode, credits: account?.credits, status: account?.status },
                    owner: byId.get(account?.user_id) ?? null,
                }
            }),
        })
    } catch (error: any) {
        console.error('[AdminSmsBusinesses] GET error:', error)
        return NextResponse.json({ error: 'Failed to load registrations' }, { status: 500 })
    }
}

export async function PATCH(request: NextRequest) {
    try {
        const authResult = await validateAdminAccess(false, request)
        if (authResult.error) return NextResponse.json({ error: authResult.error }, { status: authResult.status })

        const body: any = await request.json().catch(() => ({}))
        const id = String(body.id || '')
        const action = body.action
        const reason = String(body.reason || '').trim()

        if (!id || (action !== 'approve' && action !== 'reject')) {
            return NextResponse.json({ error: 'id and action (approve | reject) are required' }, { status: 400 })
        }
        if (action === 'reject' && reason.length < 3) {
            return NextResponse.json({ error: 'Give the owner a reason they can act on' }, { status: 400 })
        }

        const supabase = createServerClient() as any
        const { data, error } = await supabase.rpc('review_sms_business', {
            p_business_id: id,
            p_admin_id: authResult.user!.id,
            p_approve: action === 'approve',
            p_reason: reason || null,
        })

        if (error) {
            if (error.message?.includes('NOT_PENDING')) {
                return NextResponse.json({ error: 'This registration is no longer pending — refresh the list.' }, { status: 409 })
            }
            console.error('[AdminSmsBusinesses] review failed:', error)
            return NextResponse.json({ error: 'Could not save the decision' }, { status: 500 })
        }

        const result = (Array.isArray(data) ? data[0] : data) as { user_id: string } | undefined
        if (result?.user_id) {
            await supabase.from('notifications').insert({
                user_id: result.user_id,
                title: action === 'approve' ? 'Business Mode Active ✅' : 'Business Registration Not Approved',
                message: action === 'approve'
                    ? 'Your business is verified. You now have higher sending limits and can include links in your SMS.'
                    : `Your business registration was not approved. Reason: ${reason}. You can update it and submit again.`,
                type: 'system',
                action_url: '/dashboard/sms/business',
            }).then(({ error: notifyError }: any) => {
                if (notifyError) console.error('[AdminSmsBusinesses] notification failed:', notifyError)
            })
        }

        return NextResponse.json({ success: true, status: action === 'approve' ? 'approved' : 'rejected' })
    } catch (error: any) {
        console.error('[AdminSmsBusinesses] PATCH error:', error)
        return NextResponse.json({ error: error.message || 'Could not save the decision' }, { status: 500 })
    }
}
