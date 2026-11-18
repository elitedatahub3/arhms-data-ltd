/**
 * ARHMS AI knowledge base CRUD (table ai_knowledge, migration 20261118010000).
 *
 * GET              → { ready, rows }            admin + sub-admin
 * POST   {row}     → create                     admin only
 * PATCH  {id,...}  → update                     admin only
 * DELETE ?id=      → delete                     admin only
 *
 * The table has RLS with no policies, so it is only reachable through this
 * route (service role) and the search_knowledge tool.
 */
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createRouteHandlerClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { isStaffRole } from '@/lib/ai-assistant/helpers'

export const dynamic = 'force-dynamic'

const SURFACES = ['dashboard', 'home', 'storefront', 'admin', 'whatsapp'] as const

const rowSchema = z.object({
    category: z.string().trim().min(1).max(60),
    question: z.string().trim().min(3).max(300),
    answer: z.string().trim().min(3).max(2000),
    contexts: z.array(z.enum(SURFACES)).min(1),
    is_active: z.boolean().default(true),
})

async function caller() {
    const supabase = await createRouteHandlerClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
    const db = createServerClient() as any
    const { data: me } = await db.from('users').select('role').eq('id', user.id).single()
    return { db, role: me?.role as string | undefined }
}

function forbidden() {
    return NextResponse.json({ error: 'Only admins can change the knowledge base' }, { status: 403 })
}

export async function GET() {
    const c = await caller()
    if ('error' in c) return c.error
    if (!isStaffRole(c.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const { data, error } = await c.db.from('ai_knowledge')
        .select('id, category, question, answer, contexts, is_active, updated_at')
        .order('category', { ascending: true }).order('question', { ascending: true }).limit(500)
    return NextResponse.json(
        { ready: !error, rows: data || [] },
        { headers: { 'Cache-Control': 'private, no-store' } },
    )
}

export async function POST(request: Request) {
    const c = await caller()
    if ('error' in c) return c.error
    if (c.role !== 'admin') return forbidden()

    const parsed = rowSchema.safeParse(await request.json().catch(() => null))
    if (!parsed.success) return NextResponse.json({ error: parsed.error.errors[0]?.message || 'Invalid entry' }, { status: 400 })

    const { data, error } = await c.db.from('ai_knowledge').insert(parsed.data).select().single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ row: data })
}

export async function PATCH(request: Request) {
    const c = await caller()
    if ('error' in c) return c.error
    if (c.role !== 'admin') return forbidden()

    const body = await request.json().catch(() => null)
    const id = z.string().uuid().safeParse(body?.id)
    if (!id.success) return NextResponse.json({ error: 'Missing id' }, { status: 400 })
    const parsed = rowSchema.partial().safeParse(body)
    if (!parsed.success) return NextResponse.json({ error: parsed.error.errors[0]?.message || 'Invalid entry' }, { status: 400 })

    const { data, error } = await c.db.from('ai_knowledge')
        .update({ ...parsed.data, updated_at: new Date().toISOString() })
        .eq('id', id.data).select().single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ row: data })
}

export async function DELETE(request: Request) {
    const c = await caller()
    if ('error' in c) return c.error
    if (c.role !== 'admin') return forbidden()

    const id = z.string().uuid().safeParse(new URL(request.url).searchParams.get('id'))
    if (!id.success) return NextResponse.json({ error: 'Missing id' }, { status: 400 })

    const { error } = await c.db.from('ai_knowledge').delete().eq('id', id.data)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true })
}
