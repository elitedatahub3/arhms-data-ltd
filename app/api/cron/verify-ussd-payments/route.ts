/**
 * SUPERSEDED by /api/cron/verify-paystack-momo-payments, which absorbed both of the
 * sweeps below (Parts C1 and C2 there) so that one cron owns every call to
 * verifyTransaction rather than two that can drift apart.
 *
 * Unscheduled, not deleted: it is kept for one release as a rollback target. Do not
 * re-add it to vercel.json or to cron-job.org while the merged sweep is scheduled —
 * running both is harmless (every settle path is idempotent) but doubles the
 * Paystack verify calls and makes the two run logs impossible to read against each
 * other. Delete this file once the merged sweep has run clean.
 *
 * NOTE its activation query below filters provider='paystack'. The merged sweep
 * matches both 'paystack' and 'paystack_momo', which is the correct behaviour now
 * that /api/shop/ussd/activate stamps the new label.
 *
 * ---
 *
 * USSD (Paystack Mobile Money) reconciliation sweep.
 *
 * The safety net for a charge whose webhook never arrived. USSD needs this more
 * than any other flow: there is no browser to poll /api/payments/verify, and the
 * customer hung up the moment we released the session. If the webhook is lost,
 * nothing else in the system will ever notice — the money is in and the bundle
 * never went out.
 *
 * Unlike most crons here there is deliberately NO areCronJobsEnabled() guard, the
 * same stance as verify-hubtel-payments / verify-moolre-payments /
 * verify-payswitch-payments: a global cron kill switch must not be able to strand
 * a customer's money.
 *
 * Pending SALES are read from hubtel_payment_logs rather than wallet_payments,
 * because a USSD caller has no account and therefore no wallet_payments row (that
 * table needs user_id and wallet_id NOT NULL).
 *
 * Short-code ACTIVATIONS are the opposite case and are swept separately below: the
 * buyer is a signed-in shop owner, so the charge does have a wallet_payments row.
 * They landed here when activation moved from Hubtel to Paystack — the row's
 * provider changed to 'paystack', which put it outside verify-hubtel-payments, and
 * nothing else was watching. A shop can pay GHS 40 and never get a code if the
 * webhook is lost, so the net has to follow the money.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { verifyTransaction } from '@/lib/paystack-momo-service'
import { logStatusCheck } from '@/lib/hubtel-payment-log'
import { resolveByReference } from '@/lib/ussd-reference'

/** Give the webhook a head start before second-guessing it. */
const MIN_AGE_MS = 3 * 60 * 1000
/** Past this a charge is not coming good, and chasing it just reopens old rows. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000
/** Keeps one invocation inside the function time limit. */
const BATCH_LIMIT = 15

