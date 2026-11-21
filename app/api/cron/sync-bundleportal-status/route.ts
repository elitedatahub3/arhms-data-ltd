import { NextRequest, NextResponse } from 'next/server'
import { reconcileBundlePortalOrders } from '@/lib/bundleportal-reconcile'
import { areCronJobsEnabled, cronDisabledResponse } from '@/lib/cron-control'
import { sendPushToAdmins } from '@/lib/web-push'

// BundlePortal reconciliation cron — the SAFETY NET behind
// app/api/webhooks/bundleportal. BundlePortal never retries a webhook, so this is
// the ONLY way an order whose delivery we missed ever leaves 'processing'.
// The logic lives in lib/bundleportal-reconcile (shared with the admin Sync button).
//
// Scheduling:
//   • cron-job.org → GET https://arhmsgh.com/api/cron/sync-bundleportal-status
//     with header `Authorization: Bearer <CRON_SECRET>`, every 10 min. NEVER the
//     www host — the cross-host 307 strips the auth header.
//
// CRON_JOBS_ENABLED must be 'true'. When it is not, this returns HTTP 200
// {"disabled": true} and the console stays GREEN while nothing reconciles.

export const maxDuration = 60

export async function GET(request: NextRequest) {
    if (!areCronJobsEnabled()) return cronDisabledResponse()

    const authHeader = request.headers.get('authorization')
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const result = await reconcileBundlePortalOrders()

    if (result.refunded.length > 0) {
        const first = result.refunded[0]
        const more = result.refunded.length > 1 ? ` (+${result.refunded.length - 1} more)` : ''
        await sendPushToAdmins({
            title: `BundlePortal refunded ${result.refunded.length} order${result.refunded.length > 1 ? 's' : ''}`,
            body: `Marked failed — refund the customer: ${first.size ?? ''} ${first.phone ?? first.id}${more}`,
            url: '/admin/orders',
            tag: 'bundleportal-refunded',
        }).catch(() => {})
    }

    // "History scan incomplete" is routine — BundlePortal's history endpoint
    // drops a page now and then, and the unchecked orders are picked up on the
    // next 10-minute run. It stays in the JSON result; it no longer pushes.
    const pushable = result.errors.filter((e) => !e.includes('history scan incomplete'))
    if (pushable.length > 0) {
        await sendPushToAdmins({
            title: 'BundlePortal sync failing',
            body: pushable[0],
            url: '/admin/orders',
            tag: 'bundleportal-sync-error',
        }).catch(() => {})
    }

    return NextResponse.json(result)
}

// Accept any method (cron-job.org's sent method doesn't always match its UI); auth-gated.
export const POST = GET
export const PUT = GET
export const PATCH = GET
export const DELETE = GET
