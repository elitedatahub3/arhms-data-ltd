-- Durable copy of storefront checkout metadata.
--
-- Until now the order details for a storefront (SHOP-) payment lived only in
-- Redis (`shop:meta:<ref>`, 24h TTL). When Redis was over quota, checkout could
-- not start, and a payment already in flight could not be settled because the
-- callback had nothing to price it from. Redis stays the fast path; this table
-- is the fallback lib/shop-meta-store.ts reads when Redis has no answer.
--
-- Service role only: RLS is on with no policies, so anon/authenticated clients
-- cannot read or write it. The API routes use the service-role client.

CREATE TABLE IF NOT EXISTS public.shop_payment_meta (
    reference   text PRIMARY KEY,
    metadata    jsonb NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    expires_at  timestamptz NOT NULL DEFAULT (now() + interval '24 hours')
);

CREATE INDEX IF NOT EXISTS shop_payment_meta_expires_at_idx
    ON public.shop_payment_meta (expires_at);

ALTER TABLE public.shop_payment_meta ENABLE ROW LEVEL SECURITY;
