/**
 * Customer SMS — the shared rules behind the shop owner's own SMS product.
 *
 * Everything a route or a page needs to agree on lives here: how a message is
 * priced in credits, what makes a sender ID acceptable to the networks, how a
 * recipient list is cleaned, and how a queued campaign is actually dispatched.
 *
 * Kept apart from lib/sms-service.ts on purpose: that file is the platform's own
 * transactional notifications, this one is a metered product customers pay for.
 */

import { sendSMS, normalizeGhanaPhone, getActiveSmsProvider } from '@/lib/sms-service'
import { sendKingFlexyBulkSMS, isKingFlexySmsConfigured, KF_INLINE_RECIPIENTS } from '@/lib/kingflexy-sms-service'
import { SUB_AGENTS_GROUP_ID, findBlockedSenderWord } from '@/lib/sms/sms-rules'
import { fetchAllRows } from '@/lib/supabase-pagination'

export {
    countSegments,
    SMS_MESSAGE_MIN,
    SMS_MESSAGE_MAX,
    SENDER_ID_MIN,
    SENDER_ID_MAX,
    SENDER_ID_TIPS,
    validateSenderId,
    SUB_AGENTS_GROUP_ID,
} from '@/lib/sms/sms-rules'
export type { SegmentInfo, SenderIdCheck } from '@/lib/sms/sms-rules'

// ============================================================
// ACCOUNT
// ============================================================

export interface SmsAccount {
    id: string
    user_id: string
    shop_id: string | null
    status: 'locked' | 'active' | 'suspended'
    credits: number
    total_purchased: number
    total_used: number
    default_sender: string | null
}

/** Which product an account belongs to: the shop's Customer SMS or the SMS Platform. */
export type SmsAccountScope = 'shop' | 'platform'

const ACCOUNT_COLUMNS = 'id, user_id, shop_id, status, credits, total_purchased, total_used, default_sender'

/**
 * The caller's SMS account for one product, created on first sight so every
 * later query has a row to hang off.
 *
 * The shop's Customer SMS and the SMS Platform are separate products: each
 * user has one account per scope, with its own credits, sender IDs, contacts
 * and records (migration 20261019010000_sms_separate_accounts.sql).
 *
 * Activation differs by product. A platform account is always open — the
 * platform has no unlock fee. A shop account follows the shop's own unlock
 * (paid, or free while admin waives it with sms_free_activation).
 *
 * On a database that has not run the migration yet there is no scope column:
 * one account per user serves both products, opened on sight as it has been
 * since the platform launched.
 *
 * @param db A service-role client — sms_accounts is insert-only to the service
 *           role, since an account is an entitlement and not self-serve.
 */
export async function resolveSmsAccount(
    db: any,
    userId: string,
    shopId?: string | null,
    scope: SmsAccountScope = 'shop',
): Promise<SmsAccount | null> {
    if (!userId) return null

    let scoped = true
    const read = () => {
        const q = db.from('sms_accounts').select(ACCOUNT_COLUMNS).eq('user_id', userId)
        return scoped ? q.eq('scope', scope).maybeSingle() : q.maybeSingle()
    }

    let { data: existing, error: readError } = await read()
    if (readError?.code === '42703') {
        scoped = false
        ;({ data: existing } = await read())
    }

    const openOnSight = scope === 'platform' || !scoped

    if (existing) {
        // A shop created after the SMS account was first touched still needs
        // linking, otherwise "import from my orders" finds nothing.
        const patch: Record<string, any> = {}
        if (!existing.shop_id && shopId) patch.shop_id = shopId
        if (openOnSight && existing.status === 'locked') {
            patch.status = 'active'
            patch.unlocked_at = new Date().toISOString()
            patch.unlock_amount = 0
        }
        if (Object.keys(patch).length) {
            patch.updated_at = new Date().toISOString()
            // .eq(status) keeps a concurrent admin suspension from being undone.
            let update = db.from('sms_accounts').update(patch).eq('id', existing.id)
            if (patch.status) update = update.eq('status', 'locked')
            const { error } = await update
            if (!error) Object.assign(existing, patch)
        }
        return existing as SmsAccount
    }

    const row: Record<string, any> = { user_id: userId, shop_id: shopId ?? null }
    if (scoped) row.scope = scope
    if (openOnSight) {
        row.status = 'active'
        row.unlocked_at = new Date().toISOString()
        row.unlock_amount = 0
    }

    const { data: created, error } = await db
        .from('sms_accounts')
        .insert(row)
        .select(ACCOUNT_COLUMNS)
        .single()

    if (error) {
        // Lost a race with a concurrent request; the unique on (user_id, scope)
        // means the other one won and its row is the right one.
        const { data: raced } = await read()
        return (raced as SmsAccount) ?? null
    }

    return created as SmsAccount
}

