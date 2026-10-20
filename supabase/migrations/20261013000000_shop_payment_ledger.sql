-- Turn shop_payment_meta into the ledger of every storefront (SHOP-) payment.
--
-- Until now the only record that a storefront payment was still in flight was a
-- Redis marker (paystack_momo:pending:<ref>), and only the Paystack MoMo rail wrote
-- one. When Redis was over quota, or a callback cleared the marker without creating
-- the order, a paid payment could end with no order and no trace.
--
-- Each row now carries a status:
--   pending         - charge started; no order yet. The reconciliation cron works these.
--   settled         - shop_orders row exists for this reference.
--   failed          - the payment never happened (declined / abandoned). Nothing owed.
--   needs_attention - PAID but the order could not be created after retries, or for a
--                     reason retrying cannot fix (amount mismatch). A human must act.
--
-- Safe to run more than once. lib/shop-meta-store.ts works before and after it.

ALTER TABLE public.shop_payment_meta
    ADD COLUMN IF NOT EXISTS provider   text,
    ADD COLUMN IF NOT EXISTS kind       text NOT NULL DEFAULT 'shop',
    ADD COLUMN IF NOT EXISTS slug       text,
    ADD COLUMN IF NOT EXISTS status     text NOT NULL DEFAULT 'pending',
    ADD COLUMN IF NOT EXISTS attempts   integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS last_error text,
    ADD COLUMN IF NOT EXISTS settled_at timestamptz,
    -- When the cron last asked the gateway, so a backlog is worked round-robin
    -- instead of the oldest rows eating every run.
    ADD COLUMN IF NOT EXISTS last_checked_at timestamptz;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'shop_payment_meta_status_check'
    ) THEN
        ALTER TABLE public.shop_payment_meta
            ADD CONSTRAINT shop_payment_meta_status_check
            CHECK (status IN ('pending', 'settled', 'failed', 'needs_attention'));
    END IF;
END $$;

-- Rows written before this migration: mark the ones that already became orders,
-- so the cron does not re-verify history. Everything else stays 'pending' and the
-- cron settles or fails it on its next runs.
UPDATE public.shop_payment_meta m
   SET status = 'settled', settled_at = COALESCE(m.settled_at, now())
  FROM public.shop_orders o
 WHERE o.paystack_reference = m.reference
   AND m.status = 'pending';

-- Provider for pre-migration rows, from the stored metadata.
UPDATE public.shop_payment_meta
   SET provider = metadata->>'provider'
 WHERE provider IS NULL AND metadata ? 'provider';

CREATE INDEX IF NOT EXISTS shop_payment_meta_status_created_idx
    ON public.shop_payment_meta (status, created_at);
CREATE INDEX IF NOT EXISTS shop_payment_meta_status_checked_idx
    ON public.shop_payment_meta (status, last_checked_at NULLS FIRST);
