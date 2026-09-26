import { createServerClient } from './supabase'
import { sendWalletTopupSuccessEmail, sendPermanentAgentUpgradeSuccessEmail } from './email-service'
import { sendWalletTopupSuccessSMS, sendAgentUpgradeSuccessSMS, sendAgentExtensionSuccessSMS, sendPermanentAgentUpgradeSuccessSMS, sendDealerUpgradeSuccessSMS, sendUssdActivationSMS } from './sms-service'
import { sendPushToUser, sendPushToAdmins } from './web-push'

/**
 * Processes a completed payment by updating the status, 
 * crediting the wallet, logging the transaction, and notifying the user.
 * This is designed to be idempotent.
 */
export async function processCompletedWalletPayment(reference: string, providerMetadata?: any, expectedUserId?: string) {
    const supabase = createServerClient()

    // 1. Get payment record
    const { data: paymentData, error: paymentError } = await supabase
        .from('wallet_payments')
        .select('*')
        .eq('reference', reference)
        .single()

    const payment = paymentData as any

    if (paymentError || !payment) {
        console.error('[PaymentProcess] Payment not found:', reference)
        return { success: false, error: 'Payment not found' }
    }

    if (expectedUserId && payment.user_id !== expectedUserId) {
        console.error('[PaymentProcess] Payment ownership mismatch')
        return { success: false, error: 'Forbidden' }
    }

    // 2. Atomic Update (Idempotency Check)
    // We attempt to update the status to 'completed' ONLY if it is currently 'pending'.
    // If the record exists but status is not 'pending', this will return 0 rows
    // (or empty data), meaning it was already processed.
    const { data: updatedPayment, error: updatePaymentError } = await (supabase
        .from('wallet_payments') as any)
        .update({
            status: 'completed',
            metadata: providerMetadata || payment.metadata,
            updated_at: new Date().toISOString(),
        })
        .eq('id', payment.id)
        .eq('status', 'pending')
        .select()
        .single()

    if (updatePaymentError) {
        // If error is just "no rows returned", it means condition failed (already completed)
        // But .single() might throw if 0 rows. Use MaybeSingle if available or handle error code.
        // Actually, Supabase .single() returns error code PGRST116 for no rows.
        if (updatePaymentError.code === 'PGRST116') {
            return { success: true, alreadyProcessed: true }
        }
        console.error('[PaymentProcess] Update payment error:', updatePaymentError)
        return { success: false, error: 'Failed to update payment status' }
    }

    if (!updatedPayment) {
        // Fallback if no error was thrown but no data returned (dependent on client version)
        return { success: true, alreadyProcessed: true }
    }

    // 4. Credit wallet atomically
    const { data: newBalance, error: walletError } = await (supabase as any).rpc('topup_wallet_balance', {
        p_user_id: payment.user_id,
        p_amount: payment.amount
    })

    if (walletError || newBalance === null) {
        console.error('[PaymentProcess] Failed to credit wallet atomically:', walletError)
        return { success: false, error: 'Failed to credit wallet' }
    }

    // 5. Create transaction record
    const { error: txnError } = await (supabase.from('wallet_transactions') as any).insert({
        wallet_id: payment.wallet_id,
        user_id: payment.user_id,
        type: 'credit',
        amount: payment.amount,
        description: 'Wallet top-up via Paystack',
        reference: reference,
        source: 'payment',
        status: 'completed',
    })

    if (txnError) {
        console.error('[PaymentProcess] Transaction log error:', txnError)
    }

    // 6. Create notification
    const { error: notifyError } = await (supabase.from('notifications') as any).insert({
        user_id: payment.user_id,
        title: 'Wallet Topped Up',
        message: `Your wallet has been credited with GHS ${payment.amount.toFixed(2)}`,
        type: 'payment_success',
        action_url: '/dashboard/wallet',
    })

    if (notifyError) {
        console.error('[PaymentProcess] Notification error:', notifyError)
    }

    // Await web push for payment confirmation so Vercel doesn't kill it
    await sendPushToUser(payment.user_id, {
        title: 'Wallet Topped Up',
        body: `GHS ${payment.amount.toFixed(2)} added to your wallet.`,
        url: '/dashboard/wallet',
    }).catch((e: any) => console.error('[PaymentProcess] Push error:', e))

    // 7. Send email notification
    try {
        // Get user details for email
        const { data: userData } = await supabase
            .from('users')
            .select('email, first_name, phone_number')
            .eq('id', payment.user_id)
            .single()

        if (userData) {
            // Notify admin of top-up
            await sendPushToAdmins({
                title: 'Wallet Top-Up',
                body: `${(userData as any).first_name || 'User'} topped up GHS ${payment.amount.toFixed(2)}`,
                url: '/admin/finance',
            }).catch(() => {})

            await sendWalletTopupSuccessEmail(
                (userData as any).email,
                (userData as any).first_name || 'Customer',
                payment.amount,
                reference,
                newBalance as number
            )

            // Send SMS notification
            if ((userData as any).phone_number) {
                await sendWalletTopupSuccessSMS(
                    (userData as any).phone_number,
                    {
                        amount: payment.amount,
                        newBalance
                    }
                ).catch(err => console.error('[PaymentProcess] SMS error:', err))
            } else {
                console.warn('[PaymentProcess] No phone number found for payment user')
            }

        }
    } catch (emailError) {
        // Don't fail the payment process if email fails
        console.error('[PaymentProcess] Email notification error:', emailError)
    }

    return { success: true }
}

