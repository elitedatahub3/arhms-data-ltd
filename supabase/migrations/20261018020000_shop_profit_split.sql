-- ============================================================================
-- Sub-agent profit split for Results Checker and AFA shop sales
-- ============================================================================
-- Data orders have always recorded what each upline earns on a sub-agent's sale
-- (shop_orders.parent_profit / grandparent_profit). Checker and AFA orders had no
-- such columns, and their settlement paid the selling sub the entire margin while
-- every upline got nothing — even though a sub's checker and AFA prices are
-- floored on their upline's price.
--
-- lib/shop-profit.ts now computes the split when the order is created and stores
-- it here; every settlement path pays what the row says. Until this runs, orders
-- are still created (the insert retries without these columns) but their upline
-- legs are dropped and logged.
-- ============================================================================

ALTER TABLE public.results_checker_orders
    ADD COLUMN IF NOT EXISTS parent_shop_id      UUID REFERENCES public.shop_profiles(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS parent_profit       DECIMAL(12,2),
    ADD COLUMN IF NOT EXISTS grandparent_shop_id UUID REFERENCES public.shop_profiles(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS grandparent_profit  DECIMAL(12,2);

ALTER TABLE public.afa_orders
    ADD COLUMN IF NOT EXISTS parent_shop_id      UUID REFERENCES public.shop_profiles(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS parent_profit       DECIMAL(12,2),
    ADD COLUMN IF NOT EXISTS grandparent_shop_id UUID REFERENCES public.shop_profiles(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS grandparent_profit  DECIMAL(12,2);

COMMENT ON COLUMN public.results_checker_orders.parent_profit IS
    'What the selling shop''s direct upline earns on this sale. Paid under reference <reference_code>:up1.';
COMMENT ON COLUMN public.results_checker_orders.grandparent_profit IS
    'What the root Lead earns on a level-2 sub''s sale. Paid under reference <reference_code>:up2.';
COMMENT ON COLUMN public.afa_orders.parent_profit IS
    'What the selling shop''s direct upline earns on this sale. Paid under reference <reference>:up1.';
COMMENT ON COLUMN public.afa_orders.grandparent_profit IS
    'What the root Lead earns on a level-2 sub''s sale. Paid under reference <reference>:up2.';

-- PostgREST caches the schema; without this the new columns 400 until it reloads.
NOTIFY pgrst, 'reload schema';
