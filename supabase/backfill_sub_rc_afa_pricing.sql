-- ============================================================================
-- Backfill: give existing sub-agent storefronts their Results Checker and AFA
-- prices, so those tiles finally render.
-- ----------------------------------------------------------------------------
-- seedSubShopFromParent() (app/api/shop/profile/route.ts) cloned only
-- shop_pricing and the airtime fees, so every sub storefront ever created sold
-- data and airtime and nothing else. The two missing tiles are not hidden by a
-- flag — they are absent because the shop has no priced rows:
--
--   /api/shop/rc/types   returns {types: []}      -> ShopStorefront hides the tab
--   /api/shop/afa/config returns {enabled: false} -> ShopStorefront hides the tab
--
-- The seeding function now copies both for new shops. This repairs the ones
-- that already exist, at every level of the network.
--
-- Run ONCE in the Supabase SQL Editor. Idempotent — safe to re-run, and it
-- never overwrites a price a sub has already chosen.
-- ============================================================================

-- 1. Results Checker: copy the parent's catalogue at parent price + ₵0.50, for
--    sub shops with no RC pricing of their own yet.
INSERT INTO public.shop_rc_pricing (shop_id, rc_type_id, selling_price)
SELECT s.id, pr.rc_type_id, ROUND(pr.selling_price + 0.50, 2)
FROM public.shop_profiles s
JOIN public.sub_agents sa ON sa.user_id = s.owner_id
JOIN public.shop_rc_pricing pr ON pr.shop_id = sa.upline_shop_id
WHERE pr.selling_price IS NOT NULL
  AND NOT EXISTS (
      SELECT 1 FROM public.shop_rc_pricing x WHERE x.shop_id = s.id
  )
ON CONFLICT (shop_id, rc_type_id) DO NOTHING;

-- 2. AFA registration: one row per shop, so a plain insert-where-missing.
INSERT INTO public.shop_afa_pricing (shop_id, selling_price)
SELECT s.id, ROUND(pa.selling_price + 0.50, 2)
FROM public.shop_profiles s
JOIN public.sub_agents sa ON sa.user_id = s.owner_id
JOIN public.shop_afa_pricing pa ON pa.shop_id = sa.upline_shop_id
WHERE pa.selling_price IS NOT NULL
  AND NOT EXISTS (
      SELECT 1 FROM public.shop_afa_pricing x WHERE x.shop_id = s.id
  )
ON CONFLICT (shop_id) DO NOTHING;

-- 3. What landed. Run this after the two inserts to confirm every sub shop can
--    now show all four product tiles.
SELECT
    s.shop_slug,
    sa.depth,
    (SELECT COUNT(*) FROM public.shop_pricing    x WHERE x.shop_id = s.id) AS data_packages,
    (SELECT COUNT(*) FROM public.shop_rc_pricing x WHERE x.shop_id = s.id) AS rc_types,
    (SELECT COUNT(*) FROM public.shop_afa_pricing x WHERE x.shop_id = s.id) AS afa_priced
FROM public.shop_profiles s
JOIN public.sub_agents sa ON sa.user_id = s.owner_id
ORDER BY sa.depth, s.shop_slug;