/**
 * Reads (never creates) a user's account for one product. Before the
 * per-product migration there is one account per user, which is returned for
 * either scope.
 */
export async function findSmsAccountByUser(db: any, userId: string, scope: SmsAccountScope, columns = '*'): Promise<any | null> {
    if (!userId) return null
    const { data, error } = await db.from('sms_accounts').select(columns).eq('user_id', userId).eq('scope', scope).maybeSingle()
    if (!error) return data ?? null
    if (error.code !== '42703') {
        console.error('[CustomerSMS] account lookup failed:', error.message)
        return null
    }
    const { data: legacy } = await db.from('sms_accounts').select(columns).eq('user_id', userId).maybeSingle()
    return legacy ?? null
}

/**
 * Whether a sender name is already held (submitted to the networks or approved)
 * by a DIFFERENT person. A sender ID belongs to one business at the network,
 * but the same owner may use their name on both their shop's Customer SMS and
 * their SMS Platform account, so the owner's own accounts never block it.
 */
export async function senderClaimedByOtherUser(db: any, sender: string, userId: string): Promise<boolean> {
    const name = String(sender || '').trim()
    if (!name) return false
    // Sender IDs are letters, digits and spaces only, so ilike here is an exact,
    // case-insensitive match with no wildcards to escape.
    const { data, error } = await db
        .from('sms_sender_ids')
        .select('id, account:sms_accounts!inner(user_id)')
        .ilike('sender', name)
        .in('status', ['submitted', 'approved'])
    if (error) {
        console.error('[CustomerSMS] sender claim check failed:', error.message)
        return false
    }
    return (data || []).some((row: any) => row.account?.user_id && row.account.user_id !== userId)
}

/** Pool senders any unlocked account may send under, from admin_settings. */
export async function getPoolSenders(db: any): Promise<string[]> {
    try {
        const { data } = await db.from('admin_settings').select('value').eq('key', 'sms_pool_senders').maybeSingle()
        const raw = (data as any)?.value
        if (!raw) return []
        // The column is JSONB but the repo stores these as quoted strings, so a
        // value can arrive as either a JSON array or a comma-separated string.
        if (Array.isArray(raw)) return raw.map(String).filter(Boolean)
        return String(raw)
            .replace(/^"+|"+$/g, '')
            .split(',')
            .map(s => s.trim().replace(/^"+|"+$/g, ''))
            .filter(Boolean)
    } catch {
        return []
    }
}

/**
 * Every sender the account may legally use: its own approved IDs plus the pool.
 */
export async function getAllowedSenders(db: any, accountId: string): Promise<{ sender: string; type: 'own' | 'pool'; isDefault: boolean }[]> {
    const { data: own } = await db
        .from('sms_sender_ids')
        .select('sender, is_default')
        .eq('account_id', accountId)
        .eq('status', 'approved')

    const pool = await getPoolSenders(db)
    // The name rule is checked when a sender is requested, but an approved row can
    // predate it or be set by hand; never send under a telco-looking name.
    const ownSenders = (own || [])
        .filter((row: any) => !findBlockedSenderWord(String(row.sender)))
        .map((row: any) => ({
            sender: row.sender as string,
            type: 'own' as const,
            isDefault: !!row.is_default,
        }))

    const ownNames = new Set(ownSenders.map(s => s.sender.toLowerCase()))
    const poolSenders = pool
        .filter(name => !ownNames.has(name.toLowerCase()))
        .map(name => ({ sender: name, type: 'pool' as const, isDefault: false }))

    return [...ownSenders, ...poolSenders]
}

