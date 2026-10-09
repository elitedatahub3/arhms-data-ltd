'use client'

import { useEffect, useState } from 'react'
import { History } from 'lucide-react'
import { SmsHistory } from '@/components/sms/sms-history'
import { SmsActiveGate, SmsPageHeader } from '@/components/sms/platform/sms-platform-shell'

export default function SmsRecordsPage() {
    const [openId, setOpenId] = useState<string | null>(null)

    // Read once from the URL rather than via useSearchParams, which would need a
    // Suspense boundary. Compose lands here with ?id= after a send.
    useEffect(() => {
        const id = new URLSearchParams(window.location.search).get('id')
        if (id) setOpenId(id)
    }, [])

    const open = (id: string | null) => {
        setOpenId(id)
        const url = id ? `/dashboard/sms/records?id=${id}` : '/dashboard/sms/records'
        window.history.replaceState(null, '', url)
    }

    return (
        <>
            <SmsPageHeader title="Records" description="Every send, with delivery reports per recipient." icon={History} />
            <SmsActiveGate>
                {() => <SmsHistory openCampaignId={openId} onOpen={open} />}
            </SmsActiveGate>
        </>
    )
}
