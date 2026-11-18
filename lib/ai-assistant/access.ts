/**
 * Server-side gate shared by the chat route and its status GET: who the caller
 * is, whether ARHMS AI is on for them, and how many messages they have left.
 */
import { resolveSubAgentContext } from '@/lib/sub-agents'
import {
    canUseAssistant,
    dayStartIso,
    parseAssistantMode,
    parseDailyLimit,
    resolveAssistantModel,
    type AssistantMode,
    type HiddenNetworks,
} from './helpers'

const SETTING_KEYS = [
    'ai_assistant_mode',
    'ai_assistant_daily_limit',
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
    /** Claude model for the dashboard surface (admin_settings ai_model_dashboard → env → Haiku). */
    model: string
    userRow: any
    hidden: HiddenNetworks
    support: { whatsappNumber: string | null; whatsappLink: string | null }
}

export async function loadAssistantAccess(db: any, userId: string): Promise<AssistantAccess> {
    const [{ data: userRow }, { data: settingRows }, sub, { count }] = await Promise.all([
        // '*' so a database without is_api_user still works (see lib/data-order-pricing.ts).
        db.from('users').select('*').eq('id', userId).maybeSingle(),
        db.from('admin_settings').select('key, value').in('key', SETTING_KEYS),
        resolveSubAgentContext(db, userId),
        db.from('ai_chat_messages').select('id', { count: 'exact', head: true })
            .eq('user_id', userId).eq('role', 'user').gte('created_at', dayStartIso()),
    ])

    const s: Record<string, string> = {}
    for (const r of settingRows || []) s[r.key] = r.value

    const mode = parseAssistantMode(s.ai_assistant_mode)
    const limit = parseDailyLimit(s.ai_assistant_daily_limit)
    const usedToday = count || 0

    return {
        allowed: !!userRow && userRow.status !== 'suspended' && canUseAssistant(mode, userRow.role, sub.isSub),
        mode,
        limit,
        usedToday,
        remaining: Math.max(limit - usedToday, 0),
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
