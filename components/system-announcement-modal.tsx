'use client'

import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import { AnnouncementModal } from '@/components/announcements/announcement-modal'
import { SystemAnnouncement } from '@/types/supabase'

export function SystemAnnouncementModal({ initialAnnouncement = null }: { initialAnnouncement?: Partial<SystemAnnouncement> | null }) {
    const [announcement, setAnnouncement] = useState<Partial<SystemAnnouncement> | null>(null)
    const [isOpen, setIsOpen] = useState(false)
    const pathname = usePathname()

    // Only show the announcement on authenticated routes (dashboard, admin).
    // This prevents the sessionStorage "seen" key being consumed on auth/login pages
    // before the user ever reaches the dashboard.
    const isAuthenticatedRoute = pathname?.startsWith('/dashboard') || pathname?.startsWith('/admin')

    useEffect(() => {
        if (!isAuthenticatedRoute) return
        fetchAndCheck()
    }, [isAuthenticatedRoute])

    const fetchAndCheck = async () => {
        try {
            // Use the dedicated announcement endpoint:
            // - No caching (Cache-Control: no-store) → always fresh after login
            // - Uses service role key on server → bypasses RLS, no permission issues
            // - Falls back to the server-passed prop if the API fails
            let announcementData: Partial<SystemAnnouncement> | null = null

            try {
                const res = await fetch('/api/public/announcement', { cache: 'no-store' })
                if (res.ok) {
                    const json = await res.json()
                    announcementData = json.announcement ?? null
                }
            } catch {
                // If the API fails, fall back to the server-passed prop
                announcementData = initialAnnouncement
            }

            if (!announcementData?.id) return

            // Check if this specific announcement has already been seen in this session
            const seenKey = `announcement_seen_${announcementData.id}`
            const hasSeen = sessionStorage.getItem(seenKey)

            if (!hasSeen) {
                setAnnouncement(announcementData)
                setIsOpen(true)
            }
        } catch (error) {
            console.error('Failed to check announcements', error)
        }
    }

    const handleDismiss = () => {
        if (announcement?.id) {
            sessionStorage.setItem(`announcement_seen_${announcement.id}`, 'true')
            setIsOpen(false)
        }
    }

    if (!announcement) return null

    return (
        <AnnouncementModal
            open={isOpen}
            onOpenChange={setIsOpen}
            // Both were pinned before tones were selectable, which is why every
            // platform notice was amber. Fall back to that for rows predating the
            // column so nothing changes look until an admin picks a tone.
            tone={(announcement as any).tone || 'official'}
            badgeLabel={(announcement as any).badge_label || 'Official Notice'}
            title={announcement.title}
            message={announcement.message}
            onDismiss={handleDismiss}
            onRefresh={fetchAndCheck}
        />
    )
}
