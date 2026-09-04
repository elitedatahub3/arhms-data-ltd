-- Stops a shop price from ever being zero or negative, and closes the path that
-- allowed it.
--
-- Background. /api/shop/sub-pricing validates a wholesale price properly: it
-- resolves the owner's cost server-side and refuses anything below it
-- (isSubPriceValid in lib/pricing/cost-basis.ts). The pricing screen shows the same
-- rule in the browser. Neither is the last word, because shop_pricing carries an
-- RLS policy — shop_pricing_owner_all — granted FOR ALL to authenticated with only
-- a USING clause and no WITH CHECK. A shop owner holding their own session can
-- therefore write the column directly with the public anon key:
--
--     supabase.from('shop_pricing').update({ sub_price: -100 }).eq('shop_id', mine)
--
-- USING restricts WHICH ROWS they may touch, not what they may put in them, so that
-- write is permitted today and never passes through the validator. A negative
-- wholesale price means the owner pays their sub-agent on every downline order.
--
-- Two layers go in, because either alone leaves a gap:
--
--   1. A CHECK constraint. Absolute — it holds against the API, the browser, the
--      service role, a psql session and any future code path. It cannot express
--      "at least your cost" (that depends on role and upline chain, and changes as
--      those change), so it enforces the part that is always true: a price is
--      positive.
--
--   2. Removing the owner's direct write grant, so the cost-aware rule in the API
--      is the only way in. Owners keep reading their own rows.
--
-- Verified against production before writing this: 10,190 rows, none with a
-- zero or negative selling_price or sub_price. The constraints validate as-is.

-- ─── 1. Positive-price constraints ───────────────────────────────────────────
-- DROP IF EXISTS then ADD, rather than a DO block trapping duplicate_object.
-- Re-running is then unconditional, and there is no dollar-quoting to get wrong.
ALTER TABLE public.shop_pricing
    DROP CONSTRAINT IF EXISTS shop_pricing_selling_price_positive;
ALTER TABLE public.shop_pricing
    ADD  CONSTRAINT shop_pricing_selling_price_positive
    CHECK (selling_price > 0);

-- NULL stays legal and means "no wholesale price set" — readers fall back to the
-- retail price. Only a present value has to be positive.
ALTER TABLE public.shop_pricing
    DROP CONSTRAINT IF EXISTS shop_pricing_sub_price_positive;
ALTER TABLE public.shop_pricing
    ADD  CONSTRAINT shop_pricing_sub_price_positive
    CHECK (sub_price IS NULL OR sub_price > 0);

-- ─── PRE-FLIGHT for section 2 ────────────────────────────────────────────────
-- Section 1 above is unconditional and safe. Section 2 drops the owner write
-- grant, and admin writes then depend entirely on shop_pricing_admin_write,
-- which lives in a loose script (supabase/fix_shop_pricing_rls.sql) rather than a
-- migration -- so it cannot be proven applied from the repo alone. Run this first:
--
--     SELECT policyname, cmd, roles
--       FROM pg_policies
--      WHERE schemaname = 'public' AND tablename = 'shop_pricing'
--      ORDER BY policyname;
--
-- Expect shop_pricing_admin_write in the output. If it is absent, run
-- supabase/fix_shop_pricing_rls.sql before this file, or an admin approving a
-- pending price submission will start getting an RLS denial.
--
-- (In practice it must already be live: the admin shop page writes pricing rows
-- for shops the admin does not own, which shop_pricing_owner_all never permitted.)

-- ─── 2. Owners read their own rows; they do not write them ───────────────────
-- Created BEFORE the broad policy is dropped, so read access is never interrupted
-- even for the moment between the two statements.
DROP POLICY IF EXISTS "shop_pricing_owner_read" ON public.shop_pricing;
CREATE POLICY "shop_pricing_owner_read" ON public.shop_pricing
    FOR SELECT TO authenticated USING (
        shop_id IN (SELECT id FROM public.shop_profiles WHERE owner_id = (SELECT auth.uid()))
    );

-- The over-broad grant. Every legitimate owner write already goes through a route
-- handler on the service role — /api/shop/pricing for retail, /api/shop/sub-pricing
-- for wholesale — which is where the cost checks live. Admin writes are unaffected:
-- they run under shop_pricing_admin_write (see supabase/fix_shop_pricing_rls.sql),
-- which is a separate policy.
DROP POLICY IF EXISTS "shop_pricing_owner_all" ON public.shop_pricing;

NOTIFY pgrst, 'reload schema';
