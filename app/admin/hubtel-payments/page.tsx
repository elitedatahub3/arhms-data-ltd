'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select'
import {
    Pagination,
    PaginationContent,
    PaginationEllipsis,
    PaginationItem,
    PaginationLink,
    PaginationNext,
    PaginationPrevious,
} from '@/components/ui/pagination'
import { toast } from 'sonner'
import { ShopPaymentIssues } from '@/components/admin/shop-payment-issues'

const ITEMS_PER_PAGE = 20

const FLOW_LABELS: Record<string, string> = {
    wallet: 'Wallet Top-up',
    shop: 'Storefront',
    data: 'Data Bundle',
    results_checker: 'Results Checker',
    boost: 'Listing Boost',
    agent_upgrade: 'Agent Upgrade',
    dealer_subscription: 'Dealer Subscription',
    ussd: 'USSD',
    // Commission Services split money IN from money OUT, and the difference matters
    // when reading this table: 'airtime_pay'/'utility_pay' are the customer paying us,
    // 'airtime'/'utility' are us paying the provider. Only the latter two can strand.
    airtime_pay: 'Airtime (payment in)',
    airtime: 'Airtime top-up (out)',
    utility_pay: 'Bill payment (payment in)',
    utility: 'Utility bill (out)',
    unknown: 'Other',
}

/**
 * Flows worth filtering on. The outgoing Commission Services legs earn their place
 * because they are the ones that go quiet — Hubtel accepts them with '0001' and the
 * callback may never arrive — and they are what the checker above exists to resolve.
 * The label map stays complete so a wallet or storefront row still renders a readable
 * Type under "All types".
 */
const FILTERABLE_FLOWS = ['ussd', 'results_checker', 'utility', 'airtime'] as const

interface CheckResult {
    clientReference: string
    hubtel: {
        answered: boolean
        status: string | null
        accountUsed: 'prepaid' | 'collection' | null
        transactionId: string | null
        externalTransactionId: string | null
        amount: number | null
        charges: number | null
        date: string | null
        error: string | null
        attempts: Array<{ account: string; success: boolean; status: string | null; error?: string }>
        raw: unknown
    }
    linkedOrder: {
        kind: 'utility' | 'airtime'
        id: string
        reference: string
        status: string
        amount: number
        createdAt: string
        description: string
    } | null
    suggestion: { action: string; label: string; tone: 'success' | 'danger' } | null
}

interface HubtelPaymentRecord {
    id: string
    client_reference: string
    flow: string | null
    status: 'pending' | 'success' | 'failed'
    stage: string
    amount: number | null
    channel: string | null
    payer_msisdn: string | null
    transaction_id: string | null
    response_code: string | null
    message: string | null
    created_at: string
    updated_at: string
}

/**
 * Every Hubtel payment attempt, successful or not.
 *
 * Rows are written at initiate, at each callback (including the ones the webhook
 * ignores), by the reconciliation cron, and by USSD fulfilment — so this is the one
 * place that answers "did this customer's payment go through?" across all flows.
 */
