import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { checkOrderStatus } from '@/lib/codecraft-service'
import { areCronJobsEnabled, cronDisabledResponse, isCronAuthorized, cronUnauthorizedResponse } from '@/lib/cron-control'

// ─── Shared Package Type Resolver ─────────────────────────────────────────────
function resolvePackageType(network: string, gigValue: number): 'regular' | 'bigtime' {
    if (network === 'MTN') return 'regular'
    if (network === 'AT-iShare') return 'regular'
    if (network === 'AT-BigTime') return 'bigtime'
    if (network === 'Telecel') return 'regular'
    return 'regular' // safe default
}

// ─── GB Parser ────────────────────────────────────────────────────────────────
function parseGigValue(sizeString: string): number {
    const match = sizeString.match(/[\d.]+/)
    if (!match) return 0
    return parseFloat(match[0]) || 0
}

// ─── Network Parser from package_size string (shop_orders) ───────────────────
// package_size format example: "MTN 10GB Data" or "AT-iShare 5GB" or "Telecel 2GB"
function parseNetworkFromPackageSize(packageSize: string): string {
    const upper = packageSize.toUpperCase()
    if (upper.startsWith('AT-BIGTIME')) return 'AT-BigTime'
    if (upper.startsWith('AT-ISHARE') || upper.startsWith('ATISHARE')) return 'AT-iShare'
    if (upper.startsWith('AT')) return 'AT-iShare' // safe fallback for plain 'AT'
    if (upper.startsWith('TELECEL')) return 'Telecel'
    if (upper.startsWith('SPECIAL MTN MASHUP')) return 'Special MTN Mashup'
    if (upper.startsWith('MTN')) return 'MTN'
    return ''
}

// This cron polls the supplier once PER ORDER, serially. Without a duration cap the
// platform kills the function mid-loop and every order after that point is silently
// skipped — so give it room, then stop ourselves just short of the kill with a clean
// response. Combined with oldest-first ordering, the next run resumes where we left off.
export const maxDuration = 60
const RUN_BUDGET_MS = 50_000

