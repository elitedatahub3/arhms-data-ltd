-- Standard Bundles on shop storefronts.
--
-- The shop owner switches them on and sets one percentage that is added on top of
-- the owner's own price (our Standard Bundles price for the owner's role). A
-- storefront buyer is a guest, so the order is placed under the owner, exactly
-- as storefront bill payments are; the owner's margin is bundle_orders.shop_profit
-- and is paid into the shop wallet only once the bundle is delivered.

ALTER TABLE public.shop_profiles
    ADD COLUMN IF NOT EXISTS bundles_enabled boolean NOT NULL DEFAULT false;

ALTER TABLE public.shop_profiles
    ADD COLUMN IF NOT EXISTS bundle_markup_percent numeric(5,2) NOT NULL DEFAULT 0;

DO $$ BEGIN
    ALTER TABLE public.shop_profiles
        ADD CONSTRAINT shop_profiles_bundle_markup_percent_check CHECK (bundle_markup_percent >= 0 AND bundle_markup_percent <= 10);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Set when the shop's profit has been paid into its shop wallet (latch; the
-- shop_wallet_transactions unique (reference, type) index is the real guard).
ALTER TABLE public.bundle_orders
    ADD COLUMN IF NOT EXISTS shop_credited_at timestamptz;

CREATE INDEX IF NOT EXISTS bundle_orders_shop_idx ON public.bundle_orders (shop_id, created_at DESC)
    WHERE shop_id IS NOT NULL;
