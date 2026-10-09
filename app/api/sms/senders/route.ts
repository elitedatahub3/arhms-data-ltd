import { NextResponse } from 'next/server'
import { loadSmsContext, smsBlockReason, isCustomerSmsEnabled, SMS_DISABLED_MESSAGE } from '@/lib/sms/sms-purchase'
import { validateSenderId, getAllowedSenders, SENDER_ID_TIPS } from '@/lib/sms/customer-sms'
import { senderCapFor, getSmsBusiness } from '@/lib/sms/platform'

/**
 * Sender IDs: the brand name the shop's messages arrive from.
 *
 * A request here is only the start — an admin reviews it, hands it to the
 * networks, and marks it approved when they accept it. Nothing sendable is
 * created by this route.
 */
export async function GET() {
    try {
        const ctx = await loadSmsContext()
        if ('error' in ctx) return NextResponse.json({ error: ctx.error }, { status: ctx.status })

        const { supabaseAdmin, account, settingsMap, mode } = ctx

        const { data: senders } = await supabaseAdmin
            .from('sms_sender_ids')
            .select('id, sender, business_name, status, rejection_reason, is_default, submitted_at, approved_at, created_at')
            .eq('account_id', account.id)
            .order('created_at', { ascending: false })

        return NextResponse.json({
            success: true,
            senderIds: senders || [],
            allowedSenders: await getAllowedSenders(supabaseAdmin, account.id),
            tips: SENDER_ID_TIPS,
            mode,
            cap: senderCapFor(mode, settingsMap),
        })
    } catch (error: any) {
        console.error('[SmsSenders] GET error:', error)
        return NextResponse.json({ error: 'Failed to load your sender IDs' }, { status: 500 })
    }
}

export async function POST(request: Request) {
    try {
        const ctx = await loadSmsContext()
        if ('error' in ctx) return NextResponse.json({ error: ctx.error }, { status: ctx.status })

        const { supabaseAdmin, account, shop, sub, settingsMap } = ctx

        if (!isCustomerSmsEnabled(settingsMap)) {
            return NextResponse.json({ error: SMS_DISABLED_MESSAGE }, { status: 503 })
        }

        const blockedReason = smsBlockReason(shop, sub, ctx.userStatus)
        if (blockedReason) return NextResponse.json({ error: blockedReason }, { status: 403 })

        if (account.status !== 'active') {
            return NextResponse.json({ error: 'Unlock Customer SMS before requesting a sender ID' }, { status: 403 })
        }

        const body: any = await request.json().catch(() => ({}))
        const sender = String(body.sender || '').trim()
        const businessName = String(body.businessName || '').trim() || null
        const ghanaCardUrl = String(body.ghanaCardUrl || '').trim() || null

        // The same rule the form applies, re-run here: the form's copy of it is a
        // courtesy, this one is the gate.
        const check = validateSenderId(sender)
        if (!check.ok) {
            return NextResponse.json({ error: check.error, tips: SENDER_ID_TIPS }, { status: 400 })
        }

        // A rejected name can be resubmitted after the owner fixes it, so only a
        // request that is still live blocks a new one.
        const { count: liveCount } = await supabaseAdmin
            .from('sms_sender_ids')
            .select('id', { count: 'exact', head: true })
            .eq('account_id', account.id)
            .in('status', ['pending', 'submitted', 'approved'])

        // Platform Mode gets a few KYC-free names; an approved business gets
        // many. Both caps are admin settings.
        const cap = senderCapFor(ctx.mode, settingsMap)
        if ((liveCount ?? 0) >= cap) {
            return NextResponse.json(
                {
                    error: ctx.mode === 'business'
                        ? `You already have ${cap} sender IDs requested or approved. Contact support if you need more.`
                        : `Platform Mode accounts can hold ${cap} sender ID${cap === 1 ? '' : 's'}. Register your business to request more.`,
                    needsBusinessMode: ctx.mode !== 'business',
                },
                { status: 400 }
            )
        }

        const business = ctx.mode === 'business' ? await getSmsBusiness(supabaseAdmin, account.id) : null

        const row: Record<string, any> = {
            account_id: account.id,
            sender,
            business_name: businessName || business?.business_name || (shop as any)?.shop_name || null,
            ghana_card_url: ghanaCardUrl,
            status: 'pending',
        }
        // Only written once the migration has added the column; a 'platform'
        // default covers older databases.
        if (ctx.mode === 'business') row.kind = 'business'

        const { data: created, error } = await (supabaseAdmin.from('sms_sender_ids') as any)
            .insert(row)
            .select('id, sender, status, created_at')
            .single()

        if (error) {
            // The partial unique index on lower(sender) is what enforces global
            // uniqueness — a sender ID belongs to one business at the network.
            if ((error as any).code === '23505') {
                return NextResponse.json(
                    { error: 'That sender ID is already taken. Please choose a different name.' },
                    { status: 409 }
                )
            }
            console.error('[SmsSenders] insert failed:', error)
            return NextResponse.json({ error: 'Could not submit your sender ID' }, { status: 500 })
        }

        return NextResponse.json({
            success: true,
            senderId: created,
            message: 'Sender ID submitted. We will register it with the networks and let you know once it is approved.',
        })
    } catch (error: any) {
        console.error('[SmsSenders] POST error:', error)
        return NextResponse.json({ error: error.message || 'Failed to submit sender ID' }, { status: 500 })
    }
}
