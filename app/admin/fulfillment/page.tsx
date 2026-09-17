'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { useAuth } from '@/contexts/auth-context'
import { supabase } from '@/lib/supabase'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Switch } from '@/components/ui/switch'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
    RefreshCw,
    CheckCircle2,
    XCircle,
    Package,
    Activity,
    Server,
    Filter,
    RotateCcw,
    Clock,
    Search,
    Calendar as CalendarIcon,
    ChevronLeft,
    ChevronRight,
    MoreHorizontal,
    Loader2,
    PauseCircle,
    ShieldCheck
} from 'lucide-react'
import { toast } from 'sonner'
import { ADMIN_VERIFYING_LABEL, getOrderDisplayStatus } from '@/lib/order-status-display'
import { formatCurrency, cn } from '@/lib/utils'
import { format } from 'date-fns'

interface Order {
    id: string
    created_at: string
    phone_number: string
    network: string
    size: string
    price: number
    status: string
    payment_status?: string
    supplier_status?: string | null
    user_id: string
    shop_name?: string
    users: {
        first_name: string
        last_name: string
        role: string
    }
    mtn_fulfillment_tracking: Array<{
        transaction_id: string | null
        api_response?: any
        retry_count?: number
    }>
}

interface FulfillmentSettings {
    is_global_enabled: boolean
    networks: Record<string, boolean>
    codecraft_networks: Record<string, boolean>
    kingflexy_networks: Record<string, boolean>
    eazydata_networks: Record<string, boolean>
    agentportal_networks: Record<string, boolean>
    netpulse_networks: Record<string, boolean>
    hendylinks_networks: Record<string, boolean>
}

const NETWORKS = ['MTN', 'Telecel', 'AT-iShare', 'AT-BigTime']

// Supplier id → the FulfillmentSettings key holding its per-network toggles.
// Exactly one supplier may be active per network (the dispatcher halts on
// conflicts), so toggling one on switches every other one off.
const SUPPLIER_KEYS = {
    datakazina: 'networks',
    codecraft: 'codecraft_networks',
    kingflexy: 'kingflexy_networks',
    eazydata: 'eazydata_networks',
    agentportal: 'agentportal_networks',
    netpulse: 'netpulse_networks',
    hendylinks: 'hendylinks_networks',
} as const

type SupplierId = keyof typeof SUPPLIER_KEYS
const PAGE_SIZE = 10
// Per-request page size, and the safety ceiling on how many orders one filter
// will pull into the browser before we stop and say so on screen.
const FETCH_CHUNK = 500
const MAX_ORDERS_LOADED = 5000

