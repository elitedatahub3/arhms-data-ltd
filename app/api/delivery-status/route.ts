import { NextResponse } from 'next/server'
import { getDeliveryStatus } from '@/lib/delivery-status'

/**
 * Public: the dashboard widget, shop storefronts and the buy-confirm line all
 * poll this. It carries only computed durations — no order ids, phones or users.
 */
export async function GET() {
    try {
        const channels = await getDeliveryStatus()
        return NextResponse.json(
            { channels, generatedAt: new Date().toISOString() },
            { headers: { 'Cache-Control': 'public, s-maxage=20, stale-while-revalidate=40' } },
        )
    } catch (error: any) {
        console.error('[delivery-status]', error?.message)
        return NextResponse.json({ channels: [] }, { status: 503, headers: { 'Cache-Control': 'no-store' } })
    }
}
