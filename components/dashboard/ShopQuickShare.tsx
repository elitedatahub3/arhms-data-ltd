'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { QRCodeCanvas, QRCodeSVG } from 'qrcode.react'
import { QrCode, Copy, Check, MessageCircle, Download, Share2, ChevronDown } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { shopUrl as buildShopUrl } from '@/lib/shop-url'

interface ShopQuickShareProps {
    shopSlug: string
    shopName?: string
    /** compact keeps the QR and tips behind a toggle (dashboard home); full shows everything (shop page). */
    variant?: 'full' | 'compact'
    /** Where the SMS tip links; sub-agents have their own SMS page. */
    smsHref?: string
}

const PRINT_QR_SIZE = 1024

export function ShopQuickShare({ shopSlug, shopName, variant = 'full', smsHref = '/dashboard/shop/sms' }: ShopQuickShareProps) {
    const [copied, setCopied] = useState(false)
    const [expanded, setExpanded] = useState(variant === 'full')
    const [canNativeShare, setCanNativeShare] = useState(false)
    const printCanvasRef = useRef<HTMLCanvasElement>(null)
    const shopUrl = buildShopUrl(shopSlug)
    const shareText = `Buy cheap data from my shop! Check it out here: ${shopUrl}`

    // navigator.share only exists in the browser; checking after mount avoids a hydration mismatch.
    useEffect(() => {
        setCanNativeShare(typeof navigator !== 'undefined' && typeof navigator.share === 'function')
    }, [])

    // The SMS tip only makes sense once the shop can actually broadcast. Until it
    // has an approved sender ID it is pointed at getting one; when SMS is off or
    // unavailable to this shop the tip is left out. Fetched once the tips show.
    const [smsState, setSmsState] = useState<'unknown' | 'ready' | 'needs_sender' | 'hidden'>('unknown')
    useEffect(() => {
        if (!expanded || smsState !== 'unknown') return
        let cancelled = false
        ;(async () => {
            try {
                const res = await fetch('/api/sms/account', { cache: 'no-store' })
                const data = res.ok ? await res.json() : null
                if (cancelled) return
                if (!data?.success || !data.enabled || !data.eligible) return setSmsState('hidden')
                const hasApproved = (data.senderIds || []).some((s: any) => s.status === 'approved')
                setSmsState(hasApproved && data.account?.status === 'active' ? 'ready' : 'needs_sender')
            } catch {
                if (!cancelled) setSmsState('hidden')
            }
        })()
        return () => { cancelled = true }
    }, [expanded, smsState])

    const handleCopy = async () => {
        try {
            await navigator.clipboard.writeText(shopUrl)
            setCopied(true)
            toast.success('Shop link copied to clipboard!')
            setTimeout(() => setCopied(false), 2000)
        } catch (err) {
            toast.error('Failed to copy link')
        }
    }

    const shareToWhatsApp = () => {
        window.open(`https://wa.me/?text=${encodeURIComponent(shareText)}`, '_blank')
    }

    const handleNativeShare = async () => {
        try {
            await navigator.share({ title: shopName || 'My shop', text: shareText, url: shopUrl })
        } catch {
            // user dismissed the share sheet
        }
    }

    // A print-ready PNG: QR on white with the shop name and link underneath.
    const downloadQr = () => {
        const qr = printCanvasRef.current
        if (!qr) return
        const pad = 96
        const textBlock = 200
        const out = document.createElement('canvas')
        out.width = PRINT_QR_SIZE + pad * 2
        out.height = PRINT_QR_SIZE + pad * 2 + textBlock
        const ctx = out.getContext('2d')
        if (!ctx) return
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, out.width, out.height)
        ctx.drawImage(qr, pad, pad, PRINT_QR_SIZE, PRINT_QR_SIZE)
        ctx.textAlign = 'center'
        ctx.fillStyle = '#111827'
        ctx.font = 'bold 64px system-ui, sans-serif'
        ctx.fillText(shopName || 'Scan to shop', out.width / 2, PRINT_QR_SIZE + pad + 110, out.width - pad)
        ctx.fillStyle = '#059669'
        ctx.font = '40px ui-monospace, monospace'
        ctx.fillText(shopUrl.replace(/^https?:\/\//, ''), out.width / 2, PRINT_QR_SIZE + pad + 180, out.width - pad)

        const a = document.createElement('a')
        a.href = out.toDataURL('image/png')
        a.download = `${shopSlug}-qr.png`
        a.click()
        toast.success('QR code downloaded')
    }

    const linkClass = 'font-semibold text-emerald-600 dark:text-emerald-400 underline-offset-2 hover:underline'
    const tips: React.ReactNode[] = [
        'Post your link on WhatsApp status daily — consistency beats one big push.',
        'Print the QR code and place it where your community gathers.',
        'Reward returning customers with a small discount on bulk orders.',
    ]
    if (smsState === 'ready') {
        tips.push(
            <>
                Use <Link href={smsHref} className={linkClass}>SMS broadcasts</Link> to announce promos to your customer list.
            </>
        )
    } else if (smsState === 'needs_sender') {
        tips.push(
            <>
                Want to text promos to your customers?{' '}
                <Link href={`${smsHref}?tab=senders`} className={linkClass}>Get your sender ID approved</Link> first.
            </>
        )
    }

    return (
        <Card className="bg-gradient-to-br from-emerald-500/10 to-emerald-500/5 border-emerald-500/20">
            <CardContent className="p-4 sm:p-6 space-y-4">
                <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center flex-shrink-0">
                        <QrCode className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />
                    </div>
                    <div className="min-w-0">
                        <h3 className="font-bold text-gray-900 dark:text-gray-100">Share Your Shop</h3>
                        <p className="text-xs text-muted-foreground mt-0.5">Customers can scan, tap, or get the link on WhatsApp</p>
                    </div>
                </div>

                {expanded && (
                    <div className="flex flex-col items-center gap-3">
                        {/* Always white so phone cameras can read it in dark mode too */}
                        <div className="rounded-2xl bg-white p-3 shadow-sm">
                            <QRCodeSVG value={shopUrl} size={168} level="M" marginSize={0} />
                        </div>
                        <Button onClick={downloadQr} variant="outline" size="sm" className="h-8 gap-2 rounded-lg">
                            <Download className="w-4 h-4" /> Download QR to print
                        </Button>
                        <div className="hidden" aria-hidden>
                            <QRCodeCanvas ref={printCanvasRef} value={shopUrl} size={PRINT_QR_SIZE} level="M" marginSize={0} />
                        </div>
                    </div>
                )}

                <div className="rounded-xl border border-gray-200 dark:border-zinc-800 bg-white/70 dark:bg-zinc-900/70 p-3 space-y-3">
                    <p className="text-xs sm:text-sm font-mono text-gray-700 dark:text-gray-300 truncate px-1">{shopUrl}</p>
                    <div className={cn('grid gap-2', canNativeShare ? 'grid-cols-[1fr_1fr_auto]' : 'grid-cols-2')}>
                        <Button
                            onClick={handleCopy}
                            variant="outline"
                            className={cn(
                                'h-10 gap-2 rounded-lg font-semibold transition-all',
                                copied && 'bg-emerald-50 text-emerald-600 border-emerald-200 dark:bg-emerald-900/20 dark:border-emerald-800'
                            )}
                        >
                            {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                            {copied ? 'Copied!' : 'Copy'}
                        </Button>
                        <Button onClick={shareToWhatsApp} className="h-10 gap-2 rounded-lg font-semibold bg-[#25D366] hover:bg-[#1ebe5b] text-white">
                            <MessageCircle className="w-4 h-4" /> WhatsApp
                        </Button>
                        {canNativeShare && (
                            <Button onClick={handleNativeShare} variant="outline" className="h-10 w-10 p-0 rounded-lg" aria-label="More ways to share">
                                <Share2 className="w-4 h-4" />
                            </Button>
                        )}
                    </div>
                </div>

                {expanded ? (
                    <ul className="space-y-2">
                        {tips.map((tip, i) => (
                            <li key={i} className="flex gap-2 text-xs sm:text-sm text-gray-600 dark:text-gray-400">
                                <span className="mt-1.5 h-1.5 w-1.5 rounded-full bg-emerald-500 flex-shrink-0" />
                                <span>{tip}</span>
                            </li>
                        ))}
                    </ul>
                ) : (
                    <button
                        type="button"
                        onClick={() => setExpanded(true)}
                        className="flex w-full items-center justify-center gap-1 text-xs font-semibold text-emerald-700 dark:text-emerald-400 hover:underline"
                    >
                        Show QR code &amp; growth tips <ChevronDown className="w-3.5 h-3.5" />
                    </button>
                )}
            </CardContent>
        </Card>
    )
}
