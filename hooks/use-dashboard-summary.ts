'use client'

import useSWR, { mutate as globalMutate } from 'swr'
import { useAuth } from '@/contexts/auth-context'

/**
 * The dashboard home's data, from the single /api/dashboard/summary request.
 *
 * Keys include the signed-in user's id, so signing in as someone else can never
 * show the previous account's cached figures.
 */

export interface DashboardSummary {
    stats: {
        totalOrders: number
        completedOrders: number
        processingOrders: number
        failedOrders: number
        pendingOrders: number
        walletBalance: number
    }
    recentOrders: any[]
    today: {
        orders: Array<{ status: string; size: string; price: number }>
        afaOrders: Array<{ status: string; payment_amount: number }>
    }
    performance: {
        totalCount: number
        completedCount: number
        completedLast14Days: Array<{ price: number; created_at: string }>
    }
    unreadNotifications: number
    shop: any
}

export const dashboardSummaryKey = (userId?: string) =>
    userId ? (['dashboard-summary', userId] as const) : null

const fetcher = async (): Promise<DashboardSummary> => {
    const res = await fetch('/api/dashboard/summary')
    if (!res.ok) throw new Error('Failed to load dashboard')
    return res.json()
}

export function useDashboardSummary() {
    const { dbUser } = useAuth()
    return useSWR(dashboardSummaryKey(dbUser?.id), fetcher)
}

/**
 * Refresh the dashboard after anything that moves money or creates an order — a
 * purchase, a bulk purchase, a wallet top-up. A cached wallet balance that is
 * half a minute stale is worse than a slow page, so call this instead of
 * letting the entry age out on its own.
 *
 * Matches on the key prefix, so callers don't need the user id to hand.
 */
export function refreshDashboardSummary() {
    globalMutate(key => Array.isArray(key) && key[0] === 'dashboard-summary')
}
