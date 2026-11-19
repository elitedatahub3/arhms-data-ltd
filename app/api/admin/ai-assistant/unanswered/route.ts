/**
 * Questions ARHMS AI could not answer (table ai_unanswered, migration 20261118020000).
 *
 * GET              -> { ready, rows }  open questions, newest first   (admin + sub-admin)
 * PATCH {id}       -> mark resolved                                  (admin only)
 */
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createRouteHandlerClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { isStaffRole } from '@/lib/ai-assistant/helpers'

export const dynamic = 'force-dynamic'

async function caller() {
    const supabase = await createRouteHandlerClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
    const db = createServerClient() as any
    const { data: me } = await db.from('users').select('role').eq('id', user.id).single()
    return { db, role: me?.role as string | undefined }
}

export async function GET() {
    const c = await caller()
    if ('error' in c) return c.error
    if (!isStaffRole(c.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const { data, error } = await c.db.from('ai_unanswered')
        .select('id, question, surface, created_at')
        .eq('resolved', false).order('created_at', { ascending: false }).limit(50)
    return NextResponse.json({ ready: !error, rows: data || [] }, { headers: { 'Cache-Control': 'private, no-store' } })
}

export async function PATCH(request: Request) {
    const c = await caller()
    if ('error' in c) return c.error
    if (c.role !== 'admin') return NextResponse.json({ error: 'Only admins can change this' }, { status: 403 })

    const body = await request.json().catch(() => null)
    const id = z.string().uuid().safeParse(body?.id)
    if (!id.success) return NextResponse.json({ error: 'Missing id' }, { status: 400 })

    const { error } = await c.db.from('ai_unanswered').update({ resolved: true }).eq('id', id.data)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true })
}
