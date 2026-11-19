/**
 * Storefront assistant for a shop's guest customers (no login).
 *
 * GET  ?shop=<slug>                        -> { enabled, name, whatsapp }
 * POST { shopSlug, message, history[] }    -> NDJSON stream (text | done | error)
 *                                             or JSON { notice } when it can't answer now
 *
 * Gate order: admin switch ai_storefront_mode='on' -> shop approved/active/priced and
 * not switched off by its owner -> per-visitor burst (6/min) and daily cap
 * (ai_storefront_daily_limit_per_ip, default 15) -> the SHOP's monthly allowance
 * (ai_shop_monthly_limit + paid GHS 7 resets) -> platform daily safety cap.
 *
 * Guests have no stored conversation: history comes from the browser, reduced to
 * plain text (a forged tool result can't get in). Visitors are counted by a salted
 * hash of their IP + shop, never the raw IP.
 */
import { NextResponse } from 'next/server'
import { createHash } from 'crypto'
import { createServerClient } from '@/lib/supabase'
import { deepSeekTurn, DeepSeekError } from '@/lib/ai-assistant/deepseek'
import { runAgentLoop, type EngineMessage } from '@/lib/ai-assistant/engine'
import {
    BURST_LIMIT_PER_MINUTE,
    cleanGuestHistory,
    cleanUserMessage,
    createSecretRedactor,
    currentMonthKey,
    dayStartIso,
    monthlyAllowance,
    monthStartIso,
    parseGlobalDailyLimit,
    parseMonthlyLimit,
    resolveAssistantModel,
    SURFACE_LIMITS,
    USAGE_DEFAULTS,
    USAGE_SETTING_KEYS,
} from '@/lib/ai-assistant/helpers'
import { buildShopPrompt, executeShopTool, loadShopContext, SHOP_TOOLS, type ShopContext } from '@/lib/ai-assistant/shop-assistant'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const GATE_KEYS = [
    'ai_storefront_mode',
    'ai_storefront_daily_limit_per_ip',
    'ai_assistant_global_daily_limit',
    'ai_model_storefront',
    USAGE_SETTING_KEYS.shop.limit,
]
const HISTORY_MAX = 12

async function gateSettings(db: any): Promise<Record<string, string>> {
    const { data } = await db.from('admin_settings').select('key, value').in('key', GATE_KEYS)
    const s: Record<string, string> = {}
    for (const r of data || []) s[r.key] = r.value
    return s
}

async function openShop(db: any, slug: unknown): Promise<{ shop: ShopContext; s: Record<string, string> } | null> {
    if (typeof slug !== 'string') return null
    const s = await gateSettings(db)
    if (s.ai_storefront_mode !== 'on') return null
    const shop = await loadShopContext(db, slug)
    if (!shop) return null
    const { data: flag } = await db.from('shop_profiles').select('ai_assistant_enabled').eq('id', shop.id).maybeSingle()
    if (flag && flag.ai_assistant_enabled === false) return null
    return { shop, s }
}

