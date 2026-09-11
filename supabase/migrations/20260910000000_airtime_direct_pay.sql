-- Direct Pay (MoMo/card) for airtime, alongside the existing wallet-debit path.
--
-- airtime_orders predates payment_method/payment_status entirely — every row has
-- always been paid by wallet debit at INSERT time (see app/api/airtime/create,
-- which deducts the wallet BEFORE inserting the order). Direct-pay orders are
-- different: the order does not exist until the gateway confirms payment (see
-- lib/airtime-order-payments.ts), so it needs to record that it was already paid
-- via a gateway rather than the wallet.
--
-- Mirrors utility_orders.payment_method / payment_status exactly (see
-- supabase/migrations/20260816000000_utility_bill_payments.sql).
-- ADD COLUMN ... NOT NULL DEFAULT backfills every existing row with the default
-- in the same statement, so every prior order (all wallet-debited at creation)
-- ends up correctly marked 'wallet' / 'paid' with no separate UPDATE needed.
ALTER TABLE public.airtime_orders
    ADD COLUMN IF NOT EXISTS payment_method TEXT NOT NULL DEFAULT 'wallet'
        CHECK (payment_method IN ('wallet', 'gateway')),
    ADD COLUMN IF NOT EXISTS payment_status TEXT NOT NULL DEFAULT 'paid'
        CHECK (payment_status IN ('pending', 'paid', 'refunded'));
