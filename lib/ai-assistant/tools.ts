/**
 * ARHMS AI tools. All read-only, all scoped to the signed-in user's id, run on
 * the service-role client (so every query MUST filter by user id itself).
 * The assistant never spends money: show_bundle_cards only returns links into
 * the normal buy page, which keeps its own checks (MTN gate, balance, idempotency).
 */
import type { ToolDef } from './engine'
import { z } from 'zod'
import { rolePriceForPackage } from '@/lib/data-order-pricing'
import { getOrderDisplayStatus, getOrderStatusLabel } from '@/lib/order-status-display'
import { HELP_TOPICS, helpText } from './knowledge'
import { getMyStatus, MY_STATUS_AREAS } from './my-status'
import { getSiteInfo, SITE_INFO_TOPICS } from './site-info'
import { searchSite } from './site-index'
import {
    buildBuyLink,
    isNetworkVisible,
    isStaffRole,
    knowledgeSearchTerms,
    normaliseGhanaPhone,
    phoneVariants,
    rankKnowledge,
    type AssistantSurface,
    type HiddenNetworks,
    type KnowledgeRow,
} from './helpers'

export const DATA_NETWORKS = [
    'MTN',
    'Telecel',
    'AT-iShare',
    'AT-BigTime',
    'Special MTN Mashup',
    'EXPRESS MTN',
] as const

export interface BundleCard {
    packageId: string
    network: string
    size: string
    price: number
    description: string | null
    href: string
}

/**
 * Everything a tool needs to act for the caller. Built by the SERVER from the
 * verified session, never from request input or model output.
 */
export interface ToolContext {
    surface: AssistantSurface
    db: any
    userId: string
    /** users row read with '*' (role, expiries, is_api_user when present). */
    userRow: any
    hidden: HiddenNetworks
    support: { whatsappNumber: string | null; whatsappLink: string | null }
    /** Per-request scratch state (e.g. note_unanswered runs at most once per message). */
    state?: { noted?: boolean }
}

export interface ToolOutput {
    content: string
    isError?: boolean
    cards?: BundleCard[]
}

