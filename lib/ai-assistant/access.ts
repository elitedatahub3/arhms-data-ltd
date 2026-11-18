/**
 * Server-side gate shared by the chat route and its status GET: who the caller
 * is, whether ARHMS AI is on for them, and how many messages they have left.
 *
 * Limits (all counted in ai_chat_messages, not Redis):
 *   - per user per day      admin_settings ai_assistant_daily_limit (default 30)
 *   - per user per minute   BURST_LIMIT_PER_MINUTE (stops scripted flooding)
 *   - all users per day     admin_settings ai_assistant_global_daily_limit (default 3000),
 *                           a ceiling on DeepSeek spend
 */
import { resolveSubAgentContext } from '@/lib/sub-agents'
import {
    BURST_LIMIT_PER_MINUTE,
    canUseAssistant,
    dayStartIso,
    parseAssistantMode,
    parseDailyLimit,
    parseGlobalDailyLimit,
    resolveAssistantModel,
    type AssistantMode,
    type HiddenNetworks,
} from './helpers'

const SETTING_KEYS = [
    'ai_assistant_mode',
    'ai_assistant_daily_limit',
    'ai_assistant_global_daily_limit',
    'ai_model_dashboard',
    'special_mtn_mashup_hidden',
    'express_mtn_hidden',
    'standard_mtn_hidden',
    'whatsapp_admin_number',
    'whatsapp_group_link',
]

export interface AssistantAccess {
    allowed: boolean
    mode: AssistantMode
    limit: number
    usedToday: number
    remaining: number
    /** User sent BURST_LIMIT_PER_MINUTE messages in the last 60 seconds. */
    tooFast: boolean
    /** Every user together has used the platform-wide daily allowance. */
    globalExhausted: boolean
    globalLimit: number
    /** DeepSeek model for the dashboard surface (admin_settings ai_model_dashboard → env → deepseek-chat). */
    model: string
    userRow: any
    hidden: HiddenNetworks
    support: { whatsappNumber: string | null; whatsappLink: string | null }
}

export async function loadAssistantAccess(db: any, userId: string): Promise<AssistantAccess> {
    const today = dayStartIso()
    const minuteAgo = new Date(Date.now() - 60_000).toISOString()
    const userQuestions = () => db.from('ai_chat_messages').select('id', { count: 'exact', head: true })
        .eq('user_id', userId).eq('role', 'user')

    const [{ data: userRow }, { data: settingRows }, sub, { count }, { count: lastMinute }, { count: globalToday }] = await Promise.all([
        // '*' so a database without is_api_user still works (see lib/data-order-pricing.ts).
        db.from('users').select('*').eq('id', userId).maybeSingle(),
        db.from('admin_settings').select('key, value').in('key', SETTING_KEYS),
        resolveSubAgentContext(db, userId),
        userQuestions().gte('created_at', today),
        userQuestions().gte('created_at', minuteAgo),
        db.from('ai_chat_messages').select('id', { count: 'exact', head: true })
            .eq('role', 'user').gte('created_at', today),
    ])

    const s: Record<string, string> = {}
    for (const r of settingRows || []) s[r.key] = r.value

    const mode = parseAssistantMode(s.ai_assistant_mode)
    const limit = parseDailyLimit(s.ai_assistant_daily_limit)
    const globalLimit = parseGlobalDailyLimit(s.ai_assistant_global_daily_limit)
    const usedToday = count || 0

    return {
        allowed: !!userRow && userRow.status !== 'suspended' && canUseAssistant(mode, userRow.role, sub.isSub),
        mode,
        limit,
        usedToday,
        remaining: Math.max(limit - usedToday, 0),
        tooFast: (lastMinute || 0) >= BURST_LIMIT_PER_MINUTE,
        globalExhausted: (globalToday || 0) >= globalLimit,
        globalLimit,
        model: resolveAssistantModel(s.ai_model_dashboard, process.env.AI_ASSISTANT_MODEL),
        userRow,
        hidden: {
            mashup: String(s.special_mtn_mashup_hidden) === 'true',
            express: String(s.express_mtn_hidden) === 'true',
            standard: String(s.standard_mtn_hidden) === 'true',
        },
        support: {
            whatsappNumber: s.whatsapp_admin_number || null,
            whatsappLink: s.whatsapp_group_link || null,
        },
    }
}
