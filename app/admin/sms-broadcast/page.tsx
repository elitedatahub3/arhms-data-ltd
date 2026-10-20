'use client'

import { useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Loader2, Send, MessageSquare, Users, Search, CheckSquare, XSquare, AlertTriangle, Play, Ban } from 'lucide-react'
import { toast } from 'sonner'
import { GREETING_PREFIX, NAME_TOKEN, greetName, greetShopName, hasNameToken, renderBroadcast } from '@/lib/sms-broadcast-greeting'

interface ActiveJob {
    id: string
    sent_count: number
    total: number
    created_at: string
}

interface User {
    id: string
    first_name: string
    last_name: string
    phone_number: string
    role: string
    email: string
}

export default function AdminSMSBroadcastPage() {
    const [users, setUsers] = useState<User[]>([])
    const [filteredUsers, setFilteredUsers] = useState<User[]>([])
    const [selectedUsers, setSelectedUsers] = useState<Set<string>>(new Set())
    const [loading, setLoading] = useState(true)
    const [sending, setSending] = useState(false)
    const [message, setMessage] = useState('')
    const [searchQuery, setSearchQuery] = useState('')
    const [roleFilter, setRoleFilter] = useState<string>('all')
    const [jobProgress, setJobProgress] = useState<{ sent: number; total: number } | null>(null)
    // An unfinished broadcast from earlier. Shown with Resume / Cancel — never
    // restarted just because the page was opened.
    const [activeJob, setActiveJob] = useState<ActiveJob | null>(null)
    const [cancelling, setCancelling] = useState(false)
    // "Hi {name}! " in front of the message, each person's own first name.
    const [greet, setGreet] = useState(true)

    useEffect(() => {
        fetchUsers()
        checkActiveJob()
    }, [])

    useEffect(() => {
        filterUsers()
    }, [users, searchQuery, roleFilter])

    const fetchUsers = async () => {
        try {
            const response = await fetch('/api/admin/sms-broadcast/users')
            const result = await response.json()

            if (!response.ok) {
                throw new Error(result.error || 'Failed to fetch users')
            }

            setUsers(result.users || [])
        } catch (error: any) {
            console.error('Error fetching users:', error)
            toast.error('Failed to load users: ' + error.message)
        } finally {
            setLoading(false)
        }
    }

    const filterUsers = () => {
        let filtered = [...users]

        // Apply role filter
        if (roleFilter !== 'all') {
            filtered = filtered.filter(u => u.role === roleFilter)
        }

        // Apply search filter
        if (searchQuery.trim()) {
            const query = searchQuery.toLowerCase()
            filtered = filtered.filter(u =>
                u.first_name?.toLowerCase().includes(query) ||
                u.last_name?.toLowerCase().includes(query) ||
                u.phone_number?.includes(query) ||
                u.email?.toLowerCase().includes(query)
            )
        }

        setFilteredUsers(filtered)
    }

    const handleSelectAll = () => {
        const newSelected = new Set(selectedUsers)
        filteredUsers.forEach(u => newSelected.add(u.id))
        setSelectedUsers(newSelected)
    }

    const handleDeselectAll = () => {
        const newSelected = new Set(selectedUsers)
        filteredUsers.forEach(u => newSelected.delete(u.id))
        setSelectedUsers(newSelected)
    }

    const handleToggleUser = (userId: string) => {
        const newSelected = new Set(selectedUsers)
        if (newSelected.has(userId)) {
            newSelected.delete(userId)
        } else {
            newSelected.add(userId)
        }
        setSelectedUsers(newSelected)
    }

    // Look for a broadcast left unfinished by an earlier visit. Report only:
    // resuming it here used to start texting people the moment the admin
    // opened this page. The admin chooses Resume or Cancel on the banner.
    const checkActiveJob = async () => {
        try {
            const response = await fetch('/api/admin/sms-broadcast/status?active=1')
            const data = await response.json()
            if (response.ok && data?.job) setActiveJob(data.job)
        } catch (error) {
            console.error('[SMSBroadcast] Could not check for an active broadcast:', error)
        }
    }

    // Polling by jobId is what restarts a stalled job server-side, so this is
    // how a broadcast that stopped part-way gets moving again.
    const handleResume = async () => {
        if (!activeJob) return
        const job = activeJob
        setActiveJob(null)
        toast.info(`Resuming broadcast: ${job.sent_count} / ${job.total} sent`)
        setSending(true)
        setJobProgress({ sent: job.sent_count, total: job.total })
        try {
            await pollJobStatus(job.id)
        } finally {
            setSending(false)
        }
    }

    const handleCancel = async () => {
        if (!activeJob) return
        setCancelling(true)
        try {
            const response = await fetch('/api/admin/sms-broadcast/cancel', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jobId: activeJob.id }),
            })
            const data = await response.json()
            if (!response.ok) throw new Error(data.error || 'Failed to cancel')
            toast.success('Broadcast cancelled — nobody else will be texted')
            setActiveJob(null)
        } catch (error: any) {
            toast.error(error.message || 'Failed to cancel broadcast')
        } finally {
            setCancelling(false)
        }
    }

    const pollJobStatus = async (jobId: string) => {
        const POLL_INTERVAL_MS = 2000
        const MAX_POLLS = 1800 // 60 minutes ceiling

        for (let i = 0; i < MAX_POLLS; i++) {
            await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))

            try {
                const response = await fetch(`/api/admin/sms-broadcast/status?jobId=${jobId}`)
                const data = await response.json()
                if (!response.ok) throw new Error(data.error || 'Failed to check status')

                const job = data.job
                setJobProgress({ sent: job.sent_count, total: job.total })

                if (job.status === 'completed' || job.status === 'failed') {
                    toast.success(`Broadcast finished: ${job.success_count}/${job.total} delivered`)
                    if (job.failed_count > 0) {
                        console.warn('[SMSBroadcast] Failed deliveries:', job.errors)
                        // Show WHY on the page — "see console" is no answer on a phone.
                        // Errors read "<name>: <reason>"; group by reason.
                        const reasons = new Map<string, number>()
                        for (const e of (job.errors || []) as string[]) {
                            const reason = String(e).replace(/^[^:]*:\s*/, '')
                            reasons.set(reason, (reasons.get(reason) || 0) + 1)
                        }
                        const top = [...reasons.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
                        toast.error(
                            `${job.failed_count} message(s) failed to deliver${top ? ` — reason: ${top}` : ''}`,
                            { duration: 20000 }
                        )
                    }
                    return
                }
            } catch (error: any) {
                console.error('[SMSBroadcast] Status poll failed:', error)
                // Keep polling — a single failed poll shouldn't abandon tracking.
            }
        }

        toast.error('Broadcast is taking longer than expected — check back later, it is still running in the background')
    }

    const handleSendSMS = async () => {
        if (!message.trim()) {
            toast.error('Please enter a message')
            return
        }

        if (selectedUsers.size === 0) {
            toast.error('Please select at least one recipient')
            return
        }

        setSending(true)
        setJobProgress(null)
        try {
            const response = await fetch('/api/admin/sms-broadcast', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    userIds: Array.from(selectedUsers),
                    message: finalMessage
                })
            })

            const data = await response.json()

            if (!response.ok) {
                throw new Error(data.error || 'Failed to send SMS')
            }

            toast.success(`Broadcast queued for ${data.total} recipient${data.total !== 1 ? 's' : ''} — sending in the background`)
            setJobProgress({ sent: 0, total: data.total })

            // Clear form immediately; the job continues server-side regardless
            // of whether this tab stays open to watch it.
            setMessage('')
            setSelectedUsers(new Set())

            await pollJobStatus(data.jobId)
        } catch (error: any) {
            console.error('Error sending SMS:', error)
            toast.error(error.message || 'Failed to send SMS')
        } finally {
            setSending(false)
        }
    }

    const getRoleBadgeColor = (role: string) => {
        switch (role) {
            case 'admin': return 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400'
            case 'sub-admin': return 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-400'
            case 'shop_owner': return 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-400'
            default: return 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400'
        }
    }

    // What actually gets queued: the greeting goes in front unless the admin
    // already placed {name} themselves.
    const finalMessage = greet && message.trim() && !hasNameToken(message)
        ? GREETING_PREFIX + message.trim()
        : message.trim()

    // Preview with the first selected person's name, or a sample.
    const previewUser = users.find(u => selectedUsers.has(u.id))
    const previewName = !previewUser
        ? 'Derrick'
        : previewUser.id.startsWith('shop_') ? greetShopName(previewUser.last_name) : greetName(previewUser.first_name)
    const preview = renderBroadcast(finalMessage, { greet_name: previewName })

    const insertName = () => {
        setMessage(m => (m ? `${m} ${NAME_TOKEN}` : `${GREETING_PREFIX}`))
    }

    const characterCount = preview.length
    const smsCount = Math.ceil(characterCount / 160) || 1

    return (
        <div className="space-y-6">
            <div>
                <h1 className="text-2xl font-bold">SMS Broadcast</h1>
                <p className="text-muted-foreground">Send SMS alerts to your customers</p>
            </div>

            {activeJob && (
                <div className="flex flex-col gap-3 rounded-lg border border-amber-300 bg-amber-50 p-4 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex items-start gap-2 text-sm">
                        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                        <span>
                            An earlier broadcast did not finish: <strong>{activeJob.sent_count} / {activeJob.total}</strong> sent
                            {' '}(started {new Date(activeJob.created_at).toLocaleString()}). It is paused — nothing is sent unless you resume it.
                        </span>
                    </div>
                    <div className="flex gap-2">
                        <Button size="sm" onClick={handleResume} disabled={sending || cancelling}>
                            <Play className="mr-1 h-4 w-4" /> Resume
                        </Button>
                        <Button size="sm" variant="outline" onClick={handleCancel} disabled={sending || cancelling}>
                            {cancelling ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Ban className="mr-1 h-4 w-4" />}
                            Cancel it
                        </Button>
                    </div>
                </div>
            )}

            <div className="grid gap-6 lg:grid-cols-2">
                {/* Compose SMS Card */}
                <Card className="h-fit">
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2">
                            <MessageSquare className="w-5 h-5 text-primary" />
                            Compose SMS
                        </CardTitle>
                        <CardDescription>
                            Write your message below. Keep it concise for best delivery.
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-4">
                        <div className="space-y-2">
                            <Label htmlFor="message">Message</Label>
                            <Textarea
                                id="message"
                                placeholder="Type your SMS message here..."
                                className="min-h-[150px] resize-none"
                                value={message}
                                onChange={(e) => setMessage(e.target.value)}
                                maxLength={480}
                            />
                            <div className="flex justify-between text-xs text-muted-foreground">
                                <span>{characterCount} / 480 characters</span>
                                <span>{smsCount} SMS{smsCount > 1 ? 's' : ''} (160 chars each)</span>
                            </div>
                        </div>

                        <div className="flex items-center justify-between gap-3">
                            <Label htmlFor="greet" className="flex flex-col gap-0.5 font-normal">
                                <span className="font-medium">Greet each person by name</span>
                                <span className="text-xs text-muted-foreground">
                                    Adds &quot;Hi Derrick!&quot; with each person&apos;s own first name
                                </span>
                            </Label>
                            <Switch id="greet" checked={greet} onCheckedChange={setGreet} />
                        </div>
                        <button
                            type="button"
                            onClick={insertName}
                            className="text-xs text-primary underline-offset-2 hover:underline"
                        >
                            Insert {NAME_TOKEN} somewhere else in the message
                        </button>

                        {message.trim() && (
                            <div className="space-y-1">
                                <Label className="text-xs text-muted-foreground">
                                    Preview — what {previewUser ? previewName : 'a customer'} will receive
                                </Label>
                                <div className="rounded-2xl bg-muted px-4 py-3 text-sm whitespace-pre-wrap break-words">
                                    {preview}
                                </div>
                                {hasNameToken(finalMessage) && (
                                    <p className="text-[11px] text-muted-foreground">
                                        Names differ in length, so some messages may be a few characters longer.
                                    </p>
                                )}
                            </div>
                        )}

                        <div className="p-3 rounded-lg bg-muted/50 space-y-1">
                            <div className="flex justify-between text-sm">
                                <span className="text-muted-foreground">Selected Recipients:</span>
                                <span className="font-medium">{selectedUsers.size}</span>
                            </div>
                            <div className="flex justify-between text-sm">
                                <span className="text-muted-foreground">SMS per recipient:</span>
                                <span className="font-medium">{smsCount} SMS</span>
                            </div>
                            <div className="flex justify-between text-sm font-semibold">
                                <span className="text-muted-foreground">Est. Total Cost:</span>
                                <span className="font-medium">
                                    {selectedUsers.size > 0
                                        ? `${selectedUsers.size * smsCount} SMS units`
                                        : `— (select recipients)`}
                                </span>
                            </div>
                        </div>

                        <Button
                            onClick={handleSendSMS}
                            className="w-full"
                            disabled={sending || selectedUsers.size === 0 || !message.trim()}
                        >
                            {sending ? (
                                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                            ) : (
                                <Send className="w-4 h-4 mr-2" />
                            )}
                            Send SMS to {selectedUsers.size} Recipient{selectedUsers.size !== 1 ? 's' : ''}
                        </Button>

                        {jobProgress && (
                            <div className="space-y-1">
                                <div className="flex justify-between text-xs text-muted-foreground">
                                    <span>Sending in background…</span>
                                    <span>{jobProgress.sent} / {jobProgress.total}</span>
                                </div>
                                <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                                    <div
                                        className="h-full bg-primary transition-all"
                                        style={{ width: `${jobProgress.total > 0 ? (jobProgress.sent / jobProgress.total) * 100 : 0}%` }}
                                    />
                                </div>
                            </div>
                        )}
                    </CardContent>
                </Card>

                {/* Recipients Selection Card */}
                <Card>
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2">
                            <Users className="w-5 h-5 text-primary" />
                            Select Recipients
                        </CardTitle>
                        <CardDescription>
                            Choose individual users or filter by role
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-4">
                        {/* Filters */}
                        <div className="flex gap-2">
                            <div className="flex-1 relative">
                                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                                <Input
                                    placeholder="Search by name, phone, or email..."
                                    value={searchQuery}
                                    onChange={(e) => setSearchQuery(e.target.value)}
                                    className="pl-9"
                                />
                            </div>
                            <Select value={roleFilter} onValueChange={setRoleFilter}>
                                <SelectTrigger className="w-[140px]">
                                    <SelectValue placeholder="Role" />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="all">All Roles</SelectItem>
                                    <SelectItem value="customer">Customers</SelectItem>
                                    <SelectItem value="agent">Agents</SelectItem>
                                    <SelectItem value="shop_owner">Shop Owners</SelectItem>
                                    <SelectItem value="dealer">Dealers</SelectItem>
                                    <SelectItem value="sub-admin">Sub-Admins</SelectItem>
                                    <SelectItem value="admin">Admins</SelectItem>
                                </SelectContent>
                            </Select>
                        </div>

                        {/* Bulk Actions */}
                        <div className="flex gap-2">
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={handleSelectAll}
                                className="flex-1"
                            >
                                <CheckSquare className="w-4 h-4 mr-2" />
                                Select All ({filteredUsers.length})
                            </Button>
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={handleDeselectAll}
                                className="flex-1"
                            >
                                <XSquare className="w-4 h-4 mr-2" />
                                Deselect All
                            </Button>
                        </div>

                        {/* User List */}
                        <div className="border rounded-lg max-h-[400px] overflow-y-auto">
                            {loading ? (
                                <div className="flex items-center justify-center py-8">
                                    <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
                                </div>
                            ) : filteredUsers.length === 0 ? (
                                <div className="text-center py-8 text-muted-foreground">
                                    No users found
                                </div>
                            ) : (
                                <div className="divide-y">
                                    {filteredUsers.map((user) => (
                                        <label
                                            key={user.id}
                                            className="flex items-center gap-3 p-3 hover:bg-muted/50 cursor-pointer transition-colors"
                                        >
                                            <Checkbox
                                                checked={selectedUsers.has(user.id)}
                                                onCheckedChange={() => handleToggleUser(user.id)}
                                            />
                                            <div className="flex-1 min-w-0">
                                                <div className="flex items-center gap-2">
                                                    <span className="font-medium truncate">
                                                        {user.first_name} {user.last_name}
                                                    </span>
                                                    <Badge className={`text-[10px] ${getRoleBadgeColor(user.role)}`}>
                                                        {user.role}
                                                    </Badge>
                                                </div>
                                                <div className="text-xs text-muted-foreground truncate">
                                                    {user.phone_number}
                                                </div>
                                            </div>
                                        </label>
                                    ))}
                                </div>
                            )}
                        </div>

                        <div className="text-xs text-muted-foreground text-center">
                            Showing {filteredUsers.length} of {users.length} users with phone numbers
                        </div>
                    </CardContent>
                </Card>
            </div>
        </div>
    )
}
