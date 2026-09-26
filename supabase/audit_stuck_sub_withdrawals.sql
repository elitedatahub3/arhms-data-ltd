-- ============================================================================
-- READ-ONLY AUDIT: sub withdrawals stranded in 'shop_owner_pending'
-- ----------------------------------------------------------------------------
-- These subs have ALREADY been debited (deduct_shop_wallet_balance runs when
-- the request is created) but the row never reached the admin payout queue,
-- because nothing in the app ever called approve_sub_withdrawal() and the 48h
-- escalation cron was never registered.
--
-- Nothing is modified. Run in the Supabase SQL Editor and read the results.
-- ============================================================================

SELECT
    swt.id                                   AS withdrawal_id,
    swt.created_at,
    ROUND(EXTRACT(EPOCH FROM (NOW() - swt.created_at)) / 86400, 1) AS age_days,

    -- Who is owed the money
    su.first_name || ' ' || su.last_name     AS sub_name,
    su.phone                                 AS sub_phone,
    sub_shop.shop_name                       AS sub_shop_name,

    -- Payout details the sub submitted
    swt.amount,
    swt.net_amount,
    swt.network,
    swt.momo_number,
    swt.account_name,

    -- Where it is stuck
    swt.status,
    swt.sub_approval_status,
    swt.escalate_after,
    (swt.escalate_after < NOW())             AS escalation_window_lapsed,

    -- The Lead who was supposed to approve
    lu.first_name || ' ' || lu.last_name     AS lead_name,
    lu.phone                                 AS lead_phone,
    upline_shop.shop_name                    AS lead_shop_name,

    -- Can the sub actually be refunded from their current balance? (context only)
    sw.balance                               AS sub_current_balance

FROM public.shop_wallet_transactions swt
JOIN public.shop_wallets   sw          ON swt.shop_wallet_id = sw.id
JOIN public.sub_agents     sa          ON sw.owner_id        = sa.user_id
JOIN public.users          su          ON sa.user_id         = su.id
LEFT JOIN public.shop_profiles sub_shop    ON sub_shop.owner_id  = sa.user_id
LEFT JOIN public.shop_profiles upline_shop ON sa.upline_shop_id  = upline_shop.id
LEFT JOIN public.users         lu          ON upline_shop.owner_id = lu.id

WHERE swt.type   = 'withdrawal'
  AND swt.status = 'shop_owner_pending'

ORDER BY swt.created_at ASC;


-- ── Totals: how much money is stranded in this state ────────────────────────
SELECT
    COUNT(*)                AS stuck_requests,
    COUNT(DISTINCT sw.owner_id) AS affected_subs,
    SUM(swt.amount)         AS total_debited_from_subs,
    MIN(swt.created_at)     AS oldest_request
FROM public.shop_wallet_transactions swt
JOIN public.shop_wallets sw ON swt.shop_wallet_id = sw.id
WHERE swt.type   = 'withdrawal'
  AND swt.status = 'shop_owner_pending';