// ============================================================
// RECIPIENTS
// ============================================================


export interface RecipientResolution {
    /** Normalised, deduped, opt-outs and unreachable numbers removed. */
    recipients: string[]
    /** Numbers that could not be parsed, echoed back so the UI can show them. */
    invalid: string[]
    /** Contacts skipped because they opted out. */
    optedOut: number
}

/**
 * Turns whatever the caller sent — raw numbers, contact ids, group ids — into
 * the exact list that will be charged for and dispatched.
 *
 * @param db A service-role client.
 */
export async function normaliseRecipients(
    db: any,
    accountId: string,
    input: {
        numbers?: string[]
        contactIds?: string[]
        groupIds?: string[]
        /** Every contact on the account — the "all my customers" send. */
        allContacts?: boolean
        shopId?: string | null
    }
): Promise<RecipientResolution> {
    const phones = new Set<string>()
    const invalid: string[] = []
    let optedOut = 0

    const addRaw = (value: string) => {
        const normalised = normalizeGhanaPhone(value)
        if (normalised) phones.add(normalised)
        else if (value?.trim()) invalid.push(value.trim())
    }

    for (const number of input.numbers || []) addRaw(number)

    // Contacts named directly.
    if (input.contactIds?.length) {
        const { data } = await db
            .from('sms_contacts')
            .select('phone, opted_out')
            .eq('account_id', accountId)
            .in('id', input.contactIds)

        for (const row of (data || []) as any[]) {
            if (row.opted_out) { optedOut++; continue }
            phones.add(row.phone)
        }
    }

    const groupIds = input.groupIds || []
    const realGroupIds = groupIds.filter(id => id !== SUB_AGENTS_GROUP_ID)

    // Paged: PostgREST stops at 1000 rows, and a truncated group is a send that
    // silently skips everyone after the thousandth customer.
    if (input.allContacts) {
        const { data } = await fetchAllRows<{ phone: string; opted_out: boolean }>(() =>
            db
                .from('sms_contacts')
                .select('id, phone, opted_out')
                .eq('account_id', accountId)
                .order('id', { ascending: true })
        )
        for (const row of data) {
            if (row.opted_out) { optedOut++; continue }
            phones.add(row.phone)
        }
    }

    if (realGroupIds.length) {
        const { data } = await fetchAllRows(() =>
            db
                .from('sms_group_members')
                .select('group_id, contact_id, contact:sms_contacts!inner(phone, opted_out, account_id)')
                .in('group_id', realGroupIds)
                .order('group_id', { ascending: true })
                .order('contact_id', { ascending: true })
        )

        for (const row of data as any[]) {
            const contact = row.contact
            if (!contact || contact.account_id !== accountId) continue
            if (contact.opted_out) { optedOut++; continue }
            phones.add(contact.phone)
        }
    }

    if (groupIds.includes(SUB_AGENTS_GROUP_ID) && input.shopId) {
        for (const phone of await getSubAgentPhones(db, input.shopId)) phones.add(phone)
    }

    return { recipients: [...phones], invalid, optedOut }
}

/**
 * Phone numbers of the active sub-agents directly under `shopId`.
 *
 * Direct subs only: a sub-of-a-sub belongs to their own upline's network, and a
 * Lead messaging two levels down would surprise everybody.
 */
export async function getSubAgentPhones(db: any, shopId: string): Promise<string[]> {
    const { data: subs } = await db
        .from('sub_agents')
        .select('user_id')
        .eq('upline_shop_id', shopId)
        .eq('status', 'active')

    const userIds = (subs || []).map((row: any) => row.user_id).filter(Boolean)
    if (!userIds.length) return []

    const { data: users } = await db
        .from('users')
        .select('phone_number')
        .in('id', userIds)
        .not('phone_number', 'is', null)

    const phones = new Set<string>()
    for (const row of (users || []) as any[]) {
        const normalised = normalizeGhanaPhone(row.phone_number)
        if (normalised) phones.add(normalised)
    }
    return [...phones]
}

