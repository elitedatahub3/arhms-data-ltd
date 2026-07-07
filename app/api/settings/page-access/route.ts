import { NextResponse } from 'next/server'
import { getCachedPublicConfig } from '@/lib/public-config'

// Never CDN/browser-cache this response. The underlying config read is already
// memoized server-side (unstable_cache) and invalidated via revalidateTag on
// every admin save, so serving it fresh per request is cheap AND lets page-access
// toggles (e.g. Data Packages) take effect immediately instead of being pinned to
// a stale edge-cached value for up to an hour.
export const dynamic = 'force-dynamic'

export async function GET() {
    try {
        const config = await getCachedPublicConfig()

        return NextResponse.json(config.pageAccess, {
            headers: {
                'Cache-Control': 'no-store, must-revalidate',
            },
        })
    } catch (error) {
        console.error('Error in page-access API:', error)
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
    }
}
