/**
 * ARHMS AI chat.
 *
 * GET  → { enabled, remaining, limit, conversationId, messages } (last conversation, 24h)
 * POST { message, conversationId? } → NDJSON stream of
 *        {type:'meta', conversationId} | {type:'text', text} | {type:'cards', cards}
 *        | {type:'done', remaining} | {type:'error', error}
 *
 * Gate: admin_settings.ai_assistant_mode (off | admins | all), daily cap from
 * ai_assistant_daily_limit counted in ai_chat_messages (no Redis). Tools are
 * read-only; see lib/ai-assistant/tools.ts.
 */
import { NextResponse } from 'next/server'
import { randomUUID } from 'crypto'
import { createRouteHandlerClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { loadAssistantAccess } from '@/lib/ai-assistant/access'
import { deepSeekTurn, DeepSeekError } from '@/lib/ai-assistant/deepseek'
import { runAgentLoop, type EngineMessage } from '@/lib/ai-assistant/engine'
import { cleanUserMessage, MAX_MESSAGE_CHARS, SURFACE_LIMITS } from '@/lib/ai-assistant/helpers'
import { ASSISTANT_SYSTEM_PROMPT } from '@/lib/ai-assistant/system-prompt'
import { executeAssistantTool, toolsForSurface, type BundleCard } from '@/lib/ai-assistant/tools'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const SURFACE = 'dashboard' as const
const HISTORY_MESSAGES = 10
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const BUSY = 'ARHMS AI is busy right now. Please try again in a moment.'
const REFUSED = "Sorry, I can't help with that. Ask me about your wallet, orders or data prices."

async function currentUserId(): Promise<string | null> {
    const supabase = await createRouteHandlerClient()
    const { data: { user } } = await supabase.auth.getUser()
    return user?.id ?? null
}

export async function GET() {
    const userId = await currentUserId()
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const db = createServerClient() as any
    const access = await loadAssistantAccess(db, userId)
    if (!access.allowed) return NextResponse.json({ enabled: false })

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const { data: last } = await db.from('ai_chat_messages').select('conversation_id')
        .eq('user_id', userId).gte('created_at', since)
        .order('created_at', { ascending: false }).limit(1).maybeSingle()

    let messages: any[] = []
    if (last?.conversation_id) {
        const { data } = await db.from('ai_chat_messages').select('role, content, cards, created_at')
            .eq('user_id', userId).eq('conversation_id', last.conversation_id)
            .order('created_at', { ascending: true }).limit(40)
        messages = data || []
    }

    return NextResponse.json(
        {
            enabled: true,
            remaining: access.remaining,
            limit: access.limit,
            maxChars: MAX_MESSAGE_CHARS,
            conversationId: last?.conversation_id ?? null,
            messages,
        },
        { headers: { 'Cache-Control': 'private, no-store' } },
    )
}

/** Stored rows → alternating user/assistant text turns starting with 'user'. */
function toHistory(rows: { role: string; content: string }[]): EngineMessage[] {
    const out: EngineMessage[] = []
    for (const r of rows) {
        const role = r.role === 'assistant' ? 'assistant' : 'user'
        const text = (r.content || '').trim()
        if (!text) continue
        if (!out.length && role === 'assistant') continue
        const prev = out[out.length - 1]
        if (prev && prev.role === role) {
            prev.content = `${prev.content as string}\n\n${text}`
        } else {
            out.push({ role, content: text })
        }
    }
    // The new question is appended as a user turn, so history must end on assistant.
    if (out.length && out[out.length - 1].role === 'user') out.pop()
    return out
}

export async function POST(request: Request) {
    const userId = await currentUserId()
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    let body: any
    try {
        body = await request.json()
    } catch {
        return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
    }

    const message = cleanUserMessage(body?.message)
    if (!message) {
        return NextResponse.json({ error: `Type a message of up to ${MAX_MESSAGE_CHARS} characters.` }, { status: 400 })
    }

    const db = createServerClient() as any
    const access = await loadAssistantAccess(db, userId)
    if (!access.allowed) return NextResponse.json({ error: 'ARHMS AI is not available.' }, { status: 403 })
    if (access.remaining <= 0) {
        return NextResponse.json(
            { error: `You have used your ${access.limit} ARHMS AI messages for today. Try again tomorrow.` },
            { status: 429 },
        )
    }
    const apiKey = process.env.DEEPSEEK_API_KEY
    if (!apiKey) {
        console.error('[ARHMS AI] DEEPSEEK_API_KEY is not set')
        return NextResponse.json({ error: BUSY }, { status: 503 })
    }

    const conversationId = typeof body?.conversationId === 'string' && UUID_RE.test(body.conversationId)
        ? body.conversationId
        : randomUUID()

    const { data: historyRows } = await db.from('ai_chat_messages').select('role, content')
        .eq('user_id', userId).eq('conversation_id', conversationId)
        .order('created_at', { ascending: false }).limit(HISTORY_MESSAGES)
    const messages: EngineMessage[] = [
        ...toHistory((historyRows || []).reverse()),
        { role: 'user', content: message },
    ]

    // Counted toward the daily cap even if the reply later fails.
    await db.from('ai_chat_messages').insert({ user_id: userId, conversation_id: conversationId, role: 'user', content: message })

    const u = access.userRow || {}
    // The name is user-typed, so it is a prompt-injection path: letters, spaces, '-' and '.' only.
    const firstName = String(u.first_name || '').replace(/[^\p{L}\p{M} .'-]/gu, '').trim().slice(0, 40)
    // Stable prompt first, per-request facts last (keeps DeepSeek's prefix cache warm).
    const system = `${ASSISTANT_SYSTEM_PROMPT}\n\nCurrent user: first name "${firstName}", role "${u.role || 'customer'}". Today is ${new Date().toISOString().slice(0, 10)} (Ghana time).`
    const toolCtx = { surface: SURFACE, db, userId, userRow: access.userRow, hidden: access.hidden, support: access.support }
    const limits = SURFACE_LIMITS[SURFACE]
    const encoder = new TextEncoder()

    const createTurn = deepSeekTurn({
        apiKey,
        model: access.model,
        system,
        tools: toolsForSurface(SURFACE),
        maxTokens: limits.maxTokens,
        signal: request.signal,
    })

    const stream = new ReadableStream({
        async start(controller) {
            const send = (event: Record<string, unknown>) => {
                try {
                    controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'))
                } catch {
                    /* client went away */
                }
            }

            let replyText = ''
            const cards: BundleCard[] = []
            let inputTokens = 0
            let outputTokens = 0

            const say = (text: string) => {
                replyText += text
                send({ type: 'text', text })
            }

            send({ type: 'meta', conversationId })

            try {
                const result = await runAgentLoop<BundleCard[]>({
                    createTurn,
                    messages,
                    maxRounds: limits.maxRounds,
                    onText: say,
                    runTool: async (name, input) => {
                        const out = await executeAssistantTool(name, input, toolCtx)
                        return { content: out.content, isError: out.isError, extra: out.cards }
                    },
                    onToolOutput: (_name, out) => {
                        if (out.extra?.length) {
                            cards.push(...out.extra)
                            send({ type: 'cards', cards: out.extra })
                        }
                    },
                })
                inputTokens = result.inputTokens
                outputTokens = result.outputTokens
                if (result.refused && !replyText.trim()) say(REFUSED)

                if (!replyText.trim() && !cards.length) say(BUSY)
            } catch (err) {
                if (err instanceof DeepSeekError) {
                    // 401 bad key · 402 out of DeepSeek balance · 429 rate limit · 5xx overloaded.
                    // Users only ever see BUSY; the reason is for the Vercel logs.
                    const hint = err.status === 401 ? 'check DEEPSEEK_API_KEY'
                        : err.status === 402 ? 'top up the DeepSeek account balance'
                        : err.status === 429 ? 'rate limited'
                        : 'provider error'
                    console.error(`[ARHMS AI] DeepSeek ${err.status} (${hint})`, err.message)
                } else {
                    console.error('[ARHMS AI] chat failed', err)
                }
                if (!replyText.trim()) say(BUSY)
            }

            try {
                await db.from('ai_chat_messages').insert({
                    user_id: userId,
                    conversation_id: conversationId,
                    role: 'assistant',
                    content: replyText.trim(),
                    cards: cards.length ? cards : null,
                    input_tokens: inputTokens,
                    output_tokens: outputTokens,
                })
            } catch (err) {
                console.error('[ARHMS AI] could not save reply', err)
            }

            send({ type: 'done', remaining: Math.max(access.remaining - 1, 0) })
            try {
                controller.close()
            } catch {
                /* already closed by a disconnect */
            }
        },
    })

    return new Response(stream, {
        headers: {
            'Content-Type': 'application/x-ndjson; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Accel-Buffering': 'no',
        },
    })
}
