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

        // Realtime Subscriptions
        const ordersChannel = supabase.channel('admin-counts-orders')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, () => {
                fetchOrdersCount()
                fetchMashupOrdersCount()
            })
            .subscribe()

        const shopsChannel = supabase.channel('admin-counts-shops')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'shop_profiles' }, fetchShopsCount)
            .subscribe()

        const withdrawalsChannel = supabase.channel('admin-counts-withdrawals')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'shop_wallet_transactions' }, fetchWithdrawalsCount)
            .subscribe()

        const afaChannel = supabase.channel('admin-counts-afa')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'afa_orders' }, fetchAfaCount)
            .subscribe()

        const airtimeChannel = supabase.channel('admin-counts-airtime')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'airtime_orders' }, fetchAirtimeCount)
            .subscribe()

        const complaintsChannel = supabase.channel('admin-counts-complaints')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'complaints' }, fetchComplaintsCount)
            .subscribe()

        const usersChannel = supabase.channel('admin-counts-users')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'users' }, fetchExpiringAgentsCount)
            .subscribe()

        const debtsChannel = supabase.channel('admin-counts-debts')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'pending_settlements' }, fetchPendingDebtsCount)
            .subscribe()

        return () => {
            supabase.removeChannel(ordersChannel)
            supabase.removeChannel(shopsChannel)
            supabase.removeChannel(withdrawalsChannel)
            supabase.removeChannel(afaChannel)
            supabase.removeChannel(airtimeChannel)
            supabase.removeChannel(complaintsChannel)
            supabase.removeChannel(usersChannel)
            supabase.removeChannel(debtsChannel)
        }
    }, [isAdmin, fetchAllCounts, fetchOrdersCount, fetchShopsCount, fetchWithdrawalsCount, fetchAfaCount, fetchAirtimeCount, fetchComplaintsCount, fetchExpiringAgentsCount, fetchPendingDebtsCount, fetchMashupOrdersCount])

    return { counts, refresh: fetchAllCounts }
}
