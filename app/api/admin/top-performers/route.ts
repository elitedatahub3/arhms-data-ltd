import { NextRequest, NextResponse } from 'next/server'
import { revalidateTag } from 'next/cache'
import { z } from 'zod'
import { createRouteHandlerClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { PUBLIC_CONFIG_CACHE_TAG } from '@/lib/cache-tags'
import {
    TOP_PERFORMERS_CACHE_TAG,
    TOP_PERFORMERS_KEYS,
    readTopPerformersConfig,
} from '@/lib/top-performers'
import { sendWinnerSms, type WinnerRow } from '@/lib/top-performers-winners'

export const dynamic = 'force-dynamic'

/**
 * Admin side of Top Performers: settings, and the frozen winners of past months
 * with their SMS state, a resend button and a "prize handed over" mark.
 */

async function requireAdmin() {
    const supabaseUser = await createRouteHandlerClient()
    const { data: { user }, error } = await supabaseUser.auth.getUser()
    if (error || !user) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }

    const { data: dbUser } = await supabaseUser
        .from('users').select('role').eq('id', user.id).single()

    if (!dbUser || !['admin', 'sub-admin'].includes((dbUser as any).role)) {
        return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }
    }
    return { user }
}

export async function GET() {
    const auth = await requireAdmin()
    if ('error' in auth) return auth.error

    const db = createServerClient() as any
    const [config, { data: winners, error }] = await Promise.all([
        readTopPerformersConfig(),
        db.from('top_performer_winners')
            .select('*, users:user_id(phone_number)')
            .order('month', { ascending: false })
            .order('board')
            .order('rank')
            .limit(60),
    ])
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    return NextResponse.json({
        config,
        winners: (winners || []).map((w: any) => ({ ...w, phone_number: w.users?.phone_number ?? null, users: undefined })),
    })
}

const prizeList = z.array(z.string().trim().max(60)).length(3)
const configSchema = z.object({
    enabled: z.boolean(),
    rankingsOnly: z.boolean(),
    contactPhone: z.string().trim().max(20),
    prizes: z.object({ dashboard: prizeList, shop: prizeList }),
})

export async function PUT(request: NextRequest) {
    const auth = await requireAdmin()
    if ('error' in auth) return auth.error

    const parsed = configSchema.safeParse(await request.json().catch(() => null))
    if (!parsed.success) {
        return NextResponse.json({ error: parsed.error.issues[0]?.message || 'Invalid settings' }, { status: 400 })
    }
    const { enabled, ...rest } = parsed.data

    const db = createServerClient() as any
    const { error } = await db.from('admin_settings').upsert([
        { key: TOP_PERFORMERS_KEYS.enabled, value: String(enabled) },
        { key: TOP_PERFORMERS_KEYS.config, value: JSON.stringify(rest) },
    ], { onConflict: 'key' })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    // The nav link rides on the public config; the boards carry prize labels.
    revalidateTag(PUBLIC_CONFIG_CACHE_TAG)
    revalidateTag(TOP_PERFORMERS_CACHE_TAG)
    return NextResponse.json({ success: true })
}

const actionSchema = z.object({
    id: z.string().uuid(),
    action: z.enum(['resend-sms', 'mark-claimed', 'unmark-claimed']),
})

export async function POST(request: NextRequest) {
    const auth = await requireAdmin()
    if ('error' in auth) return auth.error

    const parsed = actionSchema.safeParse(await request.json().catch(() => null))
    if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
    const { id, action } = parsed.data

    const db = createServerClient() as any
    const { data: row, error } = await db.from('top_performer_winners').select('*').eq('id', id).maybeSingle()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    if (!row) return NextResponse.json({ error: 'Winner not found' }, { status: 404 })

    if (action === 'resend-sms') {
        const outcome = await sendWinnerSms(row as WinnerRow, await readTopPerformersConfig(), { force: true })
        if (!outcome.sent) return NextResponse.json({ error: outcome.error }, { status: 502 })
        return NextResponse.json({ success: true })
    }

    const claimed = action === 'mark-claimed'
    const { error: updateError } = await db.from('top_performer_winners').update({
        claimed_at: claimed ? new Date().toISOString() : null,
        claimed_by: claimed ? auth.user.id : null,
    }).eq('id', id)
    if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 })
    return NextResponse.json({ success: true })
}
