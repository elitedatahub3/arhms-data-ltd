-- Record every supplier call made for a data order, for the fallback supplier switch.
--
-- lib/supplier-router.ts sends an order to the network's primary supplier and, if
-- that supplier DEFINITELY refused it (no balance, out of stock, bad key...), to the
-- fallback the admin switched on for the network. Each call is appended here as
--   { supplier, at, outcome: success|already_submitted|refused|unknown, error? }
--
-- Two things read it:
--   * the router itself: once a supplier returned 'unknown' for an order (timeout,
--     5xx — it may have accepted it), every retry goes to that supplier alone, so a
--     fallback can never deliver the same bundle a second time;
--   * /admin/fulfillment, which shows "Dakazina refused -> BundlePortal ✓" per order.
--
-- Safe to run more than once. The code works without it: it just can't remember
-- attempts between retries, and falls back to the configured primary-then-fallback.

ALTER TABLE public.orders
    ADD COLUMN IF NOT EXISTS supplier_attempts jsonb NOT NULL DEFAULT '[]'::jsonb;
