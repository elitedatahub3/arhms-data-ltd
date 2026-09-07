-- Lets a shop sell utility bills from its storefront and keep a margin.
--
-- The margin model is a percentage of the bill, not a price per item, because a
-- bill has no fixed amount — the customer types it. That makes this closer to
-- shop_profiles.airtime_fee_mtn/_telecel/_at than to shop_pricing, and it is
-- deliberately modelled the same way.
--
-- ─── The 5% ceiling is on the TOTAL, not per level ───────────────────────────
--
-- A customer must never pay more than 5% over the face value of their bill, no
-- matter who sold it to them. The platform's own fee, the shop's margin and every
-- sub-agent's margin all come out of that same 5%.
--
-- That is the whole reason the cap cannot live in a CHECK constraint on this
-- column. A CHECK sees one row; the rule spans the platform fee in admin_settings
-- plus every ancestor in the sub-agent chain. A shop at 3% is legal under a Lead
-- taking 0% and illegal under a Lead taking 3%, and the same stored value can flip
-- between the two when the upline edits theirs. The constraint below is only a
-- sanity bound — the real rule is enforced in lib/utility-shop-pricing.ts, which is
-- the single place that knows the whole chain.

ALTER TABLE public.shop_profiles
    ADD COLUMN IF NOT EXISTS utility_fee_percent NUMERIC(5,2) NOT NULL DEFAULT 0;

-- Cannot be negative (paying the customer to pay a bill) and cannot exceed the
-- ceiling on its own. Everything between is chain-dependent and checked in code.
DO $$ BEGIN
    ALTER TABLE public.shop_profiles
        ADD CONSTRAINT shop_profiles_utility_fee_percent_range
        CHECK (utility_fee_percent >= 0 AND utility_fee_percent <= 5);
EXCEPTION
    WHEN duplicate_object THEN NULL;
    WHEN duplicate_table  THEN NULL;
END $$;

-- Whether this shop shows the Pay Bills tab at all. Separate from the margin: a
-- shop may legitimately sell at 0% and still want the tab.
ALTER TABLE public.shop_profiles
    ADD COLUMN IF NOT EXISTS utilities_enabled BOOLEAN NOT NULL DEFAULT false;

-- ─── Order attribution ───────────────────────────────────────────────────────
-- Mirrors what 20260325_shop_airtime.sql added to airtime_orders.
ALTER TABLE public.utility_orders
    ADD COLUMN IF NOT EXISTS shop_id UUID REFERENCES public.shop_profiles(id);
ALTER TABLE public.utility_orders
    ADD COLUMN IF NOT EXISTS shop_name TEXT;

-- What the reseller chain charged on top of the platform's own fee_amount.
ALTER TABLE public.utility_orders
    ADD COLUMN IF NOT EXISTS reseller_fee_amount NUMERIC(12,2) NOT NULL DEFAULT 0;

-- The split, SNAPSHOTTED at checkout: [{shop_id, owner_id, percent, amount}].
--
-- Stored rather than recomputed at completion because a bill can settle minutes or
-- hours later, and by then a Lead may have changed their margin or a sub may have
-- left the chain. Paying out against today's configuration for yesterday's sale
-- would quietly pay the wrong people.
ALTER TABLE public.utility_orders
    ADD COLUMN IF NOT EXISTS reseller_split JSONB;

-- Set once the chain has actually been paid. Same latch shape as
-- commission_credited_at: claimed with a conditional UPDATE before any money
-- moves, so a webhook racing the reconciliation cron cannot pay a shop twice.
ALTER TABLE public.utility_orders
    ADD COLUMN IF NOT EXISTS reseller_credited_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_utility_orders_shop ON public.utility_orders(shop_id);

-- ─── Settings ────────────────────────────────────────────────────────────────
-- The ceiling lives here so it can move without a deploy. Read by
-- lib/utility-shop-pricing.ts; the CHECK above is only a per-row sanity bound and
-- does NOT follow this value, so lowering it below 5 needs the constraint revisited.
INSERT INTO public.admin_settings (key, value) VALUES
    ('utility_total_markup_cap_percent', '5')
ON CONFLICT (key) DO NOTHING;
