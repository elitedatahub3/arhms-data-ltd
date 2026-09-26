-- ============================================================
-- Make the platform-price cascade sub-agent aware.
--
-- Apply migrations/20260825_sub_agent_level_3.sql FIRST — the downline stage
-- orders its work by sub_agents.depth.
--
-- THE BUG (live today, at two levels, not only three):
--
--   auto_update_shop_pricing_on_platform_cost() fires on any data_packages
--   price change and rewrites EVERY shop_pricing.selling_price to
--   `owner_role_cost + profit_margin`, joining shop_profiles → users with no
--   awareness of sub_agents.
--
--   A sub's users.role is 'customer' — being a sub is a membership, not a role
--   — and their profit_margin holds margin over their PARENT (0.50 from
--   seeding), not margin over platform cost. So every platform price change
--   resets a sub's price to `base_price + 0.50`, which lands BELOW their
--   upline's retail price. The order processor then clamps with
--   Math.min(uplineCost, sellingPrice) and the upline's cut collapses to zero.
--
--   At three levels one price change flattens the whole chain at once.
--
-- THE FIX: two ordered stages. Platform-priced shops cascade from the platform
-- exactly as before; downline shops cascade from their PARENT, preserving the
-- markup each level actually chose, then floor so nothing lands underwater.
-- Level 1 is repriced before level 2 reads it as a parent.
-- ============================================================

CREATE OR REPLACE FUNCTION auto_update_shop_pricing_on_platform_cost()
RETURNS TRIGGER AS $$
DECLARE
  v_min_margin NUMERIC;
  v_depth      SMALLINT;
BEGIN
    -- Zero Price Guard
    IF NEW.price <= 0 OR (NEW.agent_price IS NOT NULL AND NEW.agent_price <= 0) THEN
        RAISE EXCEPTION 'Invalid platform price detected';
    END IF;

    -- Trigger Guard (Loops, No Operation)
    IF NEW.price IS NOT DISTINCT FROM OLD.price AND NEW.agent_price IS NOT DISTINCT FROM OLD.agent_price THEN
        RETURN NEW;
    END IF;

    SELECT COALESCE((value #>> '{}')::NUMERIC, 0.50) INTO v_min_margin
    FROM public.shop_global_settings WHERE key = 'sub_min_margin';
    v_min_margin := COALESCE(v_min_margin, 0.50);

    -- Safe execution block guaranteeing flag reset
    BEGIN
        -- System Isolation bypass flag
        PERFORM set_config('app.system_pricing_update', 'true', true);

        -- ── Stage 1: shops priced against the platform ────────────────────
        -- Unchanged behaviour, but now scoped to owners with no membership row.
        WITH updated_pricing AS (
            SELECT
                sp.id,
                sp.shop_id,
                sp.package_id,
                CASE
                    WHEN u.role = 'agent' AND OLD.agent_price IS NOT NULL THEN OLD.agent_price
                    ELSE OLD.price
                END AS old_cost,
                sp.selling_price AS old_selling,
                CASE
                    WHEN u.role = 'agent' AND NEW.agent_price IS NOT NULL THEN NEW.agent_price
                    ELSE NEW.price
                END AS new_cost,
                (
                    CASE
                        WHEN u.role = 'agent' AND NEW.agent_price IS NOT NULL THEN NEW.agent_price
                        ELSE NEW.price
                    END
                ) + (
                    CASE
                        WHEN sp.profit_margin <= 0 THEN 1
                        WHEN sp.profit_margin > 10 THEN 10
                        ELSE sp.profit_margin
                    END
                ) AS new_selling
            FROM public.shop_pricing sp
            JOIN public.shop_profiles spf ON sp.shop_id = spf.id
            JOIN public.users u ON u.id = spf.owner_id
            WHERE sp.package_id = NEW.id
              AND NOT EXISTS (
                    SELECT 1 FROM public.sub_agents sa WHERE sa.user_id = spf.owner_id
                  )
        ),
        applied_update AS (
            UPDATE public.shop_pricing sp
            SET
                selling_price = up.new_selling,
                last_auto_updated_at = NOW()
            FROM updated_pricing up
            WHERE sp.id = up.id
            RETURNING up.*
        )
        INSERT INTO public.shop_pricing_logs (
            shop_id, package_id, old_cost_price, new_cost_price,
            old_selling_price, new_selling_price, changed_at
        )
        SELECT
            shop_id, package_id, old_cost, new_cost,
            old_selling, new_selling, NOW()
        FROM applied_update;

        -- ── Stage 2: downline shops, shallowest first ─────────────────────
        -- A downline's price follows its PARENT, not the platform.
        --
        -- profit_margin already holds exactly what is needed: for a sub it is
        -- written as (their price − their parent's price) by
        -- /api/dashboard/sub/pricing, and seeded at SUB_START_MARGIN when the
        -- storefront is created. So re-applying it to the parent's NEW price
        -- reproduces the markup this level actually chose, with no need to
        -- reconstruct what the parent used to charge.
        --
        -- Then floor at the parent's wholesale + the platform minimum, so a row
        -- can never land underwater even if the margin on file was stale.
        --
        -- Depth order matters: level 2 reads level 1's row only after the
        -- v_depth = 1 pass has already corrected it.
        FOR v_depth IN 1..2 LOOP
            WITH resolved AS (
                SELECT
                    sp.id,
                    sp.shop_id,
                    sp.package_id,
                    sp.selling_price AS old_selling,
                    COALESCE(parent_sp.sub_price, parent_sp.selling_price) AS parent_wholesale,
                    GREATEST(
                        parent_sp.selling_price + (
                            CASE
                                WHEN sp.profit_margin <= 0 THEN v_min_margin
                                WHEN sp.profit_margin > 10 THEN 10
                                ELSE sp.profit_margin
                            END
                        ),
                        COALESCE(parent_sp.sub_price, parent_sp.selling_price) + v_min_margin
                    ) AS new_selling
                FROM public.shop_pricing sp
                JOIN public.shop_profiles spf ON sp.shop_id = spf.id
                JOIN public.sub_agents sa ON sa.user_id = spf.owner_id
                JOIN public.shop_pricing parent_sp
                  ON parent_sp.shop_id = sa.upline_shop_id
                 AND parent_sp.package_id = sp.package_id
                WHERE sp.package_id = NEW.id
                  AND sa.depth = v_depth
            ),
            applied AS (
                UPDATE public.shop_pricing sp
                SET selling_price = r.new_selling,
                    last_auto_updated_at = NOW()
                FROM resolved r
                WHERE sp.id = r.id
                  AND sp.selling_price IS DISTINCT FROM r.new_selling
                RETURNING r.*
            )
            INSERT INTO public.shop_pricing_logs (
                shop_id, package_id, old_cost_price, new_cost_price,
                old_selling_price, new_selling_price, changed_at
            )
            SELECT shop_id, package_id, NULL, parent_wholesale, old_selling, new_selling, NOW()
            FROM applied;
        END LOOP;

        PERFORM set_config('app.system_pricing_update', 'false', true);
        RETURN NEW;
    EXCEPTION
        WHEN OTHERS THEN
            PERFORM set_config('app.system_pricing_update', 'false', true);
            RAISE;
    END;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_auto_update_shop_pricing ON public.data_packages;
CREATE TRIGGER trg_auto_update_shop_pricing
AFTER UPDATE OF price, agent_price ON public.data_packages
FOR EACH ROW
EXECUTE FUNCTION auto_update_shop_pricing_on_platform_cost();
