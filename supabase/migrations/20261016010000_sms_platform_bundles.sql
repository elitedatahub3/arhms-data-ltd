-- ============================================================
-- SMS Platform credit bundles
--
-- The SMS Platform sells credits at its own prices, separate from the shop
-- Customer SMS price list. Every existing bundle stays a 'shop' bundle, so
-- Customer SMS prices are unchanged; platform bundles are created in
-- /admin/sms-senders → Settings & bundles → SMS Platform bundles.
--
-- Until this runs the application shows every bundle to Customer SMS as
-- before and none on the SMS Platform.
-- ============================================================

ALTER TABLE public.sms_credit_bundles
    ADD COLUMN IF NOT EXISTS audience TEXT NOT NULL DEFAULT 'shop';

DO $$ BEGIN
    ALTER TABLE public.sms_credit_bundles
        ADD CONSTRAINT sms_credit_bundles_audience_check CHECK (audience IN ('shop', 'platform'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_sms_credit_bundles_audience
    ON public.sms_credit_bundles(audience, sort_order) WHERE is_active = true;
