/**
 * Shop assistant credits: state, paying for an answer, and buying packs.
 *
 * Money-safety rules (same as the dashboard reset in usage-reset.ts):
 *   - the pack (credits + price) comes from admin_settings, never from the client;
 *   - the buyer must own the shop (resolved from the session user, not a shop id);
 *   - the purchase row (UNIQUE reference from the client's idempotency key) is
 *     claimed BEFORE the wallet is charged, so a double tap charges once;
 *   - the wallet charge is the atomic deduct_wallet_balance RPC;
 *   - if adding the credits fails after charging, the money is refunded.
 *
 * No runtime imports: the db client is passed in, so node --test can drive it
 * (lib/__tests__/ai-assistant-shop-credits.test.mts).
 */
import {
    chooseAnswerPayer,
    currentMonthKey,
    isValidIdempotencyKey,
    monthStartIso,
    parseCreditPacks,
    parseFreeMonthlyCredits,
    SHOP_CREDIT_SETTING_KEYS,
    type CreditPack,
} from './helpers.ts'

export async function loadShopCreditTerms(db: any): Promise<{ packs: CreditPack[]; freeMonthly: number }> {
    const { data } = await db.from('admin_settings').select('key, value')
        .in('key', [SHOP_CREDIT_SETTING_KEYS.packs, SHOP_CREDIT_SETTING_KEYS.freeMonthly])
    const s: Record<string, string> = {}
    for (const r of data || []) s[r.key] = r.value
    return { packs: parseCreditPacks(s[SHOP_CREDIT_SETTING_KEYS.packs]), freeMonthly: parseFreeMonthlyCredits(s[SHOP_CREDIT_SETTING_KEYS.freeMonthly]) }
}

export interface ShopCreditState {
    bought: number
    freeMonthly: number
    freeUsed: number
    freeLeft: number
    /** Free left this month + bought: what the owner sees as "credits left". */
    total: number
}

export async function getShopCreditState(db: any, shopId: string, freeMonthly: number, now?: Date): Promise<ShopCreditState> {
    const [{ data: row }, { count }] = await Promise.all([
        db.from('ai_shop_credits').select('balance').eq('shop_id', shopId).maybeSingle(),
        db.from('ai_shop_questions').select('id', { count: 'exact', head: true })
            .eq('shop_id', shopId).eq('paid_by', 'shop_free').gte('created_at', monthStartIso(now)),
    ])
    const bought = Math.max(0, Number(row?.balance || 0))
    const freeUsed = count || 0
    const freeLeft = Math.max(0, freeMonthly - freeUsed)
    return { bought, freeMonthly, freeUsed, freeLeft, total: freeLeft + bought }
}

/**
 * Decide who pays for this answer and, for a bought credit, take it atomically.
 * Returns the payer to record on the ai_shop_questions row, or null (wait till tomorrow).
 */
export async function payForShopAnswer(
    db: any,
    p: { shopId: string; visitorUsedToday: number; visitorFreePerDay: number; freeMonthly: number; now?: Date },
): Promise<'visitor_free' | 'shop_free' | 'shop_credit' | null> {
    if (p.visitorUsedToday < p.visitorFreePerDay) return 'visitor_free'
    const state = await getShopCreditState(db, p.shopId, p.freeMonthly, p.now)
    const payer = chooseAnswerPayer({
        visitorUsedToday: p.visitorUsedToday,
        visitorFreePerDay: p.visitorFreePerDay,
        shopFreeUsedThisMonth: state.freeUsed,
        shopFreeMonthly: p.freeMonthly,
        boughtBalance: state.bought,
    })
    if (payer !== 'shop_credit') return payer
    // Two customers could race for the last credit: the RPC decides atomically.
    const { data: used, error } = await db.rpc('consume_shop_credit', { p_shop_id: p.shopId })
    if (error) {
        console.error('[Shop AI] consume_shop_credit failed, is migration 20261121000000 run?', error.message)
        return null
    }
    return used === true ? 'shop_credit' : null
}

export type BuyResult =
    | { ok: true; alreadyPaid?: boolean; credits: number; amount: number; balance?: number }
    | { ok: false; code: 'bad_request' | 'forbidden' | 'insufficient' | 'in_progress' | 'failed'; error: string; price?: number }

