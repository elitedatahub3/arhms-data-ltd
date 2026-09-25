'use client'

/**
 * Sub-Agent "Customer SMS" — the sub messages their own storefront customers.
 * Same panel and endpoints as the shop-owner page; the sub's SMS account is
 * entirely their own (own unlock, sender ID, credits and customer list), and
 * the page is de-branded because the sub trades under their own name here.
 */

import { CustomerSmsPanel } from '@/components/sms/customer-sms-panel'

export default function SubCustomerSmsPage() {
    return (
        <div className="max-w-3xl mx-auto p-4">
            <CustomerSmsPanel
                backHref="/dashboard/sub"
                backLabel="Back to Dashboard"
                setupHref="/dashboard/sub/shop"
                deBranded
            />
        </div>
    )
}
