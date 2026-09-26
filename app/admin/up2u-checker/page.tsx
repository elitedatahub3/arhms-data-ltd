'use client'

import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { ShieldCheck, Search, ListChecks, Loader2, Download, CheckCircle2, XCircle, Clock } from 'lucide-react'

const MAX_NUMBERS = 50

type Tone = 'success' | 'failed' | 'pending'

interface Up2uRecord {
    msisdn: string
    beneficiaryName: string | null
    voiceMinutes: number
    dataMb: number
    smsUnits: number
    status: string
    statusTone: Tone
    date: string | null
}

interface LookupRow {
    input: string
    phone: string
    success: boolean
    records: Up2uRecord[]
    error?: string
}

interface Summary {
    total: number
    checked: number
    withRecords: number
    noRecords: number
    errors: number
}

type Filter = 'all' | 'withRecords' | 'noRecords' | 'errors'

const TONE_META: Record<Tone, { className: string; icon: typeof CheckCircle2 }> = {
    success: { className: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400 border-transparent', icon: CheckCircle2 },
    failed: { className: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400 border-transparent', icon: XCircle },
    pending: { className: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400 border-transparent', icon: Clock },
}

const FILTERS: { key: Filter; label: string; className: string }[] = [
    { key: 'withRecords', label: 'Delivered to', className: TONE_META.success.className },
    { key: 'noRecords', label: 'No deliveries', className: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300 border-transparent' },
    { key: 'errors', label: 'Errors', className: TONE_META.failed.className },
]

/** Split a paste on newlines, commas, semicolons, tabs or spaces. */
function parseNumbers(text: string): string[] {
    return text.split(/[\s,;]+/).map(n => n.trim()).filter(Boolean)
}

function formatData(mb: number): string {
    if (mb >= 1024) {
        const gb = mb / 1024
        return `${mb.toLocaleString()} MB (${Number.isInteger(gb) ? gb : gb.toFixed(2)} GB)`
    }
    return `${mb.toLocaleString()} MB`
}

function matchesFilter(row: LookupRow, filter: Filter): boolean {
    if (filter === 'withRecords') return row.success && row.records.length > 0
    if (filter === 'noRecords') return row.success && row.records.length === 0
    if (filter === 'errors') return !row.success
    return true
}

export default function Up2uCheckerPage() {
    const [mode, setMode] = useState<'single' | 'bulk'>('single')
    const [single, setSingle] = useState('')
    const [bulk, setBulk] = useState('')
    const [isChecking, setIsChecking] = useState(false)
    const [results, setResults] = useState<LookupRow[] | null>(null)
    const [summary, setSummary] = useState<Summary | null>(null)
    const [filter, setFilter] = useState<Filter>('all')

    const bulkNumbers = useMemo(() => parseNumbers(bulk), [bulk])
    const overLimit = bulkNumbers.length > MAX_NUMBERS

    const runCheck = async (numbers: string[]) => {
        if (numbers.length === 0) {
            toast.error('Enter at least one number')
            return
        }
        if (numbers.length > MAX_NUMBERS) {
            toast.error(`You can check up to ${MAX_NUMBERS} numbers at a time`)
            return
        }

        setIsChecking(true)
        setResults(null)
        setSummary(null)
        setFilter('all')

        try {
            const response = await fetch('/api/admin/up2u-check', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ numbers }),
            })
            const data = await response.json()

            if (!response.ok) {
                toast.error(data?.error || 'Could not check these numbers')
                return
            }

            setResults(data.results)
            setSummary(data.summary)
            if (data.summary.errors > 0 && data.summary.errors === data.summary.total) {
                toast.error(data.results[0]?.error || 'Every lookup failed')
            }
        } catch {
            toast.error('Network error. Please try again.')
        } finally {
            setIsChecking(false)
        }
    }

    const filteredResults = useMemo(
        () => (results || []).filter(row => matchesFilter(row, filter)),
        [results, filter]
    )

    const downloadCsv = () => {
        if (!results || results.length === 0) return
        const rows: (string | number)[][] = [['Number', 'Beneficiary Msisdn', 'Beneficiary Name', 'Voice (Minutes)', 'Data (MB)', 'SMS (Unit)', 'Status', 'Date']]
        for (const row of results) {
            const number = row.phone || row.input
            if (!row.success) {
                rows.push([number, '', '', '', '', '', row.error || 'Error', ''])
            } else if (row.records.length === 0) {
                rows.push([number, '', '', '', '', '', 'No deliveries found', ''])
            } else {
                for (const r of row.records) {
                    rows.push([number, r.msisdn, r.beneficiaryName || '', r.voiceMinutes, r.dataMb, r.smsUnits, r.status, r.date || ''])
                }
            }
        }
        const csv = rows.map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\n')
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
        const url = URL.createObjectURL(blob)
        const link = document.createElement('a')
        link.href = url
        link.download = `up2u-check-${new Date().toISOString().slice(0, 10)}.csv`
        link.click()
        URL.revokeObjectURL(url)
    }

    return (
        <div className="space-y-6">
            <div>
                <h1 className="text-2xl font-bold flex items-center gap-2">
                    <ShieldCheck className="w-6 h-6 text-green-600" />
                    UP2U Checker
                </h1>
                <p className="text-sm text-muted-foreground mt-1">
                    Confirm UP2U data deliveries to MTN numbers, straight from Eazy Data
                </p>
            </div>

            <div className="max-w-5xl space-y-6">
                <Card className="rounded-3xl">
                    <CardHeader>
                        <CardTitle className="text-lg">Look up numbers</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-4">
                        <div className="flex gap-3">
                            <Button
                                type="button"
                                variant={mode === 'single' ? 'default' : 'outline'}
                                className="flex-1 h-11 rounded-xl font-bold"
                                onClick={() => setMode('single')}
                            >
                                <Search className="w-4 h-4 mr-2" />
                                Single
                            </Button>
                            <Button
                                type="button"
                                variant={mode === 'bulk' ? 'default' : 'outline'}
                                className="flex-1 h-11 rounded-xl font-bold"
                                onClick={() => setMode('bulk')}
                            >
                                <ListChecks className="w-4 h-4 mr-2" />
                                Bulk
                            </Button>
                        </div>

                        {mode === 'single' ? (
                            <form
                                className="flex flex-col sm:flex-row gap-3"
                                onSubmit={(e) => {
                                    e.preventDefault()
                                    runCheck(single.trim() ? [single.trim()] : [])
                                }}
                            >
                                <Input
                                    value={single}
                                    onChange={(e) => setSingle(e.target.value)}
                                    placeholder="0597313605"
                                    inputMode="tel"
                                    className="h-12 font-mono text-base rounded-xl"
                                />
                                <Button type="submit" className="h-12 rounded-xl font-bold sm:w-40" disabled={isChecking || !single.trim()}>
                                    {isChecking ? <Loader2 className="w-4 h-4 animate-spin" /> : <><ShieldCheck className="w-4 h-4 mr-2" />Check</>}
                                </Button>
                            </form>
                        ) : (
                            <div className="space-y-2">
                                <Textarea
                                    value={bulk}
                                    onChange={(e) => setBulk(e.target.value)}
                                    placeholder={'0597313605\n0244000000\n0551234567'}
                                    className="min-h-[180px] font-mono text-base rounded-xl"
                                />
                                <div className="flex items-center justify-between text-sm">
                                    <span className={cn('font-medium', overLimit ? 'text-red-600' : 'text-muted-foreground')}>
                                        {bulkNumbers.length} / {MAX_NUMBERS} numbers
                                    </span>
                                    {bulk && (
                                        <button type="button" className="text-muted-foreground hover:text-foreground underline" onClick={() => setBulk('')}>
                                            Clear
                                        </button>
                                    )}
                                </div>
                                <Button
                                    className="w-full h-12 rounded-xl font-bold"
                                    disabled={isChecking || overLimit || bulkNumbers.length === 0}
                                    onClick={() => runCheck(bulkNumbers)}
                                >
                                    {isChecking ? (
                                        <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Checking…</>
                                    ) : (
                                        <><ShieldCheck className="w-4 h-4 mr-2" />Check Numbers</>
                                    )}
                                </Button>
                            </div>
                        )}
                    </CardContent>
                </Card>

                {isChecking && (
                    <div className="space-y-3">
                        <Skeleton className="h-20 w-full rounded-2xl" />
                        <Skeleton className="h-48 w-full rounded-2xl" />
                    </div>
                )}

                {results && summary && !isChecking && (
                    <Card className="rounded-3xl">
                        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 space-y-0">
                            <CardTitle className="text-xl flex items-center gap-2">
                                <CheckCircle2 className="w-5 h-5 text-green-600" />
                                Delivery Confirmation Results
                            </CardTitle>
                            <Button variant="outline" className="h-10 rounded-xl" onClick={downloadCsv}>
                                <Download className="w-4 h-4 mr-2" />
                                Download CSV
                            </Button>
                        </CardHeader>
                        <CardContent className="space-y-5">
                            {results.length > 1 && (
                                <div className="flex flex-wrap gap-2">
                                    <button
                                        type="button"
                                        onClick={() => setFilter('all')}
                                        className={cn(
                                            'px-4 py-2 rounded-full text-sm font-bold border transition-colors',
                                            filter === 'all' ? 'bg-foreground text-background border-transparent' : 'hover:bg-muted'
                                        )}
                                    >
                                        All {summary.total}
                                    </button>
                                    {FILTERS.map(({ key, label, className }) => {
                                        const count = summary[key]
                                        if (!count) return null
                                        return (
                                            <button
                                                key={key}
                                                type="button"
                                                onClick={() => setFilter(key)}
                                                className={cn('px-4 py-2 rounded-full text-sm font-bold transition-all', className, filter === key && 'ring-2 ring-offset-1 ring-current')}
                                            >
                                                {label} {count}
                                            </button>
                                        )
                                    })}
                                </div>
                            )}

                            {filteredResults.map((row, index) => (
                                <section key={`${row.input}-${index}`} className="space-y-2">
                                    <p className="text-sm text-muted-foreground">
                                        Results for <span className="font-mono font-semibold text-foreground">{row.phone || row.input}</span>
                                        {row.success && ` · ${row.records.length} ${row.records.length === 1 ? 'record' : 'records'}`}
                                    </p>

                                    {!row.success ? (
                                        <div className="rounded-xl border border-red-200 dark:border-red-900/40 bg-red-50 dark:bg-red-900/10 px-4 py-3 text-sm text-red-700 dark:text-red-400">
                                            {row.error || 'Lookup failed'}
                                        </div>
                                    ) : row.records.length === 0 ? (
                                        <div className="rounded-xl border px-4 py-3 text-sm text-muted-foreground">
                                            No UP2U deliveries found for this number
                                        </div>
                                    ) : (
                                        <div className="overflow-x-auto rounded-xl border">
                                            <table className="w-full text-sm">
                                                <thead className="bg-muted/50">
                                                    <tr>
                                                        <th className="text-left font-semibold px-4 py-3 whitespace-nowrap">Beneficiary Msisdn</th>
                                                        <th className="text-left font-semibold px-4 py-3 whitespace-nowrap">Beneficiary Name</th>
                                                        <th className="text-left font-semibold px-4 py-3 whitespace-nowrap">Voice (Minutes)</th>
                                                        <th className="text-left font-semibold px-4 py-3 whitespace-nowrap">Data</th>
                                                        <th className="text-left font-semibold px-4 py-3 whitespace-nowrap">SMS (Unit)</th>
                                                        <th className="text-left font-semibold px-4 py-3 whitespace-nowrap">Status</th>
                                                        <th className="text-left font-semibold px-4 py-3 whitespace-nowrap">Date</th>
                                                    </tr>
                                                </thead>
                                                <tbody>
                                                    {row.records.map((record, recordIndex) => {
                                                        const tone = TONE_META[record.statusTone]
                                                        const Icon = tone.icon
                                                        return (
                                                            <tr key={recordIndex} className="border-t">
                                                                <td className="px-4 py-3 font-mono whitespace-nowrap">{record.msisdn}</td>
                                                                <td className="px-4 py-3">{record.beneficiaryName || '—'}</td>
                                                                <td className="px-4 py-3">{record.voiceMinutes}</td>
                                                                <td className="px-4 py-3 whitespace-nowrap">{formatData(record.dataMb)}</td>
                                                                <td className="px-4 py-3">{record.smsUnits}</td>
                                                                <td className="px-4 py-3">
                                                                    <Badge className={cn('gap-1.5 font-semibold', tone.className)}>
                                                                        <Icon className="w-3.5 h-3.5" />
                                                                        {record.status}
                                                                    </Badge>
                                                                </td>
                                                                <td className="px-4 py-3 whitespace-nowrap text-muted-foreground">{record.date || '—'}</td>
                                                            </tr>
                                                        )
                                                    })}
                                                </tbody>
                                            </table>
                                        </div>
                                    )}
                                </section>
                            ))}
                        </CardContent>
                    </Card>
                )}
            </div>
        </div>
    )
}
