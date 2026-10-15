'use client'

import { useEffect, useState } from 'react'
import { formatCurrency } from '@/lib/utils'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog'
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select'
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from '@/components/ui/table'
import {
    Plus,
    Pencil,
    Trash2,
    Loader2,
    Package,
    FileEdit
} from 'lucide-react'
import { toast } from 'sonner'
import { DataPackage } from '@/types/supabase'

const NETWORKS = ['MTN', 'Telecel', 'AT-iShare', 'AT-BigTime', 'Special MTN Mashup', 'EXPRESS MTN'] as const

interface PackageFormData {
    network: typeof NETWORKS[number]
    size: string
    price: number
    agent_price: number
    dealer_price: number
    // Developer API price, every API caller. Blank (string) = role price.
    api_price: string
    cost_price: number
    description: string
    is_available: boolean
    sort_order: number
}

const defaultFormData: PackageFormData = {
    network: 'MTN',
    size: '',
    price: 0,
    agent_price: 0,
    dealer_price: 0,
    api_price: '',
    cost_price: 0,
    description: '',
    is_available: true,
    sort_order: 0,
}

export default function AdminPackagesPage() {
    const [packages, setPackages] = useState<DataPackage[]>([])
    const [isLoading, setIsLoading] = useState(true)
    const [isDialogOpen, setIsDialogOpen] = useState(false)
    const [editingPackage, setEditingPackage] = useState<DataPackage | null>(null)
    const [formData, setFormData] = useState<PackageFormData>(defaultFormData)
    const [isSaving, setIsSaving] = useState(false)
    const [deletingId, setDeletingId] = useState<string | null>(null)
    const [isNetworkDescDialogOpen, setIsNetworkDescDialogOpen] = useState(false)
    const [editingNetwork, setEditingNetwork] = useState<typeof NETWORKS[number] | null>(null)
    const [networkDescription, setNetworkDescription] = useState('')
    const [isSavingNetworkDesc, setIsSavingNetworkDesc] = useState(false)

    useEffect(() => {
        fetchPackages()
    }, [])

    const fetchPackages = async () => {
        try {
            const res = await fetch('/api/admin/packages')
            const data = await res.json()
            if (!res.ok) throw new Error(data?.error || 'Failed to fetch packages')
            setPackages(Array.isArray(data) ? data : [])
        } catch (error: any) {
            console.error('Error fetching packages:', error)
            toast.error(error?.message || 'Failed to load packages')
        } finally {
            setIsLoading(false)
        }
    }

    const openCreateDialog = () => {
        setEditingPackage(null)
        setFormData(defaultFormData)
        setIsDialogOpen(true)
    }

    const openEditDialog = (pkg: DataPackage) => {
        setEditingPackage(pkg)
        setFormData({
            network: pkg.network,
            size: pkg.size,
            price: pkg.price,
            agent_price: (pkg as any).agent_price || 0,
            dealer_price: (pkg as any).dealer_price || 0,
            api_price: (pkg as any).api_price > 0 ? String((pkg as any).api_price) : '',
            cost_price: (pkg as any).cost_price || 0,
            description: pkg.description || '',
            is_available: pkg.is_available,
            sort_order: pkg.sort_order,
        })
        setIsDialogOpen(true)
    }

    const handleSave = async () => {
        if (!formData.size || !formData.price) {
            toast.error('Please fill in all required fields')
            return
        }

        setIsSaving(true)
        try {
            const method = editingPackage ? 'PUT' : 'POST'
            // Blank API price is stored as NULL so API callers fall back to role pricing.
            const payload = { ...formData, api_price: Number(formData.api_price) > 0 ? Number(formData.api_price) : null }
            const body = editingPackage ? { ...payload, id: editingPackage.id } : payload

            const res = await fetch('/api/admin/packages', {
                method,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            })

            const data = await res.json()
            if (!res.ok) {
                const detail = Array.isArray(data?.details) ? ` (${data.details.join(', ')})` : ''
                throw new Error(`${data?.error || 'Failed to save package'}${detail}`)
            }

            toast.success(editingPackage ? 'Package updated successfully' : 'Package created successfully')
            setIsDialogOpen(false)
            fetchPackages()
        } catch (error: any) {
            console.error('Error saving package:', error)
            toast.error(error?.message || 'Failed to save package')
        } finally {
            setIsSaving(false)
        }
    }

    const handleDelete = async (id: string) => {
        if (!confirm('Are you sure you want to delete this package?')) return

        setDeletingId(id)
        try {
            const res = await fetch(`/api/admin/packages?id=${id}`, {
                method: 'DELETE',
            })

            if (!res.ok) throw new Error('Failed to delete package')

            toast.success('Package deleted successfully')
            fetchPackages()
        } catch (error) {
            toast.error('Failed to delete package')
        } finally {
            setDeletingId(null)
        }
    }

    const toggleAvailability = async (pkg: DataPackage) => {
        try {
            const res = await fetch('/api/admin/packages', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    id: pkg.id,
                    is_available: !pkg.is_available
                })
            })

            if (!res.ok) throw new Error('Failed to update package')

            setPackages(prev =>
                prev.map(p => p.id === pkg.id ? { ...p, is_available: !p.is_available } : p)
            )
        } catch (error) {
            toast.error('Failed to update package')
        }
    }

    const openNetworkDescDialog = (network: typeof NETWORKS[number]) => {
        setEditingNetwork(network)
        // Get description from first package of this network
        const networkPackage = packages.find(p => p.network === network)
        setNetworkDescription(networkPackage?.description || '')
        setIsNetworkDescDialogOpen(true)
    }

    const handleSaveNetworkDescription = async () => {
        if (!editingNetwork) return

        setIsSavingNetworkDesc(true)
        try {
            const res = await fetch('/api/admin/packages/network-description', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    network: editingNetwork,
                    description: networkDescription
                })
            })

            const data = await res.json()
            if (!res.ok) throw new Error(data.error || 'Failed to update description')

            toast.success(`Description updated for all ${editingNetwork} packages`)
            setIsNetworkDescDialogOpen(false)
            fetchPackages()
        } catch (error: any) {
            console.error('Error updating network description:', error)
            toast.error(error.message || 'Failed to update description')
        } finally {
            setIsSavingNetworkDesc(false)
        }
    }

    // Group packages by network — include an 'Other' bucket for any unrecognized network values
    const knownNetworkSet = new Set<string>(NETWORKS)
    const packagesByNetwork: Record<string, DataPackage[]> = {}
    NETWORKS.forEach(n => { packagesByNetwork[n] = [] })
    packagesByNetwork['Other'] = []

    packages.forEach(p => {
        const key = knownNetworkSet.has(p.network) ? p.network : 'Other'
        packagesByNetwork[key].push(p)
    })

    const allGroupKeys = [...NETWORKS, 'Other'] as string[]
    const hasAnyPackages = packages.length > 0

    return (
        <div className="space-y-6">
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-bold">Data Packages</h1>
                    <p className="text-muted-foreground">Manage available data packages</p>
                </div>
                <Button onClick={openCreateDialog}>
                    <Plus className="w-4 h-4 mr-2" />
                    Add Package
                </Button>
            </div>

            {/* Loading skeleton */}
            {isLoading && (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                    {[...Array(8)].map((_, i) => (
                        <div key={i} className="h-48 rounded-xl bg-muted animate-pulse" />
                    ))}
                </div>
            )}

            {/* Empty state */}
            {!isLoading && !hasAnyPackages && (
                <div className="flex flex-col items-center justify-center py-24 border-2 border-dashed rounded-xl text-center">
                    <Package className="w-12 h-12 text-muted-foreground/40 mb-4" />
                    <h3 className="text-lg font-semibold">No Packages Found</h3>
                    <p className="text-muted-foreground text-sm mt-1">Click &quot;Add Package&quot; to create your first data package.</p>
                </div>
            )}

            {/* Network-based Card Grid */}
            {!isLoading && hasAnyPackages && allGroupKeys.map(network => {
                const networkPackages = packagesByNetwork[network] || []
                if (networkPackages.length === 0 && network === 'Other') return null // Only hide 'Other' if empty

                return (
                    <div key={network} className="space-y-4">
                        <div className="flex items-center justify-between">
                            <h2 className="text-xl font-bold flex items-center gap-2">
                                <span className={`px-3 py-1 rounded-full text-sm ${
                                    network === 'MTN' || network === 'Special MTN Mashup' || network === 'EXPRESS MTN' ? 'bg-yellow-500 text-black' :
                                    network === 'Telecel' ? 'bg-red-600 text-white' :
                                    network === 'Other' ? 'bg-gray-500 text-white' :
                                    'bg-blue-600 text-white'
                                }`}>
                                    {network}
                                </span>
                                <span className="text-muted-foreground text-sm">({networkPackages.length} packages)</span>
                            </h2>
                            {network !== 'Other' && (
                                <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => openNetworkDescDialog(network as typeof NETWORKS[number])}
                                    className="gap-2"
                                >
                                    <FileEdit className="w-4 h-4" />
                                    Edit Description
                                </Button>
                            )}
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                            {networkPackages.length === 0 ? (
                                <div className="col-span-full py-8 text-center bg-muted/30 rounded-xl border border-dashed">
                                    <p className="text-sm text-muted-foreground font-medium">No packages configured for this network.</p>
                                    <Button variant="link" size="sm" onClick={() => {
                                        setFormData(prev => ({ ...prev, network: network as typeof NETWORKS[number] }))
                                        setIsDialogOpen(true)
                                    }} className="mt-1 h-auto py-0">
                                        Click here to add one
                                    </Button>
                                </div>
                            ) : networkPackages.map((pkg) => (
                                <Card key={pkg.id} className="hover:shadow-lg transition-shadow">
                                    <CardHeader className="pb-3">
                                        <div className="flex items-start justify-between">
                                            <div className="space-y-1">
                                                <CardTitle className="text-2xl font-bold">{pkg.size}</CardTitle>
                                                <div className="flex flex-col">
                                                    <p className="text-2xl font-bold text-primary">{formatCurrency(pkg.price)}</p>
                                                    {(pkg as any).agent_price > 0 && (
                                                        <p className="text-sm font-medium text-green-600">
                                                            Agent: {formatCurrency((pkg as any).agent_price)}
                                                        </p>
                                                    )}
                                                    {(pkg as any).dealer_price > 0 && (
                                                        <p className="text-sm font-medium text-violet-600">
                                                            Dealer: {formatCurrency((pkg as any).dealer_price)}
                                                        </p>
                                                    )}
                                                    {(pkg as any).api_price > 0 && (
                                                        <p className="text-sm font-medium text-sky-600">
                                                            API: {formatCurrency((pkg as any).api_price)}
                                                        </p>
                                                    )}
                                                </div>
                                            </div>
                                            <Switch
                                                checked={pkg.is_available}
                                                onCheckedChange={() => toggleAvailability(pkg)}
                                            />
                                        </div>
                                    </CardHeader>
                                    <CardContent className="space-y-3">
                                        <p className="text-sm text-muted-foreground line-clamp-2">
                                            {pkg.description || 'No description'}
                                        </p>
                                        <div className="flex gap-2">
                                            <Button
                                                size="sm"
                                                variant="outline"
                                                onClick={() => openEditDialog(pkg)}
                                                className="flex-1"
                                            >
                                                <Pencil className="w-4 h-4 mr-2" />
                                                Edit
                                            </Button>
                                            <Button
                                                size="sm"
                                                variant="destructive"
                                                onClick={() => handleDelete(pkg.id)}
                                                disabled={deletingId === pkg.id}
                                            >
                                                {deletingId === pkg.id ? (
                                                    <Loader2 className="w-4 h-4 animate-spin" />
                                                ) : (
                                                    <Trash2 className="w-4 h-4" />
                                                )}
                                            </Button>
                                        </div>
                                    </CardContent>
                                </Card>
                            ))}
                        </div>
                    </div>
                )
            })}

            {/* Create/Edit Dialog */}
            <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
                <DialogContent className="max-h-[90dvh] overflow-y-auto">
                    <DialogHeader>
                        <DialogTitle>
                            {editingPackage ? 'Edit Package' : 'Create Package'}
                        </DialogTitle>
                        <DialogDescription>
                            {editingPackage ? 'Update the package details' : 'Add a new data package'}
                        </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4 py-4">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <div className="space-y-2">
                                <Label>Network</Label>
                                <Select
                                    value={formData.network}
                                    onValueChange={(value: typeof NETWORKS[number]) =>
                                        setFormData(prev => ({ ...prev, network: value }))
                                    }
                                >
                                    <SelectTrigger>
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {NETWORKS.map((network) => (
                                            <SelectItem key={network} value={network}>
                                                {network}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </div>
                            <div className="space-y-2">
                                <Label>Size (e.g., 1GB, 5GB)</Label>
                                <Input
                                    value={formData.size}
                                    onChange={(e) => setFormData(prev => ({ ...prev, size: e.target.value }))}
                                    placeholder="1GB"
                                />
                            </div>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <div className="space-y-2">
                                <Label>Selling Price (GHS)</Label>
                                <Input
                                    type="number"
                                    value={formData.price}
                                    onChange={(e) => setFormData(prev => ({ ...prev, price: parseFloat(e.target.value) || 0 }))}
                                    placeholder="0.00"
                                />
                            </div>
                            <div className="space-y-2">
                                <Label>Agent Price (GHS)</Label>
                                <Input
                                    type="number"
                                    value={formData.agent_price}
                                    onChange={(e) => setFormData(prev => ({ ...prev, agent_price: parseFloat(e.target.value) || 0 }))}
                                    placeholder="0.00"
                                />
                                <p className="text-[10px] text-muted-foreground">Optional: Set specifically for agents</p>
                            </div>
                            <div className="space-y-2">
                                <Label>Dealer Price (GHS)</Label>
                                <Input
                                    type="number"
                                    value={formData.dealer_price}
                                    onChange={(e) => setFormData(prev => ({ ...prev, dealer_price: parseFloat(e.target.value) || 0 }))}
                                    placeholder="0.00"
                                />
                                <p className="text-[10px] text-muted-foreground">Optional: Set specifically for dealers</p>
                            </div>
                            <div className="space-y-2">
                                <Label>API Price (GHS)</Label>
                                <Input
                                    type="number"
                                    value={formData.api_price}
                                    onChange={(e) => setFormData(prev => ({ ...prev, api_price: e.target.value }))}
                                    placeholder="Blank = role price"
                                />
                                <p className="text-[10px] text-muted-foreground">Optional: Charged to every developer API user</p>
                            </div>
                            <div className="space-y-2">
                                <Label>Cost Price (GHS)</Label>
                                <Input
                                    type="number"
                                    value={formData.cost_price}
                                    onChange={(e) => setFormData(prev => ({ ...prev, cost_price: parseFloat(e.target.value) || 0 }))}
                                    placeholder="0.00"
                                />
                            </div>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <div className="space-y-2">
                                <Label>Sort Order</Label>
                                <Input
                                    type="number"
                                    value={formData.sort_order}
                                    onChange={(e) => setFormData(prev => ({ ...prev, sort_order: parseInt(e.target.value) || 0 }))}
                                />
                            </div>
                        </div>
                        <div className="space-y-2">
                            <Label>Description</Label>
                            <Textarea
                                value={formData.description}
                                onChange={(e) => setFormData(prev => ({ ...prev, description: e.target.value }))}
                                placeholder="Package description..."
                            />
                        </div>
                        <div className="flex items-center gap-2">
                            <Switch
                                checked={formData.is_available}
                                onCheckedChange={(checked) => setFormData(prev => ({ ...prev, is_available: checked }))}
                            />
                            <Label>Available for purchase</Label>
                        </div>
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setIsDialogOpen(false)}>
                            Cancel
                        </Button>
                        <Button onClick={handleSave} disabled={isSaving}>
                            {isSaving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                            {editingPackage ? 'Update' : 'Create'}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Network Description Dialog */}
            <Dialog open={isNetworkDescDialogOpen} onOpenChange={setIsNetworkDescDialogOpen}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Edit {editingNetwork} Description</DialogTitle>
                        <DialogDescription>
                            This description will be applied to all {editingNetwork} packages
                        </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4 py-4">
                        <div className="space-y-2">
                            <Label>Network Description</Label>
                            <Textarea
                                value={networkDescription}
                                onChange={(e) => setNetworkDescription(e.target.value)}
                                placeholder="Enter description for all packages on this network..."
                                rows={5}
                            />
                            <p className="text-xs text-muted-foreground">
                                This will update the description for all {editingNetwork} packages
                            </p>
                        </div>
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setIsNetworkDescDialogOpen(false)}>
                            Cancel
                        </Button>
                        <Button onClick={handleSaveNetworkDescription} disabled={isSavingNetworkDesc}>
                            {isSavingNetworkDesc ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                            Update All {editingNetwork} Packages
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    )
}