export async function buyCreditPack(
    db: any,
    params: { userId: string; packId: unknown; idempotencyKey: unknown; now?: Date },
): Promise<BuyResult> {
    const { userId } = params
    if (!isValidIdempotencyKey(params.idempotencyKey)) return { ok: false, code: 'bad_request', error: 'Invalid request.' }

    const { data: shop } = await db.from('shop_profiles').select('id, owner_id').eq('owner_id', userId).maybeSingle()
    if (!shop || shop.owner_id !== userId) return { ok: false, code: 'forbidden', error: 'Only shop owners can buy credits.' }

    const { packs } = await loadShopCreditTerms(db)
    const pack = packs.find(p => p.id === params.packId && p.enabled)
    if (!pack) return { ok: false, code: 'bad_request', error: 'That pack is not available.' }

    const reference = `AICRED-${params.idempotencyKey}`

    // 1. Claim the reference first: a retry with the same key hits the UNIQUE index.
    const { error: claimError } = await db.from('ai_usage_purchases').insert({
        user_id: userId,
        shop_id: shop.id,
        scope: 'shop',
        month: currentMonthKey(params.now),
        questions_added: pack.credits,
        amount: pack.price,
        method: 'wallet',
        reference,
        status: 'pending',
    })
    if (claimError) {
        if (claimError.code === '23505') {
            const { data: existing } = await db.from('ai_usage_purchases')
                .select('status, questions_added, amount, user_id').eq('reference', reference).maybeSingle()
            if (existing && existing.user_id === userId && existing.status === 'paid') {
                return { ok: true, alreadyPaid: true, credits: existing.questions_added, amount: Number(existing.amount) }
            }
            if (existing?.status === 'pending') return { ok: false, code: 'in_progress', error: 'This payment is already being processed.' }
            return { ok: false, code: 'failed', error: 'That payment did not go through. Please try again.' }
        }
        console.error('[Shop credits] purchase claim failed', claimError.message)
        return { ok: false, code: 'failed', error: 'Could not start the payment. Please try again.' }
    }
    const markFailed = () => db.from('ai_usage_purchases').update({ status: 'failed' }).eq('reference', reference).eq('status', 'pending')

    // 2. Charge the wallet atomically (a free pack skips the charge).
    let walletId: string | null = null
    if (pack.price > 0) {
        const { data: deducted, error: deductError } = await db.rpc('deduct_wallet_balance', { p_user_id: userId, p_amount: pack.price })
        if (deductError) {
            await markFailed()
            if (String(deductError.message || '').includes('INSUFFICIENT_BALANCE')) {
                return { ok: false, code: 'insufficient', error: `Your wallet needs GHS ${pack.price.toFixed(2)}. Top up and try again.`, price: pack.price }
            }
            console.error('[Shop credits] wallet deduction failed', deductError.message)
            return { ok: false, code: 'failed', error: 'Payment failed. You were not charged.' }
        }
        const row = Array.isArray(deducted) ? deducted[0] : deducted
        walletId = row?.wallet_id ?? null
        if (!walletId) {
            await markFailed()
            return { ok: false, code: 'insufficient', error: `Your wallet needs GHS ${pack.price.toFixed(2)}. Top up and try again.`, price: pack.price }
        }
    }

    // 3. Add the credits. If that fails, give the money back.
    const { data: balance, error: addError } = await db.rpc('add_shop_credits', { p_shop_id: shop.id, p_credits: pack.credits })
    if (addError) {
        console.error('[Shop credits] add_shop_credits failed, refunding', reference, addError.message)
        if (pack.price > 0) {
            const { error: refundError } = await db.rpc('credit_wallet_balance', { p_user_id: userId, p_amount: pack.price })
            if (refundError) console.error('[Shop credits] CRITICAL: refund failed for', reference, refundError.message)
        }
        await markFailed()
        return { ok: false, code: 'failed', error: 'Could not add the credits. You were refunded.' }
    }

    // 4. Mark paid + statement line (best effort: the credits and charge already match).
    const { error: paidError } = await db.from('ai_usage_purchases')
        .update({ status: 'paid', paid_at: new Date().toISOString() }).eq('reference', reference).eq('status', 'pending')
    if (paidError) console.error('[Shop credits] could not mark paid (credits were added)', reference, paidError.message)
    if (pack.price > 0 && walletId) {
        const { error: ledgerError } = await db.from('wallet_transactions').insert({
            wallet_id: walletId,
            user_id: userId,
            type: 'debit',
            amount: pack.price,
            description: `Shop assistant credits: ${pack.name} (${pack.credits})`,
            reference,
            source: 'purchase',
            status: 'completed',
        })
        if (ledgerError) console.error('[Shop credits] wallet_transactions insert failed', ledgerError.message)
    }

    return { ok: true, credits: pack.credits, amount: pack.price, balance: typeof balance === 'number' ? balance : undefined }
}

// ── Direct Pay (MoMo / card) ─────────────────────────────────────────────────
// /api/ai-assistant/shop-credits/pay records a pending wallet_payments intent
// (reference AICPAY-...) whose metadata carries the shop and the pack, priced on
// the server. Every collection webhook, the verify poller and the reconciliation
// crons route AICPAY- here once the gateway confirms the money. The wallet is
// not touched on the happy path; it is only credited to give money back.

/** Money coming IN for a shop credit pack. Distinct from AICRED-, the wallet purchase. */
export const CREDIT_PAYMENT_PREFIX = 'AICPAY-'