/**
 * Processes a completed upgrade payment by updating the user's role 
 * and extending their agent membership duration.
 */
export async function processCompletedUpgradePayment(reference: string, providerMetadata: any) {
    const supabase = createServerClient()

    // 1. Get payment record
    const { data: paymentData, error: paymentError } = await supabase
        .from('wallet_payments')
        .select('*')
        .eq('reference', reference)
        .single()

    const payment = paymentData as any

    if (paymentError || !payment) {
        console.error('[UpgradeProcess] Payment not found:', reference)
        return { success: false, error: 'Payment not found' }
    }

    // Safely parse original metadata
    const originalMetadata = typeof payment.metadata === 'string' 
        ? JSON.parse(payment.metadata) 
        : (payment.metadata || {});

    // 2. Atomic Update (Idempotency Check)
    const { data: updatedPayment, error: updatePaymentError } = await (supabase
        .from('wallet_payments') as any)
        .update({
            status: 'completed',
            metadata: { ...originalMetadata, provider_data: providerMetadata },
            updated_at: new Date().toISOString(),
        })
        .eq('id', payment.id)
        .eq('status', 'pending')
        .select()
        .single()

    if (updatePaymentError) {
        if (updatePaymentError.code === 'PGRST116') {
            return { success: true, alreadyProcessed: true }
        }
        console.error('[UpgradeProcess] Update payment error:', updatePaymentError)
        return { success: false, error: 'Failed to update payment status' }
    }

    if (!updatedPayment) return { success: true, alreadyProcessed: true }

    // 3. Get User and current expiry
    const { data: userData, error: userError } = await supabase
        .from('users')
        .select('role, agent_expires_at, email, first_name, phone_number')
        .eq('id', payment.user_id)
        .single()

    const user = userData as any

    if (userError || !user) {
        console.error('[UpgradeProcess] User not found:', payment.user_id)
        return { success: false, error: 'User not found' }
    }

    // 4. Calculate new expiry
    const isPermanent = originalMetadata?.plan_type === 'permanent';
    const planDays = originalMetadata?.plan_days || 30
    const now = new Date()
    let currentExpiry = user.agent_expires_at ? new Date(user.agent_expires_at) : null
    let newExpiry: Date | null = null;

    if (!isPermanent) {
        if (currentExpiry && currentExpiry > now) {
            // Extend existing
            newExpiry = new Date(currentExpiry.getTime() + (planDays * 24 * 60 * 60 * 1000))
        } else {
            // Start fresh
            newExpiry = new Date(now.getTime() + (planDays * 24 * 60 * 60 * 1000))
        }
    }

    // 5. Update user role and expiry
    const { error: updateUserError } = await (supabase
        .from('users') as any)
        .update({
            role: 'agent',
            agent_expires_at: isPermanent ? null : newExpiry?.toISOString(),
            updated_at: new Date().toISOString(),
        })
        .eq('id', payment.user_id)

    if (updateUserError) {
        console.error('[UpgradeProcess] Update user error:', updateUserError)
        return { success: false, error: 'Failed to update user role' }
    }

    // 6. Create notification
    await (supabase.from('notifications') as any).insert({
        user_id: payment.user_id,
        title: isPermanent ? 'Permanent Agent Unlocked! 💎' : 'Upgrade Successful',
        message: isPermanent 
            ? 'Congratulations! You now have lifetime access to premium agent benefits.' 
            : `Congratulations! Your Agent membership has been ${currentExpiry && currentExpiry > now ? 'extended' : 'activated'} until ${newExpiry?.toLocaleDateString()}.`,
        type: 'system',
        action_url: '/dashboard',
    })

    // 7. Send SMS notification
    try {
        if (user.phone_number) {
            if (isPermanent) {
                // Send Permanent/Lifetime notification (static import at top-level)
                await sendPermanentAgentUpgradeSuccessSMS(user.phone_number)
            } else if (newExpiry) {
                const planLabelText = originalMetadata?.plan_label ||
                    (planDays === 3 ? '3 Days' : planDays === 14 ? '14 Days' : '30 Days')

                // Calculate remaining days from now
                const diffMs = newExpiry.getTime() - now.getTime()
                const remainingDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24))

                // Check if it was an extension (user was already agent and didn't expire)
                if (currentExpiry && currentExpiry > now) {
                    // Extension
                    await sendAgentExtensionSuccessSMS(
                        user.phone_number,
                        newExpiry
                    )
                } else {
                    // New Upgrade
                    await sendAgentUpgradeSuccessSMS(
                        user.phone_number,
                        user.first_name || 'Agent',
                        planLabelText,
                        remainingDays,
                        newExpiry.toISOString() // Pass the expiry date
                    )
                }
            }
        }
    } catch (smsError) {
        console.error('[UpgradeProcess] SMS error:', smsError)
        // Don't fail the transaction if SMS fails
    }

    // 8. Send permanent agent upgrade email notification
    // Migrated from /api/payments/webhook (old route) — lines 140-147
    if (isPermanent && user.email) {
        try {
            await sendPermanentAgentUpgradeSuccessEmail(
                user.email,
                user.first_name || 'User'
            )
        } catch (emailError) {
            console.error('[UpgradeProcess] Permanent upgrade email error:', emailError)
            // Don't fail the transaction if email fails
        }
    }

    return { success: true }
}