export async function GET(request: NextRequest) {
    if (!areCronJobsEnabled()) return cronDisabledResponse()

    const startedAt = Date.now()
    const outOfTime = () => Date.now() - startedAt > RUN_BUDGET_MS

    // Verify cron secret
    if (!isCronAuthorized(request)) {
        return cronUnauthorizedResponse()
    }

    const supabase = createServerClient()
    let totalChecked = 0
    let totalUpdated = 0
    let totalFailed = 0
    const errors: string[] = []

    // ── Part A: shop_orders ───────────────────────────────────────────────────
    try {
        const { data: shopOrders, error: shopError } = await (supabase
            .from('shop_orders') as any)
            .select('id, codecraft_reference_id, package_size, status')
            .eq('fulfilled_by', 'codecraft')
            .in('status', ['pending', 'processing'])
            .not('codecraft_reference_id', 'is', null)
            // Oldest first: without an explicit order Postgres returns an arbitrary
            // (but stable) page, so anything past the limit is NEVER checked and the
            // backlog starves itself. Oldest-first guarantees stuck orders drain.
            .order('created_at', { ascending: true })
            .limit(50)

        if (shopError) {
            console.error('[CronSync] shop_orders query error:', shopError)
            errors.push(`shop_orders query failed: ${shopError.message}`)
        } else {
            for (const order of shopOrders || []) {
                if (outOfTime()) {
                    errors.push('shop_orders: run budget exhausted — remaining orders deferred to next run')
                    break
                }
                totalChecked++
                try {
                    const packageSize: string = order.package_size || ''
                    const network = parseNetworkFromPackageSize(packageSize)
                    const gigValue = parseGigValue(packageSize)

                    if (network === 'Special MTN Mashup') continue

                    if (!network || gigValue <= 0) {
                        console.warn(`[CronSync] shop_orders: Cannot parse network/gig from package_size="${packageSize}" for order ${order.id}`)
                        continue
                    }

                    const packageType = resolvePackageType(network, gigValue)
                    const statusResult = await checkOrderStatus(order.codecraft_reference_id, packageType)

                    if (!statusResult.success) continue

                    const newStatus = statusResult.status
                    if (newStatus === order.status || newStatus === 'processing') continue

                    // Update shop_orders — NO wallet touch, NO payment_status change
                    const { error: updateError } = await (supabase
                        .from('shop_orders') as any)
                        .update({
                            status: newStatus,
                            updated_at: new Date().toISOString(),
                        })
                        .eq('id', order.id)

                    if (updateError) {
                        console.error(`[CronSync] shop_orders DB update failed for ${order.id}:`, updateError.message)
                        errors.push(`DB update failed for ${order.id}: ${updateError.message}`)
                        totalFailed++
                    } else {
                        console.log(`[CronSync] shop_orders ${order.id}: ${order.status} → ${newStatus}`)
                        totalUpdated++
                    }
                } catch (orderErr: any) {
                    console.error(`[CronSync] shop_orders exception for ${order.id}:`, orderErr)
                    errors.push(`shop_orders exception for ${order.id}: ${orderErr.message}`)
                    totalFailed++
                }
            }
        }
    } catch (partAErr: any) {
        console.error('[CronSync] Part A (shop_orders) failed:', partAErr)
        errors.push(`Part A failed: ${partAErr.message}`)
    }

    // ── Part B: orders ────────────────────────────────────────────────────────
    try {
        const { data: mainOrders, error: mainError } = await (supabase
            .from('orders') as any)
            .select('id, codecraft_reference, network, size, status')
            .eq('fulfillment_method', 'codecraft')
            .in('status', ['pending', 'processing'])
            .not('codecraft_reference', 'is', null)
            // Oldest first: without an explicit order Postgres returns an arbitrary
            // (but stable) page, so anything past the limit is NEVER checked and the
            // backlog starves itself. Oldest-first guarantees stuck orders drain.
            .order('created_at', { ascending: true })
            .limit(50)

        if (mainError) {
            console.error('[CronSync] orders query error:', mainError)
            errors.push(`orders query failed: ${mainError.message}`)
        } else {
            for (const order of mainOrders || []) {
                if (outOfTime()) {
                    errors.push('orders: run budget exhausted — remaining orders deferred to next run')
                    break
                }
                totalChecked++
                try {
                    const network: string = order.network || ''
                    const gigValue = parseGigValue(order.size || '')

                    if (network === 'Special MTN Mashup') continue

                    if (!network || gigValue <= 0) {
                        console.warn(`[CronSync] orders: Cannot parse network/gig for order ${order.id} (network="${network}", size="${order.size}")`)
                        continue
                    }

                    const packageType = resolvePackageType(network, gigValue)
                    const statusResult = await checkOrderStatus(order.codecraft_reference, packageType)

                    if (!statusResult.success) continue

                    const newStatus = statusResult.status
                    if (newStatus === order.status || newStatus === 'processing') continue

                    // Update orders — NO wallet touch, NO refund logic
                    const { error: updateError } = await (supabase
                        .from('orders') as any)
                        .update({
                            status: newStatus,
                            updated_at: new Date().toISOString(),
                        })
                        .eq('id', order.id)

                    if (updateError) {
                        console.error(`[CronSync] orders DB update failed for ${order.id}:`, updateError.message)
                        errors.push(`DB update failed for ${order.id}: ${updateError.message}`)
                        totalFailed++
                    } else {
                        console.log(`[CronSync] orders ${order.id}: ${order.status} → ${newStatus}`)
                        totalUpdated++
                    }
                } catch (orderErr: any) {
                    console.error(`[CronSync] orders exception for ${order.id}:`, orderErr)
                    errors.push(`orders exception for ${order.id}: ${orderErr.message}`)
                    totalFailed++
                }
            }
        }
    } catch (partBErr: any) {
        console.error('[CronSync] Part B (orders) failed:', partBErr)
        errors.push(`Part B failed: ${partBErr.message}`)
    }

    return NextResponse.json({
        success: true,
        checked: totalChecked,
        updated: totalUpdated,
        failed: totalFailed,
        errors,
    })
}

// Accept any method (cron-job.org's sent method doesn't always match its UI); auth-gated.
export const POST = GET
export const PUT = GET
export const PATCH = GET
export const DELETE = GET