export function isCreditPaymentReference(reference: unknown): boolean {
    return typeof reference === 'string' && reference.startsWith(CREDIT_PAYMENT_PREFIX)
}

/** The caller's own shop and an enabled pack, priced from admin settings. */
export async function resolveCreditPackForOwner(
    db: any,
    userId: string,
    packId: unknown,
): Promise<{ ok: true; shopId: string; pack: CreditPack } | { ok: false; status: number; error: string }> {
    const { data: shop } = await db.from('shop_profiles').select('id, owner_id').eq('owner_id', userId).maybeSingle()
    if (!shop || shop.owner_id !== userId) return { ok: false, status: 403, error: 'Only shop owners can buy credits.' }
    const { packs } = await loadShopCreditTerms(db)
    const pack = packs.find(p => p.id === packId && p.enabled)
    if (!pack) return { ok: false, status: 400, error: 'That pack is not available.' }
    if (!(pack.price > 0)) return { ok: false, status: 400, error: 'This pack is free. Use Wallet to claim it.' }
    return { ok: true, shopId: shop.id, pack }
}

export interface CreditSettleResult {
    success: boolean
    alreadyProcessed?: boolean
    /** Set when adding the credits failed after payment: true = money returned to the wallet. */
    refunded?: boolean
    error?: string
    order?: { reference: string; credits: number; pack_name: string }
}

export async function settleCreditPackPayment(
    db: any,
    reference: string,
    expectedUserId?: string,
    now?: Date,
): Promise<CreditSettleResult> {
    const { data: payment } = await db.from('wallet_payments').select('*').eq('reference', reference).maybeSingle()
    if (!payment) return { success: false, error: 'Payment not found' }
    if (expectedUserId && payment.user_id !== expectedUserId) return { success: false, error: 'Forbidden' }

    const meta = payment.metadata || {}
    const pack = meta.pack || {}
    const credits = Number(pack.credits)
    if (meta.kind !== 'ai_shop_credits' || !meta.shop_id || !Number.isInteger(credits) || credits <= 0) {
        console.error('[Shop credits] malformed AICPAY metadata', reference)
        return { success: false, error: 'Malformed payment metadata' }
    }
    const order = { reference, credits, pack_name: String(pack.name || 'Credits') }

    // Only one caller may flip pending -> completed: the webhook and the poller can't both add credits.
    const { data: claimed, error: claimError } = await db.from('wallet_payments')
        .update({ status: 'completed', updated_at: new Date().toISOString() })
        .eq('id', payment.id).eq('status', 'pending').select().maybeSingle()
    if (claimError) return { success: false, error: 'Failed to update payment status' }
    if (!claimed) return { success: true, alreadyProcessed: true, order }

    const { error: addError } = await db.rpc('add_shop_credits', { p_shop_id: meta.shop_id, p_credits: credits })
    if (addError) {
        // The customer has paid: the money must land somewhere.
        console.error('[Shop credits] CRITICAL: add_shop_credits failed after Direct Pay, refunding', reference, addError.message)
        const { error: refundError } = await db.rpc('credit_wallet_balance', { p_user_id: payment.user_id, p_amount: Number(payment.total_amount) })
        if (refundError) console.error('[Shop credits] CRITICAL: refund ALSO failed for', reference, refundError.message)
        await db.from('notifications').insert({
            user_id: payment.user_id,
            title: 'Shop AI credits not added',
            message: refundError
                ? `We received GHS ${Number(payment.total_amount).toFixed(2)} but could not add your credits. Support has been alerted. Ref: ${reference}`
                : `We could not add your credits, so GHS ${Number(payment.total_amount).toFixed(2)} was returned to your wallet. Ref: ${reference}`,
            type: 'system',
            action_url: '/dashboard/shop/ai',
        })
        return { success: false, refunded: !refundError, error: 'Could not add the credits' }
    }

    // Revenue record for the admin page (same table as wallet purchases).
    const { error: recordError } = await db.from('ai_usage_purchases').insert({
        user_id: payment.user_id,
        shop_id: meta.shop_id,
        scope: 'shop',
        month: currentMonthKey(now),
        questions_added: credits,
        amount: Number(pack.price ?? payment.amount),
        method: 'momo',
        reference,
        status: 'paid',
        paid_at: new Date().toISOString(),
    })
    if (recordError && recordError.code !== '23505') console.error('[Shop credits] purchase record failed (credits were added)', reference, recordError.message)

    await db.from('notifications').insert({
        user_id: payment.user_id,
        title: 'Shop AI credits added',
        message: `${credits} credits (${order.pack_name}) were added to your shop assistant. Ref: ${reference}`,
        type: 'system',
        action_url: '/dashboard/shop/ai',
    })
    return { success: true, order }
}