/**
 * Settles a USSD short-code activation: marks the payment completed, mints the
 * shop's 4-character short code, and flips the shop to `active`.
 *
 * Idempotent on two levels — the conditional wallet_payments update below, and
 * assign_shop_ussd_code() itself, which returns the existing code rather than
 * minting a second one. A replayed webhook is therefore a no-op.
 */
export async function processCompletedUssdActivation(reference: string, providerMetadata?: any) {
    const supabase = createServerClient()

    const { data: paymentData, error: paymentError } = await supabase
        .from('wallet_payments')
        .select('*')
        .eq('reference', reference)
        .single()

    const payment = paymentData as any

    if (paymentError || !payment) {
        console.error('[UssdActivation] Payment not found:', reference)
        return { success: false, error: 'Payment not found' }
    }

    const originalMetadata = typeof payment.metadata === 'string'
        ? JSON.parse(payment.metadata)
        : (payment.metadata || {})

    const shopId = originalMetadata?.shop_id
    if (!shopId) {
        console.error('[UssdActivation] Payment has no shop_id in metadata:', reference)
        return { success: false, error: 'Activation is missing its shop reference' }
    }

    // Atomic idempotency check: only the transition out of `pending` wins.
    const { data: updatedPayment, error: updatePaymentError } = await (supabase
        .from('wallet_payments') as any)
        .update({
            status: 'completed',
            metadata: { ...originalMetadata, provider_data: providerMetadata },
            updated_at: new Date().toISOString(),
        })
        .eq('id', payment.id)
        .eq('status', 'pending')
        .select()
        .single()

    if (updatePaymentError) {
        if (updatePaymentError.code === 'PGRST116') {
            return { success: true, alreadyProcessed: true }
        }
        console.error('[UssdActivation] Update payment error:', updatePaymentError)
        return { success: false, error: 'Failed to update payment status' }
    }

    if (!updatedPayment) return { success: true, alreadyProcessed: true }

    const { data: shortCode, error: codeError } = await (supabase as any)
        .rpc('assign_shop_ussd_code', { p_shop_id: shopId })

    if (codeError || !shortCode) {
        console.error('[UssdActivation] Code assignment failed for shop', shopId, codeError)
        // Put the payment back so a retry (or the caller's refund path) can act on it.
        await (supabase.from('wallet_payments') as any)
            .update({ status: 'pending' })
            .eq('id', payment.id)
        return { success: false, error: 'Could not assign a short code' }
    }

    const { error: shopUpdateError } = await (supabase.from('shop_profiles') as any)
        .update({
            ussd_status: 'active',
            ussd_activated_at: new Date().toISOString(),
            ussd_activation_reference: reference,
            ussd_activation_amount: payment.total_amount,
            updated_at: new Date().toISOString(),
        })
        .eq('id', shopId)

    if (shopUpdateError) {
        console.error('[UssdActivation] Shop update error:', shopUpdateError)
        return { success: false, error: 'Failed to activate the short code' }
    }

    const { data: settingRow } = await supabase
        .from('admin_settings')
        .select('value')
        .eq('key', 'ussd_dial_code')
        .maybeSingle()
    const dialCode = (settingRow as any)?.value || ''

    // Sub-agents live in the de-branded portal — sending them to /dashboard/shop
    // would drop them into the platform-branded dashboard they never use.
    const { data: subRow } = await supabase
        .from('sub_agents')
        .select('id')
        .eq('user_id', payment.user_id)
        .maybeSingle()

    await (supabase.from('notifications') as any).insert({
        user_id: payment.user_id,
        title: 'USSD Short Code Active 📱',
        message: `Your short code is ${shortCode}. Customers can dial ${dialCode} and enter ${shortCode} to buy from your shop without internet.`,
        type: 'system',
        action_url: subRow ? '/dashboard/sub/ussd' : '/dashboard/shop',
    })

    try {
        const { data: userData } = await supabase
            .from('users')
            .select('phone_number')
            .eq('id', payment.user_id)
            .single()
        const phone = (userData as any)?.phone_number
        if (phone) await sendUssdActivationSMS(phone, shortCode, dialCode)
    } catch (smsError) {
        console.error('[UssdActivation] SMS error:', smsError)
    }

    await sendPushToAdmins({
        title: 'USSD Short Code Activated',
        body: `${originalMetadata.shop_name || 'A shop'} activated short code ${shortCode}.`,
        url: '/admin/shops',
    }).catch(() => {})

    return { success: true, shortCode }
}

