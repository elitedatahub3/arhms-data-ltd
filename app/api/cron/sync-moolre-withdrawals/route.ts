import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { checkTransferStatus } from '@/lib/moolre-transfer-service'
import { sendShopWithdrawalProcessedSMS } from '@/lib/sms-service'
import { sendShopWithdrawalProcessedEmail } from '@/lib/email-service'
import { areCronJobsEnabled, cronDisabledResponse, validateCronSecret } from '@/lib/cron-control'

export async function GET(req: NextRequest) {
    validateCronSecret() // Throws if CRON_SECRET is missing or shorter than 32 chars
    if (!areCronJobsEnabled()) return cronDisabledResponse()

    // 1. Secure with CRON_SECRET
    const authHeader = req.headers.get('authorization')
    const cronSecret = process.env.CRON_SECRET

    if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const db = createServerClient() as any
    const results = {
        processed: 0,
        completed: 0,
        stillPending: 0,
        errors: 0,
    }

    try {
        // 2. Fetch all moolre_pending transactions
        const { data: pendingTxns, error: fetchError } = await db
            .from('shop_wallet_transactions')
            .select(`
                id,
                moolre_external_ref,
                net_amount,
                momo_number,
                network,
                wallet:shop_wallets!inner(
                    owner_id
                )
            `)
            .eq('status', 'moolre_pending')

        if (fetchError) {
            console.error('[sync-moolre] Failed to fetch pending transactions:', fetchError)
            return NextResponse.json({ error: 'Database error', details: fetchError.message }, { status: 500 })
        }

        console.log(`[sync-moolre] Checking ${pendingTxns?.length ?? 0} moolre_pending shop transactions...`)

        // 3. Check each pending transaction in series to avoid overwhelming Moolre API
        for (const tx of pendingTxns || []) {
            results.processed++

            const externalref = tx.moolre_external_ref || tx.id

            try {
                const status = await checkTransferStatus(externalref)

                if (status.txstatus === null) {
                    // Could not get a response — skip, leave as moolre_pending, try next run
                    console.warn(`[sync-moolre] Could not get status for tx ${tx.id}:`, status.error)
                    results.errors++
                    continue
                }

                if (status.txstatus === 1) {
                    // ✅ Completed — update DB and send SMS
                    const { error: updateError } = await db
                        .from('shop_wallet_transactions')
                        .update({
                            status: 'completed',
                            moolre_status: 1,
                            moolre_transaction_id: status.transactionid,
                            processed_at: new Date().toISOString(),
                            updated_at: new Date().toISOString(),
                        })
                        .eq('id', tx.id)

                    if (updateError) {
                        console.error(`[sync-moolre] Failed to update tx ${tx.id} to completed:`, updateError)
                        results.errors++
                        continue
                    }

                    results.completed++
                    console.log(`[sync-moolre] ✅ tx ${tx.id} completed. Moolre ID: ${status.transactionid}`)

                    // Fetch owner details for SMS
                    try {
                        const { data: shopProfile } = await db
                            .from('shop_profiles')
                            .select('shop_name, owner_phone')
                            .eq('owner_id', tx.wallet.owner_id)
                            .single()

                        const { data: ownerUser } = await db
                            .from('users')
                            .select('first_name, email')
                            .eq('id', tx.wallet.owner_id)
                            .single()

                        if (shopProfile && ownerUser) {
                            try {
                                await Promise.allSettled([
                                    sendShopWithdrawalProcessedSMS(
                                        shopProfile.owner_phone,
                                        ownerUser.first_name,
                                        tx.net_amount,
                                        tx.network || 'MoMo',
                                        tx.momo_number
                                    ),
                                    sendShopWithdrawalProcessedEmail(
                                        ownerUser.email,
                                        ownerUser.first_name,
                                        shopProfile.shop_name,
                                        tx.net_amount,
                                        tx.momo_number,
                                        tx.network || 'MoMo'
                                    )
                                ])
                            } catch (notifyErr) {
                                console.warn(`[sync-moolre] SMS error for tx ${tx.id}:`, notifyErr)
                            }
                        }
                    } catch (smsErr) {
                        // Non-fatal — transaction is already marked completed
                        console.warn(`[sync-moolre] Could not send SMS for tx ${tx.id}:`, smsErr)
                    }

                } else if (status.txstatus === 2) {
                    // ❌ Moolre explicitly failed — leave as moolre_pending, log only
                    // Admin will see the transaction still pending and can use "Pay Manually"
                    console.error(
                        `[sync-moolre] ❌ Moolre returned txstatus=2 (explicit failure) for tx ${tx.id}. ` +
                        `Leaving as moolre_pending. Admin must use "Pay Manually".`
                    )
                    results.errors++

                } else {
                    // txstatus=0 or txstatus=3 — still pending, check again next run
                    console.log(`[sync-moolre] ⏳ tx ${tx.id} still pending (txstatus=${status.txstatus})`)
                    results.stillPending++
                }

            } catch (txErr: any) {
                console.error(`[sync-moolre] Unexpected error processing tx ${tx.id}:`, txErr.message)
                results.errors++
            }
        }

        // ── Commission Wallet payouts ────────────────────────────────────────────
        // Same Moolre lifecycle, a different table. Kept in this cron rather than a new
        // one because it is the same question asked of the same API: "did this transfer
        // land?" — and a second schedule is another thing to register and forget.
        try {
            const { data: commissionPending } = await db
                .from('commission_withdrawals')
                .select('id, moolre_external_ref, net_amount, momo_number, account_number, network, user_id')
                .eq('status', 'moolre_pending')

            for (const w of (commissionPending as any[]) || []) {
                results.processed++
                try {
                    const status = await checkTransferStatus(w.moolre_external_ref || w.id)

                    if (status.txstatus === null) {
                        console.warn(`[sync-moolre] commission ${w.id}: no status —`, status.error)
                        results.errors++
                        continue
                    }

                    if (status.txstatus === 1) {
                        const { error: updateError } = await db
                            .from('commission_withdrawals')
                            .update({
                                status: 'completed',
                                moolre_status: 1,
                                moolre_transaction_id: status.transactionid,
                                processed_at: new Date().toISOString(),
                                updated_at: new Date().toISOString(),
                            })
                            .eq('id', w.id)
                            .eq('status', 'moolre_pending')

                        if (updateError) {
                            console.error(`[sync-moolre] commission ${w.id} update failed:`, updateError.message)
                            results.errors++
                            continue
                        }

                        results.completed++

                        try {
                            const { data: partner } = await db
                                .from('users').select('first_name, phone_number').eq('id', w.user_id).maybeSingle()
                            if (partner?.phone_number) {
                                await sendShopWithdrawalProcessedSMS(
                                    partner.phone_number,
                                    partner.first_name || 'Partner',
                                    w.net_amount,
                                    w.network || 'MoMo',
                                    w.momo_number || w.account_number || ''
                                )
                            }
                        } catch (notifyErr) {
                            // Non-fatal: the payout is already recorded as completed.
                            console.warn(`[sync-moolre] commission ${w.id} SMS failed:`, notifyErr)
                        }
                    } else if (status.txstatus === 2) {
                        // Left in moolre_pending on purpose, exactly as the shop sweep does:
                        // the admin can still settle it with "Pay Manually".
                        console.error(`[sync-moolre] commission ${w.id}: Moolre reported failure (txstatus=2).`)
                        results.errors++
                    } else {
                        results.stillPending++
                    }
                } catch (e: any) {
                    console.error(`[sync-moolre] commission ${w.id} error:`, e?.message || e)
                    results.errors++
                }
            }
        } catch (e: any) {
            console.error('[sync-moolre] commission sweep failed:', e?.message || e)
            results.errors++
        }

        console.log('[sync-moolre] Run complete:', results)
        return NextResponse.json({ success: true, results })

    } catch (error: any) {
        console.error('[sync-moolre] Fatal cron error:', error)
        return NextResponse.json({ error: error.message || 'Internal error' }, { status: 500 })
    }
}
