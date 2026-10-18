-- ============================================================
-- SMS Platform order confirmations
--
-- "Use my sender ID for order confirmations" on the SMS Platform: when on,
-- the data and airtime the user buys on the platform itself are confirmed to
-- the recipient under the user's own approved sender ID, paid from their SMS
-- credits, instead of the house sender.
--
-- Separate from the shop's storefront confirmations
-- (order_sms_data_enabled / order_sms_airtime_enabled), which stay as they are.
-- Until this runs the switch cannot be saved and every platform confirmation
-- uses the house sender, as today.
-- ============================================================

ALTER TABLE public.sms_accounts
    ADD COLUMN IF NOT EXISTS platform_order_sms_enabled     BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS last_platform_order_sms_skip    TEXT,
    ADD COLUMN IF NOT EXISTS last_platform_order_sms_skip_at TIMESTAMPTZ;
