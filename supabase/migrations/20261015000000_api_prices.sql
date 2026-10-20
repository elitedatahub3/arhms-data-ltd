-- Admin-set developer API prices.
--
-- When set, EVERY v2 API caller pays the API price, whatever their role. NULL means
-- "not set": the API falls back to the caller's ordinary role price (dealer → agent
-- → base). Only /api/v2 routes read these — see lib/api-pricing.ts.
--
-- AFA and airtime use admin_settings rows instead, which need no DDL:
--   afa_price_api                      flat GHS price per registration
--   airtime_fee_{mtn,telecel,at}_api   fee % per network
-- A missing or blank row means fall back.
--
-- Safe to run more than once. The code tolerates it not having run yet: the API
-- reads these tables with select('*') and simply charges role prices.

ALTER TABLE public.data_packages
    ADD COLUMN IF NOT EXISTS api_price numeric(10,2);

ALTER TABLE public.results_checker_types
    ADD COLUMN IF NOT EXISTS api_price numeric(10,2);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'data_packages_api_price_nonneg') THEN
        ALTER TABLE public.data_packages
            ADD CONSTRAINT data_packages_api_price_nonneg CHECK (api_price IS NULL OR api_price >= 0);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'results_checker_types_api_price_nonneg') THEN
        ALTER TABLE public.results_checker_types
            ADD CONSTRAINT results_checker_types_api_price_nonneg CHECK (api_price IS NULL OR api_price >= 0);
    END IF;
END $$;

NOTIFY pgrst, 'reload schema';