/**
 * Customer SMS reference prefixes.
 *
 * Both purchases route through wallet_payments like every other one-time fee, so
 * they need an arm in each webhook and reconciliation sweep. There are nine such
 * dispatch sites; giving them one predicate and one entry point keeps a new SMS
 * purchase type from having to be added to all nine again.
 */
export const SMS_UNLOCK_PREFIX = 'sms_unlock_'
export const SMS_CREDITS_PREFIX = 'sms_credits_'

export function isSmsPaymentReference(reference: string, metadata?: any): boolean {
    const ref = reference || ''
    const type = metadata?.upgrade_type
    return ref.startsWith(SMS_UNLOCK_PREFIX)
        || ref.startsWith(SMS_CREDITS_PREFIX)
        || type === 'sms_unlock'
        || type === 'sms_credits'
}

/**
 * Routes a settled Customer SMS payment to the handler that owns it.
 *
 * The prefix decides, with the metadata as a fallback for the same reason the
 * other flows check both: a gateway that echoes the reference back mangled still
 * carries the metadata we sent it.
 */
export async function processCompletedSmsPayment(
    reference: string,
    providerMetadata?: any,
    metadata?: any
) {
    const isUnlock = reference.startsWith(SMS_UNLOCK_PREFIX) || metadata?.upgrade_type === 'sms_unlock'
    return isUnlock
        ? processCompletedSmsUnlock(reference, providerMetadata)
        : processCompletedSmsCreditPurchase(reference, providerMetadata)
}

