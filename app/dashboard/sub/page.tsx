'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import type { BrandConfig } from '@/lib/brand-context'
import { ShopAnnouncementBox } from '@/components/dashboard/ShopAnnouncementBox'
import { cn, formatCurrency } from '@/lib/utils'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  AlertCircle,
  ArrowDownToLine,
  BadgeCheck,
  ClipboardList,
  Clock,
  ExternalLink,
  LifeBuoy,
  Package,
  Phone,
  Receipt,
  Settings,
  Store,
  Tag,
  TrendingUp,
  Users,
  Wallet,
} from 'lucide-react'

interface SubDashboardData {
  status: 'pending' | 'active' | 'suspended'
  canRecruit?: boolean
  walletBalance: number
  totalEarned: number
  totalWithdrawn: number
  uplineShop: {
    shopName: string
    contactName?: string | null
    contactPhone?: string | null
  }
  ownShopSlug?: string | null
  brandConfig?: BrandConfig
}

const NETWORKS = ['MTN MoMo', 'Telecel Cash', 'AirtelTigo Money'] as const

const STATUS_DISPLAY = {
  active: { label: 'Active', icon: BadgeCheck, color: 'bg-emerald-500' },
  pending: { label: 'Pending', icon: Clock, color: 'bg-amber-500' },
  suspended: { label: 'Suspended', icon: AlertCircle, color: 'bg-red-500' },
} as const