function clientIp(request: Request): string {
    return (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || request.headers.get('x-real-ip') || 'unknown'
}

function visitorHash(ip: string, shopId: string): string {
    const salt = process.env.AI_GUEST_SALT || 'arhms-ai-storefront'
    return createHash('sha256').update(`${salt}:${shopId}:${ip}`).digest('hex').slice(0, 40)
}

/** Browser history reduced to plain text (tested in lib/__tests__/ai-assistant-helpers.test.mts). */
const cleanHistory = (raw: unknown): EngineMessage[] => cleanGuestHistory(raw, HISTORY_MAX, 500)

const contactLine = (shop: ShopContext) => (shop.whatsapp ? ` Chat with us on WhatsApp: ${shop.whatsapp}.` : '')

export async function GET(request: Request) {
    const db = createServerClient() as any
    const open = await openShop(db, new URL(request.url).searchParams.get('shop'))
    if (!open) return NextResponse.json({ enabled: false }, { headers: { 'Cache-Control': 'no-store' } })
    return NextResponse.json(
        { enabled: true, name: open.shop.name, whatsapp: open.shop.whatsapp },
        { headers: { 'Cache-Control': 'no-store' } },
    )
}

export async function POST(request: Request) {
    let body: any
    try {
        body = await request.json()
    } catch {
        return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
    }
    const message = cleanUserMessage(body?.message)
    if (!message) return NextResponse.json({ error: 'Type a message of up to 500 characters.' }, { status: 400 })

    const db = createServerClient() as any
    const open = await openShop(db, body?.shopSlug)
    if (!open) return NextResponse.json({ error: 'The assistant is not available.' }, { status: 404 })
    const { shop, s } = open

    const apiKey = process.env.DEEPSEEK_API_KEY?.trim()
    if (!apiKey) {
        console.error('[Shop AI] DEEPSEEK_API_KEY is not set')
        return NextResponse.json({ notice: `Our assistant is unavailable right now.${contactLine(shop)}` })
    }

    // ── Limits ────────────────────────────────────────────────────────────────
    const ipHash = visitorHash(clientIp(request), shop.id)
    const minuteAgo = new Date(Date.now() - 60_000).toISOString()
    const today = dayStartIso()
    const q = () => db.from('ai_shop_questions').select('id', { count: 'exact', head: true })
    const [burst, ipToday, shopMonth, resets, globalChat, globalShop] = await Promise.all([
        q().eq('ip_hash', ipHash).gte('created_at', minuteAgo),
        q().eq('ip_hash', ipHash).gte('created_at', today),
        q().eq('shop_id', shop.id).gte('created_at', monthStartIso()),
        db.from('ai_usage_purchases').select('questions_added')
            .eq('shop_id', shop.id).eq('scope', 'shop').eq('month', currentMonthKey()).eq('status', 'paid'),
        db.from('ai_chat_messages').select('id', { count: 'exact', head: true }).eq('role', 'user').gte('created_at', today),
        q().gte('created_at', today),
    ])
    if (shopMonth.error) {
        console.error('[Shop AI] ai_shop_questions unavailable, is migration 20261118020000 run?', shopMonth.error.message)
        return NextResponse.json({ notice: `Our assistant is unavailable right now.${contactLine(shop)}` })
    }
    if ((burst.count || 0) >= BURST_LIMIT_PER_MINUTE) {
        return NextResponse.json({ error: 'You are sending messages too fast. Please wait a minute.' }, { status: 429 })
    }
    const perIpDay = parseMonthlyLimit(s.ai_storefront_daily_limit_per_ip, 15)
    if ((ipToday.count || 0) >= perIpDay) {
        return NextResponse.json({ notice: `You have reached today's limit for the assistant.${contactLine(shop)}` })
    }
    const shopAllowance = monthlyAllowance(
        parseMonthlyLimit(s[USAGE_SETTING_KEYS.shop.limit], USAGE_DEFAULTS.shop.limit),
        (resets.data || []).map((r: any) => Number(r.questions_added)),
    )
    if ((shopMonth.count || 0) >= shopAllowance) {
        await notifyOwnerLimitReached(db, shop)
        return NextResponse.json({ notice: `Our assistant is resting for now.${contactLine(shop) || ' Please try again later.'}` })
    }
    if ((globalChat.count || 0) + (globalShop.count || 0) >= parseGlobalDailyLimit(s.ai_assistant_global_daily_limit)) {
        return NextResponse.json({ notice: `Our assistant is busy right now.${contactLine(shop)}` })
    }

    // Counts toward the shop's allowance even if the reply later fails.
    await db.from('ai_shop_questions').insert({ shop_id: shop.id, ip_hash: ipHash })

    const limits = SURFACE_LIMITS.storefront
    const createTurn = deepSeekTurn({
        apiKey,
        model: resolveAssistantModel(s.ai_model_storefront, process.env.AI_ASSISTANT_MODEL),
        system: `${buildShopPrompt(shop)}\n\nToday is ${new Date().toISOString().slice(0, 10)} (Ghana time).`,
        tools: SHOP_TOOLS,
        maxTokens: limits.maxTokens,
        signal: request.signal,
    })
    const messages: EngineMessage[] = [...cleanHistory(body?.history), { role: 'user', content: message }]
    const encoder = new TextEncoder()

    const stream = new ReadableStream({
        async start(controller) {
            const send = (event: Record<string, unknown>) => {
                try {
                    controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'))
                } catch {
                    /* client went away */
                }
            }
            let reply = ''
            const say = (t: string) => {
                reply += t
                send({ type: 'text', text: t })
            }
            const redactor = createSecretRedactor()
            const sayModel = (d: string) => {
                const safe = redactor.push(d)
                if (safe) say(safe)
            }
            try {
                await runAgentLoop({
                    createTurn,
                    messages,
                    maxRounds: limits.maxRounds,
                    onText: sayModel,
                    runTool: (name, input) => executeShopTool(name, input, db, shop),
                })
                const rest = redactor.flush()
                if (rest) say(rest)
            } catch (err) {
                const rest = redactor.flush()
                if (rest) say(rest)
                if (err instanceof DeepSeekError) console.error(`[Shop AI] DeepSeek ${err.status}`, err.message)
                else console.error('[Shop AI] chat failed', err)
            }
            if (!reply.trim()) say(`Sorry, I could not answer that right now.${contactLine(shop)}`)
            send({ type: 'done' })
            try {
                controller.close()
            } catch {
                /* already closed */
            }
        },
    })

    return new Response(stream, {
        headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' },
    })
}

/** One in-app notification per shop per day when its monthly allowance runs out. */
async function notifyOwnerLimitReached(db: any, shop: ShopContext) {
    try {
        const { count } = await db.from('notifications').select('id', { count: 'exact', head: true })
            .eq('user_id', shop.ownerId).eq('title', 'Shop assistant paused').gte('created_at', dayStartIso())
        if ((count || 0) > 0) return
        await db.from('notifications').insert({
            user_id: shop.ownerId,
            title: 'Shop assistant paused',
            message: "Your shop's AI assistant has used this month's questions. Reset it from your shop page to keep answering customers.",
            type: 'system',
            action_url: '/dashboard/shop',
        })
    } catch (err) {
        console.error('[Shop AI] owner notification failed', err)
    }
}
