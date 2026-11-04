import { createServerClient } from '@/lib/supabase'
import { sendSMS } from '@/lib/sms-service'
import { sendPushToUser } from '@/lib/web-push'
import { createNotification } from '@/lib/notification-service'
import {
    BOARDS,
    BOARD_LABELS,
    fetchBoard,
    monthLabel,
    monthStartDate,
    winnerSmsText,
    type TopPerformersConfig,
} from '@/lib/top-performers'

/**
 * Freezing a closed month's top 3 and telling the winners.
 *
 * Rewards are paid by hand: the SMS only tells each winner to contact the admin.
 * Everything here is safe to re-run — rows are unique per (month, board, rank),
 * and an SMS is claimed (sms_sent_at set) before it is sent, so two overlapping
 * runs cannot both text the same winner.
 */

export interface WinnerRow {
    id: string
    month: string
    board: 'dashboard' | 'shop'
    rank: number
    user_id: string
    display_name: string
    total: number
    prize_label: string | null
    sms_sent_at: string | null
    sms_error: string | null
    claimed_at: string | null
}

export interface FinalizeResult {
    month: string
    inserted: number
    alreadyFrozen: string[]
    preview?: Array<{ board: string; rank: number; name: string; total: number; prize: string | null; sms: string | null }>
}

/**
 * Writes the top 3 of each board for `key` unless that board is already frozen.
 * Prize labels are taken from the settings as they stand now; while rankings-only
 * every prize is null, which also means no SMS will ever go out for that month.
 */
export async function finalizeMonth(key: string, config: TopPerformersConfig, opts: { dry?: boolean } = {}): Promise<FinalizeResult> {
    const db = createServerClient() as any
    const month = monthStartDate(key)
    const result: FinalizeResult = { month: key, inserted: 0, alreadyFrozen: [] }
    if (opts.dry) result.preview = []

    const { data: existing, error: existingError } = await db
        .from('top_performer_winners').select('board').eq('month', month)
    if (existingError) throw new Error(`Reading winners: ${existingError.message}`)
    const frozen = new Set((existing || []).map((r: any) => r.board))

    for (const board of BOARDS) {
        if (frozen.has(board)) {
            result.alreadyFrozen.push(board)
            continue
        }
        const top3 = await fetchBoard(board, key, 3)
        if (!top3.length) continue

        const rows = top3.map(entry => ({
            month,
            board,
            rank: entry.rank,
            user_id: entry.userId,
            display_name: entry.name,
            total: entry.total,
            prize_label: config.rankingsOnly ? null : (config.prizes[board][entry.rank - 1] || null),
        }))

        if (opts.dry) {
            for (const row of rows) {
                result.preview!.push({
                    board,
                    rank: row.rank,
                    name: row.display_name,
                    total: row.total,
                    prize: row.prize_label,
                    sms: row.prize_label
                        ? winnerSmsText({ firstName: row.display_name, rank: row.rank, board, month: key, prize: row.prize_label, contactPhone: config.contactPhone })
                        : null,
                })
            }
            continue
        }

        const { data: inserted, error } = await db
            .from('top_performer_winners')
            .upsert(rows, { onConflict: 'month,board,rank', ignoreDuplicates: true })
            .select('user_id, rank, prize_label')
        if (error) throw new Error(`Saving ${board} winners: ${error.message}`)
        result.inserted += (inserted || []).length

        // In-app notice for everyone who placed, prize or not.
        for (const row of inserted || []) {
            const prize = row.prize_label ? ` Prize: ${row.prize_label}. Contact admin to claim it.` : ''
            await createNotification({
                userId: row.user_id,
                title: `You placed #${row.rank} in ${BOARD_LABELS[board]}!`,
                message: `Top performers for ${monthLabel(key)} are in.${prize}`,
                type: 'system',
                actionUrl: '/dashboard/top-performers',
            })
        }
    }

    return result
}

export interface SmsOutcome {
    id: string
    sent: boolean
    error?: string
}

/**
 * Texts one winner. `force` (admin resend) skips the "already sent" guard but
 * still claims the row first so a double click sends once.
 */
export async function sendWinnerSms(row: WinnerRow, config: TopPerformersConfig, opts: { force?: boolean } = {}): Promise<SmsOutcome> {
    const db = createServerClient() as any
    if (!row.prize_label) return { id: row.id, sent: false, error: 'No prize for this place' }

    // Claim: only one caller gets the row back.
    const claimedAt = new Date().toISOString()
    let claim = db.from('top_performer_winners').update({ sms_sent_at: claimedAt, sms_error: null }).eq('id', row.id)
    claim = opts.force && row.sms_sent_at ? claim.eq('sms_sent_at', row.sms_sent_at) : claim.is('sms_sent_at', null)
    const { data: claimed, error: claimError } = await claim.select('id')
    if (claimError) return { id: row.id, sent: false, error: claimError.message }
    if (!claimed?.length) return { id: row.id, sent: false, error: 'Already being sent' }

    const { data: user } = await db.from('users').select('first_name, phone_number').eq('id', row.user_id).maybeSingle()
    const monthKeyValue = String(row.month).slice(0, 7)
    const message = winnerSmsText({
        firstName: user?.first_name || row.display_name,
        rank: row.rank,
        board: row.board,
        month: monthKeyValue,
        prize: row.prize_label,
        contactPhone: config.contactPhone,
    })

    let error: string | undefined
    if (!user?.phone_number) {
        error = 'User has no phone number'
    } else {
        try {
            const res = await sendSMS({ recipient: user.phone_number, message, scope: 'main' })
            if (!res.success) error = res.error || 'SMS provider refused the message'
            else if (res.messageId === 'sms_disabled') error = 'SMS is disabled (SMS_ENABLED=false)'
        } catch (e: any) {
            error = e?.message || 'SMS send threw'
        }
    }

    if (error) {
        await db.from('top_performer_winners')
            .update({ sms_sent_at: null, sms_error: error.slice(0, 300) })
            .eq('id', row.id).eq('sms_sent_at', claimedAt)
        return { id: row.id, sent: false, error }
    }

    sendPushToUser(row.user_id, {
        title: `You won #${row.rank} in ${BOARD_LABELS[row.board]}!`,
        body: `Prize: ${row.prize_label}. Contact admin to claim your reward.`,
        url: '/dashboard/top-performers',
        tag: `top-performer-${row.id}`,
    }).catch(e => console.error('[TopPerformers] Push error:', e?.message || e))

    return { id: row.id, sent: true }
}

/** Sends every unsent SMS for `key`. Rows that failed are retried for 3 days, then left for an admin. */
export async function sendPendingWinnerSms(key: string, config: TopPerformersConfig): Promise<SmsOutcome[]> {
    if (config.rankingsOnly) return []
    const db = createServerClient() as any
    const retryCutoff = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString()

    const { data: rows, error } = await db
        .from('top_performer_winners')
        .select('*')
        .eq('month', monthStartDate(key))
        .is('sms_sent_at', null)
        .not('prize_label', 'is', null)
        .or(`sms_error.is.null,created_at.gte.${retryCutoff}`)
    if (error) throw new Error(`Reading unsent winners: ${error.message}`)

    const outcomes: SmsOutcome[] = []
    for (const row of (rows || []) as WinnerRow[]) {
        outcomes.push(await sendWinnerSms(row, config))
    }
    return outcomes
}