export const ASSISTANT_TOOLS: ToolDef[] = [
    {
        name: 'get_wallet_balance',
        description: "Get the user's current ARHMS wallet balance in GHS.",
        input_schema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
        name: 'get_account_info',
        description:
            "Get the user's account: first name, role (customer, agent, dealer, admin), agent/dealer expiry dates and whether they are an API user. Use it for questions about their role or which prices they get.",
        input_schema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
        name: 'get_recent_orders',
        description:
            "List the user's most recent orders with status. kind: 'data' bundles, 'airtime', 'afa' registrations, 'bills' (ECG/water/TV), 'standard_bundles', 'checker' (results checker vouchers), or 'all' (data, airtime and AFA).",
        input_schema: {
            type: 'object',
            properties: {
                kind: { type: 'string', enum: ['all', 'data', 'airtime', 'afa', 'bills', 'standard_bundles', 'checker'] },
                limit: { type: 'integer', minimum: 1, maximum: 10 },
            },
            required: ['kind', 'limit'],
            additionalProperties: false,
        },
    },
    {
        name: 'find_order',
        description:
            "Find the user's own orders by order reference code or by the recipient phone number. Use it for 'where is my order' questions when the user gives a reference or number.",
        input_schema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Order reference code or Ghana phone number' },
            },
            required: ['query'],
            additionalProperties: false,
        },
    },
    {
        name: 'get_data_prices',
        description:
            'Get the data bundles on sale for one network, with the price THIS user pays (already adjusted for their role). Returns package ids for show_bundle_cards. AT-iShare and AT-BigTime are AirtelTigo.',
        input_schema: {
            type: 'object',
            properties: {
                network: { type: 'string', enum: [...DATA_NETWORKS] },
            },
            required: ['network'],
            additionalProperties: false,
        },
    },
    {
        name: 'show_bundle_cards',
        description:
            'Show tappable bundle cards in the chat so the user can buy. Use package ids from get_data_prices (max 6). Pass the recipient phone if the user gave one, else an empty string.',
        input_schema: {
            type: 'object',
            properties: {
                package_ids: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 6 },
                phone: { type: 'string' },
            },
            required: ['package_ids', 'phone'],
            additionalProperties: false,
        },
    },
    {
        name: 'search_site',
        description:
            "Search the text of the ARHMS website's own pages (menus, page headings, buttons, hints, rules shown to users, and the API documentation). Use it for any 'how do I', 'where is', 'what does this page do' question. Returns page addresses you can give the user. Pass key words.",
        input_schema: {
            type: 'object',
            properties: { query: { type: 'string', description: 'Key words, e.g. "withdraw shop profit"' } },
            required: ['query'],
            additionalProperties: false,
        },
    },
    {
        name: 'get_site_info',
        description:
            'Get LIVE fees, prices and limits for this user\'s role. Topics: airtime (fees, min/max), wallet_topup (minimum, payment fee), upgrade_plans (agent and dealer prices), afa (registration price), bills (ECG/water/TV fees), results_checker (voucher prices), withdrawals (shop, commission, sub-agent minimums and fees), sms (activation price, credit bundles), delivery_status (current delivery times), support_contacts, features_on. Always use this instead of guessing a number.',
        input_schema: {
            type: 'object',
            properties: { topic: { type: 'string', enum: [...SITE_INFO_TOPICS] } },
            required: ['topic'],
            additionalProperties: false,
        },
    },
    {
        name: 'get_my_status',
        description:
            "Get the user's OWN status for: complaints (latest), shop (link, approval, balance), commission (balance, withdrawals), api_keys (kind, approval status, first characters only), sms (account, credits), wallet_history (recent wallet transactions), top_performers (this month's rank), notifications (unread count).",
        input_schema: {
            type: 'object',
            properties: { area: { type: 'string', enum: [...MY_STATUS_AREAS] } },
            required: ['area'],
            additionalProperties: false,
        },
    },
    {
        name: 'note_unanswered',
        description:
            "Record a valid ARHMS question you could not answer from your tools, so the team can add the answer. Call it at most once, then still reply helpfully and offer WhatsApp support. Do not call it for off-topic, harmful or general-knowledge questions.",
        input_schema: {
            type: 'object',
            properties: { question: { type: 'string', description: "The user's question, in their words" } },
            required: ['question'],
            additionalProperties: false,
        },
    },
    {
        name: 'search_knowledge',
        description:
            'Search the ARHMS knowledge base (FAQ and policies: refunds, delivery times, failed orders, how-to steps). Call it before answering any policy or how-to question. Pass a few key words from the question.',
        input_schema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Key words, e.g. "refund failed order"' },
            },
            required: ['query'],
            additionalProperties: false,
        },
    },
    {
        name: 'get_help',
        description:
            'Fallback help text for a how-to or policy topic. Use it when search_knowledge returns nothing, and for contact_support (it includes the WhatsApp support contact).',
        input_schema: {
            type: 'object',
            properties: {
                topic: { type: 'string', enum: [...HELP_TOPICS] },
            },
            required: ['topic'],
            additionalProperties: false,
        },
    },
]

const schemas = {
    get_wallet_balance: z.object({}).passthrough(),
    get_account_info: z.object({}).passthrough(),
    get_recent_orders: z.object({
        kind: z.enum(['all', 'data', 'airtime', 'afa', 'bills', 'standard_bundles', 'checker']),
        limit: z.coerce.number().int().min(1).max(10),
    }),
    find_order: z.object({ query: z.string().trim().min(3).max(60) }),
    get_data_prices: z.object({ network: z.enum(DATA_NETWORKS) }),
    show_bundle_cards: z.object({
        package_ids: z.array(z.string().max(64)).min(1).max(6),
        phone: z.string().max(20).optional().default(''),
    }),
    search_knowledge: z.object({ query: z.string().trim().min(2).max(200) }),
    search_site: z.object({ query: z.string().trim().min(2).max(200) }),
    get_site_info: z.object({ topic: z.enum(SITE_INFO_TOPICS) }),
    get_my_status: z.object({ area: z.enum(MY_STATUS_AREAS) }),
    note_unanswered: z.object({ question: z.string().trim().min(3).max(500) }),
    get_help: z.object({ topic: z.enum(HELP_TOPICS) }),
}

type ToolName = keyof typeof schemas

const money = (n: unknown) => Number(Number(n || 0).toFixed(2))

function dataOrderView(o: any) {
    const status = getOrderDisplayStatus(o)
    return {
        type: 'data',
        reference: o.reference_code,
        network: o.network,
        size: o.size,
        recipient: o.phone_number,
        price_ghs: money(o.price),
        status: getOrderStatusLabel(status),
        awaiting_mtn_registration: o.awaiting_registration === true ? true : undefined,
        created_at: o.created_at,
    }
}

