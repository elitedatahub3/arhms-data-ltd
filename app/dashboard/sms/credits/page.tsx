'use client'

import { Coins } from 'lucide-react'
import { SmsCredits } from '@/components/sms/sms-credits'
import { SmsActiveGate, SmsPageHeader, useSmsPlatform } from '@/components/sms/platform/sms-platform-shell'

export default function SmsCreditsPage() {
    const { reload } = useSmsPlatform()

    return (
        <>
            <SmsPageHeader title="Credits" description="One credit sends one SMS part to one number." icon={Coins} />
            <SmsActiveGate>
                {(info) => <SmsCredits credits={info.account.credits} onPurchased={() => { reload() }} portal="platform" />}
            </SmsActiveGate>
        </>
    )
}
