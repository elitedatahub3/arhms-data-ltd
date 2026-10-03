'use client'

import { useState } from 'react'
import { Link2, Copy, Check, ExternalLink } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'

interface ShopQuickShareProps {
    shopSlug: string
}

export function ShopQuickShare({ shopSlug }: ShopQuickShareProps) {
    const [copied, setCopied] = useState(false)
    const baseOrigin = typeof window !== 'undefined' ? window.location.origin : (process.env.NEXT_PUBLIC_APP_URL || 'https://www.dataking.qzz.io')
    const shopUrl = `${baseOrigin}/shop/${shopSlug}`

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
        const text = encodeURIComponent(`Buy cheap data from my shop! Check it out here: ${shopUrl}`)
        window.open(`https://wa.me/?text=${text}`, '_blank')
    }

    return (
        <Card className="bg-gradient-to-br from-emerald-500/10 to-emerald-500/5 border-emerald-500/20">
            <CardContent className="p-4 sm:p-6">
                <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                    <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-xl bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center flex-shrink-0">
                            <Link2 className="w-5 h-5 text-emerald-600 dark:text-emerald-400 -rotate-45" />
                        </div>
                        <div>
                            <h3 className="font-bold text-gray-900 dark:text-gray-100">Share Your Shop</h3>
                            <p className="text-xs text-muted-foreground mt-0.5">Copy your link to get more customers</p>
                        </div>
                    </div>

                    <div className="flex items-center gap-2 w-full sm:w-auto">
                        <div className="flex-1 sm:hidden bg-white dark:bg-zinc-900 border border-gray-200 dark:border-zinc-800 rounded-lg px-3 py-2 text-xs font-mono text-emerald-600 truncate">
                            {shopUrl}
                        </div>
                        <Button 
                            onClick={handleCopy} 
                            variant="outline" 
                            className={cn(
                                "h-9 px-3 gap-2 transition-all",
                                copied ? "bg-emerald-50 text-emerald-600 border-emerald-200 dark:bg-emerald-900/20 dark:border-emerald-800" : ""
                            )}
                        >
                            {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4 text-gray-500" />}
                            <span className="hidden sm:inline">{copied ? 'Copied!' : 'Copy Link'}</span>
                        </Button>
                        <Button onClick={shareToWhatsApp} className="h-9 bg-emerald-600 hover:bg-emerald-700 text-white gap-2">
                            <ExternalLink className="w-4 h-4" />
                            <span className="hidden sm:inline">WhatsApp</span>
                        </Button>
                    </div>
                </div>
            </CardContent>
        </Card>
    )
}