export default function FulfillmentPage() {
    const { dbUser } = useAuth()

    // Data State
    const [orders, setOrders] = useState<Order[]>([])
    const [selectedOrders, setSelectedOrders] = useState<Set<string>>(new Set())
    const [isLoadingOrders, setIsLoadingOrders] = useState(true)
    const [isUpdating, setIsUpdating] = useState(false)
    const [isRefulfilling, setIsRefulfilling] = useState(false)
    const [refundingId, setRefundingId] = useState<string | null>(null)

    // Filter State
    const [networkFilter, setNetworkFilter] = useState('All')
    const [statusFilter, setStatusFilter] = useState('All')
    const [dateFilter, setDateFilter] = useState('today')
    const [customDate, setCustomDate] = useState<string>('') // Changed to string for input date
    const [searchQuery, setSearchQuery] = useState('')

    // Total matching the current filter (from the server), plus a flag for when
    // the range is so large we stopped short of loading all of it.
    const [ordersCount, setOrdersCount] = useState(0)
    const [isTruncated, setIsTruncated] = useState(false)

    // Settings state — defaults all networks to false until loaded from DB
    const [settings, setSettings] = useState<FulfillmentSettings>({
        is_global_enabled: true,
        networks: NETWORKS.reduce((acc, n) => ({ ...acc, [n]: false }), {}),
        codecraft_networks: NETWORKS.reduce((acc, n) => ({ ...acc, [n]: false }), {}),
        kingflexy_networks: NETWORKS.reduce((acc, n) => ({ ...acc, [n]: false }), {}),
        eazydata_networks: NETWORKS.reduce((acc, n) => ({ ...acc, [n]: false }), {}),
        agentportal_networks: NETWORKS.reduce((acc, n) => ({ ...acc, [n]: false }), {}),
        netpulse_networks: NETWORKS.reduce((acc, n) => ({ ...acc, [n]: false }), {}),
        hendylinks_networks: NETWORKS.reduce((acc, n) => ({ ...acc, [n]: false }), {})
    })
    const [isSavingSettings, setIsSavingSettings] = useState(false)

    // Balance state
    const [balance, setBalance] = useState<{ amount: number; currency: string } | null>(null)
    const [codecraftBalance, setCodecraftBalance] = useState<{ amount: number; currency: string } | null>(null)
    const [kingflexyBalance, setKingflexyBalance] = useState<{ amount: number; currency: string } | null>(null)
    const [eazydataBalance, setEazydataBalance] = useState<{ amount: number; currency: string } | null>(null)
    const [agentportalBalance, setAgentportalBalance] = useState<{ amount: number; currency: string } | null>(null)
    const [netpulseBalance, setNetpulseBalance] = useState<{ amount: number; currency: string } | null>(null)
    const [hendylinksBalance, setHendylinksBalance] = useState<{ amount: number; currency: string } | null>(null)
    const [isLoadingBalance, setIsLoadingBalance] = useState(false)
    // Per-supplier failure reason, keyed by the API prefix ('agentportal', ...; 'dakazina'
    // for the unprefixed one). Set when a supplier's balance call failed, so the card can
    // say "Unavailable — <reason>" instead of a misleading GHS 0.00.
    const [balanceErrors, setBalanceErrors] = useState<Record<string, string>>({})

    // Sync CodeCraft Status state
    const [isSyncing, setIsSyncing] = useState(false)
    const [syncCooldown, setSyncCooldown] = useState(false)

    // Sync Dakazina Status state
    const [isSyncingDakazina, setIsSyncingDakazina] = useState(false)
    const [dakazinaSyncCooldown, setDakazinaSyncCooldown] = useState(false)

    // Sync KingFlexy Status state
    const [isSyncingKingFlexy, setIsSyncingKingFlexy] = useState(false)
    const [kingflexySyncCooldown, setKingflexySyncCooldown] = useState(false)

    // Sync EazyData Status state
    const [isSyncingEazyData, setIsSyncingEazyData] = useState(false)
    const [eazydataSyncCooldown, setEazydataSyncCooldown] = useState(false)

    // Sync NetPulse Status state
    const [isSyncingNetPulse, setIsSyncingNetPulse] = useState(false)
    const [netpulseSyncCooldown, setNetpulseSyncCooldown] = useState(false)

    // Sync HendyLinks Status state
    const [isSyncingHendyLinks, setIsSyncingHendyLinks] = useState(false)
    const [hendylinksSyncCooldown, setHendylinksSyncCooldown] = useState(false)

    // Cron Settings state
    const [cronRefulfillEnabled, setCronRefulfillEnabled] = useState(false)
    const [cronRefulfillDelay, setCronRefulfillDelay] = useState('5')
    const [cronAutoCompleteEnabled, setCronAutoCompleteEnabled] = useState(false)
    const [cronAutoCompleteDelay, setCronAutoCompleteDelay] = useState('30')
    const [isSavingCronSettings, setIsSavingCronSettings] = useState(false)

    // MTN registration gate — refuses orders to unregistered MTN numbers on storefronts
    // and USSD only. The dashboard and the API are not gated at all.
    // Off unless the DB says otherwise.
    const [mtnGateEnabled, setMtnGateEnabled] = useState(false)
    const [isSavingMtnGate, setIsSavingMtnGate] = useState(false)

    useEffect(() => {
        if (dbUser?.role === 'admin') {
            fetchSettings()
            fetchBalance()
        }
    }, [dbUser])

    /**
     * Search only reaches the fetch once typing stops.
     *
     * Every keystroke used to start its own paginated walk. The early ones are
     * the broad ones — a single "0" matches almost every row, so that walk pages
     * through up to MAX_ORDERS_LOADED orders while the full number comes back in
     * one request. The broad walk therefore finished LAST and overwrote the
     * narrow result, leaving the table showing matches for the first character
     * typed. It looked like the search box did nothing.
     */
    const [debouncedSearch, setDebouncedSearch] = useState('')
    useEffect(() => {
        const timer = setTimeout(() => setDebouncedSearch(searchQuery), 350)
        return () => clearTimeout(timer)
    }, [searchQuery])

    /** Which fetchOrders walk owns the table, and the one still on the wire. */
    const fetchSeq = useRef(0)
    const inFlight = useRef<AbortController | null>(null)

    // Reset when filters change
    useEffect(() => {
        fetchOrders(true)
    }, [networkFilter, statusFilter, dateFilter, customDate, debouncedSearch]) // eslint-disable-line react-hooks/exhaustive-deps

    // Determine Date Range
    const getDateRange = () => {
        const now = new Date()
        let start: Date | null = null
        let end: Date | null = null

        if (dateFilter === 'today') {
            start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
            end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999)
        } else if (dateFilter === 'yesterday') {
            start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
            end = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 23, 59, 59, 999)
        } else if (dateFilter === 'week') {
            const day = now.getDay() || 7 // Get current day number, converting Sun (0) to 7
            if (day !== 1) now.setHours(-24 * (day - 1)) // Set to Monday of this week
            start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
            end = new Date() // Up to now
        } else if (dateFilter === 'month') {
            start = new Date(now.getFullYear(), now.getMonth(), 1)
            end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999)
        } else if (dateFilter === 'last30') {
            // A rolling window, deliberately NOT the calendar month. On the 1st
            // "This Month" is hours old and legitimately empty, which reads as a
            // broken page; this always spans real trading. Kept separate so the
            // Total Cost tile under "This Month" still reconciles month-end.
            start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29)
            end = new Date() // up to now
        } else if (dateFilter === 'custom' && customDate) {
            // customDate is YYYY-MM-DD string
            const dateParts = customDate.split('-').map(Number)
            // Create date in local time (months are 0-indexed)
            start = new Date(dateParts[0], dateParts[1] - 1, dateParts[2])
            end = new Date(dateParts[0], dateParts[1] - 1, dateParts[2], 23, 59, 59, 999)
        }

        return { start, end }
    }

    const dateRangeLabel = () => {
        if (dateFilter === 'today') return "Today"
        if (dateFilter === 'yesterday') return "Yesterday"
        if (dateFilter === 'week') return "This Week"
        if (dateFilter === 'month') return "This Month"
        if (dateFilter === 'last30') return "Last 30 Days"
        if (dateFilter === 'custom') return customDate || "Custom"
        return "All Time"
    }

    const fetchSettings = async () => {
        try {
            const { data } = await supabase
                .from('admin_settings')
                .select('key, value')
                .in('key', [
                    'auto_fulfillment_enabled',
                    'fulfillment_settings',
                    'cron_auto_refulfill_enabled',
                    'cron_auto_refulfill_delay_minutes',
                    'cron_auto_complete_enabled',
                    'cron_auto_complete_delay_minutes',
                    'mtn_registration_gate_enabled',
                ])

            const map = (data || []).reduce((acc: any, curr: any) => {
                acc[curr.key] = curr.value
                return acc
            }, {})

            const dbFulfillmentSettings = typeof map.fulfillment_settings === 'string'
                ? JSON.parse(map.fulfillment_settings)
                : map.fulfillment_settings || {}

            const dbNetworks: Record<string, boolean> = dbFulfillmentSettings.networks || {}
            const dbCodecraftNetworks: Record<string, boolean> = dbFulfillmentSettings.codecraft_networks || {}
            const dbKingflexyNetworks: Record<string, boolean> = dbFulfillmentSettings.kingflexy_networks || {}
            const dbEazydataNetworks: Record<string, boolean> = dbFulfillmentSettings.eazydata_networks || {}
            const dbAgentportalNetworks: Record<string, boolean> = dbFulfillmentSettings.agentportal_networks || {}
            const dbNetpulseNetworks: Record<string, boolean> = dbFulfillmentSettings.netpulse_networks || {}
            const dbHendylinksNetworks: Record<string, boolean> = dbFulfillmentSettings.hendylinks_networks || {}

            setSettings({
                is_global_enabled: String(map.auto_fulfillment_enabled) !== 'false',
                networks: NETWORKS.reduce((acc, n) => ({
                    ...acc,
                    [n]: dbNetworks[n] === true
                }), {} as Record<string, boolean>),
                codecraft_networks: NETWORKS.reduce((acc, n) => ({
                    ...acc,
                    [n]: dbCodecraftNetworks[n] === true
                }), {} as Record<string, boolean>),
                kingflexy_networks: NETWORKS.reduce((acc, n) => ({
                    ...acc,
                    [n]: dbKingflexyNetworks[n] === true
                }), {} as Record<string, boolean>),
                eazydata_networks: NETWORKS.reduce((acc, n) => ({
                    ...acc,
                    [n]: dbEazydataNetworks[n] === true
                }), {} as Record<string, boolean>),
                agentportal_networks: NETWORKS.reduce((acc, n) => ({
                    ...acc,
                    [n]: dbAgentportalNetworks[n] === true
                }), {} as Record<string, boolean>),
                netpulse_networks: NETWORKS.reduce((acc, n) => ({
                    ...acc,
                    [n]: dbNetpulseNetworks[n] === true
                }), {} as Record<string, boolean>),
                hendylinks_networks: NETWORKS.reduce((acc, n) => ({
                    ...acc,
                    [n]: dbHendylinksNetworks[n] === true
                }), {} as Record<string, boolean>)
            })

            // Load cron settings
            setCronRefulfillEnabled(map.cron_auto_refulfill_enabled === 'true')
            setCronRefulfillDelay(map.cron_auto_refulfill_delay_minutes || '5')
            setCronAutoCompleteEnabled(map.cron_auto_complete_enabled === 'true')
            setCronAutoCompleteDelay(map.cron_auto_complete_delay_minutes || '30')
            setMtnGateEnabled(map.mtn_registration_gate_enabled === 'true')
        } catch (error) {
            console.error('Failed to fetch settings:', error)
        }
    }

    const saveCronSettings = async () => {
        setIsSavingCronSettings(true)
        try {
            const delayRef = Math.max(1, parseInt(cronRefulfillDelay) || 5)
            const delayComplete = Math.max(1, parseInt(cronAutoCompleteDelay) || 30)
            const updates = [
                { key: 'cron_auto_refulfill_enabled', value: String(cronRefulfillEnabled) },
                { key: 'cron_auto_refulfill_delay_minutes', value: String(delayRef) },
                { key: 'cron_auto_complete_enabled', value: String(cronAutoCompleteEnabled) },
                { key: 'cron_auto_complete_delay_minutes', value: String(delayComplete) },
            ]
            const { error } = await (supabase.from('admin_settings') as any).upsert(updates)
            if (error) throw error
            toast.success('Cron settings saved')
        } catch (error: any) {
            toast.error('Failed to save cron settings: ' + error.message)
        } finally {
            setIsSavingCronSettings(false)
        }
    }

    // Saves immediately on toggle. Optimistic, with a rollback on failure — an admin
    // must never be left believing this switch is off when the DB still says on.
    const saveMtnGateSetting = async (enabled: boolean) => {
        const previous = mtnGateEnabled
        setMtnGateEnabled(enabled)
        setIsSavingMtnGate(true)
        try {
            const { error } = await (supabase.from('admin_settings') as any)
                .upsert([{ key: 'mtn_registration_gate_enabled', value: String(enabled) }])
            if (error) throw error
            toast.success(enabled
                ? 'Unregistered MTN numbers are now refused on storefronts and USSD'
                : 'MTN registration check turned off')
        } catch (error: any) {
            setMtnGateEnabled(previous)
            toast.error('Failed to save setting: ' + error.message)
        } finally {
            setIsSavingMtnGate(false)
        }
    }

    const saveSettings = async (newSettings: FulfillmentSettings) => {
        setIsSavingSettings(true)
        try {
            const updates = [
                { key: 'auto_fulfillment_enabled', value: String(newSettings.is_global_enabled) },
                { key: 'fulfillment_settings', value: JSON.stringify({ networks: newSettings.networks, codecraft_networks: newSettings.codecraft_networks, kingflexy_networks: newSettings.kingflexy_networks, eazydata_networks: newSettings.eazydata_networks, agentportal_networks: newSettings.agentportal_networks, netpulse_networks: newSettings.netpulse_networks, hendylinks_networks: newSettings.hendylinks_networks }) }
            ]

            const { error } = await (supabase
                .from('admin_settings') as any)
                .upsert(updates)

            if (error) throw error
            setSettings(newSettings)
            toast.success('Fulfillment settings updated')
        } catch (error: any) {
            toast.error('Failed to save settings: ' + error.message)
        } finally {
            setIsSavingSettings(false)
        }
    }

    const toggleNetwork = (network: string, provider: SupplierId) => {
        const targetKey = SUPPLIER_KEYS[provider]
        const isCurrentlyEnabled = settings[targetKey][network] === true

        const newSettings = { ...settings }
        newSettings[targetKey] = { ...settings[targetKey], [network]: !isCurrentlyEnabled }

        // Turning a supplier ON for this network switches every other one OFF,
        // so the dispatcher's conflict guard can never trip.
        if (!isCurrentlyEnabled) {
            for (const key of Object.values(SUPPLIER_KEYS)) {
                if (key === targetKey) continue
                newSettings[key] = { ...settings[key], [network]: false }
            }
        }
        saveSettings(newSettings)
    }

    const toggleGlobal = () => {
        const newSettings = {
            ...settings,
            is_global_enabled: !settings.is_global_enabled
        }
        saveSettings(newSettings)
    }




    const handleSyncCodecraft = async () => {
        if (isSyncing || syncCooldown) return
        setIsSyncing(true)
        try {
            const response = await fetch('/api/admin/fulfillment/sync-codecraft', {
                method: 'POST',
            })
            const result = await response.json()
            if (!response.ok) {
                toast.error('Sync failed: ' + (result.error || 'Unknown error'))
            } else {
                toast.success(`${result.checked} checked, ${result.updated} updated, ${result.failed} failed`)
                await fetchOrders()
            }
        } catch (err: any) {
            toast.error('Sync error: ' + err.message)
        } finally {
            setIsSyncing(false)
            setSyncCooldown(true)
            setTimeout(() => setSyncCooldown(false), 30000)
        }
    }

    const handleSyncDakazina = async () => {
        if (isSyncingDakazina || dakazinaSyncCooldown) return
        setIsSyncingDakazina(true)
        try {
            const response = await fetch('/api/admin/fulfillment/sync-dakazina', {
                method: 'POST',
            })
            const result = await response.json()
            if (!response.ok) {
                toast.error('Sync failed: ' + (result.error || 'Unknown error'))
            } else {
                toast.success(`${result.checked} checked, ${result.updated} updated, ${result.failed} failed`)
                await fetchOrders(true)
            }
        } catch (err: any) {
            toast.error('Sync error: ' + err.message)
        } finally {
            setIsSyncingDakazina(false)
            setDakazinaSyncCooldown(true)
            setTimeout(() => setDakazinaSyncCooldown(false), 30000)
        }
    }

    const fetchOrders = async (isNewFilter = false) => {
        // Only the newest walk may touch state. Debouncing thins the requests
        // out but does not order them: a broad search still outruns a narrow one
        // typed after it, and whichever lands last would otherwise win.
        const seq = ++fetchSeq.current
        inFlight.current?.abort()
        const controller = new AbortController()
        inFlight.current = controller

        setIsLoadingOrders(true)
        try {
            const { start, end } = getDateRange()

            let url = `/api/admin/fulfillment?network=${networkFilter}&status=${statusFilter}&limit=${FETCH_CHUNK}`
            if (start) url += `&startDate=${start.toISOString()}`
            if (end) url += `&endDate=${end.toISOString()}`
            if (debouncedSearch) url += `&search=${encodeURIComponent(debouncedSearch)}`

            // The API returns one page at a time. Walk every page of the range so
            // the stat tiles and the Total Cost cover the whole day rather than
            // whatever happened to fit in the first batch.
            const collected: Order[] = []
            const seen = new Set<string>()
            let total = 0
            let truncated = false
            let fetched = 0

            while (true) {
                const response = await fetch(`${url}&offset=${fetched}`, { signal: controller.signal })
                if (!response.ok) {
                    const errorData = await response.json()
                    throw new Error(errorData.error || 'Failed to fetch orders')
                }

                const data = await response.json()
                const batch: Order[] = data.orders || []
                fetched += batch.length
                // Newest-first paging shifts rows down when an order lands mid-walk,
                // so the same id can come back on the next page.
                for (const order of batch) {
                    if (seen.has(order.id)) continue
                    seen.add(order.id)
                    collected.push(order)
                }
                total = typeof data.total === 'number' ? data.total : collected.length

                if (batch.length === 0 || !data.hasMore) break
                if (fetched >= MAX_ORDERS_LOADED) {
                    truncated = true
                    break
                }
            }

            if (seq !== fetchSeq.current) return // a newer search has taken over

            setOrders(collected)
            setOrdersCount(total || collected.length)
            setIsTruncated(truncated)
        } catch (error: any) {
            // Superseded by a newer search — expected, not a failure to report.
            if (error?.name === 'AbortError') return
            console.error('Fetch orders error:', error)
            toast.error('Failed to fetch orders: ' + error.message)
        } finally {
            // Leave the spinner to whichever walk is still current.
            if (seq === fetchSeq.current) setIsLoadingOrders(false)
        }
    }

    const fetchBalance = async () => {
        setIsLoadingBalance(true)
        try {
            const response = await fetch('/api/admin/fulfillment/balance')
            if (!response.ok) {
                const error = await response.json()
                throw new Error(error.error || 'Failed to fetch balance')
            }

            const data = await response.json()

            // A supplier that failed comes back as `<prefix>_error` with no balance —
            // clear its card rather than leaving a stale figure on screen.
            const errors: Record<string, string> = {}
            const apply = (
                prefix: string,
                setter: (v: { amount: number; currency: string } | null) => void
            ) => {
                const balanceKey = prefix === 'dakazina' ? 'balance' : `${prefix}_balance`
                const currencyKey = prefix === 'dakazina' ? 'currency' : `${prefix}_currency`
                const errorKey = `${prefix}_error`
                if (data[currencyKey] !== undefined) {
                    setter({ amount: data[balanceKey], currency: data[currencyKey] })
                } else if (data[errorKey]) {
                    errors[prefix] = String(data[errorKey])
                    setter(null)
                }
            }

            apply('dakazina', setBalance)
            apply('codecraft', setCodecraftBalance)
            apply('kingflexy', setKingflexyBalance)
            apply('eazydata', setEazydataBalance)
            apply('agentportal', setAgentportalBalance)
            apply('netpulse', setNetpulseBalance)
            apply('hendylinks', setHendylinksBalance)

            setBalanceErrors(errors)
            const failed = Object.keys(errors)
            if (failed.length > 0) {
                toast.error(`Balance unavailable for: ${failed.join(', ')}`)
            }
        } catch (error: any) {
            console.error('Balance fetch error:', error)
            toast.error('Failed to fetch supplier balance')
        } finally {
            setIsLoadingBalance(false)
        }
    }

    // Renders a supplier balance figure, or the reason it couldn't be read. Never falls
    // back to "GHS 0.00" on failure — that reads as an empty wallet and hides the cause.
    const renderBalance = (prefix: string, value: { amount: number; currency: string } | null) => {
        if (value) {
            return <span>{`${value.currency} ${value.amount.toFixed(2)}`}</span>
        }
        if (isLoadingBalance) {
            return <span>Loading...</span>
        }
        const error = balanceErrors[prefix]
        if (error) {
            return (
                <span className="flex flex-col">
                    <span className="text-lg md:text-xl">Unavailable</span>
                    <span className="text-[10px] font-medium opacity-90 normal-case">{error}</span>
                </span>
            )
        }
        return <span>&mdash;</span>
    }

    const handleSyncKingFlexy = async () => {
        if (isSyncingKingFlexy || kingflexySyncCooldown) return
        setIsSyncingKingFlexy(true)
        try {
            const response = await fetch('/api/admin/fulfillment/sync-kingflexy', {
                method: 'POST',
            })
            const result = await response.json()
            if (!response.ok) {
                toast.error('Sync failed: ' + (result.error || 'Unknown error'))
            } else {
                toast.success(`${result.checked} checked, ${result.updated} updated, ${result.failed} failed`)
                await fetchOrders(true)
            }
        } catch (err: any) {
            toast.error('Sync error: ' + err.message)
        } finally {
            setIsSyncingKingFlexy(false)
            setKingflexySyncCooldown(true)
            setTimeout(() => setKingflexySyncCooldown(false), 30000)
        }
    }

    const handleSyncNetPulse = async () => {
        if (isSyncingNetPulse || netpulseSyncCooldown) return
        setIsSyncingNetPulse(true)
        try {
            const response = await fetch('/api/admin/fulfillment/sync-netpulse', {
                method: 'POST',
            })
            const result = await response.json()
            if (!response.ok) {
                toast.error('Sync failed: ' + (result.error || 'Unknown error'))
            } else {
                toast.success(`${result.checked} checked, ${result.updated} updated, ${result.failed} failed`)
                await fetchOrders(true)
            }
        } catch (err: any) {
            toast.error('Sync error: ' + err.message)
        } finally {
            setIsSyncingNetPulse(false)
            setNetpulseSyncCooldown(true)
            setTimeout(() => setNetpulseSyncCooldown(false), 30000)
        }
    }

    const handleSyncHendyLinks = async () => {
        if (isSyncingHendyLinks || hendylinksSyncCooldown) return
        setIsSyncingHendyLinks(true)
        try {
            const response = await fetch('/api/admin/fulfillment/sync-hendylinks', {
                method: 'POST',
            })
            const result = await response.json()
            if (!response.ok) {
                toast.error('Sync failed: ' + (result.error || 'Unknown error'))
            } else {
                toast.success(`${result.checked} checked, ${result.updated} updated, ${result.failed} failed`)
                await fetchOrders(true)
            }
        } catch (err: any) {
            toast.error('Sync error: ' + err.message)
        } finally {
            setIsSyncingHendyLinks(false)
            setHendylinksSyncCooldown(true)
            setTimeout(() => setHendylinksSyncCooldown(false), 30000)
        }
    }

    const handleSyncEazyData = async () => {
        if (isSyncingEazyData || eazydataSyncCooldown) return
        setIsSyncingEazyData(true)
        try {
            const response = await fetch('/api/admin/fulfillment/sync-eazydata', {
                method: 'POST',
            })
            const result = await response.json()
            if (!response.ok) {
                toast.error('Sync failed: ' + (result.error || 'Unknown error'))
            } else {
                toast.success(`${result.checked} checked, ${result.updated} updated, ${result.failed} failed`)
                await fetchOrders(true)
            }
        } catch (err: any) {
            toast.error('Sync error: ' + err.message)
        } finally {
            setIsSyncingEazyData(false)
            setEazydataSyncCooldown(true)
            setTimeout(() => setEazydataSyncCooldown(false), 30000)
        }
    }

    // `supplierStatus` carries the in-flight sub-state (only "verifying" today).
    // It is deliberately separate from `newStatus`: a held order is still
    // 'processing' as far as filters, stats and the crons are concerned.
    const bulkUpdateStatus = async (
        newStatus: 'completed' | 'failed' | 'processing' | 'pending',
        supplierStatus?: string
    ) => {
        if (selectedOrders.size === 0) {
            toast.error('No orders selected')
            return
        }

        setIsUpdating(true)
        try {
            const orderIds = Array.from(selectedOrders)
            const response = await fetch('/api/admin/orders/update-status', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ orderIds, status: newStatus, supplierStatus: supplierStatus ?? null }),
            })

            const data = await response.json()
            if (!response.ok) throw new Error(data.error || 'Update failed')

            toast.success(`${orderIds.length} order(s) marked as ${supplierStatus || newStatus}`)
            setSelectedOrders(new Set())

            // Re-fetch current view
            await fetchOrders(true)
        } catch (error: any) {
            toast.error('Update failed: ' + error.message)
        } finally {
            setIsUpdating(false)
        }
    }

    const handleRefund = async (order: Order) => {
        if (order.payment_status === 'refunded') return
        if (!confirm(`Refund GHS ${Number(order.price).toFixed(2)} to ${order.users?.first_name || 'this user'} for ${order.network} ${order.size} (${order.phone_number})? This credits their wallet.`)) return

        setRefundingId(order.id)
        try {
            const response = await fetch('/api/admin/orders/refund', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ orderId: order.id }),
            })

            const data = await response.json()
            if (!response.ok) throw new Error(data.error || 'Refund failed')

            toast.success('Order refunded successfully')
            // Reflect the new state locally (refund sets status='failed' + payment_status='refunded')
            setOrders(prev => prev.map(o => o.id === order.id ? { ...o, status: 'failed', payment_status: 'refunded' } : o))
        } catch (error: any) {
            toast.error('Refund failed: ' + error.message)
        } finally {
            setRefundingId(null)
        }
    }

    const refulfillPending = async (useSelection = false) => {
        setIsRefulfilling(true)
        try {
            const payload = useSelection && selectedOrders.size > 0
                ? { orderIds: Array.from(selectedOrders) }
                : {}

            const response = await fetch('/api/admin/fulfillment/refulfill', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            })

            const data = await response.json()
            if (!response.ok) throw new Error(data.error || 'Refulfillment failed')

            // `remaining` > 0 means the route ran out of time and deliberately stopped —
            // say so, otherwise a partial run looks like it quietly ignored the rest.
            const summary = `${data.fulfilled} processing, ${data.skipped} skipped, ${data.failed} failed/reverted`
            if (data.remaining > 0) {
                toast.warning(`Refulfillment partial: ${summary}. ${data.remaining} left — run it again.`)
            } else {
                toast.success(`Refulfillment complete: ${summary}`)
            }
            if (useSelection) setSelectedOrders(new Set())

            // Re-fetch current view
            await fetchOrders(true)
        } catch (error: any) {
            toast.error('Refulfillment failed: ' + error.message)
        } finally {
            setIsRefulfilling(false)
        }
    }

    if (dbUser?.role !== 'admin') {
        return (
            <div className="flex flex-col items-center justify-center h-[60vh]">
                <Activity className="w-12 h-12 text-destructive mb-4" />
                <h1 className="text-2xl font-bold">Access Denied</h1>
                <p className="text-muted-foreground">Admin privileges required.</p>
            </div>
        )
    }

    // Unfinished orders now come back regardless of age — see the open/closed
    // split in /api/admin/fulfillment. Money has to re-apply the window here, or
    // "This Month" would quietly absorb every stuck order from earlier months and
    // stop matching what the period is reconciled against.
    const { start: rangeStart, end: rangeEnd } = getDateRange()
    const isInRange = (order: Order) => {
        if (!rangeStart && !rangeEnd) return true
        const at = new Date(order.created_at).getTime()
        if (rangeStart && at < rangeStart.getTime()) return false
        if (rangeEnd && at > rangeEnd.getTime()) return false
        return true
    }
    const rangeCost = orders.reduce((acc, o) => (isInRange(o) ? acc + (o.price || 0) : acc), 0)
    const carriedOver = orders.filter(o => !isInRange(o)).length

    return (
        <div className="px-2 py-4 md:p-8 max-w-[1400px] mx-auto space-y-6">
            {/* Header Section */}
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div>
                    <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight">Fulfillment Center</h1>
                    <p className="text-xs md:text-sm text-muted-foreground">Manage multi-network automated and manual order processing</p>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                    <Button
                        onClick={() => refulfillPending(false)}
                        disabled={isRefulfilling || orders.filter(o => o.status === 'pending').length === 0}
                        className="bg-indigo-600 hover:bg-indigo-700 text-white font-bold h-9 md:h-10 text-xs md:text-sm px-3 md:px-4"
                    >
                        {isRefulfilling ? (
                            <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                        ) : (
                            <RotateCcw className="w-4 h-4 mr-2" />
                        )}
                        Refulfill All Pending
                    </Button>
                    <Button onClick={() => fetchOrders(true)} disabled={isLoadingOrders} variant="outline" size="sm" className="h-9 md:h-10 text-xs md:text-sm">
                        <RefreshCw className={`w-4 h-4 mr-2 ${isLoadingOrders ? 'animate-spin' : ''}`} />
                        Refresh
                    </Button>
                    <div className="flex items-center gap-2 bg-background border px-3 h-9 md:h-10 rounded-full shadow-sm">
                        <span className="text-[10px] md:text-xs font-semibold">Auto-Fulfillment</span>
                        <Switch checked={settings.is_global_enabled} onCheckedChange={toggleGlobal} disabled={isSavingSettings} className="scale-75 md:scale-90" />
                    </div>
                </div>
            </div>

            {/* Supplier Balances */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Card className="bg-gradient-to-br from-emerald-600 to-emerald-800 text-white border-none shadow-lg">
                    <CardContent className="p-4 md:p-5">
                        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                            <div className="flex items-center gap-3">
                                <div className="bg-white/20 p-2.5 rounded-lg">
                                    <Server className="w-5 h-5 md:w-6 md:h-6" />
                                </div>
                                <div>
                                    <p className="text-[10px] md:text-xs font-bold uppercase tracking-wider opacity-90">DataKazina Balance</p>
                                    <p className="text-2xl md:text-3xl font-black">
                                        {renderBalance('dakazina', balance)}
                                    </p>
                                </div>
                            </div>
                            <Button
                                onClick={fetchBalance}
                                disabled={isLoadingBalance}
                                variant="secondary"
                                size="sm"
                                className="bg-white/20 hover:bg-white/30 text-white border-white/30"
                            >
                                <RefreshCw className={`w-4 h-4 mr-2 ${isLoadingBalance ? 'animate-spin' : ''}`} />
                                Refresh
                            </Button>
                        </div>
                    </CardContent>
                </Card>

                <Card className="bg-gradient-to-br from-blue-600 to-blue-800 text-white border-none shadow-lg">
                    <CardContent className="p-4 md:p-5">
                        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                            <div className="flex items-center gap-3">
                                <div className="bg-white/20 p-2.5 rounded-lg">
                                    <Server className="w-5 h-5 md:w-6 md:h-6" />
                                </div>
                                <div>
                                    <p className="text-[10px] md:text-xs font-bold uppercase tracking-wider opacity-90">CodeCraft Balance</p>
                                    <p className="text-2xl md:text-3xl font-black">
                                        {renderBalance('codecraft', codecraftBalance)}
                                    </p>
                                </div>
                            </div>
                            <Button
                                onClick={fetchBalance}
                                disabled={isLoadingBalance}
                                variant="secondary"
                                size="sm"
                                className="bg-white/20 hover:bg-white/30 text-white border-white/30"
                            >
                                <RefreshCw className={`w-4 h-4 mr-2 ${isLoadingBalance ? 'animate-spin' : ''}`} />
                                Refresh
                            </Button>
                        </div>
                    </CardContent>
                </Card>

                <Card className="bg-gradient-to-br from-violet-600 to-purple-800 text-white border-none shadow-lg">
                    <CardContent className="p-4 md:p-5">
                        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                            <div className="flex items-center gap-3">
                                <div className="bg-white/20 p-2.5 rounded-lg">
                                    <Server className="w-5 h-5 md:w-6 md:h-6" />
                                </div>
                                <div>
                                    <p className="text-[10px] md:text-xs font-bold uppercase tracking-wider opacity-90">KingFlexyGH Balance</p>
                                    <p className="text-2xl md:text-3xl font-black">
                                        {renderBalance('kingflexy', kingflexyBalance)}
                                    </p>
                                </div>
                            </div>
                            <Button
                                onClick={fetchBalance}
                                disabled={isLoadingBalance}
                                variant="secondary"
                                size="sm"
                                className="bg-white/20 hover:bg-white/30 text-white border-white/30"
                            >
                                <RefreshCw className={`w-4 h-4 mr-2 ${isLoadingBalance ? 'animate-spin' : ''}`} />
                                Refresh
                            </Button>
                        </div>
                    </CardContent>
                </Card>

                <Card className="bg-gradient-to-br from-rose-600 to-pink-800 text-white border-none shadow-lg">
                    <CardContent className="p-4 md:p-5">
                        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                            <div className="flex items-center gap-3">
                                <div className="bg-white/20 p-2.5 rounded-lg">
                                    <Server className="w-5 h-5 md:w-6 md:h-6" />
                                </div>
                                <div>
                                    <p className="text-[10px] md:text-xs font-bold uppercase tracking-wider opacity-90">Eazy Data Balance</p>
                                    <p className="text-2xl md:text-3xl font-black">
                                        {renderBalance('eazydata', eazydataBalance)}
                                    </p>
                                </div>
                            </div>
                            <Button
                                onClick={fetchBalance}
                                disabled={isLoadingBalance}
                                variant="secondary"
                                size="sm"
                                className="bg-white/20 hover:bg-white/30 text-white border-white/30"
                            >
                                <RefreshCw className={`w-4 h-4 mr-2 ${isLoadingBalance ? 'animate-spin' : ''}`} />
                                Refresh
                            </Button>
                        </div>
                    </CardContent>
                </Card>

                <Card className="bg-gradient-to-br from-amber-600 to-orange-800 text-white border-none shadow-lg">
                    <CardContent className="p-4 md:p-5">
                        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                            <div className="flex items-center gap-3">
                                <div className="bg-white/20 p-2.5 rounded-lg">
                                    <Server className="w-5 h-5 md:w-6 md:h-6" />
                                </div>
                                <div>
                                    <p className="text-[10px] md:text-xs font-bold uppercase tracking-wider opacity-90">Agent Portal Balance</p>
                                    <p className="text-2xl md:text-3xl font-black">
                                        {renderBalance('agentportal', agentportalBalance)}
                                    </p>
                                </div>
                            </div>
                            <Button
                                onClick={fetchBalance}
                                disabled={isLoadingBalance}
                                variant="secondary"
                                size="sm"
                                className="bg-white/20 hover:bg-white/30 text-white border-white/30"
                            >
                                <RefreshCw className={`w-4 h-4 mr-2 ${isLoadingBalance ? 'animate-spin' : ''}`} />
                                Refresh
                            </Button>
                        </div>
                    </CardContent>
                </Card>

                <Card className="bg-gradient-to-br from-cyan-600 to-sky-800 text-white border-none shadow-lg">
                    <CardContent className="p-4 md:p-5">
                        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                            <div className="flex items-center gap-3">
                                <div className="bg-white/20 p-2.5 rounded-lg">
                                    <Server className="w-5 h-5 md:w-6 md:h-6" />
                                </div>
                                <div>
                                    <p className="text-[10px] md:text-xs font-bold uppercase tracking-wider opacity-90">NetPulse Balance</p>
                                    <p className="text-2xl md:text-3xl font-black">
                                        {renderBalance('netpulse', netpulseBalance)}
                                    </p>
                                </div>
                            </div>
                            <Button
                                onClick={fetchBalance}
                                disabled={isLoadingBalance}
                                variant="secondary"
                                size="sm"
                                className="bg-white/20 hover:bg-white/30 text-white border-white/30"
                            >
                                <RefreshCw className={`w-4 h-4 mr-2 ${isLoadingBalance ? 'animate-spin' : ''}`} />
                                Refresh
                            </Button>
                        </div>
                    </CardContent>
                </Card>

                <Card className="bg-gradient-to-br from-teal-600 to-emerald-800 text-white border-none shadow-lg">
                    <CardContent className="p-4 md:p-5">
                        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                            <div className="flex items-center gap-3">
                                <div className="bg-white/20 p-2.5 rounded-lg">
                                    <Server className="w-5 h-5 md:w-6 md:h-6" />
                                </div>
                                <div>
                                    <p className="text-[10px] md:text-xs font-bold uppercase tracking-wider opacity-90">HendyLinks Balance</p>
                                    <p className="text-2xl md:text-3xl font-black">
                                        {renderBalance('hendylinks', hendylinksBalance)}
                                    </p>
                                </div>
                            </div>
                            <Button
                                onClick={fetchBalance}
                                disabled={isLoadingBalance}
                                variant="secondary"
                                size="sm"
                                className="bg-white/20 hover:bg-white/30 text-white border-white/30"
                            >
                                <RefreshCw className={`w-4 h-4 mr-2 ${isLoadingBalance ? 'animate-spin' : ''}`} />
                                Refresh
                            </Button>
                        </div>
                    </CardContent>
                </Card>

                <Card className="bg-gradient-to-br from-blue-700 to-indigo-800 text-white border-none shadow-lg">
                    <CardContent className="p-4 md:p-5 flex flex-col md:flex-row md:items-center justify-between gap-4">
                        <div className="flex items-center gap-3">
                            <div className="bg-white/20 p-2.5 rounded-lg">
                                <RefreshCw className="w-5 h-5 md:w-6 md:h-6" />
                            </div>
                            <div>
                                <p className="text-[10px] md:text-xs font-bold uppercase tracking-wider opacity-90">CodeCraft Status Sync</p>
                                <p className="text-xs text-white/70 mt-0.5">Pulls live status for all pending CodeCraft orders</p>
                            </div>
                        </div>
                        <Button
                            onClick={handleSyncCodecraft}
                            disabled={isSyncing || syncCooldown}
                            variant="secondary"
                            size="sm"
                            className="bg-white/20 hover:bg-white/30 text-white border-white/30 disabled:opacity-50"
                        >
                            {isSyncing
                                ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Syncing...</>
                                : syncCooldown
                                    ? <><RefreshCw className="w-4 h-4 mr-2" />Cooling down...</>
                                    : <><RefreshCw className="w-4 h-4 mr-2" />Sync CodeCraft Status</>
                            }
                        </Button>
                    </CardContent>
                </Card>

                <Card className="bg-gradient-to-br from-emerald-700 to-green-800 text-white border-none shadow-lg">
                    <CardContent className="p-4 md:p-5 flex flex-col md:flex-row md:items-center justify-between gap-4">
                        <div className="flex items-center gap-3">
                            <div className="bg-white/20 p-2.5 rounded-lg">
                                <RefreshCw className="w-5 h-5 md:w-6 md:h-6" />
                            </div>
                            <div>
                                <p className="text-[10px] md:text-xs font-bold uppercase tracking-wider opacity-90">DataKazina Status Sync</p>
                                <p className="text-xs text-white/70 mt-0.5">Pulls live status for pending DataKazina orders</p>
                            </div>
                        </div>
                        <Button
                            onClick={handleSyncDakazina}
                            disabled={isSyncingDakazina || dakazinaSyncCooldown}
                            variant="secondary"
                            size="sm"
                            className="bg-white/20 hover:bg-white/30 text-white border-white/30 disabled:opacity-50"
                        >
                            {isSyncingDakazina
                                ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Syncing...</>
                                : dakazinaSyncCooldown
                                    ? <><RefreshCw className="w-4 h-4 mr-2" />Cooling down...</>
                                    : <><RefreshCw className="w-4 h-4 mr-2" />Sync DataKazina Status</>
                            }
                        </Button>
                    </CardContent>
                </Card>

                <Card className="bg-gradient-to-br from-violet-700 to-purple-900 text-white border-none shadow-lg">
                    <CardContent className="p-4 md:p-5 flex flex-col md:flex-row md:items-center justify-between gap-4">
                        <div className="flex items-center gap-3">
                            <div className="bg-white/20 p-2.5 rounded-lg">
                                <RefreshCw className="w-5 h-5 md:w-6 md:h-6" />
                            </div>
                            <div>
                                <p className="text-[10px] md:text-xs font-bold uppercase tracking-wider opacity-90">KingFlexyGH Status Sync</p>
                                <p className="text-xs text-white/70 mt-0.5">Updates processing KingFlexy orders to completed or failed</p>
                            </div>
                        </div>
                        <Button
                            onClick={handleSyncKingFlexy}
                            disabled={isSyncingKingFlexy || kingflexySyncCooldown}
                            variant="secondary"
                            size="sm"
                            className="bg-white/20 hover:bg-white/30 text-white border-white/30 disabled:opacity-50"
                        >
                            {isSyncingKingFlexy
                                ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Syncing...</>
                                : kingflexySyncCooldown
                                    ? <><RefreshCw className="w-4 h-4 mr-2" />Cooling down...</>
                                    : <><RefreshCw className="w-4 h-4 mr-2" />Sync KingFlexy Status</>
                            }
                        </Button>
                    </CardContent>
                </Card>

                <Card className="bg-gradient-to-br from-rose-700 to-pink-900 text-white border-none shadow-lg">
                    <CardContent className="p-4 md:p-5 flex flex-col md:flex-row md:items-center justify-between gap-4">
                        <div className="flex items-center gap-3">
                            <div className="bg-white/20 p-2.5 rounded-lg">
                                <RefreshCw className="w-5 h-5 md:w-6 md:h-6" />
                            </div>
                            <div>
                                <p className="text-[10px] md:text-xs font-bold uppercase tracking-wider opacity-90">Eazy Data Status Sync</p>
                                <p className="text-xs text-white/70 mt-0.5">Updates processing Eazy Data orders to completed or failed</p>
                            </div>
                        </div>
                        <Button
                            onClick={handleSyncEazyData}
                            disabled={isSyncingEazyData || eazydataSyncCooldown}
                            variant="secondary"
                            size="sm"
                            className="bg-white/20 hover:bg-white/30 text-white border-white/30 disabled:opacity-50"
                        >
                            {isSyncingEazyData
                                ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Syncing...</>
                                : eazydataSyncCooldown
                                    ? <><RefreshCw className="w-4 h-4 mr-2" />Cooling down...</>
                                    : <><RefreshCw className="w-4 h-4 mr-2" />Sync Eazy Data Status</>
                            }
                        </Button>
                    </CardContent>
                </Card>

                <Card className="bg-gradient-to-br from-cyan-700 to-sky-900 text-white border-none shadow-lg">
                    <CardContent className="p-4 md:p-5 flex flex-col md:flex-row md:items-center justify-between gap-4">
                        <div className="flex items-center gap-3">
                            <div className="bg-white/20 p-2.5 rounded-lg">
                                <RefreshCw className="w-5 h-5 md:w-6 md:h-6" />
                            </div>
                            <div>
                                <p className="text-[10px] md:text-xs font-bold uppercase tracking-wider opacity-90">NetPulse Status Sync</p>
                                <p className="text-xs text-white/70 mt-0.5">Updates processing NetPulse orders to completed or failed</p>
                            </div>
                        </div>
                        <Button
                            onClick={handleSyncNetPulse}
                            disabled={isSyncingNetPulse || netpulseSyncCooldown}
                            variant="secondary"
                            size="sm"
                            className="bg-white/20 hover:bg-white/30 text-white border-white/30 disabled:opacity-50"
                        >
                            {isSyncingNetPulse
                                ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Syncing...</>
                                : netpulseSyncCooldown
                                    ? <><RefreshCw className="w-4 h-4 mr-2" />Cooling down...</>
                                    : <><RefreshCw className="w-4 h-4 mr-2" />Sync NetPulse Status</>
                            }
                        </Button>
                    </CardContent>
                </Card>

                <Card className="bg-gradient-to-br from-teal-700 to-emerald-900 text-white border-none shadow-lg">
                    <CardContent className="p-4 md:p-5 flex flex-col md:flex-row md:items-center justify-between gap-4">
                        <div className="flex items-center gap-3">
                            <div className="bg-white/20 p-2.5 rounded-lg">
                                <RefreshCw className="w-5 h-5 md:w-6 md:h-6" />
                            </div>
                            <div>
                                <p className="text-[10px] md:text-xs font-bold uppercase tracking-wider opacity-90">HendyLinks Status Sync</p>
                                <p className="text-xs text-white/70 mt-0.5">Fallback for orders the completion webhook missed</p>
                            </div>
                        </div>
                        <Button
                            onClick={handleSyncHendyLinks}
                            disabled={isSyncingHendyLinks || hendylinksSyncCooldown}
                            variant="secondary"
                            size="sm"
                            className="bg-white/20 hover:bg-white/30 text-white border-white/30 disabled:opacity-50"
                        >
                            {isSyncingHendyLinks
                                ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Syncing...</>
                                : hendylinksSyncCooldown
                                    ? <><RefreshCw className="w-4 h-4 mr-2" />Cooling down...</>
                                    : <><RefreshCw className="w-4 h-4 mr-2" />Sync HendyLinks Status</>
                            }
                        </Button>
                    </CardContent>
                </Card>
            </div>

            {/* Network Connections — Mutex Toggle System */}
            <div className="space-y-3">
                {/* DataKazina Row */}
                <div>
                    <div className="flex flex-col gap-2 mb-2">
                        <div className="flex items-center gap-2">
                            <Server className="w-3.5 h-3.5 text-emerald-500" />
                            <span className="text-xs font-bold uppercase tracking-wide text-emerald-700 dark:text-emerald-400">DataKazina Networks</span>
                            <span className="text-[10px] text-muted-foreground">(enabling a network here auto-disables CodeCraft for same network)</span>
                        </div>
                    </div>
                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4">
                        {NETWORKS.map(net => (
                            <Card key={`datakazina-${net}`} className={`border-l-4 transition-colors ${settings.networks[net] ? 'border-l-emerald-500' : 'border-l-gray-300 dark:border-l-gray-600'}`}>
                                <CardContent className="p-3 md:p-4">
                                    <div className="flex items-center justify-between mb-2">
                                        <div className="flex items-center gap-2">
                                            <Activity className={`w-3.5 h-3.5 ${settings.networks[net] ? 'text-emerald-500' : 'text-gray-400'}`} />
                                            <span className="font-semibold text-xs md:text-sm">{net}</span>
                                        </div>
                                        <Button
                                            id={`dk-toggle-${net}`}
                                            variant={settings.networks[net] ? 'outline' : 'default'}
                                            size="sm"
                                            className={`h-6 text-[10px] md:text-xs px-2 ${settings.networks[net] ? 'border-emerald-500 text-emerald-600' : ''}`}
                                            onClick={() => toggleNetwork(net, 'datakazina')}
                                            disabled={isSavingSettings}
                                        >
                                            {settings.networks[net] ? 'Disconnect' : 'Connect'}
                                        </Button>
                                    </div>
                                    <div className="text-[10px] text-muted-foreground flex items-center gap-1">
                                        <div className={`w-1.5 h-1.5 rounded-full ${settings.networks[net] ? 'bg-emerald-500' : 'bg-gray-300'}`} />
                                        <span className="font-bold text-emerald-600 dark:text-emerald-400">DataKazina</span>
                                        {settings.networks[net] && <span className="text-emerald-500 font-semibold">· Active</span>}
                                    </div>
                                </CardContent>
                            </Card>
                        ))}
                    </div>
                </div>

                {/* CodeCraft Row */}
                <div>
                    <div className="flex items-center gap-2 mb-2">
                        <Server className="w-3.5 h-3.5 text-blue-500" />
                        <span className="text-xs font-bold uppercase tracking-wide text-blue-700 dark:text-blue-400">CodeCraft Networks</span>
                        <span className="text-[10px] text-muted-foreground">(enabling a network here auto-disables DataKazina for same network)</span>
                    </div>
                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4">
                        {NETWORKS.map(net => (
                            <Card key={`codecraft-${net}`} className={`border-l-4 transition-colors ${settings.codecraft_networks[net] ? 'border-l-blue-500' : 'border-l-gray-300 dark:border-l-gray-600'}`}>
                                <CardContent className="p-3 md:p-4">
                                    <div className="flex items-center justify-between mb-2">
                                        <div className="flex items-center gap-2">
                                            <Activity className={`w-3.5 h-3.5 ${settings.codecraft_networks[net] ? 'text-blue-500' : 'text-gray-400'}`} />
                                            <span className="font-semibold text-xs md:text-sm">{net}</span>
                                        </div>
                                        <Button
                                            id={`cc-toggle-${net}`}
                                            variant={settings.codecraft_networks[net] ? 'outline' : 'default'}
                                            size="sm"
                                            className={`h-6 text-[10px] md:text-xs px-2 ${settings.codecraft_networks[net] ? 'border-blue-500 text-blue-600' : ''}`}
                                            onClick={() => toggleNetwork(net, 'codecraft')}
                                            disabled={isSavingSettings}
                                        >
                                            {settings.codecraft_networks[net] ? 'Disconnect' : 'Connect'}
                                        </Button>
                                    </div>
                                    <div className="text-[10px] text-muted-foreground flex items-center gap-1">
                                        <div className={`w-1.5 h-1.5 rounded-full ${settings.codecraft_networks[net] ? 'bg-blue-500' : 'bg-gray-300'}`} />
                                        <span className="font-bold text-blue-600 dark:text-blue-400">CodeCraft</span>
                                        {settings.codecraft_networks[net] && <span className="text-blue-500 font-semibold">· Active</span>}
                                    </div>
                                </CardContent>
                            </Card>
                        ))}
                    </div>
                </div>

                {/* KingFlexyGH Row */}
                <div>
                    <div className="flex items-center gap-2 mb-2">
                        <Server className="w-3.5 h-3.5 text-violet-500" />
                        <span className="text-xs font-bold uppercase tracking-wide text-violet-700 dark:text-violet-400">KingFlexyGH Networks</span>
                        <span className="text-[10px] text-muted-foreground">(enabling a network here auto-disables DataKazina and CodeCraft for same network)</span>
                    </div>
                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4">
                        {NETWORKS.map(net => (
                            <Card key={`kingflexy-${net}`} className={`border-l-4 transition-colors ${settings.kingflexy_networks[net] ? 'border-l-violet-500' : 'border-l-gray-300 dark:border-l-gray-600'}`}>
                                <CardContent className="p-3 md:p-4">
                                    <div className="flex items-center justify-between mb-2">
                                        <div className="flex items-center gap-2">
                                            <Activity className={`w-3.5 h-3.5 ${settings.kingflexy_networks[net] ? 'text-violet-500' : 'text-gray-400'}`} />
                                            <span className="font-semibold text-xs md:text-sm">{net}</span>
                                        </div>
                                        <Button
                                            id={`kf-toggle-${net}`}
                                            variant={settings.kingflexy_networks[net] ? 'outline' : 'default'}
                                            size="sm"
                                            className={`h-6 text-[10px] md:text-xs px-2 ${settings.kingflexy_networks[net] ? 'border-violet-500 text-violet-600' : ''}`}
                                            onClick={() => toggleNetwork(net, 'kingflexy')}
                                            disabled={isSavingSettings}
                                        >
                                            {settings.kingflexy_networks[net] ? 'Disconnect' : 'Connect'}
                                        </Button>
                                    </div>
                                    <div className="text-[10px] text-muted-foreground flex items-center gap-1">
                                        <div className={`w-1.5 h-1.5 rounded-full ${settings.kingflexy_networks[net] ? 'bg-violet-500' : 'bg-gray-300'}`} />
                                        <span className="font-bold text-violet-600 dark:text-violet-400">KingFlexyGH</span>
                                        {settings.kingflexy_networks[net] && <span className="text-violet-500 font-semibold">· Active</span>}
                                    </div>
                                </CardContent>
                            </Card>
                        ))}
                    </div>
                </div>

                {/* Eazy Data Row */}
                <div>
                    <div className="flex items-center gap-2 mb-2">
                        <Server className="w-3.5 h-3.5 text-rose-500" />
                        <span className="text-xs font-bold uppercase tracking-wide text-rose-700 dark:text-rose-400">Eazy Data Networks</span>
                        <span className="text-[10px] text-muted-foreground">(enabling a network here auto-disables others for same network)</span>
                    </div>
                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4">
                        {NETWORKS.map(net => (
                            <Card key={`eazydata-${net}`} className={`border-l-4 transition-colors ${settings.eazydata_networks[net] ? 'border-l-rose-500' : 'border-l-gray-300 dark:border-l-gray-600'}`}>
                                <CardContent className="p-3 md:p-4">
                                    <div className="flex items-center justify-between mb-2">
                                        <div className="flex items-center gap-2">
                                            <Activity className={`w-3.5 h-3.5 ${settings.eazydata_networks[net] ? 'text-rose-500' : 'text-gray-400'}`} />
                                            <span className="font-semibold text-xs md:text-sm">{net}</span>
                                        </div>
                                        <Button
                                            id={`ed-toggle-${net}`}
                                            variant={settings.eazydata_networks[net] ? 'outline' : 'default'}
                                            size="sm"
                                            className={`h-6 text-[10px] md:text-xs px-2 ${settings.eazydata_networks[net] ? 'border-rose-500 text-rose-600' : ''}`}
                                            onClick={() => toggleNetwork(net, 'eazydata')}
                                            disabled={isSavingSettings}
                                        >
                                            {settings.eazydata_networks[net] ? 'Disconnect' : 'Connect'}
                                        </Button>
                                    </div>
                                    <div className="text-[10px] text-muted-foreground flex items-center gap-1">
                                        <div className={`w-1.5 h-1.5 rounded-full ${settings.eazydata_networks[net] ? 'bg-rose-500' : 'bg-gray-300'}`} />
                                        <span className="font-bold text-rose-600 dark:text-rose-400">Eazy Data</span>
                                        {settings.eazydata_networks[net] && <span className="text-rose-500 font-semibold">· Active</span>}
                                    </div>
                                </CardContent>
                            </Card>
                        ))}
                    </div>
                </div>

                {/* Agent Portal Row */}
                <div>
                    <div className="flex items-center gap-2 mb-2">
                        <Server className="w-3.5 h-3.5 text-amber-500" />
                        <span className="text-xs font-bold uppercase tracking-wide text-amber-700 dark:text-amber-400">Agent Portal Networks</span>
                        <span className="text-[10px] text-muted-foreground">(enabling a network here auto-disables others for same network)</span>
                    </div>
                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4">
                        {NETWORKS.map(net => (
                            <Card key={`agentportal-${net}`} className={`border-l-4 transition-colors ${settings.agentportal_networks[net] ? 'border-l-amber-500' : 'border-l-gray-300 dark:border-l-gray-600'}`}>
                                <CardContent className="p-3 md:p-4">
                                    <div className="flex items-center justify-between mb-2">
                                        <div className="flex items-center gap-2">
                                            <Activity className={`w-3.5 h-3.5 ${settings.agentportal_networks[net] ? 'text-amber-500' : 'text-gray-400'}`} />
                                            <span className="font-semibold text-xs md:text-sm">{net}</span>
                                        </div>
                                        <Button
                                            id={`ap-toggle-${net}`}
                                            variant={settings.agentportal_networks[net] ? 'outline' : 'default'}
                                            size="sm"
                                            className={`h-6 text-[10px] md:text-xs px-2 ${settings.agentportal_networks[net] ? 'border-amber-500 text-amber-600' : ''}`}
                                            onClick={() => toggleNetwork(net, 'agentportal')}
                                            disabled={isSavingSettings}
                                        >
                                            {settings.agentportal_networks[net] ? 'Disconnect' : 'Connect'}
                                        </Button>
                                    </div>
                                    <div className="text-[10px] text-muted-foreground flex items-center gap-1">
                                        <div className={`w-1.5 h-1.5 rounded-full ${settings.agentportal_networks[net] ? 'bg-amber-500' : 'bg-gray-300'}`} />
                                        <span className="font-bold text-amber-600 dark:text-amber-400">Agent Portal</span>
                                        {settings.agentportal_networks[net] && <span className="text-amber-500 font-semibold">· Active</span>}
                                    </div>
                                </CardContent>
                            </Card>
                        ))}
                    </div>
                </div>

                {/* NetPulse Row */}
                <div>
                    <div className="flex items-center gap-2 mb-2">
                        <Server className="w-3.5 h-3.5 text-cyan-500" />
                        <span className="text-xs font-bold uppercase tracking-wide text-cyan-700 dark:text-cyan-400">NetPulse Networks</span>
                        <span className="text-[10px] text-muted-foreground">(enabling a network here auto-disables others for same network)</span>
                    </div>
                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4">
                        {NETWORKS.map(net => (
                            <Card key={`netpulse-${net}`} className={`border-l-4 transition-colors ${settings.netpulse_networks[net] ? 'border-l-cyan-500' : 'border-l-gray-300 dark:border-l-gray-600'}`}>
                                <CardContent className="p-3 md:p-4">
                                    <div className="flex items-center justify-between mb-2">
                                        <div className="flex items-center gap-2">
                                            <Activity className={`w-3.5 h-3.5 ${settings.netpulse_networks[net] ? 'text-cyan-500' : 'text-gray-400'}`} />
                                            <span className="font-semibold text-xs md:text-sm">{net}</span>
                                        </div>
                                        <Button
                                            id={`np-toggle-${net}`}
                                            variant={settings.netpulse_networks[net] ? 'outline' : 'default'}
                                            size="sm"
                                            className={`h-6 text-[10px] md:text-xs px-2 ${settings.netpulse_networks[net] ? 'border-cyan-500 text-cyan-600' : ''}`}
                                            onClick={() => toggleNetwork(net, 'netpulse')}
                                            disabled={isSavingSettings}
                                        >
                                            {settings.netpulse_networks[net] ? 'Disconnect' : 'Connect'}
                                        </Button>
                                    </div>
                                    <div className="text-[10px] text-muted-foreground flex items-center gap-1">
                                        <div className={`w-1.5 h-1.5 rounded-full ${settings.netpulse_networks[net] ? 'bg-cyan-500' : 'bg-gray-300'}`} />
                                        <span className="font-bold text-cyan-600 dark:text-cyan-400">NetPulse</span>
                                        {settings.netpulse_networks[net] && <span className="text-cyan-500 font-semibold">· Active</span>}
                                    </div>
                                </CardContent>
                            </Card>
                        ))}
                    </div>
                </div>

                {/* HendyLinks Row */}
                <div>
                    <div className="flex items-center gap-2 mb-2">
                        <Server className="w-3.5 h-3.5 text-teal-500" />
                        <span className="text-xs font-bold uppercase tracking-wide text-teal-700 dark:text-teal-400">HendyLinks Networks</span>
                        <span className="text-[10px] text-muted-foreground">(enabling a network here auto-disables others for same network)</span>
                    </div>
                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4">
                        {NETWORKS.map(net => (
                            <Card key={`hendylinks-${net}`} className={`border-l-4 transition-colors ${settings.hendylinks_networks[net] ? 'border-l-teal-500' : 'border-l-gray-300 dark:border-l-gray-600'}`}>
                                <CardContent className="p-3 md:p-4">
                                    <div className="flex items-center justify-between mb-2">
                                        <div className="flex items-center gap-2">
                                            <Activity className={`w-3.5 h-3.5 ${settings.hendylinks_networks[net] ? 'text-teal-500' : 'text-gray-400'}`} />
                                            <span className="font-semibold text-xs md:text-sm">{net}</span>
                                        </div>
                                        <Button
                                            id={`hl-toggle-${net}`}
                                            variant={settings.hendylinks_networks[net] ? 'outline' : 'default'}
                                            size="sm"
                                            className={`h-6 text-[10px] md:text-xs px-2 ${settings.hendylinks_networks[net] ? 'border-teal-500 text-teal-600' : ''}`}
                                            onClick={() => toggleNetwork(net, 'hendylinks')}
                                            disabled={isSavingSettings}
                                        >
                                            {settings.hendylinks_networks[net] ? 'Disconnect' : 'Connect'}
                                        </Button>
                                    </div>
                                    <div className="text-[10px] text-muted-foreground flex items-center gap-1">
                                        <div className={`w-1.5 h-1.5 rounded-full ${settings.hendylinks_networks[net] ? 'bg-teal-500' : 'bg-gray-300'}`} />
                                        <span className="font-bold text-teal-600 dark:text-teal-400">HendyLinks</span>
                                        {settings.hendylinks_networks[net] && <span className="text-teal-500 font-semibold">· Active</span>}
                                    </div>
                                </CardContent>
                            </Card>
                        ))}
                    </div>
                </div>
            </div>

            {/* Cron Settings Card */}
            <Card className="border-2 border-dashed border-violet-300 dark:border-violet-800 bg-violet-50/50 dark:bg-violet-900/10">
                <CardHeader className="pb-3 pt-4 px-4">
                    <CardTitle className="text-sm font-bold flex items-center gap-2 text-violet-700 dark:text-violet-400">
                        <Clock className="w-4 h-4" /> Cron Job Settings
                        <span className="text-[10px] font-normal text-muted-foreground ml-1">(cron-job.org)</span>
                    </CardTitle>
                </CardHeader>
                <CardContent className="px-4 pb-4 space-y-5">
                    {/* Auto-Refulfill */}
                    <div className="flex flex-col sm:flex-row sm:items-center gap-3 p-3 bg-background rounded-xl border">
                        <div className="flex-1">
                            <p className="text-sm font-bold">⚡ Auto-Refulfill Pending Orders</p>
                            <p className="text-xs text-muted-foreground mt-0.5">Automatically retry pending data orders after the set delay. Respects global fulfillment on/off and active supplier.</p>
                        </div>
                        <div className="flex items-center gap-3 shrink-0">
                            <div className="flex items-center gap-2">
                                <label className="text-xs font-semibold text-muted-foreground whitespace-nowrap">Delay (min)</label>
                                <Input
                                    type="number"
                                    min="1"
                                    max="60"
                                    value={cronRefulfillDelay}
                                    onChange={e => setCronRefulfillDelay(e.target.value)}
                                    className="w-16 h-8 text-xs text-center"
                                    disabled={!cronRefulfillEnabled}
                                />
                            </div>
                            <Switch
                                checked={cronRefulfillEnabled}
                                onCheckedChange={setCronRefulfillEnabled}
                                id="cron-refulfill-toggle"
                            />
                            <label htmlFor="cron-refulfill-toggle" className="text-xs font-bold">
                                {cronRefulfillEnabled ? 'ON' : 'OFF'}
                            </label>
                        </div>
                    </div>

                    {/* Auto-Complete */}
                    <div className="flex flex-col sm:flex-row sm:items-center gap-3 p-3 bg-background rounded-xl border">
                        <div className="flex-1">
                            <p className="text-sm font-bold">✅ Auto-Complete Processing Orders</p>
                            <p className="text-xs text-muted-foreground mt-0.5">Mark processing orders as completed after the set delay (max 50 per run). Use for suppliers without webhooks.</p>
                        </div>
                        <div className="flex items-center gap-3 shrink-0">
                            <div className="flex items-center gap-2">
                                <label className="text-xs font-semibold text-muted-foreground whitespace-nowrap">Delay (min)</label>
                                <Input
                                    type="number"
                                    min="1"
                                    max="240"
                                    value={cronAutoCompleteDelay}
                                    onChange={e => setCronAutoCompleteDelay(e.target.value)}
                                    className="w-16 h-8 text-xs text-center"
                                    disabled={!cronAutoCompleteEnabled}
                                />
                            </div>
                            <Switch
                                checked={cronAutoCompleteEnabled}
                                onCheckedChange={setCronAutoCompleteEnabled}
                                id="cron-autocomplete-toggle"
                            />
                            <label htmlFor="cron-autocomplete-toggle" className="text-xs font-bold">
                                {cronAutoCompleteEnabled ? 'ON' : 'OFF'}
                            </label>
                        </div>
                    </div>

                    <Button
                        onClick={saveCronSettings}
                        disabled={isSavingCronSettings}
                        size="sm"
                        className="bg-violet-600 hover:bg-violet-700 text-white font-bold"
                    >
                        {isSavingCronSettings ? <><RefreshCw className="w-3.5 h-3.5 mr-2 animate-spin" />Saving...</> : 'Save Cron Settings'}
                    </Button>
                </CardContent>
            </Card>

            {/* MTN Registration Gate — saves on toggle, like the supplier switches above.
                This is a safety switch; it must not depend on remembering to hit Save. */}
            <Card className="border-2 border-dashed border-amber-300 dark:border-amber-800 bg-amber-50/50 dark:bg-amber-900/10">
                <CardHeader className="pb-3 pt-4 px-4">
                    <CardTitle className="text-sm font-bold flex items-center gap-2 text-amber-700 dark:text-amber-400">
                        <ShieldCheck className="w-4 h-4" /> MTN Number Registration
                    </CardTitle>
                </CardHeader>
                <CardContent className="px-4 pb-4">
                    <div className="flex flex-col sm:flex-row sm:items-center gap-3 p-3 bg-background rounded-xl border">
                        <div className="flex-1">
                            <p className="text-sm font-bold">🔒 Block Orders To Unregistered MTN Numbers</p>
                            <p className="text-xs text-muted-foreground mt-0.5">
                                When ON, an MTN number that isn&apos;t registered yet is <strong>refused outright on the
                                dashboard, shop storefronts and USSD</strong> — nothing is charged and no order is
                                created, and a bulk order is refused whole if any one number in it is unregistered.
                                This does not affect the developer API: those orders are never stopped, and they sit
                                pending until MTN enables the number. When OFF, every surface goes through silently.
                                Runs the Agent Portal registration check whichever supplier is
                                currently fulfilling MTN, so some sales your active supplier could have delivered will
                                be turned away instead. Note that checking a number also submits it for registration —
                                turning this off later does not undo that. Changes apply within a minute.
                            </p>
                        </div>
                        <div className="flex items-center gap-3 shrink-0">
                            <Switch
                                checked={mtnGateEnabled}
                                onCheckedChange={saveMtnGateSetting}
                                disabled={isSavingMtnGate}
                                id="mtn-reg-gate-toggle"
                            />
                            <label htmlFor="mtn-reg-gate-toggle" className="text-xs font-bold">
                                {isSavingMtnGate ? '...' : mtnGateEnabled ? 'ON' : 'OFF'}
                            </label>
                        </div>
                    </div>
                </CardContent>
            </Card>

            {/* Main Content Area */}
            <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
                {/* Left Column: Stats & Filters */}
                <div className="lg:col-span-1 space-y-4">
                    <Card>
                        <CardHeader className="pb-2 pt-4 px-4">
                            <CardTitle className="text-sm font-bold flex items-center gap-2">
                                <Filter className="w-4 h-4" /> Filters & Search
                            </CardTitle>
                        </CardHeader>
                        <CardContent className="px-4 pb-4 space-y-4">
                            {/* Search */}
                            <div className="relative">
                                <Search className="absolute left-2 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
                                <Input
                                    placeholder="Search Beneficiary..."
                                    value={searchQuery}
                                    onChange={(e) => setSearchQuery(e.target.value)}
                                    className="pl-8 text-xs h-8"
                                />
                            </div>

                            {/* Date Filter */}
                            <div className="space-y-1.5">
                                <label className="text-[10px] uppercase font-bold text-muted-foreground">Date Range</label>
                                <div className="grid grid-cols-2 md:grid-cols-1 gap-2">
                                    {[
                                        { id: 'today', label: 'Today' },
                                        { id: 'yesterday', label: 'Yesterday' },
                                        { id: 'week', label: 'This Week' },
                                        { id: 'month', label: 'This Month' },
                                        { id: 'last30', label: 'Last 30 Days' },
                                        { id: 'all', label: 'All Time' },
                                        { id: 'custom', label: 'Custom' }
                                    ].map(range => (
                                        <Button
                                            key={range.id}
                                            variant={dateFilter === range.id ? "default" : "outline"}
                                            size="sm"
                                            className="h-8 text-[11px] font-bold justify-start px-3"
                                            onClick={() => setDateFilter(range.id)}
                                        >
                                            <CalendarIcon className="w-3.5 h-3.5 mr-2 opacity-60" />
                                            {range.label}
                                        </Button>
                                    ))}
                                </div>
                                {dateFilter === 'custom' && (
                                    <div className="mt-2">
                                        <div className="relative">
                                            <CalendarIcon className="absolute left-2 top-2 h-4 w-4 text-muted-foreground" />
                                            <Input
                                                type="date"
                                                className="pl-8 h-8 text-xs w-full block"
                                                value={customDate}
                                                onChange={(e) => setCustomDate(e.target.value)}
                                            />
                                        </div>
                                    </div>
                                )}
                            </div>

                            {/* Status Filter */}
                            <div className="space-y-1.5">
                                <label className="text-[10px] uppercase font-bold text-muted-foreground">Status</label>
                                <div className="flex flex-wrap gap-1.5">
                                    {['All', 'Pending', 'Processing', 'Verifying', 'Completed', 'Failed'].map(s => (
                                        <Button
                                            key={s}
                                            variant={statusFilter === (s === 'All' ? 'All' : s.toLowerCase()) ? "default" : "outline"}
                                            size="sm"
                                            className="h-7 text-[10px] px-2.5"
                                            onClick={() => setStatusFilter(s === 'All' ? 'All' : s.toLowerCase())}
                                        >
                                            {s}
                                        </Button>
                                    ))}
                                </div>
                            </div>

                            {/* Network Filter */}
                            <div className="space-y-1.5">
                                <label className="text-[10px] uppercase font-bold text-muted-foreground">Network</label>
                                <div className="flex flex-wrap gap-1.5">
                                    {['All', ...NETWORKS].map(n => (
                                        <Button
                                            key={n}
                                            variant={networkFilter === n ? "default" : "outline"}
                                            size="sm"
                                            className="h-7 text-[10px] px-2.5"
                                            onClick={() => setNetworkFilter(n)}
                                        >
                                            {n}
                                        </Button>
                                    ))}
                                </div>
                            </div>

                            <div className="pt-4 border-t">
                                <div className="grid grid-cols-2 gap-2">

                                    <div className="col-span-2 p-2.5 md:p-3 bg-primary/5 dark:bg-primary/10 rounded-lg border border-primary/20">
                                        <div className="flex items-baseline justify-between gap-2">
                                            {/* Not possessive: it has to read for "Last 30 Days"
                                                and "All Time" too, where "'s" does not work. */}
                                            <p className="text-[9px] md:text-[10px] text-primary font-bold uppercase">Orders · {dateRangeLabel()}</p>
                                            {isLoadingOrders && <span className="text-[9px] text-muted-foreground">loading…</span>}
                                        </div>
                                        <p className="text-2xl md:text-3xl font-black text-primary leading-tight">{ordersCount}</p>
                                        {isTruncated ? (
                                            <p className="text-[9px] text-amber-600 dark:text-amber-500 font-bold">
                                                Showing first {orders.length} of {ordersCount} — narrow the filters to see the rest
                                            </p>
                                        ) : (
                                            <p className="text-[9px] text-muted-foreground">
                                                All {orders.length} order{orders.length === 1 ? '' : 's'} loaded below
                                            </p>
                                        )}
                                        {carriedOver > 0 && (
                                            // Say it plainly: these sit outside the chosen dates and are
                                            // shown anyway because they are still owed to a customer.
                                            <p className="text-[9px] text-amber-600 dark:text-amber-500 font-bold">
                                                includes {carriedOver} still outstanding from before {dateRangeLabel().toLowerCase()}
                                            </p>
                                        )}
                                    </div>

                                    <div className="p-2 md:p-2.5 bg-amber-50 dark:bg-amber-900/10 rounded-lg border border-amber-100 dark:border-amber-900/20 italic">
                                        <p className="text-[9px] md:text-[10px] text-amber-700 dark:text-amber-400 font-bold uppercase">Pending</p>
                                        <p className="text-lg md:text-xl font-black text-amber-600 dark:text-amber-500">{orders.filter(o => o.status === 'pending').length}</p>
                                    </div>
                                    <div className="p-2 md:p-2.5 bg-yellow-50 dark:bg-yellow-900/10 rounded-lg border border-yellow-100 dark:border-yellow-900/20 italic">
                                        <p className="text-[9px] md:text-[10px] text-yellow-700 dark:text-yellow-400 font-bold uppercase">Processing</p>
                                        <p className="text-lg md:text-xl font-black text-yellow-600 dark:text-yellow-500">{orders.filter(o => o.status === 'processing').length}</p>
                                    </div>
                                    <div className="p-2 md:p-2.5 bg-green-50 dark:bg-green-900/10 rounded-lg border border-green-100 dark:border-green-900/20">
                                        <p className="text-[9px] md:text-[10px] text-green-700 dark:text-green-400 font-bold uppercase">Completed</p>
                                        <p className="text-lg md:text-xl font-black text-green-600 dark:text-green-500">{orders.filter(o => o.status === 'completed').length}</p>
                                    </div>
                                    <div className="p-2 md:p-2.5 bg-red-50 dark:bg-red-900/10 rounded-lg border border-red-100 dark:border-red-900/20">
                                        <p className="text-[9px] md:text-[10px] text-red-700 dark:text-red-400 font-bold uppercase">Failed</p>
                                        <p className="text-lg md:text-xl font-black text-red-600 dark:text-red-500">{orders.filter(o => o.status === 'failed').length}</p>
                                    </div>
                                    <div className="p-2 md:p-2.5 bg-blue-50 dark:bg-blue-900/10 rounded-lg border border-blue-100 dark:border-blue-900/20">
                                        <p className="text-[9px] md:text-[10px] text-blue-700 dark:text-blue-400 font-bold uppercase">Selected</p>
                                        <p className="text-lg md:text-xl font-black text-blue-600 dark:text-blue-500">{selectedOrders.size}</p>
                                    </div>
                                    <div className="p-2 md:p-2.5 bg-emerald-50 dark:bg-emerald-900/10 rounded-lg border border-emerald-100 dark:border-emerald-900/20">
                                        <p className="text-[9px] md:text-[10px] text-emerald-700 dark:text-emerald-400 font-bold uppercase">Total Cost</p>
                                        {/* Deliberately rangeCost, not every loaded order: carried-over
                                            outstanding work must not land in this period's figure. */}
                                        <p className="text-sm md:text-base font-black text-emerald-600 dark:text-emerald-500 truncate">
                                            GHS {rangeCost.toFixed(2)}
                                        </p>
                                    </div>
                                </div>
                            </div>
                        </CardContent>
                    </Card>

                    <Card className="bg-gradient-to-br from-indigo-600 to-indigo-800 text-white border-none shadow-lg">
                        <CardHeader className="pb-2 pt-4 px-4">
                            <CardTitle className="text-sm font-bold flex items-center gap-2">
                                <Server className="w-4 h-4" /> Tip
                            </CardTitle>
                        </CardHeader>
                        <CardContent className="px-4 pb-4 text-[10px] leading-relaxed opacity-90">
                            Check supplier portal manually. Mark orders appropriately to maintain accurate records.
                        </CardContent>
                    </Card>
                </div>

                {/* Right Column: Order List */}
                <div className="lg:col-span-3 space-y-4">
                    {/* Bulk Actions Bar */}
                    {selectedOrders.size > 0 && (
                        <div className="sticky top-20 z-30 flex items-center justify-between bg-primary/10 dark:bg-primary/20 backdrop-blur-md border border-primary/20 p-2 md:p-3 rounded-xl shadow-lg animate-in fade-in slide-in-from-top-4 flex-wrap gap-2 mx-2">
                            <div className="flex items-center gap-2">
                                <Badge variant="default" className="rounded-full px-2 text-[10px]">{selectedOrders.size}</Badge>
                                <span className="text-[10px] md:text-xs font-bold uppercase">Selected</span>
                            </div>
                            <div className="flex gap-2 md:gap-3 flex-wrap justify-end">
                                <Button
                                    size="sm"
                                    onClick={() => refulfillPending(true)}
                                    className="h-9 md:h-10 text-xs md:text-sm px-3 md:px-4 bg-indigo-600 hover:bg-indigo-700 text-white font-bold shadow-sm"
                                    disabled={isRefulfilling || isUpdating}
                                >
                                    {isRefulfilling ? <RefreshCw className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5 mr-1.5" />}
                                    {isRefulfilling ? 'Refulfilling...' : 'Refulfill Pending'}
                                </Button>
                                <Button
                                    size="sm"
                                    onClick={() => bulkUpdateStatus('pending')}
                                    className="h-9 md:h-10 text-xs md:text-sm px-3 md:px-4 bg-amber-500 hover:bg-amber-600 text-black font-bold shadow-sm disabled:opacity-50"
                                    disabled={isUpdating || isRefulfilling || orders.some(o => selectedOrders.has(o.id) && o.status === 'processing')}
                                    title={orders.some(o => selectedOrders.has(o.id) && o.status === 'processing') ? "Cannot revert processing orders to pending" : ""}
                                >
                                    <Clock className="w-3.5 h-3.5 mr-1.5" /> Pending
                                </Button>
                                <Button size="sm" onClick={() => bulkUpdateStatus('processing')} className="h-9 md:h-10 text-xs md:text-sm px-3 md:px-4 bg-yellow-500 hover:bg-yellow-600 text-black font-bold shadow-sm" disabled={isUpdating || isRefulfilling}>
                                    <RotateCcw className="w-3.5 h-3.5 mr-1.5" /> Reprocess
                                </Button>
                                <Button
                                    size="sm"
                                    onClick={() => bulkUpdateStatus('processing', ADMIN_VERIFYING_LABEL)}
                                    className="h-9 md:h-10 text-xs md:text-sm px-3 md:px-4 bg-orange-500 hover:bg-orange-600 text-white font-bold shadow-sm"
                                    disabled={isUpdating || isRefulfilling}
                                    title="Hold under review — the order stays processing, the customer sees 'On Hold — Verifying'"
                                >
                                    <PauseCircle className="w-3.5 h-3.5 mr-1.5" /> Verifying
                                </Button>
                                <Button size="sm" onClick={() => bulkUpdateStatus('completed')} className="h-9 md:h-10 text-xs md:text-sm px-3 md:px-4 bg-green-600 hover:bg-green-700 font-bold shadow-sm" disabled={isUpdating || isRefulfilling}>
                                    <CheckCircle2 className="w-3.5 h-3.5 mr-1.5" /> Complete
                                </Button>
                                <Button size="sm" onClick={() => bulkUpdateStatus('failed')} variant="destructive" className="h-9 md:h-10 text-xs md:text-sm px-3 md:px-4 font-bold shadow-sm" disabled={isUpdating || isRefulfilling}>
                                    <XCircle className="w-3.5 h-3.5 mr-1.5" /> Fail
                                </Button>
                            </div>
                        </div>
                    )}

                    <Card className="shadow-md">
                        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-4">
                            <CardTitle className="text-lg font-bold flex items-center gap-2">
                                Order History
                                <Badge variant="secondary" className="rounded-full px-2 text-[10px] font-bold">
                                    {dateRangeLabel()} · {orders.length}{isTruncated ? `/${ordersCount}` : ''}
                                </Badge>
                            </CardTitle>
                            <div className="flex gap-2">
                                <Button variant="ghost" size="sm" className="h-7 text-[10px]" onClick={() => setSelectedOrders(new Set())} disabled={selectedOrders.size === 0}>
                                    Clear
                                </Button>
                                <Button variant="outline" size="sm" className="h-7 text-[10px]" onClick={() => setSelectedOrders(new Set(orders.map(o => o.id)))} disabled={orders.length === 0}>
                                    Select Page
                                </Button>
                            </div>
                        </CardHeader>
                        <CardContent className="px-1 md:px-6">
                            {orders.length === 0 && !isLoadingOrders ? (
                                <div className="text-center py-20 border-2 border-dashed rounded-xl m-2">
                                    <Package className="w-12 h-12 mx-auto text-muted-foreground/30 mb-3" />
                                    <h3 className="text-sm font-bold">No Records Found</h3>
                                    {debouncedSearch && dateFilter !== 'all' ? (
                                        // A search runs inside the date range, so a beneficiary
                                        // whose order sits outside it comes back empty and reads
                                        // as a broken search box. Name the range, and offer the
                                        // one filter that would actually find them.
                                        <>
                                            <p className="text-muted-foreground text-xs">
                                                Nothing matching &ldquo;{debouncedSearch}&rdquo; in {dateRangeLabel()}.
                                            </p>
                                            <Button
                                                variant="outline"
                                                size="sm"
                                                className="h-7 text-[10px] mt-3"
                                                onClick={() => setDateFilter('all')}
                                            >
                                                Search all time instead
                                            </Button>
                                        </>
                                    ) : (
                                        <p className="text-muted-foreground text-xs">Try adjusting your filters.</p>
                                    )}
                                </div>
                            ) : (
                                <div className="space-y-3">
                                    {orders.map(order => {
                                        // 'verifying' is derived, not stored in status — see lib/order-status-display.
                                        const isHeld = getOrderDisplayStatus(order) === 'verifying'
                                        const isQueued = order.status === 'processing'
                                            && order.mtn_fulfillment_tracking?.some((t: any) => t.api_response?.note === 'Background Queue Fulfillment Success')
                                        return (
                                        <div
                                            key={order.id}
                                            onClick={() => {
                                                const next = new Set(selectedOrders)
                                                next.has(order.id) ? next.delete(order.id) : next.add(order.id)
                                                setSelectedOrders(next)
                                            }}
                                            className={cn(
                                                "group relative flex items-center gap-3 p-3 border-2 rounded-xl transition-all duration-200 cursor-pointer select-none",
                                                selectedOrders.has(order.id)
                                                    ? "bg-primary/10 border-primary shadow-md scale-[1.01]"
                                                    : "bg-card border-transparent hover:border-primary/20 hover:bg-accent/50"
                                            )}
                                        >
                                            <Checkbox
                                                checked={selectedOrders.has(order.id)}
                                                className="scale-110 pointer-events-none"
                                            />

                                            <div className="flex-1 grid grid-cols-2 md:grid-cols-6 items-center gap-x-2 gap-y-3 md:gap-4 p-1">
                                                <div className="space-y-0.5">
                                                    <p className="text-[10px] md:text-[11px] uppercase font-extrabold text-muted-foreground">Beneficiary</p>
                                                    <p className="text-[13px] md:text-sm font-black truncate text-primary">{order.phone_number}</p>
                                                </div>
                                                <div className="space-y-0.5">
                                                    <p className="text-[10px] md:text-[11px] uppercase font-extrabold text-muted-foreground">Bundle</p>
                                                    <div className="flex items-center gap-1.5 flex-wrap">
                                                        <Badge variant="outline" className="text-[10px] px-1.5 font-black leading-none py-1 bg-secondary/50">{order.network}</Badge>
                                                        <span className="text-[13px] md:text-xs font-black">{order.size}</span>
                                                    </div>
                                                </div>
                                                <div className="space-y-0.5">
                                                    <p className="text-[10px] md:text-[11px] uppercase font-extrabold text-muted-foreground">Purchaser</p>
                                                    <div className="text-[11px] md:text-xs">
                                                        <div className="flex items-center gap-1.5 flex-wrap">
                                                            <p className="font-bold truncate max-w-[100px] md:max-w-full" title={`${order.users?.first_name} ${order.users?.last_name}`}>
                                                                {order.users?.first_name || 'N/A'} {order.users?.last_name || ''}
                                                            </p>
                                                            {order.shop_name && (
                                                                <Badge variant="secondary" className="text-[9px] h-4 px-1.5 bg-blue-100 text-blue-700 hover:bg-blue-100 border-blue-200">
                                                                    Shop: {order.shop_name}
                                                                </Badge>
                                                            )}
                                                        </div>
                                                        <p className="text-muted-foreground opacity-70 text-[10px] font-bold uppercase">{order.users?.role || 'User'}</p>
                                                    </div>
                                                </div>
                                                <div className="space-y-0.5">
                                                    <p className="text-[10px] md:text-[11px] uppercase font-extrabold text-muted-foreground">Status</p>
                                                    <div>
                                                        <Badge
                                                            variant={order.status === 'completed' ? 'success' : order.status === 'failed' ? 'destructive' : order.status === 'pending' || isHeld ? 'outline' : 'default'}
                                                            className={cn(
                                                                "text-[10px] md:text-[11px] font-black uppercase tracking-wider h-5 px-2",
                                                                order.status === 'pending' && "border-amber-500 text-amber-600 bg-amber-50 dark:bg-amber-900/20",
                                                                isHeld && "border-orange-500 text-orange-600 bg-orange-50 dark:bg-orange-900/20",
                                                                isQueued && !isHeld && "border-yellow-500 text-yellow-600 bg-yellow-50 dark:bg-yellow-900/20 after:content-['_(QUEUED)'] after:text-[8px] after:ml-1"
                                                            )}
                                                        >
                                                            {isHeld ? 'Verifying' : isQueued ? 'Queued Processing' : order.status}
                                                        </Badge>
                                                    </div>
                                                </div>
                                                <div className="space-y-0.5">
                                                    <p className="text-[10px] md:text-[11px] uppercase font-extrabold text-muted-foreground">Time</p>
                                                    <p className="text-[11px] md:text-[12px] font-bold opacity-80">
                                                        {new Date(order.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} • {new Date(order.created_at).toLocaleDateString([], { month: 'short', day: 'numeric' })}
                                                    </p>
                                                </div>
                                                <div className="hidden md:block space-y-0.5 text-right">
                                                    <p className="text-[11px] uppercase font-extrabold text-muted-foreground">Cost</p>
                                                    <p className="text-sm font-black text-primary">{formatCurrency(order.price)}</p>
                                                </div>
                                            </div>

                                            {/* Per-order refund action (separate from status changes) */}
                                            <div className="flex-shrink-0" onClick={(e) => e.stopPropagation()}>
                                                {order.payment_status === 'refunded' ? (
                                                    <Badge variant="outline" className="text-[10px] px-1.5 py-0.5 bg-gray-100 text-gray-500 dark:bg-gray-800">
                                                        Refunded
                                                    </Badge>
                                                ) : (
                                                    <Button
                                                        variant="ghost"
                                                        size="sm"
                                                        className="h-8 gap-1.5 text-amber-600 hover:text-amber-700 hover:bg-amber-50 dark:hover:bg-amber-900/20"
                                                        disabled={refundingId === order.id}
                                                        onClick={() => handleRefund(order)}
                                                    >
                                                        {refundingId === order.id
                                                            ? <Loader2 className="w-4 h-4 animate-spin" />
                                                            : <RefreshCw className="w-4 h-4" />}
                                                        <span className="hidden md:inline text-xs font-bold">Refund</span>
                                                    </Button>
                                                )}
                                            </div>
                                        </div>
                                        )
                                    })}

                                    {/* Footer Info */}
                                    {orders.length > 0 && (
                                        <div className="pt-4 flex items-center justify-center">
                                            <p className="text-[10px] text-muted-foreground uppercase tracking-widest font-bold">
                                                Showing {orders.length} orders in this period
                                            </p>
                                        </div>
                                    )}
                                </div>
                            )}
                        </CardContent>
                    </Card>
                </div>
            </div>

        </div>
    )
}