/**
 * Settles the one-time Customer SMS unlock: marks the payment completed and
 * flips the caller's SMS account from `locked` to `active`.
 *
 * Idempotent on the same conditional wallet_payments update the USSD handler
 * uses — webhook, verify-cron and the client poll can all reach this.
 */
export async function processCompletedSmsUnlock(reference: string, providerMetadata?: any) {
    const supabase = createServerClient()

    const { data: paymentData, error: paymentError } = await supabase
        .from('wallet_payments')
        .select('*')
        .eq('reference', reference)
        .single()

    const payment = paymentData as any

    if (paymentError || !payment) {
        console.error('[SmsUnlock] Payment not found:', reference)
        return { success: false, error: 'Payment not found' }
    }

    const originalMetadata = typeof payment.metadata === 'string'
        ? JSON.parse(payment.metadata)
        : (payment.metadata || {})

    const accountId = originalMetadata?.sms_account_id
    if (!accountId) {
        console.error('[SmsUnlock] Payment has no sms_account_id in metadata:', reference)
        return { success: false, error: 'Unlock is missing its SMS account reference' }
    }

    // Atomic idempotency check: only the transition out of `pending` wins.
    const { data: updatedPayment, error: updatePaymentError } = await (supabase
        .from('wallet_payments') as any)
        .update({
            status: 'completed',
            metadata: { ...originalMetadata, provider_data: providerMetadata },
            updated_at: new Date().toISOString(),
        })
        .eq('id', payment.id)
        .eq('status', 'pending')
        .select()
        .single()

    if (updatePaymentError) {
        if (updatePaymentError.code === 'PGRST116') {
            return { success: true, alreadyProcessed: true }
        }
        console.error('[SmsUnlock] Update payment error:', updatePaymentError)
        return { success: false, error: 'Failed to update payment status' }
    }

    if (!updatedPayment) return { success: true, alreadyProcessed: true }

    // Only a locked account is unlocked here: a suspended one stays suspended,
    // so paying again can never wash away a suspension.
    const { error: accountError } = await (supabase.from('sms_accounts') as any)
        .update({
            status: 'active',
            unlocked_at: new Date().toISOString(),
            unlock_reference: reference,
            unlock_amount: payment.total_amount,
            updated_at: new Date().toISOString(),
        })
        .eq('id', accountId)
        .eq('status', 'locked')

    if (accountError) {
        console.error('[SmsUnlock] Account update error:', accountError)
        // Put the payment back so a retry can finish it.
        await (supabase.from('wallet_payments') as any)
            .update({ status: 'pending' })
            .eq('id', payment.id)
        return { success: false, error: 'Could not unlock Customer SMS' }
    }

    const { data: subRow } = await supabase
        .from('sub_agents')
        .select('id')
        .eq('user_id', payment.user_id)
        .maybeSingle()

    await (supabase.from('notifications') as any).insert({
        user_id: payment.user_id,
        title: 'Customer SMS Unlocked 💬',
        message: 'You can now request your sender ID, buy SMS credits and message your customers.',
        type: 'system',
        action_url: subRow ? '/dashboard/sub/sms' : '/dashboard/shop/sms',
    })

    return { success: true }
}

/**
 * Settles an SMS credit bundle purchase: marks the payment completed and adds
 * the bought credits to the account balance.
 *
 * The credit_sms_credits RPC is NOT itself idempotent — it adds every time it is
 * called — so the guard is the conditional update on sms_credit_purchases below.
 * Only the caller that moves the purchase out of `pending` goes on to credit.
 */
