'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { ArrowRight, Check, Copy, Crown, Loader2 } from 'lucide-react'
import { toast } from 'sonner'

/**
 * Invite-link generator for recruiting sub-agents.
 *
 * Shared by both portals: a Lead sees it on the shop overview, and a level-1
 * sub sees it in the de-branded portal, since the network runs three levels.
 * `manageHref` points at whichever downline screen belongs to that portal.
 *
 * Who may recruit is decided server-side by /api/shop/invites — a Lead always
 * may, a sub only while active and above the depth cap. Callers should still
 * avoid rendering this for a level-2 sub, who would only ever get an error.
 */
export default function SubAgentInviteCard({
    manageHref = '/dashboard/shop/sub-agents',
}: {
    manageHref?: string
}) {
    const [loading, setLoading] = useState(false)
    const [url, setUrl] = useState<string | null>(null)
    const [copied, setCopied] = useState(false)

    const generate = async () => {
        setLoading(true)
        try {
            const res = await fetch('/api/shop/invites', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ maxUses: null, expiresInHours: 168 }), // unlimited uses, 7-day expiry
            })
            const data = await res.json()
            if (res.ok && data?.invite?.url) {
                setUrl(data.invite.url)
            } else {
                toast.error(data.error || 'Could not generate invite link')
            }
        } catch {
            toast.error('Could not generate invite link')
        } finally {
            setLoading(false)
        }
    }

    const copy = async () => {
        if (!url) return
        await navigator.clipboard.writeText(url)
        setCopied(true)
        toast.success('Invite link copied')
        setTimeout(() => setCopied(false), 2000)
    }

    return (
        <div className="rounded-2xl border border-violet-100 dark:border-violet-900/40 bg-violet-50/50 dark:bg-violet-950/20 p-4 sm:p-5">
            <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-2 min-w-0">
                    <div className="w-9 h-9 rounded-xl bg-violet-100 dark:bg-violet-900/40 flex items-center justify-center flex-shrink-0">
                        <Crown className="w-5 h-5 text-violet-600 dark:text-violet-400" />
                    </div>
                    <div className="min-w-0">
                        <p className="font-bold text-sm text-violet-900 dark:text-violet-200">Recruit Sub-Agents</p>
                        <p className="text-xs text-violet-700 dark:text-violet-400 mt-0.5">Share an invite link to build your reseller network.</p>
                    </div>
                </div>
                {!url && (
                    <Button onClick={generate} disabled={loading} size="sm" className="h-9 gap-2 rounded-xl bg-violet-600 hover:bg-violet-700 text-white font-bold shrink-0">
                        {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Crown className="w-4 h-4" />} {loading ? 'Generating…' : 'Generate Invite'}
                    </Button>
                )}
            </div>

            <Link href={manageHref} className="block mt-3" aria-label="Manage and approve sub-agents">
                <Button variant="secondary" className="w-full h-9 bg-white dark:bg-zinc-900 text-violet-700 dark:text-violet-300 gap-2 rounded-xl font-bold border border-violet-100 dark:border-violet-900/40">
                    Manage &amp; Approve Sub-Agents <ArrowRight className="w-4 h-4" />
                </Button>
            </Link>

            {url && (
                <div className="mt-3 flex flex-col sm:flex-row items-center gap-2 bg-white dark:bg-zinc-900 p-2 sm:pl-4 rounded-xl border border-violet-100 dark:border-violet-900/40">
                    <span className="text-xs font-mono text-violet-800 dark:text-violet-300 truncate w-full px-1 text-center sm:text-left">{url}</span>
                    <div className="flex items-center gap-2 w-full sm:w-auto">
                        <Button onClick={copy} variant="secondary" className="flex-1 sm:flex-none h-9 bg-white dark:bg-zinc-900 text-violet-600 gap-2 rounded-xl font-bold">
                            {copied ? <Check className="w-4 h-4 text-green-500" /> : <Copy className="w-4 h-4" />} {copied ? 'Copied!' : 'Copy Link'}
                        </Button>
                    </div>
                </div>
            )}
        </div>
    )
}