export async function GET(request: NextRequest) {
    const startTime = Date.now()

    const authHeader = request.headers.get('authorization')
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const supabase = createServerClient()
    const results = {
        checked: 0,
        fulfilled: 0,
        stillPending: 0,
        failed: 0,
        unresolvable: 0,
        activationsChecked: 0,
        activationsSettled: 0,
        errors: [] as string[],
        totalTimeMs: 0,
    }

    try {
        const { data: pending, error: fetchError } = await (supabase
            .from('hubtel_payment_logs') as any)
            .select('client_reference, amount, created_at')
            .eq('flow', 'ussd')
            .eq('status', 'pending')
            // The old Hubtel AddToCart path also wrote flow='ussd' rows, keyed by
            // Hubtel's OrderId. Those are not Paystack references and verifying them
            // would 404 forever, so match our prefix explicitly.
            .like('client_reference', 'USSD-%')
            .lt('created_at', new Date(Date.now() - MIN_AGE_MS).toISOString())
            .gt('created_at', new Date(Date.now() - MAX_AGE_MS).toISOString())
            .order('created_at', { ascending: true })
            .limit(BATCH_LIMIT)

        if (fetchError) {
            console.error('[CronUssd] hubtel_payment_logs query error:', fetchError)
            results.errors.push(`query: ${fetchError.message}`)
            results.totalTimeMs = Date.now() - startTime
            return NextResponse.json({ success: false, ...results })
        }

        for (const row of (pending || [])) {
            const reference = String(row.client_reference)
            results.checked++

            try {
                const verified = await verifyTransaction(reference)

                if (verified.outcome === 'pending') {
                    results.stillPending++
                    continue
                }

                if (verified.outcome === 'failed') {
                    results.failed++
                    await logStatusCheck({
                        clientReference: reference,
                        status: 'failed',
                        message: verified.message ?? `Paystack status: ${verified.rawStatus ?? 'failed'}`,
                        raw: verified.raw,
                    })
                    continue
                }

                // Paid. Paystack's figure is authoritative over anything we stored.
                const amountPaid = (verified.amountPesewas ?? 0) / 100
                // Only a reference here - no gateway metadata - so this goes
                // through the session payload, which the confirm step records.
                const resolved = await resolveByReference(supabase, reference)

                if (!resolved) {
                    results.unresolvable++
                    console.error('[CronUssd] Paid but unresolvable, needs a human:', reference)
                    await logStatusCheck({
                        clientReference: reference,
                        status: 'failed',
                        amount: amountPaid,
                        message: 'Paid but the USSD session could not be found.',
                        raw: verified.raw,
                    })
                    continue
                }

                const deferredWork: Array<() => Promise<void>> = []
                // Both fulfillers are idempotent on referenceCode, so racing the
                // webhook here is safe — whichever arrives second is a no-op.
                const result = resolved.orderType === 'data'
                    ? await (await import('@/lib/ussd-data-fulfillment')).fulfillUSSDDataBySession({
                        sessionId: resolved.sessionId,
                        referenceCode: reference,
                        amountPaid,
                        deferredWork,
                    })
                    : await (await import('@/lib/ussd-rc-fulfillment')).fulfillUSSDRCBySession({
                        sessionId: resolved.sessionId,
                        referenceCode: reference,
                        amountPaid,
                        deferredWork,
                    })

                await logStatusCheck({
                    clientReference: reference,
                    status: result.success ? 'success' : 'failed',
                    amount: amountPaid,
                    message: result.success
                        ? 'Recovered by reconciliation sweep.'
                        : `Paid but fulfilment failed: ${result.error ?? 'unknown error'}`,
                    raw: verified.raw,
                })

                if (result.success) {
                    results.fulfilled++
                } else {
                    results.failed++
                    console.error('[CronUssd] Fulfilment failed:', reference, result.error)
                }

                for (const task of deferredWork) {
                    await task().catch(() => {})
                }
            } catch (err: any) {
                console.error('[CronUssd] Error on', reference, err?.message)
                results.errors.push(`${reference}: ${err?.message ?? 'unknown'}`)
            }
        }
    } catch (err: any) {
        console.error('[CronUssd] Sweep failed:', err)
        results.errors.push(`sweep: ${err?.message ?? 'unknown'}`)
    }

    // ── SHORT-CODE ACTIVATIONS ───────────────────────────────────────────────────
    // Its own try block: a failure sweeping activations must not discard the sales
    // results already collected above.
    try {
        const { data: pendingActivations, error: activationError } = await (supabase
            .from('wallet_payments') as any)
            .select('reference, total_amount')
            .eq('status', 'pending')
            .eq('provider', 'paystack')
            .like('reference', 'ussd_activation_%')
            .lt('created_at', new Date(Date.now() - MIN_AGE_MS).toISOString())
            .gt('created_at', new Date(Date.now() - MAX_AGE_MS).toISOString())
            .order('created_at', { ascending: true })
            .limit(BATCH_LIMIT)

        if (activationError) {
            console.error('[CronUssd] wallet_payments query error:', activationError)
            results.errors.push(`activations query: ${activationError.message}`)
        }

        for (const row of (pendingActivations || [])) {
            const reference = String(row.reference)
            results.activationsChecked++

            try {
                const verified = await verifyTransaction(reference)

                // Only 'paid' acts. A 'failed' row is deliberately left pending rather
                // than marked failed: unlike the sales sweep there is nothing to
                // release, and an abandoned prompt the buyer approves late should
                // still mint the code it paid for.
                if (verified.outcome !== 'paid') continue

                const { processCompletedUssdActivation } = await import('@/lib/payments')
                const settled = await processCompletedUssdActivation(reference, {
                    reference,
                    // Paystack's figure is authoritative over anything we stored.
                    amount: verified.amountPesewas ?? Math.round(Number(row.total_amount) * 100),
                    metadata: { recovered_by: 'verify-ussd-payments' },
                })

                if (settled?.success) {
                    results.activationsSettled++
                    console.log('[CronUssd] Activation recovered:', reference)
                } else {
                    results.errors.push(`${reference}: ${settled?.error ?? 'activation settle failed'}`)
                    console.error('[CronUssd] Paid activation would not settle:', reference, settled?.error)
                }
            } catch (err: any) {
                console.error('[CronUssd] Activation error on', reference, err?.message)
                results.errors.push(`${reference}: ${err?.message ?? 'unknown'}`)
            }
        }
    } catch (err: any) {
        console.error('[CronUssd] Activation sweep failed:', err)
        results.errors.push(`activation sweep: ${err?.message ?? 'unknown'}`)
    }

    results.totalTimeMs = Date.now() - startTime
    console.log('[CronUssd] Sweep complete:', JSON.stringify(results))
    return NextResponse.json({ success: true, ...results })
}
