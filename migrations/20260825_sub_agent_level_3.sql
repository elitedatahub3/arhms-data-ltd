-- Migration: Sub-Agent Network — third level
-- Date: 2026-08-25
-- Description: Let a sub-agent recruit their own sub-agent, three levels deep.
--   Lead (L0) → sub (L1) → sub-sub (L2). L2 cannot recruit.
--
--   This lifts decision D1 ("2-level hierarchy") from
--   docs/SUB_AGENTS_IMPLEMENTATION.md. Note the third level was never actually
--   blocked: POST /api/shop/invites authorises on "do you own a shop?" alone,
--   and a sub in storefront mode owns one. So this migration is as much about
--   making an already-reachable state correct as it is about new capability.
--
--   1. sub_agents.depth      — derived, never supplied; capped at 2 by CHECK
--   2. shop_orders.grandparent_* — the third profit slot
--   3. enforce_sub_agent_depth() — depth cap, self-enrolment and cycle guard

-- ============================================================
-- 1. sub_agents.depth
-- ============================================================
ALTER TABLE public.sub_agents
ADD COLUMN IF NOT EXISTS depth SMALLINT NOT NULL DEFAULT 1;

COMMENT ON COLUMN public.sub_agents.depth IS
  'Levels below the root Lead: 1 = sub of a Lead, 2 = sub of a sub. Derived by '
  'enforce_sub_agent_depth(); any value supplied by a client is overwritten.';

-- Backfill in ordered passes rather than a blanket depth=1. Level-2 rows may
-- already exist, created through the open invite path described above.
UPDATE public.sub_agents SET depth = 1;

UPDATE public.sub_agents sa SET depth = 2
FROM public.shop_profiles sp
JOIN public.sub_agents up ON up.user_id = sp.owner_id
WHERE sp.id = sa.upline_shop_id
  AND up.depth = 1;

-- Anything still sitting under a depth-2 upline is a level-3+ chain. The CHECK
-- below would reject it with a constraint name and no context, so fail here
-- instead, loudly and with the offending rows named.
DO $$
DECLARE
  v_deep TEXT;
BEGIN
  SELECT string_agg(sa.id::text, ', ') INTO v_deep
  FROM public.sub_agents sa
  JOIN public.shop_profiles sp ON sp.id = sa.upline_shop_id
  JOIN public.sub_agents up ON up.user_id = sp.owner_id
  WHERE up.depth >= 2;

  IF v_deep IS NOT NULL THEN
    RAISE EXCEPTION
      'Found sub_agents rows deeper than the 2-level cap: %. Resolve these before applying this migration.',
      v_deep;
  END IF;
END $$;

ALTER TABLE public.sub_agents
DROP CONSTRAINT IF EXISTS sub_agents_depth_range;

ALTER TABLE public.sub_agents
ADD CONSTRAINT sub_agents_depth_range CHECK (depth BETWEEN 1 AND 2);

-- ============================================================
-- 2. shop_orders: the third profit slot
-- ============================================================
-- shop_orders already carries `profit` (the seller) and `parent_profit` (one
-- upline). A three-level chain needs one more. Kept as scalars rather than a
-- normalised legs table because the depth is capped at 3 by product decision —
-- this way every existing read, RLS policy and admin query keeps working
-- untouched. If depth 4+ is ever wanted, that is the moment to normalise.
ALTER TABLE public.shop_orders
ADD COLUMN IF NOT EXISTS grandparent_shop_id UUID REFERENCES public.shop_profiles(id) ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS grandparent_profit NUMERIC(12, 2);

CREATE INDEX IF NOT EXISTS idx_shop_orders_grandparent_shop
  ON public.shop_orders(grandparent_shop_id);

COMMENT ON COLUMN public.shop_orders.grandparent_shop_id IS
  'The root Lead''s shop when the seller is a level-2 sub. NULL at one or two levels.';

-- ============================================================
-- 3. Depth cap, self-enrolment and cycle guard
-- ============================================================
-- The application enforces these too (clearer errors, earlier), but the
-- invariant belongs in the database: sub_agents has had no cycle prevention of
-- any kind, and the self-enrolment rule has already been broken once in
-- production (see supabase/fix_self_enrolled_sub_agents.sql).
CREATE OR REPLACE FUNCTION public.enforce_sub_agent_depth()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_upline_owner_id UUID;
  v_parent_depth    SMALLINT;
  v_cursor_owner_id UUID;
  v_cursor_shop_id  UUID;
  v_hops            INT := 0;
BEGIN
  SELECT owner_id INTO v_upline_owner_id
  FROM public.shop_profiles
  WHERE id = NEW.upline_shop_id;

  IF v_upline_owner_id IS NULL THEN
    RAISE EXCEPTION 'Upline shop % does not exist', NEW.upline_shop_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF v_upline_owner_id = NEW.user_id THEN
    RAISE EXCEPTION 'A user cannot join their own shop as a sub-agent'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Depth is derived, never trusted from the caller: the parent's depth + 1,
  -- or 1 when the upline owner is a Lead with no membership row of their own.
  SELECT depth INTO v_parent_depth
  FROM public.sub_agents
  WHERE user_id = v_upline_owner_id;

  NEW.depth := COALESCE(v_parent_depth, 0) + 1;

  IF NEW.depth > 2 THEN
    RAISE EXCEPTION 'Network depth limit reached — a level-2 sub-agent cannot recruit'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Cycle guard: walk up from the upline and refuse if the joining user is
  -- already somewhere above them. Bounded by v_hops so a pre-existing cycle in
  -- the data cannot spin here forever.
  v_cursor_owner_id := v_upline_owner_id;
  WHILE v_cursor_owner_id IS NOT NULL AND v_hops < 8 LOOP
    SELECT upline_shop_id INTO v_cursor_shop_id
    FROM public.sub_agents
    WHERE user_id = v_cursor_owner_id;

    EXIT WHEN v_cursor_shop_id IS NULL;

    SELECT owner_id INTO v_cursor_owner_id
    FROM public.shop_profiles
    WHERE id = v_cursor_shop_id;

    IF v_cursor_owner_id = NEW.user_id THEN
      RAISE EXCEPTION 'Circular network — this user is already an upline of that shop'
        USING ERRCODE = 'check_violation';
    END IF;

    v_hops := v_hops + 1;
  END LOOP;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_sub_agent_depth ON public.sub_agents;

-- Fires only when the parentage changes, so ordinary status/approval updates
-- (and the backfill above) never pay for the walk.
CREATE TRIGGER trg_enforce_sub_agent_depth
  BEFORE INSERT OR UPDATE OF upline_shop_id, user_id ON public.sub_agents
  FOR EACH ROW EXECUTE FUNCTION public.enforce_sub_agent_depth();

-- ============================================================
-- 4. Make the markup ceiling actually configurable
-- ============================================================
-- sub_markup_ceiling_default was seeded into shop_global_settings, but
-- /api/dashboard/sub/pricing reads it from admin_settings — so the lookup has
-- always missed and every sub silently got the hardcoded 5.00. The route now
-- reads shop_global_settings first; seed admin_settings too so either store
-- answers, and an admin editing the familiar table still has an effect.
INSERT INTO public.admin_settings (key, value)
VALUES ('sub_markup_ceiling_default', '"5.00"')
ON CONFLICT (key) DO NOTHING;
