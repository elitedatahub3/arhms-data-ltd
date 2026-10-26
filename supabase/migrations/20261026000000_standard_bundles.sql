-- Standard Bundles: KingFlexy's /api/v2/bundles/* resold at catalog price + markup.
--
-- One row per purchase, whichever channel it came through (dashboard wallet,
-- direct MoMo, a shop storefront or our own v2 API). reference_code is ours and is
-- ALSO the idempotency `reference` we send to KingFlexy, so re-sending an order
-- after a crash can never buy the bundle twice.

CREATE TABLE IF NOT EXISTS public.bundle_orders (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    user_role           text,
    -- The tier the markup was taken from: customer | agent | dealer | api.
    price_tier          text,
    network             text NOT NULL CHECK (network IN ('MTN', 'Telecel', 'AT')),
    beneficiary_phone   text NOT NULL,
    family              text,
    family_label        text,
    bundle_label        text NOT NULL,
    validity            text,
    -- Exactly one is set: Special bundles are bought by pack_id, the rest by value.
    kf_value            text,
    kf_pack_id          text,
    cost_amount         numeric(12,2) NOT NULL CHECK (cost_amount > 0),
    markup_amount       numeric(12,2) NOT NULL DEFAULT 0,
    shop_profit         numeric(12,2) NOT NULL DEFAULT 0,
    total_paid          numeric(12,2) NOT NULL CHECK (total_paid > 0),
    reference_code      text NOT NULL UNIQUE,
    provider_reference  text,
    status              text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'refunded')),
    payment_method      text NOT NULL DEFAULT 'wallet' CHECK (payment_method IN ('wallet', 'gateway')),
    payment_status      text NOT NULL DEFAULT 'paid' CHECK (payment_status IN ('pending', 'paid', 'refunded')),
    source              text NOT NULL DEFAULT 'dashboard' CHECK (source IN ('dashboard', 'storefront', 'api')),
    shop_id             uuid,
    api_key_id          uuid,
    -- What KingFlexy reports it earned us on this order (admin profit reporting).
    kf_commission       numeric(12,2),
    commission_credited_at timestamptz,
    provider_response   jsonb,
    fulfillment_note    text,
    fulfilled_by        uuid,
    fulfilled_at        timestamptz,
    dispatched_at       timestamptz,
    -- One admin alert per stuck order, not one per cron run.
    flagged_at          timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT bundle_orders_one_catalog_key CHECK ((kf_value IS NULL) <> (kf_pack_id IS NULL))
);

CREATE INDEX IF NOT EXISTS bundle_orders_user_created_idx ON public.bundle_orders (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS bundle_orders_open_idx ON public.bundle_orders (status, created_at)
    WHERE status IN ('pending', 'processing');

ALTER TABLE public.bundle_orders ENABLE ROW LEVEL SECURITY;

-- Users read their own orders; every write goes through the service role.
DO $$ BEGIN
    CREATE POLICY "bundle_orders: owner select" ON public.bundle_orders FOR SELECT
        USING (user_id = (SELECT auth.uid()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    CREATE POLICY "bundle_orders: admin all" ON public.bundle_orders FOR ALL
        USING (EXISTS (SELECT 1 FROM public.users WHERE id = (SELECT auth.uid()) AND role IN ('admin', 'sub-admin')));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Launch switched OFF. An admin turns it on from /admin/standard-bundles once the
-- KingFlexy catalog answers for our key.
INSERT INTO public.admin_settings (key, value) VALUES
    ('bundles_enabled', 'false'),
    ('bundles_enabled_mtn', 'true'),
    ('bundles_enabled_telecel', 'true'),
    ('bundles_enabled_at', 'true'),
    ('bundles_markup_percent_customer', '5'),
    ('bundles_markup_percent_agent', '2'),
    ('bundles_markup_percent_dealer', '1'),
    ('bundles_markup_percent_api', '2'),
    ('bundles_markup_min_ghs', '0'),
    ('bundles_auto_dispatch', 'true'),
    ('storefront_bundles_enabled', 'false'),
    ('page_access_standard_bundles', 'true')
ON CONFLICT (key) DO NOTHING;
