'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { clearPricingCache } from '@/lib/pricing-cache'
import { formatCurrency } from '@/lib/utils'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Switch } from '@/components/ui/switch'
import {
    Users,
    Clock,
    Calendar,
    ShieldCheck,
    Plus,
    Save,
    Loader2,
    Search,
    RefreshCw,
    MoreVertical,
    History,
    Store,
    Zap,
} from 'lucide-react'
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog'
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'

export default function AdminMembershipsPage() {
    const [agents, setAgents] = useState<any[]>([])
    const [loading, setLoading] = useState(true)
    const [isSavingPrices, setIsSavingPrices] = useState(false)
    const [searchTerm, setSearchTerm] = useState('')

    // Extend Dialog State
    const [extendUser, setExtendUser] = useState<any>(null)
    const [extendDays, setExtendDays] = useState('30')
    const [isExtending, setIsExtending] = useState(false)

    // Reduce Dialog State
    const [reduceUser, setReduceUser] = useState<any>(null)
    const [reduceDays, setReduceDays] = useState('3')
    const [isReducing, setIsReducing] = useState(false)

    // Pricing state
    const [prices, setPrices] = useState({
        '3d': '9.99',
        '14d': '49.99',
        '30d': '99.99',
        'permanent': '149.99'
    })
    const [showStrikethrough, setShowStrikethrough] = useState(false)
    type AgentPlan = '3d' | '14d' | '30d' | 'permanent'
    const [enabledPlans, setEnabledPlans] = useState<Record<AgentPlan, boolean>>({
        '3d': true,
        '14d': true,
        '30d': true,
        'permanent': true
    })
    const [savingPlanToggle, setSavingPlanToggle] = useState<AgentPlan | null>(null)

    // Dealer state
    const [dealers, setDealers] = useState<any[]>([])
    const [dealersLoading, setDealersLoading] = useState(true)
    const [dealerSearchTerm, setDealerSearchTerm] = useState('')
    const [dealerPrice6m, setDealerPrice6m] = useState('299.99')
    const [dealerPrice3m, setDealerPrice3m] = useState('169.99')
    const [isSavingDealerPrice, setIsSavingDealerPrice] = useState(false)
    const [autoUpgradeExpiredDealers, setAutoUpgradeExpiredDealers] = useState(false)
    const [isSavingAutoUpgrade, setIsSavingAutoUpgrade] = useState(false)
    const [extendDealerUser, setExtendDealerUser] = useState<any>(null)
    const [extendDealerDays, setExtendDealerDays] = useState('30')
    const [isExtendingDealer, setIsExtendingDealer] = useState(false)

    useEffect(() => {
        fetchData()
        fetchDealers()
    }, [])

    const fetchData = async () => {
        setLoading(true)
        try {
            // Fetch Prices
            const { data: settingsData } = await (supabase as any)
                .from('admin_settings')
                .select('*')

            if (settingsData) {
                const p3 = settingsData.find((s: any) => s.key === 'agent_upgrade_price_3d')?.value || '9.99'
                const p14 = settingsData.find((s: any) => s.key === 'agent_upgrade_price_14d')?.value || '49.99'
                const p30 = settingsData.find((s: any) => s.key === 'agent_upgrade_price_30d')?.value || '99.99'
                const pPerm = settingsData.find((s: any) => s.key === 'agent_upgrade_price_permanent')?.value || '149.99'
                const showStrike = settingsData.find((s: any) => s.key === 'show_price_strikethrough')?.value === 'true'
                setPrices({
                    '3d': String(p3),
                    '14d': String(p14),
                    '30d': String(p30),
                    'permanent': String(pPerm)
                })
                setShowStrikethrough(showStrike)
                const isPlanEnabled = (plan: AgentPlan) =>
                    settingsData.find((s: any) => s.key === `agent_plan_enabled_${plan}`)?.value !== 'false'
                setEnabledPlans({
                    '3d': isPlanEnabled('3d'),
                    '14d': isPlanEnabled('14d'),
                    '30d': isPlanEnabled('30d'),
                    'permanent': isPlanEnabled('permanent')
                })
            }


            // Fetch Agents via API route (bypasses RLS)
            const agentsResponse = await fetch('/api/admin/agents')

            if (!agentsResponse.ok) {
                const errorData = await agentsResponse.json()
                throw new Error(errorData.error || 'Failed to fetch agents')
            }

            const agentsData = await agentsResponse.json()
            console.log('Agents fetched:', agentsData?.length || 0, 'agents found')
            setAgents(agentsData || [])

            // Dealer price and auto-upgrade toggle
            if (settingsData) {
                const dp6m = settingsData.find((s: any) => s.key === 'dealer_subscription_price_6m')?.value
                if (dp6m) setDealerPrice6m(String(dp6m))
                const dp3m = settingsData.find((s: any) => s.key === 'dealer_subscription_price_3m')?.value
                if (dp3m) setDealerPrice3m(String(dp3m))
                const autoUpgrade = settingsData.find((s: any) => s.key === 'auto_upgrade_expired_dealers')?.value === 'true'
                setAutoUpgradeExpiredDealers(autoUpgrade)
            }

        } catch (error: any) {
            console.error('Error fetching membership data:', error)
            toast.error('Failed to load data')
        } finally {
            setLoading(false)
        }
    }

    const fetchDealers = async () => {
        setDealersLoading(true)
        try {
            const response = await fetch('/api/admin/dealers')
            if (!response.ok) throw new Error('Failed to fetch dealers')
            const data = await response.json()
            setDealers(data || [])
        } catch (error: any) {
            toast.error('Failed to load dealers')
        } finally {
            setDealersLoading(false)
        }
    }

    const handleSaveDealerPrice = async () => {
        setIsSavingDealerPrice(true)
        try {
            const response = await fetch('/api/admin/update-prices', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ dealerPrice6m, dealerPrice3m })
            })
            const data = await response.json()
            if (!response.ok) throw new Error(data.error || 'Failed to update dealer price')
            toast.success('Dealer subscription price updated!')
        } catch (error: any) {
            toast.error(error.message)
        } finally {
            setIsSavingDealerPrice(false)
        }
    }

    const handleAutoUpgradeToggle = async (checked: boolean) => {
        setIsSavingAutoUpgrade(true)
        try {
            await (supabase as any)
                .from('admin_settings')
                .upsert({ key: 'auto_upgrade_expired_dealers', value: checked ? 'true' : 'false' }, { onConflict: 'key' })
            setAutoUpgradeExpiredDealers(checked)
            toast.success(checked ? 'Auto-upgrade enabled' : 'Auto-upgrade disabled')
        } catch {
            toast.error('Failed to update setting')
        } finally {
            setIsSavingAutoUpgrade(false)
        }
    }

    const handleExtendDealer = async () => {
        if (!extendDealerUser || !extendDealerDays) return
        const days = parseInt(extendDealerDays)
        if (isNaN(days) || days <= 0) {
            toast.error('Enter a valid number of days')
            return
        }
        setIsExtendingDealer(true)
        try {
            const response = await fetch('/api/admin/dealers', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId: extendDealerUser.id, action: 'extend', days })
            })
            const result = await response.json()
            if (!response.ok) throw new Error(result.error || 'Failed to extend')
            setDealers(dealers.map(d => d.id === extendDealerUser.id ? { ...d, dealer_expires_at: result.newExpiry } : d))
            toast.success(`Extended by ${days} days`)
            setExtendDealerUser(null)
            setExtendDealerDays('30')
        } catch (error: any) {
            toast.error(error.message)
        } finally {
            setIsExtendingDealer(false)
        }
    }

    const handleRevokeDealer = async (dealer: any) => {
        if (!confirm(`Revoke dealership for ${dealer.first_name} ${dealer.last_name}? They will become a customer.`)) return
        try {
            const response = await fetch('/api/admin/dealers', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId: dealer.id, action: 'revoke' })
            })
            const result = await response.json()
            if (!response.ok) throw new Error(result.error || 'Failed to revoke')
            setDealers(dealers.filter(d => d.id !== dealer.id))
            toast.success(`${dealer.first_name}'s dealership revoked`)
        } catch (error: any) {
            toast.error(error.message)
        }
    }

    const handleSavePrices = async () => {
        setIsSavingPrices(true)
        try {
            const response = await fetch('/api/admin/update-prices', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prices, showStrikethrough })
            })

            const data = await response.json()

            if (!response.ok) {
                throw new Error(data.error || 'Failed to update prices')
            }

            // Clear pricing cache so users get fresh prices
            clearPricingCache()
            toast.success(data.message || '✅ Prices updated successfully!')
            await fetchData()
        } catch (error: any) {
            console.error('Error saving prices:', error)
            toast.error('❌ ' + error.message)
        } finally {
            setIsSavingPrices(false)
        }
    }

    const handlePlanToggle = async (plan: AgentPlan, enabled: boolean) => {
        setSavingPlanToggle(plan)
        try {
            const response = await fetch('/api/admin/update-prices', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ planEnabled: { plan, enabled } })
            })
            const data = await response.json()
            if (!response.ok) throw new Error(data.error || 'Failed to update plan')
            setEnabledPlans(prev => ({ ...prev, [plan]: enabled }))
            clearPricingCache()
            toast.success(enabled ? 'Plan turned ON' : 'Plan turned OFF')
        } catch (error: any) {
            toast.error(error.message)
        } finally {
            setSavingPlanToggle(null)
        }
    }

    const handleExtend = async () => {
        if (!extendUser || !extendDays) return

        const days = parseInt(extendDays)
        if (isNaN(days) || days <= 0) {
            toast.error('Please enter a valid positive number of days')
            return
        }

        setIsExtending(true)
        try {
            const response = await fetch('/api/admin/extend-agent', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId: extendUser.id, days, action: 'extend' })
            })

            const result = await response.json()
            if (!response.ok) throw new Error(result.error || 'Failed to extend subscription')

            // Update local state
            setAgents(agents.map(a => a.id === extendUser.id ? { ...a, agent_expires_at: result.newExpiry } : a))

            toast.success(`✅ Subscription extended by ${days} days`)
            setExtendUser(null)
            setExtendDays('30')
        } catch (error: any) {
            console.error('Error extending subscription:', error)
            toast.error(error.message || 'Failed to extend subscription')
        } finally {
            setIsExtending(false)
        }
    }

    const handleReduce = async () => {
        if (!reduceUser || !reduceDays) return

        const days = parseInt(reduceDays)
        if (isNaN(days) || days <= 0) {
            toast.error('Please enter a valid positive number of days')
            return
        }

        setIsReducing(true)
        try {
            const response = await fetch('/api/admin/extend-agent', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId: reduceUser.id, days: -days, action: 'reduce' })
            })

            const result = await response.json()
            if (!response.ok) throw new Error(result.error || 'Failed to reduce subscription')

            // Update local state
            setAgents(agents.map(a => a.id === reduceUser.id ? { ...a, agent_expires_at: result.newExpiry } : a))

            if (result.isExpired) {
                toast.warning(`⚠️ Subscription reduced by ${days} days - Agent has expired`)
            } else {
                toast.success(`✅ Subscription reduced by ${days} days`)
            }
            setReduceUser(null)
            setReduceDays('3')
        } catch (error: any) {
            console.error('Error reducing subscription:', error)
            toast.error(error.message || 'Failed to reduce subscription')
        } finally {
            setIsReducing(false)
        }
    }

    const handleMakePermanent = async (agent: any) => {
        if (!confirm(`Are you sure you want to make ${agent.first_name} a Permanent Agent? This will give them lifetime access.`)) return

        try {
            const response = await fetch('/api/admin/extend-agent/permanent', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId: agent.id })
            })

            const result = await response.json()
            if (!response.ok) throw new Error(result.error || 'Failed to assign permanent status')

            // Update local state
            setAgents(agents.map(a => a.id === agent.id ? { ...a, agent_expires_at: null } : a))

            toast.success(`✅ ${agent.first_name} is now a Permanent Agent`)
        } catch (error: any) {
            console.error('Error assigning permanent status:', error)
            toast.error(error.message || 'Failed to assign permanent status')
        }
    }

    const calculateDaysLeft = (expiry: string | null) => {
        if (!expiry) return 0
        const now = new Date()
        const exp = new Date(expiry)
        const diff = exp.getTime() - now.getTime()
        const days = Math.ceil(diff / (1000 * 60 * 60 * 24))
        return days > 0 ? days : 0
    }

    const filteredAgents = agents.filter(a =>
        a.email.toLowerCase().includes(searchTerm.toLowerCase()) ||
        a.first_name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
        a.last_name?.toLowerCase().includes(searchTerm.toLowerCase())
    )

    return (
        <div className="space-y-8 pb-20">
            {/* Header */}
            <div>
                <h1 className="text-3xl font-black text-slate-900 flex items-center gap-2">
                    <ShieldCheck className="w-8 h-8 text-amber-500" />
                    Agent &amp; Dealer Memberships
                </h1>
                <p className="text-muted-foreground font-medium">Manage pricing and subscription durations for your agents and dealers.</p>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                {/* Pricing Manager Card */}
                <Card className="lg:col-span-1 shadow-xl border-amber-100 h-fit">
                    <CardHeader className="bg-amber-50/50">
                        <CardTitle className="text-lg flex items-center gap-2">
                            <Plus className="w-5 h-5 text-amber-600" />
                            Upgrade Pricing
                        </CardTitle>
                        <CardDescription>Set the cost for each membership tier.</CardDescription>
                    </CardHeader>
                    <CardContent className="pt-6 space-y-6">
                        <div className="space-y-4">
                            {([
                                { plan: '3d', label: '3 Days Access (GHS) - Starter', inputClass: '' },
                                { plan: '14d', label: '14 Days Access (GHS)', inputClass: 'border-amber-200' },
                                { plan: '30d', label: '30 Days Access (GHS)', inputClass: '' },
                                { plan: 'permanent', label: 'Permanent Access (GHS)', inputClass: 'border-indigo-200' },
                            ] as { plan: AgentPlan; label: string; inputClass: string }[]).map(({ plan, label, inputClass }) => (
                                <div key={plan} className="space-y-2">
                                    <div className="flex items-center justify-between gap-2">
                                        <Label className="flex items-center gap-1">
                                            {plan === 'permanent' && <ShieldCheck className="w-4 h-4 text-indigo-500" />}
                                            {label}
                                        </Label>
                                        <div className="flex items-center gap-2">
                                            <span className={cn(
                                                "text-[10px] font-black uppercase",
                                                enabledPlans[plan] ? "text-emerald-600" : "text-slate-400"
                                            )}>
                                                {enabledPlans[plan] ? 'On' : 'Off'}
                                            </span>
                                            <Switch
                                                checked={enabledPlans[plan]}
                                                onCheckedChange={(checked) => handlePlanToggle(plan, checked)}
                                                disabled={savingPlanToggle === plan}
                                                aria-label={`Turn ${label} on or off`}
                                            />
                                        </div>
                                    </div>
                                    <Input
                                        type="number"
                                        value={prices[plan]}
                                        onChange={(e) => setPrices({ ...prices, [plan]: e.target.value })}
                                        className={cn("font-bold text-lg", inputClass, !enabledPlans[plan] && "opacity-50")}
                                    />
                                </div>
                            ))}
                            <p className="text-xs text-muted-foreground">
                                Plans switched OFF are hidden from customers and can't be bought.
                            </p>
                        </div>
                        <div className="space-y-3 pt-2 border-t">
                            <div className="flex items-center space-x-2">
                                <Checkbox
                                    id="strikethrough"
                                    checked={showStrikethrough}
                                    onCheckedChange={(checked) => setShowStrikethrough(checked as boolean)}
                                />
                                <Label htmlFor="strikethrough" className="text-sm font-medium cursor-pointer">
                                    Show old prices with strikethrough
                                </Label>
                            </div>
                            <p className="text-xs text-muted-foreground">
                                Enable to display previous prices crossed out when prices change
                            </p>
                        </div>
                        <Button
                            className="w-full bg-slate-900 hover:bg-slate-800 h-12 text-base font-black"
                            onClick={handleSavePrices}
                            disabled={isSavingPrices}
                        >
                            {isSavingPrices ? <Loader2 className="w-5 h-5 animate-spin mr-2" /> : <Save className="w-5 h-5 mr-2" />}
                            Update Prices
                        </Button>
                    </CardContent>
                </Card>

                {/* Agents List Card */}
                <Card className="lg:col-span-2 shadow-xl border-blue-50">
                    <CardHeader className="flex flex-col sm:flex-row items-start sm:items-center justify-between pb-4 border-b gap-4">
                        <div className="space-y-1">
                            <CardTitle className="text-lg flex items-center gap-2">
                                <Users className="w-5 h-5 text-blue-600" />
                                Active Agents ({agents.length})
                            </CardTitle>
                            <CardDescription>Agents with active subscriptions.</CardDescription>
                        </div>
                        <div className="relative w-full sm:w-64">
                            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                            <Input
                                placeholder="Search agents..."
                                value={searchTerm}
                                onChange={(e) => setSearchTerm(e.target.value)}
                                className="pl-9 h-9 text-xs"
                            />
                        </div>
                    </CardHeader>
                    <CardContent className="p-0">
                        {loading ? (
                            <div className="flex justify-center py-20">
                                <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
                            </div>
                        ) : filteredAgents.length === 0 ? (
                            <div className="text-center py-20 space-y-4">
                                <p className="text-muted-foreground font-medium">No agents found.</p>
                                <Button variant="outline" size="sm" onClick={() => fetchData()}>
                                    <RefreshCw className="w-4 h-4 mr-2" />
                                    Refresh
                                </Button>
                            </div>
                        ) : (
                            <>
                                {/* Desktop Table View */}
                                <div className="hidden md:block overflow-x-auto">
                                    <table className="w-full text-sm">
                                        <thead className="bg-slate-50/50 text-slate-500 font-bold">
                                            <tr>
                                                <th className="px-6 py-4 text-left">Agent</th>
                                                <th className="px-6 py-4 text-left">Status</th>
                                                <th className="px-6 py-4 text-center">Days Left</th>
                                                <th className="px-6 py-4 text-right">Actions</th>
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y">
                                            {filteredAgents.map((agent) => {
                                                const daysLeft = calculateDaysLeft(agent.agent_expires_at)
                                                return (
                                                    <tr key={agent.id} className="hover:bg-slate-50/50 transition-colors">
                                                        <td className="px-6 py-4">
                                                            <div className="flex flex-col">
                                                                <span className="font-black text-slate-900">{agent.first_name} {agent.last_name}</span>
                                                                <span className="text-xs text-muted-foreground">{agent.email}</span>
                                                            </div>
                                                        </td>
                                                        <td className="px-6 py-4">
                                                            {daysLeft > 0 ? (
                                                                <Badge className="bg-emerald-100 text-emerald-700 hover:bg-emerald-200 border-emerald-200 uppercase text-[10px] font-black">Active</Badge>
                                                            ) : (
                                                                <Badge variant="destructive" className="uppercase text-[10px] font-black">Expired</Badge>
                                                            )}
                                                        </td>
                                                        <td className="px-6 py-4 text-center">
                                                            {agent.agent_expires_at === null ? (
                                                                <div className="flex flex-col items-center justify-center bg-indigo-50 py-1.5 px-3 rounded-md border border-indigo-100">
                                                                    <span className="text-xs font-black tracking-widest text-indigo-700 uppercase flex items-center gap-1">
                                                                        <ShieldCheck className="w-3.5 h-3.5" /> Lifetime
                                                                    </span>
                                                                </div>
                                                            ) : (
                                                                <div className="flex flex-col items-center gap-1">
                                                                    <span className={cn(
                                                                        "text-xl font-black",
                                                                        daysLeft < 5 ? "text-red-600" : "text-slate-900"
                                                                    )}>{daysLeft}</span>
                                                                    <div className="w-16 h-1 bg-slate-100 rounded-full overflow-hidden">
                                                                        <div
                                                                            className={cn("h-full", daysLeft < 5 ? "bg-red-500" : "bg-blue-500")}
                                                                            style={{ width: `${Math.min((daysLeft / 30) * 100, 100)}%` }}
                                                                        />
                                                                    </div>
                                                                </div>
                                                            )}
                                                        </td>
                                                        <td className="px-6 py-4 text-right">
                                                            <DropdownMenu>
                                                                <DropdownMenuTrigger asChild>
                                                                    <Button variant="ghost" size="sm">
                                                                        <MoreVertical className="w-4 h-4" />
                                                                    </Button>
                                                                </DropdownMenuTrigger>
                                                                <DropdownMenuContent align="end">
                                                                    {agent.agent_expires_at !== null && (
                                                                        <>
                                                                            <DropdownMenuItem onClick={() => {
                                                                                setExtendUser(agent)
                                                                                setExtendDays('30')
                                                                            }}>
                                                                                <Plus className="w-4 h-4 mr-2" />
                                                                                Extend Days
                                                                            </DropdownMenuItem>
                                                                            <DropdownMenuItem onClick={() => {
                                                                                setReduceUser(agent)
                                                                                setReduceDays('3')
                                                                            }}>
                                                                                <History className="w-4 h-4 mr-2" />
                                                                                Reduce Days
                                                                            </DropdownMenuItem>
                                                                            <div className="h-px bg-slate-100 my-1" />
                                                                            <DropdownMenuItem className="text-indigo-600 focus:bg-indigo-50 focus:text-indigo-700" onClick={() => handleMakePermanent(agent)}>
                                                                                <ShieldCheck className="w-4 h-4 mr-2" />
                                                                                Make Permanent
                                                                            </DropdownMenuItem>
                                                                        </>
                                                                    )}
                                                                </DropdownMenuContent>
                                                            </DropdownMenu>
                                                        </td>
                                                    </tr>
                                                )
                                            })}
                                        </tbody>
                                    </table>
                                </div>

                                {/* Mobile Card View */}
                                <div className="md:hidden space-y-4 p-4">
                                    {filteredAgents.map((agent) => {
                                        const daysLeft = calculateDaysLeft(agent.agent_expires_at)
                                        return (
                                            <div key={agent.id} className="bg-white rounded-xl border p-4 shadow-sm flex flex-col gap-3">
                                                <div className="flex justify-between items-start">
                                                    <div>
                                                        <h3 className="font-black text-slate-900">{agent.first_name} {agent.last_name}</h3>
                                                        <p className="text-xs text-muted-foreground">{agent.email}</p>
                                                    </div>
                                                    {agent.agent_expires_at === null ? (
                                                        <Badge className="bg-indigo-100 text-indigo-700 hover:bg-indigo-200 border-indigo-200 uppercase text-[10px] font-black tracking-widest">Permanent</Badge>
                                                    ) : daysLeft > 0 ? (
                                                        <Badge className="bg-emerald-100 text-emerald-700 hover:bg-emerald-200 border-emerald-200 uppercase text-[10px] font-black">Active</Badge>
                                                    ) : (
                                                        <Badge variant="destructive" className="uppercase text-[10px] font-black">Expired</Badge>
                                                    )}
                                                </div>

                                                <div className="flex items-center justify-between bg-slate-50 p-3 rounded-lg">
                                                    <span className="text-xs font-bold text-slate-500">Days Remaining</span>
                                                    <div className="flex items-center gap-2">
                                                        {agent.agent_expires_at === null ? (
                                                            <span className="text-sm font-black text-indigo-600 uppercase tracking-widest flex items-center gap-1"><ShieldCheck className="w-3.5 h-3.5" /> Lifetime</span>
                                                        ) : (
                                                            <>
                                                                <Clock className="w-3.5 h-3.5 text-slate-400" />
                                                                <span className={cn(
                                                                    "text-lg font-black",
                                                                    daysLeft < 5 ? "text-red-600" : "text-slate-900"
                                                                )}>{daysLeft}</span>
                                                            </>
                                                        )}
                                                    </div>
                                                </div>

                                                {agent.agent_expires_at !== null && (
                                                    <div className="flex flex-col gap-2">
                                                        <div className="flex gap-2">
                                                            <Button
                                                                size="sm"
                                                                variant="outline"
                                                                className="flex-1 text-blue-600 border-blue-200 hover:bg-blue-50"
                                                                onClick={() => {
                                                                    setExtendUser(agent)
                                                                    setExtendDays('30')
                                                                }}
                                                            >
                                                                <Plus className="w-4 h-4 mr-2" />
                                                                Extend
                                                            </Button>
                                                            <Button
                                                                size="sm"
                                                                variant="outline"
                                                                className="flex-1 text-orange-600 border-orange-200 hover:bg-orange-50"
                                                                onClick={() => {
                                                                    setReduceUser(agent)
                                                                    setReduceDays('3')
                                                                }}
                                                            >
                                                                <History className="w-4 h-4 mr-2" />
                                                                Reduce
                                                            </Button>
                                                        </div>
                                                        <Button
                                                            size="sm"
                                                            variant="outline"
                                                            className="w-full text-indigo-600 border-indigo-200 hover:bg-indigo-50"
                                                            onClick={() => handleMakePermanent(agent)}
                                                        >
                                                            <ShieldCheck className="w-4 h-4 mr-2" />
                                                            Make Permanent
                                                        </Button>
                                                    </div>
                                                )}
                                            </div>
                                        )
                                    })}
                                </div>
                            </>
                        )}
                    </CardContent>
                </Card>
            </div>

            {/* ───────────────────────────── DEALERS SECTION ───────────────────────────── */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 mt-8">

                {/* Dealer Pricing & Auto-Upgrade Card */}
                <Card className="lg:col-span-1 shadow-xl border-violet-100 h-fit">
                    <CardHeader className="bg-violet-50/50">
                        <CardTitle className="text-lg flex items-center gap-2">
                            <Store className="w-5 h-5 text-violet-600" />
                            Dealer Settings
                        </CardTitle>
                        <CardDescription>Subscription pricing and auto-upgrade behaviour.</CardDescription>
                    </CardHeader>
                    <CardContent className="pt-6 space-y-6">
                        <div className="grid grid-cols-2 gap-4">
                            <div className="space-y-2">
                                <Label>3-Month Subscription Price (GHS)</Label>
                                <Input
                                    type="number"
                                    value={dealerPrice3m}
                                    onChange={(e) => setDealerPrice3m(e.target.value)}
                                    className="font-bold text-lg"
                                />
                            </div>
                            <div className="space-y-2">
                                <Label>6-Month Subscription Price (GHS)</Label>
                                <Input
                                    type="number"
                                    value={dealerPrice6m}
                                    onChange={(e) => setDealerPrice6m(e.target.value)}
                                    className="font-bold text-lg"
                                />
                            </div>
                        </div>
                        <Button
                            className="w-full bg-violet-700 hover:bg-violet-800 h-11 font-black"
                            onClick={handleSaveDealerPrice}
                            disabled={isSavingDealerPrice}
                        >
                            {isSavingDealerPrice ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Save className="w-4 h-4 mr-2" />}
                            Save Dealer Price
                        </Button>

                        <div className="pt-4 border-t space-y-3">
                            <div className="flex items-center justify-between gap-3">
                                <div>
                                    <p className="text-sm font-bold text-slate-800">Auto-upgrade expired dealers</p>
                                    <p className="text-xs text-muted-foreground mt-0.5">
                                        When ON, expired unsubscribed dealers become Agents within 3 days.
                                    </p>
                                </div>
                                <Switch
                                    checked={autoUpgradeExpiredDealers}
                                    onCheckedChange={handleAutoUpgradeToggle}
                                    disabled={isSavingAutoUpgrade}
                                />
                            </div>
                            {autoUpgradeExpiredDealers && (
                                <div className="flex items-center gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                                    <Zap className="w-4 h-4 text-amber-500 flex-shrink-0" />
                                    <p className="text-xs text-amber-700 font-medium">
                                        Expired dealers will be auto-promoted to Agent in 3 days via cron job.
                                    </p>
                                </div>
                            )}
                        </div>
                    </CardContent>
                </Card>

                {/* Dealers List Card */}
                <Card className="lg:col-span-2 shadow-xl border-violet-50">
                    <CardHeader className="flex flex-col sm:flex-row items-start sm:items-center justify-between pb-4 border-b gap-4">
                        <div className="space-y-1">
                            <CardTitle className="text-lg flex items-center gap-2">
                                <Store className="w-5 h-5 text-violet-600" />
                                Active Dealers ({dealers.length})
                            </CardTitle>
                            <CardDescription>Users with the dealership role.</CardDescription>
                        </div>
                        <div className="relative w-full sm:w-64">
                            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                            <Input
                                placeholder="Search dealers..."
                                value={dealerSearchTerm}
                                onChange={(e) => setDealerSearchTerm(e.target.value)}
                                className="pl-9 h-9 text-xs"
                            />
                        </div>
                    </CardHeader>
                    <CardContent className="p-0">
                        {dealersLoading ? (
                            <div className="flex justify-center py-20">
                                <Loader2 className="w-8 h-8 animate-spin text-violet-600" />
                            </div>
                        ) : dealers.filter(d =>
                            d.email.toLowerCase().includes(dealerSearchTerm.toLowerCase()) ||
                            d.first_name?.toLowerCase().includes(dealerSearchTerm.toLowerCase()) ||
                            d.last_name?.toLowerCase().includes(dealerSearchTerm.toLowerCase())
                        ).length === 0 ? (
                            <div className="text-center py-20 space-y-4">
                                <p className="text-muted-foreground font-medium">No dealers found.</p>
                                <Button variant="outline" size="sm" onClick={fetchDealers}>
                                    <RefreshCw className="w-4 h-4 mr-2" />
                                    Refresh
                                </Button>
                            </div>
                        ) : (
                            <div className="hidden md:block overflow-x-auto">
                                <table className="w-full text-sm">
                                    <thead className="bg-slate-50/50 text-slate-500 font-bold">
                                        <tr>
                                            <th className="px-6 py-4 text-left">Dealer</th>
                                            <th className="px-6 py-4 text-left">Claimed</th>
                                            <th className="px-6 py-4 text-left">Expires</th>
                                            <th className="px-6 py-4 text-center">Status</th>
                                            <th className="px-6 py-4 text-right">Actions</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y">
                                        {dealers.filter(d =>
                                            d.email.toLowerCase().includes(dealerSearchTerm.toLowerCase()) ||
                                            d.first_name?.toLowerCase().includes(dealerSearchTerm.toLowerCase()) ||
                                            d.last_name?.toLowerCase().includes(dealerSearchTerm.toLowerCase())
                                        ).map((dealer) => {
                                            const expiry = dealer.dealer_expires_at ? new Date(dealer.dealer_expires_at) : null
                                            const daysLeft = expiry ? Math.ceil((expiry.getTime() - Date.now()) / (1000 * 60 * 60 * 24)) : null
                                            const isExpired = daysLeft !== null && daysLeft <= 0
                                            return (
                                                <tr key={dealer.id} className="hover:bg-slate-50/50 transition-colors">
                                                    <td className="px-6 py-4">
                                                        <div className="flex flex-col">
                                                            <span className="font-black text-slate-900">{dealer.first_name} {dealer.last_name}</span>
                                                            <span className="text-xs text-muted-foreground">{dealer.email}</span>
                                                        </div>
                                                    </td>
                                                    <td className="px-6 py-4 text-xs text-muted-foreground">
                                                        {dealer.dealer_claimed_at ? new Date(dealer.dealer_claimed_at).toLocaleDateString() : '—'}
                                                    </td>
                                                    <td className="px-6 py-4 text-xs text-muted-foreground">
                                                        {expiry ? expiry.toLocaleDateString() : '—'}
                                                    </td>
                                                    <td className="px-6 py-4 text-center">
                                                        {isExpired ? (
                                                            <Badge variant="destructive" className="uppercase text-[10px] font-black">Expired</Badge>
                                                        ) : daysLeft !== null && daysLeft <= 7 ? (
                                                            <Badge className="bg-amber-100 text-amber-700 border-amber-200 uppercase text-[10px] font-black">Expiring</Badge>
                                                        ) : (
                                                            <Badge className="bg-violet-100 text-violet-700 border-violet-200 uppercase text-[10px] font-black">Active</Badge>
                                                        )}
                                                    </td>
                                                    <td className="px-6 py-4 text-right">
                                                        <DropdownMenu>
                                                            <DropdownMenuTrigger asChild>
                                                                <Button variant="ghost" size="sm">
                                                                    <MoreVertical className="w-4 h-4" />
                                                                </Button>
                                                            </DropdownMenuTrigger>
                                                            <DropdownMenuContent align="end">
                                                                <DropdownMenuItem onClick={() => {
                                                                    setExtendDealerUser(dealer)
                                                                    setExtendDealerDays('30')
                                                                }}>
                                                                    <Plus className="w-4 h-4 mr-2" />
                                                                    Extend Days
                                                                </DropdownMenuItem>
                                                                <div className="h-px bg-slate-100 my-1" />
                                                                <DropdownMenuItem
                                                                    className="text-red-600 focus:bg-red-50 focus:text-red-700"
                                                                    onClick={() => handleRevokeDealer(dealer)}
                                                                >
                                                                    <Store className="w-4 h-4 mr-2" />
                                                                    Revoke Dealership
                                                                </DropdownMenuItem>
                                                            </DropdownMenuContent>
                                                        </DropdownMenu>
                                                    </td>
                                                </tr>
                                            )
                                        })}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </CardContent>
                </Card>
            </div>

            {/* Dealer Extend Dialog */}
            <Dialog open={!!extendDealerUser} onOpenChange={() => setExtendDealerUser(null)}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Extend Dealer Access</DialogTitle>
                        <DialogDescription>
                            Add days for {extendDealerUser?.first_name} {extendDealerUser?.last_name}.
                        </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4 py-4">
                        <div className="space-y-2">
                            <Label>Days to Add</Label>
                            <Input
                                type="number"
                                value={extendDealerDays}
                                onChange={(e) => setExtendDealerDays(e.target.value)}
                                placeholder="e.g. 30"
                                className="font-bold text-lg"
                                min="1"
                            />
                            <div className="flex gap-2 flex-wrap">
                                {[7, 14, 30, 180].map(d => (
                                    <Badge
                                        key={d}
                                        variant="outline"
                                        className="cursor-pointer hover:bg-violet-50 border-violet-300 text-violet-600"
                                        onClick={() => setExtendDealerDays(d.toString())}
                                    >
                                        +{d}d
                                    </Badge>
                                ))}
                            </div>
                        </div>
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setExtendDealerUser(null)}>Cancel</Button>
                        <Button onClick={handleExtendDealer} disabled={isExtendingDealer} className="bg-violet-600 hover:bg-violet-700">
                            {isExtendingDealer ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Plus className="w-4 h-4 mr-2" />}
                            Extend Days
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Extend Dialog */}
            <Dialog open={!!extendUser} onOpenChange={() => setExtendUser(null)}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Extend Subscription</DialogTitle>
                        <DialogDescription>
                            Add access days for {extendUser?.first_name} {extendUser?.last_name}.
                        </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4 py-4">
                        <div className="space-y-2">
                            <Label>Days to Add</Label>
                            <Input
                                type="number"
                                value={extendDays}
                                onChange={(e) => setExtendDays(e.target.value)}
                                placeholder="e.g. 30"
                                className="font-bold text-lg"
                                min="1"
                            />
                            <div className="flex gap-2 flex-wrap">
                                {[3, 7, 14, 30].map(d => (
                                    <Badge
                                        key={d}
                                        variant="outline"
                                        className="cursor-pointer hover:bg-blue-50 border-blue-300 text-blue-600"
                                        onClick={() => setExtendDays(d.toString())}
                                    >
                                        +{d}d
                                    </Badge>
                                ))}
                            </div>
                        </div>
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setExtendUser(null)}>Cancel</Button>
                        <Button onClick={handleExtend} disabled={isExtending} className="bg-blue-600 hover:bg-blue-700">
                            {isExtending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Plus className="w-4 h-4 mr-2" />}
                            Extend Days
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Reduce Dialog */}
            <Dialog open={!!reduceUser} onOpenChange={() => setReduceUser(null)}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Reduce Subscription</DialogTitle>
                        <DialogDescription>
                            Subtract access days for {reduceUser?.first_name} {reduceUser?.last_name}.
                        </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4 py-4">
                        <div className="space-y-2">
                            <Label>Days to Reduce</Label>
                            <Input
                                type="number"
                                value={reduceDays}
                                onChange={(e) => setReduceDays(e.target.value)}
                                placeholder="e.g. 3"
                                className="font-bold text-lg"
                                min="1"
                            />
                            <div className="flex gap-2 flex-wrap">
                                {[3, 7, 14, 30].map(d => (
                                    <Badge
                                        key={d}
                                        variant="outline"
                                        className="cursor-pointer hover:bg-orange-50 border-orange-300 text-orange-600"
                                        onClick={() => setReduceDays(d.toString())}
                                    >
                                        {d}d
                                    </Badge>
                                ))}
                            </div>
                            {reduceUser && (
                                <p className="text-xs text-orange-600 mt-2">
                                    ⚠️ If reduction causes expiry, an expiry SMS will be sent.
                                </p>
                            )}
                        </div>
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setReduceUser(null)}>Cancel</Button>
                        <Button onClick={handleReduce} disabled={isReducing} className="bg-orange-600 hover:bg-orange-700">
                            {isReducing ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <History className="w-4 h-4 mr-2" />}
                            Reduce Days
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    )
}