export default function HubtelPaymentsPage() {
    const [records, setRecords] = useState<HubtelPaymentRecord[]>([])
    const [totalCount, setTotalCount] = useState(0)
    const [loading, setLoading] = useState(true)

    const [search, setSearch] = useState('')
    const [status, setStatus] = useState('all')
    const [flow, setFlow] = useState('all')
    const [startDate, setStartDate] = useState('')
    const [endDate, setEndDate] = useState('')
    const [currentPage, setCurrentPage] = useState(1)

    // ── Status checker ───────────────────────────────────────────────────────
    // Held in a ref so applying a fix can refresh the table without the checker
    // callbacks having to depend on load(), which is declared below them.
    const loadRef = useRef<(() => void) | null>(null)
    const [checkRef, setCheckRef] = useState('')
    const [checking, setChecking] = useState(false)
    const [checkResult, setCheckResult] = useState<CheckResult | null>(null)
    const [applying, setApplying] = useState(false)
    const [showRaw, setShowRaw] = useState(false)

    const runCheck = useCallback(async (reference: string) => {
        const ref = reference.trim()
        if (!ref) return
        setChecking(true)
        setShowRaw(false)
        setCheckResult(null)
        try {
            const res = await fetch('/api/admin/hubtel-payments/check', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ clientReference: ref }),
            })
            const data = await res.json()
            if (!res.ok) {
                toast.error(data.error || 'Could not check that reference')
                return
            }
            setCheckResult(data)
        } catch {
            toast.error('Network error while checking with Hubtel')
        } finally {
            setChecking(false)
        }
    }, [])

    /**
     * Applies Hubtel's answer through the EXISTING resolve endpoints, which own the
     * refund and completion logic and the customer notification. Nothing about the
     * money is re-implemented here.
     */
    const applySuggestion = useCallback(async () => {
        if (!checkResult?.linkedOrder || !checkResult.suggestion) return
        const { linkedOrder, suggestion, hubtel } = checkResult
        const note = `Hubtel status check (${hubtel.accountUsed} account): ${hubtel.status}`
            + (hubtel.transactionId ? ` · txn ${hubtel.transactionId}` : '')

        setApplying(true)
        try {
            const res = linkedOrder.kind === 'utility'
                ? await fetch('/api/admin/utilities/orders', {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ orderId: linkedOrder.id, action: suggestion.action, note }),
                })
                : await fetch('/api/admin/airtime/orders', {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ orderId: linkedOrder.id, status: suggestion.action, fulfillmentNote: note }),
                })

            const data = await res.json()
            if (!res.ok) {
                toast.error(data.error || 'Could not update the order')
                return
            }
            toast.success('Order updated')
            // Re-check so the panel shows the order's new status rather than the one
            // that prompted the fix, and refresh the table underneath it.
            await runCheck(checkResult.clientReference)
            loadRef.current?.()
        } catch {
            toast.error('Network error while updating the order')
        } finally {
            setApplying(false)
        }
    }, [checkResult, runCheck])

    const load = useCallback(async () => {
        setLoading(true)
        try {
            const params = new URLSearchParams({
                page: String(currentPage),
                limit: String(ITEMS_PER_PAGE),
            })
            if (search.trim()) params.set('search', search.trim())
            if (status !== 'all') params.set('status', status)
            if (flow !== 'all') params.set('flow', flow)
            if (startDate) params.set('startDate', startDate)
            if (endDate) params.set('endDate', endDate)

            const res = await fetch(`/api/admin/hubtel-payments?${params.toString()}`)
            const data = await res.json()
            if (!res.ok) {
                toast.error(data.error || 'Could not load payment records')
                return
            }
            setRecords(data.records || [])
            setTotalCount(data.total || 0)
        } catch {
            toast.error('Network error while loading payment records')
        } finally {
            setLoading(false)
        }
    }, [currentPage, search, status, flow, startDate, endDate])

    loadRef.current = load

    useEffect(() => {
        const t = setTimeout(load, 300)
        return () => clearTimeout(t)
    }, [load])

    // Any filter change invalidates the current page number.
    useEffect(() => {
        setCurrentPage(1)
    }, [search, status, flow, startDate, endDate])

    const totalPages = Math.ceil(totalCount / ITEMS_PER_PAGE)

    const renderPaginationItems = () => {
        const items = []
        const maxVisible = 5
        let startPage = Math.max(1, currentPage - Math.floor(maxVisible / 2))
        const endPage = Math.min(totalPages, startPage + maxVisible - 1)

        if (endPage - startPage + 1 < maxVisible) {
            startPage = Math.max(1, endPage - maxVisible + 1)
        }

        if (startPage > 1) {
            items.push(
                <PaginationItem key="1">
                    <PaginationLink onClick={() => setCurrentPage(1)} className="cursor-pointer">1</PaginationLink>
                </PaginationItem>
            )
            if (startPage > 2) items.push(<PaginationEllipsis key="e1" />)
        }

        for (let i = startPage; i <= endPage; i++) {
            items.push(
                <PaginationItem key={i}>
                    <PaginationLink
                        isActive={currentPage === i}
                        onClick={() => setCurrentPage(i)}
                        className="cursor-pointer"
                    >
                        {i}
                    </PaginationLink>
                </PaginationItem>
            )
        }

        if (endPage < totalPages) {
            if (endPage < totalPages - 1) items.push(<PaginationEllipsis key="e2" />)
            items.push(
                <PaginationItem key={totalPages}>
                    <PaginationLink onClick={() => setCurrentPage(totalPages)} className="cursor-pointer">{totalPages}</PaginationLink>
                </PaginationItem>
            )
        }

        return items
    }

    const statusBadge = (s: HubtelPaymentRecord['status']) => {
        if (s === 'success') {
            return <Badge className="bg-green-600 hover:bg-green-600 text-white">Successful</Badge>
        }
        if (s === 'failed') return <Badge variant="destructive">Failed</Badge>
        return <Badge variant="secondary">Pending</Badge>
    }

    const fmtDate = (iso: string) => new Date(iso).toLocaleString()
    const fmtAmount = (a: number | null) => (a == null ? '—' : `GHS ${Number(a).toFixed(2)}`)

    return (
        <div className="space-y-4">
            <div>
                <h1 className="text-2xl font-bold">Hubtel Payments</h1>
                <p className="text-sm text-muted-foreground mt-1">
                    Every Hubtel payment attempt — wallet, storefront, data, results checker,
                    USSD, airtime and utility bills — including the ones that failed.
                </p>
            </div>

            <ShopPaymentIssues />

            <Card>
                <CardHeader className="space-y-1 pb-3">
                    <CardTitle className="text-base">Check a transaction</CardTitle>
                    <p className="text-sm text-muted-foreground">
                        Ask Hubtel what became of one reference. Airtime top-ups and utility
                        bills go out on the prepaid account and have no callback guarantee, so
                        this is how an order that went quiet gets an answer instead of a guess.
                    </p>
                </CardHeader>
                <CardContent className="space-y-4">
                    <div className="flex flex-col sm:flex-row gap-2">
                        <Input
                            value={checkRef}
                            onChange={(e) => setCheckRef(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') runCheck(checkRef) }}
                            placeholder="UTLB-…, AIR-…, UTIL-… or any Hubtel reference"
                            className="font-mono text-xs"
                        />
                        <Button onClick={() => runCheck(checkRef)} disabled={checking || !checkRef.trim()}>
                            {checking ? 'Checking…' : 'Check'}
                        </Button>
                    </div>

                    {checkResult && (
                        <div className="rounded-lg border p-4 space-y-3">
                            <div className="flex flex-wrap items-center gap-2">
                                <span className="font-mono text-xs">{checkResult.clientReference}</span>
                                {checkResult.hubtel.answered ? (
                                    <>
                                        <Badge className="bg-green-600 hover:bg-green-600 text-white">
                                            Hubtel says: {checkResult.hubtel.status}
                                        </Badge>
                                        <span className="text-xs text-muted-foreground">
                                            via the {checkResult.hubtel.accountUsed} account
                                        </span>
                                    </>
                                ) : (
                                    <Badge variant="secondary">Hubtel would not say</Badge>
                                )}
                            </div>

                            {checkResult.hubtel.answered ? (
                                <div className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                                    <div><span className="text-muted-foreground">Txn ID: </span><span className="font-mono text-xs">{checkResult.hubtel.transactionId || '—'}</span></div>
                                    <div><span className="text-muted-foreground">Amount: </span>{fmtAmount(checkResult.hubtel.amount)}</div>
                                    <div><span className="text-muted-foreground">Charges: </span>{fmtAmount(checkResult.hubtel.charges)}</div>
                                    <div><span className="text-muted-foreground">Date: </span>{checkResult.hubtel.date ? fmtDate(checkResult.hubtel.date) : '—'}</div>
                                </div>
                            ) : (
                                <p className="text-sm text-muted-foreground">
                                    Neither account recognised this reference, so nothing here is proof
                                    either way. Resolve it from the Hubtel portal rather than assuming
                                    it failed — {checkResult.hubtel.error}
                                </p>
                            )}

                            {checkResult.linkedOrder ? (
                                <div className="rounded-md bg-muted/50 p-3 space-y-2">
                                    <p className="text-sm">
                                        <span className="text-muted-foreground">Linked order: </span>
                                        {checkResult.linkedOrder.description}
                                    </p>
                                    <p className="text-sm">
                                        <span className="text-muted-foreground">Current status: </span>
                                        <span className="font-medium">{checkResult.linkedOrder.status}</span>
                                        <span className="text-muted-foreground"> · {checkResult.linkedOrder.reference}</span>
                                    </p>

                                    {checkResult.suggestion ? (
                                        <Button
                                            size="sm"
                                            variant={checkResult.suggestion.tone === 'danger' ? 'destructive' : 'default'}
                                            onClick={applySuggestion}
                                            disabled={applying}
                                        >
                                            {applying ? 'Applying…' : checkResult.suggestion.label}
                                        </Button>
                                    ) : (
                                        <p className="text-xs text-muted-foreground">
                                            No action suggested — the answer is not definite enough to
                                            move money on. Resolve it by hand if you are sure.
                                        </p>
                                    )}
                                </div>
                            ) : (
                                <p className="text-sm text-muted-foreground">
                                    No airtime or utility order is linked to this reference — it is a
                                    collection payment, or predates the fulfilment tables.
                                </p>
                            )}

                            <button
                                type="button"
                                className="text-xs text-muted-foreground underline underline-offset-2"
                                onClick={() => setShowRaw((v) => !v)}
                            >
                                {showRaw ? 'Hide' : 'Show'} raw response
                            </button>
                            {showRaw && (
                                <pre className="overflow-x-auto rounded bg-muted p-3 text-[11px]">
                                    {JSON.stringify({ attempts: checkResult.hubtel.attempts, raw: checkResult.hubtel.raw }, null, 2)}
                                </pre>
                            )}
                        </div>
                    )}
                </CardContent>
            </Card>

            <Card>
                <CardHeader className="space-y-3">
                    <CardTitle className="text-base">
                        {loading ? 'Loading…' : `${totalCount} record${totalCount === 1 ? '' : 's'}`}
                    </CardTitle>
                    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
                        <Input
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            placeholder="Reference, phone or Hubtel ID…"
                            className="lg:col-span-2"
                        />
                        <Select value={status} onValueChange={setStatus}>
                            <SelectTrigger><SelectValue placeholder="Status" /></SelectTrigger>
                            <SelectContent>
                                <SelectItem value="all">All statuses</SelectItem>
                                <SelectItem value="success">Successful</SelectItem>
                                <SelectItem value="failed">Failed</SelectItem>
                                <SelectItem value="pending">Pending</SelectItem>
                            </SelectContent>
                        </Select>
                        <Select value={flow} onValueChange={setFlow}>
                            <SelectTrigger><SelectValue placeholder="Type" /></SelectTrigger>
                            <SelectContent>
                                <SelectItem value="all">All types</SelectItem>
                                {FILTERABLE_FLOWS.map((value) => (
                                    <SelectItem key={value} value={value}>{FLOW_LABELS[value]}</SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                        <div className="flex gap-2">
                            <Input
                                type="date"
                                value={startDate}
                                onChange={(e) => setStartDate(e.target.value)}
                                aria-label="From date"
                            />
                            <Input
                                type="date"
                                value={endDate}
                                onChange={(e) => setEndDate(e.target.value)}
                                aria-label="To date"
                            />
                        </div>
                    </div>
                </CardHeader>
                <CardContent>
                    {loading ? (
                        <div className="space-y-2">
                            {Array.from({ length: 6 }).map((_, i) => (
                                <Skeleton key={i} className="h-10 w-full" />
                            ))}
                        </div>
                    ) : records.length === 0 ? (
                        <p className="text-sm text-muted-foreground py-8 text-center">
                            No payment records match these filters.
                        </p>
                    ) : (
                        <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="border-b text-left text-muted-foreground">
                                        <th className="py-2 pr-4 font-medium">Date</th>
                                        <th className="py-2 pr-4 font-medium">Reference</th>
                                        <th className="py-2 pr-4 font-medium">Type</th>
                                        <th className="py-2 pr-4 font-medium">Phone</th>
                                        <th className="py-2 pr-4 font-medium">Amount</th>
                                        <th className="py-2 pr-4 font-medium">Status</th>
                                        <th className="py-2 pr-4 font-medium">Hubtel Txn ID</th>
                                        <th className="py-2 pr-4 font-medium">Details</th>
                                        <th className="py-2 font-medium sr-only">Check</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {records.map((r) => (
                                        <tr key={r.id} className="border-b last:border-0">
                                            <td className="py-2 pr-4 whitespace-nowrap">{fmtDate(r.created_at)}</td>
                                            <td className="py-2 pr-4 font-mono text-xs">{r.client_reference}</td>
                                            <td className="py-2 pr-4 whitespace-nowrap">
                                                {FLOW_LABELS[r.flow || 'unknown'] || r.flow}
                                            </td>
                                            <td className="py-2 pr-4 font-mono">{r.payer_msisdn || '—'}</td>
                                            <td className="py-2 pr-4 whitespace-nowrap">{fmtAmount(r.amount)}</td>
                                            <td className="py-2 pr-4">{statusBadge(r.status)}</td>
                                            <td className="py-2 pr-4 font-mono text-xs">{r.transaction_id || '—'}</td>
                                            <td
                                                className="py-2 pr-4 max-w-[22rem] truncate text-muted-foreground"
                                                title={r.message || ''}
                                            >
                                                {r.message || '—'}
                                            </td>
                                            <td className="py-2 whitespace-nowrap">
                                                <Button
                                                    size="sm"
                                                    variant="outline"
                                                    disabled={checking}
                                                    onClick={() => {
                                                        setCheckRef(r.client_reference)
                                                        runCheck(r.client_reference)
                                                        window.scrollTo({ top: 0, behavior: 'smooth' })
                                                    }}
                                                >
                                                    Check
                                                </Button>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </CardContent>
            </Card>

            {totalPages > 1 && (
                <div className="flex flex-col md:flex-row items-center justify-between gap-4 py-2">
                    <p className="text-sm text-muted-foreground">
                        Showing {(currentPage - 1) * ITEMS_PER_PAGE + 1} to{' '}
                        {Math.min(currentPage * ITEMS_PER_PAGE, totalCount)} of {totalCount} records
                    </p>
                    <Pagination>
                        <PaginationContent>
                            <PaginationItem>
                                <PaginationPrevious
                                    onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                                    className={currentPage === 1 ? 'pointer-events-none opacity-50' : 'cursor-pointer'}
                                />
                            </PaginationItem>
                            {renderPaginationItems()}
                            <PaginationItem>
                                <PaginationNext
                                    onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                                    className={currentPage === totalPages ? 'pointer-events-none opacity-50' : 'cursor-pointer'}
                                />
                            </PaginationItem>
                        </PaginationContent>
                    </Pagination>
                </div>
            )}
        </div>
    )
}
