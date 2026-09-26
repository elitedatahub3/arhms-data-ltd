-- ============================================================
-- USSD collections move from Hubtel AddToCart to Paystack Mobile Money
--
-- Until now a USSD sale was never a payment we made. The confirm screen returned
-- Hubtel's `AddToCart` and Hubtel charged the customer on its own side, settled
-- into the Hubtel merchant account, and told us only at /api/hubtel/fulfill. We
-- now debit the caller ourselves with the Paystack Charge API and fulfil from
-- /api/webhooks/paystack.
--
-- No schema change is required for the payments themselves: a USSD caller has no
-- account, so there is no wallet_payments row to write (that table needs user_id
-- and wallet_id NOT NULL). Pending state lives in Redis (`ussd:ref:{reference}`)
-- and the audit trail in hubtel_payment_logs, which already has a 'ussd' flow and
-- an admin page filtering on it.
-- ============================================================

-- Which gateway collects for a USSD sale.
--
-- Seeded 'paystack' because that is what the code now does by default. Note the
-- doubled quotes: value is JSONB, so a bare 'paystack' is not valid JSON and the
-- insert is rejected outright. Every consumer compares this as a string, so it is
-- stored as a JSON string, matching 20260813_referral_bonuses.sql. The value
-- exists so the previous behaviour is one setting away rather than one deploy
-- away: set it to 'hubtel' and the confirm step returns AddToCart exactly as
-- before. Anything other than 'hubtel' reads as 'paystack'.
INSERT INTO public.admin_settings (key, value) VALUES
    ('ussd_payment_provider', '"paystack"')
ON CONFLICT (key) DO NOTHING;

-- The reconciliation sweep (/api/cron/verify-ussd-payments) reads pending USSD
-- charges out of the payment log every five minutes. Without this it is a full
-- scan of a table that only grows.
CREATE INDEX IF NOT EXISTS idx_hubtel_payment_logs_flow_status_created
    ON public.hubtel_payment_logs (flow, status, created_at);
