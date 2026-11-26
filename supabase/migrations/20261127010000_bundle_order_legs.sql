-- Special Bundles: one customer order = N Datagod purchases of the same small
-- bundle (MTN 406.89MB) to the same number. Each purchase is a "leg".
--
-- A leg's reference is "<order reference_code>:<leg_no>", Datagod's idempotency
-- key, so re-sending a leg after a timeout can never buy it twice.
-- Needs 20261127000000_bundle_provider.sql first.

CREATE TABLE IF NOT EXISTS public.bundle_order_legs (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id          uuid NOT NULL REFERENCES public.bundle_orders(id) ON DELETE CASCADE,
    leg_no            integer NOT NULL CHECK (leg_no >= 1),
    reference         text NOT NULL UNIQUE,
    -- pending: never sent. sending: sent, outcome not confirmed (ask before resending).
    -- processing: Datagod accepted it. completed / failed: final.
    status            text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'sending', 'processing', 'completed', 'failed')),
    note              text,
    provider_response jsonb,
    sent_at           timestamptz,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    UNIQUE (order_id, leg_no)
);

CREATE INDEX IF NOT EXISTS bundle_order_legs_open_idx ON public.bundle_order_legs (order_id)
    WHERE status IN ('pending', 'sending', 'processing');

ALTER TABLE public.bundle_order_legs ENABLE ROW LEVEL SECURITY;

-- Every write goes through the service role; admins may read.
DO $$ BEGIN
    CREATE POLICY "bundle_order_legs: admin select" ON public.bundle_order_legs FOR SELECT
        USING (EXISTS (SELECT 1 FROM public.users WHERE id = (SELECT auth.uid()) AND role IN ('admin', 'sub-admin')));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Money returned for the legs that failed when the others delivered. NULL = no
-- partial refund yet; setting it is the claim that stops a double refund.
ALTER TABLE public.bundle_orders
    ADD COLUMN IF NOT EXISTS refunded_amount numeric(12,2);
