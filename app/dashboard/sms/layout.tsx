'use client'

import { SmsPlatformProvider } from '@/components/sms/platform/sms-platform-shell'

export default function SmsPlatformLayout({ children }: { children: React.ReactNode }) {
    return (
        <SmsPlatformProvider>
            <div className="mx-auto max-w-3xl space-y-5 pb-20 md:pb-6">{children}</div>
        </SmsPlatformProvider>
    )
}
