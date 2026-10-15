'use client'

import { useEffect, useState, useCallback } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/auth-context'

export interface AdminCounts {
    pendingOrders: number
    pendingFulfillment: number
    pendingShops: number
    pendingWithdrawals: number
    pendingAfa: number
    pendingAirtime: number
    pendingComplaints: number
    expiringAgents: number
    pendingDebts: number
    pendingMashupOrders: number
    /** Pending orders held because the recipient's MTN number isn't registered yet. */
    pendingAwaitingRegistration: number
}

const initialCounts: AdminCounts = {
    pendingOrders: 0,
    pendingFulfillment: 0,
    pendingShops: 0,
    pendingWithdrawals: 0,
    pendingAfa: 0,
    pendingAirtime: 0,
    pendingComplaints: 0,
    expiringAgents: 0,
    pendingDebts: 0,
    pendingMashupOrders: 0,
    pendingAwaitingRegistration: 0
}

export function useAdminCounts() {
    const { dbUser } = useAuth()
    const [counts, setCounts] = useState<AdminCounts>(initialCounts)
    const isAdmin = dbUser?.role === 'admin' || dbUser?.role === 'sub-admin'

    const fetchOrdersCount = useCallback(async () => {
        const { count } = await (supabase
            .from('orders')
            .select('*', { count: 'exact', head: true })
            .eq('status', 'pending') as any)

        // Fulfillment count (pending + processing for today)
        const today = new Date()
        today.setHours(0, 0, 0, 0)
        const { count: fulfillmentCount } = await (supabase
            .from('orders')
            .select('*', { count: 'exact', head: true })
            .in('status', ['pending', 'processing'])
            .gte('created_at', today.toISOString()) as any)

        // Held on purpose — the buyer accepted the MTN registration wait. Counted
        // separately so these don't read as a growing backlog of stuck orders.
        const { count: awaitingRegistrationCount } = await (supabase
            .from('orders')
            .select('*', { count: 'exact', head: true })
            .eq('status', 'pending')
            .eq('awaiting_registration', true) as any)

        setCounts(prev => ({
            ...prev,
            pendingOrders: count || 0,
            pendingFulfillment: fulfillmentCount || 0,
            pendingAwaitingRegistration: awaitingRegistrationCount || 0
        }))
    }, [])

    const fetchMashupOrdersCount = useCallback(async () => {
        const { count } = await (supabase
            .from('orders')
            .select('*', { count: 'exact', head: true })
            .eq('network', 'Special MTN Mashup')
            .eq('status', 'pending') as any)
        setCounts(prev => ({ ...prev, pendingMashupOrders: count || 0 }))
    }, [])

    const fetchShopsCount = useCallback(async () => {
        // Pending approval
        const { count: pendingApproval } = await (supabase
            .from('shop_profiles')
            .select('*', { count: 'exact', head: true })
            .eq('approval_status', 'pending') as any)

        // Pending pricing review
        const { count: pendingPricing } = await (supabase
            .from('shop_profiles')
            .select('*', { count: 'exact', head: true })
            .eq('approval_status', 'approved')
            .eq('pricing_status', 'pending_review') as any)

        setCounts(prev => ({
            ...prev,
            pendingShops: (pendingApproval || 0) + (pendingPricing || 0)
        }))
    }, [])

    const fetchWithdrawalsCount = useCallback(async () => {
        const { count } = await (supabase
            .from('shop_wallet_transactions')
            .select('*', { count: 'exact', head: true })
            // Sub requests parked at 'shop_owner_pending' need an admin too: money
            // already debited from a sub whose Lead never actioned the request.
            .in('status', ['pending', 'shop_owner_pending']) as any)
        setCounts(prev => ({ ...prev, pendingWithdrawals: count || 0 }))
    }, [])

    const fetchAfaCount = useCallback(async () => {
        const { count } = await (supabase
            .from('afa_orders')
            .select('*', { count: 'exact', head: true })
            .eq('status', 'pending')
            // Matches the filter in /admin/afa-management: an abandoned or declined
            // storefront checkout leaves a row behind that nobody has paid for, and
            // it must not inflate the badge. Written as an allow-list because
            // PostgREST's .neq() also drops NULLs (pre-migration rows).
            .or('payment_status.is.null,payment_status.eq.completed') as any)
        setCounts(prev => ({ ...prev, pendingAfa: count || 0 }))
    }, [])

    const fetchAirtimeCount = useCallback(async () => {
        const { count } = await (supabase
            .from('airtime_orders')
            .select('*', { count: 'exact', head: true })
            .eq('status', 'pending') as any)
        setCounts(prev => ({ ...prev, pendingAirtime: count || 0 }))
    }, [])

    const fetchComplaintsCount = useCallback(async () => {
        const { count } = await (supabase
            .from('complaints')
            .select('*', { count: 'exact', head: true })
            .in('status', ['pending', 'in_review']) as any)
        setCounts(prev => ({ ...prev, pendingComplaints: count || 0 }))
    }, [])

    const fetchExpiringAgentsCount = useCallback(async () => {
        const soon = new Date()
        soon.setDate(soon.getDate() + 3)
        const now = new Date()

        const { count } = await (supabase
            .from('users')
            .select('*', { count: 'exact', head: true })
            .eq('role', 'agent')
            .gt('agent_expires_at', now.toISOString())
            .lte('agent_expires_at', soon.toISOString()) as any)
        setCounts(prev => ({ ...prev, expiringAgents: count || 0 }))
    }, [])

    const fetchPendingDebtsCount = useCallback(async () => {
        const { count } = await (supabase
            .from('pending_settlements')
            .select('*', { count: 'exact', head: true })
            .in('status', ['pending', 'partially_settled']) as any)
        setCounts(prev => ({ ...prev, pendingDebts: count || 0 }))
    }, [])

    const fetchAllCounts = useCallback(() => {
        fetchOrdersCount()
        fetchShopsCount()
        fetchWithdrawalsCount()
        fetchAfaCount()
        fetchAirtimeCount()
        fetchComplaintsCount()
        fetchExpiringAgentsCount()
        fetchPendingDebtsCount()
        fetchMashupOrdersCount()
    }, [fetchOrdersCount, fetchShopsCount, fetchWithdrawalsCount, fetchAfaCount, fetchAirtimeCount, fetchComplaintsCount, fetchExpiringAgentsCount, fetchPendingDebtsCount, fetchMashupOrdersCount])

    useEffect(() => {
        if (!isAdmin) return

        fetchAllCounts()

        // Polled, not realtime. These were eight unfiltered postgres_changes
        // channels (orders, users, ...): every write to those tables shipped the
        // FULL row to every open admin tab — twice, since the sidebar and the admin
        // home both mount this hook — only to re-run a head count. That stream was
        // a large share of the Supabase egress quota. Head counts return no rows,
        // so a poll costs next to nothing, and only while the tab is visible.
        const POLL_MS = 60_000
        const tick = () => {
            if (document.visibilityState === 'visible') fetchAllCounts()
        }
        const timer = setInterval(tick, POLL_MS)
        document.addEventListener('visibilitychange', tick)

        return () => {
            clearInterval(timer)
            document.removeEventListener('visibilitychange', tick)
        }
    }, [isAdmin, fetchAllCounts])

    return { counts, refresh: fetchAllCounts }
}