export default function SubDashboard() {
  const [data, setData] = useState<SubDashboardData | null>(null)
  const [brand, setBrand] = useState<BrandConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Withdrawal modal state
  const [showWithdraw, setShowWithdraw] = useState(false)
  const [wAmount, setWAmount] = useState('')
  const [wNetwork, setWNetwork] = useState<(typeof NETWORKS)[number]>('MTN MoMo')
  const [wMomo, setWMomo] = useState('')
  const [wName, setWName] = useState('')
  const [wSubmitting, setWSubmitting] = useState(false)
  const [wError, setWError] = useState<string | null>(null)
  const [wSuccess, setWSuccess] = useState<string | null>(null)

  useEffect(() => {
    fetchDashboardData()
  }, [])

  const openWithdraw = () => {
    setWError(null)
    setWSuccess(null)
    setWAmount('')
    setWMomo('')
    setWName('')
    setWNetwork('MTN MoMo')
    setShowWithdraw(true)
  }

  const submitWithdrawal = async () => {
    setWError(null)
    const amountNum = parseFloat(wAmount)
    if (!amountNum || amountNum <= 0) {
      setWError('Enter a valid amount')
      return
    }
    if (amountNum > (data?.walletBalance || 0)) {
      setWError('Amount exceeds your wallet balance')
      return
    }
    if (!wMomo.trim() || !wName.trim()) {
      setWError('Enter the MoMo number and account name')
      return
    }

    setWSubmitting(true)
    try {
      const res = await fetch('/api/dashboard/sub/withdraw', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amount: amountNum,
          momoNumber: wMomo.trim(),
          network: wNetwork,
          accountName: wName.trim(),
        }),
      })
      const result = await res.json().catch(() => null)
      if (!res.ok) {
        throw new Error(result?.details?.[0] || result?.error || 'Withdrawal failed')
      }
      setWSuccess(result?.message || 'Withdrawal request submitted.')
      await fetchDashboardData()
    } catch (err: any) {
      setWError(err.message || 'Withdrawal failed')
    } finally {
      setWSubmitting(false)
    }
  }

  const fetchDashboardData = async () => {
    try {
      // Fetch sub-specific data (includes brand context)
      const response = await fetch('/api/dashboard/sub/data')
      const dashData = await response.json()

      if (response.ok) {
        setData(dashData)
        if (dashData.brandConfig) {
          setBrand(dashData.brandConfig)
        }
      } else {
        setError(dashData.error || 'Failed to load dashboard')
      }
    } catch (err) {
      setError('An error occurred')
      console.error(err)
    } finally {
      setLoading(false)
    }
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-9 w-48" />
        <Skeleton className="h-44 w-full rounded-2xl" />
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => (
            <Card key={i}>
              <CardContent className="p-6">
                <Skeleton className="h-4 w-24 mb-2" />
                <Skeleton className="h-8 w-16" />
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    )
  }

  if (error || !data) {
    return (
      <Card className="border-destructive/30 bg-destructive/5">
        <CardContent className="p-6 flex items-center gap-3 text-destructive">
          <AlertCircle className="w-5 h-5 shrink-0" />
          <p className="font-semibold">{error || 'Failed to load dashboard'}</p>
        </CardContent>
      </Card>
    )
  }

  const isActive = data.status === 'active'
  const status = STATUS_DISPLAY[data.status] ?? STATUS_DISPLAY.pending

  const quickLinks = [
    { href: '/dashboard/data-packages', label: 'Buy Data Bundles', icon: Package },
    { href: '/dashboard/airtime', label: 'Buy Airtime', icon: Phone },
    { href: '/dashboard/sub/utilities', label: 'Pay Bills', icon: Receipt },
    { href: '/dashboard/sub/rc', label: 'Results Checker', icon: Tag },
    { href: '/dashboard/sub/orders', label: 'My Orders', icon: ClipboardList },
    { href: '/dashboard/sub/storefront-orders', label: 'Storefront Orders', icon: Store },
    // The balance above is the shop earnings wallet; buying runs off the
    // main wallet, which is topped up on its own page.
    { href: '/dashboard/wallet', label: 'Top Up Main Wallet', icon: Wallet },
    ...(data.canRecruit
      ? [{ href: '/dashboard/sub/sub-agents', label: 'My Sub-Agents', icon: Users }]
      : []),
    { href: '/dashboard/sub/profile', label: 'Settings', icon: Settings },
  ]

  return (
    <div className="space-y-8 animate-slow-fade">
      {/* Header with branding */}
      <div className="flex items-center gap-4">
        {brand?.logo && (
          <img
            src={brand.logo}
            alt={brand.shopName}
            className="h-12 w-12 rounded-xl object-contain border border-border/70 bg-card shrink-0"
          />
        )}
        <div className="min-w-0">
          <h2 className="text-2xl sm:text-3xl font-black tracking-tight text-foreground">
            Dashboard
          </h2>
          <p className="text-sm font-medium text-muted-foreground mt-1 truncate">
            Selling under <span className="font-bold text-foreground">{data.uplineShop.shopName}</span>
          </p>
        </div>
      </div>

      {data.status === 'pending' && (
        <Card className="border-amber-300/70 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-900">
          <CardContent className="p-5 flex items-start gap-3">
            <div className="w-10 h-10 rounded-xl bg-amber-500 text-white flex items-center justify-center shrink-0">
              <Clock className="w-5 h-5" />
            </div>
            <div>
              <p className="font-black text-amber-900 dark:text-amber-200">Pending approval</p>
              <p className="text-sm text-amber-800 dark:text-amber-300 mt-0.5">
                Your account is waiting for approval from <strong>{data.uplineShop.shopName}</strong>.
                You can start using your wallet once approved.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* No storefront yet — the one thing a new sub must do.
          A sub-agent sells through their OWN storefront, not their upline's, so
          until this exists they have nothing to send customers to. It used to be
          one of three equal tiles further down the page, which is easy to miss
          on the screen a recruit lands on first. */}
      {!data.ownShopSlug && (
        <Card className="border-2 border-dashed border-primary/40 bg-primary/5">
          <CardContent className="p-5 flex flex-col sm:flex-row sm:items-center gap-4">
            <div className="w-12 h-12 rounded-2xl bg-primary text-primary-foreground flex items-center justify-center shrink-0 shadow-lg">
              <Store className="w-6 h-6" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-black text-foreground">You don&apos;t have a storefront yet</p>
              <p className="text-sm text-muted-foreground mt-1">
                Create your own shop to get a link you can share with customers. Your
                prices and profit are yours — {data.uplineShop.shopName}&apos;s prices are
                only the floor.
              </p>
            </div>
            <Link href="/dashboard/sub/shop" className="shrink-0">
              <Button className="w-full sm:w-auto font-bold rounded-xl h-11 px-6">Create my shop</Button>
            </Link>
          </CardContent>
        </Card>
      )}

      {/* Earnings wallet & shop card */}
      <div className="grid lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-2 overflow-hidden border border-border/70 shadow-sm bg-gradient-to-br from-primary to-blue-700 dark:to-blue-800">
          <CardContent className="p-8 relative">
            {/* Decorative pattern */}
            <div className="absolute top-0 right-0 w-64 h-64 bg-white/10 rounded-full blur-3xl -mr-32 -mt-32 pointer-events-none" />
            <div className="absolute bottom-0 left-0 w-32 h-32 bg-black/20 rounded-full blur-2xl -ml-16 -mb-16 pointer-events-none" />

            <div className="relative z-10 flex flex-col md:flex-row md:items-center justify-between gap-8">
              <div>
                <div className="flex items-center gap-2 mb-3 opacity-90">
                  <div className="w-8 h-8 rounded-lg bg-white/20 flex items-center justify-center">
                    <Wallet className="w-4 h-4 text-primary-foreground" />
                  </div>
                  <p className="text-primary-foreground font-bold tracking-widest text-xs uppercase">
                    Earnings Balance
                  </p>
                </div>
                <p className="text-5xl md:text-6xl font-black text-primary-foreground tracking-tighter">
                  {formatCurrency(data.walletBalance || 0)}
                </p>
                <p className="text-sm text-primary-foreground/80 font-medium mt-2">
                  Profit from your storefront sales
                </p>
              </div>

              <Button
                variant="outline"
                onClick={openWithdraw}
                disabled={!isActive}
                className="w-full md:w-auto bg-white text-primary hover:bg-white/90 border-0 font-black h-14 px-10 rounded-2xl shadow-xl shadow-black/15 text-lg transition-all hover:scale-[1.02] active:scale-95"
              >
                <ArrowDownToLine className="w-6 h-6 mr-2 stroke-[3]" />
                Withdraw
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card className="card-premium p-8 flex flex-col justify-between group overflow-hidden relative bg-card">
          <div className="absolute top-0 right-0 p-4 opacity-5 group-hover:opacity-10 transition-opacity">
            <Store className="w-24 h-24" />
          </div>
          <div className="relative z-10">
            <p className="text-[10px] font-black uppercase tracking-[0.2em] text-muted-foreground mb-4">Storefront</p>
            <h3 className="text-2xl font-black text-foreground mb-2">My Shop</h3>
            <p className="text-sm text-muted-foreground font-medium leading-relaxed">
              {data.ownShopSlug
                ? 'Your storefront is live. Share the link with your customers.'
                : "You haven't set up your shop yet."}
            </p>
          </div>
          <div className="relative z-10 mt-6 space-y-2">
            {data.ownShopSlug && (
              <a href={`/shop/${data.ownShopSlug}`} target="_blank" rel="noopener noreferrer" className="block">
                <Button className="w-full font-bold rounded-xl h-12">
                  <ExternalLink className="w-4 h-4 mr-2" />
                  Visit Storefront
                </Button>
              </a>
            )}
            <Link href="/dashboard/sub/shop" className="block">
              <Button variant="secondary" className="w-full font-bold rounded-xl h-12">
                {data.ownShopSlug ? 'Shop Settings' : 'Create My Shop'}
              </Button>
            </Link>
          </div>
        </Card>
      </div>

      {/* Core stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 sm:gap-6">
        {[
          { label: 'Total Earned', value: formatCurrency(data.totalEarned || 0), icon: TrendingUp, color: 'bg-emerald-500' },
          { label: 'Total Withdrawn', value: formatCurrency(data.totalWithdrawn || 0), icon: ArrowDownToLine, color: 'bg-blue-500' },
          { label: 'Account Status', value: status.label, icon: status.icon, color: status.color },
          { label: 'Your Lead', value: data.uplineShop.shopName, icon: Users, color: 'bg-violet-500' },
        ].map((stat) => (
          <Card key={stat.label} className="card-premium group hover:border-primary/30">
            <CardContent className="p-6">
              <div className="flex flex-col gap-4">
                <div className={cn('w-12 h-12 rounded-2xl flex items-center justify-center text-white shadow-lg', stat.color)}>
                  <stat.icon className="w-6 h-6" />
                </div>
                <div className="min-w-0">
                  <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">{stat.label}</p>
                  <p className="text-xl sm:text-2xl font-black text-foreground mt-1 tracking-tight truncate" title={stat.value}>
                    {stat.value}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid lg:grid-cols-3 gap-8">
        <div className="lg:col-span-2 space-y-8">
          {/* Storefront announcement. A sub owns a shop like any other owner and
              /api/shop/announcements has always authorised them by owner_id — the
              editor was simply never mounted anywhere they could reach, so the
              notice bar on their storefront was unusable. brandConfig.shopId is the
              sub's OWN shop, not their upline's. */}
          {brand?.shopId && (
            <ShopAnnouncementBox shopId={brand.shopId} currentAnnouncement={null} />
          )}

          {/* Support Info — the Lead's name is the headline; the phone only shows
              when it's a real number (Google signups carry a placeholder). */}
          {(data.uplineShop.contactName || data.uplineShop.contactPhone) && (
            <Card className="card-premium">
              <CardContent className="p-6 flex items-center gap-4">
                <div className="w-12 h-12 rounded-2xl bg-secondary flex items-center justify-center shrink-0">
                  <LifeBuoy className="w-6 h-6 text-primary" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">
                    Need help? Contact your Lead
                  </p>
                  <p className="font-black text-foreground mt-1 truncate">
                    {data.uplineShop.contactName || data.uplineShop.shopName}
                  </p>
                </div>
                {data.uplineShop.contactPhone && (
                  <a href={`tel:${data.uplineShop.contactPhone}`} className="shrink-0">
                    <Button variant="secondary" className="font-bold rounded-xl">
                      <Phone className="w-4 h-4 mr-2" />
                      {data.uplineShop.contactPhone}
                    </Button>
                  </a>
                )}
              </CardContent>
            </Card>
          )}
        </div>

        <Card className="card-premium">
          <CardHeader className="pb-4">
            <CardTitle className="text-lg font-black tracking-tight">Quick Links</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {quickLinks.map((link) => (
              <Link key={link.href} href={link.href}>
                <div className="flex items-center gap-3 p-3 rounded-xl hover:bg-secondary/50 transition-colors group cursor-pointer">
                  <div className="w-9 h-9 rounded-lg bg-secondary flex items-center justify-center group-hover:bg-primary/10 group-hover:text-primary transition-colors">
                    <link.icon className="w-4 h-4" />
                  </div>
                  <span className="text-sm font-bold text-foreground/80 group-hover:text-foreground transition-colors">
                    {link.label}
                  </span>
                </div>
              </Link>
            ))}
          </CardContent>
        </Card>
      </div>

      {/* Platform Attribution */}
      <div className="text-center text-xs text-muted-foreground pt-4 border-t border-border/70">
        Powered by {brand?.isPlatform ? 'ARHMS' : brand?.shopName || 'ARHMS'}
      </div>

      {/* Withdrawal Modal */}
      <Dialog open={showWithdraw} onOpenChange={(open) => { if (!wSubmitting) setShowWithdraw(open) }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="font-black">Withdraw Funds</DialogTitle>
            <DialogDescription>
              Available balance:{' '}
              <span className="font-bold text-foreground">{formatCurrency(data.walletBalance || 0)}</span>
            </DialogDescription>
          </DialogHeader>

          {wSuccess ? (
            <div className="space-y-4">
              <div className="rounded-xl bg-emerald-50 border border-emerald-200 p-4 text-sm text-emerald-800 dark:bg-emerald-950/30 dark:border-emerald-900 dark:text-emerald-300">
                {wSuccess} Your Lead will review it, or it moves to the platform payout
                queue automatically after 48 hours.
              </div>
              <Button onClick={() => setShowWithdraw(false)} className="w-full font-bold rounded-xl h-11">
                Done
              </Button>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="w-amount">Amount (₵)</Label>
                <Input
                  id="w-amount"
                  type="number"
                  min="0"
                  step="0.01"
                  value={wAmount}
                  onChange={(e) => setWAmount(e.target.value)}
                  placeholder="e.g. 50"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="w-network">Network</Label>
                <select
                  id="w-network"
                  value={wNetwork}
                  onChange={(e) => setWNetwork(e.target.value as (typeof NETWORKS)[number])}
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  {NETWORKS.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="w-momo">Mobile Money Number</Label>
                <Input
                  id="w-momo"
                  type="tel"
                  value={wMomo}
                  onChange={(e) => setWMomo(e.target.value)}
                  placeholder="e.g. 0241234567"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="w-name">Account Name</Label>
                <Input
                  id="w-name"
                  type="text"
                  value={wName}
                  onChange={(e) => setWName(e.target.value)}
                  placeholder="Name registered on the MoMo account"
                />
              </div>

              {wError && (
                <div className="rounded-xl bg-destructive/10 border border-destructive/30 p-3 text-sm text-destructive">
                  {wError}
                </div>
              )}

              <div className="flex gap-3 pt-2">
                <Button
                  variant="outline"
                  onClick={() => setShowWithdraw(false)}
                  disabled={wSubmitting}
                  className="flex-1 font-bold rounded-xl h-11"
                >
                  Cancel
                </Button>
                <Button
                  onClick={submitWithdrawal}
                  disabled={wSubmitting}
                  className="flex-1 font-bold rounded-xl h-11"
                >
                  {wSubmitting ? 'Submitting…' : 'Request Withdrawal'}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
