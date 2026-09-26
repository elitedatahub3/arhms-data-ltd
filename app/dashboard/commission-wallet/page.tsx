'use client'

/**
 * Commission Wallet — what a Commission Services partner has earned, and the payout
 * request that turns it into money.
 *
 * Earnings are credited by lib/commission-earning when a bill paid with a Commission
 * Services key completes: the partner receives `share_percent` of the commission the
 * provider paid ARHMS on that order. Airtime and data earn nothing here.
 *
 * Withdrawals follow the shop flow: requesting debits the balance immediately, an admin
 * approves or rejects, and a rejection refunds it. That is why the balance drops the
 * moment a request is sent rather than when it is paid.
 */
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog'
import { Coins, Percent, RefreshCw, Receipt, ArrowRight, ArrowLeftRight, Banknote, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { formatDate, cn } from '@/lib/utils'
import { refreshDashboardSummary } from '@/hooks/use-dashboard-summary'

interface Wallet {
    balance: number
    total_earned: number
    total_withdrawn: number
    currency: string
}

interface CommissionTx {
    id: string
    source: string | null
    amount: number
    description: string | null
    reference: string | null
    created_at: string
}

interface Withdrawal {
    id: string
    amount: number
    fee: number
    net_amount: number
    status: 'pending' | 'moolre_pending' | 'completed' | 'rejected'
    network: string | null
    momo_number: string | null
    account_number: string | null
    account_name: string | null
    admin_note: string | null
    created_at: string
    processed_at: string | null
}

interface WithdrawalConfig {
    min_amount: number
    fee_percent: number
    fee_flat: number
    has_open_request: boolean
}

interface Bank { id: string; name: string }

const NETWORKS = ['MTN MoMo', 'Telecel Cash', 'AirtelTigo Money', 'Bank'] as const

const STATUS_LABEL: Record<Withdrawal['status'], { label: string; className: string }> = {
    pending:        { label: 'Awaiting approval', className: 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300' },
    moolre_pending: { label: 'Sending',           className: 'bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300' },
    completed:      { label: 'Paid',              className: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300' },
    rejected:       { label: 'Rejected',          className: 'bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300' },
}

const ghs = (n: number) => `GHS ${Number(n || 0).toFixed(2)}`

export default function CommissionWalletPage() {
    const [wallet, setWallet] = useState<Wallet | null>(null)
    const [transactions, setTransactions] = useState<CommissionTx[]>([])
    const [withdrawals, setWithdrawals] = useState<Withdrawal[]>([])
    const [config, setConfig] = useState<WithdrawalConfig | null>(null)
    const [sharePercent, setSharePercent] = useState<number | null>(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [transferOpen, setTransferOpen] = useState(false)
    const [withdrawOpen, setWithdrawOpen] = useState(false)
    const [transferAmount, setTransferAmount] = useState('')
    const [transferring, setTransferring] = useState(false)

    // Payout form
    const [amount, setAmount] = useState('')
    const [network, setNetwork] = useState<string>('MTN MoMo')
    const [accountNumber, setAccountNumber] = useState('')
    const [accountName, setAccountName] = useState('')
    const [bankId, setBankId] = useState('')
    const [banks, setBanks] = useState<Bank[]>([])
    const [submitting, setSubmitting] = useState(false)

    const isBank = network === 'Bank'

    const load = useCallback(async () => {
        setLoading(true)
        setError(null)
        try {
            const res = await fetch('/api/user/commission-wallet', { cache: 'no-store' })
            const json = await res.json()
            if (!res.ok) throw new Error(json.error || 'Could not load your commission wallet')
            setWallet(json.wallet ?? null)
            setTransactions(json.transactions ?? [])
            setWithdrawals(json.withdrawals ?? [])
            setConfig(json.withdrawal ?? null)
            setSharePercent(typeof json.share_percent === 'number' ? json.share_percent : null)
        } catch (e: any) {
            setError(e?.message || 'Could not load your commission wallet')
        } finally {
            setLoading(false)
        }
    }, [])

    useEffect(() => { load() }, [load])

    // Banks are only needed once the partner chooses Bank, so they are not fetched on load.
    useEffect(() => {
        if (!isBank || banks.length) return
        fetch('/api/shop/banks')
            .then(r => r.json())
            .then(d => setBanks(d.banks ?? []))
            .catch(() => toast.error('Could not load the bank list'))
    }, [isBank, banks.length])

    const balance = Number(wallet?.balance ?? 0)
    const minAmount = config?.min_amount ?? 10
    const parsedAmount = parseFloat(amount) || 0
    const fee = config ? Math.round((parsedAmount * config.fee_percent / 100 + config.fee_flat) * 100) / 100 : 0
    const netAmount = Math.round((parsedAmount - fee) * 100) / 100
    const openRequest = config?.has_open_request ?? false

    const canSubmit = !submitting
        && !openRequest
        && parsedAmount >= minAmount
        && parsedAmount <= balance
        && accountNumber.trim().length >= 8
        && accountName.trim().length >= 2
        && (!isBank || !!bankId)

    const submit = async () => {
        setSubmitting(true)
        try {
            const res = await fetch('/api/user/commission-wallet/withdraw', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    amount: parsedAmount,
                    accountNumber: accountNumber.trim(),
                    accountName: accountName.trim(),
                    network,
                    payment_type: isBank ? 'bank' : 'momo',
                    bankId: isBank ? bankId : undefined,
                }),
            })
            const json = await res.json()
            if (!res.ok) {
                toast.error(json.error || 'Could not submit your request')
                return
            }
            toast.success('Payout requested. An admin will review it.')
            setAmount('')
            setWithdrawOpen(false)
            await load()
        } catch {
            toast.error('Something went wrong')
        } finally {
            setSubmitting(false)
        }
    }

    // Transfer to the main wallet — the instant, no-fee alternative to a payout.
    const submitTransfer = async () => {
        const amount = Number(transferAmount)
        if (!Number.isFinite(amount) || amount <= 0) {
            toast.error('Enter an amount to transfer.')
            return
        }
        if (amount > balance) {
            toast.error('That is more than your commission balance.')
            return
        }

        setTransferring(true)
        try {
            const res = await fetch('/api/user/commission-wallet/transfer', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ amount }),
            })
            const json = await res.json()
            if (!res.ok) throw new Error(json.error || 'Could not complete the transfer.')

            toast.success(`${ghs(json.amount)} moved to your main wallet.`)
            setTransferOpen(false)
            setTransferAmount('')
            // Both balances changed: this page's, and the one the dashboard and
            // wallet page show.
            if (json.wallet) setWallet(json.wallet)
            refreshDashboardSummary()
            load()
        } catch (e: any) {
            toast.error(e?.message || 'Could not complete the transfer.')
        } finally {
            setTransferring(false)
        }
    }

    return (
        <div className="space-y-6 max-w-4xl">
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <h1 className="text-2xl font-bold tracking-tight">Commission Wallet</h1>
                    <p className="text-muted-foreground text-sm mt-1">
                        What you have earned on bill payments made with your Commission Services key.
                    </p>
                </div>
                <Button variant="outline" size="sm" onClick={load} disabled={loading} className="shrink-0">
                    <RefreshCw className={cn('w-3.5 h-3.5 mr-1.5', loading && 'animate-spin')} /> Refresh
                </Button>
            </div>

            {error && (
                <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/20 dark:text-red-300">
                    {error}
                </div>
            )}

            {/* Balance */}
            <Card className="overflow-hidden border-0 bg-gradient-to-br from-violet-600 to-indigo-700 text-white shadow-lg">
                <CardContent className="p-6 sm:p-7">
                    <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-white/70">
                        Commission Balance
                    </p>
                    {loading && !wallet
                        ? <Skeleton className="mt-2 h-10 w-40 bg-white/20" />
                        : <p className="mt-1 text-4xl font-black tracking-tight tabular-nums">{ghs(balance)}</p>}

                    {/* total_withdrawn counts both payouts and transfers out — both
                        leave this wallet. */}
                    <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-white/70 tabular-nums">
                        <span>Earned: {ghs(wallet?.total_earned ?? 0)}</span>
                        <span>Paid out or transferred: {ghs(wallet?.total_withdrawn ?? 0)}</span>
                    </div>

                    <div className="mt-5 grid gap-2.5 sm:grid-cols-2">
                        <Button
                            onClick={() => setTransferOpen(true)}
                            disabled={loading || balance <= 0}
                            className="w-full bg-white text-violet-700 hover:bg-white/90 font-bold h-11 rounded-xl"
                        >
                            <ArrowLeftRight className="w-4 h-4 mr-2" />
                            Transfer
                        </Button>
                        {/* Not disabled below the minimum: the dialog explains what
                            the minimum is and how far off the balance is, which a
                            dead button cannot. */}
                        <Button
                            onClick={() => setWithdrawOpen(true)}
                            disabled={loading}
                            className="w-full h-11 rounded-xl font-bold bg-white/15 text-white hover:bg-white/25 border border-white/25"
                        >
                            <Banknote className="w-4 h-4 mr-2" />
                            Withdraw
                        </Button>
                    </div>
                    <p className="mt-3 text-xs text-white/70">
                        {balance > 0
                            ? 'Transfer is instant and free. Withdraw sends money out, and an admin reviews it.'
                            : 'Nothing to transfer yet.'}
                    </p>
                </CardContent>
            </Card>

            {/* Withdraw */}
            <Dialog open={withdrawOpen} onOpenChange={(open) => { if (!submitting) setWithdrawOpen(open) }}>
                <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2">
                            <Banknote className="w-4 h-4" /> Withdraw
                        </DialogTitle>
                        <DialogDescription>
                            Minimum {ghs(minAmount)}
                            {config && (config.fee_percent > 0 || config.fee_flat > 0)
                                ? ` · fee ${config.fee_percent}%${config.fee_flat ? ` + ${ghs(config.fee_flat)}` : ''}`
                                : ' · no fee'}
                            . An admin reviews every request.
                        </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4 py-1">
                    {openRequest ? (
                        <p className="text-sm text-muted-foreground">
                            You have a request awaiting approval. You can send another once it has been processed.
                        </p>
                    ) : balance < minAmount ? (
                        <div className="space-y-3">
                            <p className="text-sm text-muted-foreground">
                                You need at least {ghs(minAmount)} to withdraw. Your balance is {ghs(balance)}.
                            </p>
                            {balance > 0 && (
                                <>
                                    <p className="text-sm text-muted-foreground">
                                        You can move it to your main wallet instead — any amount, instantly, with no fee.
                                    </p>
                                    <Button
                                        variant="outline"
                                        className="w-full h-11 rounded-xl"
                                        onClick={() => { setWithdrawOpen(false); setTransferOpen(true) }}
                                    >
                                        <ArrowLeftRight className="w-4 h-4 mr-2" />
                                        Transfer {ghs(balance)} to Main Wallet
                                    </Button>
                                </>
                            )}
                        </div>
                    ) : (
                        <>
                            <div className="grid gap-3 sm:grid-cols-2">
                                <div>
                                    <Label className="text-sm font-semibold">Amount (GHS)</Label>
                                    <Input
                                        value={amount}
                                        onChange={e => setAmount(e.target.value)}
                                        placeholder={minAmount.toFixed(2)}
                                        inputMode="decimal"
                                        className="mt-1.5 h-11 rounded-xl"
                                    />
                                    <p className="text-[11px] text-muted-foreground mt-1">
                                        Available {ghs(balance)}
                                    </p>
                                </div>
                                <div>
                                    <Label className="text-sm font-semibold">Pay to</Label>
                                    <Select value={network} onValueChange={v => { setNetwork(v); setBankId('') }}>
                                        <SelectTrigger className="mt-1.5 h-11 rounded-xl">
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            {NETWORKS.map(n => <SelectItem key={n} value={n}>{n}</SelectItem>)}
                                        </SelectContent>
                                    </Select>
                                </div>
                            </div>

                            {isBank && (
                                <div>
                                    <Label className="text-sm font-semibold">Bank</Label>
                                    <Select value={bankId} onValueChange={setBankId}>
                                        <SelectTrigger className="mt-1.5 h-11 rounded-xl">
                                            <SelectValue placeholder={banks.length ? 'Choose your bank' : 'Loading banks…'} />
                                        </SelectTrigger>
                                        <SelectContent>
                                            {banks.map(b => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}
                                        </SelectContent>
                                    </Select>
                                </div>
                            )}

                            <div className="grid gap-3 sm:grid-cols-2">
                                <div>
                                    <Label className="text-sm font-semibold">
                                        {isBank ? 'Account number' : 'MoMo number'}
                                    </Label>
                                    <Input
                                        value={accountNumber}
                                        onChange={e => setAccountNumber(e.target.value)}
                                        placeholder={isBank ? 'Account number' : '0XXXXXXXXX'}
                                        inputMode="numeric"
                                        className="mt-1.5 h-11 rounded-xl"
                                    />
                                </div>
                                <div>
                                    <Label className="text-sm font-semibold">Account name</Label>
                                    <Input
                                        value={accountName}
                                        onChange={e => setAccountName(e.target.value)}
                                        placeholder="Name on the account"
                                        className="mt-1.5 h-11 rounded-xl"
                                    />
                                </div>
                            </div>

                            {parsedAmount > 0 && (
                                <div className="rounded-xl bg-muted/40 p-3 text-sm">
                                    <div className="flex justify-between">
                                        <span className="text-muted-foreground">You receive</span>
                                        <span className="font-bold tabular-nums">{ghs(netAmount)}</span>
                                    </div>
                                    {fee > 0 && (
                                        <div className="flex justify-between text-xs text-muted-foreground mt-1">
                                            <span>Fee</span><span>{ghs(fee)}</span>
                                        </div>
                                    )}
                                </div>
                            )}

                            <Button className="w-full h-11 rounded-xl" disabled={!canSubmit} onClick={submit}>
                                {submitting && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                                Request payout
                            </Button>
                            <p className="text-[11px] text-muted-foreground">
                                The amount leaves your balance as soon as you request it. If the request is rejected it
                                is returned in full. Check the name and number — payouts are sent exactly as entered.
                            </p>
                        </>
                    )}
                    </div>
                </DialogContent>
            </Dialog>

            {/* Payout history */}
            {withdrawals.length > 0 && (
                <Card>
                    <CardHeader className="pb-3">
                        <CardTitle className="flex items-center gap-2 text-base">
                            <Receipt className="w-4 h-4" /> Payout requests
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="divide-y divide-border/60">
                            {withdrawals.map(w => (
                                <div key={w.id} className="flex items-start justify-between gap-3 py-2.5">
                                    <div className="min-w-0">
                                        <p className="text-sm font-medium">
                                            {ghs(w.net_amount)}
                                            <span className="text-muted-foreground font-normal">
                                                {' '}to {w.network} {w.momo_number || w.account_number}
                                            </span>
                                        </p>
                                        <p className="text-[11px] text-muted-foreground">
                                            {formatDate(w.created_at)}
                                            {w.admin_note ? ` · ${w.admin_note}` : ''}
                                        </p>
                                    </div>
                                    <span className={cn(
                                        'shrink-0 text-[10px] font-bold uppercase px-2 py-1 rounded',
                                        STATUS_LABEL[w.status].className
                                    )}>
                                        {STATUS_LABEL[w.status].label}
                                    </span>
                                </div>
                            ))}
                        </div>
                    </CardContent>
                </Card>
            )}

            {/* How it is earned */}
            <Card>
                <CardHeader className="pb-3">
                    <CardTitle className="flex items-center gap-2 text-base">
                        <Percent className="w-4 h-4" /> How you earn
                    </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 text-sm text-muted-foreground">
                    <p>
                        Every bill you pay through the API with your Commission Services key earns a commission from
                        the provider. You receive{' '}
                        <strong className="text-foreground">
                            {sharePercent === null ? 'a share' : `${sharePercent}%`}
                        </strong>{' '}
                        of it, credited here once the bill completes.
                    </p>
                    <p>
                        Bills are paid at face value. Failed or refunded bills earn nothing, and data, airtime and AFA
                        orders do not earn commission.
                    </p>
                    <Link
                        href="/dashboard/developer-api"
                        className="inline-flex items-center gap-1 text-xs font-semibold text-foreground hover:underline"
                    >
                        Manage your Commission Services key <ArrowRight className="w-3 h-3" />
                    </Link>
                </CardContent>
            </Card>

            {/* Earnings history */}
            <Card>
                <CardHeader className="pb-3">
                    <CardTitle className="flex items-center gap-2 text-base">
                        <Coins className="w-4 h-4" /> Recent earnings
                    </CardTitle>
                    <CardDescription>
                        The last 20 commissions credited to this wallet. Transfers out appear on your
                        main wallet statement.
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    {loading && transactions.length === 0 ? (
                        <div className="space-y-2">
                            {[0, 1, 2].map(i => <Skeleton key={i} className="h-12 w-full" />)}
                        </div>
                    ) : transactions.length === 0 ? (
                        <div className="py-8 text-center">
                            <Receipt className="w-9 h-9 mx-auto text-muted-foreground/50 mb-2" />
                            <p className="text-sm font-medium">No commission yet</p>
                            <p className="text-xs text-muted-foreground mt-1">
                                Your first earning appears here once a bill paid with your Commission Services key completes.
                            </p>
                        </div>
                    ) : (
                        <div className="divide-y divide-border/60">
                            {transactions.map(tx => (
                                <div key={tx.id} className="flex items-center justify-between gap-3 py-2.5">
                                    <div className="min-w-0">
                                        <p className="text-sm font-medium truncate">{tx.description || 'Commission'}</p>
                                        <p className="text-[11px] text-muted-foreground truncate">
                                            {formatDate(tx.created_at)}
                                            {tx.reference ? ` · ${tx.reference}` : ''}
                                        </p>
                                    </div>
                                    <span className="shrink-0 text-sm font-bold tabular-nums text-emerald-600 dark:text-emerald-400">
                                        +{ghs(tx.amount)}
                                    </span>
                                </div>
                            ))}
                        </div>
                    )}
                </CardContent>
            </Card>

            {/* Transfer to main wallet */}
            <Dialog open={transferOpen} onOpenChange={(open) => { if (!transferring) setTransferOpen(open) }}>
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>Transfer Commission</DialogTitle>
                        <DialogDescription>
                            Move your earnings into your main wallet, where you can spend them on data,
                            airtime and bills.
                        </DialogDescription>
                    </DialogHeader>

                    <div className="space-y-4 py-2">
                        <div className="space-y-2">
                            <Label>Destination</Label>
                            <div className="flex items-center gap-2 rounded-xl border bg-muted/40 px-3 py-2.5 text-sm font-semibold">
                                <ArrowRight className="w-4 h-4 text-muted-foreground" />
                                Main Wallet
                            </div>
                        </div>

                        <div className="space-y-2">
                            <div className="flex items-center justify-between">
                                <Label htmlFor="commission-transfer-amount">Amount (GHS)</Label>
                                <button
                                    type="button"
                                    onClick={() => setTransferAmount(balance.toFixed(2))}
                                    className="text-xs font-semibold text-muted-foreground hover:text-foreground"
                                >
                                    Available: {ghs(balance)}
                                </button>
                            </div>
                            <Input
                                id="commission-transfer-amount"
                                type="number"
                                inputMode="decimal"
                                min="0.01"
                                max={balance}
                                step="0.01"
                                placeholder="0.00"
                                value={transferAmount}
                                onChange={(e) => setTransferAmount(e.target.value)}
                                disabled={transferring}
                            />
                            <p className="text-xs text-muted-foreground">Instant, no fee.</p>
                        </div>
                    </div>

                    <DialogFooter>
                        <Button
                            variant="outline"
                            onClick={() => setTransferOpen(false)}
                            disabled={transferring}
                        >
                            Cancel
                        </Button>
                        <Button
                            onClick={submitTransfer}
                            disabled={transferring || !transferAmount || Number(transferAmount) <= 0}
                        >
                            {transferring ? (
                                <>
                                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                                    Transferring…
                                </>
                            ) : 'Transfer'}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    )
}
