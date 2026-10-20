import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { validateAdminAccess } from '@/lib/auth-utils'
import { sendSenderIdApprovedSMS, sendSenderIdRejectedSMS, getActiveSmsProvider } from '@/lib/sms-service'
import { fetchKingFlexySenders, fetchKingFlexyBalance } from '@/lib/kingflexy-sms-service'
import { validateSenderId } from '@/lib/sms/sms-rules'
import { resolveSmsAccount, senderClaimedByOtherUser } from '@/lib/sms/customer-sms'

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
        const url = new URL(request.url)
        const status = url.searchParams.get('status')

        // Shop picker for "add a sender ID": admins know the shop by name, not by
        // the account id the sender row actually hangs off.
        const lookup = (url.searchParams.get('lookup') || '').trim()
        if (lookup) {
            const { data: shops } = await (supabase as any)
                .from('shop_profiles')
                .select('id, shop_name, shop_slug, approval_status, owner_id, owner:users!shop_profiles_owner_id_fkey(first_name, last_name, phone_number)')
                .or(`shop_name.ilike.%${lookup}%,shop_slug.ilike.%${lookup}%`)
                .limit(20)

            const ownerIds = (shops || []).map((row: any) => row.owner_id).filter(Boolean)
            const { data: accounts } = ownerIds.length
                ? await (supabase as any)
                    .from('sms_accounts')
                    // * so scope is read when it exists; a row without it predates the
                    // split and is the shop account.
                    .select('*')
                    .in('user_id', ownerIds)
                : { data: [] }

            // Admin adds senders to the SHOP's Customer SMS account here, never to
            // the owner's SMS Platform account.
            const byUser = new Map<string, any>((accounts || [])
                .filter((a: any) => (a.scope ?? 'shop') === 'shop')
                .map((a: any) => [a.user_id, a]))

            return NextResponse.json({
                success: true,
                shops: (shops || []).map((row: any) => ({
                    id: row.id,
                    shopName: row.shop_name,
                    shopSlug: row.shop_slug,
                    approvalStatus: row.approval_status,
                    ownerId: row.owner_id,
                    ownerName: [row.owner?.first_name, row.owner?.last_name].filter(Boolean).join(' ') || null,
                    ownerPhone: row.owner?.phone_number || null,
                    // Null means the shop has never opened Customer SMS; adding a
                    // sender still works, it is just locked until they pay to unlock.
                    accountStatus: byUser.get(row.owner_id)?.status ?? null,
                })),
            })
        }

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

        // When KingFlexy is the gateway, a sender ID approved here still bounces
        // unless it is ALSO registered on the platform's KingFlexy account. The
        // reviewer sees that list rather than discovering it from failed sends.
        let providerSenders: string[] | null = null
        let providerBalance: number | null = null
        let providerError: string | null = null

        if (await getActiveSmsProvider('storefront') === 'kingflexy') {
            const [senderList, balance] = await Promise.all([
                fetchKingFlexySenders(),
                fetchKingFlexyBalance(),
            ])
            providerSenders = senderList.ok ? senderList.senders.map(x => x.sender) : null
            providerBalance = balance.ok ? (balance.credits ?? null) : null
            providerError = senderList.ok ? null : (senderList.error || 'Could not reach KingFlexy')
        }

        return NextResponse.json({
            success: true,
            senders: data || [],
            counts,
            provider: await getActiveSmsProvider('storefront'),
            providerSenders,
            providerBalance,
            providerError,
        })
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

        // Submitting or approving claims the name. Another person holding it
        // blocks that; the same owner's other SMS account (shop or platform) does not.
        if ((status === 'submitted' || status === 'approved')
            && await senderClaimedByOtherUser(supabase, existing.sender, (existing as any).account?.user_id)) {
            return NextResponse.json(
                { error: 'Another business already holds this sender ID. Reject this request with that reason.' },
                { status: 409 }
            )
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

/**
 * Adds a sender ID for a shop, on the shop's behalf.
 *
 * The normal flow is the shop requesting and an admin approving. This is the
 * other direction, for when an admin has already registered the name on the
 * ARHMS KingFlexy account and just needs ARHMS to agree — otherwise the shop
 * has to be talked through requesting a name that is, in effect, already live.
 *
 * body: { shopId, sender, businessName?, status?: 'pending' | 'submitted' | 'approved' }
 */
export async function POST(request: NextRequest) {
    try {
        const authResult = await validateAdminAccess(false, request)
        if (authResult.error) {
            return NextResponse.json({ error: authResult.error }, { status: authResult.status })
        }
        const adminUser = authResult.user!

        const body: any = await request.json().catch(() => ({}))
        const shopId = String(body.shopId || '')
        const sender = String(body.sender || '').trim()
        const status = ['pending', 'submitted', 'approved'].includes(body.status) ? body.status : 'approved'

        if (!shopId) return NextResponse.json({ error: 'Choose a shop' }, { status: 400 })

        // The same rule the shop's own form applies. An admin may be registering a
        // name the networks already took, but a name the networks will REFUSE
        // helps nobody, so the check holds on this path too.
        const check = validateSenderId(sender)
        if (!check.ok) return NextResponse.json({ error: check.error }, { status: 400 })

        const supabase = createServerClient()

        const { data: shop } = await (supabase as any)
            .from('shop_profiles')
            .select('id, owner_id, shop_name')
            .eq('id', shopId)
            .maybeSingle()

        if (!shop?.owner_id) return NextResponse.json({ error: 'Shop not found' }, { status: 404 })

        // Creates the SMS account if the shop has never opened Customer SMS. It
        // starts 'locked' — the sender is ready for whenever they unlock, and
        // nothing can be sent until they do.
        const account = await resolveSmsAccount(supabase, shop.owner_id, shop.id)
        if (!account) return NextResponse.json({ error: 'Could not resolve the shop SMS account' }, { status: 500 })

        if (status !== 'pending' && await senderClaimedByOtherUser(supabase, sender, shop.owner_id)) {
            return NextResponse.json({ error: 'Another business already holds this sender ID.' }, { status: 409 })
        }

        const now = new Date().toISOString()
        const row: Record<string, any> = {
            account_id: account.id,
            sender,
            business_name: String(body.businessName || '').trim() || shop.shop_name || null,
            status,
        }
        if (status === 'submitted') row.submitted_at = now
        if (status === 'approved') {
            row.submitted_at = now
            row.approved_at = now
            row.approved_by = adminUser.id
        }

        const { data: created, error } = await (supabase as any)
            .from('sms_sender_ids')
            .insert(row)
            .select('id, sender, status')
            .single()

        if (error) {
            // (account_id, sender) is unique, and lower(sender) is globally unique
            // once submitted or approved — the two collisions read differently.
            if (error.code === '23505') {
                return NextResponse.json(
                    { error: 'That sender ID already exists, either for this shop or for another business.' },
                    { status: 409 }
                )
            }
            console.error('[AdminSmsSenders] insert failed:', error)
            return NextResponse.json({ error: 'Could not add the sender ID' }, { status: 500 })
        }

        if (status === 'approved') {
            // First approved name becomes the default, so the shop can send without
            // having to choose one.
            const { data: hasDefault } = await (supabase as any)
                .from('sms_sender_ids')
                .select('id')
                .eq('account_id', account.id)
                .eq('status', 'approved')
                .eq('is_default', true)
                .maybeSingle()

            if (!hasDefault) {
                await (supabase as any).from('sms_sender_ids').update({ is_default: true }).eq('id', created.id)
                await (supabase as any)
                    .from('sms_accounts')
                    .update({ default_sender: sender, updated_at: now })
                    .eq('id', account.id)
            }

            const { data: subRow } = await (supabase as any)
                .from('sub_agents')
                .select('id')
                .eq('user_id', shop.owner_id)
                .maybeSingle()

            await (supabase as any).from('notifications').insert({
                user_id: shop.owner_id,
                title: 'Sender ID Approved ✅',
                message: `Your sender ID "${sender}" is approved. Your customer SMS will now arrive from ${sender}.`,
                type: 'system',
                action_url: subRow ? '/dashboard/sub/sms?tab=senders' : '/dashboard/shop/sms?tab=senders',
            })

            try {
                const { data: user } = await (supabase as any)
                    .from('users')
                    .select('phone_number')
                    .eq('id', shop.owner_id)
                    .maybeSingle()
                if (user?.phone_number) await sendSenderIdApprovedSMS(user.phone_number, sender)
            } catch (smsError) {
                console.error('[AdminSmsSenders] approval SMS failed:', smsError)
            }
        }

        return NextResponse.json({ success: true, senderId: created, accountStatus: account.status })
    } catch (error: any) {
        console.error('[AdminSmsSenders] POST error:', error)
        return NextResponse.json({ error: error.message || 'Failed to add the sender ID' }, { status: 500 })
    }
}