// ============================================================
// DISPATCH
// ============================================================

/** How long a claimed row may sit in 'sending' before a later tick reclaims it. */
const STALE_CLAIM_MS = 5 * 60 * 1000

/** Matches the admin broadcast route: wide enough to be quick, narrow enough to survive Vercel. */
const SEND_BATCH_SIZE = 10

export interface DispatchResult {
    sent: number
    failed: number
    remaining: number
}

/**
 * Sends up to `limit` of a campaign's queued messages.
 *
 * Rows are claimed into 'sending' before the provider is called, so a second
 * worker running concurrently cannot send the same message twice. Credits for
 * messages the provider rejects are refunded as they fail — the owner paid up
 * front for a message that never left.
 *
 * @param db A service-role client.
 */
export async function dispatchCampaignBatch(db: any, campaignId: string, limit: number): Promise<DispatchResult> {
    const { data: campaign } = await db
        .from('sms_campaigns')
        .select('id, account_id, message, sender_used, segments')
        .eq('id', campaignId)
        .maybeSingle()

    if (!campaign) return { sent: 0, failed: 0, remaining: 0 }

    // Sweep rows a previous run claimed and then died holding.
    const staleBefore = new Date(Date.now() - STALE_CLAIM_MS).toISOString()
    await db
        .from('sms_messages')
        .update({ status: 'queued' })
        .eq('campaign_id', campaignId)
        .eq('status', 'sending')
        .lt('status_updated_at', staleBefore)

    const { data: queued } = await db
        .from('sms_messages')
        .select('id, recipient')
        .eq('campaign_id', campaignId)
        .eq('status', 'queued')
        .limit(limit)

    const rows = (queued || []) as { id: string; recipient: string }[]
    if (!rows.length) return { sent: 0, failed: 0, remaining: await countQueued(db, campaignId) }

    // Claim: only rows still 'queued' come back, so a racing worker's rows are
    // silently left to it.
    const { data: claimed } = await db
        .from('sms_messages')
        .update({ status: 'sending', status_updated_at: new Date().toISOString() })
        .in('id', rows.map(r => r.id))
        .eq('status', 'queued')
        .select('id, recipient')

    const mine = (claimed || []) as { id: string; recipient: string }[]
    let sent = 0
    let failed = 0

    /**
     * Gives back what the named messages cost and marks them failed.
     *
     * The owner paid up front for the whole list, so a message that never left
     * has to be refunded — one credit per segment, p_purchased = false so a
     * refund never inflates the lifetime "purchased" figure.
     */
    const failAndRefund = async (rows: { id: string }[], why: string) => {
        if (!rows.length) return
        await db.from('sms_messages').update({
            status: 'failed',
            error: why,
            status_updated_at: new Date().toISOString(),
        }).in('id', rows.map(r => r.id))

        for (let i = 0; i < rows.length; i++) {
            const { error } = await db.rpc('credit_sms_credits', {
                p_account_id: campaign.account_id,
                p_amount: campaign.segments || 1,
                p_purchased: false,
            })
            if (error) console.error('[CustomerSMS] CRITICAL: credit refund failed for message', rows[i].id, error)
        }
    }

    // ── BULK PROVIDER ────────────────────────────────────────────────────────
    // KingFlexy takes the whole list in one call, so a 500-recipient tick is a
    // single request instead of 500. Their reply is per-campaign rather than
    // per-recipient, which is why a rejected batch fails as a batch.
    // The STOREFRONT gateway decides this, not the platform's own — a shop's
    // campaign goes out under the shop's name, and Moolre and Hubtel only accept
    // senders registered on OUR account with them, so every such send there
    // comes back "Sender ID is not approved".
    //
    // isKingFlexySmsConfigured() is the capability half: the setting can name a
    // gateway whose key was never added, and bulk-sending into that would fail
    // (and refund) every message one at a time.
    if (await getActiveSmsProvider('storefront') === 'kingflexy' && isKingFlexySmsConfigured()) {
        for (let i = 0; i < mine.length; i += KF_INLINE_RECIPIENTS) {
            const chunk = mine.slice(i, i + KF_INLINE_RECIPIENTS)

            const result = await sendKingFlexyBulkSMS({
                message: campaign.message,
                recipients: chunk.map(r => r.recipient),
                sender: campaign.sender_used,
                // Their idempotency key. Tied to our campaign and this chunk's
                // first row, so a retried tick returns the original send rather
                // than messaging everyone twice.
                reference: `arhms_${campaignId}_${chunk[0].id}`.slice(0, 100),
            })

            if (!result.ok) {
                failed += chunk.length
                await failAndRefund(chunk, result.outOfCredits
                    ? 'Sending is temporarily unavailable. You have not been charged.'
                    : (result.error || 'Send failed'))
                // Out of credits at the provider affects every remaining chunk
                // too, so stop rather than burn through the whole queue.
                if (result.outOfCredits) break
                continue
            }

            sent += chunk.length
            await db.from('sms_messages').update({
                status: 'sent',
                // Their campaign id, which the delivery webhook matches on.
                provider_message_id: result.campaignId ?? null,
                status_updated_at: new Date().toISOString(),
            }).in('id', chunk.map(r => r.id))
        }

        return { sent, failed, remaining: await countQueued(db, campaignId) }
    }

    for (let i = 0; i < mine.length; i += SEND_BATCH_SIZE) {
        const batch = mine.slice(i, i + SEND_BATCH_SIZE)
        await Promise.allSettled(batch.map(async (row) => {
            let result: { success: boolean; messageId?: string; error?: string }
            try {
                result = await sendSMS({
                    recipient: row.recipient,
                    message: campaign.message,
                    sender: campaign.sender_used,
                    scope: 'storefront',
                })
            } catch (err: any) {
                result = { success: false, error: err?.message || 'Send failed' }
            }

            if (result.success) {
                sent++
                await db.from('sms_messages').update({
                    status: 'sent',
                    provider_message_id: result.messageId ?? null,
                    status_updated_at: new Date().toISOString(),
                }).eq('id', row.id)
                return
            }

            failed++
            await db.from('sms_messages').update({
                status: 'failed',
                error: result.error ?? 'Send failed',
                status_updated_at: new Date().toISOString(),
            }).eq('id', row.id)

            // Refund what this message cost. p_purchased = false so a refund
            // never inflates the lifetime "purchased" figure.
            const { error: refundError } = await db.rpc('credit_sms_credits', {
                p_account_id: campaign.account_id,
                p_amount: campaign.segments || 1,
                p_purchased: false,
            })
            if (refundError) {
                console.error('[CustomerSMS] CRITICAL: credit refund failed for message', row.id, refundError)
            }
        }))
    }

    return { sent, failed, remaining: await countQueued(db, campaignId) }
}

async function countQueued(db: any, campaignId: string): Promise<number> {
    const { count } = await db
        .from('sms_messages')
        .select('id', { count: 'exact', head: true })
        .eq('campaign_id', campaignId)
        .in('status', ['queued', 'sending'])
    return count ?? 0
}

/**
 * Closes a campaign out once nothing is left to send.
 *
 * 'failed' is reserved for the case where every single message failed — a
 * partial failure is still a completed campaign with failures in it.
 */
export async function settleCampaignIfDone(db: any, campaignId: string): Promise<boolean> {
    const remaining = await countQueued(db, campaignId)
    if (remaining > 0) return false

    const { count: failedCount } = await db
        .from('sms_messages')
        .select('id', { count: 'exact', head: true })
        .eq('campaign_id', campaignId)
        .eq('status', 'failed')

    const { count: totalCount } = await db
        .from('sms_messages')
        .select('id', { count: 'exact', head: true })
        .eq('campaign_id', campaignId)

    const allFailed = (totalCount ?? 0) > 0 && failedCount === totalCount

    await db.from('sms_campaigns').update({
        status: allFailed ? 'failed' : 'completed',
        completed_at: new Date().toISOString(),
    }).eq('id', campaignId)

    return true
}
