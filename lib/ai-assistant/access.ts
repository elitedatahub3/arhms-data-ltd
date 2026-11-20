/**
 * Server-side gate shared by the chat route and its status GET: who the caller
 * is, whether ARHMS AI is on for them, and how many messages they have left.
 *
 * Limits (all counted in ai_chat_messages, not Redis):
 *   - per user per month    admin_settings ai_dashboard_monthly_limit (default 100) + paid resets
 *                           (ai_dashboard_reset_price, default GHS 5; lib/ai-assistant/usage-reset.ts)
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
    currentMonthKey,
    isStaffRole,
    monthStartIso,
    monthlyAllowance,
    parseMonthlyLimit,
    parseResetPrice,
    USAGE_DEFAULTS,
    USAGE_SETTING_KEYS,
    checkWindowLimits,
    hourStartIso,
    parseWindowLimit,
    WINDOW_DEFAULTS,
    WINDOW_SETTING_KEYS,
    type WindowCheck,
    parseGlobalDailyLimit,
    resolveAssistantModel,
    type AssistantMode,
    type HiddenNetworks,
} from './helpers'

const SETTING_KEYS = [
    'ai_assistant_mode',
    'ai_dashboard_monthly_limit',
    'ai_dashboard_reset_price',
    'ai_dashboard_hourly_limit',
    'ai_dashboard_daily_limit',
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
    /** This month's allowance (base + paid resets). */
    baseLimit: number
    resetPrice: number
    /** Staff: no monthly limit. */
    unlimited: boolean
    usedThisMonth: number
    /** Hourly/daily limit hit (null = fine, or staff). The user waits; no payment. */
    windowBlock: { window: 'hour' | 'day'; resetsAt: string } | null
    hourLeft: number | null
    dayLeft: number | null
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

    const [{ data: userRow }, { data: settingRows }, sub, { count }, { count: lastMinute }, { count: globalToday }, { data: resets }, { count: usedHour }, { count: usedDay }] = await Promise.all([
        // '*' so a database without is_api_user still works (see lib/data-order-pricing.ts).
        db.from('users').select('*').eq('id', userId).maybeSingle(),
        db.from('admin_settings').select('key, value').in('key', SETTING_KEYS),
        resolveSubAgentContext(db, userId),
        userQuestions().gte('created_at', monthStartIso()),
        userQuestions().gte('created_at', minuteAgo),
        db.from('ai_chat_messages').select('id', { count: 'exact', head: true })
            .eq('role', 'user').gte('created_at', today),
        // Paid resets this month. A missing table (migration not run) just means none.
        db.from('ai_usage_purchases').select('questions_added')
            .eq('user_id', userId).eq('scope', 'dashboard').eq('month', currentMonthKey()).eq('status', 'paid'),
        // Clock windows for the hourly / daily limits (they reset themselves; no cron).
        userQuestions().gte('created_at', hourStartIso()),
        userQuestions().gte('created_at', today),
    ])

    const s: Record<string, string> = {}
    for (const r of settingRows || []) s[r.key] = r.value

    const mode = parseAssistantMode(s.ai_assistant_mode)
    const baseLimit = parseMonthlyLimit(s[USAGE_SETTING_KEYS.dashboard.limit], USAGE_DEFAULTS.dashboard.limit)
    const resetPrice = parseResetPrice(s[USAGE_SETTING_KEYS.dashboard.price], USAGE_DEFAULTS.dashboard.price)
    const limit = monthlyAllowance(baseLimit, (resets || []).map((r: any) => Number(r.questions_added)))
    const globalLimit = parseGlobalDailyLimit(s.ai_assistant_global_daily_limit)
    const usedThisMonth = count || 0
    // Staff are not limited monthly (only by the platform-wide daily safety limit).
    const unlimited = isStaffRole(userRow?.role)
    const windows = checkWindowLimits({
        usedHour: usedHour || 0,
        usedDay: usedDay || 0,
        hourLimit: parseWindowLimit(s[WINDOW_SETTING_KEYS.dashboardHour], WINDOW_DEFAULTS.dashboardHour),
        dayLimit: parseWindowLimit(s[WINDOW_SETTING_KEYS.dashboardDay], WINDOW_DEFAULTS.dashboardDay),
    })

    return {
        windowBlock: unlimited || windows.ok ? null : (() => { const b = windows as Extract<WindowCheck, { ok: false }>; return { window: b.window, resetsAt: b.resetsAt } })(),
        hourLeft: unlimited || !windows.ok ? null : (windows as Extract<WindowCheck, { ok: true }>).hourLeft,
        dayLeft: unlimited || !windows.ok ? null : (windows as Extract<WindowCheck, { ok: true }>).dayLeft,
        allowed: !!userRow && userRow.status !== 'suspended' && canUseAssistant(mode, userRow.role, sub.isSub),
        mode,
        limit,
        baseLimit,
        resetPrice,
        unlimited,
        usedThisMonth,
        remaining: unlimited ? Number.MAX_SAFE_INTEGER : Math.max(limit - usedThisMonth, 0),
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
