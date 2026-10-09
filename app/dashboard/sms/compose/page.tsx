'use client'

import { useRouter } from 'next/navigation'
import { Send } from 'lucide-react'
import { SmsCompose } from '@/components/sms/sms-compose'
import { SmsActiveGate, SmsPageHeader, useSmsPlatform } from '@/components/sms/platform/sms-platform-shell'

export default function SmsComposePage() {
    const router = useRouter()
    const { groups, reload } = useSmsPlatform()

    return (
        <>
            <SmsPageHeader title="Compose" description="Write once, send to numbers, groups or all your contacts." icon={Send} />
            <SmsActiveGate>
                {(info) => (
                    <SmsCompose
                        mode={info.mode}
                        credits={info.account.credits}
                        allowedSenders={info.allowedSenders}
                        groups={groups}
                        contactCount={info.contactCount}
                        onSent={(campaignId) => { reload(); router.push(`/dashboard/sms/records?id=${campaignId}`) }}
                        onNeedCredits={() => router.push('/dashboard/sms/credits')}
                        onNeedSender={() => router.push('/dashboard/sms/business')}
                    />
                )}
            </SmsActiveGate>
        </>
    )
}