export async function processCompletedSmsCreditPurchase(reference: string, providerMetadata?: any) {
    const supabase = createServerClient()

    const { data: paymentData, error: paymentError } = await supabase
        .from('wallet_payments')
        .select('*')
        .eq('reference', reference)
        .single()

    const payment = paymentData as any

    if (paymentError || !payment) {
        console.error('[SmsCredits] Payment not found:', reference)
        return { success: false, error: 'Payment not found' }
    }

    const originalMetadata = typeof payment.metadata === 'string'
        ? JSON.parse(payment.metadata)
        : (payment.metadata || {})

    const { data: updatedPayment, error: updatePaymentError } = await (supabase
        .from('wallet_payments') as any)
        .update({
            status: 'completed',
            metadata: { ...originalMetadata, provider_data: providerMetadata },
            updated_at: new Date().toISOString(),
        })
        .eq('id', payment.id)
        .eq('status', 'pending')
        .select()
        .single()

    if (updatePaymentError) {
        if (updatePaymentError.code === 'PGRST116') {
            return { success: true, alreadyProcessed: true }
        }
        console.error('[SmsCredits] Update payment error:', updatePaymentError)
        return { success: false, error: 'Failed to update payment status' }
    }

    if (!updatedPayment) return { success: true, alreadyProcessed: true }

    // The second latch, and the one that actually guards the credits: whoever
    // moves this row out of `pending` is the only caller that tops up.
    const { data: purchase, error: purchaseError } = await (supabase
        .from('sms_credit_purchases') as any)
        .update({ status: 'completed', completed_at: new Date().toISOString() })
        .eq('reference', reference)
        .eq('status', 'pending')
        .select('id, account_id, credits')
        .single()

    if (purchaseError) {
        if (purchaseError.code === 'PGRST116') {
            return { success: true, alreadyProcessed: true }
        }
        console.error('[SmsCredits] Purchase update error:', purchaseError)
        await (supabase.from('wallet_payments') as any)
            .update({ status: 'pending' })
            .eq('id', payment.id)
        return { success: false, error: 'Failed to record the credit purchase' }
    }

    const { data: newBalance, error: creditError } = await (supabase as any)
        .rpc('credit_sms_credits', {
            p_account_id: purchase.account_id,
            p_amount: purchase.credits,
            p_purchased: true,
        })

    if (creditError) {
        console.error('[SmsCredits] CRITICAL: credits not applied for paid purchase', reference, creditError)
        // Reopen both rows rather than leave the buyer paid-but-uncredited.
        await (supabase.from('sms_credit_purchases') as any)
            .update({ status: 'pending', completed_at: null })
            .eq('id', purchase.id)
        await (supabase.from('wallet_payments') as any)
            .update({ status: 'pending' })
            .eq('id', payment.id)
        return { success: false, error: 'Could not add the credits' }
    }

    const { data: subRow } = await supabase
        .from('sub_agents')
        .select('id')
        .eq('user_id', payment.user_id)
        .maybeSingle()

    await (supabase.from('notifications') as any).insert({
        user_id: payment.user_id,
        title: 'SMS Credits Added 💬',
        message: `${purchase.credits} SMS credits have been added. Your balance is now ${newBalance}.`,
        type: 'system',
        action_url: subRow ? '/dashboard/sub/sms' : '/dashboard/shop/sms',
    })

    return { success: true, credits: purchase.credits, balance: newBalance }
}

/**
 * Processes a completed dealer subscription payment: marks the payment completed,
 * promotes the user to `dealer`, extends `dealer_expires_at` by the purchased plan
 * length, and re-bases their shop pricing onto the dealer cost tier.
 * Idempotent — safe to call from both the webhook and the client-side verify poll.
 */
