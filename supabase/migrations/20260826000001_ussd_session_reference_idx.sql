-- ============================================================
-- Find a USSD session by the Paystack reference it is paying for
--
-- The reconciliation sweep (/api/cron/verify-ussd-payments) starts from a
-- reference in hubtel_payment_logs and has to get back to a session. The webhook
-- does not need this - Paystack echoes session_id in the charge metadata - but
-- the cron has no metadata to read, so it queries the session payload instead.
--
-- Without the index that is a sequential scan of a table every USSD keypress
-- writes to, run every five minutes.
--
-- Partial, because only sessions that reached the confirm step have the key at
-- all; the index stays small no matter how much menu traffic passes through.
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_hubtel_sessions_paystack_reference
    ON public.hubtel_sessions ((data ->> 'paystackReference'))
    WHERE data ->> 'paystackReference' IS NOT NULL;
