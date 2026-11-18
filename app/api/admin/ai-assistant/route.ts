/**
 * ARHMS AI admin: current settings + usage (today and last 7 days).
 * Settings are saved through POST /api/admin-settings (ai_assistant_mode,
 * ai_assistant_daily_limit) like every other admin switch.
 */
import { NextResponse } from 'next/server'
import { createRouteHandlerClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { dayStartIso, parseAssistantMode, parseDailyLimit, resolveAssistantModel } from '@/lib/ai-assistant/helpers'

export const dynamic = 'force-dynamic'

// USD per million tokens, DeepSeek list price without cache hits (an overestimate when the prefix cache hits). Estimate only; check platform.deepseek.com for current rates.
const INPUT_USD_PER_M = 0.28
const OUTPUT_USD_PER_M = 0.42

function summarise(rows: any[]) {
    const users = new Set<string>()
    let questions = 0
    let inputTokens = 0
    let outputTokens = 0
    for (const r of rows) {
        users.add(r.user_id)
        if (r.role === 'user') questions++
        inputTokens += r.input_tokens || 0
        outputTokens += r.output_tokens || 0
    }
    const usd = (inputTokens * INPUT_USD_PER_M + outputTokens * OUTPUT_USD_PER_M) / 1_000_000
    return { questions, users: users.size, inputTokens, outputTokens, estUsd: Number(usd.toFixed(4)) }
}

export async function GET() {
    const supabase = await createRouteHandlerClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const db = createServerClient() as any
    const { data: me } = await db.from('users').select('role').eq('id', user.id).single()
    if (me?.role !== 'admin' && me?.role !== 'sub-admin') {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const weekStart = new Date(dayStartIso())
    weekStart.setUTCDate(weekStart.getUTCDate() - 6)

    const [{ data: settings }, { data: rows, error }] = await Promise.all([
        db.from('admin_settings').select('key, value').in('key', ['ai_assistant_mode', 'ai_assistant_daily_limit', 'ai_model_dashboard']),
        db.from('ai_chat_messages').select('user_id, role, input_tokens, output_tokens, created_at')
            .gte('created_at', weekStart.toISOString()).limit(50000),
    ])

    const s: Record<string, string> = {}
    for (const r of settings || []) s[r.key] = r.value

    const all = rows || []
    const todayStart = dayStartIso()
    return NextResponse.json(
        {
            mode: parseAssistantMode(s.ai_assistant_mode),
            dailyLimit: parseDailyLimit(s.ai_assistant_daily_limit),
            keyConfigured: !!process.env.DEEPSEEK_API_KEY,
            canEdit: me?.role === 'admin',
            model: resolveAssistantModel(s.ai_model_dashboard, process.env.AI_ASSISTANT_MODEL),
            // Table missing = migration 20261118000000 not run yet.
            tableReady: !error,
            today: summarise(all.filter((r: any) => r.created_at >= todayStart)),
            week: summarise(all),
        },
        { headers: { 'Cache-Control': 'private, no-store' } },
    )
}
