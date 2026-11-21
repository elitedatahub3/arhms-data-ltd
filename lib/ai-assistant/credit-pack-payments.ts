/**
 * Server entry for settling a Direct Pay shop credit pack (reference AICPAY-...).
 * Called by every collection webhook, /api/payments/verify and the reconciliation
 * crons. The logic lives in settleCreditPackPayment (lib/ai-assistant/shop-credits.ts,
 * unit-tested); this adds the service-role client and the admin alert.
 * Idempotent: safe to call many times for the same reference.
 */
import { createServerClient } from '@/lib/supabase'
import { sendPushToAdmins } from '@/lib/web-push'
import { settleCreditPackPayment, type CreditSettleResult } from './shop-credits'

export async function processCreditPackPayment(reference: string, expectedUserId?: string): Promise<CreditSettleResult> {
    const result = await settleCreditPackPayment(createServerClient() as any, reference, expectedUserId)
    if (result.refunded !== undefined) {
        await sendPushToAdmins({
            title: '⚠️ Shop AI credits not added',
            body: `${reference}: paid but credits failed. ${result.refunded ? 'Owner refunded to wallet.' : 'REFUND ALSO FAILED: fix by hand.'}`,
            url: '/admin/ai-assistant',
        }).catch(() => {})
    }
    return result
}
