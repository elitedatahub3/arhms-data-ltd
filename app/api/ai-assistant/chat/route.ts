/**
 * ARHMS AI chat.
 *
 * GET  → { enabled, remaining, limit, conversationId, messages } (last conversation, 24h)
 * POST { message, conversationId? } → NDJSON stream of
 *        {type:'meta', conversationId} | {type:'text', text} | {type:'cards', cards}
 *        | {type:'done', remaining} | {type:'error', error}
 *
 * Gate: admin_settings.ai_assistant_mode (off | admins | all), daily cap from
 * monthly allowance (lib/ai-assistant/access.ts) counted in ai_chat_messages. Tools are
 * read-only; see lib/ai-assistant/tools.ts.
 */
import { NextResponse } from 'next/server'
import { randomUUID } from 'crypto'
import { createRouteHandlerClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { loadAssistantAccess } from '@/lib/ai-assistant/access'
import { deepSeekTurn, DeepSeekError } from '@/lib/ai-assistant/deepseek'
import { runAgentLoop, type EngineMessage } from '@/lib/ai-assistant/engine'
import { cleanUserMessage, createSecretRedactor, isStaffRole, MAX_MESSAGE_CHARS, SURFACE_LIMITS, windowLimitMessage } from '@/lib/ai-assistant/helpers'
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
            // null = unlimited (staff). Monthly allowance otherwise.
            remaining: access.unlimited ? null : access.remaining,
            limit: access.unlimited ? null : access.limit,
            reset: { price: access.resetPrice, questions: access.baseLimit },
            hourLeft: access.hourLeft,
            dayLeft: access.dayLeft,
            // Header usage meter: used / limit for hour, day, month (staff see it too, unlimited=true).
            usage: access.usage,
            unlimited: access.unlimited,
            // Header support button: talk to a person directly, without asking the AI.
            support: access.support,
            // Set when an hourly/daily limit is hit right now: { window, resetsAt, message }.
            windowBlock: access.windowBlock
                ? { ...access.windowBlock, message: windowLimitMessage(access.windowBlock.window, access.windowBlock.resetsAt) }
                : null,
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
    // Hourly / daily limits come first: the user just waits (paying only refills the month).
    if (access.windowBlock) {
        const { window, resetsAt } = access.windowBlock
        return NextResponse.json(
            { error: windowLimitMessage(window, resetsAt), code: window === 'day' ? 'day_limit' : 'hour_limit', resetsAt },
            { status: 429 },
        )
    }
    if (access.remaining <= 0) {
        return NextResponse.json(
            {
                error: `You have used your ${access.limit} ARHMS AI questions this month. Get ${access.baseLimit} more for GHS ${access.resetPrice.toFixed(2)}.`,
                code: 'monthly_limit',
                reset: { price: access.resetPrice, questions: access.baseLimit },
            },
            { status: 429 },
        )
    }
    if (access.tooFast) {
        return NextResponse.json(
            { error: 'You are sending messages too fast. Please wait a minute and try again.', code: 'too_fast' },
            { status: 429, headers: { 'Retry-After': '60' } },
        )
    }
    // Admins and sub-admins see the real reason for a failure; everyone else sees BUSY.
    const staff = isStaffRole(access.userRow?.role)
    if (access.globalExhausted) {
        console.error(`[ARHMS AI] platform daily limit of ${access.globalLimit} questions reached`)
        return NextResponse.json(
            {
                error: staff
                    ? `Admin note: the platform-wide limit of ${access.globalLimit} questions for today is used up. Raise it on Admin → ARHMS AI if this is expected.`
                    : 'ARHMS AI has reached its limit for today. Please try again tomorrow.',
                code: 'global_limit',
            },
            { status: 503 },
        )
    }
    const apiKey = process.env.DEEPSEEK_API_KEY?.trim()
    if (!apiKey) {
        console.error('[ARHMS AI] DEEPSEEK_API_KEY is not set')
        return NextResponse.json(
            {
                error: staff
                    ? `Admin note: DEEPSEEK_API_KEY is not set on this deployment (${process.env.VERCEL_ENV || 'unknown'} environment). Add it in Vercel → Settings → Environment Variables of THIS project, tick Preview and Production, then redeploy.`
                    : BUSY,
            },
            { status: 503 },
        )
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
    const toolCtx = { surface: SURFACE, db, userId, userRow: access.userRow, hidden: access.hidden, support: access.support, state: {} }
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
            // Model text passes through the secret redactor before the user (or the DB) sees it.
            const redactor = createSecretRedactor()
            const sayModel = (delta: string) => {
                const safe = redactor.push(delta)
                if (safe) say(safe)
            }
            const flushModel = () => {
                const rest = redactor.flush()
                if (rest) say(rest)
            }

            send({ type: 'meta', conversationId })

            try {
                const result = await runAgentLoop<BundleCard[]>({
                    createTurn,
                    messages,
                    maxRounds: limits.maxRounds,
                    onText: sayModel,
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
                flushModel()
                inputTokens = result.inputTokens
                outputTokens = result.outputTokens
                if (result.refused && !replyText.trim()) say(REFUSED)

                if (!replyText.trim() && !cards.length) say(BUSY)
            } catch (err) {
                flushModel()
                let adminNote = 'the request failed (see Vercel logs for "[ARHMS AI]")'
                if (err instanceof DeepSeekError) {
                    // 401 bad key · 402 out of DeepSeek balance · 429 rate limit · 5xx overloaded.
                    // Users only ever see BUSY; staff see the reason, and it goes to the Vercel logs.
                    const hint = err.status === 401 ? 'the API key is wrong or deleted, create a new one at platform.deepseek.com'
                        : err.status === 402 ? 'the DeepSeek account has no balance, top it up at platform.deepseek.com'
                        : err.status === 429 ? 'DeepSeek rate limit, wait a minute'
                        : err.status === 400 || err.status === 422 ? 'DeepSeek rejected the request format'
                        : 'DeepSeek server error, try again shortly'
                    adminNote = `DeepSeek ${err.status}: ${hint}`
                    console.error(`[ARHMS AI] DeepSeek ${err.status} (${hint})`, err.message)
                } else {
                    console.error('[ARHMS AI] chat failed', err)
                }
                if (!replyText.trim()) say(staff ? `Admin note: ${adminNote}.` : BUSY)
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

            send({
                type: 'done',
                remaining: access.unlimited ? null : Math.max(access.remaining - 1, 0),
                hourLeft: access.hourLeft == null ? null : Math.max(access.hourLeft - 1, 0),
                dayLeft: access.dayLeft == null ? null : Math.max(access.dayLeft - 1, 0),
            })
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
