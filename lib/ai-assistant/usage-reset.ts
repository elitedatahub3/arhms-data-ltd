/**
 * Paid reset of the ARHMS AI monthly allowance, charged from the ARHMS wallet.
 * (Mobile Money tops the wallet up through the normal top-up flow first; owner's
 * decision 2026-11-19, so no new payment type touches the gateway code.)
 *
 * Money-safety rules:
 *   - the PRICE and the questions added come from admin_settings, never from the client;
 *   - a shop reset is only for the shop's owner;
 *   - the purchase row (UNIQUE reference built from the client's idempotency key) is
 *     inserted BEFORE the wallet is charged, so a double tap or retry can't charge twice;
 *   - the wallet charge is the atomic deduct_wallet_balance RPC (only succeeds when the
 *     balance covers it);
 *   - if marking the purchase paid fails after charging, the money is refunded.
 *
 * No runtime imports: the db client is passed in, so node --test drives it with a
 * fake (lib/__tests__/ai-assistant-usage-reset.test.mts).
 */
import {
    currentMonthKey,
    isValidIdempotencyKey,
    parseMonthlyLimit,
    parseResetPrice,
    USAGE_DEFAULTS,
    USAGE_SETTING_KEYS,
    type UsageScope,
} from './helpers.ts'

export type ResetResult =
    | { ok: true; alreadyPaid?: boolean; questionsAdded: number; amount: number; newBalance?: number }
    | { ok: false; code: 'bad_request' | 'forbidden' | 'insufficient' | 'in_progress' | 'failed'; error: string; price?: number }

export async function loadUsageTerms(db: any, scope: UsageScope): Promise<{ limit: number; price: number }> {
    const keys = USAGE_SETTING_KEYS[scope]
    const { data } = await db.from('admin_settings').select('key, value').in('key', [keys.limit, keys.price])
    const s: Record<string, string> = {}
    for (const r of data || []) s[r.key] = r.value
    return {
        limit: parseMonthlyLimit(s[keys.limit], USAGE_DEFAULTS[scope].limit),
        price: parseResetPrice(s[keys.price], USAGE_DEFAULTS[scope].price),
    }
}

export async function chargeUsageReset(
    db: any,
    params: { userId: string; scope: UsageScope; shopId?: string | null; idempotencyKey: unknown; now?: Date },
): Promise<ResetResult> {
    const { userId, scope } = params
    if (scope !== 'dashboard' && scope !== 'shop') return { ok: false, code: 'bad_request', error: 'Unknown reset type.' }
    if (!isValidIdempotencyKey(params.idempotencyKey)) return { ok: false, code: 'bad_request', error: 'Invalid request.' }

    let shopId: string | null = null
    if (scope === 'shop') {
        if (!params.shopId) return { ok: false, code: 'bad_request', error: 'Missing shop.' }
        const { data: shop } = await db.from('shop_profiles').select('id, owner_id').eq('id', params.shopId).maybeSingle()
        if (!shop || shop.owner_id !== userId) return { ok: false, code: 'forbidden', error: 'Only the shop owner can do this.' }
        shopId = shop.id
    }

    const terms = await loadUsageTerms(db, scope)
    const reference = `AIRESET-${scope}-${params.idempotencyKey}`
    const description = `ARHMS AI: ${terms.limit} more questions${scope === 'shop' ? ' for your shop' : ''}`

    // 1. Claim the reference first. A retry with the same key hits the UNIQUE index.
    const { error: claimError } = await db.from('ai_usage_purchases').insert({
        user_id: userId,
        shop_id: shopId,
        scope,
        month: currentMonthKey(params.now),
        questions_added: terms.limit,
        amount: terms.price,
        method: 'wallet',
        reference,
        status: 'pending',
    })
    if (claimError) {
        if (claimError.code === '23505') {
            const { data: existing } = await db.from('ai_usage_purchases')
                .select('status, questions_added, amount, user_id').eq('reference', reference).maybeSingle()
            if (existing && existing.user_id === userId && existing.status === 'paid') {
                return { ok: true, alreadyPaid: true, questionsAdded: existing.questions_added, amount: Number(existing.amount) }
            }
            if (existing?.status === 'pending') return { ok: false, code: 'in_progress', error: 'This payment is already being processed.' }
            return { ok: false, code: 'failed', error: 'That payment did not go through. Please try again.' }
        }
        console.error('[ARHMS AI reset] purchase claim failed', claimError.message)
        return { ok: false, code: 'failed', error: 'Could not start the payment. Please try again.' }
    }

    const markFailed = () => db.from('ai_usage_purchases').update({ status: 'failed' }).eq('reference', reference).eq('status', 'pending')

    // 2. Charge the wallet atomically (free resets skip the charge).
    let walletId: string | null = null
    let newBalance: number | undefined
    if (terms.price > 0) {
        const { data: deducted, error: deductError } = await db.rpc('deduct_wallet_balance', { p_user_id: userId, p_amount: terms.price })
        if (deductError) {
            await markFailed()
            if (String(deductError.message || '').includes('INSUFFICIENT_BALANCE')) {
                return { ok: false, code: 'insufficient', error: `Your wallet needs GHS ${terms.price.toFixed(2)}. Top up and try again.`, price: terms.price }
            }
            console.error('[ARHMS AI reset] wallet deduction failed', deductError.message)
            return { ok: false, code: 'failed', error: 'Payment failed. You were not charged.' }
        }
        const row = Array.isArray(deducted) ? deducted[0] : deducted
        walletId = row?.wallet_id ?? null
        newBalance = row?.new_balance != null ? Number(row.new_balance) : undefined
        if (!walletId) {
            await markFailed()
            return { ok: false, code: 'insufficient', error: `Your wallet needs GHS ${terms.price.toFixed(2)}. Top up and try again.`, price: terms.price }
        }
    }

    // 3. Mark paid. If that fails, give the money back.
    const { error: paidError } = await db.from('ai_usage_purchases')
        .update({ status: 'paid', paid_at: new Date().toISOString() })
        .eq('reference', reference).eq('status', 'pending')
    if (paidError) {
        console.error('[ARHMS AI reset] could not mark paid, refunding', reference, paidError.message)
        if (terms.price > 0) {
            const { error: refundError } = await db.rpc('credit_wallet_balance', { p_user_id: userId, p_amount: terms.price })
            if (refundError) console.error('[ARHMS AI reset] CRITICAL: refund failed for', reference, refundError.message)
        }
        await markFailed()
        return { ok: false, code: 'failed', error: 'Payment failed and was refunded to your wallet.' }
    }

    // 4. Statement line (best effort: a missing line must not undo a paid reset).
    if (terms.price > 0 && walletId) {
        const { error: ledgerError } = await db.from('wallet_transactions').insert({
            wallet_id: walletId,
            user_id: userId,
            type: 'debit',
            amount: terms.price,
            description,
            reference,
            source: 'purchase',
            status: 'completed',
        })
        if (ledgerError) console.error('[ARHMS AI reset] wallet_transactions insert failed', ledgerError.message)
    }

    return { ok: true, questionsAdded: terms.limit, amount: terms.price, newBalance }
}
