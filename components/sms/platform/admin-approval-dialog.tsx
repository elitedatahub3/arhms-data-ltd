'use client'

/**
 * "Waiting for admin approval" popup with a WhatsApp button that opens a chat
 * with the admin, message prefilled. Used on the SMS Platform when a business
 * registration is submitted and when an SMS API key is generated — both stay
 * pending until the admin approves them.
 *
 * Same look and behaviour as the approval dialog on /dashboard/developer-api.
 */

import { useEffect, useState } from 'react'
import { ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'

/** wa.me link for a number in any form, with an optional prefilled message. */
export function whatsappLink(number: string, text?: string): string | null {
    const digits = String(number || '').replace(/\D/g, '')
    if (!digits) return null
    return `https://wa.me/${digits}${text ? `?text=${encodeURIComponent(text)}` : ''}`
}

/** The admin's WhatsApp number (Admin → Settings → WhatsApp Admin Number), or '' if unset. */
export function useAdminWhatsApp(): string {
    const [number, setNumber] = useState('')
    useEffect(() => {
        let cancelled = false
        fetch('/api/admin-settings?keys=whatsapp_admin_number', { cache: 'no-store' })
            .then((r) => r.json())
            .then((d) => { if (!cancelled && d?.whatsapp_admin_number) setNumber(String(d.whatsapp_admin_number)) })
            .catch(() => { /* no number: the dialog falls back to "contact support" */ })
        return () => { cancelled = true }
    }, [])
    return number
}

export function WhatsAppIcon({ className = 'w-5 h-5' }: { className?: string }) {
    return (
        <svg viewBox="0 0 24 24" className={`${className} fill-current`} aria-hidden="true">
            <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
        </svg>
    )
}

/** Green "Chat admin on WhatsApp" button; renders nothing without a number. */
export function WhatsAppAdminButton({ number, text, label = 'Chat Admin on WhatsApp', size = 'lg' }: {
    number: string
    text: string
    label?: string
    size?: 'lg' | 'sm'
}) {
    const href = whatsappLink(number, text)
    if (!href) return null
    return (
        <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className={size === 'lg'
                ? 'inline-flex items-center justify-center gap-2 w-full py-3 px-4 rounded-xl bg-[#25D366] hover:bg-[#1ebe5d] text-white font-bold text-sm transition-colors shadow-md'
                : 'inline-flex items-center gap-1.5 rounded-lg bg-[#25D366] hover:bg-[#1ebe5d] px-3 py-1.5 text-white font-bold text-xs transition-colors'}
        >
            <WhatsAppIcon className={size === 'lg' ? 'w-5 h-5' : 'w-3.5 h-3.5'} /> {label}
        </a>
    )
}

export function AdminApprovalDialog({ open, onOpenChange, title, body, whatsappNumber, whatsappText }: {
    open: boolean
    onOpenChange: (open: boolean) => void
    title: string
    body: string
    whatsappNumber: string
    whatsappText: string
}) {
    const hasNumber = !!whatsappLink(whatsappNumber)
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-sm text-center">
                <DialogHeader>
                    <div className="flex justify-center mb-3">
                        <div className="w-14 h-14 rounded-full bg-yellow-100 dark:bg-yellow-950/50 flex items-center justify-center">
                            <ShieldCheck className="w-7 h-7 text-yellow-600" />
                        </div>
                    </div>
                    <DialogTitle className="text-center">{title}</DialogTitle>
                    <DialogDescription className="text-center">
                        {body}{hasNumber ? '' : ' Please contact support to get it approved.'}
                    </DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-3 py-2">
                    <WhatsAppAdminButton number={whatsappNumber} text={whatsappText} />
                    <Button variant="outline" onClick={() => onOpenChange(false)} className="w-full">
                        I&apos;ll do it later
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    )
}
