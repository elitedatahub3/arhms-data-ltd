/**
 * Utility bills over USSD — the Node-side half (see lib/ussd-utilities.ts for why it is split).
 *
 * Two actions, both called by the USSD route and nobody else:
 *
 *   quote   price the bill. Verifies the account with the provider, applies the platform fee
 *           and, for a shop sale, the shop's mark-up (inside the admin's total cap), and
 *           returns what the caller will be charged together with a SIGNED token holding
 *           everything needed to record the payment.
 *
 *   create  after the caller confirms, record the payment as a pending wallet_payments row
 *           from that token — the same row /api/utilities/gateway-init writes — and return
 *           it. No provider call here, so confirming stays fast.
 *
 * Settlement is not here: the existing processUtilityDirectOrder claims that row once the
 * MoMo payment is confirmed, builds the order and pays the bill, exactly as it does for a
 * website payment. See lib/ussd-utility-settle.ts.
 *
 * The account of record — whose wallet and role the order is placed under — follows the
 * website's rules. A shop sale is the SHOP OWNER's (a guest has no account); a registered
 * user's is their own.
 */
import crypto from 'crypto'
import { UTILITY_SERVICES, isUtilityService } from '@/lib/hubtel-utility-service'
import {
    buildUtilityIntent,
    isUtilitySurfaceOpen,
    utilitySettingKeys,
    utilitySurfaceSettingKeys,
    UTILITY_LAUNCH_KEY,
} from '@/lib/utility-order-intent'
import { computeUtilityMarkup } from '@/lib/utility-shop-pricing'
import { USSD_UTILITY_SERVICES, type UtilitiesApiResult } from '@/lib/ussd-utilities'

/** admin_settings key. Utilities over USSD are OFF unless this is exactly 'true'. */
export const USSD_UTILITIES_KEY = 'ussd_utilities_enabled'

/** The provider is given this long on a keypress; Hubtel drops the session near 10s. */
const PROVIDER_BUDGET_MS = 5000
/** How long a quote stays payable. */
const QUOTE_TTL_MS = 10 * 60 * 1000

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

// ── Authentication and the signed quote ─────────────────────────────────────────

function serviceKey(): string {
    return process.env.SUPABASE_SERVICE_ROLE_KEY || ''
}

/** The edge route's proof of identity — see internalToken() in lib/ussd-utilities.ts. */
export function expectedInternalToken(): string {
    return crypto.createHash('sha256').update(`${serviceKey()}:ussd-internal:v1`).digest('hex')
}

export function internalTokenValid(presented: string | null): boolean {
    if (!presented || !serviceKey()) return false
    const a = Buffer.from(presented, 'utf8')
    const b = Buffer.from(expectedInternalToken(), 'utf8')
    return a.length === b.length && crypto.timingSafeEqual(a, b)
}

export interface QuotePayload {
    v: 1
    sid: string
    uid: string
    exp: number
    subtotal: number
    metadata: Record<string, unknown>
}

function signature(body: string): string {
    return crypto.createHmac('sha256', `${serviceKey()}:ussd-quote:v1`).update(body).digest('base64url')
}

export function signQuote(payload: QuotePayload): string {
    const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
    return `${body}.${signature(body)}`
}

export function verifyQuote(token: unknown, now: number = Date.now()): QuotePayload | null {
    if (typeof token !== 'string') return null
    const [body, sig] = token.split('.')
    if (!body || !sig) return null
    const expected = signature(body)
    const a = Buffer.from(sig, 'utf8')
    const b = Buffer.from(expected, 'utf8')
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
    try {
        const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as QuotePayload
        if (payload.v !== 1 || !(payload.exp > now)) return null
        return payload
    } catch {
        return null
    }
}

// ── Who is buying ───────────────────────────────────────────────────────────────

export interface UtilityContext {
    userId: string
    role: string
    surface: 'dashboard' | 'storefront'
    payerMsisdn: string
    shop: { id: string; shop_name: string; owner_id: string } | null
}

/**
 * Works out the account of record from the SESSION, never from the request: the edge route
 * says only which session it is, so a request cannot name someone else's wallet.
 */