export async function processCompletedDealerSubscription(reference: string, providerMetadata?: any) {
    const supabase = createServerClient()

    // 1. Get payment record
    const { data: paymentData, error: paymentError } = await supabase
        .from('wallet_payments')
        .select('*')
        .eq('reference', reference)
        .single()

    const payment = paymentData as any

    if (paymentError || !payment) {
        console.error('[DealerSubProcess] Payment not found:', reference)
        return { success: false, error: 'Payment not found' }
    }

    const originalMetadata = typeof payment.metadata === 'string'
        ? JSON.parse(payment.metadata)
        : (payment.metadata || {})

    // 2. Atomic status flip (idempotency guard)
    const { data: updatedPayment, error: updatePaymentError } = await (supabase
        .from('wallet_payments') as any)
        .update({
            status: 'completed',
            metadata: { ...originalMetadata, provider_data: providerMetadata },
            updated_at: new Date().toISOString(),
        })
        .eq('id', payment.id)
        .eq('status', 'pending')
        .select()
        .single()

    if (updatePaymentError) {
        if (updatePaymentError.code === 'PGRST116') {
            return { success: true, alreadyProcessed: true }
        }
        console.error('[DealerSubProcess] Update payment error:', updatePaymentError)
        return { success: false, error: 'Failed to update payment status' }
    }

    if (!updatedPayment) return { success: true, alreadyProcessed: true }

    // 3. Load the user
    const { data: userData, error: userError } = await supabase
        .from('users')
        .select('role, dealer_expires_at, dealer_claimed_at, first_name, phone_number')
        .eq('id', payment.user_id)
        .single()

    const user = userData as any

    if (userError || !user) {
        console.error('[DealerSubProcess] User not found:', payment.user_id)
        return { success: false, error: 'User not found' }
    }

    // 4. Extend from the later of "now" and the current expiry
    const planDays: number = Number(originalMetadata?.plan_days) || 180
    const now = new Date()
    const currentExpiry = user.dealer_expires_at ? new Date(user.dealer_expires_at) : null
    const base = currentExpiry && currentExpiry > now ? currentExpiry : now
    const newExpiry = new Date(base.getTime() + planDays * 24 * 60 * 60 * 1000)

    const previousRole = user.role

    const { error: updateUserError } = await (supabase
        .from('users') as any)
        .update({
            role: 'dealer',
            dealer_expires_at: newExpiry.toISOString(),
            dealer_claimed_at: user.dealer_claimed_at ?? now.toISOString(),
            updated_at: now.toISOString(),
        })
        .eq('id', payment.user_id)

    if (updateUserError) {
        console.error('[DealerSubProcess] Update user error:', updateUserError)
        return { success: false, error: 'Failed to update user role' }
    }

    // 5. Re-base shop pricing onto the dealer cost tier (preserves profit margins)
    if (previousRole !== 'dealer') {
        try {
            const { error: rpcError } = await (supabase as any)
                .rpc('adjust_shop_pricing_for_role_change', {
                    p_user_id: payment.user_id,
                    p_old_role: previousRole,
                    p_new_role: 'dealer',
                })
            if (rpcError) {
                console.error('[DealerSubProcess] Pricing RPC error (non-fatal):', rpcError)
            }
        } catch (rpcErr) {
            console.error('[DealerSubProcess] Unexpected RPC error (non-fatal):', rpcErr)
        }
    }

    // 6. Notify
    const wasExtension = !!(currentExpiry && currentExpiry > now)
    await (supabase.from('notifications') as any).insert({
        user_id: payment.user_id,
        title: wasExtension ? 'Dealership Extended 🎉' : 'Dealership Activated 🎉',
        message: `Your dealer subscription has been ${wasExtension ? 'extended' : 'activated'} until ${newExpiry.toLocaleDateString()}.`,
        type: 'system',
        action_url: '/dashboard',
    })

    // 7. SMS confirmation (non-fatal)
    try {
        if (user.phone_number) {
            await sendDealerUpgradeSuccessSMS(
                user.phone_number,
                user.first_name || 'Dealer',
                newExpiry.toISOString()
            )
        }
    } catch (smsError) {
        console.error('[DealerSubProcess] SMS error:', smsError)
    }

    return { success: true, dealer_expires_at: newExpiry.toISOString() }
}
