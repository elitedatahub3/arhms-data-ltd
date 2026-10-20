import { NextRequest, NextResponse } from 'next/server'
import { revalidateTag } from 'next/cache'
import { createServerClient } from '@/lib/supabase'
import { validateAdminAccess } from '@/lib/auth-utils'
import { CHANNELS, computeChannelEstimate } from '@/lib/delivery-estimate'
import { DELIVERY_STATUS_CACHE_TAG, getDeliverySignals } from '@/lib/delivery-status'

/**
 * Admin view of the delivery estimate: the raw C/P timestamps behind each row,
 * and the "mark this channel down" override. Full admins only.
 */
export async function GET(request: NextRequest) {
    const authResult = await validateAdminAccess(false, request)
    if (authResult.error) return NextResponse.json({ error: authResult.error }, { status: authResult.status })

    try {
        revalidateTag(DELIVERY_STATUS_CACHE_TAG)
        const signals = await getDeliverySignals()
        const now = Date.now()
        return NextResponse.json({
            channels: signals.map((s) => ({ signal: s, estimate: computeChannelEstimate(s, now) })),
        })
    } catch (error: any) {
        return NextResponse.json({ error: error?.message || 'Failed to load delivery status' }, { status: 500 })
    }
}

export async function PATCH(request: NextRequest) {
    const authResult = await validateAdminAccess(false, request)
    if (authResult.error) return NextResponse.json({ error: authResult.error }, { status: authResult.status })

    const body = await request.json().catch(() => null)
    const channel = body?.channel
    if (!(CHANNELS as readonly string[]).includes(channel)) {
        return NextResponse.json({ error: 'Unknown channel' }, { status: 400 })
    }
    const isManuallyDown = body?.isManuallyDown === true
    const reason = typeof body?.reason === 'string' ? body.reason.trim().slice(0, 120) || null : null

    const db = createServerClient() as any
    // Editing the reason of a channel already down keeps its original "since",
    // which is also the moment its numbers were frozen.
    const { data: existing } = await db
        .from('delivery_channel_overrides')
        .select('is_manually_down, since')
        .eq('channel', channel)
        .maybeSingle()
    const since = !isManuallyDown
        ? null
        : existing?.is_manually_down && existing.since ? existing.since : new Date().toISOString()

    const { error } = await db
        .from('delivery_channel_overrides')
        .upsert({
            channel,
            is_manually_down: isManuallyDown,
            reason: isManuallyDown ? reason : null,
            since,
            updated_by: authResult.user!.id,
            updated_at: new Date().toISOString(),
        }, { onConflict: 'channel' })

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    revalidateTag(DELIVERY_STATUS_CACHE_TAG)
    return NextResponse.json({ ok: true })
}
