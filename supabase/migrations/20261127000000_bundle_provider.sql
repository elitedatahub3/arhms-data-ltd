-- Standard Bundles: a second provider (Datagod Developer API v2) beside KingFlexy.
--
-- Each order records the provider that took it, and every later step (dispatch,
-- status check, refund) asks THAT provider, so flipping the per-network switch on
-- /admin/standard-bundles never strands an order already in flight.
--
-- The switch itself lives in admin_settings (bundles_provider_mtn / _telecel / _at).
-- No rows are seeded: a missing key means KingFlexy, so this migration changes
-- nothing until an admin flips a network.

ALTER TABLE public.bundle_orders
    ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'kingflexy';

DO $$ BEGIN
    ALTER TABLE public.bundle_orders
        ADD CONSTRAINT bundle_orders_provider_check CHECK (provider IN ('kingflexy', 'datagod'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Datagod's stable catalog id for the bundle. The bundle_token is never stored:
-- it expires after 10 minutes, so dispatch always fetches a fresh one.
ALTER TABLE public.bundle_orders
    ADD COLUMN IF NOT EXISTS dg_bundle_id text;

-- KingFlexy rows keep "exactly one of kf_value / kf_pack_id"; Datagod rows carry
-- dg_bundle_id and no KingFlexy key.
ALTER TABLE public.bundle_orders DROP CONSTRAINT IF EXISTS bundle_orders_one_catalog_key;
ALTER TABLE public.bundle_orders
    ADD CONSTRAINT bundle_orders_one_catalog_key CHECK (
        (provider = 'kingflexy' AND (kf_value IS NULL) <> (kf_pack_id IS NULL) AND dg_bundle_id IS NULL)
        OR
        (provider = 'datagod' AND dg_bundle_id IS NOT NULL AND kf_value IS NULL AND kf_pack_id IS NULL)
    );

CREATE INDEX IF NOT EXISTS bundle_orders_provider_open_idx ON public.bundle_orders (provider, status)
    WHERE status IN ('pending', 'processing');
