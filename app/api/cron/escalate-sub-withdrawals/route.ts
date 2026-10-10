import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { isCronAuthorized, cronUnauthorizedResponse } from '@/lib/cron-control'

/**
 * Escalation Cron: Sweep sub withdrawals stuck in shop_owner_pending
 *
 * Runs hourly (can be registered in cron-job.org with Bearer or ?secret=).
 *
 * A withdrawal escalates when its 48h window has lapsed:
 *   status: 'shop_owner_pending' → 'pending' (enters admin queue)
 *   auto_escalated: true (flags for admin extra verification)
 *
 * It deliberately does NOT escalate on "the Lead is ineligible". That rule
 * (lifetime agent OR unexpired dealer) is one almost no live Lead satisfies —
 * they are role 'customer' and selling every day — so applying it here would
 * forward practically every request straight past the Lead and make their
 * approval meaningless. The 48h timer already stops a Lead sitting on a
 * request, which is the abuse the escalation exists to prevent.
 *
 * Security: Uses service_role client (bypasses RLS), validates time conditions.
 */

export async function GET(request: NextRequest) {
  // === Auth: Require valid cron secret ===
  if (!isCronAuthorized(request)) {
    console.warn('[Escalate Cron] Unauthorized cron call')
    return cronUnauthorizedResponse()
  }

  const supabase: any = createServerClient()
  const now = new Date()

  try {
    console.log(`[Escalate Cron] Starting escalation sweep at ${now.toISOString()}`)

    // 1. Find all shop_owner_pending withdrawals eligible for escalation
    // Only the timer decides, so this needs nothing beyond the row itself —
    // the previous nested embed pulled the whole upline chain for a check that
    // no longer runs, and had two aliases resolving to the same relationship.
    const { data: pendingWithdrawals, error: fetchError } = await supabase
      .from('shop_wallet_transactions')
      .select('id, shop_wallet_id, amount, status, escalate_after')
      .eq('status', 'shop_owner_pending')
      .not('escalate_after', 'is', null)
      .lt('escalate_after', now.toISOString())

    if (fetchError) {
      console.error('[Escalate Cron] Fetch error:', fetchError)
      return NextResponse.json(
        { error: 'Failed to fetch withdrawals', details: fetchError.message },
        { status: 500 }
      )
    }

    if (!pendingWithdrawals || pendingWithdrawals.length === 0) {
      console.log('[Escalate Cron] No pending withdrawals found')
      return NextResponse.json({
        success: true,
        escalatedCount: 0,
        message: 'No withdrawals to escalate',
      })
    }

    // 2. Process each withdrawal
    let escalatedCount = 0
    let errors: Array<{ withdrawalId: string; error: string }> = []

    for (const withdrawal of pendingWithdrawals) {
      try {
        // The query already selected only rows whose 48h window has lapsed.
        // Re-assert the status in the UPDATE so a Lead who approves in the same
        // instant wins the race instead of both writes landing.
        const { data: escalated, error: updateError } = await supabase
          .from('shop_wallet_transactions')
          .update({
            status: 'pending',
            auto_escalated: true,
            updated_at: new Date().toISOString(),
          })
          .eq('id', withdrawal.id)
          .eq('status', 'shop_owner_pending')
          .select('id')

        if (updateError) {
          console.error(
            `[Escalate Cron] Failed to escalate withdrawal ${withdrawal.id}:`,
            updateError
          )
          errors.push({
            withdrawalId: withdrawal.id,
            error: updateError.message,
          })
        } else if (escalated?.length) {
          escalatedCount++
          console.log(
            `[Escalate Cron] Escalated withdrawal ${withdrawal.id} (48h window passed)`
          )
        }
      } catch (err: any) {
        console.error(`[Escalate Cron] Unexpected error for withdrawal:`, err)
        errors.push({
          withdrawalId: withdrawal.id,
          error: err?.message || 'Unknown error',
        })
      }
    }

    console.log(
      `[Escalate Cron] Completed: escalated ${escalatedCount}/${pendingWithdrawals.length}, errors: ${errors.length}`
    )

    return NextResponse.json({
      success: true,
      escalatedCount,
      totalProcessed: pendingWithdrawals.length,
      errors: errors.length > 0 ? errors : undefined,
      message: `Escalated ${escalatedCount} withdrawals`,
    })
  } catch (err: any) {
    console.error('[Escalate Cron] Critical error:', err)
    return NextResponse.json(
      { error: 'Cron execution failed', details: err?.message },
      { status: 500 }
    )
  }
}

// Accept any method (cron-job.org's sent method doesn't always match its UI); auth-gated.
export const POST = GET
export const PUT = GET
export const PATCH = GET
export const DELETE = GET

