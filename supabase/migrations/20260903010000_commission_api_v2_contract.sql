-- Aligns the Commission Services API with the published contract.
--
-- A separate file from 20260903000000 rather than an edit to it: that migration has
-- already left this machine, and rewriting an applied migration means the database
-- and the file disagree with no way to tell. Everything here is idempotent and safe
-- to run whether or not the first one has been applied.
--
-- Three changes.

-- ─── 1. The client reference stops being the order's reference ───────────────
-- The published contract makes `reference` a pure IDEMPOTENCY key: reusing one
-- returns the original order, and the order's own reference_code is ours to generate
-- (UTIL-<BILLER>-<random>).
--
-- Storing them separately is what makes that safe. reference_code is UNIQUE across
-- the whole table, so using the caller's string as the reference_code — as the first
-- cut did — means two partners who both pick "bill_001" collide, and scoping the
-- lookup to hide one partner's order from the other turns the collision into a
-- confusing insert failure instead. A per-user unique index on the idempotency key
-- gives each partner their own namespace.
ALTER TABLE public.utility_orders
    ADD COLUMN IF NOT EXISTS api_idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_utility_orders_api_idem
    ON public.utility_orders(user_id, api_idempotency_key)
    WHERE api_idempotency_key IS NOT NULL;

-- ─── 2. Commission is a share of the provider's commission ───────────────────
-- Not a percentage of the bill. commission_share_percent = 40 means the partner
-- receives 40% of whatever Hubtel actually paid us on that order, which is the
-- figure the API returns as commission_share_percent and the docs describe.
--
-- This supersedes commission_share_pct (a share of the bill) and retires
-- commission_share_cap_pct with it: a share of the commission cannot exceed the
-- commission, so the cap that existed to prevent that has nothing left to do.
INSERT INTO public.admin_settings (key, value) VALUES
    ('commission_share_percent', '40')
ON CONFLICT (key) DO NOTHING;

DELETE FROM public.admin_settings
 WHERE key IN ('commission_share_pct', 'commission_share_cap_pct');

-- Airtime moved to the standard key and is priced with the ordinary role fee, so
-- the API fee band it briefly had is dead. Utilities keep theirs — a commission
-- partner pays the bill at face value and earns from the commission wallet.
DELETE FROM public.admin_settings
 WHERE key IN ('airtime_fee_mtn_api', 'airtime_fee_telecel_api', 'airtime_fee_at_api');

-- ─── 3. Documented amount limits ─────────────────────────────────────────────
-- The contract publishes ONE min/max pair through GET /utilities/billers, while the
-- web path has always had per-service limits. These are the API's own bounds, and
-- /pay enforces them before the per-service ones so the error a partner sees names
-- the number they were given.
INSERT INTO public.admin_settings (key, value) VALUES
    ('utility_api_min_amount', '1'),
    ('utility_api_max_amount', '1000')
ON CONFLICT (key) DO NOTHING;
