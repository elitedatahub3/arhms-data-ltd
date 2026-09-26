/**
 * Settings behind a Commission Wallet payout.
 *
 * Shared so the request route, the wallet endpoint the page reads, and anything that
 * quotes a minimum all resolve them the same way. Shop withdrawals resolve their fees
 * through three fallback layers (per shop, per role, global); commission has one wallet
 * per user and no shop, so one global value each is the whole story.
 */
import { createServerClient } from '@/lib/supabase'

type Supabase = any

export interface CommissionWithdrawalSettings {
    minAmount: number
    feePercent: number
    feeFlat: number
}

/** Defaults if the setting row is missing: a GHS 10 floor and no fee. */
const FALLBACK: CommissionWithdrawalSettings = { minAmount: 10, feePercent: 0, feeFlat: 0 }

const KEYS = {
    minAmount:  'commission_min_withdrawal',
    feePercent: 'commission_withdrawal_fee_percent',
    feeFlat:    'commission_withdrawal_fee_flat',
} as const

export async function commissionWithdrawalSettings(
    supabase?: Supabase
): Promise<CommissionWithdrawalSettings> {
    const db = (supabase || createServerClient()) as any
    try {
        const { data } = await db
            .from('admin_settings')
            .select('key, value')
            .in('key', Object.values(KEYS))

        const map: Record<string, any> = {}
        for (const row of (data as any[]) || []) map[row.key] = row.value

        // admin_settings.value is jsonb and numbers are stored quoted ("10"), so a value
        // can arrive as a string or a number depending on who wrote it last.
        const num = (raw: any, fallback: number) => {
            const n = parseFloat(String(raw ?? ''))
            return Number.isFinite(n) && n >= 0 ? n : fallback
        }

        return {
            minAmount:  num(map[KEYS.minAmount],  FALLBACK.minAmount),
            feePercent: num(map[KEYS.feePercent], FALLBACK.feePercent),
            feeFlat:    num(map[KEYS.feeFlat],    FALLBACK.feeFlat),
        }
    } catch {
        return { ...FALLBACK }
    }
}