export async function resolveContext(db: any, sessionId: string): Promise<UtilityContext | null> {
    const { data: session } = await db
        .from('hubtel_sessions')
        .select('session_id, mobile, data')
        .eq('session_id', sessionId)
        .maybeSingle()
    const data = session?.data
    if (!data) return null

    if (data.mode === 'member' && data.member?.userId) {
        const { data: user } = await db.from('users').select('id, role, status').eq('id', data.member.userId).maybeSingle()
        if (!user || String(user.status || 'active').toLowerCase() !== 'active') return null
        return { userId: user.id, role: user.role || 'customer', surface: 'dashboard', payerMsisdn: session.mobile, shop: null }
    }

    if (data.mode === 'shop' && data.shopId) {
        const { data: shop } = await db
            .from('shop_profiles')
            .select('id, shop_name, owner_id, utilities_enabled, approval_status, is_active')
            .eq('id', data.shopId)
            .maybeSingle()
        if (!shop || shop.approval_status !== 'approved' || shop.is_active !== true || shop.utilities_enabled !== true) return null
        const { data: owner } = await db.from('users').select('id, role').eq('id', shop.owner_id).maybeSingle()
        if (!owner) return null
        return {
            userId: owner.id,
            role: owner.role || 'customer',
            surface: 'storefront',
            payerMsisdn: session.mobile,
            shop: { id: shop.id, shop_name: shop.shop_name, owner_id: shop.owner_id },
        }
    }

    return null
}

async function loadSettings(db: any, service: string): Promise<Record<string, string>> {
    const { data } = await db
        .from('admin_settings')
        .select('key, value')
        .in('key', [...utilitySettingKeys(service), ...utilitySurfaceSettingKeys(), UTILITY_LAUNCH_KEY, USSD_UTILITIES_KEY])
    const settings: Record<string, string> = {}
    for (const row of (data || []) as any[]) settings[row.key] = row.value
    return settings
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return Promise.race([
        promise,
        new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
    ])
}

// ── quote ───────────────────────────────────────────────────────────────────────

export async function handleQuote(db: any, body: any): Promise<UtilitiesApiResult> {
    const sessionId = String(body?.sessionId ?? '')
    const service = body?.service

    if (!isUtilityService(service) || !(USSD_UTILITY_SERVICES as readonly string[]).includes(service)) {
        return { ok: false, field: 'fatal', error: 'That bill is not available.' }
    }

    const ctx = await resolveContext(db, sessionId)
    if (!ctx) return { ok: false, field: 'fatal', error: 'Bill payments are not available here.' }

    const settings = await loadSettings(db, service)
    if (settings[USSD_UTILITIES_KEY] !== 'true') {
        return { ok: false, field: 'fatal', error: 'Bill payments are not available over USSD yet.' }
    }
    // Live in production but not necessarily open: the master launch flag and the
    // per-surface switch decide, exactly as on the website.
    if (!isUtilitySurfaceOpen(ctx.surface, ctx.role, settings)) {
        return { ok: false, field: 'fatal', error: 'Bill payments are not available yet.' }
    }

    // Cheap checks first, each naming the answer to ask for again.
    const def = UTILITY_SERVICES[service]
    const accountNumber = String(body?.accountNumber ?? '').replace(/\s+/g, '')
    if (!def.accountPattern.test(accountNumber)) {
        return { ok: false, field: 'account', error: `Enter a valid ${def.accountLabel}.` }
    }
    const phone = String(body?.phone ?? '').replace(/\s+/g, '')
    if (def.requiresPhone && !/^0\d{9}$/.test(phone)) {
        return { ok: false, field: 'phone', error: 'Enter a valid phone number: 0XXXXXXXXX' }
    }
    const amount = round2(Number(body?.amount))
    const min = parseFloat(settings[`utility_min_amount_${service}`] || '1')
    const max = parseFloat(settings[`utility_max_amount_${service}`] || '2000')
    if (!Number.isFinite(amount) || amount < min) {
        return { ok: false, field: 'amount', error: `Minimum is GHS ${min.toFixed(2)}.` }
    }
    if (amount > max) {
        return { ok: false, field: 'amount', error: `Maximum is GHS ${max.toFixed(2)}.` }
    }

    // The fee band follows the account of record's role, as on the website.
    const band: 'agent' | 'customer' = ctx.role === 'agent' ? 'agent' : 'customer'

    let built
    try {
        built = await withTimeout(
            buildUtilityIntent({ service, accountNumber, amount, phone, email: '' }, settings, band),
            PROVIDER_BUDGET_MS
        )
    } catch {
        // Nothing has been charged. The provider can take 20s, which no keypress can wait for.
        return { ok: false, field: 'account', error: 'We could not verify that account right now. Please try again.' }
    }
    if (!built.ok) return { ok: false, field: 'account', error: built.error }
    const intent = built.intent

    const markup = ctx.shop
        ? await computeUtilityMarkup(db, { shopId: ctx.shop.id, service: intent.service, ownerRole: band, billAmount: intent.billAmount })
        : null
    const resellerFee = markup ? markup.resellerAmount : 0
    const subtotal = round2(intent.totalPaid + resellerFee)

    // Everything processUtilityDirectOrder needs, in the shape /api/utilities/gateway-init
    // writes. The reseller split is SNAPSHOTTED here, at the moment the caller is quoted.
    const metadata: Record<string, unknown> = {
        kind: 'utility_order',
        user_id: ctx.userId,
        role: band,
        service: intent.service,
        account_number: intent.accountNumber,
        account_name: intent.accountName,
        destination: intent.destination,
        customer_phone: intent.customerPhone,
        customer_email: intent.customerEmail,
        bill_amount: intent.billAmount,
        fee_rate: intent.feeRate,
        fee_amount: intent.feeAmount,
        ...(ctx.shop ? {
            shop_id: ctx.shop.id,
            shop_name: ctx.shop.shop_name,
            reseller_fee_amount: resellerFee,
            reseller_split: markup?.legs.map((l) => ({
                shop_id: l.shopId, owner_id: l.ownerId, percent: l.percent, amount: l.amount,
            })) ?? [],
        } : {}),
        // How this payment is recognised as a USSD one, and who to tell about it.
        channel: 'ussd',
        session_id: sessionId,
        payer_msisdn: ctx.payerMsisdn,
    }

    const token = signQuote({ v: 1, sid: sessionId, uid: ctx.userId, exp: Date.now() + QUOTE_TTL_MS, subtotal, metadata })

    return {
        ok: true,
        quote: {
            token,
            label: intent.label,
            accountNumber: intent.accountNumber,
            accountName: intent.accountName,
            billAmount: intent.billAmount,
            fee: round2(intent.feeAmount + resellerFee),
            total: subtotal,
        },
    }
}

