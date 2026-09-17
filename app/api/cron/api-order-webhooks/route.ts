import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { deliverApiWebhook, type WebhookPayload } from '@/lib/api-webhook'
import { areCronJobsEnabled, cronDisabledResponse } from '@/lib/cron-control'

/**
 * Delivers order webhooks for API-created data and AFA orders (cron-job.org, every minute).
 *
 * Airtime and bills notify the partner the instant they settle, from their completion
 * helpers. Data and AFA have no equivalent chokepoint — around twenty-five call sites
 * move those rows to a terminal state — so this reads the result instead of trying to
 * intercept every writer. The cost is latency measured in one sweep; the benefit is that
 * a supplier added next month is covered without anyone remembering to wire it up.
 *
 * Marking a row as sent is deliberately an ATTEMPT, not a confirmed 2xx: deliverApiWebhook
 * already retries three times with backoff inside a single call, and a partner whose
 * endpoint is down for an hour must not hold the queue behind them.
 */
export const maxDuration = 60

// One run's budget. Each delivery can take up to ~25s against a dead endpoint, so the
// batch is small enough that a pathological partner cannot run the function out of time
// before it has written back what it did.
const BATCH = 25

interface Sweepable {
    table: 'orders' | 'afa_orders'
    columns: string
    build: (row: any) => WebhookPayload
}

const SOURCES: Sweepable[] = [
    {
        table: 'orders',
        columns: 'id, reference_code, status, network, size, phone_number, price, api_key_id',
        build: row => ({
            event:     `data.${row.status}`,
            reference: row.reference_code,
            order_id:  row.id,
            status:    row.status,
            network:   row.network,
            size:      row.size,
            recipient: row.phone_number,
            price:     Number(row.price ?? 0),
        }),
    },
    {
        table: 'afa_orders',
        columns: 'id, reference_code, status, full_name, phone_number, payment_amount, api_key_id',
        build: row => ({
            event:     `afa.${row.status}`,
            reference: row.reference_code,
            order_id:  row.id,
            status:    row.status,
            full_name: row.full_name,
            recipient: row.phone_number,
            price:     Number(row.payment_amount ?? 0),
        }),
    },
]

export async function GET(request: NextRequest) {
    if (!areCronJobsEnabled()) return cronDisabledResponse()

    const authHeader = request.headers.get('authorization')
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const supabase = createServerClient() as any
    const result: Record<string, number> = { processed: 0, errors: 0 }

    for (const source of SOURCES) {
        try {
            const { data: rows, error } = await supabase
                .from(source.table)
                .select(source.columns)
                .not('api_key_id', 'is', null)
                .is('api_webhook_sent_at', null)
                .in('status', ['completed', 'failed'])
                // Oldest first: a partner who was unreachable earlier is caught up in
                // order, rather than having the newest events delivered out of sequence.
                .order('updated_at', { ascending: true })
                .limit(BATCH)

            if (error) {
                console.error(`[ApiOrderWebhooks] ${source.table} query failed:`, error.message)
                result.errors++
                continue
            }

            for (const row of (rows as any[]) || []) {
                // Claimed BEFORE delivery, not after. A run that dies mid-flight would
                // otherwise leave the row unclaimed and resend on the next pass, and a
                // duplicate settlement is worse for a partner than a missed one they can
                // still read from GET /orders/{reference}.
                const { error: claimError } = await supabase
                    .from(source.table)
                    .update({ api_webhook_sent_at: new Date().toISOString() })
                    .eq('id', row.id)
                    .is('api_webhook_sent_at', null)

                if (claimError) {
                    console.error(`[ApiOrderWebhooks] claim failed for ${row.id}:`, claimError.message)
                    result.errors++
                    continue
                }

                // Awaited: the response must not return before delivery, or Vercel may
                // freeze the function mid-request — the same failure that was losing
                // api_logs rows.
                await deliverApiWebhook({
                    apiKeyId: row.api_key_id,
                    payload: source.build(row),
                    supabase,
                })
                result.processed++
            }
        } catch (e: any) {
            console.error(`[ApiOrderWebhooks] ${source.table} sweep failed:`, e?.message || e)
            result.errors++
        }
    }

    return NextResponse.json({ success: true, ...result })
}
