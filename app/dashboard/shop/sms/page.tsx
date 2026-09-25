'use client'

import { CustomerSmsPanel } from '@/components/sms/customer-sms-panel'

export default function CustomerSmsPage() {
    return (
        <CustomerSmsPanel
            backHref="/dashboard/shop"
            setupHref="/dashboard/shop/setup"
        />
    )
}