// ── create ──────────────────────────────────────────────────────────────────────

export async function handleCreate(db: any, body: any): Promise<UtilitiesApiResult> {
    const sessionId = String(body?.sessionId ?? '')
    const reference = String(body?.reference ?? '')

    if (!/^USSD-UTIL-[A-Za-z0-9-]{6,60}$/.test(reference)) {
        return { ok: false, field: 'fatal', error: 'Invalid reference.' }
    }

    const quote = verifyQuote(body?.token)
    if (!quote || quote.sid !== sessionId) {
        return { ok: false, field: 'fatal', error: 'That quote has expired. Please dial again.' }
    }

    // The quote names the account of record; the session must still agree, and the
    // switches must still be open (an admin may have closed them since the quote).
    const ctx = await resolveContext(db, sessionId)
    if (!ctx || ctx.userId !== quote.uid) {
        return { ok: false, field: 'fatal', error: 'Bill payments are not available here.' }
    }
    const service = String(quote.metadata.service)
    const settings = await loadSettings(db, service)
    if (settings[USSD_UTILITIES_KEY] !== 'true' || !isUtilitySurfaceOpen(ctx.surface, ctx.role, settings)) {
        return { ok: false, field: 'fatal', error: 'Bill payments are not available yet.' }
    }

    // A repeat of the same confirm (a retry) finds the row it made.
    const { data: existing } = await db
        .from('wallet_payments')
        .select('id, user_id, status, amount')
        .eq('reference', reference)
        .maybeSingle()
    if (existing) {
        if (existing.user_id !== quote.uid || existing.status !== 'pending') {
            return { ok: false, field: 'fatal', error: 'Invalid reference.' }
        }
        return { ok: true, amount: Number(existing.amount) }
    }

    // wallet_payments needs a wallet_id, and a shop owner or member may never have had one.
    let { data: wallet } = await db.from('wallets').select('id').eq('user_id', quote.uid).maybeSingle()
    if (!wallet) {
        const created = await db.from('wallets').insert({ user_id: quote.uid }).select().single()
        wallet = created.data
    }
    if (!wallet?.id) {
        console.error('[UssdUtilities] Could not get or create a wallet for', quote.uid)
        return { ok: false, field: 'fatal', error: 'System busy. Please try again.' }
    }

    // The caller is charged exactly the quote: no gateway fee on USSD, the gateway
    // absorbs its cut at settlement (the same stance as every other USSD sale).
    const { error } = await db.from('wallet_payments').insert({
        user_id: quote.uid,
        wallet_id: wallet.id,
        amount: quote.subtotal,
        fee: 0,
        total_amount: quote.subtotal,
        reference,
        provider: 'paystack_momo',
        status: 'pending',
        metadata: quote.metadata,
    })
    if (error) {
        console.error('[UssdUtilities] wallet_payments insert failed:', error.message)
        return { ok: false, field: 'fatal', error: 'System busy. Please try again.' }
    }

    return { ok: true, amount: quote.subtotal }
}
