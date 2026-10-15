'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Plus, Upload, RefreshCw, Loader2, Pencil, AlertTriangle, Eye, Wrench, Package, ShoppingCart, DollarSign, Clock, TrendingUp, Download, FileText, Store } from 'lucide-react'
import { toast } from 'sonner'
import { formatCurrency, formatDate } from '@/lib/utils'

interface BulkTier { min_qty: number; max_qty: number; unit_price: number }
interface RCType { id: string; name: string; customer_price: number; agent_price: number; dealer_price: number; api_price?: number | null; cost_price: number; is_active: boolean; display_order: number; created_at: string; bulk_pricing?: BulkTier[]; stock?: { available: number; reserved: number; sold: number } }
interface RCOrder { id: string; reference_code: string; customer_name: string; customer_email: string; customer_phone: string; type_name: string; quantity: number; unit_price: number; total_paid: number; status: string; payment_status: string; created_at: string; fulfilled_at: string | null }
interface Stats { revenue: number; cost: number; profit: number; totalOrders: number; completedOrders: number; pendingOrders: number; stockSummary: Array<{ id: string; name: string; available: number; sold: number; lowStock: boolean; is_active: boolean }> }

function StatusBadge({ status }: { status: string }) {
    const map: Record<string, { label: string; cls: string }> = {
        completed: { label: 'Completed', cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400' },
        pending: { label: 'Pending', cls: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400' },
        failed: { label: 'Failed', cls: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' },
        refunded: { label: 'Refunded', cls: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400' },
    }
    const c = map[status] || { label: status, cls: 'bg-gray-100 text-gray-700' }
    return <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold ${c.cls}`}>{c.label}</span>
}

export default function VouchersAdminPage() {
    const [types, setTypes] = useState<RCType[]>([])
    const [orders, setOrders] = useState<RCOrder[]>([])
    const [stats, setStats] = useState<Stats | null>(null)
    const [loading, setLoading] = useState(true)
    const [ordersLoading, setOrdersLoading] = useState(false)
    const [statsLoading, setStatsLoading] = useState(false)
    const [orderStatus, setOrderStatus] = useState('all')
    const [orderTypeId, setOrderTypeId] = useState('all')
    const [typeModal, setTypeModal] = useState(false)
    const [editingType, setEditingType] = useState<RCType | null>(null)
    const [typeForm, setTypeForm] = useState({ name: '', customer_price: '', agent_price: '', dealer_price: '', api_price: '', cost_price: '', display_order: '0' })
    const [bulkTiers, setBulkTiers] = useState<BulkTier[]>([])
    const [typeSaving, setTypeSaving] = useState(false)
    const [uploadTypeId, setUploadTypeId] = useState('')
    const [uploadFile, setUploadFile] = useState<File | null>(null)
    const [uploading, setUploading] = useState(false)
    const [pasteText, setPasteText] = useState('')
    const [uploadMode, setUploadMode] = useState<'file'|'text'>('file')
    const [orderDetail, setOrderDetail] = useState<RCOrder | null>(null)
    const [fulfilling, setFulfilling] = useState(false)
    const [storefrontRcEnabled, setStorefrontRcEnabled] = useState(false)
    const [storefrontRcToggling, setStorefrontRcToggling] = useState(false)
    const storefrontRcFetched = useRef(false)

    const fetchTypes = useCallback(async () => {
        setLoading(true)
        try {
            const res = await fetch('/api/admin/vouchers/types')
            const json = await res.json()
            if (res.ok) {
                setTypes(json.data || [])
                if (json.data?.length > 0) setUploadTypeId((prev: string) => prev || json.data[0].id)
            } else {
                toast.error(json.error || 'Failed to load voucher types')
            }
        } catch {
            toast.error('Failed to load voucher types')
        } finally { setLoading(false) }
    }, [])

    const fetchOrders = useCallback(async () => {
        setOrdersLoading(true)
        try {
            const params = new URLSearchParams()
            if (orderStatus !== 'all') params.set('status', orderStatus)
            if (orderTypeId !== 'all') params.set('type_id', orderTypeId)
            const res = await fetch(`/api/admin/vouchers/orders?${params}`)
            const json = await res.json()
            if (res.ok) setOrders(json.data || [])
        } finally { setOrdersLoading(false) }
    }, [orderStatus, orderTypeId])

    const fetchStats = useCallback(async () => {
        const res = await fetch('/api/admin/vouchers/stats')
        const json = await res.json()
        if (res.ok) setStats(json)
    }, [])

    useEffect(() => {
        fetchTypes(); fetchStats()
        if (!storefrontRcFetched.current) {
            storefrontRcFetched.current = true
            fetch('/api/admin/settings?key=storefront_rc_enabled')
                .then(r => r.json())
                .then(d => { if (d.value !== undefined) setStorefrontRcEnabled(d.value === 'true') })
                .catch(() => {})
        }
    }, [fetchTypes, fetchStats])
    useEffect(() => { fetchOrders() }, [fetchOrders])

    const openAddType = () => {
        setEditingType(null)
        setTypeForm({ name: '', customer_price: '', agent_price: '', dealer_price: '', api_price: '', cost_price: '', display_order: '0' })
        setBulkTiers([])
        setTypeModal(true)
    }
    const num = (v: number | undefined | null) => (v === undefined || v === null ? '' : String(v))
    const openEditType = (t: RCType) => {
        setEditingType(t)
        setTypeForm({ name: t.name, customer_price: num(t.customer_price), agent_price: num(t.agent_price), dealer_price: num(t.dealer_price ?? 0), api_price: num(t.api_price), cost_price: num(t.cost_price), display_order: num(t.display_order ?? 0) })
        setBulkTiers(Array.isArray(t.bulk_pricing) ? t.bulk_pricing : [])
        setTypeModal(true)
    }

    const saveType = async () => {
        if (!typeForm.name || !typeForm.customer_price || !typeForm.agent_price || !typeForm.cost_price) {
            toast.error('Name, customer price, agent price, and cost price are required'); return
        }
        const badField = (['customer_price', 'agent_price', 'dealer_price', 'api_price', 'cost_price', 'display_order'] as const)
            .find(f => typeForm[f] !== '' && !Number.isFinite(Number(typeForm[f])))
        if (badField) {
            toast.error(`${badField.replace(/_/g, ' ')} must be a valid number`); return
        }
        setTypeSaving(true)
        try {
            const url = editingType ? `/api/admin/vouchers/types/${editingType.id}` : '/api/admin/vouchers/types'
            const method = editingType ? 'PUT' : 'POST'
            const res = await fetch(url, {
                method, headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...typeForm, bulk_pricing: bulkTiers })
            })
            const json = await res.json()
            if (!res.ok) { toast.error(json.error || 'Failed to save'); return }
            toast.success(editingType ? 'Type updated' : 'Type created')
            setTypeModal(false); fetchTypes(); fetchStats()
        } catch (err: any) {
            console.error('[RC saveType]', err)
            toast.error(err?.message || 'Could not reach the server. Check your connection and try again.')
        } finally { setTypeSaving(false) }
    }

    const toggleActive = async (t: RCType) => {
        const res = await fetch(`/api/admin/vouchers/types/${t.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ is_active: !t.is_active }) })
        if (res.ok) { toast.success(t.is_active ? 'Archived' : 'Activated'); fetchTypes() }
        else toast.error('Failed to update')
    }

    
    const processUpload = async (vouchers: any[]) => {
        if (!uploadTypeId) { toast.error('Select a voucher type'); return }
        if (vouchers.length === 0) { toast.error('No valid vouchers found'); return }
        setUploading(true)
        try {
            const res = await fetch('/api/admin/vouchers/upload', { 
                method: 'POST', 
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ typeId: uploadTypeId, vouchers }) 
            })
            const json = await res.json()
            if (res.ok) { 
                toast.success(json.message || 'Upload successful'); 
                setUploadFile(null); 
                setPasteText('');
                fetchTypes(); 
                fetchStats(); 
            } else toast.error(json.error || 'Upload failed')
        } finally { setUploading(false) }
    }

    const handleFileUpload = async (e: React.FormEvent) => {
        e.preventDefault()
        if (!uploadFile) { toast.error('Select a file'); return }
        const reader = new FileReader()
        reader.onload = async (ev) => {
            try {
                const data = ev.target?.result
                const xlsx = await import('xlsx')
                const workbook = xlsx.read(data, { type: 'binary' })
                const sheet = workbook.Sheets[workbook.SheetNames[0]]
                const jsonData = xlsx.utils.sheet_to_json(sheet, { header: 1 })
                
                const parsedVouchers = []
                for (let i = 0; i < jsonData.length; i++) {
                    const row: any = jsonData[i]
                    if (!row || row.length === 0) continue
                    const pinStr = String(row[0] || '').trim()
                    if (!pinStr || pinStr.toLowerCase() === 'pin') continue
                    const serialStr = row.length > 1 ? String(row[1] || '').trim() : ''
                    parsedVouchers.push({ pin: pinStr, serial_number: serialStr !== 'serial_number' ? serialStr : '' })
                }
                processUpload(parsedVouchers)
            } catch (err) { toast.error('Failed to parse file. Make sure it is a valid CSV or Excel file.') }
        }
        reader.readAsBinaryString(uploadFile)
    }

    const handleTextUpload = async (e: React.FormEvent) => {
        e.preventDefault()
        if (!pasteText.trim()) { toast.error('Paste some text first'); return }
        const lines = pasteText.split('\n')
        const parsedVouchers = []
        for (const line of lines) {
            const cleanLine = line.trim()
            if (!cleanLine) continue
            const parts = cleanLine.split(/[\t,]+/)
            let pin = parts[0].trim()
            let serial = parts.length > 1 ? parts[1].trim() : ''
            if (parts.length === 1 && cleanLine.includes(' ')) {
                const spaceParts = cleanLine.split(/\s+/)
                pin = spaceParts[0]; serial = spaceParts.length > 1 ? spaceParts[1] : ''
            }
            if (pin.toLowerCase() !== 'pin') parsedVouchers.push({ pin, serial_number: serial !== 'serial_number' ? serial : '' })
        }
        processUpload(parsedVouchers)
    }

    const downloadTemplate = (type: 'csv' | 'xlsx') => {
        import('xlsx').then(xlsx => {
            const ws = xlsx.utils.json_to_sheet([{ pin: '123456789012', serial_number: 'SN123456' }])
            const wb = xlsx.utils.book_new(); xlsx.utils.book_append_sheet(wb, ws, "Template")
            xlsx.writeFile(wb, `voucher_template.${type}`)
        })
    }

    const toggleStorefrontRc = async () => {
        setStorefrontRcToggling(true)
        try {
            const newVal = !storefrontRcEnabled
            const res = await fetch('/api/admin/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ key: 'storefront_rc_enabled', value: String(newVal) })
            })
            if (res.ok) {
                setStorefrontRcEnabled(newVal)
                toast.success(newVal ? 'Results Checker enabled on storefronts' : 'Results Checker disabled on storefronts')
            } else {
                toast.error('Failed to update setting')
            }
        } finally {
            setStorefrontRcToggling(false)
        }
    }

    const manualFulfill = async (orderId: string) => {
        setFulfilling(true)
        try {
            const res = await fetch(`/api/admin/vouchers/orders/${orderId}/fulfill`, { method: 'POST' })
            const json = await res.json()
            if (res.ok) { toast.success(`Fulfilled ${json.fulfilled} voucher(s)`); setOrderDetail(null); fetchOrders(); fetchStats() }
            else toast.error(json.error || 'Fulfillment failed')
        } finally { setFulfilling(false) }
    }

    return (
        <div className="flex-1 space-y-6 p-4 md:p-8 pt-6">
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-3xl font-bold tracking-tight">Results Checker</h1>
                    <p className="text-muted-foreground text-sm mt-1">Manage voucher types, inventory, and sales</p>
                </div>
                <Button onClick={() => { fetchTypes(); fetchOrders(); fetchStats() }} variant="outline" size="sm">
                    <RefreshCw className="w-4 h-4 mr-2" /> Refresh
                </Button>
            </div>

            {stats && (
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    {[
                        { label: 'Revenue', value: formatCurrency(stats.revenue), icon: DollarSign, color: 'text-emerald-600' },
                        { label: 'Profit', value: formatCurrency(stats.profit), icon: TrendingUp, color: 'text-blue-600' },
                        { label: 'Orders', value: stats.totalOrders, icon: ShoppingCart, color: 'text-violet-600' },
                        { label: 'Pending', value: stats.pendingOrders, icon: Clock, color: 'text-yellow-600' },
                    ].map(s => (
                        <Card key={s.label} className="border-border/50">
                            <CardContent className="pt-4 pb-4">
                                <div className="flex items-center justify-between">
                                    <div>
                                        <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">{s.label}</p>
                                        <p className="text-2xl font-bold mt-1">{s.value}</p>
                                    </div>
                                    <s.icon className={"w-8 h-8  opacity-80"} />
                                </div>
                            </CardContent>
                        </Card>
                    ))}
                </div>
            )}

            {/* Storefront RC Toggle */}
            <Card className="border-border/50">
                <CardContent className="py-4">
                    <div className="flex items-center justify-between gap-4">
                        <div className="flex items-start gap-3">
                            <div className="w-10 h-10 rounded-full bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center flex-shrink-0">
                                <Store className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />
                            </div>
                            <div>
                                <p className="font-semibold text-sm">Results Checker on Storefronts</p>
                                <p className="text-xs text-muted-foreground mt-0.5">
                                    When enabled, shop owners can set RC prices and storefront customers can buy vouchers directly.
                                </p>
                            </div>
                        </div>
                        <div className="flex items-center gap-3 flex-shrink-0">
                            <span className={"text-xs font-semibold "}>
                                {storefrontRcEnabled ? 'Enabled' : 'Disabled'}
                            </span>
                            {storefrontRcToggling ? (
                                <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                            ) : (
                                <Switch checked={storefrontRcEnabled} onCheckedChange={toggleStorefrontRc} />
                            )}
                        </div>
                    </div>
                </CardContent>
            </Card>

            <Tabs defaultValue="types" className="space-y-4">
                <TabsList className="grid grid-cols-4 w-full max-w-lg">
                    <TabsTrigger value="types">Types</TabsTrigger>
                    <TabsTrigger value="inventory">Inventory</TabsTrigger>
                    <TabsTrigger value="orders">Orders</TabsTrigger>
                    <TabsTrigger value="analytics">Analytics</TabsTrigger>
                </TabsList>

                <TabsContent value="types" className="space-y-4">
                    <div className="flex items-center justify-between">
                        <h2 className="text-lg font-semibold">Voucher Types</h2>
                        <Button onClick={openAddType} size="sm"><Plus className="w-4 h-4 mr-2" />Add Type</Button>
                    </div>
                    {loading ? (
                        <div className="flex items-center justify-center py-12"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
                    ) : types.length === 0 ? (
                        <Card><CardContent className="py-12 text-center text-muted-foreground">No voucher types yet. Create one to get started.</CardContent></Card>
                    ) : (
                        <div className="grid gap-3">
                            {types.map(t => (
                                <Card key={t.id} className={`border-border/50 transition-opacity ${!t.is_active ? 'opacity-50' : ''}`}>
                                    <CardContent className="py-4">
                                        <div className="flex items-center justify-between gap-4">
                                            <div className="flex items-center gap-3 min-w-0">
                                                <div className="flex-shrink-0 w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
                                                    <Package className="w-5 h-5 text-primary" />
                                                </div>
                                                <div className="min-w-0">
                                                    <div className="flex items-center gap-2 flex-wrap">
                                                        <span className="font-semibold">{t.name}</span>
                                                        {!t.is_active && <Badge variant="secondary" className="text-xs">Archived</Badge>}
                                                        {t.stock && t.stock.available < 10 && t.is_active && (
                                                            <Badge className="bg-orange-100 text-orange-700 text-xs border-0">
                                                                <AlertTriangle className="w-3 h-3 mr-1" />Low Stock
                                                            </Badge>
                                                        )}
                                                    </div>
                                                    <div className="text-xs text-muted-foreground mt-0.5 flex gap-3 flex-wrap">
                                                        <span>Customer: <b className="text-foreground">{formatCurrency(t.customer_price)}</b></span>
                                                        <span>Agent: <b className="text-foreground">{formatCurrency(t.agent_price)}</b></span>
                                                        <span>Dealer: <b className="text-foreground">{formatCurrency(t.dealer_price || 0)}</b></span>
                                                        {Number(t.api_price) > 0 && (
                                                            <span>API: <b className="text-foreground">{formatCurrency(Number(t.api_price))}</b></span>
                                                        )}
                                                        <span>Cost: <b className="text-foreground">{formatCurrency(t.cost_price)}</b></span>
                                                        {Array.isArray(t.bulk_pricing) && t.bulk_pricing.length > 0 && (
                                                            <span className="text-amber-600 dark:text-amber-400 font-semibold">
                                                                Bulk tiers: {t.bulk_pricing.map((tier, i) => `${tier.min_qty}-${tier.max_qty}@${formatCurrency(tier.unit_price)}`).join(', ')}
                                                            </span>
                                                        )}
                                                    </div>
                                                </div>
                                            </div>
                                            <div className="flex items-center gap-4 flex-shrink-0">
                                                {t.stock && (
                                                    <div className="hidden md:flex gap-3 text-xs text-center">
                                                        <div><div className="font-bold text-emerald-600">{t.stock.available}</div><div className="text-muted-foreground">Available</div></div>
                                                        <div><div className="font-bold text-yellow-600">{t.stock.reserved}</div><div className="text-muted-foreground">Reserved</div></div>
                                                        <div><div className="font-bold text-blue-600">{t.stock.sold}</div><div className="text-muted-foreground">Sold</div></div>
                                                    </div>
                                                )}
                                                <div className="flex items-center gap-2">
                                                    <Button variant="ghost" size="icon" onClick={() => openEditType(t)}><Pencil className="w-4 h-4" /></Button>
                                                    <Switch checked={t.is_active} onCheckedChange={() => toggleActive(t)} />
                                                </div>
                                            </div>
                                        </div>
                                    </CardContent>
                                </Card>
                            ))}
                        </div>
                    )}
                </TabsContent>
                <TabsContent value="inventory" className="space-y-4">
                    <div className="flex items-center justify-between">
                        <h2 className="text-lg font-semibold">Upload Inventory</h2>
                        <div className="flex gap-2">
                            <Button variant="outline" size="sm" onClick={() => downloadTemplate('csv')}><Download className="w-4 h-4 mr-2"/>CSV Template</Button>
                            <Button variant="outline" size="sm" onClick={() => downloadTemplate('xlsx')}><Download className="w-4 h-4 mr-2"/>Excel Template</Button>
                        </div>
                    </div>
                    
                    <Card className="border-border/50">
                        <CardHeader className="pb-2 border-b border-border/30 mb-4">
                            <div className="flex gap-4">
                                <button type="button" onClick={() => setUploadMode('file')} className={`pb-2 text-sm font-semibold ${uploadMode === 'file' ? 'border-b-2 border-primary text-primary' : 'text-muted-foreground'}`}>File Upload (CSV/Excel)</button>
                                <button type="button" onClick={() => setUploadMode('text')} className={`pb-2 text-sm font-semibold ${uploadMode === 'text' ? 'border-b-2 border-primary text-primary' : 'text-muted-foreground'}`}>Paste Text</button>
                            </div>
                        </CardHeader>
                        <CardContent>
                            <div className="mb-4 space-y-1.5 max-w-md">
                                <Label>Voucher Type <span className="text-red-500">*</span></Label>
                                <Select value={uploadTypeId} onValueChange={setUploadTypeId}>
                                    <SelectTrigger><SelectValue placeholder="Select type to upload into..." /></SelectTrigger>
                                    <SelectContent>
                                        {types.map(t => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}
                                    </SelectContent>
                                </Select>
                            </div>
                            
                            {uploadMode === 'file' ? (
                                <form onSubmit={handleFileUpload} className="space-y-4">
                                    <div className="space-y-1.5">
                                        <Label>Select File (.csv, .xlsx, .xls)</Label>
                                        <Input type="file" accept=".csv,.xlsx,.xls" onChange={e => setUploadFile(e.target.files?.[0] || null)} className="max-w-md file:mr-3 file:py-1 file:px-3 file:rounded file:border-0 file:text-sm file:bg-primary/10 file:text-primary cursor-pointer" />
                                        {uploadFile && <p className="text-xs text-muted-foreground mt-1">Selected: {uploadFile.name} ({(uploadFile.size / 1024).toFixed(1)} KB)</p>}
                                    </div>
                                    <Button type="submit" disabled={uploading || !uploadFile || !uploadTypeId}>
                                        {uploading ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Processing...</> : <><Upload className="w-4 h-4 mr-2" />Upload File</>}
                                    </Button>
                                </form>
                            ) : (
                                <form onSubmit={handleTextUpload} className="space-y-4">
                                    <div className="space-y-1.5">
                                        <Label>Paste PINs and Serials</Label>
                                        <p className="text-xs text-muted-foreground mb-2">Format: `PIN,SerialNumber` or `PIN` per line. Separated by comma, tab, or space.</p>
                                        <textarea 
                                            value={pasteText} 
                                            onChange={e => setPasteText(e.target.value)} 
                                            className="flex min-h-[200px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 font-mono"
                                            placeholder="123456789012,SN001&#10;987654321098,SN002&#10;555555555555"
                                        />
                                    </div>
                                    <Button type="submit" disabled={uploading || !pasteText.trim() || !uploadTypeId}>
                                        {uploading ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Processing...</> : <><FileText className="w-4 h-4 mr-2" />Process Text</>}
                                    </Button>
                                </form>
                            )}
                        </CardContent>
                    </Card>

                    <h2 className="text-lg font-semibold mt-6">Stock Levels</h2>
                    <div className="grid md:grid-cols-2 gap-3">
                        {types.map(t => (
                            <Card key={t.id} className={`border-border/50 ${!t.is_active ? 'opacity-50' : ''}`}>
                                <CardContent className="py-4">
                                    <div className="flex items-center justify-between mb-2">
                                        <span className="font-semibold text-sm">{t.name}</span>
                                        {t.stock && t.stock.available < 10 && t.is_active && (
                                            <Badge className="bg-orange-100 text-orange-700 border-0 text-xs"><AlertTriangle className="w-3 h-3 mr-1" />Low</Badge>
                                        )}
                                        {!t.is_active && <Badge variant="secondary" className="text-xs">Archived</Badge>}
                                    </div>
                                    {t.stock ? (
                                        <div className="grid grid-cols-3 gap-2 text-center">
                                            <div className="bg-emerald-50 dark:bg-emerald-900/20 rounded-lg p-2">
                                                <div className="text-lg font-bold text-emerald-600">{t.stock.available}</div>
                                                <div className="text-xs text-muted-foreground">Available</div>
                                            </div>
                                            <div className="bg-yellow-50 dark:bg-yellow-900/20 rounded-lg p-2">
                                                <div className="text-lg font-bold text-yellow-600">{t.stock.reserved}</div>
                                                <div className="text-xs text-muted-foreground">Reserved</div>
                                            </div>
                                            <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-2">
                                                <div className="text-lg font-bold text-blue-600">{t.stock.sold}</div>
                                                <div className="text-xs text-muted-foreground">Sold</div>
                                            </div>
                                        </div>
                                    ) : <p className="text-xs text-muted-foreground">Loading stock...</p>}
                                </CardContent>
                            </Card>
                        ))}
                    </div>
                </TabsContent>

                <TabsContent value="orders" className="space-y-4">
                    <div className="flex items-center justify-between flex-wrap gap-3">
                        <h2 className="text-lg font-semibold">Sales Orders</h2>
                        <div className="flex gap-2 flex-wrap">
                            <Select value={orderStatus} onValueChange={setOrderStatus}>
                                <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="all">All Statuses</SelectItem>
                                    <SelectItem value="completed">Completed</SelectItem>
                                    <SelectItem value="pending">Pending</SelectItem>
                                    <SelectItem value="failed">Failed</SelectItem>
                                </SelectContent>
                            </Select>
                            <Select value={orderTypeId} onValueChange={setOrderTypeId}>
                                <SelectTrigger className="w-44"><SelectValue placeholder="All Types" /></SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="all">All Types</SelectItem>
                                    {types.map(t => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}
                                </SelectContent>
                            </Select>
                        </div>
                    </div>

                    {ordersLoading ? (
                        <div className="flex items-center justify-center py-12"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
                    ) : orders.length === 0 ? (
                        <Card><CardContent className="py-12 text-center text-muted-foreground">No orders found.</CardContent></Card>
                    ) : (
                        <div className="rounded-lg border border-border/50 overflow-hidden">
                            <table className="w-full text-sm">
                                <thead className="bg-muted/40">
                                    <tr>
                                        {['Reference', 'Customer', 'Type', 'Qty', 'Amount', 'Status', 'Date', ''].map(h => (
                                            <th key={h} className="px-3 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wide">{h}</th>
                                        ))}
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-border/30">
                                    {orders.map(o => (
                                        <tr key={o.id} className="hover:bg-muted/20 transition-colors">
                                            <td className="px-3 py-3 font-mono text-xs text-muted-foreground">{o.reference_code}</td>
                                            <td className="px-3 py-3">
                                                <div className="font-medium text-xs">{o.customer_name || 'â€”'}</div>
                                                <div className="text-xs text-muted-foreground">{o.customer_phone || o.customer_email || ''}</div>
                                            </td>
                                            <td className="px-3 py-3 text-xs">{o.type_name}</td>
                                            <td className="px-3 py-3 text-xs text-center">{o.quantity}</td>
                                            <td className="px-3 py-3 text-xs font-semibold">{formatCurrency(o.total_paid)}</td>
                                            <td className="px-3 py-3"><StatusBadge status={o.status} /></td>
                                            <td className="px-3 py-3 text-xs text-muted-foreground whitespace-nowrap">{formatDate(o.created_at)}</td>
                                            <td className="px-3 py-3">
                                                <Button variant="ghost" size="icon" onClick={() => setOrderDetail(o)} title="View details">
                                                    <Eye className="w-4 h-4" />
                                                </Button>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </TabsContent>
                <TabsContent value="analytics" className="space-y-4">
                    <h2 className="text-lg font-semibold">Analytics & Stock Alerts</h2>
                    {statsLoading || !stats ? (
                        <div className="flex items-center justify-center py-12"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
                    ) : (
                        <>
                            <div className="grid md:grid-cols-3 gap-4">
                                <Card className="border-border/50">
                                    <CardContent className="pt-4">
                                        <p className="text-xs text-muted-foreground uppercase tracking-wide font-medium">Total Revenue</p>
                                        <p className="text-3xl font-bold mt-1 text-emerald-600">{formatCurrency(stats.revenue)}</p>
                                    </CardContent>
                                </Card>
                                <Card className="border-border/50">
                                    <CardContent className="pt-4">
                                        <p className="text-xs text-muted-foreground uppercase tracking-wide font-medium">Total Cost</p>
                                        <p className="text-3xl font-bold mt-1 text-red-500">{formatCurrency(stats.cost)}</p>
                                    </CardContent>
                                </Card>
                                <Card className="border-border/50">
                                    <CardContent className="pt-4">
                                        <p className="text-xs text-muted-foreground uppercase tracking-wide font-medium">Gross Profit</p>
                                        <p className="text-3xl font-bold mt-1 text-blue-600">{formatCurrency(stats.profit)}</p>
                                    </CardContent>
                                </Card>
                            </div>

                            <h3 className="font-semibold text-sm mt-2">Per-Type Breakdown</h3>
                            <div className="rounded-lg border border-border/50 overflow-hidden">
                                <table className="w-full text-sm">
                                    <thead className="bg-muted/40">
                                        <tr>
                                            {['Type', 'Available', 'Sold', 'Status'].map(h => (
                                                <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wide">{h}</th>
                                            ))}
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-border/30">
                                        {stats.stockSummary.map(s => (
                                            <tr key={s.id} className="hover:bg-muted/20">
                                                <td className="px-4 py-3 font-medium text-sm">{s.name}</td>
                                                <td className="px-4 py-3">
                                                    <span className={`font-bold ${s.available < 10 ? 'text-orange-600' : 'text-emerald-600'}`}>{s.available}</span>
                                                    {s.lowStock && <span className="ml-2 text-xs text-orange-500">? Low</span>}
                                                </td>
                                                <td className="px-4 py-3 text-blue-600 font-bold">{s.sold}</td>
                                                <td className="px-4 py-3">
                                                    {s.is_active ? <span className="text-xs text-emerald-600 font-semibold">Active</span> : <span className="text-xs text-muted-foreground">Archived</span>}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </>
                    )}
                </TabsContent>
            </Tabs>

            <Dialog open={typeModal} onOpenChange={setTypeModal}>
                <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
                    <DialogHeader>
                        <DialogTitle>{editingType ? 'Edit Voucher Type' : 'Add Voucher Type'}</DialogTitle>
                    </DialogHeader>
                    <div className="space-y-4 py-2">
                        <div className="space-y-1.5">
                            <Label>Name <span className="text-red-500">*</span></Label>
                            <Input placeholder="e.g. WAEC 2026" value={typeForm.name} onChange={e => setTypeForm(f => ({ ...f, name: e.target.value }))} />
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                            <div className="space-y-1.5">
                                <Label>Customer Price <span className="text-red-500">*</span></Label>
                                <Input type="number" step="0.01" placeholder="0.00" value={typeForm.customer_price} onChange={e => setTypeForm(f => ({ ...f, customer_price: e.target.value }))} />
                            </div>
                            <div className="space-y-1.5">
                                <Label>Agent Price <span className="text-red-500">*</span></Label>
                                <Input type="number" step="0.01" placeholder="0.00" value={typeForm.agent_price} onChange={e => setTypeForm(f => ({ ...f, agent_price: e.target.value }))} />
                            </div>
                            <div className="space-y-1.5">
                                <Label>Dealer Price</Label>
                                <Input type="number" step="0.01" placeholder="0.00" value={typeForm.dealer_price} onChange={e => setTypeForm(f => ({ ...f, dealer_price: e.target.value }))} />
                            </div>
                            <div className="space-y-1.5">
                                <Label>API Price</Label>
                                <Input type="number" step="0.01" placeholder="Blank = role price" value={typeForm.api_price} onChange={e => setTypeForm(f => ({ ...f, api_price: e.target.value }))} />
                                <p className="text-[11px] text-muted-foreground">Charged to every developer API user</p>
                            </div>
                            <div className="space-y-1.5">
                                <Label>Cost Price <span className="text-red-500">*</span></Label>
                                <Input type="number" step="0.01" placeholder="0.00" value={typeForm.cost_price} onChange={e => setTypeForm(f => ({ ...f, cost_price: e.target.value }))} />
                            </div>
                        </div>
                        <p className="text-xs text-muted-foreground">Selling prices must be ≥ cost price.</p>

                        {/* Bulk Pricing Tiers Editor */}
                        <div className="pt-2 border-t border-border/50">
                            <div className="flex items-center justify-between mb-3">
                                <div>
                                    <p className="text-xs font-bold text-amber-600 dark:text-amber-400 uppercase tracking-wider">Bulk Pricing Tiers</p>
                                    <p className="text-xs text-muted-foreground mt-0.5">Buying more → lower unit price. No proration: all units get the tier rate.</p>
                                </div>
                                <Button
                                    type="button" variant="outline" size="sm"
                                    className="border-amber-300 text-amber-700 hover:bg-amber-50 dark:border-amber-700 dark:text-amber-400"
                                    onClick={() => setBulkTiers(prev => [...prev, { min_qty: 0, max_qty: 0, unit_price: 0 }])}
                                >
                                    <Plus className="w-3 h-3 mr-1" /> Add Tier
                                </Button>
                            </div>

                            {bulkTiers.length === 0 ? (
                                <p className="text-xs text-muted-foreground italic py-2">No tiers — all quantities use standard price above.</p>
                            ) : (
                                <div className="space-y-2">
                                    <div className="grid grid-cols-[1fr_1fr_1fr_auto] gap-2 text-xs font-semibold text-muted-foreground px-1">
                                        <span>Min Qty</span><span>Max Qty</span><span>Unit Price (GHS)</span><span></span>
                                    </div>
                                    {bulkTiers.map((tier, i) => (
                                        <div key={i} className="grid grid-cols-[1fr_1fr_1fr_auto] gap-2 items-center bg-amber-50/50 dark:bg-amber-900/10 border border-amber-200 dark:border-amber-800/50 rounded-lg px-2 py-1.5">
                                            <Input
                                                type="number" min="1" placeholder="5" value={tier.min_qty || ''}
                                                onChange={e => setBulkTiers(prev => prev.map((t, j) => j === i ? { ...t, min_qty: parseInt(e.target.value) || 0 } : t))}
                                                className="h-8 text-sm"
                                            />
                                            <Input
                                                type="number" min="1" placeholder="50" value={tier.max_qty || ''}
                                                onChange={e => setBulkTiers(prev => prev.map((t, j) => j === i ? { ...t, max_qty: parseInt(e.target.value) || 0 } : t))}
                                                className="h-8 text-sm"
                                            />
                                            <Input
                                                type="number" step="0.01" placeholder="0.00" value={tier.unit_price || ''}
                                                onChange={e => setBulkTiers(prev => prev.map((t, j) => j === i ? { ...t, unit_price: parseFloat(e.target.value) || 0 } : t))}
                                                className="h-8 text-sm"
                                            />
                                            <button
                                                type="button"
                                                onClick={() => setBulkTiers(prev => prev.filter((_, j) => j !== i))}
                                                className="w-7 h-7 flex items-center justify-center rounded-md text-red-400 hover:bg-red-100 dark:hover:bg-red-900/30 transition-colors"
                                            >
                                                ✕
                                            </button>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>

                        <div className="space-y-1.5">
                            <Label>Display Order</Label>
                            <Input type="number" value={typeForm.display_order} onChange={e => setTypeForm(f => ({ ...f, display_order: e.target.value }))} />
                        </div>
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setTypeModal(false)}>Cancel</Button>
                        <Button onClick={saveType} disabled={typeSaving}>
                            {typeSaving ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Saving...</> : 'Save'}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <Dialog open={!!orderDetail} onOpenChange={v => !v && setOrderDetail(null)}>
                <DialogContent className="sm:max-w-lg">
                    <DialogHeader>
                        <DialogTitle>Order Details</DialogTitle>
                    </DialogHeader>
                    {orderDetail && (
                        <div className="space-y-4 py-2">
                            <div className="grid grid-cols-2 gap-3 text-sm">
                                <div><span className="text-muted-foreground">Reference</span><p className="font-mono font-semibold">{orderDetail.reference_code}</p></div>
                                <div><span className="text-muted-foreground">Status</span><p><StatusBadge status={orderDetail.status} /></p></div>
                                <div><span className="text-muted-foreground">Customer</span><p className="font-medium">{orderDetail.customer_name || 'â€”'}</p></div>
                                <div><span className="text-muted-foreground">Phone</span><p>{orderDetail.customer_phone || 'â€”'}</p></div>
                                <div><span className="text-muted-foreground">Type</span><p>{orderDetail.type_name}</p></div>
                                <div><span className="text-muted-foreground">Quantity</span><p className="font-bold">{orderDetail.quantity}</p></div>
                                <div><span className="text-muted-foreground">Total Paid</span><p className="font-bold text-emerald-600">{formatCurrency(orderDetail.total_paid)}</p></div>
                                <div><span className="text-muted-foreground">Date</span><p>{formatDate(orderDetail.created_at)}</p></div>
                            </div>
                            {orderDetail.status !== 'completed' && orderDetail.payment_status === 'completed' && (
                                <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg p-3">
                                    <p className="text-sm font-medium text-yellow-800 dark:text-yellow-300 flex items-center gap-2">
                                        <AlertTriangle className="w-4 h-4" />Payment received but vouchers not yet assigned
                                    </p>
                                    <Button size="sm" className="mt-2 bg-yellow-600 hover:bg-yellow-700 text-white" onClick={() => manualFulfill(orderDetail.id)} disabled={fulfilling}>
                                        {fulfilling ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Fulfilling...</> : <><Wrench className="w-4 h-4 mr-2" />Manually Fulfill</>}
                                    </Button>
                                </div>
                            )}
                        </div>
                    )}
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setOrderDetail(null)}>Close</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    )
}