function airtimeOrderView(o: any) {
    return {
        type: 'airtime',
        reference: o.reference_code,
        network: o.network,
        recipient: o.beneficiary_phone,
        airtime_ghs: money(o.airtime_amount),
        paid_ghs: money(o.total_paid),
        status: getOrderStatusLabel(o.status || 'pending'),
        created_at: o.created_at,
    }
}

function afaOrderView(o: any) {
    return {
        type: 'afa',
        reference: o.reference_code,
        name: o.full_name,
        phone: o.phone,
        paid_ghs: money(o.payment_amount),
        status: getOrderStatusLabel(o.status || 'pending'),
        created_at: o.created_at,
    }
}

const byNewest = (a: any, b: any) => String(b.created_at).localeCompare(String(a.created_at))

async function loadPackages(ctx: ToolContext, filter: { network?: string; ids?: string[] }) {
    let q = ctx.db.from('data_packages').select('*').eq('is_available', true)
    if (filter.network) q = q.eq('network', filter.network)
    if (filter.ids) q = q.in('id', filter.ids)
    const { data, error } = await q.order('sort_order', { ascending: true }).limit(60)
    if (error) throw error
    return (data || []).filter((p: any) => isNetworkVisible(p.network, ctx.hidden))
}

async function run(name: ToolName, input: any, ctx: ToolContext): Promise<ToolOutput> {
    const { db, userId } = ctx

    switch (name) {
        case 'get_wallet_balance': {
            const { data, error } = await db.from('wallets').select('balance').eq('user_id', userId).maybeSingle()
            if (error) throw error
            return { content: JSON.stringify({ balance_ghs: money(data?.balance) }) }
        }

        case 'get_account_info': {
            const u = ctx.userRow || {}
            return {
                content: JSON.stringify({
                    first_name: u.first_name || null,
                    role: u.role || 'customer',
                    agent_expires_at: u.agent_expires_at || null,
                    dealer_expires_at: u.dealer_expires_at || null,
                    is_api_user: u.is_api_user === true,
                }),
            }
        }

        case 'get_recent_orders': {
            const { kind, limit } = input as z.infer<typeof schemas.get_recent_orders>
            const rows: any[] = []
            if (kind === 'all' || kind === 'data') {
                const { data } = await db.from('orders').select('*').eq('user_id', userId).is('shop_order_id', null)
                    .order('created_at', { ascending: false }).limit(limit)
                rows.push(...(data || []).map(dataOrderView))
            }
            if (kind === 'all' || kind === 'airtime') {
                const { data } = await db.from('airtime_orders').select('*').eq('user_id', userId).is('shop_id', null)
                    .order('created_at', { ascending: false }).limit(limit)
                rows.push(...(data || []).map(airtimeOrderView))
            }
            if (kind === 'all' || kind === 'afa') {
                const { data } = await db.from('afa_orders').select('*').eq('user_id', userId)
                    .order('created_at', { ascending: false }).limit(limit)
                rows.push(...(data || []).map(afaOrderView))
            }
            // Named columns only: these tables hold cost/markup columns the user must not see.
            if (kind === 'bills') {
                const { data } = await db.from('utility_orders')
                    .select('reference_code, service, account_number, bill_amount, fee_amount, total_paid, status, created_at')
                    .eq('user_id', userId).order('created_at', { ascending: false }).limit(limit)
                rows.push(...(data || []).map((o: any) => ({
                    type: 'bill', reference: o.reference_code, service: o.service, account: o.account_number,
                    bill_ghs: money(o.bill_amount), paid_ghs: money(o.total_paid), status: getOrderStatusLabel(o.status || 'pending'), created_at: o.created_at,
                })))
            }
            if (kind === 'standard_bundles') {
                const { data } = await db.from('bundle_orders')
                    .select('reference_code, network, beneficiary_phone, bundle_label, total_paid, status, created_at')
                    .eq('user_id', userId).order('created_at', { ascending: false }).limit(limit)
                rows.push(...(data || []).map((o: any) => ({
                    type: 'standard_bundle', reference: o.reference_code, network: o.network, recipient: o.beneficiary_phone,
                    bundle: o.bundle_label, paid_ghs: money(o.total_paid), status: getOrderStatusLabel(o.status || 'pending'), created_at: o.created_at,
                })))
            }
            if (kind === 'checker') {
                const { data } = await db.from('results_checker_orders')
                    .select('reference_code, type_name, quantity, total_paid, status, created_at')
                    .eq('user_id', userId).is('shop_id', null).order('created_at', { ascending: false }).limit(limit)
                rows.push(...(data || []).map((o: any) => ({
                    type: 'results_checker', reference: o.reference_code, voucher: o.type_name, quantity: o.quantity,
                    paid_ghs: money(o.total_paid), status: getOrderStatusLabel(o.status || 'pending'), created_at: o.created_at,
                    note: 'Voucher PINs are shown on the Results Checker page, not in chat.',
                })))
            }
            const orders = rows.sort(byNewest).slice(0, limit)
            return { content: JSON.stringify({ orders, count: orders.length }) }
        }

        case 'find_order': {
            const { query } = input as z.infer<typeof schemas.find_order>
            const phones = phoneVariants(query)
            const rows: any[] = []
            if (phones.length) {
                const [d, a] = await Promise.all([
                    db.from('orders').select('*').eq('user_id', userId).is('shop_order_id', null).in('phone_number', phones)
                        .order('created_at', { ascending: false }).limit(5),
                    db.from('airtime_orders').select('*').eq('user_id', userId).is('shop_id', null).in('beneficiary_phone', phones)
                        .order('created_at', { ascending: false }).limit(5),
                ])
                rows.push(...(d.data || []).map(dataOrderView), ...(a.data || []).map(airtimeOrderView))
            } else {
                const ref = query.trim()
                const [d, a, f] = await Promise.all([
                    db.from('orders').select('*').eq('user_id', userId).is('shop_order_id', null).eq('reference_code', ref).limit(1),
                    db.from('airtime_orders').select('*').eq('user_id', userId).is('shop_id', null).eq('reference_code', ref).limit(1),
                    db.from('afa_orders').select('*').eq('user_id', userId).eq('reference_code', ref).limit(1),
                ])
                rows.push(
                    ...(d.data || []).map(dataOrderView),
                    ...(a.data || []).map(airtimeOrderView),
                    ...(f.data || []).map(afaOrderView),
                )
            }
            const orders = rows.sort(byNewest).slice(0, 5)
            return {
                content: JSON.stringify(
                    orders.length ? { orders } : { orders: [], note: 'No order of this user matches that reference or number.' },
                ),
            }
        }

        case 'get_data_prices': {
            const { network } = input as z.infer<typeof schemas.get_data_prices>
            if (!isNetworkVisible(network, ctx.hidden)) {
                return { content: JSON.stringify({ network, packages: [], note: 'This network is not on sale right now.' }) }
            }
            const pkgs = await loadPackages(ctx, { network })
            const packages = pkgs.map((p: any) => ({
                package_id: p.id,
                size: p.size,
                price_ghs: money(rolePriceForPackage(ctx.userRow, p)),
                description: p.description || undefined,
            }))
            return { content: JSON.stringify({ network, role: ctx.userRow?.role || 'customer', packages }) }
        }

        case 'show_bundle_cards': {
            const { package_ids, phone } = input as z.infer<typeof schemas.show_bundle_cards>
            const recipient = normaliseGhanaPhone(phone)
            const pkgs = await loadPackages(ctx, { ids: package_ids })
            const order = new Map(package_ids.map((id, i) => [id, i]))
            const cards: BundleCard[] = pkgs
                .sort((a: any, b: any) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
                .map((p: any) => ({
                    packageId: p.id,
                    network: p.network,
                    size: p.size,
                    price: money(rolePriceForPackage(ctx.userRow, p)),
                    description: p.description || null,
                    href: buildBuyLink(p.network, p.id, recipient),
                }))
            if (!cards.length) {
                return { content: 'None of those packages are on sale. Call get_data_prices for current ids.', isError: true }
            }
            return {
                content: JSON.stringify({ shown: cards.length, note: 'Cards are now visible to the user; tapping one opens the buy page.' }),
                cards,
            }
        }

        case 'search_site': {
            const { query } = input as z.infer<typeof schemas.search_site>
            const results = searchSite(query, 'dashboard')
            return {
                content: JSON.stringify(
                    results.length ? { results } : { results: [], note: 'No page text matched. Try other key words, search_knowledge, or get_help.' },
                ),
            }
        }

        case 'get_site_info': {
            const { topic } = input as z.infer<typeof schemas.get_site_info>
            return { content: JSON.stringify({ topic, ...(await getSiteInfo(db, topic, ctx.userRow)) }) }
        }

        case 'get_my_status': {
            const { area } = input as z.infer<typeof schemas.get_my_status>
            return { content: JSON.stringify({ area, ...(await getMyStatus(db, userId, area)) }) }
        }

        case 'note_unanswered': {
            const { question } = input as z.infer<typeof schemas.note_unanswered>
            if (ctx.state?.noted) return { content: JSON.stringify({ recorded: false, note: 'Already recorded for this message.' }) }
            if (ctx.state) ctx.state.noted = true
            const { error } = await db.from('ai_unanswered').insert({ question, user_id: userId, surface: ctx.surface })
            if (error) console.error('[ARHMS AI] note_unanswered failed, is migration 20261118020000 run?', error.message)
            return { content: JSON.stringify({ recorded: !error, note: 'Now reply helpfully and offer WhatsApp support.' }) }
        }

        case 'search_knowledge': {
            const { query } = input as z.infer<typeof schemas.search_knowledge>
            const terms = knowledgeSearchTerms(query)
            if (!terms.length) {
                return { content: JSON.stringify({ results: [], note: 'Use more specific key words, or call get_help.' }) }
            }
            // Terms are [a-z0-9] only (knowledgeSearchTerms), so they are safe inside or().
            const or = terms.flatMap(t => [`question.ilike.%${t}%`, `answer.ilike.%${t}%`, `category.ilike.%${t}%`]).join(',')
            const { data, error } = await db.from('ai_knowledge').select('id, category, question, answer')
                .eq('is_active', true).contains('contexts', [ctx.surface]).or(or).limit(50)
            if (error) {
                // Loud on purpose: a missing table would otherwise fail silently forever.
                console.error('[ARHMS AI] knowledge search failed, is migration 20261118010000 run?', error.message)
                return { content: 'Knowledge base unavailable. Use get_help instead.', isError: true }
            }
            const results = rankKnowledge((data || []) as KnowledgeRow[], terms).map(r => ({
                question: r.question,
                answer: r.answer.slice(0, 2000),
            }))
            return {
                content: JSON.stringify(
                    results.length ? { results } : { results: [], note: 'Nothing found. Try get_help, or offer WhatsApp support.' },
                ),
            }
        }

        case 'get_help': {
            const { topic } = input as z.infer<typeof schemas.get_help>
            const extra = topic === 'contact_support' || topic === 'refund' || topic === 'failed_order'
                ? { whatsapp_number: ctx.support.whatsappNumber, whatsapp_link: ctx.support.whatsappLink }
                : {}
            return { content: JSON.stringify({ topic, text: helpText(topic), ...extra }) }
        }
    }
}

/** Tools only staff may run. Empty until the admin surface lands (phase 3). */
const STAFF_ONLY = new Set<string>()

const DASHBOARD_TOOLS = new Set<string>([
    'get_wallet_balance',
    'get_account_info',
    'get_recent_orders',
    'find_order',
    'get_data_prices',
    'show_bundle_cards',
    'search_knowledge',
    'get_help',
    'search_site',
    'get_site_info',
    'get_my_status',
    'note_unanswered',
])

/** Tool definitions offered on a surface. Not a security boundary on its own (see executeAssistantTool). */
export function toolsForSurface(surface: AssistantSurface): ToolDef[] {
    switch (surface) {
        case 'dashboard':
            return ASSISTANT_TOOLS.filter(t => DASHBOARD_TOOLS.has(t.name))
        default:
            return []
    }
}

/** Validate and run one tool call. Never throws: errors become is_error results. */
export async function executeAssistantTool(name: string, rawInput: unknown, ctx: ToolContext): Promise<ToolOutput> {
    if (!(name in schemas)) return { content: `Unknown tool: ${name}`, isError: true }
    // Second, independent check: the offered tool list is not a security boundary.
    if (!toolsForSurface(ctx.surface).some(t => t.name === name)) {
        return { content: `Tool ${name} is not available here.`, isError: true }
    }
    if (STAFF_ONLY.has(name) && !isStaffRole(ctx.userRow?.role)) {
        return { content: 'Not authorized.', isError: true }
    }
    const parsed = schemas[name as ToolName].safeParse(rawInput ?? {})
    if (!parsed.success) {
        return { content: `Invalid input: ${parsed.error.errors.map(e => e.message).join('; ')}`, isError: true }
    }
    try {
        return await run(name as ToolName, parsed.data, ctx)
    } catch (err) {
        console.error(`[ARHMS AI] tool ${name} failed`, err)
        return { content: 'This lookup failed. Tell the user to try again in a moment.', isError: true }
    }
}
