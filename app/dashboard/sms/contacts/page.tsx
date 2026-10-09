'use client'

import { Users } from 'lucide-react'
import { SmsContacts } from '@/components/sms/sms-contacts'
import { SmsActiveGate, SmsPageHeader, useSmsPlatform } from '@/components/sms/platform/sms-platform-shell'

export default function SmsContactsPage() {
    const { groups, reload, reloadGroups } = useSmsPlatform()

    return (
        <>
            <SmsPageHeader title="Contacts & Groups" description="Reusable recipient lists for your SMS campaigns." icon={Users} />
            <SmsActiveGate>
                {(info) => (
                    <SmsContacts
                        hasShop={info.hasShop}
                        groups={groups}
                        onGroupsChanged={() => { reload(); reloadGroups() }}
                    />
                )}
            </SmsActiveGate>
        </>
    )
}
